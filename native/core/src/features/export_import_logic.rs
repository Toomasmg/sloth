//! Lógica pura de exportar/importar la configuración (equivale a src/main/features/export-import-logic.ts).
//!
//! Formato 2 (`.sloth`, o `.json` sin cifrar): {formato, formatoVersion: 2, versión, exportado, ...grupos}. Con contraseña,
//! el archivo es {formato, formatoVersion, versión, exportado, cifrado, datos} (ver export_crypto.rs). Todos los campos
//! nuevos son opcionales: los archivos viejos se leen igual, y el formato 1 (sin `formatoVersion`) también.
//! El archivo NUNCA lleva configDir, ids internos, credenciales, tokens, sesiones ni transcripts.
//! Las cuentas, espacios y plantillas locales llegan como JSON tal cual (así los guarda el store).
use super::export_crypto::{decrypt_text, WRONG_PASSWORD};
use super::export_regla::{check_rule, es_herramienta_de_edicion, len16, trim_js, PermissionKind, RuleDraft};
use super::url_lite;
use crate::initial_prompt::problema_del_primer_mensaje;
use crate::proveedores::{capacidades_de, PROVEEDOR_DEFECTO};
use crate::settings_model::{combo_canonico, ACCENTS, ACCOUNT_PALETTE, DENSITIES, SHORTCUT_IDS, THEMES, UI_FONT};
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

pub const FORMAT: &str = "sloth-config";
pub const FORMAT_VERSION: u32 = 2;
pub const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_RULES: usize = 500;
const MAX_PLAN_LEN: usize = 20;
const MAX_URL_LENGTH: usize = 300;
pub const TEMPLATE_COLOR_KEYS: [&str; 5] = ["cielo", "hoja", "lila", "ambar", "coral"];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExportedAccount {
    pub label: String,
    #[serde(rename = "shareSetup")]
    pub share_setup: bool,
    /// Plan escrito a mano («Pro», «Max»…). Es una etiqueta: nunca sale de credenciales.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// Solo si no es claude: los archivos exportados con Claude quedan idénticos.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proveedor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExportedSpace {
    pub nombre: String,
    pub ruta: String,
    pub cuenta: String,
    /// Hex de la paleta de cuentas (el color de la cuenta asignada).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Color propio del espacio (TEMPLATE_COLOR_KEYS).
    #[serde(rename = "colorEspacio", skip_serializing_if = "Option::is_none")]
    pub color_espacio: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorktreeExportado {
    #[serde(rename = "branchPattern")]
    pub branch_pattern: String,
}

/// Plantilla sin ids locales: la cuenta va por nombre (sin `cuenta` = «sugerida»).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExportedTemplate {
    pub name: String,
    #[serde(rename = "repoPath")]
    pub repo_path: String,
    #[serde(rename = "autoStartClaude")]
    pub auto_start_claude: bool,
    pub resume: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cuenta: Option<String>,
    #[serde(rename = "namePattern", skip_serializing_if = "Option::is_none")]
    pub name_pattern: Option<String>,
    #[serde(rename = "initialPrompt", skip_serializing_if = "Option::is_none")]
    pub initial_prompt: Option<String>,
    #[serde(rename = "useWorktree", skip_serializing_if = "Option::is_none")]
    pub use_worktree: Option<WorktreeExportado>,
}

