//! Actualizaciones en Rust (`feat:updater:*`) con el updater firmado de Tauri (`latest.json` de las releases de GitHub).
//! Solo en la app instalada. Un hilo busca 20 s después del arranque y después cada 6 h (12 h en modo liviano), salvo con
//! la ventana oculta o minimizada o con batería. Nada se baja solo: lo pide la persona («Actualizar y reiniciar» o «Al
//! cerrar Sloth»). Las terminales viven en el daemon, así que instalar no las corta. El estado y sus pasos están en
//! `sloth_core::features::updater`; el canal beta toma el `latest.json` del release más nuevo aunque sea prerelease.
use super::{comun, AlHook};
use crate::entorno::Entorno;
use crate::router::Router;
use serde_json::Value;
use sloth_core::features::updater::{
    amigable, canal_de_ajustes, cuerpo_del_release, latest_json_beta, pospuesta_el, proximo_chequeo_ms, tags_de, Canal, Encontrada, Estado, Fase, Pospuesta,
    BUSCA_PRIMERO, EN_DESARROLLO_CHEQUEO, EN_DESARROLLO_DESCARGA, PRIMER_CHEQUEO_MS, REINTENTO_MS, SIN_CONEXION, SIN_DESCARGAR,
};
use sloth_core::features::updater_notas::agrupar_notas;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};

pub const NOMBRE: &str = "updater";

const API_GITHUB: &str = "https://api.github.com/repos/Toomasmg/sloth";
const ESPERA_GITHUB: Duration = Duration::from_secs(8);

/// De dónde salen las versiones: el updater de Tauri en la app, uno simulado en las pruebas.
pub trait Fuente: Send + Sync {
    fn buscar(&self, canal: Canal) -> Result<Option<Encontrada>, String>;
    /// Baja la versión encontrada y la guarda para instalarla; `progreso` recibe lo bajado y el total.
    fn bajar(&self, progreso: &mut dyn FnMut(u64, Option<u64>)) -> Result<(), String>;
    /// En Windows lanza el instalador y la app sale sola.
    fn instalar(&self) -> Result<(), String>;
    /// Cuerpo y fecha del release en GitHub, para cuando el update no trae notas.
    fn release_en_github(&self, version: &str) -> (Option<String>, Option<String>);
}

pub struct Actualizador {
    entorno: Arc<Entorno>,
    fuente: Arc<dyn Fuente>,
    habilitado: bool,
    estado: Mutex<Estado>,
    /// Identifica la última descarga: una cancelada o reemplazada no cambia el estado al terminar.
    descarga: AtomicU64,
    instalar_al_salir: AtomicBool,
    /// Cierra la app por el camino de siempre (el instalador corre al salir).
    salir: Arc<dyn Fn() + Send + Sync>,
}

impl Actualizador {
    pub fn nuevo(entorno: Arc<Entorno>, fuente: Arc<dyn Fuente>, habilitado: bool, salir: Arc<dyn Fn() + Send + Sync>) -> Arc<Actualizador> {
        let estado = Estado::nuevo(&entorno.plataforma.version(), habilitado, Canal::Estable);
        Arc::new(Actualizador { entorno, fuente, habilitado, estado: Mutex::new(estado), descarga: AtomicU64::new(0), instalar_al_salir: AtomicBool::new(false), salir })
    }

    fn con_estado<T>(&self, f: impl FnOnce(&mut Estado) -> T) -> T {
        f(&mut self.estado.lock().unwrap_or_else(|e| e.into_inner()))
    }

    fn emitir(&self) -> Value {
        let v = self.con_estado(|s| s.a_json());
        self.entorno.emitir(NOMBRE, "status", std::slice::from_ref(&v));
        v
    }

    pub fn estado(&self) -> Value {
        self.con_estado(|s| s.a_json())
    }

    fn archivo_pospuesta(&self) -> Result<PathBuf, String> {
        Ok(self.entorno.carpeta_features()?.join("updater-later.json"))
    }

    fn pospuesta(&self) -> Option<Pospuesta> {
        let t = fs::read_to_string(self.archivo_pospuesta().ok()?).ok()?;
        Pospuesta::desde_json(&serde_json::from_str(t.strip_prefix('\u{feff}').unwrap_or(&t)).ok()?)
    }

