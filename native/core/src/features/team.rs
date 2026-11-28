//! Lógica pura de la vista «Equipo»: parseo de `gh pr list`, resumen de CI y review, y cruce de identidades entre GitHub
//! y el conector de tickets. Equivale a src/main/features/team-core.ts.
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::OnceLock;
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum EstadoCi {
    Pass,
    Fail,
    Running,
    #[default]
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum EstadoReview {
    Approved,
    Changes,
    #[default]
    Pending,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ConteoCi {
    pub pass: u32,
    pub fail: u32,
    pub running: u32,
}

/// El orden de las claves es el de `parsePrList`: así queda igual el team.json que escribe la app de Node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TeamPr {
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub login: String,
    pub branch: String,
    pub is_draft: bool,
    pub review: EstadoReview,
    pub ci: EstadoCi,
    pub checks: ConteoCi,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_bot: Option<bool>,
    /// Nombres de los checks que fallan (máx. 5).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failing: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    /// Campos que esta versión no conoce: se conservan al volver a guardar.
    #[serde(flatten)]
    pub otros: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Categoria {
    Pendiente,
    EnCurso,
    Revision,
    Bloqueado,
    Hecho,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CategoriaActiva {
    EnCurso,
    Revision,
    Bloqueado,
}

pub const CATEGORIAS_ACTIVAS: [CategoriaActiva; 3] = [CategoriaActiva::EnCurso, CategoriaActiva::Revision, CategoriaActiva::Bloqueado];

impl CategoriaActiva {
    fn de(c: Categoria) -> Option<Self> {
        match c {
            Categoria::EnCurso => Some(Self::EnCurso),
            Categoria::Revision => Some(Self::Revision),
            Categoria::Bloqueado => Some(Self::Bloqueado),
            Categoria::Pendiente | Categoria::Hecho => None,
        }
    }

    fn orden(self) -> usize {
        CATEGORIAS_ACTIVAS.iter().position(|c| *c == self).unwrap_or(0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Estado {
    pub clave: String,
    pub nombre: String,
    pub categoria: Categoria,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Ticket {
    pub id: String,
    pub titulo: String,
    pub estado: Option<String>,
    pub proyecto: Option<String>,
    pub url: Option<String>,
    pub responsable: Option<String>,
    pub responsable_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamTicket {
    pub id: String,
    pub titulo: String,
    pub estado: String,
    pub estado_nombre: String,
    pub categoria: CategoriaActiva,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub responsable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub responsable_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proyecto: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PersonaConector {
    pub id: Option<String>,
    pub nombre: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Cruce {
    Manual,
    Auto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub key: String,
    pub nombre: String,
    pub logins: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id_conector: Option<String>,
    pub en_conector: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_bot: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_by: Option<Cruce>,
    pub tickets: Vec<TeamTicket>,
    pub prs: Vec<TeamPr>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub ci_failing: usize,
    pub waiting_review: usize,
    pub blocked: usize,
    pub prs: usize,
    pub tickets: usize,
}

/// Valor del mapeo a mano que dice «este login no es nadie del conector».
pub const NADIE: &str = "-";

fn re(texto: &'static str, cache: &'static OnceLock<Regex>) -> &'static Regex {
    cache.get_or_init(|| Regex::new(texto).unwrap())
}

pub fn login_valido(s: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    re(r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$", &R).is_match(s)
}

pub fn repo_valido(s: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    re(r"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$", &R).is_match(s)
}

pub fn url_de_pr_valida(s: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    re(r"^https://github\.com/[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}/pull/[0-9]{1,9}$", &R).is_match(s)
}

// ---------- equivalentes de JavaScript ----------

/// `s.slice(0, max)` de JavaScript: max cuenta unidades UTF-16 (un carácter fuera del plano básico cuenta 2 y no se parte).
pub fn recortar_utf16(s: &str, max: usize) -> String {
    let mut usadas = 0;
    let mut out = String::new();
    for c in s.chars() {
        usadas += c.len_utf16();
        if usadas > max {
            break;
        }
        out.push(c);
    }
    out
}

pub fn largo_utf16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `String(v ?? '')` de JavaScript para lo que puede traer un JSON.
fn js_texto(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Array(a)) => a.iter().map(|x| if x.is_null() { String::new() } else { js_texto(Some(x)) }).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// Un objeto de JavaScript recorre primero las claves que son un índice de arreglo (en orden numérico) y después el resto
/// en el orden en que se agregaron.
pub fn es_indice_js(k: &str) -> bool {
    !k.is_empty() && k.len() <= 10 && k.bytes().all(|b| b.is_ascii_digit()) && (k == "0" || !k.starts_with('0')) && k.parse::<u64>().is_ok_and(|n| n < 4_294_967_295)
}

pub fn ordenar_como_js<V>(entradas: &mut Vec<(String, V)>) {
    let (mut indices, resto): (Vec<_>, Vec<_>) = std::mem::take(entradas).into_iter().partition(|(k, _)| es_indice_js(k));
    indices.sort_by_key(|(k, _)| k.parse::<u64>().unwrap_or(0));
    entradas.extend(indices);
    entradas.extend(resto);
}

/// Un `Record<string, string>` con el orden de claves de JavaScript.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Mapeo(Vec<(String, String)>);

impl Mapeo {
    pub fn nuevo() -> Self {
        Self::default()
    }

    pub fn desde(pares: &[(&str, &str)]) -> Self {
        let mut m = Mapeo::nuevo();
        for (k, v) in pares {
            m.insertar(k, v);
        }
        m
    }

    pub fn get(&self, k: &str) -> Option<&str> {
        self.0.iter().find(|(c, _)| c == k).map(|(_, v)| v.as_str())
    }

    pub fn insertar(&mut self, k: &str, v: &str) {
        match self.0.iter_mut().find(|(c, _)| c == k) {
            Some(e) => e.1 = v.to_string(),
            None => {
                self.0.push((k.to_string(), v.to_string()));
                ordenar_como_js(&mut self.0);
            }
        }
    }

    pub fn quitar(&mut self, k: &str) {
        self.0.retain(|(c, _)| c != k);
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0.iter().map(|(k, v)| (k.as_str(), v.as_str()))
    }

    pub fn a_valor(&self) -> Value {
        Value::Object(self.0.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect())
    }
}

fn texto_corto(v: Option<&Value>, max: usize) -> Option<String> {
    let s = match v {
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s.clone(),
        _ => return None,
    };
    let limpio = s.split(|c: char| c.is_whitespace() || c == '\u{feff}').filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" ");
    (!limpio.is_empty()).then(|| recortar_utf16(&limpio, max))
}

/// `Date.parse` de una fecha ISO 8601 (la que da GitHub), en ms desde la época. Sin zona, una fecha sola es UTC y una
/// fecha con hora también (la hora local no tiene sentido para ordenar PRs de gente en otras zonas).
pub fn fecha_ms(s: &str) -> Option<i64> {
    static R: OnceLock<Regex> = OnceLock::new();
    let re = re(r"^([+-][0-9]{6}|[0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?(?:[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:[.,]([0-9]+))?)?(Z|[+-][0-9]{2}:?[0-9]{2})?)?$", &R);
    let c = re.captures(s.trim())?;
    let num = |i: usize, por_defecto: i64| c.get(i).map_or(por_defecto, |m| m.as_str().parse::<i64>().unwrap_or(por_defecto));
    let (anio, mes, dia) = (num(1, 0), num(2, 1), num(3, 1));
    let (hora, min, seg) = (num(4, 0), num(5, 0), num(6, 0));
    if !(1..=12).contains(&mes) || !(1..=31).contains(&dia) || hora > 24 || min > 59 || seg > 59 || (hora == 24 && (min > 0 || seg > 0)) {
        return None;
    }
    let ms = c.get(7).map_or(0, |m| {
        let d: String = m.as_str().chars().take(3).collect();
        format!("{d:0<3}").parse::<i64>().unwrap_or(0)
    });
    let desfase = match c.get(8).map(|m| m.as_str()) {
        None | Some("Z") => 0,
        Some(z) => {
            let signo = if z.starts_with('-') { -1 } else { 1 };
            let d: String = z[1..].chars().filter(|c| c.is_ascii_digit()).collect();
            let (h, m): (i64, i64) = (d[..2].parse().ok()?, d[2..].parse().ok()?);
            signo * (h * 60 + m)
        }
    };
    let dias = dias_desde_epoca(anio, mes, dia);
    Some(((dias * 24 + hora) * 60 + min - desfase) * 60_000 + seg * 1000 + ms)
}

fn dias_desde_epoca(anio: i64, mes: i64, dia: i64) -> i64 {
    let y = if mes <= 2 { anio - 1 } else { anio };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if mes > 2 { mes - 3 } else { mes + 9 }) + 2) / 5 + dia - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn tiempo(v: Option<&Value>) -> Option<i64> {
    fecha_ms(v?.as_str()?)
}

// ---------- GitHub ----------

/// `https://github.com/o/r(.git)`, `git@github.com:o/r.git`, `ssh://git@github.com/o/r` → `o/r`.
pub fn remoto_de_github(url: Option<&str>) -> Option<String> {
    static R: OnceLock<Regex> = OnceLock::new();
    let u = url?.trim();
    if u.is_empty() {
        return None;
    }
    let m = re(r"(?i)^(?:https?://(?:[^@/]+@)?github\.com/|git@github\.com:|ssh://git@github\.com(?::[0-9]+)?/)([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?$", &R).captures(u)?;
    let repo = format!("{}/{}", &m[1], &m[2]);
    repo_valido(&repo).then_some(repo)
}

const CONCLUSIONES_FALLIDAS: [&str; 6] = ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumenCi {
    pub ci: EstadoCi,
    pub checks: ConteoCi,
    pub failing: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Clase {
    Pass,
    Fail,
    Running,
    Skip,
}

/// Resume `statusCheckRollup`: los CheckRun (Actions) traen status/conclusion y los StatusContext (statuses viejos:
/// Vercel, Prow, Jenkins…) traen state. Si un check se corrió varias veces, vale la última corrida.
pub fn resumir_checks(raw: &Value) -> ResumenCi {
    let mut checks = ConteoCi::default();
    let mut failing = Vec::new();
    let Some(lista) = raw.as_array() else { return ResumenCi { ci: EstadoCi::None, checks, failing } };
    let mut ultimos: Vec<(String, Clase, i64)> = Vec::new();
    let mut posicion: HashMap<String, usize> = HashMap::new();
    for (i, c) in lista.iter().enumerate() {
        if c.is_null() || !(c.is_object() || c.is_array()) {
            continue;
        }
        let vacio = Map::new();
        let o = c.as_object().unwrap_or(&vacio);
        let (clase, nombre) = if o.get("__typename").and_then(Value::as_str) == Some("StatusContext") || (o.contains_key("state") && !o.contains_key("status")) {
            let s = js_texto(o.get("state")).to_uppercase();
            let clase = match s.as_str() {
                "SUCCESS" => Clase::Pass,
                "FAILURE" | "ERROR" => Clase::Fail,
                _ => Clase::Running,
            };
            (clase, texto_corto(o.get("context"), 120).unwrap_or_else(|| format!("status-{i}")))
        } else {
            let status = js_texto(o.get("status")).to_uppercase();
            let concl = js_texto(o.get("conclusion")).to_uppercase();
            let clase = if status != "COMPLETED" {
                Clase::Running
            } else if CONCLUSIONES_FALLIDAS.contains(&concl.as_str()) {
                Clase::Fail
            } else if concl == "SKIPPED" || concl == "NEUTRAL" {
                Clase::Skip
            } else {
                Clase::Pass
            };
            let partes: Vec<String> = [texto_corto(o.get("workflowName"), 80), texto_corto(o.get("name"), 120)].into_iter().flatten().collect();
            (clase, if partes.is_empty() { format!("check-{i}") } else { partes.join(" / ") })
        };
        let at = tiempo(o.get("completedAt")).or_else(|| tiempo(o.get("startedAt"))).unwrap_or(0);
        match posicion.get(&nombre) {
            Some(&p) if at < ultimos[p].2 => {}
            Some(&p) => ultimos[p] = (nombre, clase, at),
            None => {
                posicion.insert(nombre.clone(), ultimos.len());
                ultimos.push((nombre, clase, at));
            }
        }
    }
    for (nombre, clase, _) in &ultimos {
        match clase {
            Clase::Skip => continue,
            Clase::Pass => checks.pass += 1,
            Clase::Running => checks.running += 1,
            Clase::Fail => {
                checks.fail += 1;
                if failing.len() < 5 {
                    failing.push(nombre.clone());
                }
            }
        }
    }
    let ci = if checks.fail > 0 {
        EstadoCi::Fail
    } else if checks.running > 0 {
        EstadoCi::Running
    } else if checks.pass > 0 || !ultimos.is_empty() {
        EstadoCi::Pass
    } else {
        EstadoCi::None
    };
    ResumenCi { ci, checks, failing }
}

pub fn review_de(v: Option<&Value>) -> EstadoReview {
    match js_texto(v).to_uppercase().as_str() {
        "APPROVED" => EstadoReview::Approved,
        "CHANGES_REQUESTED" => EstadoReview::Changes,
        _ => EstadoReview::Pending,
    }
}

/// Parsea la salida de `gh pr list --json …`. No confía en la forma.
pub fn parsear_lista_de_prs(crudo: &str, repo: &str) -> Result<Vec<TeamPr>, String> {
    let t = crudo.trim();
    let datos: Value = serde_json::from_str(if t.is_empty() { "[]" } else { t }).map_err(|e| format!("gh no devolvió un JSON válido: {e}"))?;
    parsear_prs(&datos, repo)
}

pub fn parsear_prs(datos: &Value, repo: &str) -> Result<Vec<TeamPr>, String> {
    let Some(lista) = datos.as_array() else { return Err("gh no devolvió una lista de PRs.".into()) };
    let mut out = Vec::new();
    for item in lista {
        let Some(o) = item.as_object() else { continue };
        let number = o.get("number").and_then(|n| n.as_u64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0 && *f > 0.0).map(|f| f as u64))).filter(|n| *n > 0);
        let url = texto_corto(o.get("url"), 300);
        let (Some(number), Some(url)) = (number, url) else { continue };
        if !url_de_pr_valida(&url) {
            continue;
        }
        let vacio = Map::new();
        let a = o.get("author").and_then(Value::as_object).unwrap_or(&vacio);
        let login_crudo = texto_corto(a.get("login"), 60).unwrap_or_else(|| "ghost".into());
        let resumen = resumir_checks(o.get("statusCheckRollup").unwrap_or(&Value::Null));
        let mut pr = TeamPr {
            repo: repo.to_string(),
            number,
            title: texto_corto(o.get("title"), 300).unwrap_or_else(|| format!("#{number}")),
            login: if login_valido(&login_crudo) { login_crudo.clone() } else { "ghost".into() },
            branch: texto_corto(o.get("headRefName"), 200).unwrap_or_default(),
            is_draft: o.get("isDraft") == Some(&Value::Bool(true)),
            review: review_de(o.get("reviewDecision")),
            ci: resumen.ci,
            checks: resumen.checks,
            url,
            ..TeamPr::default()
        };
        pr.author_name = texto_corto(a.get("name"), 100);
        if a.get("is_bot") == Some(&Value::Bool(true)) || login_crudo.ends_with("[bot]") || login_crudo.starts_with("app/") {
            pr.is_bot = Some(true);
        }
        if !resumen.failing.is_empty() {
            pr.failing = Some(resumen.failing);
        }
        pr.updated_at = tiempo(o.get("updatedAt")).filter(|t| *t != 0);
        pr.created_at = tiempo(o.get("createdAt")).filter(|t| *t != 0);
        out.push(pr);
    }
    Ok(out)
}

/// Agrupa PRs por login, sin distinguir mayúsculas, y deja cada grupo del más nuevo al más viejo.
pub fn agrupar_por_autor(prs: &[TeamPr]) -> Vec<(String, Vec<TeamPr>)> {
    let mut grupos: Vec<(String, Vec<TeamPr>)> = Vec::new();
    for p in prs {
        let k = p.login.to_lowercase();
        match grupos.iter_mut().find(|(c, _)| *c == k) {
            Some((_, l)) => l.push(p.clone()),
            None => grupos.push((k, vec![p.clone()])),
        }
    }
    for (_, l) in &mut grupos {
        l.sort_by(|a, b| b.updated_at.unwrap_or(0).cmp(&a.updated_at.unwrap_or(0)));
    }
    grupos
}

// ---------- identidades ----------

pub fn normalizar_nombre(s: &str) -> String {
    let sin_tildes: String = s.to_lowercase().nfd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect();
    let mut out = String::new();
    let mut separador = false;
    for c in sin_tildes.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if separador && !out.is_empty() {
                out.push(' ');
            }
            separador = false;
            out.push(c);
        } else {
            separador = true;
        }
    }
    out
}

fn palabras(s: &str) -> Vec<String> {
    normalizar_nombre(s).split(' ').filter(|t| t.chars().count() > 1).map(String::from).collect()
}

/// ¿Este autor de GitHub (login + nombre) parece esta persona del conector?
pub fn se_parece(login: &str, nombre_gh: Option<&str>, nombre: &str) -> bool {
    let g = palabras(nombre);
    if g.is_empty() {
        return false;
    }
    if let Some(nombre_gh) = nombre_gh.filter(|n| !n.is_empty()) {
        let h = palabras(nombre_gh);
        if !h.is_empty() && normalizar_nombre(nombre_gh) == normalizar_nombre(nombre) {
            return true;
        }
        // «Tomás Muñoz» ↔ «Tomás Ignacio Muñoz»: todas las palabras del más corto están en el otro (2 o más).
        let (corto, largo) = if h.len() <= g.len() { (&h, &g) } else { (&g, &h) };
        if corto.len() >= 2 && corto.iter().all(|t| largo.contains(t)) {
            return true;
        }
        // Mismo nombre y mismo apellido final.
        if h.len() >= 2 && g.len() >= 2 && h[0] == g[0] && h.last() == g.last() {
            return true;
        }
    }
    // Login armado con el nombre: tomasmunoz, tmunoz, tomas-munoz, munoztomas.
    let minuscula = login.to_lowercase();
    let sin_bot = minuscula.strip_suffix("[bot]").unwrap_or(&minuscula);
    let l: String = sin_bot.chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect();
    if g.len() >= 2 && l.len() >= 4 {
        let primero = &g[0];
        let ultimo = &g[g.len() - 1];
        let inicial = |s: &str| s.chars().next().map(String::from).unwrap_or_default();
        let opciones = [format!("{primero}{ultimo}"), format!("{}{ultimo}", inicial(primero)), format!("{ultimo}{primero}"), format!("{primero}{}", inicial(ultimo))];
        if opciones.iter().any(|o| o.len() >= 4 && l.starts_with(o.as_str())) {
            return true;
        }
    }
    false
}

/// La `g` queda por compatibilidad: así siguen valiendo los mapeos guardados.
pub fn clave_de_persona(p: &PersonaConector) -> String {
    match p.id.as_deref().filter(|i| !i.is_empty()) {
        Some(id) => format!("g:{id}"),
        None => format!("n:{}", normalizar_nombre(&p.nombre)),
    }
}

fn no_vacio(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|s| !s.is_empty())
}

pub fn categoria_de(clave: Option<&str>, estados: &[Estado]) -> Categoria {
    clave.and_then(|c| estados.iter().find(|e| e.clave == c)).map_or(Categoria::Pendiente, |e| e.categoria)
}

/// Los tickets en curso, en revisión o bloqueados, con el nombre y la categoría de su estado.
pub fn tickets_activos(tickets: &[Ticket], estados: &[Estado]) -> Vec<TeamTicket> {
    // Un conector sin estados activos (gh: abierto/cerrado) no dice quién está trabajando: vale lo abierto que tiene responsable.
    let sin_activos = !estados.iter().any(|e| CategoriaActiva::de(e.categoria).is_some());
    let mut out = Vec::new();
    for t in tickets {
        let c = categoria_de(t.estado.as_deref(), estados);
        let categoria = match CategoriaActiva::de(c) {
            Some(a) => a,
            None if sin_activos && c != Categoria::Hecho && no_vacio(&t.responsable).is_some() => CategoriaActiva::EnCurso,
            None => continue,
        };
        let clave = t.estado.clone().unwrap_or_default();
        out.push(TeamTicket {
            id: t.id.clone(),
            titulo: t.titulo.clone(),
            estado_nombre: estados.iter().find(|e| e.clave == clave).map_or_else(|| clave.clone(), |e| e.nombre.clone()),
            estado: clave,
            categoria,
            responsable: no_vacio(&t.responsable).map(String::from),
            responsable_id: no_vacio(&t.responsable_id).map(String::from),
            proyecto: no_vacio(&t.proyecto).map(String::from),
            url: no_vacio(&t.url).map(String::from),
        });
    }
    out
}

/// Las personas responsables de esos tickets, sin repetir (por id o por nombre).
pub fn personas_de(tickets: &[TeamTicket]) -> Vec<PersonaConector> {
    let mut out = Vec::new();
    let mut vistos: Vec<String> = Vec::new();
    for t in tickets {
        let nombre = t.responsable.as_deref().map(str::trim).unwrap_or("");
        let id = t.responsable_id.as_deref().filter(|i| !i.is_empty());
        if nombre.is_empty() && id.is_none() {
            continue;
        }
        let mut claves = Vec::new();
        if let Some(id) = id {
            claves.push(format!("g:{id}"));
        }
        if !nombre.is_empty() {
            claves.push(format!("n:{}", normalizar_nombre(nombre)));
        }
        if claves.iter().any(|k| vistos.contains(k)) {
            continue;
        }
        vistos.extend(claves);
        out.push(PersonaConector { id: id.map(String::from), nombre: nombre.to_string() });
    }
    out
}

/// Las personas elegidas en el filtro de Tickets, con su nombre, para que tengan tarjeta aunque todavía no tengan tickets activos.
pub fn personas_elegidas_equipo(ids: &[String], personas: Option<&[(String, String)]>) -> Vec<PersonaConector> {
    ids.iter()
        .filter_map(|id| personas?.iter().find(|(i, _)| i == id))
        .map(|(id, nombre)| PersonaConector { id: Some(id.clone()), nombre: recortar_utf16(nombre, 80) })
        .collect()
}

pub struct EntradaPersonas<'a> {
    pub prs: &'a [TeamPr],
    pub tickets: &'a [TeamTicket],
    pub personas: &'a [PersonaConector],
    pub mapping: &'a Mapeo,
}

pub struct VistaEquipo {
    pub people: Vec<Person>,
    pub summary: Summary,
    pub unassigned: Vec<TeamTicket>,
}

struct Personas {
    lista: Vec<Person>,
    por_clave: HashMap<String, usize>,
    por_nombre: HashMap<String, usize>,
}

impl Personas {
    fn agregar(&mut self, p: &PersonaConector) -> Option<usize> {
        let id = p.id.as_deref().filter(|i| !i.is_empty());
        if p.nombre.is_empty() && id.is_none() {
            return None;
        }
        let norm = normalizar_nombre(&p.nombre);
        // Si ya existe (por id o por nombre), es la misma.
        let existente = id.and_then(|i| self.por_clave.get(&format!("g:{i}"))).or_else(|| if norm.is_empty() { None } else { self.por_nombre.get(&norm) }).copied();
        if let Some(i) = existente {
            let e = &mut self.lista[i];
            if let Some(id) = id {
                if no_vacio(&e.id_conector).is_none() {
                    e.id_conector = Some(id.to_string());
                }
            }
            return Some(i);
        }
        let key = clave_de_persona(p);
        let nombre = if p.nombre.is_empty() { id.unwrap_or_default().to_string() } else { p.nombre.clone() };
        let persona = Person { key: key.clone(), nombre, logins: vec![], id_conector: id.map(String::from), en_conector: true, is_bot: None, matched_by: None, tickets: vec![], prs: vec![] };
        let i = self.lista.len();
        self.lista.push(persona);
        self.por_clave.insert(key.clone(), i);
        if !norm.is_empty() {
            self.por_nombre.insert(norm, i);
        }
        Some(i)
    }
}

/// Arma las tarjetas: una por persona del conector (con sus tickets) y les suma los PRs de su login de GitHub (mapeo a
/// mano primero; si no, por nombre cuando hay un solo candidato). Los autores de GitHub sin pareja quedan como tarjeta propia.
pub fn armar_personas(entrada: &EntradaPersonas) -> VistaEquipo {
    let mut ps = Personas { lista: vec![], por_clave: HashMap::new(), por_nombre: HashMap::new() };
    for p in entrada.personas {
        ps.agregar(p);
    }
    let mut sin_asignar = Vec::new();
    for t in entrada.tickets {
        if no_vacio(&t.responsable).is_none() && no_vacio(&t.responsable_id).is_none() {
            sin_asignar.push(t.clone());
            continue;
        }
        let persona = PersonaConector { id: t.responsable_id.clone(), nombre: t.responsable.clone().unwrap_or_default() };
        match ps.agregar(&persona) {
            Some(i) => ps.lista[i].tickets.push(t.clone()),
            None => sin_asignar.push(t.clone()),
        }
    }

    let del_conector: Vec<usize> = (0..ps.lista.len()).collect();
    // Claves de mapeo en minúscula (los logins de GitHub no distinguen mayúsculas).
    let mut mapeo: HashMap<String, &str> = HashMap::new();
    for (k, v) in entrada.mapping.iter() {
        mapeo.insert(k.to_lowercase(), v);
    }
    for (minuscula, prs) in agrupar_por_autor(entrada.prs) {
        let login = prs[0].login.clone();
        let nombre_gh = prs[0].author_name.clone();
        let es_bot = prs[0].is_bot == Some(true);
        let manual = mapeo.get(&minuscula).copied().filter(|m| !m.is_empty());
        let mut destino: Option<usize> = None;
        let mut como: Option<Cruce> = None;
        if let Some(m) = manual.filter(|m| *m != NADIE && ps.por_clave.contains_key(*m)) {
            destino = ps.por_clave.get(m).copied();
            como = Some(Cruce::Manual);
        } else if manual.is_none() && !es_bot {
            // Con GitHub como conector el id de la persona ES el login: no hace falta adivinar por nombre.
            let mismo_login = del_conector.iter().copied().find(|&i| ps.lista[i].id_conector.as_deref().map(str::to_lowercase).as_deref() == Some(minuscula.as_str()));
            let candidatos: Vec<usize> = match mismo_login {
                Some(i) => vec![i],
                None => del_conector.iter().copied().filter(|&i| se_parece(&login, nombre_gh.as_deref(), &ps.lista[i].nombre)).collect(),
            };
            if candidatos.len() == 1 {
                destino = Some(candidatos[0]);
                como = Some(Cruce::Auto);
            }
        }
        let i = match destino {
            Some(i) => {
                if let Some(c) = como {
                    if ps.lista[i].matched_by != Some(Cruce::Manual) {
                        ps.lista[i].matched_by = Some(c);
                    }
                }
                i
            }
            None => {
                let key = format!("gh:{minuscula}");
                let nombre = nombre_gh.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| login.clone());
                let nueva = Person { key: key.clone(), nombre, logins: vec![], id_conector: None, en_conector: false, is_bot: es_bot.then_some(true), matched_by: None, tickets: vec![], prs: vec![] };
                match ps.por_clave.get(&key) {
                    Some(&existente) => ps.lista[existente] = nueva,
                    None => {
                        ps.por_clave.insert(key, ps.lista.len());
                        ps.lista.push(nueva);
                    }
                }
                ps.por_clave[&format!("gh:{minuscula}")]
            }
        };
        ps.lista[i].logins.push(login);
        ps.lista[i].prs.extend(prs);
    }

    for p in &mut ps.lista {
        p.prs.sort_by(|a, b| b.updated_at.unwrap_or(0).cmp(&a.updated_at.unwrap_or(0)));
        p.tickets.sort_by(|a, b| a.categoria.orden().cmp(&b.categoria.orden()).then_with(|| comparar_es(&a.id, &b.id)));
    }
    let mut lista = ps.lista;
    lista.sort_by(|a, b| {
        let (ba, bb) = (a.is_bot == Some(true), b.is_bot == Some(true));
        if ba != bb {
            return if ba { Ordering::Greater } else { Ordering::Less };
        }
        let (wa, wb) = (a.tickets.len() + a.prs.len(), b.tickets.len() + b.prs.len());
        if (wa > 0) != (wb > 0) {
            return if wa > 0 { Ordering::Less } else { Ordering::Greater };
        }
        comparar_es(&a.nombre, &b.nombre)
    });
    VistaEquipo { people: lista, summary: resumir(entrada.prs, entrada.tickets), unassigned: sin_asignar }
}

pub fn resumir(prs: &[TeamPr], tickets: &[TeamTicket]) -> Summary {
    Summary {
        ci_failing: prs.iter().filter(|p| p.ci == EstadoCi::Fail).count(),
        waiting_review: prs.iter().filter(|p| !p.is_draft && p.review == EstadoReview::Pending).count(),
        blocked: tickets.iter().filter(|t| t.categoria == CategoriaActiva::Bloqueado).count(),
        prs: prs.len(),
        tickets: tickets.len(),
    }
}

/// Valida el mapeo guardado (por si se editó el JSON a mano).
pub fn limpiar_mapeo(raw: &Value) -> Mapeo {
    static R: OnceLock<Regex> = OnceLock::new();
    let prefijada = re(r"^(?:g|n):[^\n\r\u{2028}\u{2029}]", &R);
    let mut out = Mapeo::nuevo();
    let Some(o) = raw.as_object() else { return out };
    for (k, v) in o {
        let Some(v) = v.as_str().filter(|v| login_valido(k) && largo_utf16(v) <= 200) else { continue };
        if v == NADIE || prefijada.is_match(v) {
            out.insertar(&k.to_lowercase(), v);
        }
        if out.len() >= 500 {
            break;
        }
    }
    out
}

/// Comparación de textos como `localeCompare(…, 'es')`: sin distinguir mayúsculas ni tildes al principio, con la ñ como
/// letra propia después de la n; recién si no alcanza decide la tilde y después la mayúscula (la minúscula va primero).
pub fn comparar_es(a: &str, b: &str) -> Ordering {
    fn primaria(c: char) -> (u8, u32) {
        let base: String = c.to_lowercase().nfd().collect();
        let mut it = base.chars();
        let letra = it.next().unwrap_or(c);
        let tilde_de_enie = letra == 'n' && it.next() == Some('\u{303}');
        if tilde_de_enie {
            (4, u32::from('n') * 2 + 1)
        } else if letra.is_alphabetic() {
            (4, u32::from(letra) * 2)
        } else if letra.is_ascii_digit() {
            (3, u32::from(letra))
        } else if letra.is_whitespace() {
            (0, u32::from(letra))
        } else if letra.is_ascii_punctuation() && !"$+<=>^`|~".contains(letra) {
            (1, u32::from(letra))
        } else {
            (2, u32::from(letra))
        }
    }
    let pa: Vec<_> = a.chars().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).map(primaria).collect();
    let pb: Vec<_> = b.chars().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).map(primaria).collect();
    pa.cmp(&pb)
        .then_with(|| {
            let acentos = |s: &str| s.to_lowercase().nfd().filter(|c| ('\u{300}'..='\u{36f}').contains(c)).collect::<Vec<_>>();
            acentos(a).cmp(&acentos(b))
        })
        .then_with(|| {
            let mayusculas = |s: &str| s.chars().map(|c| c.is_uppercase()).collect::<Vec<_>>();
            mayusculas(a).cmp(&mayusculas(b))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn t(id: &str, estado: Option<&str>, responsable: Option<&str>, responsable_id: Option<&str>) -> Ticket {
        Ticket { id: id.into(), titulo: format!("Ticket {id}"), estado: estado.map(String::from), responsable: responsable.map(String::from), responsable_id: responsable_id.map(String::from), ..Ticket::default() }
    }

    fn est(clave: &str, nombre: &str, categoria: Categoria) -> Estado {
        Estado { clave: clave.into(), nombre: nombre.into(), categoria }
    }

    fn estados_gruv() -> Vec<Estado> {
        vec![
            est("abierto", "Abierto", Categoria::Pendiente),
            est("en_curso", "En curso", Categoria::EnCurso),
            est("bloqueado", "Bloqueado", Categoria::Bloqueado),
            est("en_revision", "En revisión", Categoria::Revision),
            est("pre_rtd", "Pre RTD", Categoria::Revision),
            est("en_qa", "En QA", Categoria::Revision),
            est("rechazado", "Rechazado", Categoria::Bloqueado),
            est("cerrado", "Cerrado", Categoria::Hecho),
        ]
    }

    fn estados_gh() -> Vec<Estado> {
        vec![est("abierto", "Abierto", Categoria::Pendiente), est("cerrado", "Cerrado", Categoria::Hecho)]
    }

    #[test]
    fn tickets_activos_con_los_estados_de_gruv_entran_en_curso_revision_y_bloqueado() {
        let tickets: Vec<Ticket> = ["abierto", "en_curso", "en_revision", "pre_rtd", "en_qa", "bloqueado", "cerrado"].iter().enumerate().map(|(i, e)| t(&format!("TCK-{}", i + 1), Some(e), Some("Ana"), None)).collect();
        let activos = tickets_activos(&tickets, &estados_gruv());
        let vista: Vec<_> = activos.iter().map(|x| (x.estado.as_str(), x.categoria, x.estado_nombre.as_str())).collect();
        assert_eq!(
            vista,
            vec![
                ("en_curso", CategoriaActiva::EnCurso, "En curso"),
                ("en_revision", CategoriaActiva::Revision, "En revisión"),
                ("pre_rtd", CategoriaActiva::Revision, "Pre RTD"),
                ("en_qa", CategoriaActiva::Revision, "En QA"),
                ("bloqueado", CategoriaActiva::Bloqueado, "Bloqueado"),
            ]
        );
    }

    #[test]
    fn tickets_activos_sin_estados_activos_entra_lo_abierto_con_responsable_como_en_curso() {
        let activos = tickets_activos(&[t("12", Some("abierto"), Some("ana"), None), t("13", Some("abierto"), None, None), t("14", Some("cerrado"), Some("ana"), None)], &estados_gh());
        let vista: Vec<_> = activos.iter().map(|x| (x.id.as_str(), x.categoria, x.estado_nombre.as_str())).collect();
        assert_eq!(vista, vec![("12", CategoriaActiva::EnCurso, "Abierto")]);
    }

    #[test]
    fn tickets_activos_usa_la_clave_como_nombre_si_no_hay_lista_de_estados() {
        let activos = tickets_activos(&[t("TCK-2", Some("abierto"), Some("Ana"), None)], &[]);
        assert_eq!(activos.len(), 1);
        assert_eq!(activos[0].estado_nombre, "abierto");
        assert_eq!(activos[0].categoria, CategoriaActiva::EnCurso);
    }

    #[test]
    fn personas_de_no_repite_personas_por_id_ni_por_nombre() {
        let activos = tickets_activos(
            &[t("TCK-1", Some("en_curso"), Some("Ana Pérez"), Some("12")), t("TCK-2", Some("en_qa"), Some("Ana Pérez"), Some("12")), t("TCK-3", Some("bloqueado"), Some("Beto"), None), t("TCK-4", Some("en_curso"), Some("beto "), None)],
            &estados_gruv(),
        );
        assert_eq!(personas_de(&activos), vec![PersonaConector { id: Some("12".into()), nombre: "Ana Pérez".into() }, PersonaConector { id: None, nombre: "Beto".into() }]);
    }

    fn pr_base(login: &str, numero: u64) -> TeamPr {
        TeamPr {
            repo: "org/app".into(),
            number: numero,
            title: "Algo".into(),
            login: login.into(),
            branch: "b".into(),
            review: EstadoReview::Pending,
            ci: EstadoCi::Pass,
            checks: ConteoCi { pass: 1, fail: 0, running: 0 },
            url: format!("https://github.com/org/app/pull/{numero}"),
            ..TeamPr::default()
        }
    }

    fn vista(prs: &[TeamPr], tickets: &[TeamTicket], personas: &[PersonaConector], mapping: &Mapeo) -> VistaEquipo {
        armar_personas(&EntradaPersonas { prs, tickets, personas, mapping })
    }

    #[test]
    fn un_mapeo_g_12_guardado_se_aplica_a_la_persona_con_responsable_id_12() {
        let pr = pr_base("zz-otro", 1);
        let tickets = tickets_activos(&[t("TCK-1", Some("en_curso"), Some("Ana Pérez"), Some("12"))], &estados_gruv());
        let v = vista(&[pr], &tickets, &personas_de(&tickets), &Mapeo::desde(&[("zz-otro", "g:12")]));
        let ana = v.people.iter().find(|p| p.key == "g:12").unwrap();
        assert_eq!(ana.matched_by, Some(Cruce::Manual));
        assert_eq!(ana.id_conector.as_deref(), Some("12"));
        assert_eq!(ana.logins, vec!["zz-otro"]);
    }

    #[test]
    fn con_github_como_conector_el_pr_del_mismo_login_cae_en_la_tarjeta_del_ticket() {
        let mut pr = pr_base("TomyMG", 5);
        pr.author_name = Some("Tomas Munoz".into());
        let tickets = tickets_activos(&[t("12", Some("abierto"), Some("tomymg"), Some("tomymg"))], &estados_gh());
        let v = vista(&[pr], &tickets, &personas_de(&tickets), &Mapeo::nuevo());
        assert_eq!(v.people.len(), 1);
        assert_eq!(v.people[0].tickets.len(), 1);
        assert_eq!(v.people[0].prs.len(), 1);
        assert_eq!(v.people[0].matched_by, Some(Cruce::Auto));
    }

    #[test]
    fn tickets_activos_descarta_un_estado_que_no_esta_en_la_lista() {
        let activos = tickets_activos(&[t("TCK-1", Some("raro"), Some("Ana"), None)], &[est("en_curso", "En curso", Categoria::EnCurso)]);
        assert!(activos.is_empty());
    }

    #[test]
    fn personas_elegidas_equipo_da_tarjeta_a_las_elegidas_con_el_nombre_acotado() {
        let lista = vec![("u1".to_string(), "Mateo".to_string()), ("u2".to_string(), "L".repeat(200))];
        let ids = vec!["u2".to_string(), "u9".to_string(), "u1".to_string()];
        assert_eq!(
            personas_elegidas_equipo(&ids, Some(&lista)),
            vec![PersonaConector { id: Some("u2".into()), nombre: "L".repeat(80) }, PersonaConector { id: Some("u1".into()), nombre: "Mateo".into() }]
        );
        assert!(personas_elegidas_equipo(&["u1".to_string()], None).is_empty());
    }

    #[test]
    fn una_elegida_sin_tickets_tiene_tarjeta_y_se_une_con_la_que_ya_tiene_tickets() {
        let activos = tickets_activos(&[t("TCK-1", Some("en_curso"), Some("Ana"), Some("u1"))], &estados_gruv());
        let mut personas = personas_de(&activos);
        personas.extend(personas_elegidas_equipo(&["u1".into(), "u2".into()], Some(&[("u1".into(), "Ana".into()), ("u2".into(), "Mateo".into())])));
        let v = vista(&[], &activos, &personas, &Mapeo::nuevo());
        assert_eq!(v.people.iter().map(|p| (p.nombre.as_str(), p.tickets.len())).collect::<Vec<_>>(), vec![("Ana", 1), ("Mateo", 0)]);
    }

    #[test]
    fn remoto_de_github_reconoce_las_tres_formas_y_rechaza_el_resto() {
        for (url, esperado) in [
            ("https://github.com/o/r.git", Some("o/r")),
            ("https://token@github.com/o/r", Some("o/r")),
            ("git@github.com:o/r.git", Some("o/r")),
            ("ssh://git@github.com:22/o/r", Some("o/r")),
            ("https://gitlab.com/o/r", None),
            ("https://github.com/o/r;rm", None),
            ("", None),
        ] {
            assert_eq!(remoto_de_github(Some(url)).as_deref(), esperado, "{url}");
        }
        assert_eq!(remoto_de_github(None), None);
    }

    #[test]
    fn resumir_checks_cuenta_check_runs_y_status_contexts_y_toma_la_ultima_corrida() {
        let r = resumir_checks(&json!([
            { "__typename": "CheckRun", "workflowName": "CI", "name": "test", "status": "COMPLETED", "conclusion": "FAILURE", "completedAt": "2026-11-16T10:00:00Z" },
            { "__typename": "CheckRun", "workflowName": "CI", "name": "test", "status": "COMPLETED", "conclusion": "SUCCESS", "completedAt": "2026-11-16T11:00:00Z" },
            { "__typename": "CheckRun", "name": "lint", "status": "IN_PROGRESS" },
            { "__typename": "CheckRun", "name": "docs", "status": "COMPLETED", "conclusion": "SKIPPED" },
            { "__typename": "StatusContext", "context": "vercel", "state": "SUCCESS" }
        ]));
        assert_eq!(r.checks, ConteoCi { pass: 2, fail: 0, running: 1 });
        assert_eq!(r.ci, EstadoCi::Running);
        assert!(r.failing.is_empty());
    }

    #[test]
    fn resumir_checks_una_corrida_vieja_no_pisa_a_la_nueva_y_los_fallos_se_nombran() {
        let r = resumir_checks(&json!([
            { "name": "a", "status": "COMPLETED", "conclusion": "SUCCESS", "completedAt": "2026-11-16T12:00:00Z" },
            { "name": "a", "status": "COMPLETED", "conclusion": "FAILURE", "completedAt": "2026-11-16T10:00:00Z" },
            { "workflowName": "CI", "name": "b", "status": "COMPLETED", "conclusion": "STALE" },
            { "__typename": "StatusContext", "state": "ERROR" }
        ]));
        assert_eq!(r.ci, EstadoCi::Fail);
        assert_eq!(r.checks, ConteoCi { pass: 1, fail: 2, running: 0 });
        assert_eq!(r.failing, vec!["CI / b", "status-3"]);
    }

    #[test]
    fn resumir_checks_todo_omitido_es_pass_y_sin_lista_es_none() {
        assert_eq!(resumir_checks(&json!([{ "name": "x", "status": "COMPLETED", "conclusion": "NEUTRAL" }])).ci, EstadoCi::Pass);
        assert_eq!(resumir_checks(&json!([])).ci, EstadoCi::None);
        assert_eq!(resumir_checks(&json!(null)).ci, EstadoCi::None);
        assert_eq!(resumir_checks(&json!([null, 3, "x"])).ci, EstadoCi::None);
    }

    #[test]
    fn el_review_se_lee_sin_importar_mayusculas_y_lo_raro_queda_pendiente() {
        assert_eq!(review_de(Some(&json!("approved"))), EstadoReview::Approved);
        assert_eq!(review_de(Some(&json!("CHANGES_REQUESTED"))), EstadoReview::Changes);
        assert_eq!(review_de(Some(&json!("REVIEW_REQUIRED"))), EstadoReview::Pending);
        assert_eq!(review_de(None), EstadoReview::Pending);
    }

    #[test]
    fn parsear_lista_de_prs_arma_filas_y_descarta_lo_que_no_es_de_github() {
        let salida = json!([
            { "number": 7, "title": "  Arreglo\n  grande ", "author": { "login": "ana", "name": "Ana Pérez" }, "headRefName": "fix/a", "isDraft": true,
              "reviewDecision": "APPROVED", "statusCheckRollup": [{ "name": "t", "status": "COMPLETED", "conclusion": "FAILURE" }],
              "updatedAt": "2026-11-16T10:00:00Z", "createdAt": "2026-11-15T10:00:00.500Z", "url": "https://github.com/org/app/pull/7" },
            { "number": 8, "url": "https://evil.example/org/app/pull/8" },
            { "number": 0, "url": "https://github.com/org/app/pull/0" },
            { "number": 9, "author": { "login": "dependabot[bot]" }, "url": "https://github.com/org/app/pull/9" },
            { "number": 10, "author": { "login": "-raro" }, "url": "https://github.com/org/app/pull/10" },
            { "number": 11, "author": null, "url": "https://github.com/org/app/pull/11" },
            "basura"
        ]);
        let prs = parsear_prs(&salida, "org/app").unwrap();
        assert_eq!(prs.iter().map(|p| p.number).collect::<Vec<_>>(), vec![7, 9, 10, 11]);
        let a = &prs[0];
        assert_eq!((a.title.as_str(), a.login.as_str(), a.author_name.as_deref(), a.branch.as_str()), ("Arreglo grande", "ana", Some("Ana Pérez"), "fix/a"));
        assert!(a.is_draft);
        assert_eq!((a.review, a.ci), (EstadoReview::Approved, EstadoCi::Fail));
        assert_eq!(a.failing, Some(vec!["t".to_string()]));
        assert_eq!(a.updated_at, Some(1_794_823_200_000));
        assert_eq!(a.created_at, Some(1_794_823_200_000 - 24 * 3_600_000 + 500));
        let bot = &prs[1];
        assert_eq!((bot.login.as_str(), bot.is_bot, bot.title.as_str(), bot.branch.as_str()), ("dependabot[bot]", Some(true), "#9", ""));
        assert_eq!(prs[2].login, "ghost");
        assert_eq!(prs[3].login, "ghost");
        assert_eq!(prs[3].is_bot, None);
    }

    #[test]
    fn parsear_lista_de_prs_acepta_vacio_y_rechaza_lo_que_no_es_lista() {
        assert_eq!(parsear_lista_de_prs("  \n", "o/r").unwrap(), vec![]);
        assert_eq!(parsear_lista_de_prs("{}", "o/r").unwrap_err(), "gh no devolvió una lista de PRs.");
        assert!(parsear_lista_de_prs("{no", "o/r").is_err());
    }

    #[test]
    fn el_pr_se_serializa_con_el_orden_de_claves_del_ts_y_conserva_lo_que_no_conoce() {
        let salida = json!([{ "number": 7, "author": { "login": "ana", "name": "Ana" }, "url": "https://github.com/org/app/pull/7", "updatedAt": "2026-11-16T10:00:00Z" }]);
        let pr = parsear_prs(&salida, "org/app").unwrap().remove(0);
        let v = serde_json::to_value(&pr).unwrap();
        assert_eq!(v.as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(), ["repo", "number", "title", "login", "branch", "isDraft", "review", "ci", "checks", "url", "authorName", "updatedAt"]);
        let con_extra: TeamPr = serde_json::from_value(json!({ "url": "https://github.com/o/r/pull/1", "campoNuevo": { "a": 1 } })).unwrap();
        assert_eq!(serde_json::to_value(&con_extra).unwrap()["campoNuevo"], json!({ "a": 1 }));
    }

    #[test]
    fn fecha_ms_lee_iso_y_rechaza_lo_demas() {
        assert_eq!(fecha_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(fecha_ms("2026-11-16T10:00:00Z"), Some(1_794_823_200_000));
        assert_eq!(fecha_ms("2026-11-16T10:00:00.5+02:00"), Some(1_794_823_200_000 - 2 * 3_600_000 + 500));
        assert_eq!(fecha_ms("2026-11-16"), Some(1_794_823_200_000 - 10 * 3_600_000));
        assert_eq!(fecha_ms("2026-13-16"), None);
        assert_eq!(fecha_ms("ayer"), None);
        assert_eq!(fecha_ms(""), None);
    }

    #[test]
    fn agrupar_por_autor_une_mayusculas_y_ordena_del_mas_nuevo_al_mas_viejo() {
        let mut a = pr_base("Ana", 1);
        a.updated_at = Some(10);
        let mut b = pr_base("ana", 2);
        b.updated_at = Some(30);
        let mut c = pr_base("ana", 3);
        c.updated_at = Some(20);
        let g = agrupar_por_autor(&[a, pr_base("beto", 4), b, c]);
        assert_eq!(g.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), vec!["ana", "beto"]);
        assert_eq!(g[0].1.iter().map(|p| p.number).collect::<Vec<_>>(), vec![2, 3, 1]);
    }

    #[test]
    fn normalizar_nombre_saca_tildes_y_signos() {
        assert_eq!(normalizar_nombre("  Tomás  Muñoz-Pérez! "), "tomas munoz perez");
        assert_eq!(normalizar_nombre("---"), "");
    }

    #[test]
    fn se_parece_por_nombre_y_por_login() {
        assert!(se_parece("x", Some("Tomás Muñoz"), "Tomas Munoz"));
        assert!(se_parece("x", Some("Tomás Muñoz"), "Tomás Ignacio Muñoz"));
        assert!(se_parece("x", Some("Tomás Ignacio Muñoz"), "Tomás Muñoz"));
        assert!(se_parece("x", Some("Tomás A Muñoz"), "Tomás B Muñoz"));
        assert!(!se_parece("x", Some("Tomás Pérez"), "Ana Pérez"));
        assert!(se_parece("tomasmunoz", None, "Tomás Muñoz"));
        assert!(se_parece("tmunoz", None, "Tomás Muñoz"));
        assert!(se_parece("munoz-tomas", None, "Tomás Muñoz"));
        assert!(se_parece("TomasM[bot]", None, "Tomás Muñoz"));
        assert!(!se_parece("tomas", None, "Tomás Muñoz"));
        assert!(!se_parece("ana", None, "Ana"));
        assert!(!se_parece("tmunoz", None, ""));
    }

    #[test]
    fn el_cruce_por_nombre_solo_vale_con_un_candidato() {
        let personas = vec![PersonaConector { id: Some("1".into()), nombre: "Tomás Muñoz".into() }, PersonaConector { id: Some("2".into()), nombre: "Tomás Ignacio Muñoz".into() }];
        let mut pr = pr_base("zz", 1);
        pr.author_name = Some("Tomás Muñoz".into());
        let v = vista(&[pr], &[], &personas, &Mapeo::nuevo());
        let gh = v.people.iter().find(|p| p.key == "gh:zz");
        assert!(gh.is_some_and(|p| !p.en_conector && p.nombre == "Tomás Muñoz"));
        assert!(v.people.iter().all(|p| p.matched_by.is_none()));
    }

    #[test]
    fn el_mapeo_nadie_o_a_una_persona_inexistente_deja_al_autor_solo_y_no_adivina() {
        let personas = vec![PersonaConector { id: Some("1".into()), nombre: "Ana Pérez".into() }];
        let mut pr = pr_base("anaperez", 1);
        pr.author_name = Some("Ana Pérez".into());
        for m in [Mapeo::desde(&[("anaperez", "-")]), Mapeo::desde(&[("anaperez", "g:999")])] {
            let v = vista(&[pr.clone()], &[], &personas, &m);
            assert_eq!(v.people.len(), 2);
            assert!(v.people.iter().any(|p| p.key == "gh:anaperez"));
        }
    }

    #[test]
    fn los_bots_no_se_cruzan_por_nombre_y_quedan_al_final() {
        let personas = vec![PersonaConector { id: Some("1".into()), nombre: "Dependabot Bot".into() }];
        let mut bot = pr_base("dependabot[bot]", 1);
        bot.is_bot = Some(true);
        bot.author_name = Some("Dependabot Bot".into());
        let v = vista(&[bot, pr_base("zeta", 2)], &[], &personas, &Mapeo::nuevo());
        assert_eq!(v.people.iter().map(|p| p.key.as_str()).collect::<Vec<_>>(), vec!["gh:zeta", "g:1", "gh:dependabot[bot]"]);
        assert_eq!(v.people[2].is_bot, Some(true));
        assert_eq!(v.summary, Summary { ci_failing: 0, waiting_review: 2, blocked: 0, prs: 2, tickets: 0 });
    }

    #[test]
    fn las_personas_sin_nada_van_despues_y_se_ordenan_por_nombre_en_castellano() {
        let personas: Vec<PersonaConector> = ["Óscar", "Ñandú", "Nora", "Zoe", "ana"].iter().map(|n| PersonaConector { id: None, nombre: (*n).into() }).collect();
        let tickets = tickets_activos(&[t("T-1", Some("en_curso"), Some("Zoe"), None)], &estados_gruv());
        let v = vista(&[], &tickets, &personas, &Mapeo::nuevo());
        assert_eq!(v.people.iter().map(|p| p.nombre.as_str()).collect::<Vec<_>>(), vec!["Zoe", "ana", "Nora", "Ñandú", "Óscar"]);
    }

    #[test]
    fn los_tickets_de_una_persona_van_por_categoria_y_despues_por_id() {
        let tickets = tickets_activos(
            &[t("B-2", Some("bloqueado"), Some("Ana"), None), t("A-1", Some("en_revision"), Some("Ana"), None), t("A-0", Some("en_curso"), Some("Ana"), None), t("A-2", Some("en_curso"), Some("Ana"), None)],
            &estados_gruv(),
        );
        let v = vista(&[], &tickets, &personas_de(&tickets), &Mapeo::nuevo());
        assert_eq!(v.people[0].tickets.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec!["A-0", "A-2", "A-1", "B-2"]);
        assert_eq!(v.summary.blocked, 1);
        assert_eq!(v.summary.tickets, 4);
    }

    #[test]
    fn los_tickets_sin_responsable_quedan_sin_asignar() {
        let tickets = tickets_activos(&[t("X-1", Some("en_curso"), None, None), t("X-2", Some("en_curso"), Some("Ana"), None)], &estados_gruv());
        let v = vista(&[], &tickets, &[], &Mapeo::nuevo());
        assert_eq!(v.unassigned.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec!["X-1"]);
        assert_eq!(v.people.len(), 1);
    }

    #[test]
    fn limpiar_mapeo_filtra_logins_y_valores_invalidos_y_pasa_las_claves_a_minuscula() {
        let m = limpiar_mapeo(&json!({ "Ana": "g:12", "beto": "n:beto perez", "-malo": "g:1", "cris": "x", "dani": "-", "eli": 4, "fer": "g:", "gus": "g:\n" }));
        assert_eq!(m, Mapeo::desde(&[("ana", "g:12"), ("beto", "n:beto perez"), ("dani", "-")]));
        assert!(limpiar_mapeo(&json!([1])).is_empty());
        assert!(limpiar_mapeo(&json!(null)).is_empty());
        assert!(limpiar_mapeo(&json!({ "ana": format!("g:{}", "x".repeat(300)) })).is_empty());
    }

    #[test]
    fn limpiar_mapeo_corta_en_500() {
        let grande: Map<String, Value> = (0..600).map(|i| (format!("u{i}"), json!("-"))).collect();
        assert_eq!(limpiar_mapeo(&Value::Object(grande)).len(), 500);
    }

    #[test]
    fn el_mapeo_ordena_las_claves_numericas_primero_como_un_objeto_de_javascript() {
        let m = Mapeo::desde(&[("ana", "-"), ("20", "-"), ("007", "-"), ("3", "-")]);
        assert_eq!(m.iter().map(|(k, _)| k).collect::<Vec<_>>(), vec!["3", "20", "ana", "007"]);
        assert_eq!(m.a_valor().as_object().unwrap().keys().next().map(String::as_str), Some("3"));
    }

    #[test]
    fn comparar_es_ignora_mayusculas_y_tildes_primero() {
        assert_eq!(comparar_es("ana", "Ana"), Ordering::Less);
        assert_eq!(comparar_es("Ana", "beto"), Ordering::Less);
        assert_eq!(comparar_es("Álvaro", "Beto"), Ordering::Less);
        assert_eq!(comparar_es("nz", "ñ"), Ordering::Less);
        assert_eq!(comparar_es("a", "á"), Ordering::Less);
        assert_eq!(comparar_es("x", "x"), Ordering::Equal);
        assert_eq!(comparar_es("TCK-2", "TCK-10"), Ordering::Greater);
    }

    #[test]
    fn recortar_utf16_cuenta_como_javascript() {
        assert_eq!(recortar_utf16("abcdef", 3), "abc");
        assert_eq!(recortar_utf16("a😀b", 2), "a");
        assert_eq!(recortar_utf16("a😀b", 3), "a😀");
        assert_eq!(largo_utf16("😀"), 2);
    }
}
