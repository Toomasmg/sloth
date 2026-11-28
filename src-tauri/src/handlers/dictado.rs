//! Canales `feat:dictado:*` en Rust: el micrófono de cada terminal. La UI graba y manda el WAV; acá se transcribe con
//! whisper-cli (sin ventana y con plazo, por el ejecutor del núcleo) y se devuelve el texto. El modelo se baja la primera
//! vez a `<datos>/whisper`, verificado con SHA-256 y solo desde los hosts de `MODELO_HOSTS` (`asegurar_modelo`), avisando
//! el avance con `feat:dictado:modelo`. Una transcripción a la vez: la que llega mientras otra corre espera su turno.
use super::comun::{self, ahora_ms};
use super::arg;
use crate::entorno::Entorno;
use crate::router::Router;
use serde_json::{json, Value};
use sloth_core::features::dictado_core::{
    ajustes_por_nombre, buscar_modelo, detalle_de_fallo, error_de_modelo, error_dictado, hilos, modelo_elegido, previo_de, segundos_de_audio, texto_de_salida, timeout_ms,
    tope_del_modelo, wav_valido, whisper_args, ArgsWhisper, ErrorDictado, ModeloWhisper, TipoErrorDictado, AVISO_MS, MAX_WAV_BYTES, MODELO_CHICO, MODELO_HOSTS,
};
use sloth_core::features::dictado_modelo::{asegurar_modelo, Cuerpo, ErrorIo, Escritor, ModeloDeps, ModeloError, OpcionesModelo, RespuestaModelo};
use sloth_core::features::proceso::{Ejecutor, Real};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const NOMBRE: &str = "dictado";

/// Si esta carpeta existe, cada parte dictada se guarda ahí (audio y texto) para revisar qué falló.
const DIAGNOSTICO: &str = "diagnostico";
const MAX_DIAGNOSTICO: usize = 400;

/// La red y el disco de verdad para `asegurar_modelo`.
pub struct DepsReales;

struct ArchivoReal(Option<fs::File>);

fn error_io(e: std::io::Error) -> ErrorIo {
    // ERROR_DISK_FULL (112) y ERROR_HANDLE_DISK_FULL (39) en Windows; ENOSPC (28) en el resto.
    let sin_espacio = matches!(e.raw_os_error(), Some(112) | Some(39)) || (cfg!(not(windows)) && e.raw_os_error() == Some(28));
    ErrorIo { mensaje: e.to_string(), sin_espacio }
}

impl Escritor for ArchivoReal {
    fn write(&mut self, chunk: &[u8]) -> Result<(), ErrorIo> {
        self.0.as_mut().ok_or_else(|| ErrorIo { mensaje: "archivo cerrado".into(), sin_espacio: false })?.write_all(chunk).map_err(error_io)
    }
    fn close(&mut self) -> Result<(), ErrorIo> {
        match self.0.take() {
            Some(f) => f.sync_all().map_err(error_io),
            None => Ok(()),
        }
    }
}

impl ModeloDeps for DepsReales {
    fn fetch(&mut self, url: &str, inactividad_ms: u64) -> Result<RespuestaModelo, String> {
        // Sin seguir redirecciones: el núcleo revisa el host de cada salto.
        let agente = ureq::AgentBuilder::new().redirects(0).timeout_connect(Duration::from_secs(30)).timeout_read(Duration::from_millis(inactividad_ms)).build();
        let res = match agente.get(url).call() {
            Ok(r) => r,
            Err(ureq::Error::Status(_, r)) => r,
            Err(e) => return Err(e.to_string()),
        };
        let status = res.status();
        let location = res.header("location").map(String::from);
        let content_length = res.header("content-length").map(String::from);
        let mut lector = res.into_reader();
        let cuerpo: Cuerpo = Box::new(std::iter::from_fn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            match lector.read(&mut buf) {
                Ok(0) => None,
                Ok(n) => {
                    buf.truncate(n);
                    Some(Ok(buf))
                }
                Err(e) => Some(Err(e.to_string())),
            }
        }));
        Ok(RespuestaModelo { status, location, content_length, cuerpo: Some(cuerpo) })
    }
    fn mkdir(&mut self, dir: &str) -> Result<(), ErrorIo> {
        fs::create_dir_all(dir).map_err(error_io)
    }
    fn abrir(&mut self, path: &str) -> Result<Box<dyn Escritor>, ErrorIo> {
        Ok(Box::new(ArchivoReal(Some(fs::File::create(path).map_err(error_io)?))))
    }
    fn rename(&mut self, desde: &str, hasta: &str) -> Result<(), ErrorIo> {
        fs::rename(desde, hasta).map_err(error_io)
    }
    fn rm(&mut self, path: &str) -> Result<(), ErrorIo> {
        match fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(error_io(e)),
            _ => Ok(()),
        }
    }
    fn existe(&mut self, path: &str) -> bool {
        Path::new(path).exists()
    }
    fn sleep(&mut self, ms: u64) {
        std::thread::sleep(Duration::from_millis(ms));
    }
}

