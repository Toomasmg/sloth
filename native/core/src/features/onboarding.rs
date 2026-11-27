//! Asistente de bienvenida: el estado de `onboarding.json`, los argumentos que llegan por IPC y el chequeo del entorno
//! (Claude Code, Node, git y gh). Equivale a src/main/features/onboarding.ts y onboarding-env.ts. Los procesos y el
//! sistema de archivos entran como closures: acá no se lanza nada.
use super::sleep::numero_js;
use crate::perfiles_core::es_blanco_js;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;

pub const STEPS: [&str; 4] = ["entorno", "cuentas", "repo", "espacio"];
const MAX_REPO: usize = 1000;

#[derive(Debug, Clone, PartialEq)]
pub struct EstadoOnboarding {
    pub completed: bool,
    pub skipped: bool,
    /// Índice del paso en el que quedó (0 a 3).
    pub step: usize,
    pub repo_path: Option<String>,
    pub updated_at: f64,
}

impl Default for EstadoOnboarding {
    fn default() -> Self {
        EstadoOnboarding { completed: false, skipped: false, step: 0, repo_path: None, updated_at: 0.0 }
    }
}

fn entero(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.fract() == 0.0)
}

fn numero_de(v: Option<&Value>) -> f64 {
    let n = match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => numero_js(s),
        Some(Value::Bool(true)) => 1.0,
        _ => 0.0,
    };
    if n.is_nan() {
        0.0
    } else {
        n
    }
}

impl EstadoOnboarding {
    /// Lee el archivo crudo (sin BOM). Si no es JSON, o lo que trae no sirve, queda el estado inicial.
    pub fn desde_texto(texto: &str) -> Self {
        let limpio = texto.strip_prefix('\u{feff}').unwrap_or(texto);
        let Ok(raw) = serde_json::from_str::<Value>(limpio) else { return Self::default() };
        let step = raw.get("step").and_then(entero).filter(|n| *n >= 0.0 && *n < STEPS.len() as f64).map_or(0, |n| n as usize);
        let repo_path = raw.get("repoPath").and_then(Value::as_str).filter(|p| p.encode_utf16().count() <= MAX_REPO).map(str::to_string);
        EstadoOnboarding {
            completed: raw.get("completed") == Some(&Value::Bool(true)),
            skipped: raw.get("skipped") == Some(&Value::Bool(true)),
            step,
            repo_path,
            updated_at: numero_de(raw.get("updatedAt")),
        }
    }

    /// El orden de las claves es el del archivo original; las ausentes (`skipped`, `repoPath`) no se escriben.
    pub fn a_json(&self) -> Value {
        let mut o = serde_json::Map::new();
        o.insert("version".into(), json!(1));
        o.insert("completed".into(), json!(self.completed));
        if self.skipped {
            o.insert("skipped".into(), json!(true));
        }
        o.insert("step".into(), json!(self.step));
        if let Some(p) = &self.repo_path {
            o.insert("repoPath".into(), json!(p));
        }
        o.insert("updatedAt".into(), json!(self.updated_at));
        Value::Object(o)
    }

    /// Lo que devuelve `feat:onboarding:state`. Se muestra solo la primera vez: sin cuentas y sin haberlo terminado o salteado.
    pub fn para_la_ui(&self, cuentas: usize, solo_lectura: bool) -> Value {
        let mut v = self.a_json();
        let o = v.as_object_mut().expect("a_json arma un objeto");
        o.insert("steps".into(), json!(STEPS));
        o.insert("show".into(), json!(!self.completed && cuentas == 0 && !solo_lectura));
        v
    }
}

pub fn es_absoluta_win32(p: &str) -> bool {
    let b = p.as_bytes();
    matches!(b.first(), Some(b'/' | b'\\')) || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'/' | b'\\'))
}

/// `checkRepoArg`: la carpeta tiene que ser un texto razonable, absoluta y existir.
pub fn validar_carpeta_repo(p: &Value, es_absoluta: impl Fn(&str) -> bool, es_dir: impl Fn(&str) -> bool) -> Result<String, String> {
    let s = p.as_str().filter(|s| !s.trim_matches(es_blanco_js).is_empty() && s.encode_utf16().count() <= MAX_REPO).ok_or("Elegí una carpeta.")?;
    let r = s.trim_matches(es_blanco_js);
    if !es_absoluta(r) || !es_dir(r) {
        return Err("Esa carpeta no existe.".into());
    }
    Ok(r.to_string())
}

