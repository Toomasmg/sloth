//! Canales `feat:report:*` en Rust («Reportar un problema»). Saneo, validación y armado del link viven en
//! `sloth_core::features::report`; acá se juntan los datos del sistema y se abre el issue prellenado en github.com.
use super::arg;
use crate::entorno::Entorno;
use crate::router::Router;
use serde_json::{json, Value};
use sloth_core::features::report::{
    armar_url, es_url_del_issue, leer_cola_del_log, lineas_de_sistema, lineas_recientes, sanitizar, validar_envio, ContextoSaneo, DatosSistema, LOG_KEEP, LOG_MAX_BYTES,
    LOG_MINUTES, LOG_READ_LINES,
};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const NOMBRE: &str = "report";

/// Datos de la máquina para sacarlos del texto: lo mismo que usa report.ts (os.homedir, userInfo, hostname).
struct Maquina {
    home: String,
    usuario: String,
    host: String,
    cuentas: Vec<String>,
}

impl Maquina {
    fn leer(entorno: &Entorno) -> Maquina {
        let var = |k: &str| std::env::var(k).unwrap_or_default();
        // Las cuentas las guarda el proceso de apoyo: solo se leen sus ids para taparlos.
        let cuentas = entorno.lista_del_estado("accounts").iter().filter_map(|a| a.get("id").and_then(Value::as_str).map(String::from)).collect();
        Maquina { home: var("USERPROFILE"), usuario: var("USERNAME"), host: var("COMPUTERNAME"), cuentas }
    }

    fn contexto(&self) -> ContextoSaneo<'_> {
        ContextoSaneo { home: &self.home, username: &self.usuario, hostname: &self.host, account_ids: &self.cuentas }
    }
}

/// `process.arch` de Node, que es lo que mostraba el reporte.
pub(crate) fn arquitectura() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        otra => otra,
    }
}

/// Como os.version() y os.release() de Node: nombre del producto y mayor.menor.build.
#[cfg(windows)]
pub(crate) fn producto_y_release() -> (String, String) {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ};
    let w = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let clave = w(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
    let texto = |nombre: &str| -> Option<String> {
        let mut buf = [0u16; 256];
        let mut tam = (buf.len() * 2) as u32;
        let n = w(nombre);
        // SAFETY: buffers propios con su tamaño en bytes; la clave y el nombre terminan en 0.
        let r = unsafe { RegGetValueW(HKEY_LOCAL_MACHINE, clave.as_ptr(), n.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut tam) };
        (r == 0).then(|| String::from_utf16_lossy(&buf[..(tam as usize / 2).saturating_sub(1)]))
    };
    let numero = |nombre: &str| -> Option<u32> {
        let mut v = 0u32;
        let mut tam = 4u32;
        let n = w(nombre);
        // SAFETY: un DWORD propio de 4 bytes.
        let r = unsafe { RegGetValueW(HKEY_LOCAL_MACHINE, clave.as_ptr(), n.as_ptr(), RRF_RT_REG_DWORD, std::ptr::null_mut(), (&mut v as *mut u32).cast(), &mut tam) };
        (r == 0).then_some(v)
    };
    let producto = texto("ProductName").unwrap_or_default();
    let release = format!("{}.{}.{}", numero("CurrentMajorVersionNumber").unwrap_or(10), numero("CurrentMinorVersionNumber").unwrap_or(0), texto("CurrentBuildNumber").unwrap_or_default());
    (producto, release)
}

#[cfg(not(windows))]
pub(crate) fn producto_y_release() -> (String, String) {
    (std::env::consts::OS.to_string(), String::new())
}

fn version_de_windows() -> String {
    let (producto, release) = producto_y_release();
    format!("{producto} · {release}")
}

/// Como `daemonLine` de report.ts. Las terminales siguen en el proceso de apoyo: se le pregunta sin esperar de más.
fn linea_del_daemon(entorno: &Entorno) -> String {
    let Ok(info) = entorno.pedir("daemon:info", vec![], Duration::from_millis(1500)) else { return "sin iniciar".into() };
    let texto = |k: &str| info.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    match info.get("mode").and_then(Value::as_str) {
        Some("daemon") => format!("daemon {}", texto("version")).trim().to_string(),
        Some(_) => {
            let motivo = texto("reason");
            if motivo.is_empty() { "en proceso".into() } else { format!("en proceso ({motivo})") }
        }
        None => "sin iniciar".into(),
    }
}