type FabricaDeps = Arc<dyn Fn() -> Box<dyn ModeloDeps> + Send + Sync>;

pub struct Dictado {
    entorno: Arc<Entorno>,
    ejecutor: Arc<dyn Ejecutor>,
    deps: FabricaDeps,
    /// Una bajada por modelo: quien llega mientras otra corre espera su candado y después encuentra el archivo.
    bajadas: Mutex<HashMap<&'static str, Arc<Mutex<()>>>>,
    turno: Mutex<()>,
}

fn resultado_error(e: ErrorDictado) -> Value {
    json!({ "ok": false, "error": e })
}

/// El WAV llega como `Uint8Array`, que por el puente de Tauri se vuelve un arreglo de números o un objeto con índices.
fn bytes_de(v: &Value) -> Option<Vec<u8>> {
    let byte = |x: &Value| x.as_u64().filter(|n| *n <= 255).map(|n| n as u8);
    match v {
        Value::Array(a) if a.len() <= MAX_WAV_BYTES => a.iter().map(byte).collect(),
        Value::Object(o) if o.len() <= MAX_WAV_BYTES => (0..o.len()).map(|i| o.get(&i.to_string()).and_then(byte)).collect(),
        _ => None,
    }
}

impl Dictado {
    fn carpeta_modelos(&self) -> PathBuf {
        self.entorno.raiz().join("whisper")
    }

    fn buscar(&self, m: &ModeloWhisper) -> Option<PathBuf> {
        let (a, b) = (self.carpeta_modelos(), self.entorno.plataforma.carpeta_whisper());
        buscar_modelo(m, &[a.as_path(), b.as_path()], &|p| p.exists())
    }

    fn candado_de(&self, m: &ModeloWhisper) -> Arc<Mutex<()>> {
        self.bajadas.lock().unwrap_or_else(|e| e.into_inner()).entry(m.archivo).or_default().clone()
    }

    /// `avisar`: el dictado espera esta bajada y la UI muestra el avance; si no, baja callada.
    fn bajar(&self, m: &'static ModeloWhisper, avisar: bool) -> Result<PathBuf, ModeloError> {
        let candado = self.candado_de(m);
        let _g = candado.lock().unwrap_or_else(|e| e.into_inner());
        let destino = self.carpeta_modelos().join(m.archivo);
        let destino_txt = destino.to_string_lossy().into_owned();
        let o = OpcionesModelo { url: m.url, sha256: m.sha256, destino: &destino_txt, hosts: &MODELO_HOSTS, max_bytes: tope_del_modelo(m), bytes_aprox: m.bytes, intentos: None, inactividad_ms: None };
        let mut ultimo: Option<Instant> = None;
        let mut progreso = |recibidos: u64, total: u64| {
            if ultimo.is_some_and(|u| u.elapsed() < Duration::from_millis(AVISO_MS)) && recibidos < total {
                return;
            }
            ultimo = Some(Instant::now());
            self.entorno.emitir(NOMBRE, "modelo", &[json!({ "recibidos": recibidos, "total": total })]);
        };
        let mut deps = (self.deps)();
        let r = asegurar_modelo(&o, deps.as_mut(), if avisar { Some(&mut progreso) } else { None });
        if avisar {
            self.entorno.emitir(NOMBRE, "modelo", &[Value::Null]);
        }
        r.map(|_| destino)
    }

