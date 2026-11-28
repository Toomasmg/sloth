//! La conexión con el daemon de terminales (`native/daemon`). La lógica del protocolo es la de
//! `sloth_core::daemon_cliente` (saludo, estado de sesiones, reconexión); acá va lo que toca el mundo: el pipe, lanzar
//! el ejecutable y la clave en userData. Equivale a la parte de E/S de src/main/daemon-client.ts.
//!
//! El pipe se abre con E/S superpuesta (tokio): con un handle sincrónico, una lectura bloqueada en un hilo traba las
//! escrituras de los demás (Windows serializa la E/S de un mismo archivo abierto en modo sincrónico).
use serde_json::{json, Value};
use sloth_core::daemon_cliente::{conectar_o_lanzar, decidir_version, reconectar, Conector, DecisionVersion, ErrorConexion, Estado, Evento, InfoBackend, Lanzado, ERR_CONEXION_CORTADA, ERR_SIN_RESPUESTA, REQUEST_TIMEOUT_MS};
use sloth_core::daemon_protocolo::{es_clave, nuevo_nonce, pipe_name_for, HelloOk, HookEventPayload, PendingPermission, PtyStartResult, SessionInfo, SpawnSpec};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

pub type Oyente = Arc<dyn Fn(Evento) + Send + Sync>;

#[derive(Clone)]
pub struct ConfDaemon {
    pub raiz: PathBuf,
    pub version: String,
    /// El ejecutable del daemon; None si no está compilado (no hay terminales).
    pub exe: Option<PathBuf>,
}

type Linea = tokio::sync::mpsc::UnboundedSender<String>;

pub struct Terminales {
    conf: ConfDaemon,
    pipe: String,
    estado: Mutex<Estado>,
    escritor: Mutex<Option<Linea>>,
    esperas: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    /// Una conexión a la vez: dos pedidos que llegan juntos al arrancar no lanzan dos daemons.
    conectando: Mutex<()>,
    /// Los eventos salen en orden por un hilo propio: quien los atiende puede bloquear (git, el store) sin trabar la lectura.
    eventos: Mutex<mpsc::Sender<Evento>>,
}

fn log(m: &str) {
    sloth_core::logger_global::info("terminales", m);
}

/// La clave se crea solo si no hay o si la que hay no sirve. Con otro error (antivirus, OneDrive) pisarla dejaría
/// inalcanzable al daemon vivo.
pub fn asegurar_clave(raiz: &Path) -> Result<String, String> {
    let archivo = raiz.join("daemon-key");
    match std::fs::read_to_string(&archivo) {
        Ok(k) if es_clave(k.trim()) => return Ok(k.trim().to_string()),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("no se pudo leer la clave del daemon: {e}")),
    }
    std::fs::create_dir_all(raiz).map_err(|e| e.to_string())?;
    let k = nuevo_nonce();
    let tmp = raiz.join(format!("daemon-key.{}.tmp", std::process::id()));
    std::fs::write(&tmp, &k).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &archivo).map_err(|e| e.to_string())?;
    Ok(k)
}