/// Aplica el parche de `feat:onboarding:save`. Valida en el mismo orden que el original y corta en el primer error.
pub fn aplicar_parche(actual: &EstadoOnboarding, patch: &Value, ahora: f64, validar_repo: impl Fn(&Value) -> Result<String, String>) -> Result<EstadoOnboarding, String> {
    let p = patch.as_object().ok_or("Datos inválidos.")?;
    let mut next = EstadoOnboarding { updated_at: ahora, ..actual.clone() };
    if let Some(s) = p.get("step") {
        next.step = entero(s).filter(|n| *n >= 0.0 && *n < STEPS.len() as f64).map(|n| n as usize).ok_or("Paso inválido.")?;
    }
    if let Some(c) = p.get("completed") {
        next.completed = c.as_bool().ok_or("Datos inválidos.")?;
    }
    if let Some(s) = p.get("skipped") {
        next.skipped = s.as_bool().ok_or("Datos inválidos.")?;
    }
    if let Some(r) = p.get("repoPath") {
        next.repo_path = if r.is_null() { None } else { Some(validar_repo(r)?) };
    }
    Ok(next)
}

/// Sin repetir y en el orden en que aparecen.
pub fn rutas_unicas(rutas: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for r in rutas {
        if !out.contains(r) {
            out.push(r.clone());
        }
    }
    out
}

pub fn nombre_de_repo(repo: &str) -> String {
    repo.split(['\\', '/']).filter(|s| !s.is_empty()).next_back().unwrap_or(repo).to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EstadoCheck {
    Ok,
    Warn,
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum DocKey {
    #[serde(rename = "claude")]
    Claude,
    #[serde(rename = "node")]
    Node,
    #[serde(rename = "git")]
    Git,
    #[serde(rename = "gh")]
    Gh,
    #[serde(rename = "gh-auth")]
    GhAuth,
}

/// Docs oficiales: la UI manda la clave, nunca una URL.
pub fn url_de_doc(k: DocKey) -> &'static str {
    match k {
        DocKey::Claude => "https://docs.claude.com/en/docs/claude-code/setup",
        DocKey::Node => "https://nodejs.org/en/download",
        DocKey::Git => "https://git-scm.com/downloads/win",
        DocKey::Gh => "https://cli.github.com/",
        DocKey::GhAuth => "https://cli.github.com/manual/gh_auth_login",
    }
}

pub fn doc_desde_texto(k: &str) -> Option<DocKey> {
    Some(match k {
        "claude" => DocKey::Claude,
        "node" => DocKey::Node,
        "git" => DocKey::Git,
        "gh" => DocKey::Gh,
        "gh-auth" => DocKey::GhAuth,
        _ => return None,
    })
}

/// `feat:onboarding:openDoc`: la URL que se abre para una clave, o el error que ve la persona.
pub fn validar_doc(k: &Value) -> Result<&'static str, String> {
    let doc = k.as_str().and_then(doc_desde_texto).ok_or("Documento desconocido.")?;
    let url = url_de_doc(doc);
    if !url.starts_with("https://") {
        return Err("Link inválido.".into());
    }
    Ok(url)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Check {
    pub id: DocKey,
    pub label: String,
    pub state: EstadoCheck,
    /// Lo que encontramos (versión, ruta o cuenta).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Qué hacer si falta o está viejo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<String>,
    /// Comando sugerido para copiar.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    pub doc: DocKey,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub optional: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InformeEntorno {
    pub items: Vec<Check>,
    pub checked_at: f64,
}

#[derive(Debug, Clone, Default)]
pub struct Resultado {
    pub ok: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    /// ENOENT, timeout, etc.
    pub error: Option<String>,
}

pub type Ejecutor<'a> = &'a dyn Fn(&str, &[String], u64) -> Resultado;

pub struct OpcionesEntorno<'a> {
    pub path_env: &'a str,
    pub home: &'a str,
    pub app_data: &'a str,
    pub run: Ejecutor<'a>,
    pub timeout_ms: u64,
    pub es_archivo: &'a dyn Fn(&str) -> bool,
    pub ahora: f64,
}

fn unir(base: &str, partes: &[&str]) -> String {
    let mut p = PathBuf::from(base);
    for x in partes {
        p.push(x);
    }
    p.to_string_lossy().into_owned()
}

const DELIMITADOR: char = if cfg!(windows) { ';' } else { ':' };

fn exe(n: &str) -> Vec<String> {
    vec![if cfg!(windows) { format!("{n}.exe") } else { n.to_string() }]
}

/// Busca un ejecutable en el PATH a mano (así no dependemos de cómo resuelve cada shell).
pub fn buscar_en_path(nombres: &[String], path_env: &str, es_archivo: &dyn Fn(&str) -> bool) -> Option<String> {
    let dirs = path_env.split(DELIMITADOR).map(|d| {
        let d = d.trim_matches(es_blanco_js);
        let d = d.strip_prefix('"').unwrap_or(d);
        d.strip_suffix('"').unwrap_or(d).to_string()
    });
    for d in dirs.filter(|d| !d.is_empty()) {
        for n in nombres {
            let p = unir(&d, &[n]);
            if es_archivo(&p) {
                return Some(p);
            }
        }
    }
    None
}

