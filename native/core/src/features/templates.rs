//! Plantillas de espacio: variables, validación de lo que llega por IPC y el archivo `templates.json` (versionado).
//! Equivale a src/shared/templates-shared.ts y src/main/features/templates-core.ts. La carpeta, las cuentas, el reloj y
//! el generador de ids entran como datos o closures.
use crate::avisos::Avisos;
use crate::initial_prompt::problema_del_primer_mensaje;
use crate::perfiles_core::es_blanco_js;
use crate::persistencia::{escribir_json_atomico, leer_json, respaldar, OpcionesLectura};
use crate::versionado::{migrar, EstadoVersion, Migraciones};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::cell::Cell;
use std::path::{Path, PathBuf};

pub const TEMPLATE_VARS: [&str; 7] = ["ticket", "ticketmin", "carpeta", "rama", "fecha", "n", "plantilla"];
/// La rama no puede depender de sí misma ni de la carpeta.
pub const BRANCH_VARS: [&str; 5] = ["ticket", "ticketmin", "fecha", "n", "plantilla"];
pub const TEMPLATE_ICON_KEYS: [&str; 6] = ["ticket", "db", "revision", "bolt", "compass", "rama"];
pub const TEMPLATE_COLOR_KEYS: [&str; 5] = ["cielo", "hoja", "lila", "ambar", "coral"];
pub const SUGGESTED: &str = "sugerida";
const VERSION_PLANTILLAS: u32 = 1;

fn utf16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `s.slice(0, n)` en unidades UTF-16; un par partido por la mitad se descarta.
fn cortar_utf16(s: &str, n: usize) -> String {
    let mut u = 0;
    s.chars()
        .take_while(|c| {
            u += c.len_utf16();
            u <= n
        })
        .collect()
}

