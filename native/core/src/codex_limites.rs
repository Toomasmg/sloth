//! Cuánto se usó de cada ventana de límite de una cuenta de Codex (`accounts:limitesCodex`), preguntado a `codex app-server`.
//! Equivale a src/main/codex-limites-core.ts y codex-limites.ts.
//!
//! Confirmado con `codex app-server --help` y `generate-json-schema` (codex-cli 0.164), sin arrancar el servidor: habla por
//! stdio; el pedido es `initialize` (params.clientInfo con name y version), la notificación `initialized` y
//! `account/rateLimits/read`; los mensajes no llevan `jsonrpc`. La respuesta trae `rateLimits` con `primary` y `secondary`
//! ({ usedPercent, windowDurationMins, resetsAt }, los dos últimos pueden ser null) y `rateLimitsByLimitId`. El esquema no
//! dice el framing por líneas ni la unidad de `resetsAt`: se asume una línea JSON por mensaje y que un número menor a 1e12
//! son segundos. Si algo no cierra, el resultado es «sin dato».
use crate::cuentas::PermisoLimites;
use crate::features::celular::tipos::VentanaLimite;
use crate::features::tickets::claude_run::{Mirada, Peticion, ProcesoRun, Real, SalidaRun};
use crate::features::tickets::lanzamiento::lanzamiento_de;
use crate::logger_global;
use crate::perfiles_core::es_blanco_js;
use crate::proveedores::{capacidades_de, proveedor_id_de, ProveedorId};
use crate::proveedores_fs::{env_cuenta, estado_login, quitar_del_entorno};
use crate::ptys_core::entorno_limpio;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, RwLock};
use std::time::Duration;

pub const ID_INICIALIZAR: f64 = 1.0;
pub const ID_LIMITES: f64 = 2.0;

const CINCO_HORAS_MIN: f64 = 300.0;
const SEMANA_MIN: f64 = 10080.0;
const TOLERANCIA_CINCO_HORAS: f64 = 5.0;
const TOLERANCIA_SEMANA: f64 = 60.0;
const MARGEN_REINICIO: f64 = 1.1;

const PLAZO: Duration = Duration::from_secs(10);
const TOPE_SALIDA_BYTES: usize = 256 * 1024;
const CACHE_MS: i64 = 5 * 60_000;
const REINTENTO_MS: i64 = 30 * 60_000;
// Cuentas distintas no comparten carpeta: dos lecturas a la vez no se pisan y Ajustes no espera una cola larga.
const MAX_PARALELO: usize = 2;

pub fn linea_inicializar() -> String {
    json!({ "id": 1, "method": "initialize", "params": { "clientInfo": { "name": "sloth", "version": "1" } } }).to_string()
}

pub fn lineas_tras_inicializar() -> [String; 2] {
    [json!({ "method": "initialized" }).to_string(), json!({ "id": 2, "method": "account/rateLimits/read", "params": { "excludeResetCreditDetails": true } }).to_string()]
}

pub fn lineas_de_pedido() -> Vec<String> {
    let mut v = vec![linea_inicializar()];
    v.extend(lineas_tras_inicializar());
    v
}

#[derive(Debug, Clone, PartialEq)]
pub struct Respuesta {
    pub id: f64,
    pub result: Option<Value>,
    pub error: bool,
}

/// None: no es una respuesta a un pedido nuestro (texto suelto, notificación o pedido del servidor).
pub fn leer_respuesta(linea: &str) -> Option<Respuesta> {
    let t = linea.trim_matches(es_blanco_js);
    if !t.starts_with('{') {
        return None;
    }
    let j: Value = serde_json::from_str(t).ok()?;
    let o = j.as_object()?;
    let id = o.get("id")?.as_f64()?;
    if o.contains_key("method") {
        return None;
    }
    if o.get("error").is_some_and(|e| !e.is_null()) {
        return Some(Respuesta { id, result: None, error: true });
    }
    let result = o.get("result")?.clone();
    Some(Respuesta { id, result: Some(result), error: false })
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct LimitesCodex {
    #[serde(rename = "cincoHoras")]
    pub cinco_horas: Option<VentanaLimite>,
    pub semana: Option<VentanaLimite>,
    pub at: i64,
}

/// La primera clave que está, aunque valga null: así lo leía el original y no se mezclan formas.
fn primero<'a>(o: &'a Map<String, Value>, claves: &[&str]) -> Option<&'a Value> {
    claves.iter().find_map(|c| o.get(*c))
}