fn primera_linea(s: &str) -> String {
    let t = s.trim_matches(es_blanco_js);
    let l = t.split('\n').next().unwrap_or("").trim_end_matches('\r').trim_matches(es_blanco_js);
    let mut unidades = 0;
    l.chars()
        .take_while(|c| {
            unidades += c.len_utf16();
            unidades <= 120
        })
        .collect()
}

/// «v20.11.1» → 20: el primer `\d+.\d+` del texto.
pub fn node_major(v: &str) -> Option<f64> {
    let b = v.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if !b[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j + 1 < b.len() && b[j] == b'.' && b[j + 1].is_ascii_digit() {
            return v[i..j].parse().ok();
        }
        i = j;
    }
    None
}

/// `(\d+\.\d+\.\d+)` en cualquier parte del texto.
fn buscar_version_triple(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let digitos = |desde: usize| b[desde..].iter().take_while(|c| c.is_ascii_digit()).count();
    for i in 0..b.len() {
        if i > 0 && b[i - 1].is_ascii_digit() {
            continue;
        }
        let mut j = i;
        let mut ok = true;
        for k in 0..3 {
            let n = digitos(j);
            if n == 0 {
                ok = false;
                break;
            }
            j += n;
            if k < 2 {
                if b.get(j) != Some(&b'.') {
                    ok = false;
                    break;
                }
                j += 1;
            }
        }
        if ok {
            return Some(s[i..j].to_string());
        }
    }
    None
}

/// `<prefijo>\s+([A-Za-z0-9-]{1,39})`: lo que sigue al primer prefijo que tenga un nombre detrás.
fn capturar_nombre(texto: &str, prefijo: &str) -> Option<String> {
    for (i, _) in texto.match_indices(prefijo) {
        let resto = &texto[i + prefijo.len()..];
        let sin_blancos = resto.trim_start_matches(es_blanco_js);
        if sin_blancos.len() == resto.len() {
            continue;
        }
        let nombre: String = sin_blancos.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-').take(39).collect();
        if !nombre.is_empty() {
            return Some(nombre);
        }
    }
    None
}

fn termina_en_npm(d: &str) -> bool {
    let s = d.strip_suffix(['\\', '/']).unwrap_or(d);
    let l = s.to_lowercase();
    l.ends_with("npm") && l.len() > 3 && matches!(l.as_bytes()[l.len() - 4], b'\\' | b'/')
}

#[derive(Debug, Clone, PartialEq)]
pub struct CandidatoClaude {
    pub file: String,
    pub args: Vec<String>,
    pub donde: String,
}

/// Dónde puede estar Claude Code: en el PATH, el instalador nativo (~/.local/bin) o el shim de npm.
pub fn candidatos_claude(path_env: &str, home: &str, app_data: &str, node: Option<&str>, es_archivo: &dyn Fn(&str) -> bool) -> Vec<CandidatoClaude> {
    let mut out = Vec::new();
    let en_path = buscar_en_path(&exe("claude"), path_env, es_archivo);
    let version = || vec!["--version".to_string()];
    if let Some(p) = &en_path {
        out.push(CandidatoClaude { file: p.clone(), args: version(), donde: p.clone() });
    }
    let nativo = unir(home, &[".local", "bin", if cfg!(windows) { "claude.exe" } else { "claude" }]);
    if es_archivo(&nativo) && Some(&nativo) != en_path.as_ref() {
        out.push(CandidatoClaude { file: nativo.clone(), args: version(), donde: nativo });
    }
    let mut npm_dirs = vec![unir(app_data, &["npm"])];
    npm_dirs.extend(path_env.split(DELIMITADOR).filter(|d| termina_en_npm(d)).map(str::to_string));
    for d in rutas_unicas(&npm_dirs) {
        let pkg = unir(&d, &["node_modules", "@anthropic-ai", "claude-code"]);
        // Versiones nuevas del paquete traen el binario nativo (bin/claude.exe); las viejas, cli.js.
        let bin = unir(&pkg, &["bin", if cfg!(windows) { "claude.exe" } else { "claude" }]);
        if es_archivo(&bin) {
            out.push(CandidatoClaude { file: bin, args: version(), donde: unir(&d, &["claude.cmd"]) });
            break;
        }
        let cli = unir(&pkg, &["cli.js"]);
        if let Some(n) = node.filter(|_| es_archivo(&cli)) {
            out.push(CandidatoClaude { file: n.to_string(), args: vec![cli, "--version".into()], donde: unir(&d, &["claude.cmd"]) });
            break;
        }
    }
    out
}