    /// El modelo elegido en Configuración. Si es el turbo y todavía no está, se dicta con el chico mientras el turbo baja
    /// de fondo (son 574 MB: el primer dictado no puede esperarlo).
    fn modelo_listo(self: &Arc<Self>) -> Result<(PathBuf, &'static str), ModeloError> {
        let preciso = comun::ajuste(&self.entorno, "terminal").and_then(|t| t.get("dictadoPreciso").and_then(Value::as_bool)).unwrap_or(false);
        let elegido = modelo_elegido(preciso);
        if let Some(p) = self.buscar(elegido) {
            return Ok((p, elegido.archivo));
        }
        if elegido.archivo != MODELO_CHICO.archivo {
            let yo = self.clone();
            std::thread::spawn(move || {
                if let Err(e) = yo.bajar(elegido, false) {
                    sloth_core::logger_global::aviso(NOMBRE, &format!("[dictado] no se pudo bajar {}: {}", elegido.archivo, e.mensaje));
                }
            });
        }
        let chico = match self.buscar(&MODELO_CHICO) {
            Some(p) => p,
            None => self.bajar(&MODELO_CHICO, true)?,
        };
        Ok((chico, MODELO_CHICO.archivo))
    }

    fn guardar_diagnostico(&self, wav: &[u8], datos: &Value) {
        let dir = self.carpeta_modelos().join(DIAGNOSTICO);
        if !dir.is_dir() {
            return;
        }
        let base = dir.join(format!("{}-{}", ahora_ms(), &comun::nuevo_uuid()[..4]));
        let r = (|| -> std::io::Result<()> {
            fs::write(base.with_extension("wav"), wav)?;
            fs::write(base.with_extension("json"), serde_json::to_string_pretty(datos).unwrap_or_default())?;
            let mut archivos: Vec<PathBuf> = fs::read_dir(&dir)?.filter_map(|e| e.ok().map(|e| e.path())).collect();
            archivos.sort();
            let sobran = archivos.len().saturating_sub(MAX_DIAGNOSTICO);
            for viejo in archivos.into_iter().take(sobran) {
                let _ = fs::remove_file(viejo);
            }
            Ok(())
        })();
        if let Err(e) = r {
            sloth_core::logger_global::aviso(NOMBRE, &format!("[dictado] no se pudo guardar el diagnóstico: {e}"));
        }
    }

