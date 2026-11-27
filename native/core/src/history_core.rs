//! Lógica pura de «history»: buscar texto en los transcripts de Claude Code, resumir cada conversación,
//! exportarla a Markdown y validar rutas y preferencias. Equivale a src/main/features/history-core.ts.
//! Todo es síncrono: la cancelación es un `AtomicBool` y los resultados salen por el callback `on_items`.
//! Los largos y cortes de texto cuentan unidades UTF-16 como en JS; si un corte parte un par sustituto
//! queda U+FFFD (JS dejaría la mitad suelta).
use regex::{Regex, RegexBuilder};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

use crate::usage::parsear_iso_ms;

pub const BLOQUE: usize = 1024 * 1024;
/// Una línea más larga que esto (p. ej. imágenes en base64) se saltea.
const MAX_LINEA: usize = 8 * 1024 * 1024;
pub const MAX_RESULTADOS: usize = 200;
/// Para que una sola conversación no se coma todos los resultados.
pub const MAX_POR_SESION: usize = 25;
const ANTES: usize = 70;
const DESPUES: usize = 130;

pub const DIAS_RANGO_SESIONES: i64 = 30;
pub const MAX_ARCHIVOS_SESIONES: usize = 400;
const MAX_ARCHIVOS_POR_SESION: usize = 200;
const MAX_LINEAS_HERRAMIENTA: usize = 30;
const MAX_TEXTO: usize = 20_000;
const MAX_ITEMS_DETALLE: usize = 3000;
const MAX_CLAVES: usize = 5000;