fn a_ms(v: Option<&Value>) -> Option<f64> {
    let n = v?.as_f64().filter(|n| n.is_finite() && *n > 0.0)?;
    Some(if n < 1e12 { n * 1000.0 } else { n })
}

fn leer_ventana(raw: &Value, ahora: f64) -> Option<(f64, VentanaLimite)> {
    let o = raw.as_object()?;
    let usado = primero(o, &["usedPercent", "used_percent"])?.as_f64()?;
    let minutos = primero(o, &["windowDurationMins", "window_duration_mins"])?.as_f64()?;
    // Sin dato antes que dato falso: un porcentaje fuera de 0-100 no es de fiar.
    if !(0.0..=100.0).contains(&usado) {
        return None;
    }
    let reinicia_en = a_ms(primero(o, &["resetsAt", "resets_at"]));
    if let Some(r) = reinicia_en {
        // Con el reinicio vencido el porcentaje es de la ventana anterior. Uno más lejano que la propia ventana (con un
        // margen) es una unidad mal interpretada: segundos relativos o microsegundos darían fechas absurdas.
        if r <= ahora || r > ahora + minutos * 60_000.0 * MARGEN_REINICIO {
            return None;
        }
    }
    Some((minutos, VentanaLimite { pct: usado, reinicia_en }))
}

fn ventanas_de(snapshot: Option<&Value>, ahora: f64) -> (Option<VentanaLimite>, Option<VentanaLimite>) {
    let (mut cinco, mut semana) = (None, None);
    let Some(o) = snapshot.and_then(Value::as_object) else { return (cinco, semana) };
    // Se asigna por duración, nunca por posición: primary/secondary cambian según el plan.
    for crudo in [o.get("primary"), o.get("secondary")].into_iter().flatten() {
        let Some((minutos, v)) = leer_ventana(crudo, ahora) else { continue };
        if (minutos - CINCO_HORAS_MIN).abs() <= TOLERANCIA_CINCO_HORAS {
            cinco = cinco.or(Some(v));
        } else if (minutos - SEMANA_MIN).abs() <= TOLERANCIA_SEMANA {
            semana = semana.or(Some(v));
        }
    }
    (cinco, semana)
}

/// Nunca falla: lo que no se entiende queda en None.
pub fn limites_de_resultado(result: &Value, ahora: i64) -> LimitesCodex {
    let vacio = LimitesCodex { cinco_horas: None, semana: None, at: ahora };
    let Some(o) = result.as_object() else { return vacio };
    let mut candidatos = vec![primero(o, &["rateLimits", "rate_limits"])];
    if let Some(por_id) = primero(o, &["rateLimitsByLimitId", "rate_limits_by_limit_id"]).and_then(Value::as_object) {
        candidatos.push(por_id.get("codex"));
    }
    for c in candidatos {
        let (cinco_horas, semana) = ventanas_de(c, ahora as f64);
        if cinco_horas.is_some() || semana.is_some() {
            return LimitesCodex { cinco_horas, semana, at: ahora };
        }
    }
    vacio
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ResultadoLectura {
    Datos(LimitesCodex),
    /// La cuenta tiene una terminal abierta: no se lanza nada.
    EnUso,
    SinDato,
}

/// Lo que Ajustes muestra de una cuenta de Codex.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(tag = "tipo")]
pub enum LecturaLimitesCodex {
    #[serde(rename = "datos")]
    Datos { limites: LimitesCodex },
    #[serde(rename = "sin-dato")]
    SinDato {
        #[serde(rename = "reintentaEnMin", skip_serializing_if = "Option::is_none")]
        reintenta_en_min: Option<i64>,
    },
    #[serde(rename = "en-uso")]
    EnUso,
}

pub struct DepsLimites {
    pub proceso: Arc<dyn ProcesoRun>,
    pub ahora: Box<dyn Fn() -> i64 + Send + Sync>,
    pub entorno: Box<dyn Fn() -> Vec<(String, String)> + Send + Sync>,
    pub windows: bool,
}

impl DepsLimites {
    pub fn reales() -> Self {
        let ahora = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
        DepsLimites { proceso: Arc::new(Real), ahora: Box::new(ahora), entorno: Box::new(|| std::env::vars().collect()), windows: cfg!(windows) }
    }
}

type FnPermiso = Box<dyn Fn(&str) -> PermisoLimites + Send + Sync>;

#[derive(Default)]
struct EnCurso {
    valor: Mutex<Option<ResultadoLectura>>,
    listo: Condvar,
}

impl EnCurso {
    fn esperar(&self) -> ResultadoLectura {
        let mut v = self.valor.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(r) = *v {
                return r;
            }
            v = self.listo.wait(v).unwrap_or_else(|e| e.into_inner());
        }
    }

    fn fijar(&self, r: ResultadoLectura) {
        *self.valor.lock().unwrap_or_else(|e| e.into_inner()) = Some(r);
        self.listo.notify_all();
    }
}