    fn transcribir(self: &Arc<Self>, wav: &[u8], previo: &str) -> Value {
        if !cfg!(windows) {
            return resultado_error(error_dictado(TipoErrorDictado::Sistema, None));
        }
        let dir = self.entorno.plataforma.carpeta_whisper();
        let exe = dir.join("whisper-cli.exe");
        if !exe.exists() {
            sloth_core::logger_global::aviso(NOMBRE, &format!("[dictado] falta whisper en {}", dir.display()));
            return resultado_error(error_dictado(TipoErrorDictado::SinMotor, None));
        }
        let (modelo, archivo) = match self.modelo_listo() {
            Ok(m) => m,
            Err(e) => {
                sloth_core::logger_global::aviso(NOMBRE, &format!("[dictado] no se pudo bajar el modelo: {}", e.mensaje));
                return resultado_error(error_de_modelo(&e));
            }
        };
        let tmp = std::env::temp_dir().join(format!("sloth-dictado-{}.wav", comun::nuevo_uuid()));
        if let Err(e) = fs::write(&tmp, wav) {
            return resultado_error(error_dictado(TipoErrorDictado::Otro, Some(&e.to_string())));
        }
        let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let (m, w) = (modelo.to_string_lossy().into_owned(), tmp.to_string_lossy().into_owned());
        let args = whisper_args(&ArgsWhisper { model: &m, wav: &w, threads: hilos(cpus), previo: Some(previo) });
        let inicio = Instant::now();
        let plazo = Duration::from_millis(timeout_ms(wav.len() as u64) as u64);
        let salida = self.ejecutor.ejecutar(&exe.to_string_lossy(), &args, Some(&dir), plazo);
        if let Err(e) = fs::remove_file(&tmp) {
            sloth_core::logger_global::aviso(NOMBRE, &format!("[dictado] no se pudo borrar {}: {e}", tmp.display()));
        }
        if salida.code != 0 || salida.vencio {
            let msg = if salida.vencio { "timed out".to_string() } else { format!("código {}: {}", salida.code, salida.stderr.trim()) };
            sloth_core::logger_global::aviso(NOMBRE, &format!("[dictado] whisper falló: {msg}"));
            return resultado_error(error_dictado(TipoErrorDictado::Otro, detalle_de_fallo(&msg)));
        }
        let texto = texto_de_salida(&salida.stdout);
        let ms = inicio.elapsed().as_millis() as u64;
        let segundos = segundos_de_audio(wav.len() as u64);
        sloth_core::logger_global::info(NOMBRE, &format!("[dictado] {segundos} s de audio en {ms} ms con {archivo}"));
        self.guardar_diagnostico(wav, &json!({ "modelo": archivo, "segundos": segundos, "ms": ms, "previo": previo, "texto": texto, "salida": salida.stdout }));
        json!({ "ok": true, "texto": texto })
    }

    fn pedido_transcribir(self: &Arc<Self>, raw: &Value) -> Result<Value, String> {
        // Llega el WAV solo o { wav, previo }: lo ya dictado, para que la parte siga la oración.
        let (wav, previo) = match raw.get("wav") {
            Some(w) if raw.is_object() => (w, raw.get("previo").unwrap_or(&Value::Null)),
            _ => (raw, &Value::Null),
        };
        let wav = bytes_de(wav).filter(|b| wav_valido(b)).ok_or("Audio inválido.")?;
        let previo = previo_de(previo);
        let _turno = self.turno.lock().unwrap_or_else(|e| e.into_inner());
        Ok(self.transcribir(&wav, &previo))
    }

    fn ajustes(&self, tipo: &Value) -> Result<Value, String> {
        let url = ajustes_por_nombre(tipo).ok_or("Ajuste desconocido.")?;
        self.entorno.plataforma.abrir_uri(url)?;
        Ok(Value::Null)
    }
}

pub fn armar(entorno: Arc<Entorno>, ejecutor: Arc<dyn Ejecutor>, deps: FabricaDeps) -> Arc<Dictado> {
    Arc::new(Dictado { entorno, ejecutor, deps, bajadas: Mutex::default(), turno: Mutex::new(()) })
}

pub fn registrar(router: &mut Router, entorno: Arc<Entorno>) {
    registrar_con(router, armar(entorno, Arc::new(Real), Arc::new(|| Box::new(DepsReales) as Box<dyn ModeloDeps>)));
}