/// Una regla «Permitir siempre» de Sloth: tipo, herramienta y comando/dominio/«*» exacto.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExportedRule {
    pub kind: PermissionKind,
    pub tool: String,
    #[serde(rename = "match")]
    pub match_: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExportedPermissions {
    pub espacio: String,
    pub ruta: String,
    pub reglas: Vec<ExportedRule>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ExportedAppearance {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub density: Option<String>,
    #[serde(rename = "uiFontSize", skip_serializing_if = "Option::is_none")]
    pub ui_font_size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accent: Option<String>,
    #[serde(rename = "lightMode", skip_serializing_if = "Option::is_none")]
    pub light_mode: Option<bool>,
}

impl ExportedAppearance {
    pub fn vacia(&self) -> bool {
        *self == ExportedAppearance::default()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExportedTeam {
    #[serde(rename = "supabaseUrl")]
    pub supabase_url: String,
}

/// El orden de los campos es el de inserción del TS: así el JSON exportado sale igual.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExportDoc {
    pub formato: String,
    #[serde(rename = "formatoVersion")]
    pub formato_version: u32,
    #[serde(rename = "versión")]
    pub version: String,
    pub exportado: String,
    /// Solo el nombre del perfil de origen, para que quien recibe el archivo sepa de dónde viene.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub perfil: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cuentas: Option<Vec<ExportedAccount>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub espacios: Option<Vec<ExportedSpace>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permisos: Option<Vec<ExportedPermissions>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plantillas: Option<Vec<ExportedTemplate>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apariencia: Option<ExportedAppearance>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub atajos: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub equipo: Option<ExportedTeam>,
}

impl ExportDoc {
    pub fn nuevo(version: &str, exportado: &str) -> ExportDoc {
        ExportDoc {
            formato: FORMAT.into(),
            formato_version: FORMAT_VERSION,
            version: version.into(),
            exportado: exportado.into(),
            perfil: None,
            cuentas: None,
            espacios: None,
            permisos: None,
            plantillas: None,
            apariencia: None,
            atajos: None,
            equipo: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SectionId {
    Espacios,
    Plantillas,
    Apariencia,
    Atajos,
    Equipo,
    Permisos,
}
pub const SECTIONS: [SectionId; 6] = [SectionId::Espacios, SectionId::Plantillas, SectionId::Apariencia, SectionId::Atajos, SectionId::Equipo, SectionId::Permisos];

// ---------- Utilidades de JSON y de texto ----------

fn obj(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
}

fn texto<'a>(o: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    o.get(k).and_then(Value::as_str)
}

/// `s.slice(0, n)` de JavaScript: n unidades UTF-16, sin partir un par sustituto.
pub fn cortar16(s: &str, n: usize) -> &str {
    let mut unidades = 0;
    for (i, c) in s.char_indices() {
        unidades += c.len_utf16();
        if unidades > n {
            return &s[..i];
        }
    }
    s
}

fn es_entero(v: &Value) -> Option<i64> {
    let n = v.as_f64()?;
    (n.is_finite() && n.fract() == 0.0 && n.abs() < 9e15).then_some(n as i64)
}

fn sin_bom(t: &str) -> &str {
    t.strip_prefix('\u{feff}').unwrap_or(t)
}

fn proveedor_id_valido(s: &str) -> bool {
    (1..=32).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// El setup compartido es de Claude Code: lo que diga el archivo no lo activa en una cuenta de un agente que no lo tiene.
pub fn share_setup_al_importar(archivo: bool, cuenta: &Value) -> bool {
    archivo && capacidades_de(cuenta).is_none_or(|c| c.setup_compartido)
}

pub fn cuenta_exportada(a: &Value, plan: Option<&str>) -> ExportedAccount {
    let label = a.get("label").and_then(Value::as_str).unwrap_or_default().to_string();
    let proveedor = a.get("proveedor").and_then(Value::as_str).filter(|p| *p != PROVEEDOR_DEFECTO.como_texto() && proveedor_id_valido(p)).map(String::from);
    ExportedAccount { label, share_setup: a.get("shareSetup") != Some(&Value::Bool(false)), plan: plan.filter(|p| !p.is_empty()).map(String::from), proveedor }
}

// ---------- Exportar ----------

fn etiquetas(cuentas: &[Value]) -> HashMap<&str, &str> {
    cuentas.iter().filter_map(|a| Some((a.get("id")?.as_str()?, a.get("label")?.as_str()?))).collect()
}

/// Lista de plantillas, acepte el archivo un array o un objeto con `templates`/`plantillas`.
pub fn template_list(raw: &Value) -> Option<&Vec<Value>> {
    if let Some(a) = raw.as_array() {
        return Some(a);
    }
    let o = obj(raw)?;
    o.get("templates").and_then(Value::as_array).or_else(|| o.get("plantillas").and_then(Value::as_array))
}

/// Nombre de una plantilla local: `name`, o `nombre` o `title` si el primero no está. Solo cuenta si es texto no vacío.
pub fn template_name(t: &Value) -> Option<String> {
    let o = obj(t)?;
    let n = ["name", "nombre", "title"].iter().filter_map(|k| o.get(*k)).find(|v| !v.is_null())?;
    n.as_str().map(trim_js).filter(|s| !s.is_empty()).map(String::from)
}

/// Plantillas en formato del archivo, a partir de templates.json (ya validado por la función «templates»).
pub fn export_templates(raw: &Value, cuentas: &[Value]) -> Vec<ExportedTemplate> {
    let label_of = etiquetas(cuentas);
    template_list(raw)
        .into_iter()
        .flatten()
        .filter_map(|t| {
            let o = obj(t)?;
            let (name, repo_path) = (texto(o, "name")?, texto(o, "repoPath")?);
            let no_vacio = |k: &str| texto(o, k).filter(|s| !s.is_empty()).map(String::from);
            Some(ExportedTemplate {
                name: name.into(),
                repo_path: repo_path.into(),
                auto_start_claude: o.get("autoStartClaude") != Some(&Value::Bool(false)),
                resume: o.get("resume") != Some(&Value::Bool(false)),
                cuenta: texto(o, "accountId").and_then(|id| label_of.get(id)).filter(|l| !l.is_empty()).map(|l| l.to_string()),
                name_pattern: no_vacio("namePattern"),
                initial_prompt: no_vacio("initialPrompt"),
                use_worktree: o.get("useWorktree").and_then(obj).and_then(|w| texto(w, "branchPattern")).map(|b| WorktreeExportado { branch_pattern: b.into() }),
            })
        })
        .collect()
}

/// Espacios del archivo: ruta, nombre, colores y cuenta asignada (ni ids ni ramas ni prompts).
pub fn export_spaces(espacios: &[Value], cuentas: &[Value], color_of: &dyn Fn(&str) -> Option<String>) -> Vec<ExportedSpace> {
    let label_of = etiquetas(cuentas);
    espacios
        .iter()
        .filter_map(|w| {
            let account_id = w.get("accountId").and_then(Value::as_str)?;
            let cuenta = label_of.get(account_id).filter(|l| !l.is_empty())?;
            Some(ExportedSpace {
                nombre: w.get("name").and_then(Value::as_str).unwrap_or_default().into(),
                ruta: w.get("repoPath").and_then(Value::as_str).unwrap_or_default().into(),
                cuenta: cuenta.to_string(),
                color: color_of(account_id).filter(|c| !c.is_empty()),
                color_espacio: w.get("color").and_then(Value::as_str).filter(|c| TEMPLATE_COLOR_KEYS.contains(c)).map(String::from),
            })
        })
        .collect()
}

/// Reglas de Sloth (permissions.json) de cada espacio, ya validadas. Sin `on: false` ni reglas inválidas.
pub fn export_rules(reglas: &[Value], espacios: &[Value]) -> Vec<ExportedPermissions> {
    espacios
        .iter()
        .filter_map(|w| {
            let id = w.get("id");
            let ok: Vec<ExportedRule> = reglas
                .iter()
                .filter(|r| obj(r).is_some_and(|o| o.get("workspaceId") == id && id.is_some() && o.get("on") != Some(&Value::Bool(false))))
                .filter_map(|r| check_rule(r).ok())
                .map(|c| ExportedRule { kind: c.kind, tool: c.tool, match_: c.match_ })
                .collect();
            (!ok.is_empty()).then(|| ExportedPermissions {
                espacio: w.get("name").and_then(Value::as_str).unwrap_or_default().into(),
                ruta: w.get("repoPath").and_then(Value::as_str).unwrap_or_default().into(),
                reglas: ok,
            })
        })
        .collect()
}

/// Tamaño aproximado (KB) de cada grupo, medido con el JSON que se escribiría.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Tamanos {
    pub espacios: f64,
    pub plantillas: f64,
    pub apariencia: f64,
    pub atajos: f64,
    pub equipo: f64,
    pub permisos: f64,
}

impl Tamanos {
    pub fn total(&self) -> f64 {
        self.espacios + self.plantillas + self.apariencia + self.atajos + self.equipo + self.permisos
    }
}

pub fn section_sizes(doc: &ExportDoc) -> Tamanos {
    fn kb<T: Serialize>(v: &Option<T>) -> f64 {
        v.as_ref().map_or(0.0, |v| serde_json::to_string(v).map_or(0, |s| s.len()) as f64 / 1024.0)
    }
    // `{cuentas, espacios}` es un objeto aunque no tenga ninguno: pesa «{}» y no 0.
    let mut espacios = Map::new();
    if let Some(c) = &doc.cuentas {
        espacios.insert("cuentas".into(), serde_json::to_value(c).unwrap_or(Value::Null));
    }
    if let Some(e) = &doc.espacios {
        espacios.insert("espacios".into(), serde_json::to_value(e).unwrap_or(Value::Null));
    }
    Tamanos {
        espacios: serde_json::to_string(&espacios).map_or(0, |s| s.len()) as f64 / 1024.0,
        plantillas: kb(&doc.plantillas),
        apariencia: kb(&doc.apariencia),
        atajos: kb(&doc.atajos),
        equipo: kb(&doc.equipo),
        permisos: kb(&doc.permisos),
    }
}

pub fn fmt_kb(kb: f64) -> String {
    if kb <= 0.0 {
        "0 KB".into()
    } else if kb < 1.0 {
        "< 1 KB".into()
    } else {
        format!("≈ {} KB", kb.round() as i64)
    }
}

// ---------- Lectura ----------

fn str_campo(o: &Map<String, Value>, key: &str, donde: &str, max: usize, requerido: bool) -> Result<Option<String>, String> {
    let v = o.get(key);
    if matches!(v, None | Some(Value::Null)) || v == Some(&Value::String(String::new())) {
        return if requerido { Err(format!("{donde}: falta «{key}».")) } else { Ok(None) };
    }
    let Some(Value::String(s)) = v else { return Err(format!("{donde}: «{key}» tiene que ser texto.")) };
    let t = trim_js(s);
    if requerido && t.is_empty() {
        return Err(format!("{donde}: falta «{key}»."));
    }
    if len16(t) > max {
        return Err(format!("{donde}: «{key}» es demasiado largo."));
    }
    Ok((!t.is_empty()).then(|| t.to_string()))
}

fn req(o: &Map<String, Value>, key: &str, donde: &str, max: usize) -> Result<String, String> {
    Ok(str_campo(o, key, donde, max, true)?.unwrap_or_default())
}

fn bool_campo(o: &Map<String, Value>, key: &str, def: bool) -> bool {
    o.get(key).and_then(Value::as_bool).unwrap_or(def)
}

/// Plan de cuenta del archivo: texto corto y sin controles; si no es válido, se ignora.
fn plan_de(v: Option<&Value>) -> Option<String> {
    let t = trim_js(v?.as_str()?);
    (!t.is_empty() && len16(t) <= MAX_PLAN_LEN && !t.chars().any(|c| c <= '\u{1f}')).then(|| t.to_string())
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedSpace {
    pub nombre: String,
    pub ruta: String,
    pub cuenta: String,
    pub color: Option<String>,
    pub color_espacio: Option<String>,
    /// Formato 1 con worktree: la carpeta del worktree (sin ella no se puede importar).
    pub sin_carpeta: bool,
    pub auto_start_claude: bool,
    pub resume: bool,
    pub initial_prompt: Option<String>,
    pub ticket: Option<String>,
    /// Algo del archivo que se dejó afuera sin saltear el espacio (p. ej. un primer mensaje inválido).
    pub aviso: Option<String>,
}

/// Una regla del archivo, ya revisada. `texto` es lo que se muestra (comando, dominio…).
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedRule {
    pub texto: String,
    pub valida: bool,
    pub motivo: Option<String>,
    pub draft: Option<RuleDraft>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedPermiso {
    pub espacio: String,
    pub ruta: String,
    pub reglas: Vec<ParsedRule>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlantillaDescartada {
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedImport {
    pub version: String,
    pub formato_version: f64,
    pub cuentas: Vec<ExportedAccount>,
    pub espacios: Vec<ParsedSpace>,
    pub plantillas: Vec<ExportedTemplate>,
    /// Plantillas que no se importan por un primer mensaje inválido (el resto del archivo sigue).
    pub plantillas_descartadas: Vec<PlantillaDescartada>,
    pub apariencia: Option<ExportedAppearance>,
    /// Atajos cambiados: id → combinación canónica. Solo los ids y combinaciones válidos.
    pub atajos: Option<Vec<(String, String)>>,
    pub equipo: Option<String>,
    pub permisos: Vec<ParsedPermiso>,
}

/// Qué contiene el texto: JSON en claro o archivo cifrado (hay que pedir la contraseña).
#[derive(Debug, Clone, PartialEq)]
pub enum Envelope {
    Plano { text: String },
    Cifrado { cifrado: Value, datos: String, version: String },
}

fn leer_documento(text: &str) -> Result<Map<String, Value>, String> {
    let data: Value = serde_json::from_str(sin_bom(text)).map_err(|_| "El archivo no es un JSON válido.".to_string())?;
    match data {
        Value::Object(o) if o.get("formato").and_then(Value::as_str) == Some(FORMAT) => Ok(o),
        _ => Err("No es una configuración exportada de Sloth (falta formato «sloth-config»).".into()),
    }
}

/// Lee el sobre: si está cifrado, devuelve el bloque para descifrar; si no, el JSON tal cual.
pub fn read_envelope(text: &str) -> Result<Envelope, String> {
    let data = leer_documento(text)?;
    if data.get("cifrado").is_some_and(Value::is_object) {
        let Some(datos) = texto(&data, "datos") else { return Err("El archivo cifrado está dañado.".into()) };
        return Ok(Envelope::Cifrado { cifrado: data["cifrado"].clone(), datos: datos.into(), version: texto(&data, "versión").unwrap_or("?").into() });
    }
    Ok(Envelope::Plano { text: text.into() })
}

/// Descifra el sobre con la contraseña; devuelve el texto del JSON.
pub fn open_envelope(cifrado: &Value, datos: &str, password: &str) -> Result<String, String> {
    if password.is_empty() {
        return Err(WRONG_PASSWORD.into());
    }
    decrypt_text(cifrado, &Value::String(datos.into()), password)
}

/// Regla en el formato que usaba Sloth antes (texto de Claude: `Bash(npm test)`, `WebFetch(domain:x)`, `Edit`,
/// `mcp__s__t`). Solo se convierte lo que Sloth podría guardar igual: nada que amplíe el permiso.
fn de_regla_en_texto(text: &str) -> Result<Value, &'static str> {
    static R: OnceLock<Regex> = OnceLock::new();
    let re = R.get_or_init(|| Regex::new(r"(?s)^([A-Za-z_][A-Za-z0-9_.:-]*)(?:\((.*)\))?$").expect("regex fija"));
    let Some(m) = re.captures(trim_js(text)) else { return Err("formato no reconocido") };
    let nombre = &m[1];
    let arg = m.get(2).map(|a| a.as_str());
    if nombre == "Bash" {
        return match arg {
            None => Err("regla general de comandos: Sloth solo guarda comandos exactos"),
            Some(a) => Ok(json!({ "kind": "cmd", "tool": "Bash", "match": a })),
        };
    }
    if nombre == "WebFetch" {
        return match arg.and_then(|a| a.strip_prefix("domain:")) {
            Some(d) => Ok(json!({ "kind": "net", "tool": "WebFetch", "match": d })),
            None => Err("Sloth solo guarda dominios de WebFetch"),
        };
    }
    if es_herramienta_de_edicion(nombre) {
        return match arg {
            None => Ok(json!({ "kind": "edit", "tool": nombre, "match": "*" })),
            Some(_) => Err("limitada a rutas: Sloth no la importa"),
        };
    }
    if nombre.starts_with("mcp__") && arg.is_none() {
        return Ok(json!({ "kind": "other", "tool": nombre, "match": "*" }));
    }
    Err("Sloth no maneja esa herramienta")
}

/// Una regla del archivo: objeto de Sloth o texto de la versión anterior. Siempre pasa por `check_rule`.
fn parse_rule(item: &Value) -> ParsedRule {
    let mostrado = match item.as_str() {
        Some(s) => s.to_string(),
        None => serde_json::to_string(item).unwrap_or_default(),
    };
    let texto = cortar16(&mostrado, 200).to_string();
    let crudo = match item.as_str() {
        Some(s) => match de_regla_en_texto(s) {
            Ok(v) => v,
            Err(motivo) => return ParsedRule { texto, valida: false, motivo: Some(motivo.into()), draft: None },
        },
        None => item.clone(),
    };
    match check_rule(&crudo) {
        Ok(d) => ParsedRule { texto: d.label.clone(), valida: true, motivo: None, draft: Some(d) },
        Err(motivo) => ParsedRule { texto, valida: false, motivo: Some(motivo), draft: None },
    }
}

/// Mismo contrato que `normalizeSupabaseUrl` (chat-config.ts): solo la URL https del proyecto, devuelta como origen.
pub fn normalizar_url_supabase(raw: &str) -> Result<String, String> {
    let s = trim_js(raw);
    if s.is_empty() || len16(s) > MAX_URL_LENGTH {
        return Err("La URL de Supabase no es válida.".into());
    }
    let Some(u) = url_lite::parsear(s) else {
        let otro_esquema = s.split_once("://").is_some_and(|(e, r)| !r.is_empty() && !e.is_empty() && e.chars().all(|c| c.is_ascii_alphabetic()) && !e.eq_ignore_ascii_case("https"));
        return Err(if otro_esquema { "La URL de Supabase tiene que empezar con https://.".into() } else { "La URL de Supabase no es válida. Tiene que ser https://<ref>.supabase.co.".into() });
    };
    if u.scheme != "https" {
        return Err("La URL de Supabase tiene que empezar con https://.".into());
    }
    if !u.usuario.is_empty() || !u.clave.is_empty() {
        return Err("La URL de Supabase no puede llevar usuario ni contraseña.".into());
    }
    if !u.query.is_empty() || !u.hash.is_empty() {
        return Err("La URL de Supabase no puede tener ? ni # al final.".into());
    }
    if u.ruta != "/" && !u.ruta.is_empty() {
        return Err("La URL de Supabase no puede tener ruta: va solo la URL del proyecto.".into());
    }
    Ok(u.origen())
}

pub fn parse_import(text: &str) -> Result<ParsedImport, String> {
    let data = leer_documento(text)?;
    let formato_version = data.get("formatoVersion").and_then(Value::as_f64).unwrap_or(1.0);
    if formato_version > FORMAT_VERSION as f64 {
        return Err("Este archivo es de una versión más nueva de Sloth. Actualizá Sloth para importarlo.".into());
    }
    let version = texto(&data, "versión").unwrap_or("?").to_string();

    let vacio = Value::Array(vec![]);
    let nulo_a_vacio = |k: &str| data.get(k).filter(|v| !v.is_null()).unwrap_or(&vacio);
    let (Some(raw_acc), Some(raw_ws)) = (nulo_a_vacio("cuentas").as_array(), nulo_a_vacio("espacios").as_array()) else {
        return Err("«cuentas» y «espacios» tienen que ser listas.".into());
    };
    if raw_acc.len() > 100 {
        return Err("Demasiadas cuentas en el archivo.".into());
    }
    if raw_ws.len() > 500 {
        return Err("Demasiados espacios en el archivo.".into());
    }

    let mut cuentas: Vec<ExportedAccount> = Vec::new();
    let mut vistas: HashSet<String> = HashSet::new();
    for (i, a) in raw_acc.iter().enumerate() {
        let donde = format!("Cuenta {}", i + 1);
        let Some(a) = obj(a) else { return Err(format!("{donde}: formato inválido.")) };
        let label = req(a, "label", &donde, 80)?;
        if !vistas.insert(label.to_lowercase()) {
            continue;
        }
        let proveedor = texto(a, "proveedor").filter(|p| *p != PROVEEDOR_DEFECTO.como_texto() && proveedor_id_valido(p)).map(String::from);
        cuentas.push(ExportedAccount { label, share_setup: bool_campo(a, "shareSetup", true), plan: plan_de(a.get("plan")), proveedor });
    }

    let mut espacios: Vec<ParsedSpace> = Vec::new();
    for (i, w) in raw_ws.iter().enumerate() {
        let donde = format!("Espacio {}", i + 1);
        let Some(w) = obj(w) else { return Err(format!("{donde}: formato inválido.")) };
        // Formato 2: nombre/ruta. Formato 1: name/repoPath (y con branch, la carpeta del worktree).
        let nombre = match str_campo(w, "nombre", &donde, 120, false)? {
            Some(n) => n,
            None => req(w, "name", &donde, 120)?,
        };
        let cuenta = req(w, "cuenta", &donde, 80)?;
        let mut e = ParsedSpace {
            nombre,
            ruta: String::new(),
            cuenta,
            color: None,
            color_espacio: None,
            sin_carpeta: false,
            auto_start_claude: bool_campo(w, "autoStartClaude", true),
            resume: bool_campo(w, "resume", true),
            initial_prompt: None,
            ticket: None,
            aviso: None,
        };
        if formato_version >= 2.0 {
            e.ruta = req(w, "ruta", &donde, 1024)?;
        } else {
            let branch = str_campo(w, "branch", &donde, 250, false)?;
            let carpeta = str_campo(w, "carpeta", &donde, 1024, false)?;
            if branch.is_some() {
                match carpeta {
                    Some(c) => e.ruta = c,
                    None => e.sin_carpeta = true,
                }
            } else {
                e.ruta = req(w, "repoPath", &donde, 1024)?;
            }
            let initial_prompt = str_campo(w, "initialPrompt", &donde, 4000, false)?;
            let ticket = str_campo(w, "ticket", &donde, 40, false)?;
            match initial_prompt.as_deref().and_then(problema_del_primer_mensaje) {
                Some(p) => e.aviso = Some(format!("{p} Se importa sin ese primer mensaje.")),
                None => e.initial_prompt = initial_prompt,
            }
            e.ticket = ticket;
        }
        e.color = texto(w, "color").filter(|c| ACCOUNT_PALETTE.iter().any(|(hex, _)| hex == c)).map(String::from);
        e.color_espacio = texto(w, "colorEspacio").filter(|c| TEMPLATE_COLOR_KEYS.contains(c)).map(String::from);
        espacios.push(e);
    }

    let raw_tpl = nulo_a_vacio_de(&data, "plantillas", &vacio);
    let Some(raw_tpl) = raw_tpl.as_array() else { return Err("«plantillas» tiene que ser una lista.".into()) };
    if raw_tpl.len() > 200 {
        return Err("Demasiadas plantillas en el archivo.".into());
    }
    let mut plantillas_descartadas: Vec<PlantillaDescartada> = Vec::new();
    let mut plantillas: Vec<ExportedTemplate> = Vec::new();
    for (i, t) in raw_tpl.iter().enumerate() {
        let donde = format!("Plantilla {}", i + 1);
        let Some(t) = obj(t) else { return Err(format!("{donde}: formato inválido.")) };
        let name = req(t, "name", &donde, 80)?;
        let repo_path = req(t, "repoPath", &donde, 1000)?;
        let cuenta = str_campo(t, "cuenta", &donde, 80, false)?;
        let name_pattern = str_campo(t, "namePattern", &donde, 120, false)?;
        let initial_prompt = str_campo(t, "initialPrompt", &donde, 4000, false)?;
        let use_worktree = match t.get("useWorktree") {
            None | Some(Value::Null) => None,
            Some(Value::Object(w)) => Some(WorktreeExportado { branch_pattern: req(w, "branchPattern", &donde, 200)? }),
            Some(_) => return Err(format!("{donde}: «useWorktree» inválido.")),
        };
        let problema = initial_prompt.as_deref().and_then(problema_del_primer_mensaje);
        let e = ExportedTemplate {
            name,
            repo_path,
            auto_start_claude: bool_campo(t, "autoStartClaude", true),
            resume: bool_campo(t, "resume", true),
            cuenta,
            name_pattern,
            initial_prompt,
            use_worktree,
        };
        match problema {
            Some(p) => plantillas_descartadas.push(PlantillaDescartada { name: e.name, reason: p.into() }),
            None => plantillas.push(e),
        }
    }

    // Apariencia: solo los valores que la Configuración acepta; el resto se ignora.
    let apariencia = data.get("apariencia").and_then(obj).map(|a| ExportedAppearance {
        theme: texto(a, "theme").filter(|t| THEMES.contains(t)).map(String::from),
        density: texto(a, "density").filter(|d| DENSITIES.contains(d)).map(String::from),
        ui_font_size: a.get("uiFontSize").and_then(es_entero).filter(|n| (*n as f64) >= UI_FONT.0 && (*n as f64) <= UI_FONT.1),
        accent: texto(a, "accent").filter(|x| ACCENTS.contains(x)).map(String::from),
        light_mode: a.get("lightMode").and_then(Value::as_bool),
    });

    // Atajos: solo ids conocidos y combinaciones válidas (la Configuración vuelve a validar al aplicar).
    let atajos = data.get("atajos").and_then(obj).and_then(|a| {
        let out: Vec<(String, String)> = SHORTCUT_IDS.iter().filter_map(|id| Some((id.to_string(), combo_canonico(a.get(*id)?.as_str()?)?))).collect();
        (!out.is_empty()).then_some(out)
    });

    let equipo = data.get("equipo").and_then(obj).and_then(|e| texto(e, "supabaseUrl")).and_then(|u| normalizar_url_supabase(u).ok());

    // Permisos: cada regla queda en la lista, válida o no. Las inválidas se muestran y no se pueden tildar.
    let mut permisos: Vec<ParsedPermiso> = Vec::new();
    if let Some(raw) = data.get("permisos").and_then(Value::as_array) {
        if raw.len() > 500 {
            return Err("Demasiados espacios con reglas en el archivo.".into());
        }
        for (i, p) in raw.iter().enumerate() {
            let donde = format!("Permisos {}", i + 1);
            let Some((p, reglas)) = obj(p).and_then(|p| Some((p, p.get("reglas")?.as_array()?))) else { return Err(format!("{donde}: formato inválido.")) };
            if reglas.len() > MAX_RULES {
                return Err(format!("{donde}: demasiadas reglas."));
            }
            permisos.push(ParsedPermiso { espacio: req(p, "espacio", &donde, 120)?, ruta: req(p, "ruta", &donde, 1024)?, reglas: reglas.iter().map(parse_rule).collect() });
        }
    }

    Ok(ParsedImport { version, formato_version, cuentas, espacios, plantillas, plantillas_descartadas, apariencia, atajos, equipo, permisos })
}

fn nulo_a_vacio_de<'a>(data: &'a Map<String, Value>, k: &str, vacio: &'a Value) -> &'a Value {
    data.get(k).filter(|v| !v.is_null()).unwrap_or(vacio)
}

// ---------- Plan (vista previa) ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SpaceStatus {
    Ok,
    Conflicto,
    Faltante,
    Ya,
    Saltear,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlanSpace {
    pub index: usize,
    pub nombre: String,
    pub ruta: String,
    pub cuenta: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aviso: Option<String>,
    pub status: SpaceStatus,
    /// Motivo cuando no se puede importar tal cual.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub motivo: Option<String>,
    /// Nombre del espacio local que choca (solo en conflicto).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub existente: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AccionCuenta {
    Crear,
    Existe,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlanAccount {
    pub label: String,
    pub action: AccionCuenta,
}

/// Una regla del archivo en la vista previa. `id` = «<grupo>.<regla>» (la interfaz la usa como clave).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlanRule {
    pub id: String,
    pub texto: String,
    pub valida: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub motivo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft: Option<RuleDraft>,
}

/// Reglas de un espacio del archivo. `espacio_index` = -1 si el espacio no está en el archivo.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlanPermiso {
    #[serde(rename = "espacioIndex")]
    pub espacio_index: i64,
    pub espacio: String,
    pub ruta: String,
    pub reglas: Vec<PlanRule>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlantillaSalteada {
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlanPlantillas {
    pub nuevas: Vec<String>,
    pub existentes: Vec<String>,
    pub salteadas: Vec<PlantillaSalteada>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImportPlan {
    pub version: String,
    pub cuentas: Vec<PlanAccount>,
    pub espacios: Vec<PlanSpace>,
    pub plantillas: PlanPlantillas,
    pub apariencia: bool,
    /// Los valores de Apariencia del archivo, para mostrarlos. Sin grupo = null.
    #[serde(rename = "aparienciaValores")]
    pub apariencia_valores: Option<ExportedAppearance>,
    pub atajos: usize,
    pub equipo: Option<String>,
    pub permisos: Vec<PlanPermiso>,
    /// Reglas en total (válidas e inválidas) y cuántas son válidas.
    pub reglas: usize,
    #[serde(rename = "reglasValidas")]
    pub reglas_validas: usize,
}

/// Para comparar carpetas: sin barra final, con `\` y sin mayúsculas.
pub fn norm(p: &str) -> String {
    p.trim_end_matches(['\\', '/']).replace('/', "\\").to_lowercase()
}

/// Qué pasaría con cada espacio y plantilla del archivo. `is_dir` dice si una carpeta existe en esta PC. Un espacio con
/// el mismo nombre y la misma carpeta ya está en Sloth; con el mismo nombre y otra carpeta es un conflicto (lo decide el
/// usuario). Una carpeta que no existe es «faltante» (se puede elegir otra).
pub fn build_plan(parsed: &ParsedImport, cuentas: &[Value], espacios_locales: &[Value], is_dir: &dyn Fn(&str) -> bool, plantillas_locales: &Value) -> ImportPlan {
    let nombre_de = |w: &Value| w.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
    let locales: HashSet<String> = cuentas.iter().map(|a| trim_js(a.get("label").and_then(Value::as_str).unwrap_or_default()).to_lowercase()).collect();
    let plan_cuentas: Vec<PlanAccount> = parsed.cuentas.iter().map(|c| PlanAccount { label: c.label.clone(), action: if locales.contains(&c.label.to_lowercase()) { AccionCuenta::Existe } else { AccionCuenta::Crear } }).collect();
    let conocidas: HashSet<String> = locales.iter().cloned().chain(parsed.cuentas.iter().map(|c| c.label.to_lowercase())).collect();

    let espacios: Vec<PlanSpace> = parsed
        .espacios
        .iter()
        .enumerate()
        .map(|(index, e)| {
            let mut p = PlanSpace { index, nombre: e.nombre.clone(), ruta: e.ruta.clone(), cuenta: e.cuenta.clone(), color: e.color.clone(), aviso: e.aviso.clone(), status: SpaceStatus::Ok, motivo: None, existente: None };
            let saltear = |mut p: PlanSpace, status, motivo: String| {
                p.status = status;
                p.motivo = Some(motivo);
                p
            };
            if !conocidas.contains(&e.cuenta.to_lowercase()) {
                return saltear(p, SpaceStatus::Saltear, format!("la cuenta «{}» no está en el archivo", e.cuenta));
            }
            if e.sin_carpeta {
                return saltear(p, SpaceStatus::Saltear, "es un worktree y el archivo no trae su carpeta".into());
            }
            if !is_dir(&e.ruta) {
                return saltear(p, SpaceStatus::Faltante, "la carpeta no existe en esta PC".into());
            }
            let mismo_nombre = espacios_locales.iter().find(|w| trim_js(&nombre_de(w)).to_lowercase() == trim_js(&e.nombre).to_lowercase());
            if let Some(w) = mismo_nombre {
                if norm(w.get("repoPath").and_then(Value::as_str).unwrap_or_default()) == norm(&e.ruta) {
                    return saltear(p, SpaceStatus::Ya, "ya está en Sloth".into());
                }
                p.status = SpaceStatus::Conflicto;
                p.existente = Some(nombre_de(w));
            }
            p
        })
        .collect();

    let mut nombres_locales: HashSet<String> = template_list(plantillas_locales).into_iter().flatten().filter_map(template_name).map(|n| n.to_lowercase()).collect();
    let mut nuevas = Vec::new();
    let mut existentes = Vec::new();
    let mut salteadas: Vec<PlantillaSalteada> = parsed.plantillas_descartadas.iter().map(|d| PlantillaSalteada { name: d.name.clone(), reason: d.reason.clone() }).collect();
    for t in &parsed.plantillas {
        if nombres_locales.contains(&t.name.to_lowercase()) {
            existentes.push(t.name.clone());
        } else if !is_dir(&t.repo_path) {
            salteadas.push(PlantillaSalteada { name: t.name.clone(), reason: "la carpeta del repo no existe en esta PC".into() });
        } else {
            nombres_locales.insert(t.name.to_lowercase());
            nuevas.push(t.name.clone());
        }
    }

    let permisos: Vec<PlanPermiso> = parsed
        .permisos
        .iter()
        .enumerate()
        .map(|(i, p)| PlanPermiso {
            espacio_index: parsed.espacios.iter().position(|e| e.nombre == p.espacio && e.ruta == p.ruta).map_or(-1, |n| n as i64),
            espacio: p.espacio.clone(),
            ruta: p.ruta.clone(),
            reglas: p.reglas.iter().enumerate().map(|(j, r)| PlanRule { id: format!("{i}.{j}"), texto: r.texto.clone(), valida: r.valida, motivo: r.motivo.clone(), draft: r.draft.clone() }).collect(),
        })
        .collect();
    let todas: Vec<&PlanRule> = permisos.iter().flat_map(|p| p.reglas.iter()).collect();
    let apariencia = parsed.apariencia.as_ref().filter(|a| !a.vacia()).cloned();

    ImportPlan {
        version: parsed.version.clone(),
        cuentas: plan_cuentas,
        espacios,
        plantillas: PlanPlantillas { nuevas, existentes, salteadas },
        apariencia: apariencia.is_some(),
        apariencia_valores: apariencia,
        atajos: parsed.atajos.as_ref().map_or(0, Vec::len),
        equipo: parsed.equipo.clone(),
        permisos: permisos.clone(),
        reglas: todas.len(),
        reglas_validas: todas.iter().filter(|r| r.valida).count(),
    }
}

/// Plantillas nuevas listas para `feat:templates:save` (sin id: se crean). La cuenta se busca por nombre; si no está,
/// queda «sugerida». La función «templates» valida todo de nuevo.
pub fn templates_to_save(parsed: &ParsedImport, plan: &ImportPlan, id_por_label: &HashMap<String, String>) -> Vec<Value> {
    let nuevas: HashSet<String> = plan.plantillas.nuevas.iter().map(|n| n.to_lowercase()).collect();
    parsed
        .plantillas
        .iter()
        .filter(|t| nuevas.contains(&t.name.to_lowercase()))
        .map(|t| {
            let account_id = t.cuenta.as_ref().filter(|c| !c.is_empty()).and_then(|c| id_por_label.get(&c.to_lowercase())).filter(|id| !id.is_empty()).cloned().unwrap_or_else(|| "sugerida".into());
            let mut o = Map::new();
            o.insert("name".into(), json!(t.name));
            o.insert("repoPath".into(), json!(t.repo_path));
            o.insert("accountId".into(), json!(account_id));
            if let Some(p) = &t.name_pattern {
                o.insert("namePattern".into(), json!(p));
            }
            if let Some(p) = &t.initial_prompt {
                o.insert("initialPrompt".into(), json!(p));
            }
            if let Some(w) = &t.use_worktree {
                o.insert("useWorktree".into(), json!({ "branchPattern": w.branch_pattern }));
            }
            o.insert("autoStartClaude".into(), json!(t.auto_start_claude));
            o.insert("resume".into(), json!(t.resume));
            Value::Object(o)
        })
        .collect()
}

#[cfg(test)]
mod tests;
