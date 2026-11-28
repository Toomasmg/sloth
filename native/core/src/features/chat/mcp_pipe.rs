//! Lado main del MCP del chat: el canal local por el que el servidor MCP (`sloth-hook`, en `native/helper`) le pregunta
//! a Sloth. Equivale al pipe de chat-mcp.ts: una línea JSON de entrada (`{token, ws, pedido}`), una línea de salida
//! (`{"ok":true,"texto":…}` o `{"ok":false,"error":…}`) y se cierra. `chat-mcp.json` le dice al helper dónde está.
//!  - Windows: named pipe `\\.\pipe\sloth-chat-<aleatorio>`, creado con FILE_FLAG_FIRST_PIPE_INSTANCE (nadie se adelanta).
//!  - Unix: socket en la carpeta de datos, con permisos 0600.
//! Hasta 16 conexiones a la vez y 5 s para mandar la línea; lo que no cabe o tarda se corta.
use super::Res;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

pub const CONN_MS: u64 = 5000;
pub const MAX_CONEXIONES: usize = 16;

pub type Atender = Arc<dyn Fn(&str) -> String + Send + Sync>;

/// La línea de respuesta que espera el helper.
pub fn linea_de_respuesta(r: &Result<String, String>) -> String {
    match r {
        Ok(t) => serde_json::json!({"ok": true, "texto": t}).to_string(),
        Err(e) => serde_json::json!({"ok": false, "error": e}).to_string(),
    }
}

/// Nombre nuevo en cada arranque: otro proceso no puede adelantarse a crearlo.
pub fn ruta_del_canal(user_data: &Path) -> String {
    let mut b = [0u8; 12];
    getrandom::getrandom(&mut b).expect("el SO no da aleatorios");
    let r = hex::encode(b);
    if cfg!(windows) {
        format!("\\\\.\\pipe\\sloth-chat-{r}")
    } else {
        user_data.join(format!("chat-mcp-{r}.sock")).to_string_lossy().into_owned()
    }
}