fn base(id: DocKey, label: &str, optional: bool) -> Check {
    Check { id, label: label.into(), state: EstadoCheck::Ok, detail: None, fix: None, command: None, doc: id, optional }
}

fn con(mut c: Check, state: EstadoCheck, detail: Option<&str>, fix: Option<&str>, command: Option<&str>) -> Check {
    c.state = state;
    c.detail = detail.map(str::to_string);
    c.fix = fix.map(str::to_string);
    c.command = command.map(str::to_string);
    c
}

const FIX_NODE: &str = "Sloth lo usa para mantener las terminales vivas aunque cierres la app. Sin Node las terminales andan igual, pero se cierran con Sloth. Instalá la versión LTS y reiniciá Sloth.";
const CMD_NODE: &str = "winget install OpenJS.NodeJS.LTS";
const FIX_GIT: &str = "Sin Git no hay ramas, cambios ni PRs en Sloth. Las terminales y los espacios andan igual. Instalalo si trabajás con repos de git y reiniciá Sloth.";
const CMD_GIT: &str = "winget install Git.Git";
const FIX_CLAUDE: &str = "Instalalo con el instalador oficial (en PowerShell) y reiniciá Sloth.";
const CMD_CLAUDE: &str = "irm https://claude.ai/install.ps1 | iex";
const CMD_GH: &str = "winget install GitHub.cli";

fn chequear_node(o: &OpcionesEntorno, ruta: Option<&str>) -> Check {
    let b = base(DocKey::Node, "Node.js 18 o más", true);
    let (fix, cmd) = (Some(FIX_NODE), Some(CMD_NODE));
    let Some(ruta) = ruta else { return con(b, EstadoCheck::Missing, None, fix, cmd) };
    let r = (o.run)(ruta, &["--version".to_string()], o.timeout_ms);
    let v = primera_linea(&r.stdout);
    let Some(major) = node_major(&v).filter(|_| r.ok) else {
        let d = if r.error.as_deref() == Some("timeout") { "No respondió a tiempo" } else { "No se pudo leer la versión" };
        return con(b, EstadoCheck::Warn, Some(d), fix, cmd);
    };
    if major < 18.0 {
        return con(b, EstadoCheck::Warn, Some(&format!("{v} (vieja)")), fix, cmd);
    }
    con(b, EstadoCheck::Ok, Some(&v), None, None)
}

fn sin_sufijo_claude_code(v: &str) -> String {
    let t = v.trim_end_matches(es_blanco_js);
    let l = t.to_lowercase();
    if l.ends_with("(claude code)") && l.len() == t.len() {
        t[..t.len() - "(claude code)".len()].trim_end_matches(es_blanco_js).to_string()
    } else {
        t.to_string()
    }
}

fn chequear_claude(o: &OpcionesEntorno, node: Option<&str>) -> Check {
    let b = base(DocKey::Claude, "Claude Code", false);
    let (fix, cmd) = (Some(FIX_CLAUDE), Some(CMD_CLAUDE));
    let cands = candidatos_claude(o.path_env, o.home, o.app_data, node, o.es_archivo);
    if cands.is_empty() {
        return con(b, EstadoCheck::Missing, None, fix, cmd);
    }
    for c in &cands {
        let r = (o.run)(&c.file, &c.args, o.timeout_ms);
        let v = primera_linea(&r.stdout);
        if r.ok && node_major(&v).is_some() {
            return con(b, EstadoCheck::Ok, Some(&format!("{} · {}", sin_sufijo_claude_code(&v), c.donde)), None, None);
        }
    }
    con(b, EstadoCheck::Warn, Some(&format!("Está en {} pero no respondió", cands[0].donde)), fix, cmd)
}

fn chequear_git(o: &OpcionesEntorno, ruta: Option<&str>) -> Check {
    let b = base(DocKey::Git, "Git", true);
    let (fix, cmd) = (Some(FIX_GIT), Some(CMD_GIT));
    let Some(ruta) = ruta else { return con(b, EstadoCheck::Missing, None, fix, cmd) };
    let r = (o.run)(ruta, &["--version".to_string()], o.timeout_ms);
    match buscar_version_triple(&r.stdout).filter(|_| r.ok) {
        Some(v) => con(b, EstadoCheck::Ok, Some(&format!("git {v}")), None, None),
        None => con(b, EstadoCheck::Warn, Some("No respondió"), fix, cmd),
    }
}