#[derive(Default)]
struct Estado {
    cache: HashMap<String, (LimitesCodex, i64)>,
    no_antes_de: HashMap<String, i64>,
    en_curso: HashMap<String, Arc<EnCurso>>,
    activas: usize,
}

/// Experimental: Sloth no abre auth.json ni nada de la carpeta de la cuenta, solo lo hace el proceso de Codex. Nunca se
/// lanza con una terminal abierta de la misma cuenta: app-server puede renovar el token y, como el refresh token es de un
/// solo uso, dejaría al Codex interactivo sin sesión. Cualquier falla da sin dato y esa cuenta no se vuelve a probar por un rato.
pub struct LectorLimites {
    deps: DepsLimites,
    permiso: RwLock<FnPermiso>,
    estado: Mutex<Estado>,
    turno: Condvar,
}

struct Turno<'a>(&'a LectorLimites);

impl Drop for Turno<'_> {
    fn drop(&mut self) {
        self.0.bloquear().activas -= 1;
        self.0.turno.notify_one();
    }
}

fn id_de(cuenta: &Value) -> Option<&str> {
    cuenta.get("id").and_then(Value::as_str)
}

impl LectorLimites {
    pub fn nuevo(deps: DepsLimites) -> Self {
        LectorLimites { deps, permiso: RwLock::new(Box::new(|_| PermisoLimites::Ok)), estado: Mutex::new(Estado::default()), turno: Condvar::new() }
    }

    fn bloquear(&self) -> MutexGuard<'_, Estado> {
        self.estado.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn permiso_de(&self, id: &str) -> PermisoLimites {
        (self.permiso.read().unwrap_or_else(|e| e.into_inner()))(id)
    }

    /// El permiso se pregunta recién cuando le toca el turno a la lectura: hasta entonces la cuenta pudo abrir una terminal
    /// o apagar el switch. Lo arma quien sabe qué terminales hay abiertas (con `cuentas::permiso_de_limites`).
    pub fn conectar_permiso(&self, permiso: impl Fn(&str) -> PermisoLimites + Send + Sync + 'static) {
        *self.permiso.write().unwrap_or_else(|e| e.into_inner()) = Box::new(permiso);
    }

    /// Lo último que se leyó, sin lanzar nada.
    pub fn cacheado(&self, id: &str) -> Option<LimitesCodex> {
        let ahora = (self.deps.ahora)();
        self.bloquear().cache.get(id).filter(|(_, hasta)| *hasta > ahora).map(|(v, _)| *v)
    }

    pub fn en_uso(&self, id: &str) -> bool {
        self.permiso_de(id) == PermisoLimites::EnUso
    }

    /// Minutos que faltan para que se vuelva a probar una cuenta cuya última lectura falló.
    pub fn reintento_en_min(&self, id: &str) -> Option<i64> {
        let falta = self.bloquear().no_antes_de.get(id).copied().unwrap_or(0) - (self.deps.ahora)();
        (falta > 0).then(|| (falta + 59_999) / 60_000)
    }