/// Nombres de las variables que aparecen en un texto (`\{([^{}\s]*)\}`), sin llaves.
pub fn vars_en(s: Option<&str>) -> Vec<String> {
    let c: Vec<char> = s.unwrap_or("").chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] == '{' {
            let mut j = i + 1;
            while j < c.len() && c[j] != '{' && c[j] != '}' && !es_blanco_js(c[j]) {
                j += 1;
            }
            if c.get(j) == Some(&'}') {
                out.push(c[i + 1..j].iter().collect());
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ValoresVars {
    pub ticket: Option<String>,
    /// Carpeta corta para mostrar: «mi-app/front».
    pub carpeta: Option<String>,
    pub rama: Option<String>,
    /// AAAA-MM-DD
    pub fecha: Option<String>,
    pub n: Option<f64>,
    pub plantilla: Option<String>,
}

fn numero_a_texto(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e21 {
        format!("{n:.0}")
    } else {
        n.to_string()
    }
}

pub fn valor_de(nombre: &str, v: &ValoresVars) -> Option<String> {
    match nombre {
        "ticket" => v.ticket.clone(),
        "ticketmin" => v.ticket.as_ref().filter(|t| !t.is_empty()).map(|t| t.to_lowercase()),
        "carpeta" => v.carpeta.clone(),
        "rama" => v.rama.clone(),
        "fecha" => v.fecha.clone(),
        "n" => v.n.map(numero_a_texto),
        "plantilla" => v.plantilla.clone(),
        _ => None,
    }
}

/// Reemplaza las variables que tengan valor. Las que faltan quedan como están.
pub fn aplicar_vars(s: &str, v: &ValoresVars) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] == '{' {
            let mut j = i + 1;
            while j < c.len() && c[j] != '{' && c[j] != '}' && !es_blanco_js(c[j]) {
                j += 1;
            }
            if c.get(j) == Some(&'}') {
                let nombre: String = c[i + 1..j].iter().collect();
                match valor_de(&nombre, v) {
                    Some(val) => out.push_str(&val),
                    None => out.extend(&c[i..=j]),
                }
                i = j + 1;
                continue;
            }
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

fn sin_repetir(v: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for x in v {
        if !out.contains(&x) {
            out.push(x);
        }
    }
    out
}

/// Variables que el texto usa y todavía no tienen valor, o que no existen.
pub fn vars_faltantes(s: Option<&str>, v: &ValoresVars) -> Vec<String> {
    sin_repetir(vars_en(s).into_iter().filter(|n| !TEMPLATE_VARS.contains(&n.as_str()) || valor_de(n, v).is_none()).collect())
}

pub fn vars_desconocidas(s: Option<&str>) -> Vec<String> {
    sin_repetir(vars_en(s).into_iter().filter(|n| !TEMPLATE_VARS.contains(&n.as_str())).collect())
}

/// Fecha local AAAA-MM-DD a partir de un instante y del desfase local en minutos (este de UTC, positivo).
pub fn hoy(epoch_ms: f64, desfase_min: i32) -> String {
    let local = epoch_ms.floor() as i64 + i64::from(desfase_min) * 60_000;
    let (y, m, d) = super::civil_de_dias(local.div_euclid(86_400_000));
    format!("{y:04}-{m:02}-{d:02}")
}

/// Carpeta corta para {carpeta}: los dos últimos tramos.
pub fn etiqueta_de_carpeta(p: Option<&str>) -> String {
    let partes: Vec<&str> = p.unwrap_or("").split(['\\', '/']).filter(|s| !s.is_empty()).collect();
    partes[partes.len().saturating_sub(2)..].join("/")
}

/// Nombre de rama válido para git (subconjunto conservador de check-ref-format).
pub fn rama_valida(b: &str) -> bool {
    if b.is_empty() || utf16(b) > 200 || !b.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-')) {
        return false;
    }
    !(b.starts_with('-') || b.starts_with('/') || b.ends_with('/') || b.ends_with('.') || b.ends_with(".lock") || b.contains("..") || b.contains("//") || b.contains("/.") || b == "@")
}

/// `^[A-Z][A-Z0-9]*-\d+$`
pub fn es_ticket_con_clave(t: &str) -> bool {
    let Some((pre, num)) = t.rsplit_once('-') else { return false };
    let mut c = pre.chars();
    c.next().is_some_and(|p| p.is_ascii_uppercase()) && c.all(|x| x.is_ascii_uppercase() || x.is_ascii_digit()) && !num.is_empty() && num.bytes().all(|b| b.is_ascii_digit())
}

fn es_ticket_libre(t: &str) -> bool {
    let mut c = t.chars();
    c.next().is_some_and(|p| p.is_ascii_alphanumeric()) && t.len() <= 20 && c.all(|x| x.is_ascii_alphanumeric() || matches!(x, '_' | '.' | '-'))
}

/// Los tipo ABC-123 van en mayúsculas; los de otros servicios, tal cual. Va al PTY y a nombres de rama.
pub fn normalizar_id_ticket(raw: &str) -> Option<String> {
    let t = raw.trim_matches(es_blanco_js);
    let mayus = t.to_uppercase();
    if es_ticket_con_clave(&mayus) {
        return Some(mayus);
    }
    (es_ticket_libre(t) && !t.contains("..")).then(|| t.to_string())
}

pub fn mismo_ticket(guardado: Option<&str>, id: &str) -> bool {
    guardado.is_some_and(|g| g.to_uppercase() == id.to_uppercase())
}

fn norm_carpeta(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

pub fn misma_carpeta(a: &str, b: &str) -> bool {
    norm_carpeta(a) == norm_carpeta(b)
}

/// El espacio ya creado para un ticket. Con `por_carpeta` (GitHub) además tiene que coincidir la carpeta.
pub fn espacio_del_ticket<'a, W>(ws: &'a [W], id: &str, carpeta: Option<&str>, por_carpeta: bool, campos: impl for<'b> Fn(&'b W) -> (Option<&'b str>, &'b str)) -> Option<&'a W> {
    ws.iter().find(|w| {
        let (ticket, repo) = campos(w);
        mismo_ticket(ticket, id) && (!por_carpeta || carpeta.is_some_and(|c| misma_carpeta(repo, c)))
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct Plantilla {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub repo_path: Option<String>,
    pub account_id: String,
    pub name_pattern: Option<String>,
    pub initial_prompt: Option<String>,
    pub branch_pattern: Option<String>,
    pub auto_start_claude: bool,
    pub resume: bool,
    pub counter: f64,
    pub created_at: Option<f64>,
    pub updated_at: Option<f64>,
    /// Campos que esta versión no conoce: se conservan al guardar.
    pub extra: Map<String, Value>,
}

fn num(f: f64) -> Value {
    if f.is_finite() && f.fract() == 0.0 && f.abs() < 9e15 {
        Value::from(f as i64)
    } else {
        serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number)
    }
}

const CONOCIDAS: [&str; 15] = [
    "id", "name", "description", "icon", "color", "repoPath", "accountId", "namePattern", "initialPrompt", "useWorktree", "autoStartClaude", "resume", "counter", "createdAt", "updatedAt",
];

impl Plantilla {
    /// None si falta `id`, `name` o `accountId` como texto. Un campo conocido con otro tipo se descarta.
    pub fn desde_json(v: &Value) -> Option<Plantilla> {
        let o = v.as_object()?;
        let txt = |k: &str| o.get(k).and_then(Value::as_str).map(str::to_string);
        let flag = |k: &str| o.get(k).and_then(Value::as_bool).unwrap_or(false);
        Some(Plantilla {
            id: txt("id")?,
            name: txt("name")?,
            description: txt("description"),
            icon: txt("icon"),
            color: txt("color"),
            repo_path: txt("repoPath"),
            account_id: txt("accountId")?,
            name_pattern: txt("namePattern"),
            initial_prompt: txt("initialPrompt"),
            branch_pattern: o.get("useWorktree").and_then(|u| u.get("branchPattern")).and_then(Value::as_str).map(str::to_string),
            auto_start_claude: flag("autoStartClaude"),
            resume: flag("resume"),
            counter: o.get("counter").and_then(Value::as_f64).filter(|n| n.is_finite()).unwrap_or(0.0),
            created_at: o.get("createdAt").and_then(Value::as_f64),
            updated_at: o.get("updatedAt").and_then(Value::as_f64),
            extra: o.iter().filter(|(k, _)| !CONOCIDAS.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect(),
        })
    }

    /// Las claves van en el orden con que la escribe la app; las vacías no se escriben.
    pub fn a_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("id".into(), json!(self.id));
        o.insert("name".into(), json!(self.name));
        let mut opc = |k: &str, v: &Option<String>| {
            if let Some(v) = v {
                o.insert(k.into(), json!(v));
            }
        };
        opc("description", &self.description);
        opc("icon", &self.icon);
        opc("color", &self.color);
        opc("repoPath", &self.repo_path);
        o.insert("accountId".into(), json!(self.account_id));
        let mut opc = |k: &str, v: &Option<String>| {
            if let Some(v) = v {
                o.insert(k.into(), json!(v));
            }
        };
        opc("namePattern", &self.name_pattern);
        opc("initialPrompt", &self.initial_prompt);
        if let Some(b) = &self.branch_pattern {
            o.insert("useWorktree".into(), json!({ "branchPattern": b }));
        }
        o.insert("autoStartClaude".into(), json!(self.auto_start_claude));
        o.insert("resume".into(), json!(self.resume));
        o.insert("counter".into(), num(self.counter));
        if let Some(c) = self.created_at {
            o.insert("createdAt".into(), num(c));
        }
        if let Some(u) = self.updated_at {
            o.insert("updatedAt".into(), num(u));
        }
        for (k, v) in &self.extra {
            o.insert(k.clone(), v.clone());
        }
        Value::Object(o)
    }

    pub fn usa_ticket(&self) -> bool {
        usa_ticket(self.name_pattern.as_deref(), self.initial_prompt.as_deref(), self.branch_pattern.as_deref())
    }
}

pub fn usa_ticket(name_pattern: Option<&str>, initial_prompt: Option<&str>, branch_pattern: Option<&str>) -> bool {
    [name_pattern, initial_prompt, branch_pattern].iter().any(|s| vars_en(*s).iter().any(|v| v == "ticket" || v == "ticketmin"))
}

fn revisar_vars(s: Option<&str>, donde: &str, permitidas: &[&str]) -> Result<(), String> {
    for v in vars_en(s) {
        if !permitidas.contains(&v.as_str()) {
            let lista: Vec<String> = permitidas.iter().map(|x| format!("{{{x}}}")).collect();
            return Err(format!("{donde}: variable no válida {{{v}}}. Usá {}.", lista.join(", ")));
        }
    }
    Ok(())
}

/// Ticket que llega por IPC: vacío o ausente es «sin ticket».
pub fn normalizar_ticket(raw: Option<&Value>) -> Result<Option<String>, String> {
    let malo = || "El ticket solo lleva letras, números, guiones, puntos o _ (p. ej. PROJ-123 o 123).".to_string();
    let t = match raw {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(s)) if s.is_empty() => return Ok(None),
        Some(Value::String(s)) if utf16(s) <= 40 => s,
        _ => return Err(malo()),
    };
    if t.trim_matches(es_blanco_js).is_empty() {
        return Ok(None);
    }
    normalizar_id_ticket(t).map(Some).ok_or_else(malo)
}