fn ahora_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

struct Previa {
    sys: Vec<String>,
    logs: Vec<String>,
}

fn sistema_y_registro(entorno: &Entorno, m: &Maquina) -> Previa {
    let ctx = m.contexto();
    let version = entorno.plataforma.version();
    let windows = version_de_windows();
    let daemon = linea_del_daemon(entorno);
    let datos = DatosSistema {
        sloth: &version,
        windows: &windows,
        arch: arquitectura(),
        // En la versión Tauri no hay Electron: la línea queda vacía, como la dejaba el proceso de apoyo.
        electron: "",
        daemon: &daemon,
        accounts: m.cuentas.len(),
        workspaces: entorno.lista_del_estado("workspaces").len(),
    };
    let sys = lineas_de_sistema(&datos).iter().map(|l| sanitizar(l, &ctx)).collect();
    let cola = leer_cola_del_log(&entorno.raiz().join("daemon.log"), LOG_READ_LINES, LOG_MAX_BYTES);
    let logs = lineas_recientes(&cola, ahora_ms(), LOG_MINUTES, LOG_KEEP).iter().map(|l| sanitizar(l, &ctx)).collect();
    Previa { sys, logs }
}

fn previa(entorno: &Entorno) -> Result<Value, String> {
    let p = sistema_y_registro(entorno, &Maquina::leer(entorno));
    Ok(json!({ "sys": p.sys, "logs": p.logs }))
}

fn enviar(entorno: &Entorno, raw: &Value) -> Result<Value, String> {
    let envio = validar_envio(raw)?;
    // Sin captura en Tauri todavía (ver `capture`): no hay ninguna vigente para adjuntar.
    if envio.con_captura {
        return Err("La captura ya no está disponible: tomala de nuevo.".into());
    }
    // Se sanitiza otra vez acá: lo que llegó desde la UI pudo editarse.
    let m = Maquina::leer(entorno);
    let fresca = sistema_y_registro(entorno, &m);
    let url = armar_url(&envio.form, envio.con_sistema.then_some(&fresca.sys[..]), envio.con_registro.then_some(&fresca.logs[..]), &m.contexto())?;
    // Host fijo: armar_url solo arma github.com/Toomasmg/sloth/issues/new.
    entorno.plataforma.abrir_enlace_externo(&url)?;
    Ok(json!({ "shot": null, "url": url }))
}

