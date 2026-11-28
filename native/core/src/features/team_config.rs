//! Función «team-config»: configuración compartida en `<repo>/.sloth/team.json` (solo lectura, validación estricta,
//! 256 KB como mucho, nunca se ejecuta nada). Equivale a src/main/features/team-config-core.ts y a las decisiones de
//! team-config.ts (estado por repo, estado de cada equipo, validación de lo que llega por IPC).
use super::team::{largo_utf16, recortar_utf16, Mapeo};
use crate::avisos::Avisos;
use crate::initial_prompt::problema_del_primer_mensaje;
use crate::perfiles_core::es_blanco_js;
use crate::persistencia::{escribir_json_atomico, leer_json, OpcionesLectura};
use base64::Engine;
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;

pub const TEAM_FORMAT: &str = "sloth-team";
pub const TEAM_VERSION: u32 = 1;
pub const TEAM_DIR: &str = ".sloth";
pub const TEAM_FILE: &str = "team.json";
pub const MAX_TEAM_BYTES: usize = 256 * 1024;
const MAX_TEMPLATES: usize = 50;
const MAX_LINKS: usize = 12;
pub const SUGGESTED: &str = "sugerida";

/// Variables del primer mensaje, del nombre y de la rama (src/shared/templates-shared.ts).
pub const TEMPLATE_VARS: [&str; 7] = ["ticket", "ticketmin", "carpeta", "rama", "fecha", "n", "plantilla"];
/// Las que se pueden usar en el patrón de rama: no puede depender de sí misma ni de la carpeta.
pub const BRANCH_VARS: [&str; 5] = ["ticket", "ticketmin", "fecha", "n", "plantilla"];
/// Los mismos valores que la Configuración de Sloth.
pub const DENSITIES: [&str; 2] = ["compacta", "cómoda"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamTemplate {
    pub name: String,
    /// Relativo a la raíz del repo: «.» o una subcarpeta (sin «..»).
    pub repo_path: String,
    /// Siempre «sugerida»: el archivo no sabe qué cuentas tiene cada uno.
    pub cuenta: String,
    pub auto_start_claude: bool,
    pub resume: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_pattern: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_worktree: Option<UseWorktree>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UseWorktree {
    pub branch_pattern: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct TeamSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub densidad: Option<String>,
    /// Tamaño de letra de la terminal, en px.
    #[serde(rename = "tamañoTerminal", skip_serializing_if = "Option::is_none")]
    pub tamano_terminal: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TeamLink {
    pub nombre: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatServerConfig {
    pub supabase_url: String,
    pub anon_key: String,
}

/// Claves en el orden en que las arma `parseTeamConfig`: formato, versión, equipo, plantillas, links, ajustes, chat, avisos.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TeamConfig {
    pub formato: String,
    #[serde(rename = "versión")]
    pub version: u32,
    pub equipo: String,
    pub plantillas: Vec<TeamTemplate>,
    pub links: Vec<TeamLink>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ajustes: Option<TeamSettings>,
    /// Chat del equipo: se usa solo si el usuario lo acepta.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat: Option<ChatServerConfig>,
    /// Partes del archivo que se ignoraron (una plantilla, el chat) sin invalidar el resto.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avisos: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorEquipo {
    Fatal(String),
    /// Un problema que descarta solo esa parte del archivo, no el team.json entero.
    ParteDescartada(String),
}

impl ErrorEquipo {
    pub fn mensaje(&self) -> &str {
        match self {
            ErrorEquipo::Fatal(m) | ErrorEquipo::ParteDescartada(m) => m,
        }
    }
}

type R<T> = Result<T, ErrorEquipo>;

fn falla<T>(msg: impl Into<String>) -> R<T> {
    Err(ErrorEquipo::Fatal(msg.into()))
}

fn re(texto: &'static str, cache: &'static OnceLock<Regex>) -> &'static Regex {
    cache.get_or_init(|| Regex::new(texto).unwrap())
}

/// Claves que no conocemos: error (las que empiezan con «_» o «$» son comentarios y se ignoran).
fn solo_claves(o: &Map<String, Value>, permitidas: &[&str], donde: &str) -> R<()> {
    for k in o.keys() {
        if k.starts_with('_') || k.starts_with('$') {
            continue;
        }
        if !permitidas.contains(&k.as_str()) {
            return falla(format!("{donde}: no conozco la clave «{k}»."));
        }
    }
    Ok(())
}

fn texto(v: Option<&Value>, max: usize, donde: &str, requerido: bool) -> R<Option<String>> {
    let Some(v) = v.filter(|v| !v.is_null()) else {
        return if requerido { falla(format!("{donde}: falta.")) } else { Ok(None) };
    };
    let Some(s) = v.as_str() else { return falla(format!("{donde}: tiene que ser texto.")) };
    let t = s.trim_matches(es_blanco_js);
    if t.is_empty() {
        return if requerido { falla(format!("{donde}: está vacío.")) } else { Ok(None) };
    }
    if largo_utf16(t) > max {
        return falla(format!("{donde}: es demasiado largo (máximo {max})."));
    }
    // Sin caracteres de control (salvo saltos de línea y tab en los prompts).
    static R: OnceLock<Regex> = OnceLock::new();
    if re(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", &R).is_match(t) {
        return falla(format!("{donde}: tiene caracteres de control."));
    }
    Ok(Some(t.to_string()))
}

fn booleano(v: Option<&Value>, donde: &str, por_defecto: bool) -> R<bool> {
    match v {
        None => Ok(por_defecto),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => falla(format!("{donde}: tiene que ser true o false.")),
    }
}

// ---------- variables de plantilla (src/shared/templates-shared.ts) ----------

fn re_variable() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(r"\{([^{}\s]*)\}", &R)
}

/// Nombres de variables que aparecen en un texto (sin llaves).
pub fn variables_en(s: Option<&str>) -> Vec<String> {
    s.map(|s| re_variable().captures_iter(s).map(|m| m[1].to_string()).collect()).unwrap_or_default()
}

pub struct ValoresDeVariables<'a> {
    pub ticket: Option<&'a str>,
    pub fecha: Option<&'a str>,
    pub n: Option<u32>,
    pub plantilla: Option<&'a str>,
}

fn valor_de(nombre: &str, v: &ValoresDeVariables) -> Option<String> {
    match nombre {
        "ticket" => v.ticket.map(String::from),
        "ticketmin" => v.ticket.filter(|t| !t.is_empty()).map(str::to_lowercase),
        "fecha" => v.fecha.map(String::from),
        "n" => v.n.map(|n| n.to_string()),
        "plantilla" => v.plantilla.map(String::from),
        _ => None,
    }
}

/// Reemplaza las variables que tengan valor. Las que faltan quedan como están.
pub fn aplicar_variables(s: &str, v: &ValoresDeVariables) -> String {
    re_variable().replace_all(s, |c: &regex::Captures| valor_de(&c[1], v).unwrap_or_else(|| c[0].to_string())).into_owned()
}

/// Fecha YYYY-MM-DD (UTC: acá solo importa su forma para probar el patrón de rama).
pub fn hoy() -> String {
    let dias = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| (d.as_secs() / 86_400) as i64);
    let z = dias + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let dia = doy - (153 * mp + 2) / 5 + 1;
    let mes = if mp < 10 { mp + 3 } else { mp - 9 };
    let anio = yoe + era * 400 + i64::from(mes <= 2);
    format!("{anio:04}-{mes:02}-{dia:02}")
}

/// Nombre de rama válido para git (subconjunto conservador de check-ref-format).
pub fn rama_valida(b: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    if b.is_empty() || largo_utf16(b) > 200 || !re(r"^[A-Za-z0-9._/-]+$", &R).is_match(b) {
        return false;
    }
    if b.starts_with('-') || b.starts_with('/') || b.ends_with('/') || b.ends_with('.') || b.ends_with(".lock") {
        return false;
    }
    !(b.contains("..") || b.contains("//") || b.contains("/.") || b == "@")
}

fn revisar_variables(s: Option<&str>, donde: &str, permitidas: &[&str]) -> R<()> {
    for v in variables_en(s) {
        if !permitidas.contains(&v.as_str()) {
            let lista = permitidas.iter().map(|x| format!("{{{x}}}")).collect::<Vec<_>>().join(", ");
            return falla(format!("{donde}: variable desconocida {{{v}}}. Usá {lista}."));
        }
    }
    Ok(())
}

// ---------- rutas y links ----------

fn es_absoluta(s: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    s.starts_with('/') || s.starts_with('\\') || re(r"^[A-Za-z]:[\\/]", &R).is_match(s)
}

/// Ruta relativa segura dentro del repo: «.», «apps/web»; nunca absoluta ni con «..».
pub fn ruta_relativa_segura(p: &str) -> Option<String> {
    static R: OnceLock<[Regex; 2]> = OnceLock::new();
    let [unidad, parte] = R.get_or_init(|| [Regex::new(r"^[A-Za-z]:").unwrap(), Regex::new(r"^[A-Za-z0-9._ -]+$").unwrap()]);
    let s = p.replace('\\', "/");
    let s = s.trim_matches(es_blanco_js);
    if s.is_empty() || largo_utf16(s) > 200 {
        return None;
    }
    if es_absoluta(s) || unidad.is_match(s) || s.starts_with('~') {
        return None;
    }
    let partes: Vec<&str> = s.split('/').filter(|x| !x.is_empty() && *x != ".").collect();
    if partes.iter().any(|x| *x == ".." || !parte.is_match(x)) {
        return None;
    }
    Some(if partes.is_empty() { ".".into() } else { partes.join("/") })
}

/// https y nada más (los links se abren con el navegador).
pub fn url_https_segura(u: &Value) -> Option<String> {
    let s = u.as_str().filter(|s| largo_utf16(s) <= 500)?;
    let url = url::Url::parse(s.trim_matches(es_blanco_js)).ok()?;
    let sin_credenciales = url.username().is_empty() && url.password().is_none();
    (url.scheme() == "https" && url.host_str().is_some_and(|h| !h.is_empty()) && sin_credenciales).then(|| url.to_string())
}

// ---------- el chat del equipo (src/main/features/chat-config.ts) ----------

const SECRET_MSG: &str = "Esa es una service_role / secret key. Nunca va en Sloth ni en .sloth/team.json: da acceso total a la base. Usá la anon / publishable key (Project Settings → API).";

/// Valida y normaliza la URL del proyecto. Solo https, sin usuario, sin query, sin hash, sin ruta.
pub fn normalizar_url_supabase(raw: Option<&Value>) -> Result<String, String> {
    let Some(s) = raw.and_then(Value::as_str) else { return Err("La URL de Supabase tiene que ser texto.".into()) };
    let s = s.trim_matches(es_blanco_js);
    if s.is_empty() || largo_utf16(s) > 300 {
        return Err("La URL de Supabase no es válida.".into());
    }
    let Ok(u) = url::Url::parse(s) else { return Err("La URL de Supabase no es válida. Tiene que ser https://<ref>.supabase.co.".into()) };
    if u.scheme() != "https" {
        return Err("La URL de Supabase tiene que empezar con https://.".into());
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err("La URL de Supabase no puede llevar usuario ni contraseña.".into());
    }
    if u.query().is_some_and(|q| !q.is_empty()) || u.fragment().is_some_and(|f| !f.is_empty()) {
        return Err("La URL de Supabase no puede tener ? ni # al final.".into());
    }
    if u.path() != "/" && !u.path().is_empty() {
        return Err("La URL de Supabase no puede tener ruta: va solo la URL del proyecto.".into());
    }
    if u.host_str().is_none_or(str::is_empty) {
        return Err("La URL de Supabase no tiene dominio.".into());
    }
    Ok(u.origin().ascii_serialization())
}