fn texto(v: Option<&Value>, max: usize, etiqueta: &str, requerido: bool) -> Result<Option<String>, String> {
    let falta = || if requerido { Err(format!("Falta {etiqueta}.")) } else { Ok(None) };
    let s = match v {
        None | Some(Value::Null) => return falta(),
        Some(Value::String(s)) => s,
        Some(_) => return Err(format!("{etiqueta}: tiene que ser texto.")),
    };
    let t = s.trim_matches(es_blanco_js);
    if t.is_empty() {
        return falta();
    }
    if utf16(t) > max {
        return Err(format!("{etiqueta}: es demasiado largo (máximo {max})."));
    }
    Ok(Some(t.to_string()))
}

fn elegir(v: Option<&Value>, claves: &[&str], etiqueta: &str) -> Result<Option<String>, String> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.is_empty() => Ok(None),
        Some(Value::String(s)) if claves.contains(&s.as_str()) => Ok(Some(s.clone())),
        Some(_) => Err(format!("{etiqueta} inválido.")),
    }
}

pub struct Entorno<'a> {
    pub cuenta_existe: &'a dyn Fn(&str) -> bool,
    /// Absoluta, existe y es carpeta.
    pub carpeta_valida: &'a dyn Fn(&str) -> bool,
    pub ahora_ms: f64,
    pub desfase_min: i32,
}

/// Valida lo que llega por IPC y arma la plantilla. `prev` es la que se edita: conserva id, contador, creación y lo que no vino.
pub fn sanear_plantilla(raw: &Value, e: &Entorno, prev: Option<&Plantilla>, nuevo_id: impl FnOnce() -> String) -> Result<Plantilla, String> {
    let r = raw.as_object().ok_or("Plantilla inválida.")?;
    let name = texto(r.get("name"), 80, "el nombre", true)?.unwrap_or_default();
    let description = texto(r.get("description"), 140, "la descripción", false)?;
    let icon = elegir(r.get("icon"), &TEMPLATE_ICON_KEYS, "El ícono")?.or_else(|| prev.and_then(|p| p.icon.clone())).unwrap_or_else(|| "rama".into());
    let color = elegir(r.get("color"), &TEMPLATE_COLOR_KEYS, "El color")?.or_else(|| prev.and_then(|p| p.color.clone())).unwrap_or_else(|| "cielo".into());
    let repo_path = texto(r.get("repoPath"), 1000, "la carpeta", false)?;
    if repo_path.as_deref().is_some_and(|p| !(e.carpeta_valida)(p)) {
        return Err("Elegí una carpeta válida para la plantilla.".into());
    }
    let account_id = texto(r.get("accountId"), 100, "la cuenta", false)?.unwrap_or_else(|| SUGGESTED.into());
    if account_id != SUGGESTED && !(e.cuenta_existe)(&account_id) {
        return Err("Esa cuenta ya no existe.".into());
    }
    let name_pattern = texto(r.get("namePattern"), 120, "el nombre del espacio", false)?;
    let initial_prompt = texto(r.get("initialPrompt"), 4000, "el primer mensaje", false)?;
    let mut branch_pattern = None;
    match r.get("useWorktree") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => {}
        Some(Value::Object(u)) => {
            let bp = texto(u.get("branchPattern"), 200, "el patrón de rama", true)?.unwrap_or_default();
            revisar_vars(Some(&bp), "Rama", &BRANCH_VARS)?;
            let muestra = aplicar_vars(&bp, &ValoresVars { ticket: Some("PROJ-1".into()), fecha: Some(hoy(e.ahora_ms, e.desfase_min)), n: Some(1.0), plantilla: Some(name.clone()), ..Default::default() });
            if !rama_valida(&muestra) {
                return Err(format!("La rama «{muestra}» no es un nombre válido para git."));
            }
            branch_pattern = Some(bp);
        }
        // Un arreglo es un objeto en JS, pero sin `branchPattern`.
        Some(Value::Array(_)) => {
            texto(None, 200, "el patrón de rama", true)?;
        }
        Some(_) => return Err("Rama aparte inválida.".into()),
    }
    revisar_vars(name_pattern.as_deref(), "Nombre del espacio", &TEMPLATE_VARS)?;
    revisar_vars(initial_prompt.as_deref(), "Primer mensaje", &TEMPLATE_VARS)?;
    if let Some(p) = initial_prompt.as_deref().filter(|p| !p.is_empty()).and_then(problema_del_primer_mensaje) {
        return Err(p.into());
    }
    let booleano = |k: &str, msg: &str| match r.get(k) {
        None => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(msg.to_string()),
    };
    let auto = booleano("autoStartClaude", "autoStartClaude inválido.")?;
    let resume = booleano("resume", "resume inválido.")?;
    Ok(Plantilla {
        id: prev.map_or_else(nuevo_id, |p| p.id.clone()),
        name,
        description,
        icon: Some(icon),
        color: Some(color),
        repo_path,
        account_id,
        name_pattern,
        initial_prompt,
        branch_pattern,
        auto_start_claude: auto.unwrap_or_else(|| prev.map_or(true, |p| p.auto_start_claude)),
        resume: resume.unwrap_or_else(|| prev.map_or(true, |p| p.resume)),
        counter: prev.map_or(0.0, |p| p.counter),
        created_at: Some(prev.and_then(|p| p.created_at).unwrap_or(e.ahora_ms)),
        updated_at: Some(e.ahora_ms),
        extra: Map::new(),
    })
}

