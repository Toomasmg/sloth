//! La línea `notify` que Sloth pone en el config.toml de una cuenta de Codex para el aviso de «terminó»
//! (`accounts:setAvisoDeTurno`). Equivale a src/main/codex-notify-core.ts y codex-notify.ts.
//! Nunca pisa un `notify` del usuario, respalda antes de escribir y ante la duda no escribe.
use crate::cuentas::motivo_carpeta_de_codex;
use crate::logger_global;
use crate::proveedores::ProveedorId;
use crate::proveedores_fs::{copiar_exclusivo, preparar_carpeta, sufijo_unico};
use crate::toml_escaner::{analizar, problema_de_duplicados, Sentencia, Tipo};
use regex::Regex;
use serde_json::Value;
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

pub const NOTIFY_MARCA: &str = "# sloth-notify";
const BOM: char = '\u{feff}';

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CambioNotify {
    Agregada,
    Actualizada,
    Igual,
    Ajeno,
    /// El archivo no se pudo leer con seguridad (TOML que no se entiende o con claves repetidas). No se escribe.
    Dudoso,
}

fn clave_propia() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^notify\s*=\s*\[").expect("regex fija"))
}

// Nada de lo que se escribe puede cortar la línea ni colar otra clave: salto de línea o control = no se escribe.
fn tiene_control(s: &str) -> bool {
    s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}

fn a_toml(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

pub fn linea_notify(exe: &str, script: &str) -> Option<String> {
    if exe.is_empty() || script.is_empty() || tiene_control(exe) || tiene_control(script) {
        return None;
    }
    Some(format!("notify = [{}, {}] {NOTIFY_MARCA}", a_toml(exe), a_toml(script)))
}

fn fin_de_linea(l: &str) -> &'static str {
    if l.ends_with("\r\n") {
        "\r\n"
    } else if l.ends_with('\n') {
        "\n"
    } else {
        ""
    }
}

fn partir(toml: &str) -> Vec<String> {
    toml.split_inclusive('\n').map(str::to_owned).collect()
}

fn es_notify_de_raiz(s: &Sentencia) -> bool {
    s.tipo == Tipo::Clave && s.tabla.is_empty() && s.ruta.first().is_some_and(|r| r == "notify")
}

fn es_notify_propio(s: &Sentencia) -> bool {
    es_notify_de_raiz(s) && s.ruta.len() == 1
}

// Una tabla `[notify]` o una clave `notify.x = …` también chocan con una clave `notify` de raíz.
fn choca_con_notify(s: &Sentencia) -> bool {
    if s.tipo == Tipo::Clave {
        es_notify_de_raiz(s)
    } else {
        s.ruta.first().is_some_and(|r| r == "notify")
    }
}

/// Nuestra: una sola línea, clave pelada `notify`, y lo único después del valor es la marca.
fn es_nuestra(toml: &str, s: &Sentencia) -> bool {
    if s.tipo != Tipo::Clave || s.ruta.len() != 1 || s.linea_ini != s.linea_fin || !clave_propia().is_match(&toml[s.desde..s.hasta]) {
        return false;
    }
    let fin = toml[s.hasta..].find('\n').map_or(toml.len(), |k| s.hasta + k);
    toml[s.hasta..fin].trim() == NOTIFY_MARCA
}

enum Busqueda {
    Sin,
    Ajeno,
    Hallada { linea: usize, nuestra: bool },
    Dudoso,
}

/// Lee el archivo con el escáner de TOML y busca la clave `notify` de raíz. Dudar es un resultado: no se escribe.
fn buscar(toml: &str) -> Busqueda {
    let Ok(sentencias) = analizar(toml) else { return Busqueda::Dudoso };
    if problema_de_duplicados(&sentencias).is_some() {
        return Busqueda::Dudoso;
    }
    let chocan: Vec<&Sentencia> = sentencias.iter().filter(|s| choca_con_notify(s)).collect();
    if chocan.is_empty() {
        return Busqueda::Sin;
    }
    let raiz: Vec<&&Sentencia> = chocan.iter().filter(|s| es_notify_de_raiz(s)).collect();
    if chocan.len() > 1 || raiz.len() != 1 || raiz[0].ruta.len() != 1 {
        return Busqueda::Ajeno;
    }
    Busqueda::Hallada { linea: raiz[0].linea_ini, nuestra: es_nuestra(toml, raiz[0]) }
}