/// `chat-mcp.json` con tmp más rename y modo 0600.
pub fn escribir_info(info: &Path, canal: &str) -> Res<()> {
    let tmp = PathBuf::from(format!("{}.{}.tmp", info.display(), std::process::id()));
    std::fs::write(&tmp, serde_json::json!({"pipe": canal}).to_string()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, info).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

pub fn borrar_info(info: &Path) -> Res<()> {
    match std::fs::remove_file(info) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Lee una línea (hasta `\n`) de a trozos: devuelve `None` si pasa el tope de bytes o la conexión se corta antes.
fn leer_linea(s: &mut impl Read, tope_bytes: usize) -> Option<String> {
    let mut buf = Vec::new();
    let mut trozo = [0u8; 4096];
    loop {
        let n = s.read(&mut trozo).ok().filter(|n| *n > 0)?;
        buf.extend_from_slice(&trozo[..n]);
        if let Some(i) = buf.iter().position(|b| *b == b'\n') {
            return String::from_utf8(buf[..i].to_vec()).ok();
        }
        if buf.len() > tope_bytes {
            return None;
        }
    }
}

/// Atiende una conexión ya abierta: lee la línea, llama al manejador y contesta. Un UTF-8 roto o una línea que no
/// entra no llegan al manejador.
pub fn atender_conexion<S: Read + Write>(s: &mut S, tope_utf16: usize, atender: &Atender, linea_leida: impl FnOnce()) {
    // Cada unidad UTF-16 ocupa hasta 3 bytes en UTF-8: con eso el tope en bytes nunca corta una línea válida.
    let linea = leer_linea(s, tope_utf16 * 3 + 16);
    linea_leida();
    let Some(linea) = linea else { return };
    let r = atender(&linea);
    let _ = s.write_all(format!("{r}\n").as_bytes());
    let _ = s.flush();
}

pub struct ServidorCanal {
    canal: String,
    parar: Arc<AtomicBool>,
}

impl ServidorCanal {
    pub fn canal(&self) -> &str {
        &self.canal
    }

    /// Deja de aceptar; las conexiones en curso terminan solas.
    pub fn detener(&self) {
        if self.parar.swap(true, Ordering::SeqCst) {
            return;
        }
        #[cfg(windows)]
        for _ in 0..ACEPTADORES {
            despertar(&self.canal);
        }
        #[cfg(unix)]
        despertar(&self.canal);
        #[cfg(unix)]
        let _ = std::fs::remove_file(&self.canal);
    }
}

impl Drop for ServidorCanal {
    fn drop(&mut self) {
        self.detener();
    }
}

#[cfg(windows)]
fn despertar(canal: &str) {
    let _ = std::fs::OpenOptions::new().read(true).write(true).open(canal);
}

#[cfg(unix)]
fn despertar(canal: &str) {
    let _ = std::os::unix::net::UnixStream::connect(canal);
}

pub fn iniciar_canal(canal: &str, tope_utf16: usize, atender: Atender) -> Res<ServidorCanal> {
    let parar = Arc::new(AtomicBool::new(false));
    let activas = Arc::new(AtomicUsize::new(0));
    escuchar(canal, tope_utf16, atender, parar.clone(), activas)?;
    Ok(ServidorCanal { canal: canal.to_string(), parar })
}

#[cfg(unix)]
fn escuchar(canal: &str, tope: usize, atender: Atender, parar: Arc<AtomicBool>, activas: Arc<AtomicUsize>) -> Res<()> {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;
    let _ = std::fs::remove_file(canal);
    let l = UnixListener::bind(canal).map_err(|e| e.to_string())?;
    std::fs::set_permissions(canal, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        for mut s in l.incoming().flatten() {
            if parar.load(Ordering::SeqCst) {
                break;
            }
            if activas.fetch_add(1, Ordering::SeqCst) >= MAX_CONEXIONES {
                activas.fetch_sub(1, Ordering::SeqCst);
                continue;
            }
            let (a, act) = (atender.clone(), activas.clone());
            std::thread::spawn(move || {
                let _ = s.set_read_timeout(Some(std::time::Duration::from_millis(CONN_MS)));
                atender_conexion(&mut s, tope, &a, || {});
                act.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
    Ok(())
}

/// Instancias del pipe esperando cliente a la vez: así una ráfaga de conexiones no encuentra el pipe «ocupado».
#[cfg(windows)]
const ACEPTADORES: usize = 4;

#[cfg(windows)]
fn escuchar(canal: &str, tope: usize, atender: Atender, parar: Arc<AtomicBool>, activas: Arc<AtomicUsize>) -> Res<()> {
    use std::fs::File;
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
    use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT};

    let nombre: Arc<Vec<u16>> = Arc::new(canal.encode_utf16().chain(std::iter::once(0)).collect());
    let crear = move |nombre: &[u16], primera: bool| -> Res<isize> {
        let modo = PIPE_ACCESS_DUPLEX | if primera { FILE_FLAG_FIRST_PIPE_INSTANCE } else { 0 };
        // SAFETY: `nombre` termina en nul y vive durante la llamada; el resto son valores por defecto de la API.
        let h = unsafe { CreateNamedPipeW(nombre.as_ptr(), modo, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, MAX_CONEXIONES as u32 + ACEPTADORES as u32, 4096, 4096, 0, std::ptr::null()) };
        if h == INVALID_HANDLE_VALUE {
            return Err(format!("no se pudo crear el canal local (error {})", unsafe { GetLastError() }));
        }
        Ok(h as isize)
    };
    // Todas las instancias se crean acá, antes de volver: si el nombre ya está tomado, falla en este hilo.
    let mut instancias = vec![crear(&nombre, true)?];
    for _ in 1..ACEPTADORES {
        match crear(&nombre, false) {
            Ok(h) => instancias.push(h),
            Err(e) => {
                for h in instancias {
                    unsafe { CloseHandle(h as _) };
                }
                return Err(e);
            }
        }
    }
    for inicial in instancias {
        let (nombre, parar, activas, atender) = (nombre.clone(), parar.clone(), activas.clone(), atender.clone());
        std::thread::spawn(move || {
            let mut actual = inicial;
            loop {
                // SAFETY: `actual` es un pipe vivo de este hilo; ConnectNamedPipe espera a un cliente.
                let conectado = unsafe { ConnectNamedPipe(actual as _, std::ptr::null_mut()) } != 0 || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
                if parar.load(Ordering::SeqCst) {
                    unsafe { CloseHandle(actual as _) };
                    return;
                }
                let Ok(siguiente) = crear(&nombre, false) else {
                    unsafe { CloseHandle(actual as _) };
                    return;
                };
                let este = std::mem::replace(&mut actual, siguiente);
                if !conectado || activas.fetch_add(1, Ordering::SeqCst) >= MAX_CONEXIONES {
                    if conectado {
                        activas.fetch_sub(1, Ordering::SeqCst);
                    }
                    unsafe {
                        DisconnectNamedPipe(este as _);
                        CloseHandle(este as _);
                    }
                    continue;
                }
                let (a, act) = (atender.clone(), activas.clone());
                std::thread::spawn(move || {
                    // El vigía corta al que no manda su línea a tiempo; solo actúa si el lector sigue esperando.
                    let (listo, espera) = std::sync::mpsc::channel::<()>();
                    let vigia = std::thread::spawn(move || {
                        if let Err(std::sync::mpsc::RecvTimeoutError::Timeout) = espera.recv_timeout(std::time::Duration::from_millis(CONN_MS)) {
                            // SAFETY: el lector todavía no soltó `listo`, así que el handle sigue abierto.
                            unsafe { DisconnectNamedPipe(este as _) };
                        }
                    });
                    // SAFETY: `este` es un handle de pipe conectado que ahora es de este hilo; `File` lo cierra al soltarse.
                    let mut f = unsafe { File::from_raw_handle(este as RawHandle) };
                    atender_conexion(&mut f, tope, &a, || drop(listo));
                    let _ = vigia.join();
                    act.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::chat::sesion::pruebas::carpeta;
    use std::io::Cursor;

    struct Duplex {
        entrada: Cursor<Vec<u8>>,
        salida: Vec<u8>,
    }
    impl Read for Duplex {
        fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
            self.entrada.read(b)
        }
    }
    impl Write for Duplex {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.salida.write(b)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn eco() -> Atender {
        Arc::new(|l: &str| format!("recibí:{l}"))
    }

    #[test]
    fn la_respuesta_tiene_la_forma_que_lee_el_helper() {
        assert_eq!(linea_de_respuesta(&Ok("hola".into())), r#"{"ok":true,"texto":"hola"}"#);
        assert_eq!(linea_de_respuesta(&Err("no".into())), r#"{"ok":false,"error":"no"}"#);
    }

    #[test]
    fn atiende_la_primera_linea_y_ignora_el_resto() {
        let mut d = Duplex { entrada: Cursor::new(b"uno\ndos\n".to_vec()), salida: Vec::new() };
        atender_conexion(&mut d, 100, &eco(), || {});
        assert_eq!(String::from_utf8(d.salida).unwrap(), "recibí:uno\n");
    }

    #[test]
    fn una_linea_que_no_entra_o_sin_salto_no_llega_al_manejador() {
        let llamado = Arc::new(AtomicBool::new(false));
        let l = llamado.clone();
        let a: Atender = Arc::new(move |_| {
            l.store(true, Ordering::SeqCst);
            String::new()
        });
        let mut largo = Duplex { entrada: Cursor::new(vec![b'x'; 10_000]), salida: Vec::new() };
        atender_conexion(&mut largo, 100, &a, || {});
        let mut cortado = Duplex { entrada: Cursor::new(b"sin salto".to_vec()), salida: Vec::new() };
        atender_conexion(&mut cortado, 100, &a, || {});
        let mut roto = Duplex { entrada: Cursor::new(vec![0xff, 0xfe, b'\n']), salida: Vec::new() };
        atender_conexion(&mut roto, 100, &a, || {});
        assert!(!llamado.load(Ordering::SeqCst));
        assert!(largo.salida.is_empty() && cortado.salida.is_empty() && roto.salida.is_empty());
    }

    #[test]
    fn avisa_cuando_termino_de_leer_la_linea() {
        let leida = Arc::new(AtomicBool::new(false));
        let l = leida.clone();
        let mut d = Duplex { entrada: Cursor::new(b"x\n".to_vec()), salida: Vec::new() };
        atender_conexion(&mut d, 100, &eco(), move || l.store(true, Ordering::SeqCst));
        assert!(leida.load(Ordering::SeqCst));
    }

    #[test]
    fn la_ruta_es_nueva_cada_vez_y_tiene_el_formato_del_sistema() {
        let d = carpeta("pipe-ruta");
        let (a, b) = (ruta_del_canal(&d), ruta_del_canal(&d));
        assert_ne!(a, b);
        if cfg!(windows) {
            assert!(a.starts_with("\\\\.\\pipe\\sloth-chat-") && a.len() == "\\\\.\\pipe\\sloth-chat-".len() + 24);
        } else {
            assert!(a.ends_with(".sock"));
        }
    }

    #[test]
    fn el_info_se_escribe_de_forma_atomica_y_se_borra_sin_quejarse_si_no_esta() {
        let d = carpeta("pipe-info");
        let f = d.join("chat-mcp.json");
        escribir_info(&f, "\\\\.\\pipe\\x").unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        assert_eq!(v["pipe"], "\\\\.\\pipe\\x");
        borrar_info(&f).unwrap();
        borrar_info(&f).unwrap();
        assert!(!f.exists());
    }

    fn preguntar(canal: &str, linea: &str) -> String {
        #[cfg(windows)]
        let mut s = loop {
            match std::fs::OpenOptions::new().read(true).write(true).open(canal) {
                Ok(f) => break f,
                // ERROR_PIPE_BUSY: todas las instancias están atendiendo; el cliente real reintenta igual.
                Err(e) if e.raw_os_error() == Some(231) => std::thread::yield_now(),
                Err(e) => panic!("{e}"),
            }
        };
        #[cfg(unix)]
        let mut s = std::os::unix::net::UnixStream::connect(canal).unwrap();
        s.write_all(format!("{linea}\n").as_bytes()).unwrap();
        let mut r = String::new();
        let mut buf = [0u8; 256];
        while !r.ends_with('\n') {
            let n = s.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            r.push_str(&String::from_utf8_lossy(&buf[..n]));
        }
        r
    }

    #[test]
    fn el_canal_real_atiende_varias_conexiones_seguidas() {
        let d = carpeta("pipe-real");
        let s = iniciar_canal(&ruta_del_canal(&d), 1000, eco()).unwrap();
        assert_eq!(preguntar(s.canal(), "a"), "recibí:a\n");
        assert_eq!(preguntar(s.canal(), "b"), "recibí:b\n");
        s.detener();
    }

    #[test]
    fn el_canal_real_atiende_conexiones_en_paralelo() {
        let d = carpeta("pipe-par");
        let s = iniciar_canal(&ruta_del_canal(&d), 1000, eco()).unwrap();
        let canal = s.canal().to_string();
        let hilos: Vec<_> = (0..6).map(|i| {
            let c = canal.clone();
            std::thread::spawn(move || preguntar(&c, &format!("n{i}")))
        }).collect();
        for (i, h) in hilos.into_iter().enumerate() {
            assert_eq!(h.join().unwrap(), format!("recibí:n{i}\n"));
        }
    }

    #[cfg(windows)]
    #[test]
    fn nadie_se_adelanta_a_crear_el_pipe() {
        let d = carpeta("pipe-primero");
        let ruta = ruta_del_canal(&d);
        let _a = iniciar_canal(&ruta, 1000, eco()).unwrap();
        assert!(iniciar_canal(&ruta, 1000, eco()).is_err());
    }
}