    /// Borra lo guardado de una cuenta (caché y espera tras un fallo): al apagar y prender el switch o al iniciar sesión se
    /// prueba de nuevo.
    pub fn olvidar(&self, id: &str) {
        let mut e = self.bloquear();
        e.cache.remove(id);
        e.no_antes_de.remove(id);
    }

    /// Bloquea hasta tener el resultado. Dos pedidos de la misma cuenta a la vez son una sola lectura.
    pub fn leer(&self, cuenta: &Value, exe: &str) -> ResultadoLectura {
        let Some(id) = id_de(cuenta) else { return ResultadoLectura::SinDato };
        let permiso = self.permiso_de(id);
        let ahora = (self.deps.ahora)();
        let lectura = {
            let mut e = self.bloquear();
            if let Some(l) = e.en_curso.get(id).cloned() {
                drop(e);
                return l.esperar();
            }
            if let Some((v, _)) = e.cache.get(id).filter(|(_, hasta)| *hasta > ahora) {
                return ResultadoLectura::Datos(*v);
            }
            match permiso {
                PermisoLimites::EnUso => return ResultadoLectura::EnUso,
                PermisoLimites::Apagada => return ResultadoLectura::SinDato,
                PermisoLimites::Ok => {}
            }
            if e.no_antes_de.get(id).is_some_and(|&t| t > ahora) {
                return ResultadoLectura::SinDato;
            }
            let l = Arc::new(EnCurso::default());
            e.en_curso.insert(id.to_owned(), l.clone());
            l
        };
        let r = {
            let _turno = self.esperar_turno();
            self.leer_y_guardar(cuenta, id, exe)
        };
        self.bloquear().en_curso.remove(id);
        lectura.fijar(r);
        r
    }

    fn esperar_turno(&self) -> Turno<'_> {
        let mut e = self.bloquear();
        while e.activas >= MAX_PARALELO {
            e = self.turno.wait(e).unwrap_or_else(|x| x.into_inner());
        }
        e.activas += 1;
        Turno(self)
    }

    fn leer_y_guardar(&self, cuenta: &Value, id: &str, exe: &str) -> ResultadoLectura {
        // Con la cola, lo que valía al pedir la lectura puede haber cambiado: se mira otra vez justo antes de lanzar.
        match self.permiso_de(id) {
            PermisoLimites::EnUso => return ResultadoLectura::EnUso,
            PermisoLimites::Apagada => return ResultadoLectura::SinDato,
            PermisoLimites::Ok => {}
        }
        let valor = self.ejecutar(cuenta, exe);
        let ahora = (self.deps.ahora)();
        let mut e = self.bloquear();
        match valor {
            Some(v) => {
                e.cache.insert(id.to_owned(), (v, ahora + CACHE_MS));
                e.no_antes_de.remove(id);
                ResultadoLectura::Datos(v)
            }
            None => {
                e.no_antes_de.insert(id.to_owned(), ahora + REINTENTO_MS);
                ResultadoLectura::SinDato
            }
        }
    }

    fn ejecutar(&self, cuenta: &Value, exe: &str) -> Option<LimitesCodex> {
        let p = proveedor_id_de(cuenta)?;
        let config_dir = cuenta.get("configDir").and_then(Value::as_str)?;
        let Ok(l) = lanzamiento_de(exe, &["app-server".to_string()], self.deps.windows) else {
            logger_global::aviso("codex", "límites: la ruta de Codex tiene caracteres que cmd.exe no acepta; no se lee.");
            return None;
        };
        let mut env = entorno_limpio((self.deps.entorno)(), &|k| quitar_del_entorno(p, k));
        env.extend(env_cuenta(p, config_dir));
        let peticion = Peticion {
            exe: l.file,
            args: l.args,
            prompt: format!("{}\n", linea_inicializar()),
            cwd: std::env::temp_dir(),
            env: env.into_iter().collect(),
            timeout: PLAZO,
            verbatim: l.verbatim,
            arbol: true,
            stdin_abierto: true,
        };
        let mut resultado: Option<LimitesCodex> = None;
        let mut motivo: Option<&str> = None;
        let mut bytes = 0usize;
        let ahora = &self.deps.ahora;
        let salida = self.deps.proceso.correr(&peticion, None, &mut |linea| {
            bytes += linea.len() + 1;
            if bytes > TOPE_SALIDA_BYTES {
                motivo = Some("Codex mandó demasiada salida");
                return Mirada::Cortar;
            }
            let Some(r) = leer_respuesta(linea) else { return Mirada::Seguir };
            if r.error {
                // Cuenta con API key, versión vieja sin el método o sin sesión: no hay dato que mostrar.
                motivo = Some("Codex contestó con un error");
                Mirada::Cortar
            } else if r.id == ID_INICIALIZAR {
                Mirada::Escribir(lineas_tras_inicializar().iter().map(|l| format!("{l}\n")).collect())
            } else if r.id == ID_LIMITES {
                let v = limites_de_resultado(r.result.as_ref().unwrap_or(&Value::Null), ahora());
                if v.cinco_horas.is_none() && v.semana.is_none() {
                    logger_global::aviso("codex", "límites: la respuesta no trae ninguna ventana usable (otra forma, unidad o duración).");
                }
                resultado = Some(v);
                Mirada::Cortar
            } else {
                Mirada::Seguir
            }
        });
        let motivo = match salida {
            SalidaRun::Cortada => motivo,
            SalidaRun::Plazo => Some("Codex no respondió a tiempo"),
            SalidaRun::NoAbrio(_) => Some("no se pudo lanzar Codex"),
            SalidaRun::Termino { .. } | SalidaRun::Cancelada => Some("Codex se cerró antes de responder"),
        };
        if resultado.is_none() {
            if let Some(m) = motivo {
                logger_global::aviso("codex", &format!("límites: {m}."));
            }
        }
        resultado
    }
}