/// Agrega al principio (una clave suelta después de una `[tabla]` caería dentro de esa tabla) o actualiza la línea marcada.
/// Una clave `notify` sin la marca es del usuario: no se toca. El resto queda byte a byte.
pub fn aplicar_notify(toml: &str, linea: &str) -> (String, CambioNotify) {
    let (indice, nuestra) = match buscar(toml) {
        Busqueda::Dudoso => return (toml.to_owned(), CambioNotify::Dudoso),
        Busqueda::Ajeno => return (toml.to_owned(), CambioNotify::Ajeno),
        Busqueda::Hallada { linea, nuestra } => (Some(linea), nuestra),
        Busqueda::Sin => (None, true),
    };
    if !nuestra {
        return (toml.to_owned(), CambioNotify::Ajeno);
    }
    let mut lineas = partir(toml);
    if let Some(i) = indice {
        let actual = &lineas[i];
        let bom = if i == 0 && actual.starts_with(BOM) { "\u{feff}" } else { "" };
        let nueva = format!("{bom}{linea}{}", fin_de_linea(actual));
        if &nueva == actual {
            return (toml.to_owned(), CambioNotify::Igual);
        }
        lineas[i] = nueva;
        return (lineas.concat(), CambioNotify::Actualizada);
    }
    let salto = if lineas.first().is_some_and(|l| l.ends_with("\r\n")) { "\r\n" } else { "\n" };
    let (bom, resto) = match toml.strip_prefix(BOM) {
        Some(r) => ("\u{feff}", r),
        None => ("", toml),
    };
    (format!("{bom}{linea}{salto}{resto}"), CambioNotify::Agregada)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotifyQuitado {
    pub toml: String,
    pub quitada: bool,
    pub dudoso: bool,
}

/// Saca solo la línea que puso Sloth. Si no hay (o el archivo es dudoso), devuelve el texto tal cual.
pub fn quitar_notify(toml: &str) -> NotifyQuitado {
    let igual = |dudoso| NotifyQuitado { toml: toml.to_owned(), quitada: false, dudoso };
    if !toml.contains(NOTIFY_MARCA) {
        return igual(false);
    }
    let i = match buscar(toml) {
        Busqueda::Dudoso => return igual(true),
        Busqueda::Hallada { linea, nuestra: true } => linea,
        _ => return igual(false),
    };
    let mut lineas = partir(toml);
    let bom = i == 0 && lineas[0].starts_with(BOM);
    lineas.remove(i);
    let resto = lineas.concat();
    let toml = if bom && !resto.starts_with(BOM) { format!("{BOM}{resto}") } else { resto };
    NotifyQuitado { toml, quitada: true, dudoso: false }
}

fn firma(s: &Sentencia) -> String {
    format!("{:?}|{}|{}", s.tipo, s.tabla.join("\0"), s.ruta.join("\0"))
}

/// Segunda lectura, sobre el texto que se va a escribir: tiene que entenderse, no repetir claves y tener exactamente las
/// mismas claves y tablas que antes, salvo el `notify` de Sloth (uno solo, nuestro, o ninguno). Devuelve el problema.
pub fn verificar_cambio(antes: &str, despues: &str, con_notify: bool) -> Option<&'static str> {
    let (Ok(a), Ok(d)) = (analizar(antes), analizar(despues)) else { return Some("El config.toml no se entiende con seguridad.") };
    if let Some(dup) = problema_de_duplicados(&d) {
        return Some(dup);
    }
    let sin_nuestra = |ss: &[Sentencia]| -> Vec<String> { ss.iter().filter(|s| !es_notify_propio(s)).map(firma).collect() };
    if sin_nuestra(&a) != sin_nuestra(&d) {
        return Some("El config.toml cambiaría más que la línea de Sloth.");
    }
    if d.iter().any(|s| choca_con_notify(s) && !es_notify_propio(s)) {
        return Some("El config.toml quedaría con otro notify.");
    }
    let propias: Vec<&Sentencia> = d.iter().filter(|s| es_notify_propio(s)).collect();
    if propias.len() != usize::from(con_notify) {
        return Some("El config.toml no quedaría con un solo notify.");
    }
    if con_notify && !es_nuestra(despues, propias[0]) {
        return Some("El notify del config.toml no es el de Sloth.");
    }
    None
}