fn registrar_con(router: &mut Router, d: Arc<Dictado>) {
    let t = d.clone();
    router.registrar("feat:dictado:transcribir", move |a: Vec<Value>| t.pedido_transcribir(arg(&a, 0)));
    router.registrar("feat:dictado:ajustes", move |a: Vec<Value>| d.ajustes(arg(&a, 0)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_comunes::{EntornoDePrueba, ReenvioNulo};
    use sloth_core::features::dictado_core::encode_wav;
    use sloth_core::features::proceso::Salida;

    struct Whisper {
        llamadas: Mutex<Vec<(String, Vec<String>, Option<PathBuf>, Duration)>>,
        salida: Salida,
    }

    impl Ejecutor for Whisper {
        fn ejecutar(&self, cmd: &str, args: &[String], cwd: Option<&Path>, plazo: Duration) -> Salida {
            self.llamadas.lock().unwrap().push((cmd.to_string(), args.to_vec(), cwd.map(Path::to_path_buf), plazo));
            self.salida.clone()
        }
    }

    /// La red simulada: sirve `contenido` desde huggingface (o desde donde diga `url_ok`) y anota lo que se pidió.
    struct Red {
        contenido: Vec<u8>,
        pedidas: Arc<Mutex<Vec<String>>>,
    }

    impl ModeloDeps for Red {
        fn fetch(&mut self, url: &str, _: u64) -> Result<RespuestaModelo, String> {
            self.pedidas.lock().unwrap().push(url.to_string());
            let c = self.contenido.clone();
            Ok(RespuestaModelo { status: 200, location: None, content_length: Some(c.len().to_string()), cuerpo: Some(Box::new(std::iter::once(Ok(c)))) })
        }
        fn mkdir(&mut self, d: &str) -> Result<(), ErrorIo> {
            DepsReales.mkdir(d)
        }
        fn abrir(&mut self, p: &str) -> Result<Box<dyn Escritor>, ErrorIo> {
            DepsReales.abrir(p)
        }
        fn rename(&mut self, a: &str, b: &str) -> Result<(), ErrorIo> {
            DepsReales.rename(a, b)
        }
        fn rm(&mut self, p: &str) -> Result<(), ErrorIo> {
            DepsReales.rm(p)
        }
        fn existe(&mut self, p: &str) -> bool {
            Path::new(p).exists()
        }
        fn sleep(&mut self, _: u64) {}
    }

    struct Prueba {
        t: EntornoDePrueba,
        router: Router,
        whisper: Arc<Whisper>,
        pedidas: Arc<Mutex<Vec<String>>>,
    }

    fn armar_prueba(nombre: &str, con_motor: bool, salida: Salida) -> Prueba {
        let t = EntornoDePrueba::nuevo(nombre);
        if con_motor {
            fs::create_dir_all(t.carpeta.join("motor")).unwrap();
            fs::write(t.carpeta.join("motor/whisper-cli.exe"), b"").unwrap();
        }
        t.fijar_apoyo(|canal, _| match canal {
            "feat:settings:get" => Ok(json!({ "settings": { "terminal": { "dictadoPreciso": false } } })),
            _ => Ok(Value::Null),
        });
        let whisper = Arc::new(Whisper { llamadas: Mutex::default(), salida });
        let pedidas: Arc<Mutex<Vec<String>>> = Arc::default();
        let p2 = pedidas.clone();
        let deps: FabricaDeps = Arc::new(move || Box::new(Red { contenido: b"modelo falso".to_vec(), pedidas: p2.clone() }) as Box<dyn ModeloDeps>);
        let mut router = Router::nuevo(Arc::new(ReenvioNulo));
        registrar_con(&mut router, armar(t.entorno.clone(), whisper.clone(), deps));
        Prueba { t, router, whisper, pedidas }
    }

    fn wav() -> Vec<u8> {
        encode_wav(&vec![0.1f32; 16_000], 16_000)
    }

    fn como_arreglo(b: &[u8]) -> Value {
        json!(b)
    }

    fn como_objeto(b: &[u8]) -> Value {
        Value::Object(b.iter().enumerate().map(|(i, x)| (i.to_string(), json!(x))).collect())
    }

    impl Prueba {
        async fn transcribir(&self, arg: Value) -> Result<Value, String> {
            self.router.invocar("feat:dictado:transcribir".into(), vec![arg]).await
        }
        fn con_modelo_chico(&self) {
            fs::create_dir_all(self.t.carpeta.join("whisper")).unwrap();
            fs::write(self.t.carpeta.join("whisper").join(MODELO_CHICO.archivo), b"x").unwrap();
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn transcribe_con_whisper_sin_ventana_con_plazo_y_limpia_la_salida() {
        let p = armar_prueba("dict-ok", true, Salida::ok(" hola che [música]\n"));
        p.con_modelo_chico();
        let v = p.transcribir(json!({ "wav": como_objeto(&wav()), "previo": "ya dije esto" })).await.unwrap();
        assert_eq!(v, json!({ "ok": true, "texto": "hola che" }));
        let llamadas = p.whisper.llamadas.lock().unwrap().clone();
        let (cmd, args, cwd, plazo) = &llamadas[0];
        assert!(cmd.ends_with("whisper-cli.exe"));
        assert_eq!(cwd.as_deref(), Some(p.t.carpeta.join("motor").as_path()));
        assert!(args.iter().any(|a| a.ends_with("ya dije esto")));
        assert_eq!(*plazo, Duration::from_millis(timeout_ms(wav().len() as u64) as u64));
        let wav_tmp = &args[args.iter().position(|a| a == "-f").unwrap() + 1];
        assert!(!Path::new(wav_tmp).exists(), "el WAV temporal se borra");
    }

    #[tokio::test]
    async fn un_audio_que_no_es_wav_se_rechaza() {
        let p = armar_prueba("dict-mal", true, Salida::ok(""));
        assert_eq!(p.transcribir(json!("hola")).await.unwrap_err(), "Audio inválido.");
        assert_eq!(p.transcribir(como_arreglo(b"no es un wav")).await.unwrap_err(), "Audio inválido.");
        assert_eq!(p.transcribir(json!({ "wav": [300] })).await.unwrap_err(), "Audio inválido.");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn sin_motor_avisa_sin_motor() {
        let p = armar_prueba("dict-sinmotor", false, Salida::ok(""));
        let v = p.transcribir(como_arreglo(&wav())).await.unwrap();
        assert_eq!(v["ok"], json!(false));
        assert_eq!(v["error"]["tipo"], json!("sin-motor"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn whisper_vencido_dice_que_tardo_demasiado() {
        let p = armar_prueba("dict-vencido", true, Salida { code: -1, vencio: true, ..Salida::default() });
        p.con_modelo_chico();
        let v = p.transcribir(como_arreglo(&wav())).await.unwrap();
        assert_eq!(v["error"]["mensaje"], json!("No se pudo dictar. (tardó demasiado)"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn sin_modelo_lo_baja_de_huggingface_y_un_hash_distinto_no_queda() {
        let p = armar_prueba("dict-baja", true, Salida::ok("listo"));
        let v = p.transcribir(como_arreglo(&wav())).await.unwrap();
        // El contenido simulado no es el modelo real: el SHA-256 no coincide y no se deja el archivo.
        assert_eq!(v["error"]["tipo"], json!("sin-modelo"));
        assert!(!p.t.carpeta.join("whisper").join(MODELO_CHICO.archivo).exists());
        assert!(p.pedidas.lock().unwrap().iter().all(|u| u.starts_with("https://huggingface.co/")));
        assert_eq!(p.t.eventos().last().map(|e| (e.0.clone(), e.1.clone())), Some(("feat:dictado:modelo".to_string(), vec![Value::Null])));
        assert!(p.whisper.llamadas.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn ajustes_solo_abre_la_lista_cerrada() {
        let p = armar_prueba("dict-ajustes", true, Salida::ok(""));
        assert_eq!(p.router.invocar("feat:dictado:ajustes".into(), vec![json!("otro")]).await.unwrap_err(), "Ajuste desconocido.");
        assert_eq!(p.router.invocar("feat:dictado:ajustes".into(), vec![json!("microfono")]).await.unwrap(), Value::Null);
        assert_eq!(*p.t.plataforma.abiertos.lock().unwrap(), vec!["ms-settings:privacy-microphone".to_string()]);
    }

    #[test]
    fn los_bytes_llegan_como_arreglo_o_como_objeto_con_indices() {
        assert_eq!(bytes_de(&json!([1, 2, 3])), Some(vec![1, 2, 3]));
        assert_eq!(bytes_de(&json!({ "0": 1, "1": 2 })), Some(vec![1, 2]));
        assert_eq!(bytes_de(&json!({ "0": 1, "2": 2 })), None);
        assert_eq!(bytes_de(&json!([256])), None);
    }
}