fn payload_jwt(parte: &str) -> Option<Map<String, Value>> {
    let motor = base64::engine::GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true).with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent);
    let bytes = base64::engine::GeneralPurpose::new(&base64::alphabet::URL_SAFE, motor).decode(parte).ok()?;
    match serde_json::from_slice::<Value>(&bytes).ok()? {
        Value::Object(o) => Some(o),
        _ => None,
    }
}

/// Acepta solo una anon key: un JWT con role «anon», o una «sb_publishable_…». Rechaza service_role, «sb_secret_…» y
/// cualquier otra cosa. No verifica la firma: lo que importa es que no sea la de servicio. Nunca repite la key en un error.
pub fn revisar_anon_key(raw: Option<&Value>) -> Result<String, String> {
    static R: OnceLock<[Regex; 2]> = OnceLock::new();
    let [publicable, parte_jwt] = R.get_or_init(|| [Regex::new(r"^sb_publishable_[A-Za-z0-9_-]{8,}$").unwrap(), Regex::new(r"^[A-Za-z0-9_-]+$").unwrap()]);
    let Some(k) = raw.and_then(Value::as_str) else { return Err("La anon key tiene que ser texto.".into()) };
    let k = k.trim_matches(es_blanco_js);
    if k.is_empty() {
        return Err("Falta la anon key.".into());
    }
    if largo_utf16(k) > 2048 {
        return Err("La key es demasiado larga.".into());
    }
    if k.starts_with("sb_secret_") {
        return Err(SECRET_MSG.into());
    }
    if k.starts_with("sb_publishable_") {
        return if publicable.is_match(k) { Ok(k.to_string()) } else { Err("La publishable key no tiene un formato válido.".into()) };
    }
    let partes: Vec<&str> = k.split('.').collect();
    if partes.len() == 3 && partes.iter().all(|p| !p.is_empty() && parte_jwt.is_match(p)) {
        let rol = payload_jwt(partes[1]).and_then(|p| p.get("role").cloned());
        return match rol.as_ref().and_then(Value::as_str) {
            Some("service_role") => Err(SECRET_MSG.into()),
            Some("anon") => Ok(k.to_string()),
            _ => Err("Esa key no es una anon key (el rol del JWT no es «anon»).".into()),
        };
    }
    Err("No reconozco esa key. Usá la anon / publishable key del proyecto (empieza con eyJ… o sb_publishable_…).".into())
}

/// Valida {supabaseUrl, anonKey}. Las claves que empiezan con «_» o «$» son comentarios y se ignoran; cualquier otra es un error.
pub fn leer_config_del_chat(raw: &Value) -> Result<ChatServerConfig, String> {
    let Some(o) = raw.as_object() else { return Err("La configuración del chat tiene que ser un objeto con supabaseUrl y anonKey.".into()) };
    for k in o.keys() {
        if k.starts_with('_') || k.starts_with('$') {
            continue;
        }
        if k != "supabaseUrl" && k != "anonKey" {
            return Err(format!("En el chat no conozco la clave «{k}»."));
        }
    }
    Ok(ChatServerConfig { supabase_url: normalizar_url_supabase(o.get("supabaseUrl"))?, anon_key: revisar_anon_key(o.get("anonKey"))? })
}

// ---------- validar el archivo ----------

fn leer_plantilla(raw: &Value, i: usize) -> R<TeamTemplate> {
    let donde = format!("plantillas[{i}]");
    let Some(o) = raw.as_object() else { return falla(format!("{donde}: tiene que ser un objeto.")) };
    solo_claves(o, &["name", "repoPath", "cuenta", "namePattern", "initialPrompt", "useWorktree", "autoStartClaude", "resume"], &donde)?;
    let name = texto(o.get("name"), 80, &format!("{donde}.name"), true)?.unwrap_or_default();
    let etiqueta = format!("Plantilla «{name}»");
    let repo_crudo = match o.get("repoPath") {
        None => ".".to_string(),
        v => texto(v, 200, &format!("{etiqueta}: repoPath"), true)?.unwrap_or_default(),
    };
    let Some(repo_path) = ruta_relativa_segura(&repo_crudo) else {
        return falla(format!("{etiqueta}: repoPath tiene que ser relativo al repo («.» o una subcarpeta), sin rutas absolutas ni «..»."));
    };
    if o.get("cuenta").is_some_and(|c| c.as_str() != Some(SUGGESTED)) {
        return falla(format!("{etiqueta}: cuenta tiene que ser «{SUGGESTED}» (el archivo es para todo el equipo)."));
    }
    let name_pattern = texto(o.get("namePattern"), 120, &format!("{etiqueta}: namePattern"), false)?;
    let initial_prompt = texto(o.get("initialPrompt"), 4000, &format!("{etiqueta}: initialPrompt"), false)?;
    revisar_variables(name_pattern.as_deref(), &format!("{etiqueta}: namePattern"), &TEMPLATE_VARS)?;
    revisar_variables(initial_prompt.as_deref(), &format!("{etiqueta}: initialPrompt"), &TEMPLATE_VARS)?;
    if let Some(problema) = initial_prompt.as_deref().and_then(problema_del_primer_mensaje) {
        return Err(ErrorEquipo::ParteDescartada(format!("{etiqueta}: {problema} Se ignora esa plantilla.")));
    }
    let mut use_worktree = None;
    if let Some(w) = o.get("useWorktree").filter(|w| !w.is_null() && **w != Value::Bool(false)) {
        let Some(wo) = w.as_object() else { return falla(format!("{etiqueta}: useWorktree tiene que ser {{ \"branchPattern\": \"…\" }}.")) };
        solo_claves(wo, &["branchPattern"], &format!("{etiqueta}: useWorktree"))?;
        let bp = texto(wo.get("branchPattern"), 200, &format!("{etiqueta}: branchPattern"), true)?.unwrap_or_default();
        revisar_variables(Some(&bp), &format!("{etiqueta}: branchPattern"), &BRANCH_VARS)?;
        let muestra = aplicar_variables(&bp, &ValoresDeVariables { ticket: Some("PROJ-1"), fecha: Some(&hoy()), n: Some(1), plantilla: Some(&name) });
        if !rama_valida(&muestra) {
            return falla(format!("{etiqueta}: la rama «{muestra}» no es un nombre válido para git."));
        }
        use_worktree = Some(UseWorktree { branch_pattern: bp });
    }
    Ok(TeamTemplate {
        auto_start_claude: booleano(o.get("autoStartClaude"), &format!("{etiqueta}: autoStartClaude"), true)?,
        resume: booleano(o.get("resume"), &format!("{etiqueta}: resume"), true)?,
        name,
        repo_path,
        cuenta: SUGGESTED.into(),
        name_pattern,
        initial_prompt,
        use_worktree,
    })
}

fn leer_ajustes(raw: Option<&Value>) -> R<Option<TeamSettings>> {
    let Some(raw) = raw.filter(|r| !r.is_null()) else { return Ok(None) };
    let Some(o) = raw.as_object() else { return falla("ajustes: tiene que ser un objeto.") };
    solo_claves(o, &["densidad", "tamañoTerminal"], "ajustes")?;
    let mut out = TeamSettings::default();
    if let Some(d) = o.get("densidad") {
        match d.as_str().filter(|d| DENSITIES.contains(d)) {
            Some(d) => out.densidad = Some(d.to_string()),
            None => return falla(format!("ajustes.densidad: tiene que ser {}.", DENSITIES.iter().map(|d| format!("«{d}»")).collect::<Vec<_>>().join(", "))),
        }
    }
    if let Some(n) = o.get("tamañoTerminal") {
        let entero = n.as_i64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)).filter(|n| (11..=18).contains(n));
        match entero {
            Some(n) if n.is_positive() => out.tamano_terminal = Some(n as u32),
            _ => return falla("ajustes.tamañoTerminal: tiene que ser un número entero entre 11 y 18."),
        }
    }
    Ok((out != TeamSettings::default()).then_some(out))
}

fn leer_links(raw: Option<&Value>) -> R<Vec<TeamLink>> {
    let Some(raw) = raw.filter(|r| !r.is_null()) else { return Ok(vec![]) };
    let Some(lista) = raw.as_array() else { return falla("links: tiene que ser una lista.") };
    if lista.len() > MAX_LINKS {
        return falla(format!("links: como mucho {MAX_LINKS}."));
    }
    lista
        .iter()
        .enumerate()
        .map(|(i, l)| {
            let donde = format!("links[{i}]");
            let Some(o) = l.as_object() else { return falla(format!("{donde}: tiene que ser {{ \"nombre\": \"…\", \"url\": \"https://…\" }}.")) };
            solo_claves(o, &["nombre", "url"], &donde)?;
            let nombre = texto(o.get("nombre"), 40, &format!("{donde}.nombre"), true)?.unwrap_or_default();
            let Some(url) = o.get("url").and_then(url_https_segura) else { return falla(format!("Link «{nombre}»: la url tiene que empezar con https://.")) };
            Ok(TeamLink { nombre, url })
        })
        .collect()
}

/// La primera clave peligrosa, recorriendo como lo hace el reviver de `JSON.parse` (los hijos antes que su propia clave).
fn clave_prohibida(v: &Value) -> Option<String> {
    match v {
        Value::Object(o) => o.iter().find_map(|(k, hijo)| clave_prohibida(hijo).or_else(|| ["__proto__", "constructor", "prototype"].contains(&k.as_str()).then(|| k.clone()))),
        Value::Array(a) => a.iter().find_map(clave_prohibida),
        _ => None,
    }
}

/// Valida el texto de un team.json. Devuelve el mensaje claro del primer problema.
pub fn leer_team_config(texto_in: &str) -> Result<TeamConfig, String> {
    leer_config_interna(texto_in).map_err(|e| e.mensaje().to_string())
}