#[cfg(windows)]
mod pipe {
    use super::*;
    use sloth_core::daemon_cliente::{Handshake, PasoSaludo, HELLO_TIMEOUT_MS};
    use sloth_core::daemon_protocolo::{DaemonMessage, LectorLineas};
    use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf};
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};

    pub struct Conectada {
        pub lectura: ReadHalf<NamedPipeClient>,
        pub escritura: WriteHalf<NamedPipeClient>,
        pub lector: LectorLineas,
        pub pendientes: Vec<DaemonMessage>,
    }

    const ERROR_PIPE_BUSY: i32 = 231;

    pub async fn intentar(nombre: &str, clave: &str, version: &str) -> Result<(Conectada, HelloOk), ErrorConexion> {
        let cliente = match ClientOptions::new().open(nombre) {
            Ok(c) => c,
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => return Err(ErrorConexion::Ausente(e.to_string())),
            Err(e) => return Err(e.into()),
        };
        let (mut lectura, mut escritura) = tokio::io::split(cliente);
        let saludo = async {
            let mut h = Handshake::nuevo(clave, version);
            escritura.write_all(h.iniciar().as_bytes()).await?;
            let mut lector = LectorLineas::nuevo();
            let mut buf = vec![0u8; 64 * 1024];
            let mut hello = None;
            let mut pendientes = Vec::new();
            loop {
                let n = lectura.read(&mut buf).await.map_err(|_| ErrorConexion::Rechazada)?;
                if n == 0 {
                    return Err(ErrorConexion::Rechazada);
                }
                for m in lector.alimentar(&buf[..n]).map_err(|_| ErrorConexion::Rechazada)? {
                    if hello.is_some() {
                        pendientes.push(m);
                        continue;
                    }
                    match h.recibir(m)? {
                        PasoSaludo::Nada => {}
                        PasoSaludo::Enviar(l) => escritura.write_all(l.as_bytes()).await?,
                        PasoSaludo::Listo(ok) => hello = Some(*ok),
                    }
                }
                if let Some(ok) = hello.take() {
                    return Ok((lector, pendientes, ok));
                }
            }
        };
        match tokio::time::timeout(Duration::from_millis(HELLO_TIMEOUT_MS), saludo).await {
            Ok(Ok((lector, pendientes, hello))) => Ok((Conectada { lectura, escritura, lector, pendientes }, hello)),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(ErrorConexion::SinSaludo),
        }
    }
}

#[cfg(not(windows))]
mod pipe {
    use super::*;
    pub struct Conectada;
    pub async fn intentar(_: &str, _: &str, _: &str) -> Result<(Conectada, HelloOk), ErrorConexion> {
        Err(ErrorConexion::Otro("el daemon de terminales solo funciona en Windows".into()))
    }
}

struct ConectorReal {
    conf: ConfDaemon,
    pipe: String,
    clave: String,
}

impl Conector for ConectorReal {
    type Conn = pipe::Conectada;

    fn intentar(&mut self) -> Result<(Self::Conn, HelloOk), ErrorConexion> {
        tauri::async_runtime::block_on(pipe::intentar(&self.pipe, &self.clave, &self.conf.version))
    }

    fn lanzar(&mut self, solo_node: bool) -> Result<Lanzado, String> {
        // Sin Node en la app: el daemon de Node no es una alternativa.
        if solo_node {
            return Err("No hay otro daemon de terminales para probar.".into());
        }
        let exe = self.conf.exe.clone().ok_or("No está el daemon de terminales (sloth-daemon.exe).")?;
        let mut cmd = std::process::Command::new(&exe);
        cmd.args(["--user-data", &self.conf.raiz.to_string_lossy(), "--pipe", &self.pipe, "--app-version", &self.conf.version])
            .current_dir(&self.conf.raiz)
            .env_clear()
            .envs(sloth_core::ptys_core::entorno_del_daemon(std::env::vars()))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Suelto de Sloth (como `detached` de Node): las terminales siguen vivas aunque la app se cierre.
            cmd.creation_flags(0x0000_0008 | 0x0000_0200);
        }
        cmd.spawn().map_err(|e| format!("no se pudo lanzar el daemon: {e}"))?;
        Ok(Lanzado::Rust)
    }

    fn dormir(&mut self, ms: u64) {
        std::thread::sleep(Duration::from_millis(ms));
    }

    fn ahora_ms(&mut self) -> u64 {
        super::arranque::ahora_ms()
    }
}

impl Terminales {
    pub fn nuevas(conf: ConfDaemon, oyente: Oyente) -> Arc<Terminales> {
        let pipe = pipe_name_for(&std::path::absolute(&conf.raiz).unwrap_or(conf.raiz.clone()).to_string_lossy());
        let (tx, rx) = mpsc::channel::<Evento>();
        std::thread::spawn(move || {
            for ev in rx {
                oyente(ev);
            }
        });
        Arc::new(Terminales { conf, pipe, estado: Mutex::new(Estado::nuevo()), escritor: Mutex::new(None), esperas: Mutex::new(HashMap::new()), conectando: Mutex::new(()), eventos: Mutex::new(tx) })
    }