/// Qué mostrar de los límites de una cuenta de Codex con la lectura activada y la sesión iniciada. Con `esperar` en falso no
/// se espera a Codex: devuelve lo último leído y deja la lectura corriendo aparte.
pub fn limites_de_cuenta(lector: &Arc<LectorLimites>, cuenta: Option<&Value>, esperar: bool, resolver_exe: &dyn Fn(ProveedorId) -> Option<String>) -> LecturaLimitesCodex {
    let sin_dato = LecturaLimitesCodex::SinDato { reintenta_en_min: None };
    let Some(cuenta) = cuenta else { return sin_dato };
    let Some(id) = id_de(cuenta) else { return sin_dato };
    let activada = capacidades_de(cuenta).is_some_and(|c| c.limites_experimental) && cuenta.get("limitesExperimentales") == Some(&Value::Bool(true));
    let (Some(p), true) = (proveedor_id_de(cuenta), activada) else { return sin_dato };
    let config_dir = cuenta.get("configDir").and_then(Value::as_str).unwrap_or_default();
    if !estado_login(p, Path::new(config_dir)).estado.logged_in {
        // Sin sesión no se lee; al iniciarla no tiene que quedar una espera vieja de un fallo anterior.
        lector.olvidar(id);
        return sin_dato;
    }
    let Some(exe) = resolver_exe(p) else { return sin_dato };
    let sin_dato_con_espera = || LecturaLimitesCodex::SinDato { reintenta_en_min: lector.reintento_en_min(id) };
    if esperar {
        return match lector.leer(cuenta, &exe) {
            ResultadoLectura::Datos(limites) => LecturaLimitesCodex::Datos { limites },
            ResultadoLectura::EnUso => LecturaLimitesCodex::EnUso,
            ResultadoLectura::SinDato => sin_dato_con_espera(),
        };
    }
    let (fondo, copia) = (lector.clone(), cuenta.clone());
    std::thread::spawn(move || fondo.leer(&copia, &exe));
    match lector.cacheado(id) {
        Some(limites) => LecturaLimitesCodex::Datos { limites },
        None if lector.en_uso(id) => LecturaLimitesCodex::EnUso,
        None => sin_dato_con_espera(),
    }
}

#[cfg(test)]
mod tests;