fn leer_config_interna(texto_in: &str) -> R<TeamConfig> {
    if texto_in.len() > MAX_TEAM_BYTES {
        return falla("El archivo pesa más de 256 KB.");
    }
    let Ok(data) = serde_json::from_str::<Value>(texto_in.strip_prefix('\u{feff}').unwrap_or(texto_in)) else { return falla("No es un JSON válido.") };
    // Sin prototipos: «__proto__» queda como clave común y después se rechaza por desconocida.
    if let Some(k) = clave_prohibida(&data) {
        return falla(format!("Clave no permitida: «{k}»."));
    }
    let Some(o) = data.as_object() else { return falla("El archivo tiene que ser un objeto JSON.") };
    solo_claves(o, &["formato", "versión", "equipo", "plantillas", "ajustes", "links", "chat"], "team.json")?;
    if o.get("formato").and_then(Value::as_str) != Some(TEAM_FORMAT) {
        return falla(format!("formato: tiene que ser «{TEAM_FORMAT}»."));
    }
    if o.get("versión").and_then(Value::as_f64) != Some(f64::from(TEAM_VERSION)) {
        return falla(format!("versión: esta versión de Sloth entiende la {TEAM_VERSION}. Actualizá Sloth."));
    }
    let equipo = texto(o.get("equipo"), 60, "equipo", true)?.unwrap_or_default();
    let crudas: &[Value] = match o.get("plantillas") {
        None => &[],
        Some(Value::Array(a)) => a,
        Some(_) => return falla("plantillas: tiene que ser una lista."),
    };
    if crudas.len() > MAX_TEMPLATES {
        return falla(format!("plantillas: como mucho {MAX_TEMPLATES}."));
    }
    let mut avisos = Vec::new();
    let mut plantillas = Vec::new();
    for (i, raw) in crudas.iter().enumerate() {
        match leer_plantilla(raw, i) {
            Ok(t) => plantillas.push(t),
            Err(ErrorEquipo::ParteDescartada(m)) => avisos.push(m),
            Err(e) => return Err(e),
        }
    }
    let mut vistos = HashSet::new();
    for t in &plantillas {
        if !vistos.insert(t.name.to_lowercase()) {
            return falla(format!("Hay dos plantillas «{}».", t.name));
        }
    }
    let links = leer_links(o.get("links"))?;
    let ajustes = leer_ajustes(o.get("ajustes"))?;
    let mut chat = None;
    if let Some(c) = o.get("chat").filter(|c| !c.is_null()) {
        match leer_config_del_chat(c) {
            Ok(cfg) => chat = Some(cfg),
            Err(e) => avisos.push(format!("chat: {e} Se ignora el chat del equipo.")),
        }
    }
    Ok(TeamConfig { formato: TEAM_FORMAT.into(), version: TEAM_VERSION, equipo, plantillas, links, ajustes, chat, avisos: (!avisos.is_empty()).then_some(avisos) })
}

// ---------- hashes ----------

fn cmp_utf16(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// JSON con las claves ordenadas: el mismo contenido da el mismo hash aunque cambie el formato.
fn canonico(v: &Value) -> String {
    match v {
        Value::Array(a) => format!("[{}]", a.iter().map(canonico).collect::<Vec<_>>().join(",")),
        Value::Object(o) => {
            let mut claves: Vec<&String> = o.keys().collect();
            claves.sort_by(|a, b| cmp_utf16(a, b));
            format!("{{{}}}", claves.iter().map(|k| format!("{}:{}", serde_json::to_string(k).unwrap_or_default(), canonico(&o[*k]))).collect::<Vec<_>>().join(","))
        }
        otro => serde_json::to_string(otro).unwrap_or_default(),
    }
}

fn sha16(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))[..16].to_string()
}

/// Hash de las plantillas (lo que dispara «Hay plantillas nuevas del equipo»).
pub fn hash_de_plantillas(cfg: &TeamConfig) -> String {
    sha16(&canonico(&serde_json::to_value(&cfg.plantillas).unwrap_or(Value::Null)))
}

/// Hash de los ajustes recomendados (para no volver a sugerir lo que ya se aceptó o descartó).
pub fn hash_de_ajustes(cfg: &TeamConfig) -> Option<String> {
    cfg.ajustes.as_ref().map(|a| sha16(&canonico(&serde_json::to_value(a).unwrap_or(Value::Null))))
}

// ---------- rutas del equipo ----------

pub fn ruta_del_archivo(repo: &str) -> PathBuf {
    Path::new(repo).join(TEAM_DIR).join(TEAM_FILE)
}

/// `path.resolve` + `path.normalize` de Node: ruta absoluta, sin `.` ni `..`, sin separadores repetidos ni final.
pub fn resolver(base: &str, rel: &str) -> String {
    let sep = std::path::MAIN_SEPARATOR;
    let junta = if rel.is_empty() {
        base.to_string()
    } else if es_absoluta(rel) {
        rel.to_string()
    } else {
        format!("{base}{sep}{rel}")
    };
    let absoluta = if es_absoluta(&junta) {
        junta
    } else {
        let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
        format!("{cwd}{sep}{junta}")
    };
    let unificada = absoluta.replace(if sep == '\\' { '/' } else { '\\' }, &sep.to_string());
    let (raiz, resto) = if sep == '\\' {
        static R: OnceLock<Regex> = OnceLock::new();
        match re(r"^(?:[A-Za-z]:|\\\\[^\\]+\\[^\\]+)", &R).find(&unificada) {
            Some(m) => (m.as_str().to_string(), unificada[m.end()..].to_string()),
            None => (String::new(), unificada.clone()),
        }
    } else {
        (String::new(), unificada.clone())
    };
    let mut partes: Vec<&str> = Vec::new();
    for p in resto.split(sep).filter(|p| !p.is_empty() && *p != ".") {
        if p == ".." {
            partes.pop();
        } else {
            partes.push(p);
        }
    }
    format!("{raiz}{sep}{}", partes.join(&sep.to_string()))
}

/// Clave estable de un repo (Windows no distingue mayúsculas).
pub fn clave_de_repo(repo: &str) -> String {
    let n = resolver(repo, "");
    let n = if n.len() > 1 { n.trim_end_matches(['\\', '/']).to_string() } else { n };
    if cfg!(windows) {
        n.to_lowercase()
    } else {
        n
    }
}

/// La carpeta absoluta de una plantilla del equipo; se asegura de que quede dentro del repo.
pub fn resolver_repo_del_equipo(repo: &str, rel: &str) -> Option<String> {
    let segura = ruta_relativa_segura(rel)?;
    let abs = resolver(repo, if segura == "." { "" } else { &segura });
    let r = relativo(&resolver(repo, ""), &abs);
    if r.starts_with("..") || es_absoluta(&r) || r.split(['\\', '/']).any(|p| p == "..") {
        return None;
    }
    Some(abs)
}

/// `path.relative` para rutas ya resueltas: vacío si son la misma.
fn relativo(desde: &str, hasta: &str) -> String {
    let sep = std::path::MAIN_SEPARATOR;
    let igual = |a: &str, b: &str| if cfg!(windows) { a.to_lowercase() == b.to_lowercase() } else { a == b };
    let a: Vec<&str> = desde.split(sep).filter(|p| !p.is_empty()).collect();
    let b: Vec<&str> = hasta.split(sep).filter(|p| !p.is_empty()).collect();
    let comun = a.iter().zip(&b).take_while(|(x, y)| igual(x, y)).count();
    let mut partes: Vec<&str> = vec![".."; a.len() - comun];
    partes.extend(&b[comun..]);
    partes.join(&sep.to_string())
}

// ---------- leer el archivo del repo ----------

#[derive(Debug, Clone, PartialEq)]
pub enum Lectura {
    Ninguna,
    Invalida(String),
    Ok { config: TeamConfig, hash: String, hash_ajustes: Option<String>, size: u64, mtime_ms: f64 },
}

/// Lee y valida `<repo>/.sloth/team.json`. Lee por bloques y corta en 256 KB: nunca un archivo enorme entero.
pub fn leer_team_config_del_repo(repo: &str) -> Lectura {
    let archivo = ruta_del_archivo(repo);
    let Ok(st) = fs::metadata(&archivo) else { return Lectura::Ninguna };
    if !st.is_file() {
        return Lectura::Invalida(".sloth/team.json no es un archivo.".into());
    }
    if st.len() > MAX_TEAM_BYTES as u64 {
        return Lectura::Invalida("El archivo pesa más de 256 KB.".into());
    }
    let mut buf = Vec::new();
    let leido = fs::File::open(&archivo).and_then(|f| f.take(MAX_TEAM_BYTES as u64 + 1).read_to_end(&mut buf));
    if leido.is_err() {
        return Lectura::Invalida("No se pudo leer el archivo.".into());
    }
    if buf.len() > MAX_TEAM_BYTES {
        return Lectura::Invalida("El archivo pesa más de 256 KB.".into());
    }
    match leer_team_config(&String::from_utf8_lossy(&buf)) {
        Ok(config) => {
            let mtime_ms = st.modified().ok().and_then(|m| m.duration_since(UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0);
            Lectura::Ok { hash: hash_de_plantillas(&config), hash_ajustes: hash_de_ajustes(&config), config, size: st.len(), mtime_ms }
        }
        Err(e) => Lectura::Invalida(e),
    }
}

// ---------- importar plantillas sin duplicar ----------

/// Lo mínimo que necesitamos de las plantillas guardadas (templates.json).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlantillaLocal {
    pub id: String,
    pub name: String,
    pub repo_path: String,
    pub account_id: Option<String>,
    pub name_pattern: Option<String>,
    pub initial_prompt: Option<String>,
    pub branch_pattern: Option<String>,
    pub auto_start_claude: Option<bool>,
    pub resume: Option<bool>,
}