fn chequear_gh(o: &OpcionesEntorno, ruta: Option<&str>) -> Vec<Check> {
    let b = base(DocKey::Gh, "GitHub CLI (gh)", true);
    let auth = base(DocKey::GhAuth, "Sesión de gh", true);
    let Some(ruta) = ruta else {
        return vec![
            con(b, EstadoCheck::Warn, None, Some("Opcional: sirve para crear PRs desde Sloth."), Some(CMD_GH)),
            con(auth, EstadoCheck::Warn, Some("Sin gh"), Some("Después de instalar gh, iniciá sesión."), Some("gh auth login")),
        ];
    };
    let v = (o.run)(ruta, &["--version".to_string()], o.timeout_ms);
    let gh = match buscar_version_triple(&v.stdout).filter(|_| v.ok) {
        Some(m) => con(b, EstadoCheck::Ok, Some(&format!("gh {m}")), None, None),
        None => con(b, EstadoCheck::Warn, Some("No respondió"), None, Some(CMD_GH)),
    };
    // Solo sale el nombre de la cuenta, nunca el token.
    let args: Vec<String> = ["auth", "status", "--hostname", "github.com"].map(String::from).to_vec();
    let a = (o.run)(ruta, &args, o.timeout_ms);
    let salida = format!("{}\n{}", a.stdout, a.stderr);
    let cuenta = capturar_nombre(&salida, "account").or_else(|| capturar_nombre(&salida, "as"));
    let auth = if a.ok {
        let d = cuenta.map_or("Sesión iniciada".to_string(), |c| format!("Cuenta {c}"));
        con(auth, EstadoCheck::Ok, Some(&d), None, None)
    } else {
        let d = if a.error.as_deref() == Some("timeout") { "No respondió a tiempo" } else { "Sin sesión" };
        con(auth, EstadoCheck::Warn, Some(d), Some("Iniciá sesión en GitHub desde una terminal."), Some("gh auth login"))
    };
    vec![gh, auth]
}

pub fn chequear_entorno(o: &OpcionesEntorno) -> InformeEntorno {
    let ruta = |n: &str| buscar_en_path(&exe(n), o.path_env, o.es_archivo);
    let (node, git, gh) = (ruta("node"), ruta("git"), ruta("gh"));
    let mut items = vec![chequear_claude(o, node.as_deref()), chequear_node(o, node.as_deref()), chequear_git(o, git.as_deref())];
    items.extend(chequear_gh(o, gh.as_deref()));
    InformeEntorno { items, checked_at: o.ahora }
}