#[derive(Debug, Clone, PartialEq)]
pub struct CuentaBusqueda {
    pub id: String,
    pub label: String,
    pub config_dir: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Rol {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemHistorial {
    pub account_id: String,
    pub account_label: String,
    pub session_id: String,
    pub cwd: String,
    pub ts: i64,
    pub role: Rol,
    pub before: String,
    #[serde(rename = "match")]
    pub coincidencia: String,
    pub after: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArchivoSesion {
    pub cuenta: CuentaBusqueda,
    pub session_id: String,
    pub file: PathBuf,
    pub mtime_ms: i64,
    pub size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct EstadisticasBusqueda {
    pub files: usize,
    pub bytes: u64,
    pub total: usize,
    pub truncated: bool,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Default)]
pub struct OpcionesBusqueda {
    pub account_id: Option<String>,
    pub max: Option<usize>,
}

pub fn es_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// `\s` de JS: los espacios de Unicode más BOM y los terminadores de línea.
fn es_espacio(c: char) -> bool {
    matches!(c, '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

const CLASE_ESPACIO: &str = r"[\t-\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]";

fn recortar(s: &str) -> &str {
    s.trim_matches(es_espacio)
}

/// Cada tanda de espacios pasa a uno solo.
fn colapsar(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut en_espacio = false;
    for c in s.chars() {
        if es_espacio(c) {
            if !en_espacio {
                out.push(' ');
            }
            en_espacio = true;
        } else {
            out.push(c);
            en_espacio = false;
        }
    }
    out
}

fn una_linea(s: &str) -> String {
    recortar(&colapsar(s)).to_string()
}

fn largo16(s: &str) -> usize {
    s.encode_utf16().count()
}

fn clip(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    let u: Vec<u16> = s.encode_utf16().collect();
    if u.len() <= n {
        return s.to_string();
    }
    let corte = String::from_utf16_lossy(&u[..n - 1]);
    format!("{}…", corte.trim_end_matches(es_espacio))
}

/// Minúsculas y sin marcas diacríticas (NFD).
pub fn plegar(s: &str) -> String {
    s.nfd().filter(|c| !is_combining_mark(*c)).collect::<String>().to_lowercase()
}

/// Letra base → todas sus variantes con acento (Latin-1 y Latin Extended-A).
fn variantes() -> &'static BTreeMap<char, String> {
    static V: OnceLock<BTreeMap<char, String>> = OnceLock::new();
    V.get_or_init(|| {
        let mut m: BTreeMap<char, Vec<char>> = BTreeMap::new();
        for cp in 0xc0u32..=0x17f {
            let Some(ch) = char::from_u32(cp) else { continue };
            let base = plegar(&ch.to_string());
            let mut it = base.chars();
            let (Some(b), None) = (it.next(), it.next()) else { continue };
            if !b.is_ascii_lowercase() {
                continue;
            }
            let e = m.entry(b).or_insert_with(|| vec![b]);
            let bajas: Vec<char> = ch.to_lowercase().collect();
            if bajas.len() == 1 && !e.contains(&bajas[0]) {
                e.push(bajas[0]);
            }
        }
        m.into_iter().map(|(k, v)| (k, v.into_iter().collect())).collect()
    })
}

fn escapar_clase(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if matches!(c, ']' | '[' | '\\' | '^' | '-' | '&' | '~') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Regex equivalente a «contiene `query` sin mayúsculas ni acentos», que se puede correr directo sobre
/// el texto crudo (o sobre el JSON: tolera `\n` escapados entre palabras y `\\` en rutas).
pub fn construir_matcher(query: &str, para_json: bool) -> Result<Regex, regex::Error> {
    let q = colapsar(recortar(&plegar(query)));
    let mut src = String::new();
    for ch in q.chars() {
        if ch == ' ' {
            if para_json {
                src.push_str(&format!(r"(?:{CLASE_ESPACIO}|\\[nrt])+"));
            } else {
                src.push_str(CLASE_ESPACIO);
                src.push('+');
            }
        } else if ch == '\\' && para_json {
            src.push_str(r"\\{1,2}");
        } else if ch == '"' && para_json {
            src.push_str(r#"\\?""#);
        } else {
            match variantes().get(&ch) {
                Some(v) => src.push_str(&format!("[{}]", escapar_clase(v))),
                None => src.push_str(&regex::escape(&ch.to_string())),
            }
            src.push_str(r"\p{M}*");
        }
    }
    RegexBuilder::new(&src).case_insensitive(true).unicode(true).size_limit(512 * 1024 * 1024).build()
}

/// Todas las conversaciones (projects/<carpeta>/<uuid>.jsonl) de las cuentas, más nuevas primero.
pub fn listar_sesiones(cuentas: &[CuentaBusqueda]) -> Vec<ArchivoSesion> {
    let mut out = Vec::new();
    for cuenta in cuentas {
        let raiz = raiz_proyectos(&cuenta.config_dir);
        for d in nombres_ordenados(&raiz) {
            for n in nombres_ordenados(&raiz.join(&d)) {
                let Some(id) = n.strip_suffix(".jsonl") else { continue };
                if !es_uuid(id) {
                    continue;
                }
                let file = raiz.join(&d).join(&n);
                let Ok(md) = fs::metadata(&file) else { continue };
                if !md.is_file() || md.len() == 0 {
                    continue;
                }
                let mtime_ms = md
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_millis() as i64);
                out.push(ArchivoSesion { cuenta: cuenta.clone(), session_id: id.to_string(), file, mtime_ms, size: md.len() });
            }
        }
    }
    out.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    out
}

fn nombres_ordenados(dir: &Path) -> Vec<String> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let mut v: Vec<String> = rd.filter_map(|e| e.ok()?.file_name().into_string().ok()).collect();
    v.sort();
    v
}

/// Transcripts modificados desde `desde_ms`, como mucho `MAX_ARCHIVOS_SESIONES`.
pub fn listar_sesiones_recientes(cuentas: &[CuentaBusqueda], desde_ms: i64) -> Vec<ArchivoSesion> {
    listar_sesiones(cuentas).into_iter().filter(|f| f.mtime_ms >= desde_ms).take(MAX_ARCHIVOS_SESIONES).collect()
}

fn verdadero(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// Texto visible del mensaje: content string o bloques type:'text' (sin tool_result ni thinking).
pub fn texto_mensaje(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(bloques)) => bloques
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

struct Recorte {
    before: String,
    coincidencia: String,
    after: String,
}

fn de_u16(u: &[u16]) -> String {
    String::from_utf16_lossy(u)
}

fn colapsar16(u: &[u16]) -> String {
    colapsar(&de_u16(u))
}

fn es_espacio16(u: u16) -> bool {
    char::from_u32(u32::from(u)).is_some_and(es_espacio)
}

/// `index` y `len` en unidades UTF-16 sobre `texto`.
fn recorte(texto: &[u16], index: usize, len: usize) -> Recorte {
    let mut before = &texto[index.saturating_sub(ANTES)..index];
    let fin = (index + len).min(texto.len());
    let mut after = &texto[fin..(index + len + DESPUES).min(texto.len())];
    let mut before_txt;
    let mut after_txt;
    if index > ANTES {
        // Saca la palabra cortada del principio: hasta el primer espacio inclusive.
        if let Some(p) = before.iter().position(|u| es_espacio16(*u)) {
            before = &before[p + 1..];
        }
        before_txt = format!("…{}", de_u16(before));
    } else {
        before_txt = de_u16(before);
    }
    if index + len + DESPUES < texto.len() {
        if let Some(p) = after.iter().rposition(|u| es_espacio16(*u)) {
            after = &after[..p];
        }
        after_txt = format!("{}…", de_u16(after));
    } else {
        after_txt = de_u16(after);
    }
    before_txt = colapsar(&before_txt).trim_start_matches(es_espacio).to_string();
    after_txt = colapsar(&after_txt).trim_end_matches(es_espacio).to_string();
    Recorte { before: before_txt, coincidencia: colapsar16(&texto[index..fin]), after: after_txt }
}

fn ultima_ocurrencia_cwd(texto: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r#""cwd":"((?:[^"\\]|\\.)*)""#).expect("regex fija"));
    let m = re.captures(texto)?;
    serde_json::from_str::<String>(&format!("\"{}\"", &m[1])).ok()
}

/// Recorre los archivos en orden y llama a `on_items` con los resultados de cada archivo apenas los
/// tiene. Lee de a bloques de 1 MiB cortando en '\n'; los bloques que no contienen la búsqueda ni se parsean.
pub fn buscar_sesiones(
    files: &[ArchivoSesion],
    query: &str,
    cancelado: &AtomicBool,
    on_items: &mut dyn FnMut(Vec<ItemHistorial>),
    opts: &OpcionesBusqueda,
) -> Result<EstadisticasBusqueda, regex::Error> {
    buscar_con_bloque(files, query, cancelado, on_items, opts, BLOQUE)
}

fn buscar_con_bloque(
    files: &[ArchivoSesion],
    query: &str,
    cancelado: &AtomicBool,
    on_items: &mut dyn FnMut(Vec<ItemHistorial>),
    opts: &OpcionesBusqueda,
    bloque: usize,
) -> Result<EstadisticasBusqueda, regex::Error> {
    let max = opts.max.unwrap_or(MAX_RESULTADOS);
    let re_bloque = construir_matcher(query, true)?;
    let re_texto = construir_matcher(query, false)?;
    let cancelado_ya = || cancelado.load(Ordering::Relaxed);
    let mut stats = EstadisticasBusqueda::default();

    for f in files {
        if opts.account_id.as_deref().is_some_and(|a| !a.is_empty() && f.cuenta.id != a) {
            continue;
        }
        if cancelado_ya() {
            break;
        }
        if stats.total >= max {
            stats.truncated = true;
            break;
        }
        stats.files += 1;
        let mut encontrados: Vec<ItemHistorial> = Vec::new();
        let mut por_sesion = 0usize;
        let mut cwd = String::new();
        if let Ok(mut fh) = File::open(&f.file) {
            let mut resto: Vec<u8> = Vec::new();
            let mut chunk = vec![0u8; bloque];
            loop {
                if cancelado_ya() {
                    break;
                }
                let mut leidos = 0;
                let mut error = false;
                while leidos < bloque {
                    match fh.read(&mut chunk[leidos..]) {
                        Ok(0) => break,
                        Ok(n) => leidos += n,
                        Err(_) => {
                            error = true;
                            break;
                        }
                    }
                }
                if error {
                    break;
                }
                let eof = leidos == 0;
                stats.bytes += leidos as u64;
                let mut buf = std::mem::take(&mut resto);
                buf.extend_from_slice(&chunk[..leidos]);
                let corte = if eof { Some(buf.len()) } else { buf.iter().rposition(|b| *b == b'\n') };
                let Some(corte) = corte else {
                    // Línea más larga que el bloque: se acumula (con tope).
                    resto = if buf.len() > MAX_LINEA { Vec::new() } else { buf };
                    continue;
                };
                let texto = String::from_utf8_lossy(&buf[..corte]).into_owned();
                if !eof {
                    resto = buf[corte + 1..].to_vec();
                }
                // El cwd viene en casi todas las líneas: tomamos el primero que aparezca aunque no haya coincidencia.
                if cwd.is_empty() {
                    if let Some(c) = ultima_ocurrencia_cwd(&texto) {
                        cwd = c;
                    }
                }
                if por_sesion < MAX_POR_SESION && re_bloque.is_match(&texto) {
                    for linea in texto.split('\n') {
                        if por_sesion >= MAX_POR_SESION || stats.total + encontrados.len() >= max {
                            break;
                        }
                        if linea.is_empty() || !re_bloque.is_match(linea) {
                            continue;
                        }
                        if !linea.contains("\"type\":\"user\"") && !linea.contains("\"type\":\"assistant\"") {
                            continue;
                        }
                        let Ok(j) = serde_json::from_str::<Value>(linea) else { continue };
                        let rol = match j.get("type").and_then(Value::as_str) {
                            Some("user") => Rol::User,
                            Some("assistant") => Rol::Assistant,
                            _ => continue,
                        };
                        if verdadero(j.get("isMeta")) || verdadero(j.get("isSidechain")) {
                            continue;
                        }
                        let cuerpo = texto_mensaje(j.get("message").and_then(|m| m.get("content")));
                        if cuerpo.is_empty() {
                            continue;
                        }
                        let Some(m) = re_texto.find(&cuerpo) else { continue };
                        let cwd_linea = j.get("cwd").and_then(Value::as_str);
                        if let Some(c) = cwd_linea.filter(|c| !c.is_empty()) {
                            cwd = c.to_string();
                        }
                        let ts = j.get("timestamp").and_then(Value::as_str).and_then(parsear_iso_ms).unwrap_or(f.mtime_ms);
                        let index = largo16(&cuerpo[..m.start()]);
                        let len = largo16(m.as_str());
                        let cuerpo16: Vec<u16> = cuerpo.encode_utf16().collect();
                        let r = recorte(&cuerpo16, index, len);
                        encontrados.push(ItemHistorial {
                            account_id: f.cuenta.id.clone(),
                            account_label: f.cuenta.label.clone(),
                            session_id: f.session_id.clone(),
                            cwd: cwd_linea.map_or_else(|| cwd.clone(), str::to_string),
                            ts,
                            role: rol,
                            before: r.before,
                            coincidencia: r.coincidencia,
                            after: r.after,
                        });
                        por_sesion += 1;
                    }
                }
                if eof {
                    break;
                }
            }
        }
        if !encontrados.is_empty() {
            for it in encontrados.iter_mut().filter(|it| it.cwd.is_empty()) {
                it.cwd = cwd.clone();
            }
            stats.total += encontrados.len();
            if !cancelado_ya() {
                on_items(encontrados);
            }
        }
        if stats.total >= max {
            stats.truncated = true;
        }
    }
    stats.cancelled = cancelado_ya();
    Ok(stats)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ArchivoTocado {
    pub path: String,
    pub add: usize,
    pub del: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TipoHerramienta {
    Read,
    Edit,
    Run,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "k", rename_all = "lowercase")]
pub enum ItemDetalle {
    Msg { role: Rol, text: String },
    Tool { kind: TipoHerramienta, title: String, cmd: String, meta: String, err: bool, lines: Vec<String> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Estado {
    Ok,
    Int,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SesionParseada {
    pub title: String,
    pub cwd: String,
    pub branch: String,
    pub start: i64,
    pub end: i64,
    pub messages: usize,
    pub tools: usize,
    pub files: Vec<ArchivoTocado>,
    /// ok: la última respuesta es de Claude. int: quedó sin contestar (se cortó, pidió algo, etc.).
    pub status: Estado,
    pub last_answer: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DetalleParseado {
    pub sesion: SesionParseada,
    pub items: Vec<ItemDetalle>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilaSesion {
    pub key: String,
    pub account_id: String,
    pub account_label: String,
    pub session_id: String,
    pub cwd: String,
    pub space_id: Option<String>,
    pub space_key: String,
    pub space_name: String,
    pub branch: String,
    pub title: String,
    pub start: i64,
    pub end: i64,
    pub messages: usize,
    pub tools: usize,
    pub files: Vec<ArchivoTocado>,
    pub status: Estado,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InfoSesion {
    #[serde(flatten)]
    pub fila: FilaSesion,
    pub last_answer: String,
    pub items: Vec<ItemDetalle>,
}

fn contar_lineas(v: Option<&Value>) -> usize {
    match v {
        Some(Value::String(s)) if !s.is_empty() => s.split('\n').count(),
        _ => 0,
    }
}

fn nombre_base(p: &str) -> String {
    p.split(['\\', '/']).rfind(|s| !s.is_empty()).unwrap_or(p).to_string()
}

pub fn tipo_herramienta(nombre: &str) -> TipoHerramienta {
    match nombre {
        "Read" | "Grep" | "Glob" | "LS" => TipoHerramienta::Read,
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => TipoHerramienta::Edit,
        "Bash" | "BashOutput" => TipoHerramienta::Run,
        _ => TipoHerramienta::Other,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Descrita {
    pub kind: TipoHerramienta,
    pub title: String,
    pub cmd: String,
    pub meta: String,
    pub lines: Vec<String>,
    pub file: String,
    pub add: usize,
    pub del: usize,
}

/// Título y datos visibles de un uso de herramienta. Solo lee lo que la herramienta declara en su entrada.
pub fn describir_herramienta(nombre: &str, inp: &Map<String, Value>) -> Descrita {
    let s = |k: &str| inp.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let mut d = Descrita {
        kind: tipo_herramienta(nombre),
        title: nombre.to_string(),
        cmd: String::new(),
        meta: String::new(),
        lines: Vec::new(),
        file: String::new(),
        add: 0,
        del: 0,
    };
    match nombre {
        "Read" => {
            d.file = s("file_path");
            let base = nombre_base(&d.file);
            d.title = format!("Leyó {}", if base.is_empty() { "un archivo" } else { &base });
            d.lines = if d.file.is_empty() { Vec::new() } else { vec![d.file.clone()] };
            d.meta = "solo lectura".into();
        }
        "Grep" | "Glob" => {
            let pat = clip(&una_linea(&s("pattern")), 60);
            d.title = if nombre == "Grep" { format!("Buscó «{pat}»") } else { format!("Buscó archivos «{pat}»") };
            d.meta = "solo lectura".into();
        }
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => {
            d.file = if s("file_path").is_empty() { s("notebook_path") } else { s("file_path") };
            match nombre {
                "Edit" => {
                    d.add = contar_lineas(inp.get("new_string"));
                    d.del = contar_lineas(inp.get("old_string"));
                }
                "Write" => d.add = contar_lineas(inp.get("content")),
                "NotebookEdit" => d.add = contar_lineas(inp.get("new_source")),
                _ => {
                    if let Some(Value::Array(eds)) = inp.get("edits") {
                        for e in eds {
                            d.add += contar_lineas(e.get("new_string"));
                            d.del += contar_lineas(e.get("old_string"));
                        }
                    }
                }
            }
            let base = nombre_base(&d.file);
            d.title = format!(
                "{} {}",
                if nombre == "Write" { "Creó" } else { "Editó" },
                if base.is_empty() { "un archivo" } else { &base }
            );
            d.meta = format!("+{} −{}", d.add, d.del);
            d.lines = if d.file.is_empty() { Vec::new() } else { vec![d.file.clone()] };
        }
        "Bash" => {
            let cmd = s("command");
            d.cmd = clip(recortar(&cmd), 400);
            let desc = s("description");
            d.title = format!("Ejecutó {}", clip(&una_linea(if desc.is_empty() { &cmd } else { &desc }), 80));
        }
        _ => {}
    }
    d
}

/// Texto de un tool_result (string o bloques de texto).
fn texto_resultado(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(bs)) => bs
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn id_como_texto(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

#[derive(PartialEq, Clone, Copy)]
enum Ultimo {
    Respuesta,
    Otro,
}

struct Acumulador {
    con_items: bool,
    out: DetalleParseado,
    tocados: Vec<ArchivoTocado>,
    indice_tocados: HashMap<String, usize>,
    pendientes: HashMap<String, usize>,
    titulo_resumen: String,
    primer_usuario: String,
    ultimo: Ultimo,
}

impl Acumulador {
    fn nuevo(con_items: bool) -> Self {
        Acumulador {
            con_items,
            out: DetalleParseado {
                sesion: SesionParseada {
                    title: String::new(),
                    cwd: String::new(),
                    branch: String::new(),
                    start: 0,
                    end: 0,
                    messages: 0,
                    tools: 0,
                    files: Vec::new(),
                    status: Estado::Int,
                    last_answer: String::new(),
                },
                items: Vec::new(),
            },
            tocados: Vec::new(),
            indice_tocados: HashMap::new(),
            pendientes: HashMap::new(),
            titulo_resumen: String::new(),
            primer_usuario: String::new(),
            ultimo: Ultimo::Otro,
        }
    }

    fn hay_lugar(&self) -> bool {
        self.con_items && self.out.items.len() < MAX_ITEMS_DETALLE
    }

    fn linea(&mut self, linea: &str, max_linea: usize) {
        if linea.is_empty() || (linea.len() > max_linea && largo16(linea) > max_linea) {
            return;
        }
        if !linea.contains("\"type\":\"user\"") && !linea.contains("\"type\":\"assistant\"") && !linea.contains("\"type\":\"summary\"") {
            return;
        }
        let Ok(j) = serde_json::from_str::<Value>(linea) else { return };
        if !j.is_object() {
            return;
        }
        let s = &mut self.out.sesion;
        if let Some(ts) = j.get("timestamp").and_then(Value::as_str).and_then(parsear_iso_ms) {
            if s.start == 0 || ts < s.start {
                s.start = ts;
            }
            if ts > s.end {
                s.end = ts;
            }
        }
        let tipo = j.get("type").and_then(Value::as_str).unwrap_or("");
        if tipo == "summary" {
            if self.titulo_resumen.is_empty() {
                if let Some(r) = j.get("summary").and_then(Value::as_str) {
                    self.titulo_resumen = una_linea(r);
                }
            }
            return;
        }
        if verdadero(j.get("isSidechain")) {
            return;
        }
        if s.cwd.is_empty() {
            if let Some(c) = j.get("cwd").and_then(Value::as_str) {
                s.cwd = c.to_string();
            }
        }
        if let Some(b) = j.get("gitBranch").and_then(Value::as_str).filter(|b| !b.is_empty()) {
            s.branch = b.to_string();
        }
        let content = j.get("message").and_then(|m| m.get("content"));

        if tipo == "user" {
            if verdadero(j.get("isMeta")) {
                return;
            }
            if let Some(Value::Array(bs)) = content {
                for b in bs {
                    if b.get("type").and_then(Value::as_str) != Some("tool_result") {
                        continue;
                    }
                    let id = id_como_texto(b.get("tool_use_id"));
                    let Some(idx) = self.pendientes.remove(&id) else { continue };
                    if let ItemDetalle::Tool { kind, meta, err, lines, .. } = &mut self.out.items[idx] {
                        *err = b.get("is_error") == Some(&Value::Bool(true));
                        *lines = texto_resultado(b.get("content"))
                            .split('\n')
                            .filter(|l| !l.is_empty())
                            .take(MAX_LINEAS_HERRAMIENTA)
                            .map(str::to_string)
                            .collect();
                        if *kind == TipoHerramienta::Run {
                            *meta = if *err { "con errores" } else { "salió bien" }.into();
                        }
                    }
                    self.ultimo = Ultimo::Otro;
                }
            }
            let crudo = match content {
                Some(Value::String(t)) => t.clone(),
                _ => texto_mensaje(content),
            };
            let texto = recortar(&crudo);
            if !texto.is_empty() {
                self.out.sesion.messages += 1;
                if self.primer_usuario.is_empty() && !texto.starts_with('<') {
                    self.primer_usuario = una_linea(texto);
                }
                if self.hay_lugar() {
                    self.out.items.push(ItemDetalle::Msg { role: Rol::User, text: clip(texto, MAX_TEXTO) });
                }
                self.ultimo = Ultimo::Otro;
            }
            return;
        }

        if tipo != "assistant" {
            return;
        }
        let bloques: Vec<Value> = match content {
            Some(Value::Array(bs)) => bs.clone(),
            Some(Value::String(t)) => vec![serde_json::json!({ "type": "text", "text": t })],
            _ => Vec::new(),
        };
        let mut textos: Vec<String> = Vec::new();
        let mut usos = 0;
        for b in &bloques {
            let bt = b.get("type").and_then(Value::as_str);
            if bt == Some("text") {
                if let Some(t) = b.get("text").and_then(Value::as_str) {
                    if !recortar(t).is_empty() {
                        textos.push(recortar(t).to_string());
                    }
                }
                continue;
            }
            if bt != Some("tool_use") {
                continue;
            }
            usos += 1;
            self.out.sesion.tools += 1;
            let vacio = Map::new();
            let inp = b.get("input").and_then(Value::as_object).unwrap_or(&vacio);
            let d = describir_herramienta(&id_como_texto(b.get("name")), inp);
            if !d.file.is_empty() {
                let i = *self.indice_tocados.entry(d.file.clone()).or_insert_with(|| {
                    self.tocados.push(ArchivoTocado { path: d.file.clone(), add: 0, del: 0 });
                    self.tocados.len() - 1
                });
                self.tocados[i].add += d.add;
                self.tocados[i].del += d.del;
            }
            if self.hay_lugar() {
                self.out.items.push(ItemDetalle::Tool {
                    kind: d.kind,
                    title: d.title,
                    cmd: d.cmd,
                    meta: d.meta,
                    err: false,
                    lines: d.lines,
                });
                if let Some(id) = b.get("id").and_then(Value::as_str) {
                    self.pendientes.insert(id.to_string(), self.out.items.len() - 1);
                }
            }
        }
        let texto = textos.join("\n");
        if !texto.is_empty() {
            self.out.sesion.messages += 1;
            self.out.sesion.last_answer = clip(&texto, 4000);
            if self.hay_lugar() {
                self.out.items.push(ItemDetalle::Msg { role: Rol::Assistant, text: clip(&texto, MAX_TEXTO) });
            }
        }
        if usos > 0 {
            self.ultimo = Ultimo::Otro;
        } else if !texto.is_empty() {
            self.ultimo = Ultimo::Respuesta;
        }
    }

    fn cerrar(mut self) -> DetalleParseado {
        let s = &mut self.out.sesion;
        let titulo = if !self.titulo_resumen.is_empty() {
            &self.titulo_resumen
        } else if !self.primer_usuario.is_empty() {
            &self.primer_usuario
        } else {
            "Sin título"
        };
        s.title = clip(titulo, 140);
        s.status = if self.ultimo == Ultimo::Respuesta { Estado::Ok } else { Estado::Int };
        s.last_answer = clip(&s.last_answer, 700);
        self.tocados.truncate(MAX_ARCHIVOS_POR_SESION);
        s.files = self.tocados;
        if s.end == 0 {
            s.end = s.start;
        }
        self.out
    }
}

/// Recorre un transcript (.jsonl) línea por línea y arma el resumen. Con `con_items`, también la
/// conversación y los bloques de herramientas (para el detalle). No carga el archivo entero en memoria.
pub fn parsear_transcript(file: &Path, con_items: bool, max_linea: usize) -> std::io::Result<DetalleParseado> {
    let mut lector = BufReader::new(File::open(file)?);
    let mut acc = Acumulador::nuevo(con_items);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        if lector.read_until(b'\n', &mut buf)? == 0 {
            break;
        }
        // readline de Node corta también en \r suelto.
        for tramo in String::from_utf8_lossy(&buf).split(['\n', '\r']) {
            acc.linea(tramo, max_linea);
        }
    }
    Ok(acc.cerrar())
}

/// Igual que `parsear_transcript`, sobre un texto en memoria.
pub fn parsear_texto(texto: &str, con_items: bool) -> DetalleParseado {
    let mut acc = Acumulador::nuevo(con_items);
    for tramo in texto.split(['\n', '\r']) {
        acc.linea(tramo, MAX_LINEA);
    }
    acc.cerrar()
}

pub const MAX_LINEA_TRANSCRIPT: usize = MAX_LINEA;

pub fn duracion_min(start: i64, end: i64) -> i64 {
    (((end - start) as f64 / 60_000.0 + 0.5).floor() as i64).max(1)
}

/// Fecha corta como la de `fmtWhen` del original en es-AR (`27/11/2026, 14:05`), con un desfase fijo en
/// minutos respecto de UTC. El original usa la zona de la máquina y el locale del sistema; quien llame
/// pasa su propio formateador a `sesion_markdown` si necesita eso.
pub fn fecha_es_ar(ms: i64, desfase_min: i32) -> String {
    let t = ms + i64::from(desfase_min) * 60_000;
    let dias = t.div_euclid(86_400_000);
    let resto = t.rem_euclid(86_400_000) / 60_000;
    let z = dias + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let dia = doy - (153 * mp + 2) / 5 + 1;
    let mes = if mp < 10 { mp + 3 } else { mp - 9 };
    let anio = yoe + era * 400 + i64::from(mes <= 2);
    format!("{dia:02}/{mes:02}/{anio}, {:02}:{:02}", resto / 60, resto % 60)
}

/// Markdown de una conversación para «Exportar como Markdown». `fmt_when` da el texto del inicio.
pub fn sesion_markdown(s: &InfoSesion, nombre_espacio: &str, fmt_when: &dyn Fn(i64) -> String) -> String {
    let f = &s.fila;
    let mut l: Vec<String> = Vec::new();
    let mins = duracion_min(f.start, f.end);
    let dur = if mins >= 60 { format!("{} h {} min", mins / 60, mins % 60) } else { format!("{mins} min") };
    l.push(format!("# {}", f.title));
    l.push(String::new());
    l.push(format!("- **Espacio:** {nombre_espacio}"));
    l.push(format!("- **Cuenta:** {}", f.account_label));
    l.push(format!("- **Carpeta:** {}", f.cwd));
    if !f.branch.is_empty() {
        l.push(format!("- **Rama:** {}", f.branch));
    }
    l.push(format!("- **Inicio:** {} · **Duración:** {dur} · **Mensajes:** {}", fmt_when(f.start), f.messages));
    l.push(format!("- **Estado:** {}", if f.status == Estado::Ok { "Terminada" } else { "Interrumpida" }));
    l.push(format!("- **Id de la conversación:** {}", f.session_id));
    l.push(String::new());
    if !s.last_answer.is_empty() {
        l.extend(["## Última respuesta de Claude".to_string(), String::new(), s.last_answer.clone(), String::new()]);
    }
    l.extend(["## Conversación".to_string(), String::new()]);
    for it in &s.items {
        match it {
            ItemDetalle::Msg { role, text } => {
                l.push(if *role == Rol::User { "**Vos:**" } else { "**Claude:**" }.to_string());
                l.push(String::new());
                l.push(text.clone());
                l.push(String::new());
            }
            ItemDetalle::Tool { kind, title, cmd, meta, lines, .. } => {
                l.push(format!("> {title}{}", if meta.is_empty() { String::new() } else { format!(" · {meta}") }));
                if !cmd.is_empty() {
                    l.extend([String::new(), "```bash".to_string(), format!("$ {cmd}"), "```".to_string()]);
                }
                if *kind == TipoHerramienta::Run && !lines.is_empty() {
                    l.extend([String::new(), "```text".to_string()]);
                    l.extend(lines.iter().cloned());
                    l.push("```".to_string());
                }
                l.push(String::new());
            }
        }
    }
    if !f.files.is_empty() {
        l.extend(
            ["## Archivos tocados", "", "| Archivo | + | − |", "| --- | ---: | ---: |"].map(String::from),
        );
        for a in &f.files {
            l.push(format!("| {} | {} | {} |", a.path.replace('|', "\\|"), a.add, a.del));
        }
        l.push(String::new());
    }
    l.join("\n")
}

/// `<id de cuenta>:<uuid de la conversación>`.
pub fn es_clave_sesion(k: &str) -> bool {
    let Some((id, uuid)) = k.split_once(':') else { return false };
    (1..=64).contains(&id.len()) && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') && es_uuid(uuid)
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct PrefsHistorial {
    pub pinned: Vec<String>,
    pub hidden: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lista {
    Fijadas,
    Ocultas,
}

pub fn parsear_prefs(raw: &Value) -> PrefsHistorial {
    let elegir = |v: Option<&Value>| -> Vec<String> {
        let Some(Value::Array(a)) = v else { return Vec::new() };
        let mut vistos = HashSet::new();
        a.iter()
            .filter_map(Value::as_str)
            .filter(|k| es_clave_sesion(k) && vistos.insert(*k))
            .take(MAX_CLAVES)
            .map(str::to_string)
            .collect()
    };
    PrefsHistorial { pinned: elegir(raw.get("pinned")), hidden: elegir(raw.get("hidden")) }
}

/// Marca o desmarca una clave en una lista. Devuelve None si la clave no es válida.
pub fn fijar_pref(prefs: &PrefsHistorial, cual: Lista, key: &str, on: bool) -> Option<PrefsHistorial> {
    if !es_clave_sesion(key) {
        return None;
    }
    let mut next = prefs.clone();
    let lista = if cual == Lista::Fijadas { &mut next.pinned } else { &mut next.hidden };
    lista.retain(|k| k != key);
    if on {
        lista.push(key.to_string());
        if lista.len() > MAX_CLAVES {
            lista.drain(..lista.len() - MAX_CLAVES);
        }
    }
    Some(next)
}

/// Carpeta de proyectos de una cuenta de Claude (`<config_dir>/projects`).
pub fn raiz_proyectos(config_dir: &Path) -> PathBuf {
    config_dir.join("projects")
}

/// Como `path.resolve`, sin tocar el disco: absoluta y sin `.` ni `..`. Los primeros `raiz` componentes son prefijo y raíz.
fn resolver(p: &Path) -> (Vec<String>, usize) {
    let abs = if p.is_absolute() { p.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(p) };
    let mut out: Vec<String> = Vec::new();
    let mut raiz = 0;
    for c in abs.components() {
        match c {
            Component::Prefix(x) => {
                out.push(x.as_os_str().to_string_lossy().into_owned());
                raiz += 1;
            }
            Component::RootDir => {
                out.push("/".into());
                raiz += 1;
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if out.len() > raiz {
                    out.pop();
                }
            }
            Component::Normal(s) => out.push(s.to_string_lossy().into_owned()),
        }
    }
    (out, raiz)
}

fn igual_componente(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.to_lowercase() == b.to_lowercase()
    } else {
        a == b
    }
}

/// true si `target` queda dentro de `projects/` de la cuenta y no es la carpeta en sí: al menos
/// `<carpeta>/<algo>`. Así nunca se toca nada fuera de las conversaciones.
pub fn esta_dentro_de_projects(config_dir: &Path, target: &Path) -> bool {
    let (base, _) = resolver(&raiz_proyectos(config_dir));
    let (obj, _) = resolver(target);
    obj.len() >= base.len() + 2 && base.iter().zip(&obj).all(|(a, b)| igual_componente(a, b))
}

#[derive(Debug, Clone, PartialEq)]
pub struct RutasPapelera {
    pub file: PathBuf,
    pub dir: PathBuf,
}

/// Rutas que se mandan a la Papelera para borrar una conversación: su `<id>.jsonl` y la carpeta con el
/// mismo id (si Claude la guardó). None si el id o la carpeta no son válidos o queda algo fuera de projects/.
pub fn rutas_papelera(config_dir: &Path, slug: &str, session_id: &str) -> Option<RutasPapelera> {
    if !es_uuid(session_id) {
        return None;
    }
    if slug.is_empty() || slug == "." || slug == ".." || slug.contains(['\\', '/']) {
        return None;
    }
    let raiz = raiz_proyectos(config_dir);
    let file = raiz.join(slug).join(format!("{session_id}.jsonl"));
    let dir = raiz.join(slug).join(session_id);
    if !esta_dentro_de_projects(config_dir, &file) || !esta_dentro_de_projects(config_dir, &dir) {
        return None;
    }
    Some(RutasPapelera { file, dir })
}

#[cfg(test)]
mod tests;