/// Las plantillas de templates.json que tienen lo mínimo (texto en id, name y repoPath).
pub fn plantillas_locales(raw: &Value) -> Vec<PlantillaLocal> {
    let texto = |o: &Map<String, Value>, k: &str| o.get(k).and_then(Value::as_str).map(String::from);
    raw.get("templates")
        .and_then(Value::as_array)
        .map(|l| {
            l.iter()
                .filter_map(Value::as_object)
                .filter_map(|o| {
                    Some(PlantillaLocal {
                        id: texto(o, "id")?,
                        name: texto(o, "name")?,
                        repo_path: texto(o, "repoPath")?,
                        account_id: texto(o, "accountId"),
                        name_pattern: texto(o, "namePattern"),
                        initial_prompt: texto(o, "initialPrompt"),
                        branch_pattern: o.get("useWorktree").and_then(Value::as_object).and_then(|w| texto(w, "branchPattern")),
                        auto_start_claude: o.get("autoStartClaude").and_then(Value::as_bool),
                        resume: o.get("resume").and_then(Value::as_bool),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AccionPlan {
    New,
    Update,
    Same,
    Renamed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemPlan {
    /// Nombre en el team.json (la identidad de la plantilla del equipo).
    pub key: String,
    pub action: AccionPlan,
    /// Lo que se le pasa a `feat:templates:save` (con `id` si actualiza). Falta si es «same».
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Map<String, Value>>,
    /// Id de la plantilla local si ya existe.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Nombre con el que queda guardada (cambia si chocaba con una plantilla tuya).
    pub saved_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlanDeImportacion {
    pub equipo: String,
    pub hash: String,
    pub items: Vec<ItemPlan>,
    /// Plantillas que importaste antes y el equipo ya no tiene (no se borran).
    pub orphans: Vec<String>,
}

struct Contenido {
    name: String,
    repo_path: String,
    account_id: String,
    name_pattern: Option<String>,
    initial_prompt: Option<String>,
    branch_pattern: Option<String>,
    auto_start_claude: bool,
    resume: bool,
}

impl Contenido {
    fn payload(&self) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("name".into(), json!(self.name));
        m.insert("repoPath".into(), json!(self.repo_path));
        m.insert("accountId".into(), json!(self.account_id));
        if let Some(p) = &self.name_pattern {
            m.insert("namePattern".into(), json!(p));
        }
        if let Some(p) = &self.initial_prompt {
            m.insert("initialPrompt".into(), json!(p));
        }
        if let Some(p) = &self.branch_pattern {
            m.insert("useWorktree".into(), json!({ "branchPattern": p }));
        }
        m.insert("autoStartClaude".into(), json!(self.auto_start_claude));
        m.insert("resume".into(), json!(self.resume));
        m
    }
}

fn mismo_contenido(a: &PlantillaLocal, b: &Contenido) -> bool {
    a.name == b.name
        && clave_de_repo(&a.repo_path) == clave_de_repo(&b.repo_path)
        && a.account_id.as_deref() == Some(b.account_id.as_str())
        && a.name_pattern.as_deref().unwrap_or("") == b.name_pattern.as_deref().unwrap_or("")
        && a.initial_prompt.as_deref().unwrap_or("") == b.initial_prompt.as_deref().unwrap_or("")
        && a.branch_pattern.as_deref().unwrap_or("") == b.branch_pattern.as_deref().unwrap_or("")
        && a.auto_start_claude == Some(b.auto_start_claude)
        && a.resume == Some(b.resume)
}

/// Qué hacer con cada plantilla del equipo. `mapping`: nombre en el team.json (minúsculas) → id local de lo que se
/// importó antes. Nunca duplica: actualiza la que ya importaste, adopta una tuya idéntica, y si una tuya distinta usa el
/// mismo nombre, guarda la del equipo como «Nombre (equipo)».
pub fn planificar_importacion(cfg: &TeamConfig, repo: &str, existentes: &[PlantillaLocal], mapping: &Mapeo, dir_existe: &dyn Fn(&str) -> bool) -> PlanDeImportacion {
    let por_id: HashMap<&str, &PlantillaLocal> = existentes.iter().map(|t| (t.id.as_str(), t)).collect();
    let ids_mapeados: HashSet<&str> = mapping.iter().map(|(_, id)| id).collect();
    let tomada = |nombre: &str| existentes.iter().find(|t| t.name.to_lowercase() == nombre.to_lowercase());
    let mut items = Vec::new();
    let mut reservados: HashSet<String> = HashSet::new();
    for t in &cfg.plantillas {
        let key = t.name.to_lowercase();
        let abs = resolver_repo_del_equipo(repo, &t.repo_path).filter(|a| dir_existe(a));
        let Some(abs) = abs else {
            items.push(ItemPlan { key, action: AccionPlan::New, payload: None, id: None, saved_name: t.name.clone(), error: Some(format!("La carpeta «{}» no existe en este repo.", t.repo_path)) });
            continue;
        };
        let base = Contenido {
            name: t.name.clone(),
            repo_path: abs,
            account_id: SUGGESTED.into(),
            name_pattern: t.name_pattern.clone(),
            initial_prompt: t.initial_prompt.clone(),
            branch_pattern: t.use_worktree.as_ref().map(|w| w.branch_pattern.clone()),
            auto_start_claude: t.auto_start_claude,
            resume: t.resume,
        };
        if let Some(prev) = mapping.get(&key).and_then(|id| por_id.get(id)) {
            // Ya importada: conserva el nombre con el que quedó (puede ser «X (equipo)»).
            let contenido = Contenido { name: prev.name.clone(), ..base };
            reservados.insert(prev.name.to_lowercase());
            let igual = mismo_contenido(prev, &contenido);
            let payload = (!igual).then(|| {
                let mut p = contenido.payload();
                p.insert("id".into(), json!(prev.id));
                p
            });
            items.push(ItemPlan { key, id: Some(prev.id.clone()), saved_name: prev.name.clone(), action: if igual { AccionPlan::Same } else { AccionPlan::Update }, payload, error: None });
            continue;
        }
        let choque = tomada(&t.name);
        if let Some(c) = choque.filter(|c| !ids_mapeados.contains(c.id.as_str()) && mismo_contenido(c, &base)) {
            // Una tuya idéntica: se adopta como del equipo (sin duplicar).
            reservados.insert(c.name.to_lowercase());
            items.push(ItemPlan { key, id: Some(c.id.clone()), saved_name: c.name.clone(), action: AccionPlan::Same, payload: None, error: None });
            continue;
        }
        if choque.is_some() || reservados.contains(&key) {
            let mut alt = recortar_utf16(&format!("{} (equipo)", t.name), 80);
            let mut i = 2;
            while tomada(&alt).is_some() || reservados.contains(&alt.to_lowercase()) {
                alt = recortar_utf16(&format!("{} (equipo {i})", t.name), 80);
                i += 1;
            }
            reservados.insert(alt.to_lowercase());
            let payload = Contenido { name: alt.clone(), ..base }.payload();
            items.push(ItemPlan { key, id: None, saved_name: alt, action: AccionPlan::Renamed, payload: Some(payload), error: None });
            continue;
        }
        reservados.insert(key.clone());
        items.push(ItemPlan { key, id: None, saved_name: t.name.clone(), action: AccionPlan::New, payload: Some(base.payload()), error: None });
    }
    let claves: HashSet<String> = cfg.plantillas.iter().map(|t| t.name.to_lowercase()).collect();
    let orphans = mapping.iter().filter(|(k, id)| !claves.contains(*k) && por_id.contains_key(id)).map(|(_, id)| por_id[id].name.clone()).collect();
    PlanDeImportacion { equipo: cfg.equipo.clone(), hash: hash_de_plantillas(cfg), items, orphans }
}

// ---------- exportar mi configuración como la del equipo ----------

/// Rutas absolutas o correos dentro de un texto (no tienen que salir en el archivo del equipo).
pub fn dato_personal(s: Option<&str>) -> Option<&'static str> {
    static R: OnceLock<[Regex; 3]> = OnceLock::new();
    let [windows, unix, correo] = R.get_or_init(|| {
        [
            Regex::new(r#"(^|[\s"'`(=])([A-Za-z]:[\\/]|\\\\[^\\\s]+\\)"#).unwrap(),
            Regex::new(r#"(^|[\s"'`(=])/(Users|home|mnt|var|opt|tmp)/"#).unwrap(),
            Regex::new(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}").unwrap(),
        ]
    });
    let s = s.filter(|s| !s.is_empty())?;
    if windows.is_match(s) || unix.is_match(s) {
        return Some("una ruta absoluta");
    }
    correo.is_match(s).then_some("un correo")
}

pub struct EntradaDeExportacion<'a> {
    pub equipo: Option<&'a Value>,
    pub links: Option<&'a Value>,
    pub ajustes: Option<&'a Value>,
    /// Nombres de plantillas elegidas (si falta, todas las del repo).
    pub include: Option<&'a Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Salteada {
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Exportacion {
    pub config: TeamConfig,
    pub text: String,
    /// Plantillas que quedaron afuera y por qué.
    pub skipped: Vec<Salteada>,
}

/// Arma el team.json desde mis plantillas que apuntan a este repo (o a una subcarpeta). Sin cuentas (todas «sugerida»),
/// sin rutas absolutas, sin ids, contadores ni fechas.
pub fn armar_exportacion(repo: &str, plantillas_mias: &[PlantillaLocal], entrada: &EntradaDeExportacion) -> Result<Exportacion, String> {
    let equipo = texto(entrada.equipo, 60, "El nombre del equipo", true).map_err(|e| e.mensaje().to_string())?.unwrap_or_default();
    let incluir: Option<HashSet<String>> = match entrada.include {
        None => None,
        Some(Value::Array(a)) => Some(a.iter().filter_map(Value::as_str).map(str::to_lowercase).collect()),
        Some(_) => return Err("Selección inválida.".into()),
    };
    let sep = std::path::MAIN_SEPARATOR;
    let raiz = clave_de_repo(repo);
    let raiz_resuelta = resolver(repo, "");
    let mut saltadas = Vec::new();
    let mut plantillas = Vec::new();
    for t in plantillas_mias {
        let k = clave_de_repo(&t.repo_path);
        if k != raiz && !k.starts_with(&format!("{raiz}{sep}")) {
            continue;
        }
        if incluir.as_ref().is_some_and(|i| !i.contains(&t.name.to_lowercase())) {
            continue;
        }
        let rel = relativo(&raiz_resuelta, &resolver(&t.repo_path, "")).replace(sep, "/");
        let Some(segura) = ruta_relativa_segura(if rel.is_empty() { "." } else { &rel }) else {
            saltadas.push(Salteada { name: t.name.clone(), reason: "su carpeta no está dentro del repo".into() });
            continue;
        };
        let malo = dato_personal(t.initial_prompt.as_deref()).or_else(|| dato_personal(t.name_pattern.as_deref())).or_else(|| dato_personal(t.branch_pattern.as_deref()));
        if let Some(malo) = malo {
            saltadas.push(Salteada { name: t.name.clone(), reason: format!("tiene {malo} en el prompt o en el nombre") });
            continue;
        }
        if let Some(problema) = t.initial_prompt.as_deref().and_then(problema_del_primer_mensaje) {
            saltadas.push(Salteada { name: t.name.clone(), reason: problema.to_string() });
            continue;
        }
        plantillas.push(TeamTemplate {
            name: t.name.clone(),
            repo_path: segura,
            cuenta: SUGGESTED.into(),
            auto_start_claude: t.auto_start_claude != Some(false),
            resume: t.resume != Some(false),
            name_pattern: t.name_pattern.clone().filter(|p| !p.is_empty()),
            initial_prompt: t.initial_prompt.clone().filter(|p| !p.is_empty()),
            use_worktree: t.branch_pattern.clone().filter(|p| !p.is_empty()).map(|branch_pattern| UseWorktree { branch_pattern }),
        });
    }
    let mut borrador = Map::new();
    borrador.insert("formato".into(), json!(TEAM_FORMAT));
    borrador.insert("versión".into(), json!(TEAM_VERSION));
    borrador.insert("equipo".into(), json!(equipo));
    borrador.insert("plantillas".into(), serde_json::to_value(&plantillas).map_err(|e| e.to_string())?);
    if let Some(a) = entrada.ajustes.filter(|a| !a.is_null()) {
        borrador.insert("ajustes".into(), a.clone());
    }
    borrador.insert("links".into(), entrada.links.filter(|l| !l.is_null()).cloned().unwrap_or_else(|| json!([])));
    // Se valida con el mismo lector que la importación: lo que se exporta siempre se puede importar.
    let config = leer_team_config(&(serde_json::to_string_pretty(&Value::Object(borrador)).map_err(|e| e.to_string())? + "\n"))?;
    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())? + "\n";
    Ok(Exportacion { config, text, skipped: saltadas })
}

// ---------- estado por repo (team-config.json) ----------

/// Una entrada de team-config.json. Guarda el objeto tal cual para conservar las claves que no conocemos y el orden en que
/// se fueron agregando (como un objeto de JavaScript).
#[derive(Debug, Clone, PartialEq)]
pub struct EntradaDeEquipo(Map<String, Value>);

impl EntradaDeEquipo {
    pub fn nueva(repo: &str, ahora_ms: u64) -> Self {
        let mut m = Map::new();
        m.insert("repoPath".into(), json!(repo));
        m.insert("mapping".into(), json!({}));
        m.insert("updatedAt".into(), json!(ahora_ms));
        EntradaDeEquipo(m)
    }

    fn texto(&self, k: &str) -> Option<&str> {
        self.0.get(k).and_then(Value::as_str)
    }

    pub fn repo_path(&self) -> &str {
        self.texto("repoPath").unwrap_or_default()
    }

    /// Hash de las plantillas la última vez que se importaron.
    pub fn hash_importado(&self) -> Option<&str> {
        self.texto("importedHash")
    }

    /// «Ahora no» al aviso de plantillas nuevas: se oculta hasta el próximo cambio.
    pub fn hash_descartado(&self) -> Option<&str> {
        self.texto("dismissedHash")
    }

    /// Ajustes recomendados ya aceptados o descartados.
    pub fn hash_de_ajustes(&self) -> Option<&str> {
        self.texto("settingsHash")
    }

    /// Nombre en el team.json (minúsculas) → id de la plantilla local.
    pub fn mapeo(&self) -> Mapeo {
        let mut m = Mapeo::nuevo();
        for (k, v) in self.0.get("mapping").and_then(Value::as_object).into_iter().flatten() {
            if let Some(s) = v.as_str() {
                m.insertar(k, s);
            }
        }
        m
    }

    fn poner(&mut self, k: &str, v: Value) {
        self.0.insert(k.to_string(), v);
    }

    /// `entry.k = undefined`: la clave deja de salir en el JSON y, si vuelve, vuelve al final.
    fn quitar(&mut self, k: &str) {
        self.0 = std::mem::take(&mut self.0).into_iter().filter(|(c, _)| c != k).collect();
    }

    fn poner_mapeo(&mut self, m: &Mapeo) {
        self.poner("mapping", m.a_valor());
    }
}

/// team-config.json: `{ version: 1, teams: { <clave del repo>: entrada } }`. Las claves de la raíz que no conocemos se conservan.
#[derive(Debug, Clone, PartialEq)]
pub struct EstadoPorRepo {
    pub equipos: Vec<(String, EntradaDeEquipo)>,
    pub raiz_extra: Map<String, Value>,
}

pub const VERSION_ESTADO: u32 = 1;

impl EstadoPorRepo {
    pub fn vacio() -> Self {
        EstadoPorRepo { equipos: Vec::new(), raiz_extra: Map::new() }
    }

    /// Descarta lo que no es un objeto con `repoPath` de texto; del mapeo, lo que no es texto.
    pub fn desde_json(v: &Value) -> Option<Self> {
        let o = v.as_object()?;
        let mut e = EstadoPorRepo::vacio();
        for (k, x) in o {
            if k != "version" && k != "teams" {
                e.raiz_extra.insert(k.clone(), x.clone());
            }
        }
        for (k, x) in o.get("teams").and_then(Value::as_object).into_iter().flatten() {
            let Some(entrada) = x.as_object().filter(|x| x.get("repoPath").is_some_and(Value::is_string)) else { continue };
            let mut ent = EntradaDeEquipo(entrada.clone());
            let m = ent.mapeo();
            ent.poner_mapeo(&m);
            e.equipos.push((k.clone(), ent));
        }
        Some(e)
    }

    pub fn a_json(&self) -> Value {
        let mut raiz = Map::new();
        raiz.insert("version".into(), json!(VERSION_ESTADO));
        raiz.insert("teams".into(), Value::Object(self.equipos.iter().map(|(k, e)| (k.clone(), Value::Object(e.0.clone()))).collect()));
        for (k, x) in &self.raiz_extra {
            raiz.insert(k.clone(), x.clone());
        }
        Value::Object(raiz)
    }

    pub fn entrada(&self, repo: &str) -> Option<&EntradaDeEquipo> {
        let k = clave_de_repo(repo);
        self.equipos.iter().find(|(c, _)| *c == k).map(|(_, e)| e)
    }

    pub fn entrada_mut(&mut self, repo: &str, ahora_ms: u64) -> &mut EntradaDeEquipo {
        let k = clave_de_repo(repo);
        let i = match self.equipos.iter().position(|(c, _)| *c == k) {
            Some(i) => i,
            None => {
                self.equipos.push((k, EntradaDeEquipo::nueva(repo, ahora_ms)));
                self.equipos.len() - 1
            }
        };
        &mut self.equipos[i].1
    }
}

/// team-config.json en disco. Con una versión más nueva que la de la app queda en solo lectura y no se reescribe.
pub struct AlmacenPorRepo {
    pub archivo: PathBuf,
    pub estado: EstadoPorRepo,
    pub solo_lectura: bool,
}

impl AlmacenPorRepo {
    pub fn cargar(archivo: PathBuf, avisos: &Avisos) -> Self {
        let validar = |v: &Value| EstadoPorRepo::desde_json(v).map(|e| (e, v.get("version").and_then(Value::as_f64).unwrap_or(1.0)));
        let por_defecto = || (EstadoPorRepo::vacio(), 1.0);
        let lectura = leer_json(&archivo, &OpcionesLectura::nuevas(&validar, &por_defecto), avisos);
        let (estado, version) = lectura.valor;
        let futura = version > f64::from(VERSION_ESTADO);
        if futura {
            avisos.version_futura(&archivo);
        }
        AlmacenPorRepo { archivo, estado, solo_lectura: lectura.solo_lectura || futura }
    }

    pub fn guardar(&self) -> std::io::Result<bool> {
        if self.solo_lectura {
            return Ok(false);
        }
        escribir_json_atomico(&self.archivo, &self.estado.a_json())
    }
}

// ---------- estado de cada equipo, lo que ve la vista ----------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EstadoDeEquipo {
    pub repo_path: String,
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub equipo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    /// Plantillas nuevas o con cambios para importar.
    pub pending: usize,
    /// Cuántas plantillas del equipo tenés importadas.
    pub imported: usize,
    pub total: usize,
    /// Mostrar el aviso «Hay plantillas nuevas del equipo».
    pub notify: bool,
    pub links: Vec<TeamLink>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ajustes: Option<TeamSettings>,
    pub settings_pending: bool,
    /// Partes del archivo que se ignoraron sin invalidar el resto.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avisos: Option<Vec<String>>,
}

/// El estado de un repo, o None si no tiene `.sloth/team.json`.
pub fn estado_de_equipo(repo: &str, lectura: &Lectura, locales: &[PlantillaLocal], entrada: Option<&EntradaDeEquipo>, dir_existe: &dyn Fn(&str) -> bool) -> Option<EstadoDeEquipo> {
    let base = |state, error| EstadoDeEquipo { repo_path: repo.to_string(), state, error, equipo: None, hash: None, pending: 0, imported: 0, total: 0, notify: false, links: vec![], ajustes: None, settings_pending: false, avisos: None };
    match lectura {
        Lectura::Ninguna => None,
        Lectura::Invalida(e) => Some(base("invalid", Some(e.clone()))),
        Lectura::Ok { config, hash, hash_ajustes, .. } => {
            let mapeo = entrada.map(EntradaDeEquipo::mapeo).unwrap_or_default();
            let plan = planificar_importacion(config, repo, locales, &mapeo, dir_existe);
            let pending = plan.items.iter().filter(|i| i.error.is_none() && i.action != AccionPlan::Same).count();
            Some(EstadoDeEquipo {
                equipo: Some(config.equipo.clone()),
                hash: Some(hash.clone()),
                pending,
                imported: plan.items.iter().filter(|i| matches!(i.action, AccionPlan::Same | AccionPlan::Update)).count(),
                total: config.plantillas.len(),
                notify: pending > 0 && entrada.and_then(EntradaDeEquipo::hash_descartado) != Some(hash.as_str()),
                links: config.links.clone(),
                ajustes: config.ajustes.clone(),
                settings_pending: hash_ajustes.as_deref().is_some_and(|h| entrada.and_then(EntradaDeEquipo::hash_de_ajustes) != Some(h)),
                avisos: config.avisos.clone(),
                ..base("ok", None)
            })
        }
    }
}

/// Repos a revisar: los de los espacios y los que ya tienen entrada (onboarding, exportar), sin repetir, hasta 30.
pub fn repos_a_revisar(de_espacios: &[String], de_entradas: &[String], extra: &[String], es_dir: &dyn Fn(&str) -> bool) -> Vec<String> {
    let mut vistos = HashSet::new();
    let mut out = Vec::new();
    for p in de_espacios.iter().chain(de_entradas).chain(extra) {
        if !p.is_empty() && es_dir(p) && vistos.insert(clave_de_repo(p)) {
            out.push(p.clone());
        }
    }
    out.truncate(30);
    out
}

// ---------- lo que llega por IPC ----------

/// El repo de un pedido: texto no vacío, absoluto y que exista como carpeta.
pub fn repo_del_pedido(p: &Value, es_dir: &dyn Fn(&str) -> bool) -> Result<String, String> {
    let Some(s) = p.as_str().map(|s| s.trim_matches(es_blanco_js)).filter(|s| !s.is_empty() && largo_utf16(p.as_str().unwrap_or_default()) <= 1000) else { return Err("Repo inválido.".into()) };
    if !es_absoluta(s) || !es_dir(s) {
        return Err("Esa carpeta no existe.".into());
    }
    Ok(s.to_string())
}

/// Los repos extra del `scan`: hasta 5, de texto, absolutos y de hasta 1000 caracteres.
pub fn extras_del_scan(extra: &Value) -> Vec<String> {
    extra.as_array().map(|l| l.iter().filter_map(Value::as_str).filter(|x| largo_utf16(x) <= 1000 && es_absoluta(x)).take(5).map(String::from).collect()).unwrap_or_default()
}

/// Lo que `markImported` recibe, validado.
pub fn marcar_importado(entrada: &mut EntradaDeEquipo, repo: &str, hash: &Value, mapeo: &Value, lectura: &Lectura, ids_locales: &HashSet<String>, ahora_ms: u64) -> Result<(), String> {
    static R: OnceLock<Regex> = OnceLock::new();
    let datos = || "Datos inválidos.".to_string();
    let hash = hash.as_str().filter(|h| re(r"^[0-9a-f]{16}$", &R).is_match(h)).ok_or_else(datos)?;
    let nuevo = mapeo.as_object().ok_or_else(datos)?;
    let Lectura::Ok { config, hash: hash_actual, .. } = lectura else { return Err("El archivo del equipo cambió o ya no es válido; volvé a intentar.".into()) };
    let claves: HashSet<String> = config.plantillas.iter().map(|t| t.name.to_lowercase()).collect();
    let mut m = entrada.mapeo();
    for (k, id) in nuevo {
        if let Some(id) = id.as_str().filter(|id| claves.contains(k) && ids_locales.contains(*id)) {
            m.insertar(k, id);
        }
    }
    entrada.poner_mapeo(&m);
    // Solo queda «al día» si se importó justo esta versión del archivo.
    if hash == hash_actual {
        entrada.poner("importedHash", json!(hash));
    }
    entrada.poner("equipo", json!(config.equipo));
    entrada.poner("repoPath", json!(repo));
    entrada.poner("updatedAt", json!(ahora_ms));
    Ok(())
}

pub fn descartar_aviso(entrada: &mut EntradaDeEquipo, lectura: &Lectura) -> bool {
    match lectura {
        Lectura::Ok { hash, .. } => {
            entrada.poner("dismissedHash", json!(hash));
            true
        }
        _ => false,
    }
}

pub fn ajustes_listos(entrada: &mut EntradaDeEquipo, lectura: &Lectura) -> bool {
    match lectura {
        Lectura::Ok { hash_ajustes: Some(h), .. } => {
            entrada.poner("settingsHash", json!(h));
            true
        }
        _ => false,
    }
}

/// Lo que se muestra al exportar: mis plantillas del repo, y el equipo, los links y los ajustes actuales si ya hay archivo.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlantillasDelRepo {
    pub templates: Vec<String>,
    pub current: Option<Value>,
    pub exists: bool,
}

pub fn plantillas_del_repo(repo: &str, locales: &[PlantillaLocal], lectura: &Lectura) -> PlantillasDelRepo {
    let k = clave_de_repo(repo);
    let sep = std::path::MAIN_SEPARATOR;
    PlantillasDelRepo {
        templates: locales.iter().filter(|t| { let c = clave_de_repo(&t.repo_path); c == k || c.starts_with(&format!("{k}{sep}")) }).map(|t| t.name.clone()).collect(),
        current: match lectura {
            Lectura::Ok { config, .. } => Some(json!({ "equipo": config.equipo, "links": config.links, "ajustes": config.ajustes })),
            _ => None,
        },
        exists: !matches!(lectura, Lectura::Ninguna),
    }
}

/// El link i del archivo, solo si es https.
pub fn link_del_pedido(lectura: &Lectura, indice: &Value) -> Result<String, String> {
    let invalido = || "Link inválido.".to_string();
    let Lectura::Ok { config, .. } = lectura else { return Err(invalido()) };
    let i = indice.as_i64().or_else(|| indice.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)).ok_or_else(invalido)?;
    let link = usize::try_from(i).ok().and_then(|i| config.links.get(i)).filter(|l| l.url.starts_with("https://")).ok_or_else(invalido)?;
    Ok(link.url.clone())
}

/// Se escribe exactamente lo que el usuario vio y confirmó.
pub fn confirmar_lo_visto(exportacion: &Exportacion, mostrado: &Value) -> Result<(), String> {
    if mostrado.as_str() != Some(exportacion.text.as_str()) {
        return Err("Tus plantillas cambiaron mientras mirabas la vista previa. Revisala de nuevo.".into());
    }
    Ok(())
}

/// Escribe el team.json del repo (carpeta `.sloth`, tmp y rename). Devuelve la ruta.
pub fn escribir_exportacion(repo: &str, text: &str) -> std::io::Result<PathBuf> {
    let destino = ruta_del_archivo(repo);
    if let Some(dir) = destino.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = PathBuf::from(format!("{}.{}.tmp", destino.display(), std::process::id()));
    fs::write(&tmp, text)?;
    fs::rename(&tmp, &destino)?;
    Ok(destino)
}

/// Lo mío ya es «del equipo»: queda mapeado para no duplicarse al importar.
pub fn registrar_exportacion(entrada: &mut EntradaDeEquipo, config: &TeamConfig, locales: &[PlantillaLocal], despues: &Lectura, ahora_ms: u64) {
    let por_nombre: HashMap<String, &str> = locales.iter().map(|t| (t.name.to_lowercase(), t.id.as_str())).collect();
    let mut m = entrada.mapeo();
    for t in &config.plantillas {
        if let Some(id) = por_nombre.get(&t.name.to_lowercase()) {
            m.insertar(&t.name.to_lowercase(), id);
        }
    }
    entrada.poner_mapeo(&m);
    entrada.poner("equipo", json!(config.equipo));
    match despues {
        Lectura::Ok { hash, .. } => entrada.poner("importedHash", json!(hash)),
        _ => entrada.quitar("importedHash"),
    }
    entrada.poner("updatedAt", json!(ahora_ms));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt(rol: &str) -> String {
        let b = |s: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(s);
        format!("{}.{}.firma", b(r#"{"alg":"HS256"}"#), b(&format!(r#"{{"role":"{rol}"}}"#)))
    }

    fn con(extra: Value) -> Value {
        let mut b = json!({ "formato": "sloth-team", "versión": 1, "equipo": "Equipo A" });
        for (k, v) in extra.as_object().unwrap() {
            b[k] = v.clone();
        }
        b
    }

    fn ok(v: Value) -> TeamConfig {
        leer_team_config(&v.to_string()).unwrap_or_else(|e| panic!("{e}"))
    }

    fn mal(v: Value) -> String {
        leer_team_config(&v.to_string()).unwrap_err()
    }

    fn con_plantilla(extra: Value) -> Value {
        let mut p = json!({ "name": "Revisión" });
        for (k, v) in extra.as_object().unwrap() {
            p[k] = v.clone();
        }
        con(json!({ "plantillas": [p] }))
    }

    fn raiz() -> String {
        if cfg!(windows) { "C:\\proyectos\\app".into() } else { "/proyectos/app".into() }
    }

    fn sub(rel: &str) -> String {
        format!("{}{}{}", raiz(), std::path::MAIN_SEPARATOR, rel.replace('/', &std::path::MAIN_SEPARATOR.to_string()))
    }

    fn local(id: &str, name: &str, ruta: &str, cuenta: &str) -> PlantillaLocal {
        PlantillaLocal { id: id.into(), name: name.into(), repo_path: ruta.into(), account_id: Some(cuenta.into()), name_pattern: None, initial_prompt: None, branch_pattern: None, auto_start_claude: Some(true), resume: Some(true) }
    }

    #[test]
    fn lo_minimo_valido_y_rechazos_de_estructura() {
        let c = ok(con(json!({})));
        assert_eq!((c.equipo.as_str(), c.plantillas.len(), c.links.len()), ("Equipo A", 0, 0));
        assert!(c.ajustes.is_none() && c.chat.is_none() && c.avisos.is_none());
        assert_eq!(mal(con(json!({ "formato": "otro" }))), "formato: tiene que ser «sloth-team».");
        assert_eq!(mal(con(json!({ "versión": 2 }))), "versión: esta versión de Sloth entiende la 1. Actualizá Sloth.");
        assert_eq!(mal(con(json!({ "extra": 1 }))), "team.json: no conozco la clave «extra».");
        assert_eq!(mal(json!([1])), "El archivo tiene que ser un objeto JSON.");
        assert_eq!(leer_team_config("{no").unwrap_err(), "No es un JSON válido.");
        assert_eq!(mal(con(json!({ "plantillas": "x" }))), "plantillas: tiene que ser una lista.");
        assert_eq!(mal(json!({ "formato": "sloth-team", "versión": 1 })), "equipo: falta.");
        assert_eq!(mal(con(json!({ "equipo": "  " }))), "equipo: está vacío.");
        assert_eq!(mal(con(json!({ "equipo": 3 }))), "equipo: tiene que ser texto.");
        assert_eq!(mal(con(json!({ "equipo": "x".repeat(61) }))), "equipo: es demasiado largo (máximo 60).");
        assert_eq!(mal(con(json!({ "equipo": "a\u{0}b" }))), "equipo: tiene caracteres de control.");
        assert!(leer_team_config(&format!("\u{feff}{}", con(json!({})))).is_ok());
        assert_eq!(ok(con(json!({ "_nota": "x", "plantillas": [{ "name": "A", "_c": 1 }] }))).plantillas.len(), 1);
    }

    #[test]
    fn claves_del_prototipo_y_archivo_grande() {
        assert_eq!(leer_team_config(r#"{"formato":"sloth-team","__proto__":{}}"#).unwrap_err(), "Clave no permitida: «__proto__».");
        assert_eq!(leer_team_config(r#"{"plantillas":[{"constructor":1}]}"#).unwrap_err(), "Clave no permitida: «constructor».");
        assert_eq!(leer_team_config(&format!(r#"{{"equipo":"{}"}}"#, "x".repeat(MAX_TEAM_BYTES))).unwrap_err(), "El archivo pesa más de 256 KB.");
    }

    #[test]
    fn plantillas_validas_e_invalidas() {
        let c = ok(con_plantilla(json!({ "repoPath": "apps/web", "namePattern": "{ticket} {plantilla}", "useWorktree": { "branchPattern": "rev/{ticketmin}-{n}" }, "autoStartClaude": false, "resume": false })));
        let t = &c.plantillas[0];
        assert_eq!((t.repo_path.as_str(), t.cuenta.as_str(), t.auto_start_claude, t.resume), ("apps/web", "sugerida", false, false));
        assert_eq!(t.use_worktree.as_ref().map(|w| w.branch_pattern.as_str()), Some("rev/{ticketmin}-{n}"));
        let d = &ok(con_plantilla(json!({}))).plantillas[0];
        assert_eq!((d.repo_path.as_str(), d.auto_start_claude, d.resume), (".", true, true));
        for ruta in ["/etc", "C:\\x", "../x", "a/../b", "~/x", "a/b c$"] {
            assert!(mal(con_plantilla(json!({ "repoPath": ruta }))).contains("repoPath tiene que ser relativo al repo"), "{ruta}");
        }
        assert_eq!(mal(con_plantilla(json!({ "cuenta": "mia" }))), "Plantilla «Revisión»: cuenta tiene que ser «sugerida» (el archivo es para todo el equipo).");
        assert_eq!(mal(con_plantilla(json!({ "namePattern": "{x}" }))), "Plantilla «Revisión»: namePattern: variable desconocida {x}. Usá {ticket}, {ticketmin}, {carpeta}, {rama}, {fecha}, {n}, {plantilla}.");
        assert!(mal(con_plantilla(json!({ "useWorktree": { "branchPattern": "{carpeta}" } }))).contains("Usá {ticket}, {ticketmin}, {fecha}, {n}, {plantilla}."));
        assert_eq!(mal(con_plantilla(json!({ "useWorktree": { "branchPattern": "con espacio" } }))), "Plantilla «Revisión»: la rama «con espacio» no es un nombre válido para git.");
        assert!(mal(con_plantilla(json!({ "useWorktree": true }))).contains("useWorktree tiene que ser"));
        assert_eq!(mal(con_plantilla(json!({ "autoStartClaude": "si" }))), "Plantilla «Revisión»: autoStartClaude: tiene que ser true o false.");
        assert_eq!(mal(con(json!({ "plantillas": [3] }))), "plantillas[0]: tiene que ser un objeto.");
        assert_eq!(mal(con(json!({ "plantillas": [{}] }))), "plantillas[0].name: falta.");
        for v in [json!(false), json!(null)] {
            assert!(ok(con_plantilla(json!({ "useWorktree": v }))).plantillas[0].use_worktree.is_none());
        }
        assert_eq!(mal(con(json!({ "plantillas": [{ "name": "Rev" }, { "name": "rev" }] }))), "Hay dos plantillas «rev».");
        let muchas: Vec<Value> = (0..51).map(|i| json!({ "name": format!("p{i}") })).collect();
        assert_eq!(mal(con(json!({ "plantillas": muchas }))), "plantillas: como mucho 50.");
    }

    #[test]
    fn un_primer_mensaje_con_exclamacion_descarta_solo_esa_plantilla() {
        let c = ok(con(json!({ "plantillas": [{ "name": "Mala", "initialPrompt": "!rm" }, { "name": "Buena" }] })));
        assert_eq!(c.plantillas.len(), 1);
        assert_eq!(c.avisos.unwrap(), vec!["Plantilla «Mala»: El primer mensaje no puede empezar con «!»: Claude Code lo correría como un comando de la terminal. Se ignora esa plantilla."]);
    }

    #[test]
    fn ajustes_y_links() {
        assert_eq!(ok(con(json!({ "ajustes": { "densidad": "cómoda", "tamañoTerminal": 14 } }))).ajustes, Some(TeamSettings { densidad: Some("cómoda".into()), tamano_terminal: Some(14) }));
        assert!(ok(con(json!({ "ajustes": {} }))).ajustes.is_none());
        assert_eq!(mal(con(json!({ "ajustes": { "densidad": "enorme" } }))), "ajustes.densidad: tiene que ser «compacta», «cómoda».");
        for n in [json!(10), json!(19), json!(12.5), json!("12")] {
            assert_eq!(mal(con(json!({ "ajustes": { "tamañoTerminal": n } }))), "ajustes.tamañoTerminal: tiene que ser un número entero entre 11 y 18.");
        }
        assert_eq!(mal(con(json!({ "ajustes": [] }))), "ajustes: tiene que ser un objeto.");
        let c = ok(con(json!({ "links": [{ "nombre": "Docs", "url": "https://Ejemplo.com" }] })));
        assert_eq!(c.links, vec![TeamLink { nombre: "Docs".into(), url: "https://ejemplo.com/".into() }]);
        for url in ["http://x.com", "https://u:p@x.com", "javascript:alert(1)", "no es url", ""] {
            assert_eq!(mal(con(json!({ "links": [{ "nombre": "L", "url": url }] }))), "Link «L»: la url tiene que empezar con https://.", "{url}");
        }
        assert_eq!(mal(con(json!({ "links": {} }))), "links: tiene que ser una lista.");
        let muchos: Vec<Value> = (0..13).map(|i| json!({ "nombre": format!("n{i}"), "url": "https://x.com" })).collect();
        assert_eq!(mal(con(json!({ "links": muchos }))), "links: como mucho 12.");
    }

    #[test]
    fn el_chat_rechaza_la_key_de_servicio_sin_invalidar_el_resto() {
        let bueno = ok(con(json!({ "chat": { "supabaseUrl": "https://abc.supabase.co/", "anonKey": jwt("anon"), "_n": 1 } })));
        assert_eq!(bueno.chat.unwrap().supabase_url, "https://abc.supabase.co");
        let c = ok(con(json!({ "chat": { "supabaseUrl": "https://abc.supabase.co", "anonKey": jwt("service_role") } })));
        assert!(c.chat.is_none());
        let aviso = &c.avisos.unwrap()[0];
        assert!(aviso.starts_with("chat: Esa es una service_role / secret key.") && aviso.ends_with("Se ignora el chat del equipo.") && !aviso.contains("firma"));
        assert!(ok(con(json!({ "chat": { "supabaseUrl": "https://abc.supabase.co", "anonKey": "sb_publishable_abcdefgh12" } }))).chat.is_some());
        let url = |v: Value| normalizar_url_supabase(Some(&v));
        assert_eq!(url(json!("http://abc.supabase.co")).unwrap_err(), "La URL de Supabase tiene que empezar con https://.");
        assert_eq!(url(json!("https://abc.supabase.co/rest")).unwrap_err(), "La URL de Supabase no puede tener ruta: va solo la URL del proyecto.");
        assert_eq!(url(json!("https://abc.supabase.co/?a=1")).unwrap_err(), "La URL de Supabase no puede tener ? ni # al final.");
        assert_eq!(url(json!("https://u:p@abc.supabase.co")).unwrap_err(), "La URL de Supabase no puede llevar usuario ni contraseña.");
        let key = |v: Value| revisar_anon_key(Some(&v));
        assert_eq!(key(json!("sb_secret_abc")).unwrap_err(), SECRET_MSG);
        assert_eq!(key(json!("sb_publishable_corta")).unwrap_err(), "La publishable key no tiene un formato válido.");
        assert_eq!(key(json!(jwt("authenticated"))).unwrap_err(), "Esa key no es una anon key (el rol del JWT no es «anon»).");
        assert_eq!(key(json!(" ")).unwrap_err(), "Falta la anon key.");
        assert_eq!(leer_config_del_chat(&json!({ "otra": 1 })).unwrap_err(), "En el chat no conozco la clave «otra».");
    }

    #[test]
    fn los_hashes_no_dependen_del_orden_de_claves() {
        let a = ok(con(json!({ "plantillas": [{ "name": "A", "repoPath": "x", "resume": false }] })));
        let b = ok(con(json!({ "plantillas": [{ "resume": false, "repoPath": "x", "name": "A" }] })));
        let c = ok(con(json!({ "plantillas": [{ "name": "A", "repoPath": "x", "resume": true }] })));
        assert_eq!(hash_de_plantillas(&a), hash_de_plantillas(&b));
        assert_ne!(hash_de_plantillas(&a), hash_de_plantillas(&c));
        assert_eq!(hash_de_plantillas(&ok(con(json!({})))), hex::encode(Sha256::digest(b"[]"))[..16].to_string());
        assert!(hash_de_ajustes(&a).is_none());
    }

    #[test]
    fn rutas_relativas_y_resolver() {
        for (e, esperado) in [(".", Some(".")), ("", None), ("apps//web/", Some("apps/web")), ("apps\\web", Some("apps/web")), ("..", None), ("/a", None), ("c:x", None), ("~", None), ("ñ", None)] {
            assert_eq!(ruta_relativa_segura(e).as_deref(), esperado, "{e:?}");
        }
        assert_eq!(resolver_repo_del_equipo(&raiz(), "apps/web").unwrap(), sub("apps/web"));
        assert_eq!(resolver_repo_del_equipo(&raiz(), ".").unwrap(), raiz());
        assert_eq!(resolver_repo_del_equipo(&raiz(), "../otro"), None);
        assert_eq!(relativo(&raiz(), &raiz()), "");
        if cfg!(windows) {
            assert_eq!(clave_de_repo("C:/Proyectos/App/"), "c:\\proyectos\\app");
        }
    }

    fn plan(cfg: &TeamConfig, locales: &[PlantillaLocal], mapeo: &Mapeo) -> PlanDeImportacion {
        planificar_importacion(cfg, &raiz(), locales, mapeo, &|p| !p.ends_with("fantasma"))
    }

    #[test]
    fn el_plan_de_importacion() {
        let c = ok(con(json!({ "plantillas": [{ "name": "A" }, { "name": "B", "repoPath": "fantasma" }] })));
        let p = plan(&c, &[], &Mapeo::nuevo());
        assert_eq!((p.items[0].action, p.items[0].saved_name.as_str()), (AccionPlan::New, "A"));
        assert_eq!(p.items[0].payload.as_ref().unwrap().keys().map(String::as_str).collect::<Vec<_>>(), ["name", "repoPath", "accountId", "autoStartClaude", "resume"]);
        assert_eq!(p.items[1].error.as_deref(), Some("La carpeta «fantasma» no existe en este repo."));
        let c = ok(con(json!({ "plantillas": [{ "name": "A", "namePattern": "{ticket}" }] })));
        let viejo = local("id1", "A (equipo)", &raiz(), "sugerida");
        let p = plan(&c, &[viejo.clone()], &Mapeo::desde(&[("a", "id1")]));
        assert_eq!((p.items[0].action, p.items[0].saved_name.as_str()), (AccionPlan::Update, "A (equipo)"));
        assert_eq!(p.items[0].payload.as_ref().unwrap().keys().last().map(String::as_str), Some("id"));
        let igual = PlantillaLocal { name_pattern: Some("{ticket}".into()), ..viejo };
        assert_eq!(plan(&c, &[igual], &Mapeo::desde(&[("a", "id1")])).items[0].action, AccionPlan::Same);
    }

    #[test]
    fn adoptar_renombrar_y_huerfanas() {
        let c = ok(con(json!({ "plantillas": [{ "name": "A" }, { "name": "B" }] })));
        let p = plan(&c, &[local("i1", "A", &raiz(), "sugerida"), local("i2", "B", &sub("otra"), "x")], &Mapeo::nuevo());
        assert_eq!((p.items[0].action, p.items[0].id.as_deref()), (AccionPlan::Same, Some("i1")));
        assert_eq!((p.items[1].action, p.items[1].saved_name.as_str()), (AccionPlan::Renamed, "B (equipo)"));
        let c = ok(con(json!({ "plantillas": [{ "name": "B" }] })));
        let locales = [local("i2", "B", &sub("otra"), "x"), local("i3", "B (equipo)", &sub("otra"), "x"), local("i4", "b (equipo 2)", &sub("otra"), "x")];
        assert_eq!(plan(&c, &locales, &Mapeo::nuevo()).items[0].saved_name, "B (equipo 3)");
        let c = ok(con(json!({ "plantillas": [{ "name": "A" }] })));
        let p = plan(&c, &[local("i1", "A", &raiz(), "sugerida")], &Mapeo::desde(&[("otra", "i1")]));
        assert_eq!(p.items[0].action, AccionPlan::Renamed);
        assert_eq!(p.orphans, vec!["A"]);
    }

    #[test]
    fn dato_personal_detecta_rutas_y_correos() {
        for (s, e) in [("abrí C:\\Users\\yo\\x", Some("una ruta absoluta")), ("mirá /Users/yo/x", Some("una ruta absoluta")), ("a ana@ej.com", Some("un correo")), ("api/Users/x", None), ("{ticket}", None)] {
            assert_eq!(dato_personal(Some(s)), e, "{s:?}");
        }
    }

    #[test]
    fn exportar_arma_un_archivo_importable_y_saltea_lo_personal() {
        let mut a = local("1", "Revisión", &sub("apps/web"), "privada");
        a.name_pattern = Some("{ticket}".into());
        let mut ruta = local("2", "Con ruta", &raiz(), "x");
        ruta.initial_prompt = Some("abrí C:\\Users\\yo".into());
        let mut bang = local("3", "Con bang", &raiz(), "x");
        bang.initial_prompt = Some("!ls".into());
        let fuera = local("4", "Fuera", "C:\\otro\\repo", "x");
        let equipo = json!(" Mi equipo ");
        let e = armar_exportacion(&raiz(), &[a, ruta, bang, fuera], &EntradaDeExportacion { equipo: Some(&equipo), links: None, ajustes: None, include: None }).unwrap();
        assert_eq!(e.config.plantillas.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), vec!["Revisión"]);
        assert!(e.text.ends_with("}\n") && !e.text.contains("privada"));
        assert_eq!(leer_team_config(&e.text).unwrap(), e.config);
        assert_eq!(e.skipped[0], Salteada { name: "Con ruta".into(), reason: "tiene una ruta absoluta en el prompt o en el nombre".into() });
        assert!(e.skipped[1].reason.starts_with("El primer mensaje no puede empezar"));
        assert_eq!(armar_exportacion(&raiz(), &[], &EntradaDeExportacion { equipo: None, links: None, ajustes: None, include: None }).unwrap_err(), "El nombre del equipo: falta.");
        assert_eq!(armar_exportacion(&raiz(), &[], &EntradaDeExportacion { equipo: Some(&equipo), links: None, ajustes: None, include: Some(&json!("x")) }).unwrap_err(), "Selección inválida.");
        let hermano = local("5", "H", &format!("{}-2", raiz()), "x");
        assert!(armar_exportacion(&raiz(), &[hermano], &EntradaDeExportacion { equipo: Some(&equipo), links: None, ajustes: None, include: None }).unwrap().config.plantillas.is_empty());
    }

    fn carpeta(nombre: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sloth-teamcfg-rs-{}-{nombre}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join(TEAM_DIR)).unwrap();
        d
    }

    #[test]
    fn leer_el_archivo_del_repo() {
        let d = carpeta("leer");
        let repo = d.to_string_lossy().into_owned();
        assert_eq!(leer_team_config_del_repo(&repo), Lectura::Ninguna);
        let f = d.join(TEAM_DIR).join(TEAM_FILE);
        fs::write(&f, "{no").unwrap();
        assert_eq!(leer_team_config_del_repo(&repo), Lectura::Invalida("No es un JSON válido.".into()));
        fs::write(&f, con(json!({})).to_string()).unwrap();
        assert!(matches!(leer_team_config_del_repo(&repo), Lectura::Ok { .. }));
        fs::write(&f, vec![b'x'; MAX_TEAM_BYTES + 1]).unwrap();
        assert_eq!(leer_team_config_del_repo(&repo), Lectura::Invalida("El archivo pesa más de 256 KB.".into()));
        fs::remove_file(&f).unwrap();
        fs::create_dir(&f).unwrap();
        assert_eq!(leer_team_config_del_repo(&repo), Lectura::Invalida(".sloth/team.json no es un archivo.".into()));
        let _ = fs::remove_dir_all(&d);
    }

    fn lectura(extra: Value) -> Lectura {
        let config = ok(con(extra));
        Lectura::Ok { hash: hash_de_plantillas(&config), hash_ajustes: hash_de_ajustes(&config), config, size: 1, mtime_ms: 1.0 }
    }

    #[test]
    fn estado_de_equipo_avisos_y_descartes() {
        let l = lectura(json!({ "plantillas": [{ "name": "A" }, { "name": "B" }, { "name": "C", "repoPath": "fantasma" }], "ajustes": { "densidad": "compacta" } }));
        let hash = if let Lectura::Ok { hash, .. } = &l { hash.clone() } else { unreachable!() };
        let locales = [local("1", "A", &raiz(), "sugerida")];
        let ex = |p: &str| !p.ends_with("fantasma");
        let s = estado_de_equipo(&raiz(), &l, &locales, None, &ex).unwrap();
        assert_eq!((s.state, s.pending, s.imported, s.total, s.notify, s.settings_pending), ("ok", 1, 1, 3, true, true));
        let mut e = EntradaDeEquipo::nueva(&raiz(), 1);
        assert!(descartar_aviso(&mut e, &l));
        assert_eq!(e.hash_descartado(), Some(hash.as_str()));
        assert!(!estado_de_equipo(&raiz(), &l, &locales, Some(&e), &ex).unwrap().notify);
        assert!(ajustes_listos(&mut e, &l));
        assert!(!estado_de_equipo(&raiz(), &l, &locales, Some(&e), &ex).unwrap().settings_pending);
        assert!(!descartar_aviso(&mut e, &Lectura::Ninguna));
        let inv = estado_de_equipo(&raiz(), &Lectura::Invalida("roto".into()), &[], None, &ex).unwrap();
        assert_eq!((inv.state, inv.error.as_deref()), ("invalid", Some("roto")));
        assert!(estado_de_equipo(&raiz(), &Lectura::Ninguna, &[], None, &ex).is_none());
    }

    #[test]
    fn validacion_de_lo_que_llega_por_ipc() {
        let siempre = |_: &str| true;
        assert_eq!(repo_del_pedido(&json!(format!(" {} ", raiz())), &siempre).unwrap(), raiz());
        for malo in [json!(3), json!(""), json!("x".repeat(1001)), Value::Null] {
            assert_eq!(repo_del_pedido(&malo, &siempre).unwrap_err(), "Repo inválido.");
        }
        assert_eq!(repo_del_pedido(&json!("relativa/x"), &siempre).unwrap_err(), "Esa carpeta no existe.");
        assert_eq!(repo_del_pedido(&json!(raiz()), &|_| false).unwrap_err(), "Esa carpeta no existe.");
        let extras = extras_del_scan(&json!([raiz(), "rel", 3, sub("a"), sub("b"), sub("c"), sub("d"), sub("e")]));
        assert_eq!(extras.len(), 5);
        let r = repos_a_revisar(&[raiz(), sub("a")], &[format!("{}{}", raiz(), std::path::MAIN_SEPARATOR)], &[sub("a")], &siempre);
        assert_eq!(r, vec![raiz(), sub("a")]);
        let l = lectura(json!({ "links": [{ "nombre": "L", "url": "https://x.com" }] }));
        assert_eq!(link_del_pedido(&l, &json!(0)).unwrap(), "https://x.com/");
        for malo in [json!(1), json!(-1), json!(0.5), json!("0")] {
            assert_eq!(link_del_pedido(&l, &malo).unwrap_err(), "Link inválido.");
        }
    }

    #[test]
    fn marcar_importado_filtra_el_mapeo_y_el_hash_vigente_manda() {
        let l = lectura(json!({ "plantillas": [{ "name": "A" }] }));
        let hash = if let Lectura::Ok { hash, .. } = &l { hash.clone() } else { unreachable!() };
        let ids: HashSet<String> = ["id1".to_string()].into();
        let mut e = EntradaDeEquipo::nueva(&raiz(), 1);
        marcar_importado(&mut e, &raiz(), &json!(hash), &json!({ "a": "id1", "b": "id1", "a2": "idx" }), &l, &ids, 99).unwrap();
        assert_eq!(e.mapeo(), Mapeo::desde(&[("a", "id1")]));
        assert_eq!(e.hash_importado(), Some(hash.as_str()));
        let mut otra = EntradaDeEquipo::nueva(&raiz(), 1);
        marcar_importado(&mut otra, &raiz(), &json!("0123456789abcdef"), &json!({}), &l, &ids, 5).unwrap();
        assert_eq!(otra.hash_importado(), None);
        assert_eq!(marcar_importado(&mut e, &raiz(), &json!("zz"), &json!({}), &l, &ids, 1).unwrap_err(), "Datos inválidos.");
        assert_eq!(marcar_importado(&mut e, &raiz(), &json!(hash), &json!({}), &Lectura::Ninguna, &ids, 1).unwrap_err(), "El archivo del equipo cambió o ya no es válido; volvé a intentar.");
    }

    #[test]
    fn escribir_lo_exportado_y_registrar_el_mapeo() {
        let d = carpeta("exportar");
        let repo = d.to_string_lossy().into_owned();
        let mia = local("id9", "Mía", &repo, "x");
        let equipo = json!("E");
        let e = armar_exportacion(&repo, &[mia.clone()], &EntradaDeExportacion { equipo: Some(&equipo), links: None, ajustes: None, include: None }).unwrap();
        assert_eq!(confirmar_lo_visto(&e, &json!("otra")).unwrap_err(), "Tus plantillas cambiaron mientras mirabas la vista previa. Revisala de nuevo.");
        assert!(confirmar_lo_visto(&e, &json!(e.text)).is_ok());
        let destino = escribir_exportacion(&repo, &e.text).unwrap();
        assert_eq!(fs::read_to_string(&destino).unwrap(), e.text);
        let despues = leer_team_config_del_repo(&repo);
        let mut ent = EntradaDeEquipo::nueva(&repo, 1);
        registrar_exportacion(&mut ent, &e.config, &[mia], &despues, 7);
        assert_eq!(ent.mapeo(), Mapeo::desde(&[("mía", "id9")]));
        assert_eq!(ent.hash_importado(), Some(hash_de_plantillas(&e.config).as_str()));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn el_estado_por_repo_conserva_lo_que_no_conoce_y_respeta_la_version_futura() {
        let original = json!({ "version": 1, "futuro": [1], "teams": { "c:\\a": { "repoPath": "C:\\a", "nuevo": { "x": 1 }, "mapping": { "a": "id1", "b": 4 }, "updatedAt": 5 }, "roto": { "mapping": {} } } });
        let e = EstadoPorRepo::desde_json(&original).unwrap();
        assert_eq!(e.equipos.len(), 1);
        let v = e.a_json();
        assert_eq!(v["futuro"], json!([1]));
        assert_eq!(v["teams"]["c:\\a"]["mapping"], json!({ "a": "id1" }));
        assert_eq!(v["teams"]["c:\\a"].as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(), ["repoPath", "nuevo", "mapping", "updatedAt"]);
        let d = std::env::temp_dir().join(format!("sloth-teamcfg-store-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        let f = d.join("team-config.json");
        let avisos = Avisos::nuevo();
        let mut a = AlmacenPorRepo::cargar(f.clone(), &avisos);
        a.estado.entrada_mut(&raiz(), 10).poner("equipo", json!("E"));
        assert!(a.guardar().unwrap());
        assert_eq!(AlmacenPorRepo::cargar(f.clone(), &avisos).estado.entrada(&raiz()).unwrap().texto("equipo"), Some("E"));
        let futura = json!({ "version": 9, "teams": {} }).to_string();
        fs::write(&f, &futura).unwrap();
        let c = AlmacenPorRepo::cargar(f.clone(), &avisos);
        assert!(c.solo_lectura && !c.guardar().unwrap());
        assert_eq!(fs::read_to_string(&f).unwrap(), futura);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn variables_ramas_y_fecha() {
        let v = ValoresDeVariables { ticket: Some("PROJ-1"), fecha: Some("2026-11-16"), n: Some(2), plantilla: Some("P") };
        assert_eq!(aplicar_variables("{ticket}/{ticketmin}/{fecha}/{n}/{plantilla}/{carpeta}/{raro}", &v), "PROJ-1/proj-1/2026-11-16/2/P/{carpeta}/{raro}");
        assert_eq!(variables_en(Some("{a} y {b}{c} {}")), vec!["a", "b", "c", ""]);
        for b in ["a", "rev/x-1", "a.b_c"] {
            assert!(rama_valida(b), "{b}");
        }
        for b in ["", "-a", "/a", "a/", "a.", "a.lock", "a..b", "a//b", "a/.b", "@", "a b", "ñ"] {
            assert!(!rama_valida(b), "{b:?}");
        }
        assert!(Regex::new(r"^20[0-9]{2}-[0-9]{2}-[0-9]{2}$").unwrap().is_match(&hoy()));
    }
}