#[derive(Debug, Clone, Default)]
pub struct VarsDeCreacion {
    /// Ticket ya escrito (PROJ-123).
    pub ticket: Option<String>,
    /// Carpeta del espacio (si la plantilla no tiene una fija).
    pub repo_path: Option<String>,
    /// Rama actual del repo, para {rama} cuando no hay rama aparte.
    pub current_branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NuevoEspacio {
    pub name: String,
    pub repo_path: String,
    pub account_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub auto_start_claude: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_prompt: Option<String>,
    pub resume: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ticket: Option<String>,
}

/// Arma el espacio a partir de la plantilla (con la cuenta ya resuelta). La carpeta sale de la plantilla o de la que se eligió al crear.
pub fn armar_espacio(t: &Plantilla, vars: &VarsDeCreacion, account_id: &str, ahora_ms: f64, desfase_min: i32) -> Result<(NuevoEspacio, f64), String> {
    let ticket = normalizar_ticket(vars.ticket.as_ref().map(|t| Value::String(t.clone())).as_ref())?;
    let repo_path = t.repo_path.clone().or_else(|| vars.repo_path.clone()).filter(|p| !p.is_empty()).ok_or("Elegí la carpeta del espacio.")?;
    if t.usa_ticket() && ticket.is_none() {
        return Err("Esta plantilla necesita un ticket (PROJ-123).".into());
    }
    let n = t.counter + 1.0;
    let base = ValoresVars { ticket: ticket.clone(), fecha: Some(hoy(ahora_ms, desfase_min)), n: Some(n), plantilla: Some(t.name.clone()), carpeta: Some(etiqueta_de_carpeta(Some(&repo_path))), rama: None };
    let branch = t.branch_pattern.as_ref().map(|b| aplicar_vars(b, &base));
    if let Some(b) = branch.as_deref().filter(|b| !rama_valida(b)) {
        return Err(format!("La rama «{b}» no es un nombre válido para git."));
    }
    let rama = branch.clone().or_else(|| vars.current_branch.clone()).unwrap_or_default();
    let completo = ValoresVars { rama: Some(rama), ..base };
    let patron = t.name_pattern.clone().unwrap_or_else(|| if t.usa_ticket() { "{plantilla} {ticket}" } else { "{plantilla} #{n}" }.into());
    let name = cortar_utf16(aplicar_vars(&patron, &completo).trim_matches(es_blanco_js), 120);
    if name.is_empty() {
        return Err("El nombre del espacio quedó vacío.".into());
    }
    let initial_prompt = t.initial_prompt.as_deref().filter(|p| !p.is_empty()).map(|p| aplicar_vars(p, &completo));
    if initial_prompt.as_deref().is_some_and(|p| utf16(p) > 4000) {
        return Err("El primer mensaje es demasiado largo.".into());
    }
    if let Some(p) = initial_prompt.as_deref().filter(|p| !p.is_empty()).and_then(problema_del_primer_mensaje) {
        return Err(p.into());
    }
    let input = NuevoEspacio { name, repo_path, account_id: account_id.into(), branch, auto_start_claude: t.auto_start_claude, initial_prompt, resume: t.resume, ticket };
    Ok((input, n))
}

fn nombre_unico(base: &str, lista: &[Plantilla]) -> String {
    let norm = |s: &str| s.trim_matches(es_blanco_js).to_lowercase();
    let mut n = cortar_utf16(base, 80);
    let mut k = 2;
    while lista.iter().any(|t| norm(&t.name) == norm(&n)) {
        let sufijo = format!(" ({k})");
        n = format!("{}{sufijo}", cortar_utf16(base, 80 - utf16(&sufijo)));
        k += 1;
    }
    n
}

/// El JSON de plantillas (escritura atómica: tmp + rename). Versionado: sin `version` es la 1; una más nueva se lee pero nunca se reescribe.
pub struct ArchivoPlantillas<'a> {
    lista: Vec<Plantilla>,
    def: Option<String>,
    file: PathBuf,
    resto: Map<String, Value>,
    solo_lectura: bool,
    futura: bool,
    por_respaldar: bool,
    avisos: &'a Avisos,
    nuevo_id: Box<dyn FnMut() -> String + Send + 'a>,
}