    /// Sin disco, el aviso vuelve en el próximo arranque, nada más.
    fn guardar_pospuesta(&self, p: &Pospuesta) {
        let r = self.archivo_pospuesta().and_then(|f| {
            fs::create_dir_all(f.parent().ok_or("ruta inválida")?).map_err(|e| e.to_string())?;
            let tmp = PathBuf::from(format!("{}.{}.tmp", f.display(), std::process::id()));
            fs::write(&tmp, p.a_json().to_string()).map_err(|e| e.to_string())?;
            fs::rename(&tmp, &f).map_err(|e| e.to_string())
        });
        if let Err(e) = r {
            sloth_core::logger_global::aviso(NOMBRE, &format!("no se pudo guardar «Más tarde»: {e}"));
        }
    }

    pub fn buscar(&self, manual: bool) -> Value {
        if !self.habilitado {
            if manual {
                self.con_estado(|s| s.con_error(EN_DESARROLLO_CHEQUEO));
                return self.emitir();
            }
            return self.estado();
        }
        let canal = canal_de_ajustes(&comun::ajustes(&self.entorno).unwrap_or(Value::Null));
        let Some(antes) = self.con_estado(|s| {
            if s.ocupado() {
                return None;
            }
            let antes = s.clone();
            s.al_buscar(canal);
            Some(antes)
        }) else {
            return self.estado();
        };
        self.emitir();
        match self.fuente.buscar(canal) {
            Ok(Some(e)) => {
                let hoy = pospuesta_el(self.pospuesta().as_ref(), &e.version, &comun::fecha_local(comun::ahora_ms()));
                self.con_estado(|s| s.al_encontrar(&e, hoy));
                self.emitir();
                self.cargar_notas(&e);
            }
            Ok(None) => self.con_estado(|s| s.al_no_haber(comun::ahora_ms())),
            Err(msg) => {
                sloth_core::logger_global::aviso(NOMBRE, &format!("error al buscar actualizaciones: {msg}"));
                // Sin red, el chequeo automático se saltea sin mostrar un error.
                if !manual && amigable(&msg) == SIN_CONEXION {
                    self.con_estado(|s| *s = Estado { channel: canal, ..antes });
                } else {
                    self.con_estado(|s| s.al_fallar(&msg, comun::ahora_ms()));
                }
            }
        }
        self.emitir()
    }

    fn cargar_notas(&self, e: &Encontrada) {
        let (mut texto, mut fecha) = (e.notas.clone(), e.fecha.clone());
        if texto.trim().is_empty() {
            let (cuerpo, publicado) = self.fuente.release_en_github(&e.version);
            texto = cuerpo.unwrap_or_default();
            fecha = fecha.or(publicado);
        }
        if self.con_estado(|s| s.con_notas(&e.version, agrupar_notas(Some(&texto)), fecha)) {
            self.emitir();
        }
    }

    pub fn bajar(self: &Arc<Self>) -> Result<Value, String> {
        if !self.habilitado {
            return Err(EN_DESARROLLO_DESCARGA.into());
        }
        let id = self.con_estado(|s| {
            if matches!(s.state, Fase::Ready | Fase::Downloading) {
                return Ok(None);
            }
            if s.version.is_none() {
                return Err(BUSCA_PRIMERO.to_string());
            }
            s.al_bajar();
            Ok(Some(self.descarga.fetch_add(1, Ordering::SeqCst) + 1))
        })?;
        let Some(id) = id else { return Ok(self.estado()) };
        let v = self.emitir();
        let a = self.clone();
        std::thread::spawn(move || {
            let vigente = |a: &Actualizador| a.descarga.load(Ordering::SeqCst) == id;
            let r = a.fuente.bajar(&mut |bajado, total| {
                if vigente(&a) && a.con_estado(|s| s.al_avanzar(bajado, total)) {
                    a.emitir();
                }
            });
            if !vigente(&a) {
                return;
            }
            match r {
                Ok(()) => {
                    let version = a.con_estado(|s| {
                        s.al_bajada(comun::ahora_ms());
                        s.version.clone().unwrap_or_default()
                    });
                    sloth_core::logger_global::info(NOMBRE, &format!("lista la versión {version}"));
                }
                Err(msg) => {
                    sloth_core::logger_global::aviso(NOMBRE, &format!("error al bajar la actualización: {msg}"));
                    a.con_estado(|s| s.al_fallar(&msg, comun::ahora_ms()));
                }
            }
            a.emitir();
        });
        Ok(v)
    }

    /// Tauri no corta una descarga en curso: termina sola, pero ya no cuenta.
    pub fn cancelar(&self) -> Value {
        if self.con_estado(Estado::al_cancelar) {
            self.descarga.fetch_add(1, Ordering::SeqCst);
            return self.emitir();
        }
        self.estado()
    }