pub fn registrar(router: &mut Router, entorno: Arc<Entorno>) {
    let e = entorno.clone();
    router.registrar("feat:report:preview", move |_| previa(&e));
    // WebView2 no expone la captura por Tauri; el proceso de apoyo tampoco la tenía (window.capturePage no existe).
    router.registrar("feat:report:capture", |_| Err("La captura de la ventana todavía no está disponible en esta versión de Sloth.".into()));
    let e = entorno.clone();
    router.registrar("feat:report:submit", move |a| enviar(&e, arg(&a, 0)));
    router.registrar("feat:report:open", move |a| {
        let url = arg(&a, 0);
        if !es_url_del_issue(url) {
            return Err("Ese enlace no es del reporte de Sloth.".into());
        }
        entorno.plataforma.abrir_enlace_externo(url.as_str().unwrap_or_default())?;
        Ok(Value::Null)
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_comunes::{EntornoDePrueba, ReenvioNulo};
    use std::fs;

    fn router(t: &EntornoDePrueba) -> Router {
        let mut r = Router::nuevo(Arc::new(ReenvioNulo));
        registrar(&mut r, t.entorno.clone());
        r
    }

    fn form(extra: Value) -> Value {
        let mut f = json!({ "type": "error", "title": "Se cierra al abrir", "what": "pasó algo", "expect": "", "steps": ["abrir"], "sys": false, "logs": false, "shot": false });
        for (k, v) in extra.as_object().unwrap() {
            f[k] = v.clone();
        }
        f
    }

    #[tokio::test]
    async fn preview_trae_el_sistema_y_el_registro_reciente_saneados() {
        let t = EntornoDePrueba::nuevo("report-previa");
        t.plataforma.fijar_version("1.2.3");
        t.fijar_estado(&json!({ "version": 1, "accounts": [{ "id": "acc-secreta" }], "workspaces": [{ "id": "a" }, { "id": "b" }] }));
        t.fijar_apoyo(|canal, _| if canal == "daemon:info" { Ok(json!({ "mode": "daemon", "version": "9" })) } else { Err("no".into()) });
        let reciente = chrono_like(ahora_ms());
        fs::write(t.carpeta.join("daemon.log"), format!("2001-01-01T00:00:00.000Z viejo\n{reciente} usé la cuenta acc-secreta\n")).unwrap();
        let v = router(&t).invocar("feat:report:preview".into(), vec![]).await.unwrap();
        let sys: Vec<&str> = v["sys"].as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect();
        assert_eq!(sys[0], "Sloth 1.2.3");
        assert!(sys[1].starts_with("Windows ") && sys[1].ends_with(&format!(" · {}", arquitectura())), "{}", sys[1]);
        assert_eq!(sys[3], "Daemon: daemon 9");
        assert_eq!(sys[4], "Cuentas: 1 · Espacios: 2");
        let logs = v["logs"].as_array().unwrap();
        assert_eq!(logs.len(), 1, "{logs:?}");
        assert!(!logs[0].as_str().unwrap().contains("acc-secreta"), "{logs:?}");
    }

    /// Fecha ISO de un instante en ms, como la escribe el log del daemon.
    fn chrono_like(ms: f64) -> String {
        let s = (ms / 1000.0) as i64;
        let (dias, resto) = (s.div_euclid(86_400), s.rem_euclid(86_400));
        let (a, m, d) = civil(dias);
        format!("{a:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z", resto / 3600, resto % 3600 / 60, resto % 60)
    }

    fn civil(dias: i64) -> (i64, i64, i64) {
        let z = dias + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        (yoe + era * 400 + i64::from(m <= 2), m, d)
    }

    #[tokio::test]
    async fn sin_respuesta_del_apoyo_el_daemon_figura_sin_iniciar() {
        let t = EntornoDePrueba::nuevo("report-sindaemon");
        let v = router(&t).invocar("feat:report:preview".into(), vec![]).await.unwrap();
        assert_eq!(v["sys"][3], json!("Daemon: sin iniciar"));
        assert_eq!(v["logs"], json!([]));
    }

    #[tokio::test]
    async fn submit_valida_igual_que_el_ts_y_abre_solo_el_issue_de_github() {
        let t = EntornoDePrueba::nuevo("report-submit");
        let r = router(&t);
        let err = |v: Value| {
            let r = &r;
            async move { r.invocar("feat:report:submit".into(), vec![v]).await.unwrap_err() }
        };
        assert_eq!(err(form(json!({ "type": "nada" }))).await, "Elegí el tipo de reporte.");
        assert_eq!(err(form(json!({ "title": "corto" }))).await, "El título tiene que tener al menos 8 caracteres.");
        assert_eq!(err(form(json!({ "steps": "x" }))).await, "Pasos inválidos.");
        assert_eq!(err(form(json!({ "shot": true }))).await, "La captura ya no está disponible: tomala de nuevo.");
        assert_eq!(err(Value::Null).await, "Elegí el tipo de reporte.");
        assert!(t.plataforma.abiertos.lock().unwrap().is_empty());
        let v = r.invocar("feat:report:submit".into(), vec![form(json!({}))]).await.unwrap();
        let url = v["url"].as_str().unwrap();
        assert!(url.starts_with("https://github.com/Toomasmg/sloth/issues/new?"), "{url}");
        assert_eq!(v["shot"], Value::Null);
        assert_eq!(*t.plataforma.abiertos.lock().unwrap(), vec![url.to_string()]);
        r.invocar("feat:report:open".into(), vec![json!(url)]).await.unwrap();
        assert_eq!(t.plataforma.abiertos.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn open_rechaza_otros_enlaces_y_capture_avisa_que_no_esta() {
        let t = EntornoDePrueba::nuevo("report-open");
        let r = router(&t);
        assert_eq!(r.invocar("feat:report:open".into(), vec![json!("https://evil.example/issues/new?title=x")]).await, Err("Ese enlace no es del reporte de Sloth.".to_string()));
        assert_eq!(r.invocar("feat:report:open".into(), vec![json!(3)]).await, Err("Ese enlace no es del reporte de Sloth.".to_string()));
        assert!(r.invocar("feat:report:capture".into(), vec![]).await.unwrap_err().contains("captura"));
        assert!(t.plataforma.abiertos.lock().unwrap().is_empty());
    }
}