    fn emitir(&self, ev: Evento) {
        let _ = self.eventos.lock().unwrap_or_else(|e| e.into_inner()).send(ev);
    }

    fn estado(&self) -> std::sync::MutexGuard<'_, Estado> {
        self.estado.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn conectado(&self) -> bool {
        self.estado().conectado()
    }

    fn conector(&self) -> Result<ConectorReal, String> {
        Ok(ConectorReal { conf: self.conf.clone(), pipe: self.pipe.clone(), clave: asegurar_clave(&self.conf.raiz)? })
    }

    /// Conecta (lanzando el daemon si hace falta). Devuelve los eventos de rehidratación ya avisados.
    pub fn asegurar(self: &Arc<Self>) -> Result<(), String> {
        let _uno = self.conectando.lock().unwrap_or_else(|e| e.into_inner());
        if self.conectado() {
            return Ok(());
        }
        #[cfg(windows)]
        sloth_core::daemon_cliente::retirar_daemon_v1(&self.conf.raiz.to_string_lossy(), &mut |m| log(m));
        let mut k = self.conector()?;
        let (conn, hello) = conectar_o_lanzar(&mut k, true).map_err(|e| e.to_string())?;
        if decidir_version(&hello.version, &self.conf.version, &hello.sessions) == DecisionVersion::Reiniciar {
            log(&format!("[daemon] versión {} ≠ {}: se reinicia", hello.version, self.conf.version));
            self.unir(conn, hello);
            self.apagar();
            let (conn, hello) = conectar_o_lanzar(&mut k, true).map_err(|e| e.to_string())?;
            self.unir(conn, hello);
        } else {
            if hello.version != self.conf.version {
                log(&format!("[daemon] versión {} ≠ {}, pero tiene terminales vivas: se sigue usando", hello.version, self.conf.version));
            }
            self.unir(conn, hello);
        }
        Ok(())
    }

    fn unir(self: &Arc<Self>, conn: pipe::Conectada, hello: HelloOk) {
        log(&format!("[daemon] conectado (pid {}, versión {})", hello.pid, hello.version));
        let eventos = {
            let mut e = self.estado();
            *e = Estado::nuevo();
            e.conectar(hello)
        };
        self.leer(conn);
        for ev in eventos {
            self.emitir(ev);
        }
    }