/// Repos sugeridos: los que ya usás y las carpetas con .git dentro de las rutas comunes (hasta 8).
pub fn candidatos_de_repo(
    home: &str,
    extra: &[String],
    es_dir: &dyn Fn(&str) -> bool,
    hijos: &dyn Fn(&str) -> std::io::Result<Vec<String>>,
    tiene_git: &dyn Fn(&str) -> bool,
) -> Vec<String> {
    let bases = [
        "C:\\dev\\work".to_string(),
        unir(home, &["dev", "work"]),
        "C:\\dev".to_string(),
        unir(home, &["dev"]),
        "D:\\dev\\work".to_string(),
        unir(home, &["Documents", "GitHub"]),
        unir(home, &["source", "repos"]),
        unir(home, &["repos"]),
    ];
    let mut out: Vec<String> = Vec::new();
    let mut vistos: Vec<String> = Vec::new();
    let mut sumar = |p: String| {
        let k = p.to_lowercase();
        if vistos.contains(&k) {
            return;
        }
        vistos.push(k);
        if es_dir(&p) && tiene_git(&unir(&p, &[".git"])) {
            out.push(p);
        }
    };
    for e in extra {
        sumar(e.clone());
    }
    for b in &bases {
        let Ok(nombres) = hijos(b) else { continue };
        for h in nombres {
            sumar(unir(b, &[&h]));
        }
    }
    out.truncate(8);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn nada(_: &str, _: &[String], _: u64) -> Resultado {
        Resultado { error: Some("no".into()), ..Default::default() }
    }

    #[test]
    fn los_repos_que_ya_usas_van_primero_sin_duplicados_y_como_mucho_8() {
        let home = std::env::temp_dir().join(format!("sloth-repos-rs-{}", std::process::id()));
        let dev = home.join("dev");
        for n in ["b", "c", "d", "e", "f", "g", "h", "i", "j"] {
            fs::create_dir_all(dev.join(n).join(".git")).unwrap();
        }
        fs::create_dir_all(dev.join("sin-git")).unwrap();
        let mio = home.join("otro").join("mio");
        fs::create_dir_all(mio.join(".git")).unwrap();
        let s = |p: &Path| p.to_string_lossy().into_owned();
        let es_dir = |p: &str| Path::new(p).is_dir();
        let hijos = |p: &str| {
            fs::read_dir(p).map(|d| {
                let mut v: Vec<String> = d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
                v.sort();
                v
            })
        };
        let tiene_git = |p: &str| Path::new(p).exists();
        let extra = [s(&mio), s(&mio).to_uppercase(), s(&dev.join("b"))];
        let lista = candidatos_de_repo(&s(&home), &extra, &es_dir, &hijos, &tiene_git);
        let _ = fs::remove_dir_all(&home);
        assert_eq!(lista.len(), 8);
        assert_eq!(lista[..2], [s(&mio), s(&dev.join("b"))]);
        let minus: std::collections::HashSet<String> = lista.iter().map(|p| p.to_lowercase()).collect();
        assert_eq!(minus.len(), 8);
        assert!(!lista.iter().any(|p| p.ends_with("sin-git")));
    }

    #[test]
    fn una_carpeta_que_no_se_puede_leer_se_saltea() {
        let hijos = |_: &str| Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "EACCES"));
        assert!(candidatos_de_repo("C:\\no\\existe", &[], &|_| true, &hijos, &|_| true).is_empty());
    }

    #[test]
    fn busca_repos_en_las_rutas_comunes_de_windows() {
        let vistos = std::cell::RefCell::new(Vec::<String>::new());
        let hijos = |p: &str| {
            vistos.borrow_mut().push(p.to_string());
            Ok(vec![])
        };
        candidatos_de_repo("C:\\Users\\x", &[], &|_| false, &hijos, &|_| false);
        for p in ["C:\\dev\\work", "C:\\dev", "D:\\dev\\work"] {
            assert!(vistos.borrow().iter().any(|v| v == p), "{p}");
        }
    }

    fn entorno<'a>(run: Ejecutor<'a>, es_archivo: &'a dyn Fn(&str) -> bool, path_env: &'a str) -> OpcionesEntorno<'a> {
        OpcionesEntorno { path_env, home: "Z:/h", app_data: "Z:/a", run, timeout_ms: 6000, es_archivo, ahora: 5.0 }
    }

    #[test]
    fn sin_node_ni_git_los_marca_faltantes_pero_opcionales_y_claude_sigue_siendo_requisito() {
        let r = chequear_entorno(&entorno(&nada, &|_| false, ""));
        let por = |id: DocKey| r.items.iter().find(|i| i.id == id).unwrap();
        for id in [DocKey::Node, DocKey::Git] {
            assert!(por(id).optional, "{id:?}");
            assert_eq!(por(id).state, EstadoCheck::Missing);
            assert!(por(id).fix.is_some() && por(id).command.is_some());
        }
        assert!(por(DocKey::Node).fix.as_deref().unwrap().contains("terminales andan igual"));
        assert!(por(DocKey::Git).fix.as_deref().unwrap().contains("terminales y los espacios andan igual"));
        assert_eq!(por(DocKey::Claude).state, EstadoCheck::Missing);
        assert!(!por(DocKey::Claude).optional);
        assert_eq!(por(DocKey::GhAuth).detail.as_deref(), Some("Sin gh"));
    }

    #[test]
    fn con_todo_instalado_lee_versiones_y_la_cuenta_de_gh() {
        let es_archivo = |p: &str| p.contains("bin");
        let run = |f: &str, a: &[String], _: u64| {
            let (stdout, stderr) = if f.contains("node") {
                ("v20.11.1\r\n", "")
            } else if f.contains("git") {
                ("git version 2.45.1.windows.1\n", "")
            } else if f.contains("claude") {
                ("2.1.0 (Claude Code)\n", "")
            } else if a.first().map(String::as_str) == Some("auth") {
                ("", "  ✓ Logged in to github.com account octo-cat (keyring)\n")
            } else {
                ("gh version 2.50.0 (2025-01-01)\n", "")
            };
            Resultado { ok: true, code: Some(0), stdout: stdout.into(), stderr: stderr.into(), error: None }
        };
        let sep = if cfg!(windows) { ';' } else { ':' };
        let path = ["Z:/bin"; 1].join(&sep.to_string());
        let r = chequear_entorno(&entorno(&run, &es_archivo, &path));
        let detalles: Vec<(DocKey, EstadoCheck, String)> = r.items.iter().map(|i| (i.id, i.state, i.detail.clone().unwrap_or_default())).collect();
        assert_eq!(detalles[1], (DocKey::Node, EstadoCheck::Ok, "v20.11.1".into()));
        assert_eq!(detalles[2], (DocKey::Git, EstadoCheck::Ok, "git 2.45.1".into()));
        assert_eq!(detalles[3], (DocKey::Gh, EstadoCheck::Ok, "gh 2.50.0".into()));
        assert_eq!(detalles[4], (DocKey::GhAuth, EstadoCheck::Ok, "Cuenta octo-cat".into()));
        assert_eq!(detalles[0].1, EstadoCheck::Ok);
        assert!(detalles[0].2.starts_with("2.1.0 · "), "{}", detalles[0].2);
    }

    #[test]
    fn node_viejo_o_que_no_responde_es_warn() {
        let es_archivo = |p: &str| p.contains("bin");
        let viejo = |_: &str, _: &[String], _: u64| Resultado { ok: true, stdout: "v16.0.0".into(), ..Default::default() };
        let path = "Z:/bin";
        let r = chequear_entorno(&entorno(&viejo, &es_archivo, path));
        let node = r.items.iter().find(|i| i.id == DocKey::Node).unwrap();
        assert_eq!((node.state, node.detail.as_deref()), (EstadoCheck::Warn, Some("v16.0.0 (vieja)")));
        let lento = |_: &str, _: &[String], _: u64| Resultado { error: Some("timeout".into()), ..Default::default() };
        let r = chequear_entorno(&entorno(&lento, &es_archivo, path));
        let node = r.items.iter().find(|i| i.id == DocKey::Node).unwrap();
        assert_eq!(node.detail.as_deref(), Some("No respondió a tiempo"));
    }

    #[test]
    fn node_major_toma_el_primer_numero_con_punto() {
        assert_eq!(node_major("v20.11.1"), Some(20.0));
        assert_eq!(node_major("node 18.0"), Some(18.0));
        assert_eq!(node_major("1a2.3"), Some(2.0));
        assert_eq!(node_major("v20"), None);
        assert_eq!(node_major(""), None);
    }

    #[test]
    fn buscar_en_path_recorta_comillas_y_saltea_vacios() {
        let sep = DELIMITADOR.to_string();
        let path = [" \"Z:/uno\" ".to_string(), String::new(), "Z:/dos".to_string()].join(&sep);
        let hay = |p: &str| p.replace('\\', "/") == "Z:/dos/x.exe";
        assert_eq!(buscar_en_path(&["x.exe".to_string()], &path, &hay).map(|p| p.replace('\\', "/")), Some("Z:/dos/x.exe".to_string()));
        assert_eq!(buscar_en_path(&["y.exe".to_string()], &path, &hay), None);
    }

    #[test]
    fn el_estado_se_lee_con_valores_por_defecto_para_lo_invalido() {
        let e = EstadoOnboarding::desde_texto("\u{feff}{\"completed\":true,\"skipped\":true,\"step\":2,\"repoPath\":\"C:\\\\r\",\"updatedAt\":\"12\"}");
        assert_eq!(e, EstadoOnboarding { completed: true, skipped: true, step: 2, repo_path: Some("C:\\r".into()), updated_at: 12.0 });
        let raro = EstadoOnboarding::desde_texto("{\"completed\":\"si\",\"step\":9,\"repoPath\":5,\"updatedAt\":null}");
        assert_eq!(raro, EstadoOnboarding::default());
        assert_eq!(EstadoOnboarding::desde_texto("{roto"), EstadoOnboarding::default());
        assert_eq!(EstadoOnboarding::desde_texto("null"), EstadoOnboarding::default());
        assert_eq!(EstadoOnboarding::desde_texto("{\"step\":1.5}").step, 0);
        let largo = format!("{{\"repoPath\":\"{}\"}}", "a".repeat(1001));
        assert_eq!(EstadoOnboarding::desde_texto(&largo).repo_path, None);
    }

    #[test]
    fn el_estado_se_escribe_en_el_orden_del_original_y_sin_claves_vacias() {
        let e = EstadoOnboarding { completed: false, skipped: false, step: 1, repo_path: None, updated_at: 7.0 };
        assert_eq!(serde_json::to_string(&e.a_json()).unwrap(), "{\"version\":1,\"completed\":false,\"step\":1,\"updatedAt\":7.0}");
        let e = EstadoOnboarding { completed: true, skipped: true, step: 3, repo_path: Some("C:\\r".into()), updated_at: 7.0 };
        assert_eq!(serde_json::to_string(&e.a_json()).unwrap(), "{\"version\":1,\"completed\":true,\"skipped\":true,\"step\":3,\"repoPath\":\"C:\\\\r\",\"updatedAt\":7.0}");
    }

    #[test]
    fn para_la_ui_solo_muestra_la_primera_vez() {
        let e = EstadoOnboarding::default();
        assert_eq!(e.para_la_ui(0, false)["show"], json!(true));
        assert_eq!(e.para_la_ui(1, false)["show"], json!(false));
        assert_eq!(e.para_la_ui(0, true)["show"], json!(false));
        assert_eq!(EstadoOnboarding { completed: true, ..e.clone() }.para_la_ui(0, false)["show"], json!(false));
        assert_eq!(e.para_la_ui(0, false)["steps"], json!(["entorno", "cuentas", "repo", "espacio"]));
    }

    fn repo_ok(v: &Value) -> Result<String, String> {
        validar_carpeta_repo(v, es_absoluta_win32, |_| true)
    }

    #[test]
    fn el_parche_valida_cada_campo() {
        let e = EstadoOnboarding::default();
        let ap = |p: Value| aplicar_parche(&e, &p, 99.0, repo_ok);
        assert_eq!(ap(json!({ "step": 2, "completed": true })).unwrap(), EstadoOnboarding { completed: true, step: 2, updated_at: 99.0, ..e.clone() });
        assert_eq!(ap(json!({ "skipped": true })).unwrap().skipped, true);
        assert_eq!(ap(json!({ "repoPath": " C:\\r " })).unwrap().repo_path.as_deref(), Some("C:\\r"));
        assert_eq!(ap(json!({})).unwrap().updated_at, 99.0);
        assert_eq!(ap(json!({ "step": 4 })), Err("Paso inválido.".into()));
        assert_eq!(ap(json!({ "step": null })), Err("Paso inválido.".into()));
        assert_eq!(ap(json!({ "step": 1.5 })), Err("Paso inválido.".into()));
        assert_eq!(ap(json!({ "completed": "x" })), Err("Datos inválidos.".into()));
        assert_eq!(ap(json!({ "skipped": 1 })), Err("Datos inválidos.".into()));
        assert_eq!(ap(json!([])), Err("Datos inválidos.".into()));
        assert_eq!(ap(json!(null)), Err("Datos inválidos.".into()));
        assert_eq!(ap(json!({ "repoPath": 5 })), Err("Elegí una carpeta.".into()));
        assert_eq!(ap(json!({ "repoPath": "rel" })), Err("Esa carpeta no existe.".into()));
    }

    #[test]
    fn el_parche_puede_borrar_la_carpeta_y_el_salteado() {
        let e = EstadoOnboarding { skipped: true, repo_path: Some("C:\\r".into()), ..Default::default() };
        let n = aplicar_parche(&e, &json!({ "repoPath": null, "skipped": false }), 1.0, repo_ok).unwrap();
        assert_eq!((n.repo_path, n.skipped), (None, false));
    }

    #[test]
    fn carpeta_de_repo_pide_texto_no_vacio_absoluto_y_existente() {
        assert_eq!(validar_carpeta_repo(&json!("   "), es_absoluta_win32, |_| true), Err("Elegí una carpeta.".into()));
        assert_eq!(validar_carpeta_repo(&json!("a".repeat(1001)), es_absoluta_win32, |_| true), Err("Elegí una carpeta.".into()));
        assert_eq!(validar_carpeta_repo(&json!("D:\\x"), es_absoluta_win32, |_| false), Err("Esa carpeta no existe.".into()));
        assert_eq!(validar_carpeta_repo(&json!("D:/x"), es_absoluta_win32, |_| true), Ok("D:/x".into()));
        assert!(es_absoluta_win32("\\\\srv\\share") && es_absoluta_win32("/x") && !es_absoluta_win32("C:x") && !es_absoluta_win32("x\\y"));
    }

    #[test]
    fn solo_se_abren_las_docs_conocidas() {
        assert_eq!(validar_doc(&json!("gh-auth")), Ok("https://cli.github.com/manual/gh_auth_login"));
        for malo in [json!("toString"), json!("https://evil.test"), json!(3), json!(null)] {
            assert_eq!(validar_doc(&malo), Err("Documento desconocido.".into()), "{malo}");
        }
    }

    #[test]
    fn nombre_de_repo_y_rutas_unicas() {
        assert_eq!(nombre_de_repo("C:\\dev\\sloth\\"), "sloth");
        assert_eq!(nombre_de_repo("/a/b"), "b");
        assert_eq!(nombre_de_repo("\\"), "\\");
        assert_eq!(rutas_unicas(&["a".into(), "b".into(), "a".into()]), vec!["a", "b"]);
    }

    #[test]
    fn el_informe_sale_con_las_claves_de_la_ui() {
        let r = chequear_entorno(&entorno(&nada, &|_| false, ""));
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["checkedAt"], json!(5.0));
        assert_eq!(v["items"][1]["id"], json!("node"));
        assert_eq!(v["items"][1]["state"], json!("missing"));
        assert_eq!(v["items"][4]["id"], json!("gh-auth"));
        assert!(v["items"][0].get("optional").is_none());
        assert!(v["items"][0].get("detail").is_none());
    }

    #[test]
    fn capturar_nombre_necesita_un_blanco_y_un_nombre_detras() {
        assert_eq!(capturar_nombre("Logged in as foo-bar (x)", "as").as_deref(), Some("foo-bar"));
        assert_eq!(capturar_nombre("account(x)", "account"), None);
        assert_eq!(capturar_nombre("account  \nx", "account").as_deref(), Some("x"));
        assert_eq!(capturar_nombre("account (x)", "account"), None);
    }
}