#[derive(Debug)]
pub enum ErrNotify {
    /// El archivo cambió desde que se leyó (Codex lo estaba guardando).
    Cambio,
    /// Lo que quedó en el tmp no pasa la verificación.
    Verif,
    Io(std::io::Error),
}

impl From<std::io::Error> for ErrNotify {
    fn from(e: std::io::Error) -> Self {
        ErrNotify::Io(e)
    }
}

pub trait FsNotify {
    /// None si el archivo no existe.
    fn leer(&self, file: &Path) -> Result<Option<String>, ErrNotify>;
    /// Copia exclusiva a `<file>.sloth-bak`; no hace nada si ya hay una o no hay archivo.
    fn respaldar(&self, file: &Path) -> Result<(), ErrNotify>;
    /// tmp único y rename. Antes del rename relee el tmp (tiene que pasar `verificar`) y el archivo (tiene que seguir igual a
    /// `previo`).
    fn escribir(&self, file: &Path, texto: &str, previo: Option<&str>, verificar: &dyn Fn(&str) -> Option<&'static str>) -> Result<(), ErrNotify>;
}

pub struct FsReal;

fn leer_si_hay(file: &Path) -> std::io::Result<Option<String>> {
    match fs::read_to_string(file) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn con_sufijo(file: &Path, sufijo: &str) -> PathBuf {
    let mut s = file.as_os_str().to_owned();
    s.push(sufijo);
    PathBuf::from(s)
}

impl FsNotify for FsReal {
    fn leer(&self, file: &Path) -> Result<Option<String>, ErrNotify> {
        Ok(leer_si_hay(file)?)
    }

    fn respaldar(&self, file: &Path) -> Result<(), ErrNotify> {
        let bak = con_sufijo(file, ".sloth-bak");
        if !file.exists() || bak.exists() {
            return Ok(());
        }
        match copiar_exclusivo(file, &bak) {
            Err(e) if e.kind() != ErrorKind::AlreadyExists => Err(e.into()),
            _ => Ok(()),
        }
    }

    fn escribir(&self, file: &Path, texto: &str, previo: Option<&str>, verificar: &dyn Fn(&str) -> Option<&'static str>) -> Result<(), ErrNotify> {
        let tmp = con_sufijo(file, &format!(".tmp-{}", sufijo_unico()));
        let r = (|| {
            OpenOptions::new().write(true).create_new(true).open(&tmp)?.write_all(texto.as_bytes())?;
            let leido = fs::read_to_string(&tmp)?;
            if leido != texto || verificar(&leido).is_some() {
                return Err(ErrNotify::Verif);
            }
            // Codex guarda la confianza de cada proyecto en este mismo archivo: si cambió desde que lo leímos, ese cambio se perdería.
            if leer_si_hay(file)?.as_deref() != previo {
                return Err(ErrNotify::Cambio);
            }
            fs::rename(&tmp, file)?;
            Ok(())
        })();
        if r.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        r
    }
}

pub const MOTIVO_AJENO: &str = "Esta cuenta de Codex ya tiene un «notify» propio en su config.toml. Sloth no lo toca, así que no llega el aviso de «terminó».";
pub const MOTIVO_SIN_NODE: &str = "Para el aviso de «terminó» hace falta Node.js en el PATH, y no lo encuentro.";
pub const MOTIVO_RUTA: &str = "La ruta de la carpeta de datos de Sloth tiene caracteres que no se pueden escribir en el config.toml de Codex; no se activa el aviso de «terminó».";
pub const MOTIVO_DUDOSO: &str = "No pude leer con seguridad el config.toml de esta cuenta de Codex (TOML que no entiendo o con claves repetidas). No lo toco, así que no llega el aviso de «terminó».";
pub const MOTIVO_CAMBIO: &str = "El config.toml de la cuenta cambió mientras lo editaba (Codex lo estaba guardando). No escribí nada; probá de nuevo en un momento.";

// Solo el tipo del error: el mensaje del sistema trae la ruta de la carpeta de la cuenta y el log se comparte.
fn motivo_de_error(cual: &str, e: &ErrNotify) -> String {
    match e {
        ErrNotify::Cambio => MOTIVO_CAMBIO.into(),
        ErrNotify::Verif => MOTIVO_DUDOSO.into(),
        ErrNotify::Io(e) => format!("No pude {cual} el config.toml de la cuenta de Codex ({:?}).", e.kind()),
    }
}

/// Pone (o actualiza) la línea `notify` de Sloth en el config.toml de la cuenta. Devuelve el motivo por el que no quedó
/// puesta, o None si quedó. `exe` es el programa que corre el aviso (None si no hay con qué correrlo).
pub fn preparar_notify(config_dir: &Path, exe: Option<&str>, script: &str, fs: &dyn FsNotify) -> Option<String> {
    let Some(exe) = exe else { return Some(MOTIVO_SIN_NODE.into()) };
    let Some(linea) = linea_notify(exe, script) else { return Some(MOTIVO_RUTA.into()) };
    let file = config_dir.join("config.toml");
    let actual = match fs.leer(&file) {
        Ok(a) => a,
        Err(e) => return Some(motivo_de_error("leer", &e)),
    };
    let previo = actual.as_deref().unwrap_or_default();
    let (nuevo, cambio) = aplicar_notify(previo, &linea);
    match cambio {
        CambioNotify::Ajeno => return Some(MOTIVO_AJENO.into()),
        CambioNotify::Dudoso => return Some(MOTIVO_DUDOSO.into()),
        CambioNotify::Igual => return None,
        CambioNotify::Agregada | CambioNotify::Actualizada => {}
    }
    let verificar = |texto: &str| verificar_cambio(previo, texto, true);
    if verificar(&nuevo).is_some() {
        return Some(MOTIVO_DUDOSO.into());
    }
    fs.respaldar(&file).and_then(|()| fs.escribir(&file, &nuevo, actual.as_deref(), &verificar)).err().map(|e| motivo_de_error("escribir", &e))
}

/// Saca solo la línea `notify` que puso Sloth. Sin esa línea no toca el archivo (ni lo respalda).
pub fn desinstalar_notify(config_dir: &Path, fs: &dyn FsNotify) -> Option<String> {
    let file = config_dir.join("config.toml");
    let r = (|| -> Result<Option<String>, ErrNotify> {
        let Some(actual) = fs.leer(&file)? else { return Ok(None) };
        let q = quitar_notify(&actual);
        if q.dudoso {
            return Ok(Some(MOTIVO_DUDOSO.into()));
        }
        if !q.quitada {
            return Ok(None);
        }
        let verificar = |texto: &str| verificar_cambio(&actual, texto, false);
        if verificar(&q.toml).is_some() {
            return Ok(Some(MOTIVO_DUDOSO.into()));
        }
        fs.respaldar(&file)?;
        fs.escribir(&file, &q.toml, Some(&actual), &verificar)?;
        Ok(None)
    })();
    r.unwrap_or_else(|e| Some(motivo_de_error("actualizar", &e)))
}

/// Deja el config.toml de la cuenta de Codex como pide su switch `avisoDeTurno`. `programa` es (ejecutable, script) del
/// aviso; None si no hay con qué correrlo. Devuelve el motivo si no quedó como se pidió.
pub fn ajustar_notify(cuenta: &Value, programa: Option<(&str, &str)>, fs: &dyn FsNotify) -> Option<String> {
    let config_dir = Path::new(cuenta.get("configDir").and_then(Value::as_str).unwrap_or_default());
    if cuenta.get("avisoDeTurno") != Some(&Value::Bool(true)) {
        return desinstalar_notify(config_dir, fs);
    }
    // Sin config.toml queda el de siempre (con el almacén de credenciales en archivo), no uno que solo tenga el notify.
    if let Err(e) = preparar_carpeta(ProveedorId::Codex, config_dir) {
        return Some(motivo_carpeta_de_codex(Some(&format!("{:?}", e.kind()))));
    }
    preparar_notify(config_dir, programa.map(|p| p.0), programa.map_or("", |p| p.1), fs)
}

/// Cada motivo se dice una sola vez: el aviso no lleva datos de la cuenta, así que da igual de cuál venga.
#[derive(Default)]
pub struct AvisoUnaVez(Mutex<HashSet<String>>);

impl AvisoUnaVez {
    /// true la primera vez que llega este mensaje.
    pub fn primera_vez(&self, msg: &str) -> bool {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).insert(msg.to_owned())
    }
}

/// Avisa al log un motivo del aviso de «terminó», una sola vez por arranque.
pub fn avisar_notify(msg: &str) {
    static DICHOS: OnceLock<AvisoUnaVez> = OnceLock::new();
    if DICHOS.get_or_init(AvisoUnaVez::default).primera_vez(msg) {
        logger_global::aviso("codex", msg);
    }
}

#[cfg(test)]
mod tests;