fn nombre_archivo(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

impl<'a> ArchivoPlantillas<'a> {
    pub fn abrir(file: &Path, avisos: &'a Avisos, nuevo_id: Box<dyn FnMut() -> String + Send + 'a>) -> Self {
        let estado = Cell::new(None);
        let migraciones = Migraciones::new();
        let validar = |v: &Value| {
            let r = migrar(v, &migraciones, VERSION_PLANTILLAS);
            if r.estado == EstadoVersion::Invalida {
                return None;
            }
            estado.set(Some(r.estado));
            r.datos.as_object().cloned()
        };
        let por_defecto = Map::new;
        let lectura = leer_json(file, &OpcionesLectura::nuevas(&validar, &por_defecto), avisos);
        let futura = estado.get() == Some(EstadoVersion::Futura);
        if futura {
            avisos.version_futura(file);
        }
        let mut data = lectura.valor;
        let def = data.get("defaultId").and_then(Value::as_str).map(str::to_string);
        let lista = match data.get("templates") {
            Some(Value::Array(a)) => a.iter().filter_map(Plantilla::desde_json).collect(),
            _ => vec![],
        };
        for k in ["version", "templates", "defaultId"] {
            data.remove(k);
        }
        ArchivoPlantillas { lista, def, file: file.to_path_buf(), resto: data, solo_lectura: futura, futura, por_respaldar: estado.get() == Some(EstadoVersion::Migrado), avisos, nuevo_id }
    }

    fn guardar(&mut self) -> Result<(), String> {
        if self.solo_lectura {
            if self.futura {
                self.avisos.version_futura(&self.file);
            }
            return Ok(());
        }
        if self.por_respaldar {
            match respaldar(&self.file) {
                Ok(_) => self.por_respaldar = false,
                Err(e) => {
                    self.solo_lectura = true;
                    self.avisos.avisar(format!("No pude respaldar {} antes de actualizarlo ({e}); no voy a guardar cambios hasta que reinicies Sloth.", nombre_archivo(&self.file)));
                    return Ok(());
                }
            }
        }
        let mut data = self.resto.clone();
        data.insert("version".into(), json!(VERSION_PLANTILLAS));
        data.insert("templates".into(), Value::Array(self.lista.iter().map(Plantilla::a_json).collect()));
        data.insert("defaultId".into(), self.def.as_ref().map_or(Value::Null, |d| json!(d)));
        escribir_json_atomico(&self.file, &Value::Object(data)).map(|_| ()).map_err(|e| e.to_string())
    }

    pub fn todas(&self) -> Vec<Plantilla> {
        self.lista.clone()
    }

    pub fn obtener(&self, id: &Value) -> Option<&Plantilla> {
        id.as_str().and_then(|i| self.lista.iter().find(|t| t.id == i))
    }

    pub fn id_predeterminada(&self) -> Option<String> {
        self.def.clone().filter(|d| self.lista.iter().any(|t| &t.id == d))
    }

    /// Crea (sin id) o actualiza (con id existente).
    pub fn guardar_plantilla(&mut self, raw: &Value, e: &Entorno) -> Result<Plantilla, String> {
        let id = raw.as_object().and_then(|o| o.get("id"));
        let prev = id.and_then(|i| self.obtener(i)).cloned();
        if id.is_some_and(|i| !i.is_null() && i != "") && prev.is_none() {
            return Err("Esa plantilla ya no existe.".into());
        }
        let t = sanear_plantilla(raw, e, prev.as_ref(), || (self.nuevo_id)())?;
        if self.lista.iter().any(|x| x.id != t.id && x.name.trim_matches(es_blanco_js).to_lowercase() == t.name.to_lowercase()) {
            return Err(format!("Ya hay una plantilla «{}».", t.name));
        }
        if prev.is_none() && self.lista.len() >= 200 {
            return Err("Demasiadas plantillas.".into());
        }
        if prev.is_some() {
            self.lista = self.lista.iter().map(|x| if x.id == t.id { t.clone() } else { x.clone() }).collect();
        } else {
            self.lista.push(t.clone());
        }
        self.guardar()?;
        Ok(t)
    }

    pub fn quitar(&mut self, id: &Value) -> Result<(), String> {
        let existe = self.obtener(id).map(|t| t.id.clone()).ok_or("Esa plantilla ya no existe.")?;
        self.lista.retain(|t| t.id != existe);
        if self.def.as_deref() == Some(existe.as_str()) {
            self.def = None;
        }
        self.guardar()
    }

    /// Copia con id nuevo y contador en cero.
    pub fn duplicar(&mut self, id: &Value, ahora_ms: f64) -> Result<Plantilla, String> {
        let src = self.obtener(id).cloned().ok_or("Esa plantilla ya no existe.")?;
        let copia = Plantilla { id: (self.nuevo_id)(), name: nombre_unico(&format!("Copia de {}", src.name), &self.lista), counter: 0.0, created_at: Some(ahora_ms), updated_at: Some(ahora_ms), ..src };
        if self.lista.len() >= 200 {
            return Err("Demasiadas plantillas.".into());
        }
        self.lista.push(copia.clone());
        self.guardar()?;
        Ok(copia)
    }

    pub fn fijar_predeterminada(&mut self, id: &Value) -> Result<(), String> {
        if !id.is_null() && self.obtener(id).is_none() {
            return Err("Esa plantilla ya no existe.".into());
        }
        self.def = id.as_str().map(str::to_string);
        self.guardar()
    }

    pub fn fijar_contador(&mut self, id: &str, n: f64) -> Result<(), String> {
        for t in self.lista.iter_mut().filter(|t| t.id == id) {
            t.counter = t.counter.max(n);
        }
        self.guardar()
    }

    /// Cuenta un espacio más creado con la plantilla (para {n}).
    pub fn sumar_uso(&mut self, id: &Value) -> Result<(), String> {
        let t = self.obtener(id).ok_or("Esa plantilla ya no existe.")?;
        let (id, c) = (t.id.clone(), t.counter);
        self.fijar_contador(&id, c + 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn tmp() -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let d = std::env::temp_dir().join(format!("sloth-tpl-rs-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn nombres(d: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    fn ids() -> Box<dyn FnMut() -> String + Send> {
        let mut n = 0;
        Box::new(move || {
            n += 1;
            format!("id-{n}")
        })
    }

    fn entorno() -> Entorno<'static> {
        Entorno { cuenta_existe: &|id| id == "acc", carpeta_valida: &|p| p.starts_with("C:\\ok"), ahora_ms: 1_764_245_000_000.0, desfase_min: 0 }
    }

    fn plantilla(extra: Value) -> Value {
        let mut base = json!({ "id": "p1", "name": "Una", "accountId": "sugerida", "autoStartClaude": true, "resume": false, "counter": 3, "createdAt": 1, "updatedAt": 1 });
        for (k, v) in extra.as_object().unwrap() {
            base[k] = v.clone();
        }
        base
    }

    #[test]
    fn roto_se_aparta_como_corrupt_y_no_se_pisa_al_guardar() {
        let d = tmp();
        let f = d.join("templates.json");
        let roto = "{ \"version\": 1, \"templates\": [], }";
        fs::write(&f, roto).unwrap();
        let avisos = Avisos::nuevo();
        let t = ArchivoPlantillas::abrir(&f, &avisos, ids());
        assert!(t.todas().is_empty());
        let apartados: Vec<String> = nombres(&d).into_iter().filter(|n| n.starts_with("templates.json.corrupt-")).collect();
        assert_eq!(apartados.len(), 1);
        assert_eq!(fs::read_to_string(d.join(&apartados[0])).unwrap(), roto);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn sin_version_se_lee_se_respalda_y_se_guarda_con_version_1_conservando_campos_desconocidos() {
        let d = tmp();
        let f = d.join("templates.json");
        let original = json!({ "templates": [plantilla(json!({}))], "defaultId": "p1", "futuro": { "a": 1 } }).to_string();
        fs::write(&f, &original).unwrap();
        let avisos = Avisos::nuevo();
        let mut t = ArchivoPlantillas::abrir(&f, &avisos, ids());
        assert_eq!(t.todas().len(), 1);
        assert_eq!(t.id_predeterminada().as_deref(), Some("p1"));
        t.guardar_plantilla(&json!({ "name": "Otra", "accountId": "sugerida" }), &entorno()).unwrap();
        let guardado: Value = serde_json::from_str(&fs::read_to_string(&f).unwrap()).unwrap();
        assert_eq!(guardado["version"], json!(1));
        assert_eq!(guardado["futuro"], json!({ "a": 1 }));
        assert_eq!(guardado["templates"].as_array().unwrap().len(), 2);
        assert_eq!(guardado["templates"][1]["id"], json!("id-1"));
        let bak: Vec<String> = nombres(&d).into_iter().filter(|n| n.starts_with("templates.json.bak-")).collect();
        assert_eq!(bak.len(), 1);
        assert_eq!(fs::read_to_string(d.join(&bak[0])).unwrap(), original);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn el_orden_de_claves_del_archivo_es_el_de_siempre() {
        let d = tmp();
        let f = d.join("templates.json");
        let avisos = Avisos::nuevo();
        let mut t = ArchivoPlantillas::abrir(&f, &avisos, ids());
        t.guardar_plantilla(&json!({ "name": "A", "accountId": "acc", "useWorktree": { "branchPattern": "feat/{ticket}" }, "initialPrompt": "hola" }), &entorno()).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&f).unwrap()).unwrap();
        let claves: Vec<&String> = v.as_object().unwrap().keys().collect();
        assert_eq!(claves, ["version", "templates", "defaultId"]);
        let claves: Vec<&String> = v["templates"][0].as_object().unwrap().keys().collect();
        assert_eq!(claves, ["id", "name", "icon", "color", "accountId", "initialPrompt", "useWorktree", "autoStartClaude", "resume", "counter", "createdAt", "updatedAt"]);
        assert_eq!(v["defaultId"], Value::Null);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn version_futura_se_lee_pero_nunca_se_reescribe() {
        let d = tmp();
        let f = d.join("templates.json");
        let original = json!({ "version": 2, "templates": [plantilla(json!({}))], "nuevo": true }).to_string();
        fs::write(&f, &original).unwrap();
        let avisos = Avisos::nuevo();
        let mut t = ArchivoPlantillas::abrir(&f, &avisos, ids());
        assert_eq!(t.todas().len(), 1);
        t.guardar_plantilla(&json!({ "name": "Otra", "accountId": "sugerida" }), &entorno()).unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), original);
        assert_eq!(nombres(&d), vec!["templates.json"]);
        assert!(!avisos.tomar().is_empty());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn version_rara_se_aparta_y_arranca_vacio() {
        let d = tmp();
        let f = d.join("templates.json");
        fs::write(&f, json!({ "version": "dos", "templates": [plantilla(json!({}))] }).to_string()).unwrap();
        let avisos = Avisos::nuevo();
        let t = ArchivoPlantillas::abrir(&f, &avisos, ids());
        assert!(t.todas().is_empty());
        assert_eq!(nombres(&d).iter().filter(|n| n.contains(".corrupt-")).count(), 1);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn crud_duplicar_predeterminada_y_contador() {
        let d = tmp();
        let f = d.join("templates.json");
        let avisos = Avisos::nuevo();
        let mut t = ArchivoPlantillas::abrir(&f, &avisos, ids());
        let a = t.guardar_plantilla(&json!({ "name": "Una", "accountId": "acc" }), &entorno()).unwrap();
        assert_eq!(t.guardar_plantilla(&json!({ "name": "  una " }), &entorno()), Err("Ya hay una plantilla «una».".into()));
        let copia = t.duplicar(&json!(a.id), 5.0).unwrap();
        assert_eq!(copia.name, "Copia de Una");
        assert_eq!(t.duplicar(&json!(a.id), 5.0).unwrap().name, "Copia de Una (2)");
        t.sumar_uso(&json!(a.id)).unwrap();
        t.sumar_uso(&json!(a.id)).unwrap();
        assert_eq!(t.obtener(&json!(a.id)).unwrap().counter, 2.0);
        t.fijar_contador(&a.id, 1.0).unwrap();
        assert_eq!(t.obtener(&json!(a.id)).unwrap().counter, 2.0);
        t.fijar_predeterminada(&json!(a.id)).unwrap();
        assert_eq!(t.id_predeterminada(), Some(a.id.clone()));
        t.quitar(&json!(a.id)).unwrap();
        assert_eq!(t.id_predeterminada(), None);
        assert_eq!(t.quitar(&json!(a.id)), Err("Esa plantilla ya no existe.".into()));
        assert_eq!(t.fijar_predeterminada(&json!("x")), Err("Esa plantilla ya no existe.".into()));
        assert!(t.fijar_predeterminada(&Value::Null).is_ok());
        assert_eq!(t.guardar_plantilla(&json!({ "id": "fantasma", "name": "Z" }), &entorno()), Err("Esa plantilla ya no existe.".into()));
        let editada = t.guardar_plantilla(&json!({ "id": copia.id, "name": "Editada", "resume": false }), &entorno()).unwrap();
        assert_eq!((editada.id, editada.resume, editada.auto_start_claude, editada.created_at), (copia.id, false, true, Some(5.0)));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn vars_en_y_aplicar() {
        assert_eq!(vars_en(Some("{a} x {b c} {d}{} {{e}")), vec!["a", "d", "", "e"]);
        assert!(vars_en(None).is_empty());
        let v = ValoresVars { ticket: Some("PROJ-1".into()), n: Some(3.0), ..Default::default() };
        assert_eq!(aplicar_vars("{ticket}/{ticketmin}/{n}/{rama}/{x}", &v), "PROJ-1/proj-1/3/{rama}/{x}");
        assert_eq!(vars_faltantes(Some("{ticket} {rama} {x} {rama}"), &v), vec!["rama", "x"]);
        assert_eq!(vars_desconocidas(Some("{ticket} {x} {x}")), vec!["x"]);
    }

    #[test]
    fn hoy_y_carpeta() {
        assert_eq!(hoy(1_764_245_000_000.0, 0), "2025-11-27");
        assert_eq!(hoy(1_764_201_600_000.0, -180), "2025-11-26");
        assert_eq!(etiqueta_de_carpeta(Some("C:\\a\\mi-app\\front\\")), "mi-app/front");
        assert_eq!(etiqueta_de_carpeta(Some("solo")), "solo");
        assert_eq!(etiqueta_de_carpeta(None), "");
    }

    #[test]
    fn ramas() {
        for ok in ["feat/x", "a.b_c-1", "PROJ-1"] {
            assert!(rama_valida(ok), "{ok}");
        }
        for mal in ["", "-x", "/x", "x/", "x.", "x.lock", "a..b", "a//b", "a/.b", "@", "a b", "ñ"] {
            assert!(!rama_valida(mal), "{mal:?}");
        }
        assert!(!rama_valida(&"a".repeat(201)));
    }

    #[test]
    fn normalizar_id_ticket_mayusculas_y_ids_de_otros_servicios() {
        assert_eq!(normalizar_id_ticket(" proj-12 ").as_deref(), Some("PROJ-12"));
        assert_eq!(normalizar_id_ticket("123").as_deref(), Some("123"));
        assert_eq!(normalizar_id_ticket("86c0abcd1").as_deref(), Some("86c0abcd1"));
        for malo in ["", " ", "-1", ".x", "a..b", "a b", "/ticket", "x;rm", &"a".repeat(21), "#12"] {
            assert_eq!(normalizar_id_ticket(malo), None, "{malo:?}");
        }
    }

    #[test]
    fn mismo_ticket_y_misma_carpeta() {
        assert!(mismo_ticket(Some("86C0ABCD1"), "86c0abcd1"));
        assert!(mismo_ticket(Some("PROJ-1"), "PROJ-1"));
        assert!(!mismo_ticket(None, "PROJ-1"));
        assert!(!mismo_ticket(Some("PROJ-1"), "PROJ-12"));
        assert!(misma_carpeta("C:\\a", "c:/a/"));
        assert!(misma_carpeta("C:\\a\\", "C:/a"));
        assert!(!misma_carpeta("C:\\a", "C:\\ab"));
    }

    #[test]
    fn espacio_del_ticket_con_gh_exige_la_misma_carpeta() {
        let ws = [("w1", Some("12"), "C:\\a")];
        fn campos<'b>(w: &'b (&str, Option<&str>, &str)) -> (Option<&'b str>, &'b str) {
            (w.1, w.2)
        }
        assert_eq!(espacio_del_ticket(&ws, "12", Some("c:/a/"), true, campos).map(|w| w.0), Some("w1"));
        assert_eq!(espacio_del_ticket(&ws, "12", Some("C:\\b"), true, campos), None);
        assert_eq!(espacio_del_ticket(&ws, "12", Some("C:\\b"), false, campos).map(|w| w.0), Some("w1"));
        assert_eq!(espacio_del_ticket(&ws, "12", None, true, campos), None);
        assert_eq!(espacio_del_ticket(&ws, "13", Some("C:\\a"), true, campos), None);
    }

    #[test]
    fn normalizar_ticket_de_ipc() {
        assert_eq!(normalizar_ticket(None), Ok(None));
        assert_eq!(normalizar_ticket(Some(&json!(""))), Ok(None));
        assert_eq!(normalizar_ticket(Some(&json!("  "))), Ok(None));
        assert_eq!(normalizar_ticket(Some(&json!("proj-1"))), Ok(Some("PROJ-1".into())));
        for malo in [json!(5), json!("a".repeat(41)), json!("x y")] {
            assert!(normalizar_ticket(Some(&malo)).is_err(), "{malo}");
        }
    }

    fn sanear(v: Value) -> Result<Plantilla, String> {
        sanear_plantilla(&v, &entorno(), None, || "nuevo".into())
    }

    #[test]
    fn sanear_valida_cada_campo() {
        assert_eq!(sanear(json!(null)), Err("Plantilla inválida.".into()));
        assert_eq!(sanear(json!({})), Err("Falta el nombre.".into()));
        assert_eq!(sanear(json!({ "name": 3 })), Err("el nombre: tiene que ser texto.".into()));
        assert_eq!(sanear(json!({ "name": "a".repeat(81) })), Err("el nombre: es demasiado largo (máximo 80).".into()));
        assert_eq!(sanear(json!({ "name": "A", "icon": "zzz" })), Err("El ícono inválido.".into()));
        assert_eq!(sanear(json!({ "name": "A", "repoPath": "D:\\x" })), Err("Elegí una carpeta válida para la plantilla.".into()));
        assert_eq!(sanear(json!({ "name": "A", "accountId": "otra" })), Err("Esa cuenta ya no existe.".into()));
        assert_eq!(sanear(json!({ "name": "A", "namePattern": "{zzz}" })), Err("Nombre del espacio: variable no válida {zzz}. Usá {ticket}, {ticketmin}, {carpeta}, {rama}, {fecha}, {n}, {plantilla}.".into()));
        assert_eq!(sanear(json!({ "name": "A", "initialPrompt": "!ls" })).unwrap_err().contains("«!»"), true);
        assert_eq!(sanear(json!({ "name": "A", "autoStartClaude": "si" })), Err("autoStartClaude inválido.".into()));
        assert_eq!(sanear(json!({ "name": "A", "resume": null })), Err("resume inválido.".into()));
        assert_eq!(sanear(json!({ "name": "A", "useWorktree": true })), Err("Rama aparte inválida.".into()));
        assert_eq!(sanear(json!({ "name": "A", "useWorktree": {} })), Err("Falta el patrón de rama.".into()));
        assert_eq!(sanear(json!({ "name": "A", "useWorktree": { "branchPattern": "{carpeta}" } })).unwrap_err().starts_with("Rama: variable no válida {carpeta}"), true);
        assert_eq!(sanear(json!({ "name": "A", "useWorktree": { "branchPattern": "a b" } })), Err("La rama «a b» no es un nombre válido para git.".into()));
    }

    #[test]
    fn sanear_aplica_valores_por_defecto() {
        let t = sanear(json!({ "name": "  Una  ", "useWorktree": false, "repoPath": "C:\\ok\\r", "accountId": "acc", "description": "" })).unwrap();
        assert_eq!((t.id.as_str(), t.name.as_str(), t.icon.as_deref(), t.color.as_deref()), ("nuevo", "Una", Some("rama"), Some("cielo")));
        assert_eq!((t.auto_start_claude, t.resume, t.counter, t.description, t.branch_pattern), (true, true, 0.0, None, None));
        assert_eq!((t.created_at, t.updated_at), (Some(1_764_245_000_000.0), Some(1_764_245_000_000.0)));
    }

    fn plantilla_armable() -> Plantilla {
        Plantilla::desde_json(&json!({ "id": "p", "name": "Rev", "accountId": "acc", "autoStartClaude": true, "resume": false, "counter": 4, "initialPrompt": "Mirá {ticket} en {rama} ({carpeta})", "useWorktree": { "branchPattern": "rev/{ticketmin}-{n}" } })).unwrap()
    }

    #[test]
    fn armar_espacio_aplica_las_variables() {
        let v = VarsDeCreacion { ticket: Some("proj-9".into()), repo_path: Some("C:\\dev\\mi-app\\front".into()), current_branch: None };
        let (e, n) = armar_espacio(&plantilla_armable(), &v, "acc", 1_764_245_000_000.0, 0).unwrap();
        assert_eq!(n, 5.0);
        assert_eq!(e.name, "Rev PROJ-9");
        assert_eq!(e.branch.as_deref(), Some("rev/proj-9-5"));
        assert_eq!(e.initial_prompt.as_deref(), Some("Mirá PROJ-9 en rev/proj-9-5 (mi-app/front)"));
        assert_eq!(serde_json::to_value(&e).unwrap()["repoPath"], json!("C:\\dev\\mi-app\\front"));
        assert!(!e.resume && e.ticket.as_deref() == Some("PROJ-9"));
    }

    #[test]
    fn armar_espacio_falla_con_claridad() {
        let t = plantilla_armable();
        let v = |tk: Option<&str>, r: Option<&str>| VarsDeCreacion { ticket: tk.map(Into::into), repo_path: r.map(Into::into), current_branch: None };
        assert_eq!(armar_espacio(&t, &v(Some("PROJ-1"), None), "acc", 0.0, 0).unwrap_err(), "Elegí la carpeta del espacio.");
        assert_eq!(armar_espacio(&t, &v(None, Some("C:\\r")), "acc", 0.0, 0).unwrap_err(), "Esta plantilla necesita un ticket (PROJ-123).");
        assert!(armar_espacio(&t, &v(Some("x y"), Some("C:\\r")), "acc", 0.0, 0).is_err());
        let sin_ticket = Plantilla { name_pattern: None, initial_prompt: None, branch_pattern: None, ..t };
        let (e, _) = armar_espacio(&sin_ticket, &VarsDeCreacion { repo_path: Some("C:\\r".into()), current_branch: Some("main".into()), ticket: None }, "acc", 0.0, 0).unwrap();
        assert_eq!((e.name.as_str(), e.branch), ("Rev #5", None));
    }

    #[test]
    fn el_nombre_del_espacio_se_corta_a_120() {
        let t = Plantilla { name_pattern: Some("é".repeat(130)), ..plantilla_armable() };
        let (e, _) = armar_espacio(&t, &VarsDeCreacion { ticket: Some("PROJ-1".into()), repo_path: Some("C:\\r".into()), current_branch: None }, "acc", 0.0, 0).unwrap();
        assert_eq!(e.name.chars().count(), 120);
    }

    #[test]
    fn plantilla_conserva_campos_desconocidos_y_descarta_los_invalidos() {
        assert!(Plantilla::desde_json(&json!({ "id": "a", "name": "b" })).is_none());
        let t = Plantilla::desde_json(&json!({ "id": "a", "name": "b", "accountId": "c", "counter": "x", "futuro": [1] })).unwrap();
        assert_eq!(t.counter, 0.0);
        assert_eq!(t.a_json()["futuro"], json!([1]));
        let t = Plantilla::desde_json(&json!({ "id": "a", "name": "b", "accountId": "c", "counter": 2.5 })).unwrap();
        assert_eq!(t.a_json()["counter"], json!(2.5));
    }
}