    /// «Más tarde»: oculta el aviso; el punto del acceso a Configuración queda hasta actualizar.
    pub fn posponer(&self) -> Value {
        let hoy = comun::fecha_local(comun::ahora_ms());
        match self.con_estado(|s| s.al_posponer(&hoy)) {
            Some(p) => {
                self.guardar_pospuesta(&p);
                self.emitir()
            }
            None => self.estado(),
        }
    }

    /// «Al cerrar Sloth»: se baja (si hace falta) y se instala al salir.
    pub fn encolar(self: &Arc<Self>) -> Result<Value, String> {
        if !matches!(self.con_estado(|s| s.state), Fase::Ready | Fase::Downloading) {
            self.bajar()?;
        }
        self.con_estado(Estado::al_encolar);
        Ok(self.emitir())
    }

    pub fn instalar(&self) -> Result<Value, String> {
        let (fase, version) = self.con_estado(|s| (s.state, s.version.clone()));
        if fase != Fase::Ready {
            return Err(SIN_DESCARGAR.into());
        }
        sloth_core::logger_global::info(NOMBRE, &format!("instalando {}; las terminales siguen en el daemon", version.unwrap_or_default()));
        self.instalar_al_salir.store(true, Ordering::SeqCst);
        (self.salir)();
        Ok(Value::Bool(true))
    }

    /// El chequeo automático: la ventana oculta (bandeja), minimizada o la batería lo posponen 5 minutos.
    pub fn programar(self: &Arc<Self>, puede_buscar: impl Fn() -> bool + Send + 'static) {
        if !self.habilitado {
            return;
        }
        let a = Arc::downgrade(self);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(PRIMER_CHEQUEO_MS));
            loop {
                let Some(act) = a.upgrade() else { return };
                let espera = if puede_buscar() {
                    act.buscar(false);
                    let liviano = comun::ajuste(&act.entorno, "lightMode").and_then(|v| v.as_bool()).unwrap_or(false);
                    proximo_chequeo_ms(liviano)
                } else {
                    REINTENTO_MS
                };
                drop(act);
                std::thread::sleep(Duration::from_millis(espera));
            }
        });
    }
}

impl AlHook for Actualizador {
    fn al_hook(&self, _: &str, _: Option<&str>) {}

    fn al_salir(&self) {
        let (fase, encolada) = self.con_estado(|s| (s.state, s.queued == Some(true)));
        if fase == Fase::Ready && (encolada || self.instalar_al_salir.load(Ordering::SeqCst)) {
            if let Err(e) = self.fuente.instalar() {
                sloth_core::logger_global::aviso(NOMBRE, &format!("no se pudo instalar la actualización: {e}"));
            }
        }
    }
}

pub fn registrar(router: &mut Router, actualizador: &Arc<Actualizador>) {
    let a = actualizador.clone();
    router.registrar("feat:updater:status", move |_| Ok(a.estado()));
    let a = actualizador.clone();
    router.registrar("feat:updater:check", move |_| Ok(a.buscar(true)));
    let a = actualizador.clone();
    router.registrar("feat:updater:download", move |_| a.bajar());
    let a = actualizador.clone();
    router.registrar("feat:updater:cancel", move |_| Ok(a.cancelar()));
    let a = actualizador.clone();
    router.registrar("feat:updater:later", move |_| Ok(a.posponer()));
    let a = actualizador.clone();
    router.registrar("feat:updater:queue", move |_| a.encolar());
    let a = actualizador.clone();
    router.registrar("feat:updater:install", move |_| a.instalar());
}

/// El updater firmado de Tauri. Genérico en el runtime para probarlo con la app simulada de Tauri.
pub struct FuenteTauri<R: Runtime> {
    app: AppHandle<R>,
    api: String,
    actual: Mutex<Option<(Update, Option<Vec<u8>>)>>,
}

impl<R: Runtime> FuenteTauri<R> {
    pub fn nueva(app: AppHandle<R>, api: &str) -> FuenteTauri<R> {
        FuenteTauri { app, api: api.trim_end_matches('/').to_string(), actual: Mutex::new(None) }
    }