    #[cfg(windows)]
    fn leer(self: &Arc<Self>, conn: pipe::Conectada) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let pipe::Conectada { mut lectura, mut escritura, mut lector, pendientes } = conn;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        *self.escritor.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
        tauri::async_runtime::spawn(async move {
            while let Some(l) = rx.recv().await {
                if escritura.write_all(l.as_bytes()).await.is_err() {
                    break;
                }
            }
        });
        let yo = self.clone();
        tauri::async_runtime::spawn(async move {
            yo.procesar(pendientes);
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match lectura.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => match lector.alimentar(&buf[..n]) {
                        Ok(ms) => yo.procesar(ms),
                        Err(_) => break,
                    },
                }
            }
            // Reconectar bloquea (espera al daemon relanzado): va en un hilo propio, fuera del runtime.
            std::thread::spawn(move || yo.al_cerrar());
        });
    }

    #[cfg(not(windows))]
    fn leer(self: &Arc<Self>, _: pipe::Conectada) {}

    fn procesar(&self, ms: Vec<sloth_core::daemon_protocolo::DaemonMessage>) {
        for m in ms {
            let salida = self.estado().al_mensaje(m);
            if let Some(r) = salida.respuesta {
                if let Some(tx) = self.esperas.lock().unwrap_or_else(|e| e.into_inner()).remove(&r.rid) {
                    let _ = tx.send(r.resultado);
                }
            }
            for ev in salida.eventos {
                self.emitir(ev);
            }
        }
    }

    fn fallar(&self, rids: Vec<u64>, motivo: &str) {
        let mut esperas = self.esperas.lock().unwrap_or_else(|e| e.into_inner());
        for rid in rids {
            if let Some(tx) = esperas.remove(&rid) {
                let _ = tx.send(Err(motivo.to_string()));
            }
        }
    }

    fn al_cerrar(self: Arc<Self>) {
        *self.escritor.lock().unwrap_or_else(|e| e.into_inner()) = None;
        let (rids, reintentar) = self.estado().al_cerrar();
        self.fallar(rids, ERR_CONEXION_CORTADA);
        if !reintentar {
            return;
        }
        let Ok(mut k) = self.conector() else { return };
        let (nueva, eventos) = {
            let mut e = self.estado();
            reconectar(&mut e, &mut k, &mut |m| log(m))
        };
        if let Some(conn) = nueva {
            self.leer(conn);
        }
        for ev in eventos {
            self.emitir(ev);
        }
    }

    fn mandar(&self, linea: Option<String>) {
        let (Some(l), Some(tx)) = (linea, self.escritor.lock().unwrap_or_else(|e| e.into_inner()).clone()) else { return };
        let _ = tx.send(l);
    }

    fn pedir(&self, armar: impl FnOnce(&mut Estado, u64) -> Result<(u64, String), sloth_core::daemon_cliente::ErrorPedido>) -> Result<Value, String> {
        let (tx, rx) = mpsc::channel();
        let linea = {
            let mut e = self.estado();
            let (rid, linea) = armar(&mut e, super::arranque::ahora_ms()).map_err(|e| e.to_string())?;
            self.esperas.lock().unwrap_or_else(|e| e.into_inner()).insert(rid, tx);
            linea
        };
        self.mandar(Some(linea));
        rx.recv_timeout(Duration::from_millis(REQUEST_TIMEOUT_MS)).unwrap_or_else(|_| Err(ERR_SIN_RESPUESTA.to_string()))
    }

    pub fn start(self: &Arc<Self>, id: &str, spawn: SpawnSpec) -> Result<PtyStartResult, String> {
        self.asegurar()?;
        let v = self.pedir(|e, t| e.pedir_start(t, id, spawn))?;
        let r: PtyStartResult = serde_json::from_value(v).map_err(|e| format!("respuesta inválida del daemon: {e}"))?;
        self.estado().start_listo(id, &r);
        Ok(r)
    }

    pub fn kill(self: &Arc<Self>, id: &str) -> Result<(), String> {
        self.asegurar()?;
        self.pedir(|e, t| e.pedir_kill(t, id)).map(|_| ())
    }

    pub fn list(self: &Arc<Self>) -> Result<Vec<SessionInfo>, String> {
        self.asegurar()?;
        let v = self.pedir(|e, t| e.pedir_list(t))?;
        let l: Vec<SessionInfo> = serde_json::from_value(v).map_err(|e| e.to_string())?;
        self.estado().list_listo(&l);
        Ok(l)
    }

    pub fn write(&self, id: &str, data: &str) {
        let l = self.estado().escribir(id, data);
        self.mandar(l);
    }

    pub fn resize(&self, id: &str, cols: u32, rows: u32) {
        let l = self.estado().redimensionar(id, cols, rows);
        self.mandar(l);
    }

    pub fn responder_permiso(&self, req: &str, decision: Value) {
        let l = self.estado().responder_permiso(req, decision);
        self.mandar(l);
    }

    pub fn esta_corriendo(&self, id: &str) -> bool {
        self.estado().esta_corriendo(id)
    }

    pub fn permisos(&self) -> Vec<PendingPermission> {
        self.estado().permisos_pendientes()
    }

    pub fn ultimos_hooks(&self) -> BTreeMap<String, HookEventPayload> {
        self.estado().ultimos_hooks()
    }

    pub fn hook(&self) -> (String, String) {
        let e = self.estado();
        (e.hook_url().to_string(), e.hook_token().to_string())
    }

    pub fn info(&self) -> Value {
        let InfoBackend { pid, version } = self.estado().info();
        json!({ "mode": "daemon", "pid": pid, "version": version })
    }

    /// Apaga el daemon y sus terminales. No se reconecta: el próximo pedido lanza otro.
    pub fn apagar(&self) {
        if !self.conectado() {
            return;
        }
        self.estado().marcar_apagado();
        let _ = self.pedir(|e, t| e.pedir_shutdown(t));
        let limite = std::time::Instant::now() + Duration::from_secs(3);
        while self.escritor.lock().unwrap_or_else(|e| e.into_inner()).is_some() && std::time::Instant::now() < limite {
            std::thread::sleep(Duration::from_millis(50));
        }
        self.estado().tras_apagar();
        sloth_core::daemon_cliente::esperar_pipe_cerrado(&self.pipe, 3000);
    }

    /// Suelta la conexión: el daemon y sus terminales siguen vivos.
    pub fn soltar(&self) {
        let rids = self.estado().liberar();
        self.fallar(rids, sloth_core::daemon_cliente::ERR_LIBERADO);
        *self.escritor.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use sloth_core::daemon_protocolo::PtyChunk;

    #[test]
    fn con_el_daemon_real_arranca_una_terminal_escribe_y_la_cierra() {
        let Some(exe) = crate::tests_comunes::exe_del_daemon() else {
            eprintln!("SIN DAEMON: compilá native/daemon en el mismo CARGO_TARGET_DIR para correr esta prueba");
            return;
        };
        let raiz = std::env::temp_dir().join(format!("sloth-term-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&raiz);
        std::fs::create_dir_all(&raiz).unwrap();
        let eventos: Arc<Mutex<Vec<Evento>>> = Arc::default();
        let ev = eventos.clone();
        let t = Terminales::nuevas(ConfDaemon { raiz: raiz.clone(), version: "0.0.0-prueba".into(), exe: Some(exe) }, Arc::new(move |e| ev.lock().unwrap().push(e)));
        t.asegurar().unwrap();
        assert!(t.conectado());
        assert!(t.hook().0.starts_with("http://127.0.0.1:"));
        let spawn = SpawnSpec { file: "cmd.exe".into(), args: vec!["/d".into(), "/q".into()], cwd: raiz.to_string_lossy().into(), env: std::env::vars().collect(), cols: 80, rows: 24 };
        let r = t.start("w1", spawn).unwrap();
        assert!(r.running && t.esta_corriendo("w1"));
        t.write("w1", "echo hola-sloth\r\n");
        let limite = std::time::Instant::now() + Duration::from_secs(15);
        let vio = || eventos.lock().unwrap().iter().any(|e| matches!(e, Evento::Data { id, chunks } if id == "w1" && chunks.iter().any(|c: &PtyChunk| c.data.contains("hola-sloth"))));
        while !vio() && std::time::Instant::now() < limite {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(vio(), "no llegó la salida de la terminal");
        assert!(t.list().unwrap().iter().any(|s| s.id == "w1" && s.running));
        t.kill("w1").unwrap();
        assert!(!t.esta_corriendo("w1"));
        t.apagar();
        assert!(!t.conectado());
        let _ = std::fs::remove_dir_all(&raiz);
    }

    #[test]
    fn la_clave_existente_se_respeta_y_una_rota_se_reemplaza() {
        let raiz = std::env::temp_dir().join(format!("sloth-clave-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&raiz);
        let k = asegurar_clave(&raiz).unwrap();
        assert!(es_clave(&k));
        assert_eq!(asegurar_clave(&raiz).unwrap(), k);
        std::fs::write(raiz.join("daemon-key"), "rota").unwrap();
        assert_ne!(asegurar_clave(&raiz).unwrap(), "rota");
        let _ = std::fs::remove_dir_all(&raiz);
    }
}