    fn pedir_json(&self, url: &str) -> Result<Option<Value>, String> {
        let agente = ureq::AgentBuilder::new().timeout(ESPERA_GITHUB).build();
        match agente.get(url).set("Accept", "application/vnd.github+json").set("User-Agent", "Sloth").call() {
            Ok(r) => r.into_json::<Value>().map(Some).map_err(|e| e.to_string()),
            Err(ureq::Error::Status(_, _)) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn endpoint_beta(&self) -> Result<tauri::Url, String> {
        let releases = self.pedir_json(&format!("{}/releases?per_page=20", self.api))?.unwrap_or(Value::Null);
        let url = latest_json_beta(&releases).ok_or("Todavía no hay versiones publicadas.")?;
        url.parse::<tauri::Url>().map_err(|e| e.to_string())
    }
}

impl<R: Runtime> Fuente for FuenteTauri<R> {
    fn buscar(&self, canal: Canal) -> Result<Option<Encontrada>, String> {
        let updater = match canal {
            Canal::Estable => self.app.updater(),
            Canal::Beta => self.app.updater_builder().endpoints(vec![self.endpoint_beta()?]).and_then(|b| b.build()),
        }
        .map_err(|e| e.to_string())?;
        let update = tauri::async_runtime::block_on(updater.check()).map_err(|e| e.to_string())?;
        let encontrada = update.as_ref().map(|u| Encontrada {
            version: u.version.clone(),
            // `pub_date` tal cual viene en latest.json (ISO 8601), como `releaseDate` de electron-updater.
            fecha: u.raw_json.get("pub_date").and_then(Value::as_str).map(str::to_string),
            notas: u.body.clone().unwrap_or_default(),
        });
        *self.actual.lock().unwrap_or_else(|e| e.into_inner()) = update.map(|u| (u, None));
        Ok(encontrada)
    }

    fn bajar(&self, progreso: &mut dyn FnMut(u64, Option<u64>)) -> Result<(), String> {
        let u = self.actual.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|(u, _)| u.clone()).ok_or(BUSCA_PRIMERO)?;
        let mut bajado = 0u64;
        let bytes = tauri::async_runtime::block_on(u.download(
            |trozo, total| {
                bajado += trozo as u64;
                progreso(bajado, total);
            },
            || {},
        ))
        .map_err(|e| e.to_string())?;
        if let Some((actual, guardado)) = self.actual.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            if actual.version == u.version {
                *guardado = Some(bytes);
            }
        }
        Ok(())
    }

    fn instalar(&self) -> Result<(), String> {
        let (u, bytes) = self.actual.lock().unwrap_or_else(|e| e.into_inner()).take().ok_or(SIN_DESCARGAR)?;
        u.install(bytes.ok_or(SIN_DESCARGAR)?).map_err(|e| e.to_string())
    }

    fn release_en_github(&self, version: &str) -> (Option<String>, Option<String>) {
        for tag in tags_de(version) {
            if let Ok(Some(r)) = self.pedir_json(&format!("{}/releases/tags/{tag}", self.api)) {
                return cuerpo_del_release(&r);
            }
        }
        (None, None)
    }
}

/// Instalada (con los recursos del instalador), como `app.isPackaged`: en desarrollo y en las pruebas e2e no se busca.
fn instalada(app: &AppHandle) -> bool {
    crate::sidecar::raiz_de_la_app(app).1
}

pub fn registrar_en_tauri(router: &mut Router, entorno: Arc<Entorno>, app: AppHandle) -> Arc<Actualizador> {
    let fuente = Arc::new(FuenteTauri::nueva(app.clone(), API_GITHUB));
    let app_salir = app.clone();
    // Sale como el menú «Salir» de la bandeja; el instalador corre en `al_salir`.
    let a = Actualizador::nuevo(entorno, fuente, instalada(&app), Arc::new(move || super::tray::salir_de_la_app(&app_salir)));
    registrar(router, &a);
    let app_v = app.clone();
    a.programar(move || {
        let ventana_a_la_vista = app_v.get_webview_window("main").is_some_and(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false));
        ventana_a_la_vista && crate::sistema::con_corriente() != Some(false)
    });
    a
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_comunes::{EntornoDePrueba, ReenvioNulo};
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    /// Clave y firma de un par de prueba (`tauri signer`), no la de las releases: firman el texto de `INSTALADOR`.
    const CLAVE_PUBLICA: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQ3N0NCQ0I4MkIzOTY0RDkKUldUWlpEa3J1THg4Ujg5VVRKODZSMDcwRzRBSFp4QndrOEtVdnRGazltWmNLcWVpblpLSHBjekoK";
    const FIRMA: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUWlpEa3J1THg4UjExMUk3WEkwejd2U1NmNWxSVFlkWFVBSXNHMlprb2JHMlpER1VxN0IzVnhDUmd4RXNhYXBGUUs1UG1ldFFEVkJOQmZQQ2pTYnJwbXdNa0JjdUlVaWdNPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk1ODcxODc3CWZpbGU6aW5zdGFsYWRvci5leGUKYjF1T2hUQWhNazEzUmE4MVczWFAyNmdQb0lDOUVtQytuOWI0OU4vZk5YRjNDbFJPMSs5MzBWQytZZkNMUjFrNGx0OWR1SlJZZ1FsaHRsei9KRWthQ1E9PQo=";
    const INSTALADOR: &[u8] = b"instalador de prueba de Sloth";

    type Rutas = Vec<(String, u16, Vec<u8>)>;

    /// Servidor HTTP local con respuestas fijas por ruta (sin red real). Anota las rutas pedidas.
    struct Servidor {
        base: String,
        pedidas: Arc<Mutex<Vec<String>>>,
    }

    fn servidor(rutas: impl FnOnce(&str) -> Rutas) -> Servidor {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        let rutas = rutas(&base);
        let pedidas = Arc::new(Mutex::new(Vec::new()));
        let anotadas = pedidas.clone();
        std::thread::spawn(move || {
            for mut s in l.incoming().map_while(Result::ok) {
                let mut buf = Vec::new();
                let mut trozo = [0u8; 4096];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    match s.read(&mut trozo) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => buf.extend_from_slice(&trozo[..n]),
                    }
                }
                let pedido = String::from_utf8_lossy(&buf);
                let ruta = pedido.split_whitespace().nth(1).unwrap_or("/").to_string();
                anotadas.lock().unwrap().push(ruta.clone());
                let (codigo, cuerpo) = rutas.iter().find(|(r, _, _)| *r == ruta).map(|(_, c, b)| (*c, b.clone())).unwrap_or((404, b"{}".to_vec()));
                let _ = write!(s, "HTTP/1.1 {codigo} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", cuerpo.len());
                let _ = s.write_all(&cuerpo);
            }
        });
        Servidor { base, pedidas }
    }

    fn latest_json(base: &str, version: &str, notas: &str) -> Vec<u8> {
        json!({
            "version": version,
            "notes": notas,
            "pub_date": "2026-11-20T12:00:00Z",
            "platforms": { "windows-x86_64": { "signature": FIRMA, "url": format!("{base}/Sloth-Setup.exe") } }
        })
        .to_string()
        .into_bytes()
    }

    fn app_simulada(endpoint: &str) -> tauri::App<tauri::test::MockRuntime> {
        let mut ctx = tauri::test::mock_context(tauri::test::noop_assets());
        ctx.config_mut().plugins.0.insert("updater".into(), json!({ "pubkey": CLAVE_PUBLICA, "endpoints": [endpoint], "dangerousInsecureTransportProtocol": true }));
        tauri::test::mock_builder().plugin(tauri_plugin_updater::Builder::new().build()).build(ctx).unwrap()
    }

    #[test]
    fn el_updater_de_tauri_encuentra_la_version_del_latest_json_y_baja_el_instalador_firmado() {
        let s = servidor(|b| vec![("/latest.json".into(), 200, latest_json(b, "0.2.0", "## Nuevo\n- algo")), ("/Sloth-Setup.exe".into(), 200, INSTALADOR.to_vec())]);
        let app = app_simulada(&format!("{}/latest.json", s.base));
        let f = FuenteTauri::nueva(app.handle().clone(), &s.base);
        let e = f.buscar(Canal::Estable).unwrap().expect("hay una versión nueva");
        assert_eq!(e, Encontrada { version: "0.2.0".into(), fecha: Some("2026-11-20T12:00:00Z".into()), notas: "## Nuevo\n- algo".into() });
        let mut avances = Vec::new();
        f.bajar(&mut |b, t| avances.push((b, t))).unwrap();
        assert_eq!(avances.last(), Some(&(INSTALADOR.len() as u64, Some(INSTALADOR.len() as u64))));
        assert!(f.actual.lock().unwrap().as_ref().unwrap().1.is_some());
    }

    #[test]
    fn la_misma_version_o_una_vieja_no_es_actualizacion() {
        let s = servidor(|b| vec![("/latest.json".into(), 200, latest_json(b, "0.1.0", ""))]);
        let app = app_simulada(&format!("{}/latest.json", s.base));
        assert_eq!(FuenteTauri::nueva(app.handle().clone(), &s.base).buscar(Canal::Estable), Ok(None));
    }

    #[test]
    fn un_instalador_alterado_no_pasa_la_firma() {
        let s = servidor(|b| vec![("/latest.json".into(), 200, latest_json(b, "0.2.0", "")), ("/Sloth-Setup.exe".into(), 200, b"otro instalador".to_vec())]);
        let app = app_simulada(&format!("{}/latest.json", s.base));
        let f = FuenteTauri::nueva(app.handle().clone(), &s.base);
        f.buscar(Canal::Estable).unwrap();
        let e = f.bajar(&mut |_, _| {}).unwrap_err();
        assert_eq!(amigable(&e), "La descarga llegó dañada; se reintenta en el próximo chequeo.", "{e}");
    }

    #[test]
    fn sin_latest_json_publicado_lo_dice() {
        let s = servidor(|_| vec![]);
        let app = app_simulada(&format!("{}/latest.json", s.base));
        let e = FuenteTauri::nueva(app.handle().clone(), &s.base).buscar(Canal::Estable).unwrap_err();
        assert_eq!(amigable(&e), "Todavía no hay versiones publicadas.", "{e}");
    }

    #[test]
    fn el_canal_beta_busca_en_el_latest_json_del_release_mas_nuevo() {
        let s = servidor(|b| {
            let releases = json!([
                { "draft": false, "prerelease": true, "assets": [{ "name": "latest.json", "browser_download_url": format!("{b}/beta/latest.json") }] },
                { "draft": false, "prerelease": false, "assets": [{ "name": "latest.json", "browser_download_url": format!("{b}/latest.json") }] }
            ]);
            vec![
                ("/releases?per_page=20".into(), 200, releases.to_string().into_bytes()),
                ("/beta/latest.json".into(), 200, latest_json(b, "0.3.0-beta.1", "")),
                ("/latest.json".into(), 200, latest_json(b, "0.2.0", "")),
            ]
        });
        let app = app_simulada(&format!("{}/latest.json", s.base));
        let f = FuenteTauri::nueva(app.handle().clone(), &s.base);
        assert_eq!(f.buscar(Canal::Beta).unwrap().map(|e| e.version).as_deref(), Some("0.3.0-beta.1"));
        assert_eq!(f.buscar(Canal::Estable).unwrap().map(|e| e.version).as_deref(), Some("0.2.0"));
        assert!(s.pedidas.lock().unwrap().contains(&"/beta/latest.json".to_string()));
    }

    #[test]
    fn las_notas_de_github_prueban_el_tag_con_v_y_sin_v() {
        let s = servidor(|_| vec![("/releases/tags/0.2.0".into(), 200, json!({ "body": "- a", "published_at": "2026-11-01T00:00:00Z" }).to_string().into_bytes())]);
        let app = app_simulada(&format!("{}/latest.json", s.base));
        let f = FuenteTauri::nueva(app.handle().clone(), &s.base);
        assert_eq!(f.release_en_github("0.2.0"), (Some("- a".into()), Some("2026-11-01T00:00:00Z".into())));
        assert_eq!(*s.pedidas.lock().unwrap(), ["/releases/tags/v0.2.0", "/releases/tags/0.2.0"]);
        assert_eq!(f.release_en_github("9.9.9"), (None, None));
    }

    /// Fuente simulada: lo que encuentra, si falla y una descarga que termina cuando la prueba lo pide.
    #[derive(Default)]
    struct FuenteSimulada {
        encontrada: Mutex<Option<Result<Option<Encontrada>, String>>>,
        canales: Mutex<Vec<Canal>>,
        github: Mutex<Option<String>>,
        paso: Mutex<Option<mpsc::Receiver<Result<(), String>>>>,
        instaladas: Mutex<u32>,
    }

    impl Fuente for FuenteSimulada {
        fn buscar(&self, canal: Canal) -> Result<Option<Encontrada>, String> {
            self.canales.lock().unwrap().push(canal);
            self.encontrada.lock().unwrap().clone().unwrap_or(Ok(None))
        }
        fn bajar(&self, progreso: &mut dyn FnMut(u64, Option<u64>)) -> Result<(), String> {
            progreso(50, Some(100));
            let rx = self.paso.lock().unwrap().take();
            rx.map(|r| r.recv().unwrap_or(Ok(()))).unwrap_or(Ok(()))
        }
        fn instalar(&self) -> Result<(), String> {
            *self.instaladas.lock().unwrap() += 1;
            Ok(())
        }
        fn release_en_github(&self, _: &str) -> (Option<String>, Option<String>) {
            (self.github.lock().unwrap().clone(), Some("2026-10-10T00:00:00Z".into()))
        }
    }

    struct Prueba {
        t: EntornoDePrueba,
        fuente: Arc<FuenteSimulada>,
        a: Arc<Actualizador>,
        salidas: Arc<Mutex<u32>>,
    }

    fn armar(nombre: &str, habilitado: bool, ajustes: Value) -> Prueba {
        let t = EntornoDePrueba::nuevo(nombre);
        t.plataforma.fijar_version("0.8.0");
        t.fijar_apoyo(move |canal, _| if canal == "feat:settings:get" { Ok(json!({ "settings": ajustes })) } else { Ok(Value::Null) });
        let fuente = Arc::new(FuenteSimulada::default());
        let salidas = Arc::new(Mutex::new(0));
        let s = salidas.clone();
        let a = Actualizador::nuevo(t.entorno.clone(), fuente.clone(), habilitado, Arc::new(move || *s.lock().unwrap() += 1));
        Prueba { t, fuente, a, salidas }
    }

    fn encontrar(p: &Prueba, version: &str, notas: &str) {
        *p.fuente.encontrada.lock().unwrap() = Some(Ok(Some(Encontrada { version: version.into(), fecha: Some("2026-11-20T12:00:00Z".into()), notas: notas.into() })));
    }

    fn estados_emitidos(p: &Prueba) -> Vec<String> {
        p.t.eventos().iter().filter(|(c, _)| c == "feat:updater:status").map(|(_, a)| a[0]["state"].as_str().unwrap_or("").to_string()).collect()
    }

    /// Espera a que el hilo de la descarga deje el estado en `fase`.
    async fn hasta(p: &Prueba, fase: &str) {
        for _ in 0..100 {
            if p.a.estado()["state"] == fase {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("el estado no llegó a {fase}: {}", p.a.estado());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn en_desarrollo_no_se_busca_ni_se_baja() {
        let p = armar("upd-dev", false, json!({}));
        assert_eq!(p.a.estado()["enabled"], json!(false));
        let v = p.a.buscar(true);
        assert_eq!((v["state"].clone(), v["error"].clone()), (json!("error"), json!(EN_DESARROLLO_CHEQUEO)));
        assert!(p.fuente.canales.lock().unwrap().is_empty());
        assert_eq!(p.a.bajar(), Err(EN_DESARROLLO_DESCARGA.into()));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn buscar_encuentra_con_el_canal_de_configuracion_y_agrupa_las_notas() {
        let p = armar("upd-buscar", true, json!({ "updateChannel": "beta" }));
        encontrar(&p, "0.9.0", "## Arreglos\n- a\n## Nuevo\n- b");
        let v = p.a.buscar(true);
        assert_eq!(*p.fuente.canales.lock().unwrap(), [Canal::Beta]);
        assert_eq!((v["state"].clone(), v["version"].clone(), v["channel"].clone(), v["later"].clone()), (json!("available"), json!("0.9.0"), json!("beta"), json!(false)));
        assert_eq!(v["notes"], json!([{ "id": "nuevo", "label": "Nuevo", "items": ["b"] }, { "id": "arreglos", "label": "Arreglos", "items": ["a"] }]));
        assert_eq!(estados_emitidos(&p), ["checking", "available", "available", "available"]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn sin_notas_en_el_update_se_piden_a_github() {
        let p = armar("upd-github", true, json!({}));
        encontrar(&p, "0.9.0", "  ");
        *p.fuente.github.lock().unwrap() = Some("- desde github".into());
        assert_eq!(p.a.buscar(true)["notes"], json!([{ "id": "otros", "label": "Novedades", "items": ["desde github"] }]));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn sin_novedades_queda_al_dia() {
        let p = armar("upd-al-dia", true, json!({}));
        let v = p.a.buscar(true);
        assert_eq!((v["state"].clone(), v["upToDate"].clone(), v["channel"].clone()), (json!("idle"), json!(true), json!("estable")));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn sin_red_el_chequeo_automatico_no_muestra_error_y_el_manual_si() {
        let p = armar("upd-sin-red", true, json!({}));
        *p.fuente.encontrada.lock().unwrap() = Some(Err("error sending request for url (https://github.com/x)".into()));
        assert_eq!(p.a.buscar(false)["state"], json!("idle"));
        assert!(p.a.estado().get("error").is_none());
        let v = p.a.buscar(true);
        assert_eq!((v["state"].clone(), v["error"].clone()), (json!("error"), json!(SIN_CONEXION)));
        assert!(v["checkedAt"].as_u64().unwrap() > 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn mas_tarde_se_guarda_y_la_misma_version_no_vuelve_a_avisar_hoy() {
        let p = armar("upd-mas-tarde", true, json!({}));
        encontrar(&p, "0.9.0", "");
        p.a.buscar(true);
        assert_eq!(p.a.posponer()["later"], json!(true));
        let f = p.t.carpeta.join("perfil").join("features").join("updater-later.json");
        let guardado: Value = serde_json::from_str(&fs::read_to_string(&f).unwrap()).unwrap();
        assert_eq!(guardado, json!({ "version": "0.9.0", "day": comun::fecha_local(comun::ahora_ms()) }));
        // Otro arranque el mismo día: la misma versión llega pospuesta, otra versión vuelve a avisar.
        *p.a.estado.lock().unwrap() = Estado::nuevo("0.8.0", true, Canal::Estable);
        assert_eq!(p.a.buscar(true)["later"], json!(true));
        *p.a.estado.lock().unwrap() = Estado::nuevo("0.8.0", true, Canal::Estable);
        encontrar(&p, "0.9.1", "");
        assert_eq!(p.a.buscar(true)["later"], json!(false));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bajar_exige_una_version_y_avanza_hasta_quedar_lista() {
        let p = armar("upd-bajar", true, json!({}));
        assert_eq!(p.a.bajar(), Err(BUSCA_PRIMERO.into()));
        encontrar(&p, "0.9.0", "");
        p.a.buscar(true);
        assert_eq!(p.a.bajar().unwrap()["state"], json!("downloading"));
        hasta(&p, "ready").await;
        assert!(p.t.eventos().iter().any(|(c, a)| c == "feat:updater:status" && a[0]["percent"] == json!(50) && a[0]["transferred"] == json!(50)));
        assert!(p.a.estado().get("percent").is_none());
        assert_eq!(p.a.bajar().unwrap()["state"], json!("ready"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn una_descarga_cancelada_no_queda_lista_al_terminar() {
        let p = armar("upd-cancelar", true, json!({}));
        encontrar(&p, "0.9.0", "");
        p.a.buscar(true);
        let (tx, rx) = mpsc::channel();
        *p.fuente.paso.lock().unwrap() = Some(rx);
        p.a.bajar().unwrap();
        assert_eq!(p.a.cancelar()["state"], json!("available"));
        tx.send(Ok(())).unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(p.a.estado()["state"], json!("available"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn una_descarga_que_falla_muestra_el_error() {
        let p = armar("upd-falla", true, json!({}));
        encontrar(&p, "0.9.0", "");
        p.a.buscar(true);
        let (tx, rx) = mpsc::channel();
        *p.fuente.paso.lock().unwrap() = Some(rx);
        p.a.bajar().unwrap();
        tx.send(Err("signature verification failed".into())).unwrap();
        hasta(&p, "error").await;
        assert_eq!(p.a.estado()["error"], json!("La descarga llegó dañada; se reintenta en el próximo chequeo."));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn al_cerrar_sloth_baja_y_se_instala_al_salir() {
        let p = armar("upd-encolar", true, json!({}));
        encontrar(&p, "0.9.0", "");
        p.a.buscar(true);
        let v = p.a.encolar().unwrap();
        assert_eq!((v["queued"].clone(), v["later"].clone()), (json!(true), json!(false)));
        hasta(&p, "ready").await;
        assert_eq!(p.a.estado()["queued"], json!(true));
        p.a.al_salir();
        assert_eq!(*p.fuente.instaladas.lock().unwrap(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn instalar_exige_una_version_lista_y_sale_por_el_camino_de_siempre() {
        let p = armar("upd-instalar", true, json!({}));
        assert_eq!(p.a.instalar(), Err(SIN_DESCARGAR.into()));
        p.a.al_salir();
        assert_eq!(*p.fuente.instaladas.lock().unwrap(), 0);
        encontrar(&p, "0.9.0", "");
        p.a.buscar(true);
        p.a.bajar().unwrap();
        hasta(&p, "ready").await;
        assert_eq!(p.a.instalar(), Ok(Value::Bool(true)));
        assert_eq!(*p.salidas.lock().unwrap(), 1);
        p.a.al_salir();
        assert_eq!(*p.fuente.instaladas.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn los_canales_de_la_ui_responden_por_el_router() {
        let p = armar("upd-canales", false, json!({}));
        let mut r = Router::nuevo(Arc::new(ReenvioNulo));
        registrar(&mut r, &p.a);
        for op in ["status", "check", "download", "cancel", "later", "queue", "install"] {
            assert!(r.atiende(&format!("feat:updater:{op}")), "{op}");
        }
        assert_eq!(r.invocar("feat:updater:status".into(), vec![]).await.unwrap()["current"], json!("0.8.0"));
        assert_eq!(r.invocar("feat:updater:install".into(), vec![]).await, Err(SIN_DESCARGAR.into()));
    }
}
