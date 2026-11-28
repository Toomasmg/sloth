//! Función «prs»: los PR abiertos de los repos de GitHub que usan los espacios. Equivale a src/main/features/prs-core.ts
//! (consultas a gh y validación de lo que devuelve GitHub), a la parte decidible de prs.ts y a `rebaseBlocker` de
//! src/shared/prs.ts. Lo que corre procesos pasa por el `Ejecutor` y el `EntornoPrs` que se inyectan.
use super::proceso::{legible, nombre_de_rama_valido, normalizar_ruta, Ejecutor, Salida};
use crate::avisos::Avisos;
use crate::persistencia::{escribir_json_atomico, leer_json, OpcionesLectura};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

pub const VERSION: u32 = 2;
pub const STALE_MS: u64 = 30_000;
pub const AUTH_TTL_MS: u64 = 5 * 60_000;
pub const PARALELO: usize = 4;
const MAX_FALLANDO: usize = 5;
const MAX_PR: i64 = 10_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EstadoChecks {
    Ok,
    Fail,
    Pending,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EstadoReview {
    Approved,
    Changes,
    Required,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mergeable {
    Yes,
    Conflict,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MetodoMerge {
    Squash,
    Merge,
    Rebase,
}

impl MetodoMerge {
    pub fn desde_texto(s: &str) -> Option<Self> {
        match s {
            "squash" => Some(Self::Squash),
            "merge" => Some(Self::Merge),
            "rebase" => Some(Self::Rebase),
            _ => None,
        }
    }

    pub fn como_texto(self) -> &'static str {
        match self {
            Self::Squash => "squash",
            Self::Merge => "merge",
            Self::Rebase => "rebase",
        }
    }
}

const METODOS: [MetodoMerge; 3] = [MetodoMerge::Squash, MetodoMerge::Merge, MetodoMerge::Rebase];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckPr {
    pub name: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ConteoChecks {
    pub ok: u32,
    pub fail: u32,
    pub pending: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilaPr {
    pub repo: String,
    pub number: u32,
    pub title: String,
    pub url: String,
    pub author: String,
    pub is_draft: bool,
    pub base: String,
    pub head: String,
    pub cross_repo: bool,
    pub maintainer_can_modify: bool,
    pub head_sha: String,
    pub updated_at: String,
    pub checks: EstadoChecks,
    pub check_counts: ConteoChecks,
    pub failing: Vec<CheckPr>,
    pub review: EstadoReview,
    pub review_requested_from_me: bool,
    pub mine: bool,
    pub mergeable: Mergeable,
    pub merge_state: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoPrs {
    pub repo: String,
    pub repo_paths: Vec<String>,
    pub default_branch: Option<String>,
    pub merge_methods: Vec<MetodoMerge>,
    pub prs: Vec<FilaPr>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Problema {
    #[serde(rename = "no-gh")]
    NoGh,
    #[serde(rename = "no-login")]
    NoLogin,
    #[serde(rename = "no-repos")]
    NoRepos,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Instantanea {
    pub problem: Option<Problema>,
    pub login: Option<String>,
    pub repos: Vec<RepoPrs>,
    /// ms del último refresco completo; 0 = nunca.
    pub at: u64,
    pub refreshing: bool,
}

impl Instantanea {
    pub fn inicial() -> Self {
        Instantanea { problem: None, login: None, repos: Vec::new(), at: 0, refreshing: false }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrTarget {
    pub repo: String,
    pub number: u32,
}

// ---------- validación de lo que llega por IPC ----------

fn re_repo() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$").unwrap())
}

fn re_sha() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^[0-9a-f]{40}$").unwrap())
}

fn re_id() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^[A-Za-z0-9_=-]{1,100}$").unwrap())
}

// Copia de GITHUB_PR_URL de git-ops: este módulo no corre procesos.
fn re_url_pr() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[0-9]+/?$").unwrap())
}

pub fn repo_valido(s: &str) -> bool {
    re_repo().is_match(s) && s.split('/').all(|p| !p.chars().all(|c| c == '.'))
}

fn repo_valido_valor(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| repo_valido(s))
}

fn entero(v: Option<&Value>) -> Option<i64> {
    let n = v?.as_number()?;
    if let Some(i) = n.as_i64() {
        return Some(i);
    }
    let f = n.as_f64()?;
    (f.is_finite() && f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0).then_some(f as i64)
}

fn numero_de_pr(v: Option<&Value>) -> Option<u32> {
    entero(v).filter(|n| (1..=MAX_PR).contains(n)).map(|n| n as u32)
}

pub fn remoto_de_github(url: &str) -> Option<String> {
    static R: OnceLock<[Regex; 3]> = OnceLock::new();
    let res = R.get_or_init(|| {
        [
            Regex::new(r"(?i)^https?://(?:[^@/]+@)?github\.com/([^/]+)/([^/]+?)(?:\.git)?/?$").unwrap(),
            Regex::new(r"(?i)^git@github\.com:([^/]+)/([^/]+?)(?:\.git)?/?$").unwrap(),
            Regex::new(r"(?i)^ssh://git@github\.com(?::[0-9]+)?/([^/]+)/([^/]+?)(?:\.git)?/?$").unwrap(),
        ]
    });
    let u = url.trim();
    for re in res {
        let Some(m) = re.captures(u) else { continue };
        let slug = format!("{}/{}", &m[1], &m[2]);
        return repo_valido(&slug).then_some(slug);
    }
    None
}

pub fn target_valido(x: &Value) -> Result<PrTarget, String> {
    let Some(o) = x.as_object() else {
        return Err(if x.is_array() { "Repo inválido.".into() } else { "PR inválido.".into() });
    };
    let Some(repo) = repo_valido_valor(o.get("repo")) else { return Err("Repo inválido.".into()) };
    let Some(number) = numero_de_pr(o.get("number")) else { return Err("Número de PR inválido.".into()) };
    Ok(PrTarget { repo: repo.to_string(), number })
}

pub fn metodo_valido(v: &Value) -> Option<MetodoMerge> {
    v.as_str().and_then(MetodoMerge::desde_texto)
}

/// Texto de GitHub apto para mostrar: sin caracteres invisibles ni de control, en una línea y acotado.
pub fn limpiar_texto(s: &str, max: usize) -> String {
    static R: OnceLock<[Regex; 3]> = OnceLock::new();
    let [cf, cc, blancos] = R.get_or_init(|| [Regex::new(r"\p{Cf}").unwrap(), Regex::new(r"\p{Cc}").unwrap(), Regex::new(r"\s+").unwrap()]);
    let t = cf.replace_all(s, "");
    let t = cc.replace_all(&t, " ");
    let t = blancos.replace_all(&t, " ");
    t.trim().chars().take(max).collect()
}

fn limpiar_valor(v: Option<&Value>, max: usize) -> String {
    v.and_then(Value::as_str).map(|s| limpiar_texto(s, max)).unwrap_or_default()
}

// ---------- consultas a gh ----------

pub const PRS_QUERY: &str = concat!(
    "query($owner:String!,$name:String!){viewer{login} repository(owner:$owner,name:$name){",
    "mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed defaultBranchRef{name} ",
    "pullRequests(states:OPEN,first:30,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{",
    "id number title url isDraft baseRefName headRefName isCrossRepository maintainerCanModify updatedAt author{login} ",
    "mergeable mergeStateStatus reviewDecision ",
    "reviewRequests(first:20){nodes{requestedReviewer{... on User{login}}}} ",
    "commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:50){nodes{__typename ",
    "... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}}}}}}}",
    "}}}}"
);

pub fn args_de_consulta(owner: &str, name: &str) -> Result<Vec<String>, String> {
    if !repo_valido(&format!("{owner}/{name}")) {
        return Err("Repo inválido.".into());
    }
    Ok(["api", "graphql", "-f"].iter().map(|s| s.to_string()).chain([format!("query={PRS_QUERY}"), "-f".into(), format!("owner={owner}"), "-f".into(), format!("name={name}")]).collect())
}

fn objeto(v: Option<&Value>) -> Option<&Map<String, Value>> {
    v.and_then(Value::as_object)
}

fn nodos(v: Option<&Value>) -> &[Value] {
    objeto(v).and_then(|o| o.get("nodes")).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn url_https(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?;
    let sin_blancos = !s.chars().any(|c| c.is_whitespace() || c.is_control());
    (s.starts_with("https://") && s.encode_utf16().count() <= 2000 && sin_blancos).then(|| s.to_string())
}

const CONCLUSIONES_FALLIDAS: [&str; 5] = ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumenChecks {
    pub state: EstadoChecks,
    pub counts: ConteoChecks,
    pub failing: Vec<CheckPr>,
}

/// `rollup` es statusCheckRollup.state, que cubre todos los checks aunque solo se lean los primeros contextos.
pub fn resumir_checks(contextos: &[Value], rollup: Option<&Value>) -> ResumenChecks {
    #[derive(PartialEq)]
    enum Clase {
        Ok,
        Fail,
        Pending,
    }
    let mut counts = ConteoChecks::default();
    let mut failing = Vec::new();
    for c in contextos {
        let Some(o) = c.as_object() else { continue };
        let tipo = o.get("__typename").and_then(Value::as_str);
        let (clase, nombre, url) = if tipo == Some("CheckRun") {
            let clase = if o.get("status").and_then(Value::as_str) != Some("COMPLETED") {
                Clase::Pending
            } else if o.get("conclusion").and_then(Value::as_str).is_some_and(|c| CONCLUSIONES_FALLIDAS.contains(&c)) {
                Clase::Fail
            } else {
                Clase::Ok
            };
            (clase, limpiar_valor(o.get("name"), 200), url_https(o.get("detailsUrl")))
        } else if tipo == Some("StatusContext") {
            let clase = match o.get("state").and_then(Value::as_str) {
                Some("PENDING") | Some("EXPECTED") => Clase::Pending,
                Some("FAILURE") | Some("ERROR") => Clase::Fail,
                Some("SUCCESS") => Clase::Ok,
                _ => continue,
            };
            (clase, limpiar_valor(o.get("context"), 200), url_https(o.get("targetUrl")))
        } else {
            continue;
        };
        match clase {
            Clase::Ok => counts.ok += 1,
            Clase::Fail => counts.fail += 1,
            Clase::Pending => counts.pending += 1,
        }
        if clase == Clase::Fail && failing.len() < MAX_FALLANDO {
            failing.push(CheckPr { name: if nombre.is_empty() { "check".into() } else { nombre }, url });
        }
    }
    let mut state = if counts.fail > 0 {
        EstadoChecks::Fail
    } else if counts.pending > 0 {
        EstadoChecks::Pending
    } else if counts.ok > 0 {
        EstadoChecks::Ok
    } else {
        EstadoChecks::None
    };
    match rollup.and_then(Value::as_str) {
        Some("FAILURE") | Some("ERROR") => state = EstadoChecks::Fail,
        Some("PENDING") | Some("EXPECTED") if state != EstadoChecks::Fail => state = EstadoChecks::Pending,
        _ => {}
    }
    ResumenChecks { state, counts, failing }
}

fn review_de(v: Option<&Value>) -> EstadoReview {
    match v.and_then(Value::as_str) {
        Some("APPROVED") => EstadoReview::Approved,
        Some("CHANGES_REQUESTED") => EstadoReview::Changes,
        Some("REVIEW_REQUIRED") => EstadoReview::Required,
        _ => EstadoReview::None,
    }
}

fn mergeable_de(v: Option<&Value>) -> Mergeable {
    match v.and_then(Value::as_str) {
        Some("MERGEABLE") => Mergeable::Yes,
        Some("CONFLICTING") => Mergeable::Conflict,
        _ => Mergeable::Unknown,
    }
}

fn fila_de_nodo(n: &Value, repo: &str, login: &str) -> Option<(FilaPr, String)> {
    let o = n.as_object()?;
    let number = numero_de_pr(o.get("number"))?;
    let url = o.get("url").and_then(Value::as_str).filter(|u| re_url_pr().is_match(u))?;
    let id = o.get("id").and_then(Value::as_str).filter(|i| re_id().is_match(i))?;
    let commit = objeto(objeto(nodos(o.get("commits")).first()).and_then(|c| c.get("commit")));
    let head_sha = commit.and_then(|c| c.get("oid")).and_then(Value::as_str).filter(|s| re_sha().is_match(s))?;
    let rollup = objeto(commit.and_then(|c| c.get("statusCheckRollup")));
    let checks = resumir_checks(nodos(rollup.and_then(|r| r.get("contexts"))), rollup.and_then(|r| r.get("state")));
    let author = limpiar_valor(objeto(o.get("author")).and_then(|a| a.get("login")), 200);
    let merge_state = limpiar_valor(o.get("mergeStateStatus"), 40);
    let pedida_a_mi = !login.is_empty()
        && nodos(o.get("reviewRequests")).iter().any(|r| limpiar_valor(objeto(objeto(Some(r)).and_then(|r| r.get("requestedReviewer"))).and_then(|u| u.get("login")), 200) == login);
    let merge_state_ok = !merge_state.is_empty() && merge_state.chars().all(|c| c.is_ascii_uppercase() || c == '_');
    let fila = FilaPr {
        repo: repo.to_string(),
        number,
        title: limpiar_valor(o.get("title"), 300),
        url: url.to_string(),
        mine: !login.is_empty() && author == login,
        author,
        is_draft: o.get("isDraft") == Some(&Value::Bool(true)),
        base: limpiar_valor(o.get("baseRefName"), 200),
        head: limpiar_valor(o.get("headRefName"), 200),
        cross_repo: o.get("isCrossRepository") == Some(&Value::Bool(true)),
        maintainer_can_modify: o.get("maintainerCanModify") == Some(&Value::Bool(true)),
        head_sha: head_sha.to_string(),
        updated_at: limpiar_valor(o.get("updatedAt"), 40),
        checks: checks.state,
        check_counts: checks.counts,
        failing: checks.failing,
        review: review_de(o.get("reviewDecision")),
        review_requested_from_me: pedida_a_mi,
        mergeable: mergeable_de(o.get("mergeable")),
        merge_state: if merge_state_ok { merge_state } else { "UNKNOWN".into() },
    };
    Some((fila, id.to_string()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RespuestaRepo {
    pub login: String,
    pub default_branch: Option<String>,
    pub merge_methods: Vec<MetodoMerge>,
    pub prs: Vec<FilaPr>,
    /// Número de PR → id de GraphQL.
    pub ids: BTreeMap<u32, String>,
}

pub fn leer_respuesta_de_texto(texto: &str, repo: &str) -> Result<RespuestaRepo, String> {
    let json: Value = serde_json::from_str(texto).map_err(|_| "GitHub devolvió una respuesta que no se pudo leer.".to_string())?;
    leer_respuesta(&json, repo)
}

pub fn leer_respuesta(json: &Value, repo: &str) -> Result<RespuestaRepo, String> {
    let Some(root) = json.as_object() else { return Err("GitHub devolvió una respuesta que no se pudo leer.".into()) };
    let d = objeto(root.get("data"));
    let Some(r) = objeto(d.and_then(|d| d.get("repository"))) else {
        let msg = root.get("errors").and_then(Value::as_array).and_then(|e| e.first()).map(|e| limpiar_valor(e.get("message"), 300)).unwrap_or_default();
        return Err(if msg.is_empty() { "No encontré el repo en GitHub o no tenés acceso.".into() } else { format!("GitHub: {msg}") });
    };
    let login = limpiar_valor(objeto(d.and_then(|d| d.get("viewer"))).and_then(|v| v.get("login")), 200);
    let permitido = |m: MetodoMerge| {
        let clave = match m {
            MetodoMerge::Squash => "squashMergeAllowed",
            MetodoMerge::Merge => "mergeCommitAllowed",
            MetodoMerge::Rebase => "rebaseMergeAllowed",
        };
        r.get(clave) == Some(&Value::Bool(true))
    };
    let merge_methods = METODOS.into_iter().filter(|m| permitido(*m)).collect();
    let mut prs = Vec::new();
    let mut ids = BTreeMap::new();
    for n in nodos(r.get("pullRequests")) {
        let Some((fila, id)) = fila_de_nodo(n, repo, &login) else { continue };
        ids.insert(fila.number, id);
        prs.push(fila);
    }
    let rama = limpiar_valor(objeto(r.get("defaultBranchRef")).and_then(|b| b.get("name")), 200);
    Ok(RespuestaRepo { login, default_branch: (!rama.is_empty()).then_some(rama), merge_methods, prs, ids })
}

/// El commit que el usuario vio y confirmó tiene que seguir siendo el head del PR.
pub fn head_visto(actual: &str, visto: &Value) -> Result<String, String> {
    let Some(v) = visto.as_str().filter(|s| re_sha().is_match(s)) else { return Err("Commit del PR inválido.".into()) };
    if v != actual {
        return Err("El PR cambió desde que lo abriste: revisalo y confirmá de nuevo.".into());
    }
    Ok(v.to_string())
}

pub fn args_de_merge(t: &PrTarget, metodo: &str, head_sha: &str) -> Result<Vec<String>, String> {
    if !repo_valido(&t.repo) || !(1..=MAX_PR).contains(&i64::from(t.number)) {
        return Err(if repo_valido(&t.repo) { "Número de PR inválido.".into() } else { "Repo inválido.".into() });
    }
    if MetodoMerge::desde_texto(metodo).is_none() {
        return Err("Método de merge inválido.".into());
    }
    if !re_sha().is_match(head_sha) {
        return Err("Commit del PR inválido.".into());
    }
    Ok(["pr", "merge"].iter().map(|s| s.to_string()).chain([t.number.to_string(), "--repo".into(), t.repo.clone(), format!("--{metodo}"), "--match-head-commit".into(), head_sha.into()]).collect())
}

pub const MUTACION_ACTUALIZAR_RAMA: &str = "mutation($id:ID!,$sha:GitObjectID!){updatePullRequestBranch(input:{pullRequestId:$id,expectedHeadOid:$sha,updateMethod:REBASE}){pullRequest{number}}}";

pub fn args_de_actualizar_rama(pr_id: &str, head_sha: &str) -> Result<Vec<String>, String> {
    if !re_id().is_match(pr_id) {
        return Err("Id de PR inválido.".into());
    }
    if !re_sha().is_match(head_sha) {
        return Err("Commit del PR inválido.".into());
    }
    Ok(["api", "graphql", "-f"].iter().map(|s| s.to_string()).chain([format!("query={MUTACION_ACTUALIZAR_RAMA}"), "-f".into(), format!("id={pr_id}"), "-f".into(), format!("sha={head_sha}")]).collect())
}

/// Carpetas de worktree que tienen esa rama, según `git worktree list --porcelain`.
pub fn worktrees_con_rama(porcelain: &str, rama: &str) -> Vec<String> {
    let objetivo = format!("branch refs/heads/{rama}");
    let mut out = Vec::new();
    let mut ruta: Option<&str> = None;
    for linea in porcelain.split('\n').map(|l| l.trim_end_matches('\r')) {
        if let Some(r) = linea.strip_prefix("worktree ") {
            ruta = Some(r);
        } else if linea == objetivo {
            if let Some(r) = ruta {
                out.push(r.to_string());
            }
        } else if linea.is_empty() {
            ruta = None;
        }
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EstadoRamaLocal {
    Igual,
    Atrasada,
    Divergida,
}

/// Rama local frente a la del PR, según `git rev-list --left-right --count local...remota`.
pub fn comparar_local(conteo: &str) -> Result<(EstadoRamaLocal, u64, u64), String> {
    static R: OnceLock<Regex> = OnceLock::new();
    let re = R.get_or_init(|| Regex::new(r"^([0-9]+)\s+([0-9]+)$").unwrap());
    let err = || "No pude comparar la rama local con la del PR.".to_string();
    let m = re.captures(conteo.trim()).ok_or_else(err)?;
    let adelante: u64 = m[1].parse().map_err(|_| err())?;
    let atras: u64 = m[2].parse().map_err(|_| err())?;
    let estado = if adelante == 0 && atras == 0 {
        EstadoRamaLocal::Igual
    } else if adelante == 0 {
        EstadoRamaLocal::Atrasada
    } else {
        EstadoRamaLocal::Divergida
    };
    Ok((estado, adelante, atras))
}

/// Primer nombre `pr-N`, `pr-N-2`… que no esté entre las ramas locales.
pub fn rama_libre(numero: u32, ramas: &HashSet<String>) -> Result<String, String> {
    for i in 1..50 {
        let b = if i == 1 { format!("pr-{numero}") } else { format!("pr-{numero}-{i}") };
        if !ramas.contains(&b) {
            return Ok(b);
        }
    }
    Err(format!("Ya hay demasiadas ramas pr-{numero}: borrá alguna."))
}

const RAMAS_PROTEGIDAS: [&str; 6] = ["main", "master", "staging", "develop", "production", "release"];

/// Por qué no se ofrece el rebase en GitHub de este PR, o None si se puede.
pub fn bloqueo_de_rebase(pr: &FilaPr, repo: &RepoPrs) -> Option<String> {
    if pr.cross_repo {
        return (!pr.maintainer_can_modify).then(|| "Es de un fork que no deja modificar su rama.".to_string());
    }
    let Some(por_defecto) = repo.default_branch.as_deref().filter(|d| !d.is_empty()) else {
        return Some("No sé cuál es la rama por defecto del repo: refrescá.".into());
    };
    if pr.head == por_defecto {
        return Some(format!("{} es la rama por defecto del repo.", pr.head));
    }
    if RAMAS_PROTEGIDAS.contains(&pr.head.as_str()) {
        return Some(format!("{} es una rama protegida.", pr.head));
    }
    if repo.prs.iter().any(|p| p.number != pr.number && p.base == pr.head) {
        return Some(format!("Otros PR salen de {}.", pr.head));
    }
    None
}

// ---------- decisiones de la función ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModoRama {
    Local,
    Copia,
}

pub fn modo_valido(v: &Value) -> Result<Option<ModoRama>, String> {
    match v {
        Value::Null => Ok(None),
        Value::String(s) if s == "local" => Ok(Some(ModoRama::Local)),
        Value::String(s) if s == "copy" => Ok(Some(ModoRama::Copia)),
        _ => Err("Opción inválida.".into()),
    }
}

/// ¿Hay que volver a leer de GitHub? Un refresco en curso se reusa; sin `forzar`, un dato reciente alcanza.
pub fn hace_falta_refrescar(en_curso: bool, forzar: bool, ahora_ms: u64, ultimo_ms: u64) -> bool {
    !en_curso && (forzar || ahora_ms.saturating_sub(ultimo_ms) >= STALE_MS)
}

/// La fila de un PR de la última lectura, solo si alguno de sus repos sigue en uso por un espacio.
pub fn fila_de<'a>(snap: &'a Instantanea, x: &Value, rutas_de_espacios: &[String]) -> Result<(&'a FilaPr, &'a RepoPrs, PrTarget), String> {
    let target = target_valido(x)?;
    let repo = snap.repos.iter().find(|r| r.repo == target.repo);
    let fila = repo.and_then(|r| r.prs.iter().find(|p| p.number == target.number));
    let en_uso = repo.is_some_and(|r| r.repo_paths.iter().any(|p| rutas_de_espacios.iter().any(|w| normalizar_ruta(w) == normalizar_ruta(p))));
    match (repo, fila, en_uso) {
        (Some(r), Some(f), true) => Ok((f, r, target)),
        _ => Err("Ese PR ya no está en la lista. Refrescá.".into()),
    }
}

pub fn metodo_de(repo: &RepoPrs, fila: &FilaPr, metodo: &Value) -> Result<MetodoMerge, String> {
    let Some(m) = metodo_valido(metodo).filter(|m| repo.merge_methods.contains(m)) else {
        return Err("Ese método de merge no está habilitado en el repo.".into());
    };
    if fila.is_draft {
        return Err("Es un borrador.".into());
    }
    Ok(m)
}

/// Solo se abre el link del PR o el de uno de sus checks fallidos, y solo https.
pub fn url_permitida<'a>(fila: &FilaPr, url: &'a Value) -> Result<&'a str, String> {
    let permitida = url.as_str().filter(|u| *u == fila.url || fila.failing.iter().any(|f| f.url.as_deref() == Some(u)));
    let Some(u) = permitida else { return Err("Ese link no es de este PR.".into()) };
    if !u.starts_with("https://") {
        return Err("Solo se abren links https.".into());
    }
    Ok(u)
}

/// `gh pr merge …` tal cual se le muestra al usuario para que lo corra a mano.
pub fn comando_de_merge(repo: &RepoPrs, fila: &FilaPr, target: &PrTarget, metodo: &Value, visto: &Value) -> Result<Vec<String>, String> {
    let m = metodo_de(repo, fila, metodo)?;
    let head = head_visto(&fila.head_sha, visto)?;
    let mut v = vec!["gh".to_string()];
    v.extend(args_de_merge(target, m.como_texto(), &head)?);
    Ok(v)
}

/// Una operación por PR a la vez.
#[derive(Default)]
pub struct Ocupados {
    en_curso: Mutex<HashSet<String>>,
}

pub struct Reserva<'a> {
    ocupados: &'a Ocupados,
    clave: String,
}

impl Drop for Reserva<'_> {
    fn drop(&mut self) {
        self.ocupados.en_curso.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.clave);
    }
}

impl Ocupados {
    pub fn reservar(&self, t: &PrTarget) -> Result<Reserva<'_>, String> {
        let clave = format!("{}#{}", t.repo, t.number);
        if !self.en_curso.lock().unwrap_or_else(|e| e.into_inner()).insert(clave.clone()) {
            return Err("Ya hay una operación en curso con ese PR.".into());
        }
        Ok(Reserva { ocupados: self, clave })
    }
}

/// Ids de GraphQL tras un refresco: los del repo leído ahora y, de los que fallaron, los que ya se tenían.
pub fn fusionar_ids(previos: &[(String, String)], leidos: &[(String, Option<BTreeMap<u32, String>>)]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut poner = |k: String, v: String| match out.iter_mut().find(|(c, _)| *c == k) {
        Some(e) => e.1 = v,
        None => out.push((k, v)),
    };
    for (repo, ids) in leidos {
        match ids {
            Some(ids) => {
                for (n, id) in ids {
                    poner(format!("{repo}#{n}"), id.clone());
                }
            }
            None => {
                for (k, id) in previos {
                    if k.starts_with(&format!("{repo}#")) {
                        poner(k.clone(), id.clone());
                    }
                }
            }
        }
    }
    out
}

pub struct RepoLeido {
    pub repo: RepoPrs,
    pub ids: Option<BTreeMap<u32, String>>,
    pub login: String,
}

/// Lee un repo con gh. Si falla, conserva lo que había y deja el error para mostrarlo.
pub fn leer_repo(ejecutor: &dyn Ejecutor, slug: &str, rutas: &[String], viejo: Option<&RepoPrs>) -> RepoLeido {
    let conservado = |error: String| RepoLeido {
        repo: RepoPrs {
            repo: slug.to_string(),
            repo_paths: rutas.to_vec(),
            default_branch: viejo.and_then(|v| v.default_branch.clone()),
            merge_methods: viejo.map(|v| v.merge_methods.clone()).unwrap_or_default(),
            prs: viejo.map(|v| v.prs.clone()).unwrap_or_default(),
            error: Some(error),
        },
        ids: None,
        login: String::new(),
    };
    let Some((owner, name)) = slug.split_once('/') else { return conservado("Repo inválido.".into()) };
    let args = match args_de_consulta(owner, name) {
        Ok(a) => a,
        Err(e) => return conservado(e),
    };
    let r = ejecutor.ejecutar("gh", &args, None, Duration::from_secs(20));
    // gh sale con error si hay `errors` aunque `data` venga completo (p. ej. un campo sin permiso).
    match leer_respuesta_de_texto(&r.stdout, slug) {
        Ok(p) => RepoLeido {
            repo: RepoPrs { repo: slug.to_string(), repo_paths: rutas.to_vec(), default_branch: p.default_branch, merge_methods: p.merge_methods, prs: p.prs, error: None },
            ids: Some(p.ids),
            login: p.login,
        },
        Err(e) => conservado(if r.code != 0 { legible(&r, "gh api graphql") } else { e }),
    }
}

// ---------- abrir la rama de un PR en un espacio ----------

#[derive(Debug, Clone)]
pub struct EspacioPrs {
    pub id: String,
    pub repo_path: String,
    pub cwd: String,
    pub branch: Option<String>,
    pub account_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NuevoEspacio {
    pub name: String,
    pub repo_path: String,
    pub account_id: String,
    pub branch: Option<String>,
    pub base_branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ResultadoRama {
    Opened { id: String, created: bool },
    Diverged { branch: String, ahead: u64, behind: u64, copy: String },
}

/// Lo que `abrir_rama` necesita del mundo: carpetas, git y los espacios de Sloth.
pub trait EntornoPrs {
    fn es_dir(&self, p: &str) -> bool;
    fn rama_actual(&self, cwd: &str) -> Option<String>;
    fn git(&self, cwd: &str, args: &[&str]) -> Result<String, String>;
    fn git_crudo(&self, cwd: &str, args: &[&str]) -> Salida;
    fn agregar_espacio(&self, nuevo: NuevoEspacio) -> Result<EspacioPrs, String>;
    fn mostrar_espacio(&self, id: &str);
    fn registrar(&self, mensaje: &str);
}

pub fn abrir_rama(
    entorno: &dyn EntornoPrs,
    ocupados: &Ocupados,
    espacios: &[EspacioPrs],
    fila: &FilaPr,
    repo: &RepoPrs,
    target: &PrTarget,
    modo: Option<ModoRama>,
) -> Result<ResultadoRama, String> {
    if fila.cross_repo {
        return Err("Es un PR de un fork: abrilo en GitHub.".into());
    }
    let head = fila.head.as_str();
    if !nombre_de_rama_valido(head) {
        return Err("La rama del PR tiene un nombre que no puedo usar.".into());
    }
    let _reserva = ocupados.reservar(target)?;
    let rutas: HashSet<String> = repo.repo_paths.iter().map(|p| normalizar_ruta(p)).collect();
    let candidatos: Vec<&EspacioPrs> = espacios.iter().filter(|w| rutas.contains(&normalizar_ruta(&w.repo_path)) || rutas.contains(&normalizar_ruta(&w.cwd))).collect();
    let abierto = |id: &str, creado: bool| {
        entorno.mostrar_espacio(id);
        Ok(ResultadoRama::Opened { id: id.to_string(), created: creado })
    };
    if let Some(w) = candidatos.iter().find(|w| w.branch.as_deref() == Some(head)) {
        return abierto(&w.id, false);
    }
    for w in &candidatos {
        if entorno.es_dir(&w.cwd) && entorno.rama_actual(&w.cwd).as_deref() == Some(head) {
            return abierto(&w.id, false);
        }
    }

    let ruta_repo = repo.repo_paths.iter().find(|p| entorno.es_dir(p));
    let cuenta = candidatos.iter().find(|w| rutas.contains(&normalizar_ruta(&w.repo_path))).map(|w| w.account_id.clone());
    let (Some(ruta_repo), Some(cuenta)) = (ruta_repo, cuenta) else { return Err("No encuentro la carpeta del repo en tus espacios.".into()) };
    let nombre = format!("PR #{}", fila.number);

    let listado = entorno.git(ruta_repo, &["worktree", "list", "--porcelain"])?;
    if let Some(existente) = worktrees_con_rama(&listado, head).into_iter().find(|p| entorno.es_dir(p)) {
        let ws = entorno.agregar_espacio(NuevoEspacio { name: nombre, repo_path: existente, account_id: cuenta, branch: None, base_branch: None })?;
        return abierto(&ws.id, true);
    }

    let remoto = format!("origin/{head}");
    // Forzado: la rama del PR puede haberse reescrito (rebase, force-push) y el ref de seguimiento tiene que seguirla.
    let f = entorno.git_crudo(ruta_repo, &["fetch", "origin", &format!("+refs/heads/{head}:refs/remotes/{remoto}")]);
    if f.code != 0 {
        return Err(legible(&f, "git fetch"));
    }

    let mut rama = head.to_string();
    let refs_local = format!("refs/heads/{head}");
    let l = entorno.git_crudo(ruta_repo, &["rev-parse", "--verify", "--quiet", &refs_local]);
    if l.code == 0 {
        let local = l.stdout.trim().to_string();
        let conteo = entorno.git(ruta_repo, &["rev-list", "--left-right", "--count", &format!("{refs_local}...refs/remotes/{remoto}")])?;
        let (estado, adelante, atras) = comparar_local(&conteo)?;
        match estado {
            EstadoRamaLocal::Atrasada => {
                // Solo avanza: la rama local no tiene nada que el PR no tenga y no está en ningún worktree.
                entorno.git(ruta_repo, &["update-ref", &refs_local, &format!("refs/remotes/{remoto}"), &local])?;
            }
            EstadoRamaLocal::Divergida => {
                let prefijo = format!("pr-{}", fila.number);
                let salida = entorno.git(ruta_repo, &["for-each-ref", "--format=%(refname:short)", &format!("refs/heads/{prefijo}*")])?;
                let ramas: HashSet<String> = salida.split('\n').map(|l| l.trim_end_matches('\r')).filter(|l| !l.is_empty()).map(String::from).collect();
                let copia = rama_libre(fila.number, &ramas)?;
                match modo {
                    None => return Ok(ResultadoRama::Diverged { branch: head.to_string(), ahead: adelante, behind: atras, copy: copia }),
                    Some(ModoRama::Copia) => rama = copia,
                    Some(ModoRama::Local) => {}
                }
            }
            EstadoRamaLocal::Igual => {}
        }
    }

    let ws = entorno.agregar_espacio(NuevoEspacio { name: nombre, repo_path: ruta_repo.clone(), account_id: cuenta, branch: Some(rama.clone()), base_branch: Some(remoto.clone()) })?;
    if let Err(e) = entorno.git(&ws.cwd, &["branch", "--set-upstream-to", &remoto, &rama]) {
        entorno.registrar(&format!("prs: no se pudo asociar la rama a origin: {e}"));
    }
    abierto(&ws.id, true)
}

// ---------- prs.json ----------

#[derive(Debug, Clone, PartialEq)]
pub struct Guardado {
    pub instantanea: Instantanea,
    pub ids: Vec<(String, String)>,
}

/// Con otra forma de fila el caché rompería la vista: si la versión no es la actual se descarta y se vuelve a leer.
pub fn guardado_desde_json(v: &Value) -> Option<Guardado> {
    let o = v.as_object()?;
    if entero(o.get("version")) != Some(i64::from(VERSION)) {
        return None;
    }
    let mut instantanea = Instantanea::inicial();
    if let Some(s) = objeto(o.get("snapshot")) {
        if let (Some(repos), Some(at)) = (s.get("repos").and_then(Value::as_array), s.get("at").and_then(Value::as_f64)) {
            instantanea.problem = match s.get("problem").and_then(Value::as_str) {
                Some("no-gh") => Some(Problema::NoGh),
                Some("no-login") => Some(Problema::NoLogin),
                Some("no-repos") => Some(Problema::NoRepos),
                _ => None,
            };
            instantanea.login = s.get("login").and_then(Value::as_str).map(String::from);
            instantanea.repos = repos
                .iter()
                .filter(|r| repo_valido_valor(r.get("repo")).is_some() && r.get("prs").is_some_and(Value::is_array) && r.get("repoPaths").is_some_and(Value::is_array))
                .filter_map(|r| serde_json::from_value::<RepoPrs>(r.clone()).ok())
                .collect();
            instantanea.at = at.max(0.0) as u64;
        }
    }
    let ids = objeto(o.get("ids")).map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect()).unwrap_or_default();
    Some(Guardado { instantanea, ids })
}

pub fn guardado_a_json(snap: &Instantanea, ids: &[(String, String)]) -> Value {
    let ids: Map<String, Value> = ids.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
    json!({
        "version": VERSION,
        "snapshot": { "problem": snap.problem, "login": snap.login, "repos": snap.repos, "at": snap.at },
        "ids": ids
    })
}

pub fn cargar(ruta: &Path, avisos: &Avisos) -> Guardado {
    let validar = |v: &Value| v.is_object().then(|| v.clone());
    let por_defecto = || Value::Object(Map::new());
    let leido = leer_json(ruta, &OpcionesLectura::nuevas(&validar, &por_defecto), avisos).valor;
    guardado_desde_json(&leido).unwrap_or(Guardado { instantanea: Instantanea::inicial(), ids: Vec::new() })
}

pub fn guardar(ruta: &Path, snap: &Instantanea, ids: &[(String, String)]) -> std::io::Result<bool> {
    escribir_json_atomico(ruta, &guardado_a_json(snap, ids))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;

    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SHA2: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn remoto_de_github_reconoce_https_ssh_y_scp() {
        assert_eq!(remoto_de_github("https://github.com/o/r.git").as_deref(), Some("o/r"));
        assert_eq!(remoto_de_github("https://github.com/o/r").as_deref(), Some("o/r"));
        assert_eq!(remoto_de_github("git@github.com:o/r.git").as_deref(), Some("o/r"));
        assert_eq!(remoto_de_github("ssh://git@github.com/o/r.git").as_deref(), Some("o/r"));
        assert_eq!(remoto_de_github("https://gitlab.com/o/r.git"), None);
        assert_eq!(remoto_de_github("cualquier cosa"), None);
        assert_eq!(remoto_de_github("https://github.com/o/r;rm.git"), None);
    }

    #[test]
    fn target_valido_acepta_un_pr_valido_y_rechaza_basura() {
        assert_eq!(target_valido(&json!({ "repo": "o/r", "number": 12 })).unwrap(), PrTarget { repo: "o/r".into(), number: 12 });
        for malo in [
            json!({ "repo": "o/r;rm", "number": 1 }),
            json!({ "repo": "../x", "number": 1 }),
            json!({ "repo": "o/r", "number": 0 }),
            json!({ "repo": "o/r", "number": 1.5 }),
            json!({ "repo": "o/r", "number": "3" }),
            json!("o/r#3"),
        ] {
            assert!(target_valido(&malo).is_err(), "{malo}");
        }
        assert_eq!(target_valido(&json!({ "repo": "o/r", "number": 1.0 })).unwrap().number, 1);
        assert_eq!(target_valido(&json!("x")).unwrap_err(), "PR inválido.");
        assert_eq!(target_valido(&json!({ "repo": "o/r", "number": 10_000_001 })).unwrap_err(), "Número de PR inválido.");
    }

    #[test]
    fn limpiar_texto_saca_caracteres_de_control_e_invisibles_y_corta() {
        assert_eq!(limpiar_texto("a\u{202E}b\u{200B}c\nd\x1b[31me", 100), "abc d [31me");
        assert_eq!(limpiar_texto("abcdef", 3), "abc");
        assert_eq!(limpiar_valor(Some(&json!(42)), 10), "");
    }

    #[test]
    fn checks_sin_checks_es_none() {
        assert_eq!(resumir_checks(&[], None), ResumenChecks { state: EstadoChecks::None, counts: ConteoChecks::default(), failing: vec![] });
    }

    #[test]
    fn un_fallo_gana_a_un_pendiente_y_trae_su_link() {
        let r = resumir_checks(
            &[
                json!({ "__typename": "CheckRun", "name": "build", "status": "COMPLETED", "conclusion": "FAILURE", "detailsUrl": "https://ci/1" }),
                json!({ "__typename": "StatusContext", "context": "lint", "state": "PENDING", "targetUrl": "https://ci/2" }),
                json!({ "__typename": "CheckRun", "name": "skip", "status": "COMPLETED", "conclusion": "SKIPPED", "detailsUrl": null }),
            ],
            None,
        );
        assert_eq!(r.state, EstadoChecks::Fail);
        assert_eq!(r.counts, ConteoChecks { ok: 1, fail: 1, pending: 1 });
        assert_eq!(r.failing, vec![CheckPr { name: "build".into(), url: Some("https://ci/1".into()) }]);
    }

    #[test]
    fn solo_pendientes_es_pending_y_una_url_que_no_es_https_queda_en_null() {
        assert_eq!(resumir_checks(&[json!({ "__typename": "CheckRun", "name": "a", "status": "IN_PROGRESS" })], None).state, EstadoChecks::Pending);
        let r = resumir_checks(&[json!({ "__typename": "StatusContext", "context": "x", "state": "ERROR", "targetUrl": "javascript:alert(1)" })], None);
        assert_eq!(r.failing, vec![CheckPr { name: "x".into(), url: None }]);
    }

    #[test]
    fn el_estado_del_rollup_gana_a_los_contextos_leidos() {
        let ok = [json!({ "__typename": "CheckRun", "name": "a", "status": "COMPLETED", "conclusion": "SUCCESS" })];
        let estado = |r: &str| resumir_checks(&ok, Some(&json!(r))).state;
        assert_eq!(estado("FAILURE"), EstadoChecks::Fail);
        assert_eq!(estado("ERROR"), EstadoChecks::Fail);
        assert_eq!(estado("PENDING"), EstadoChecks::Pending);
        assert_eq!(estado("SUCCESS"), EstadoChecks::Ok);
        let mal = [json!({ "__typename": "CheckRun", "name": "b", "status": "COMPLETED", "conclusion": "FAILURE" })];
        assert_eq!(resumir_checks(&mal, Some(&json!("PENDING"))).state, EstadoChecks::Fail);
    }

    #[test]
    fn el_nombre_de_un_check_fallido_sin_nombre_es_check_y_se_cortan_en_cinco() {
        let c = |n: &str| json!({ "__typename": "CheckRun", "name": n, "status": "COMPLETED", "conclusion": "TIMED_OUT" });
        let r = resumir_checks(&[c(""), c("a"), c("b"), c("c"), c("d"), c("e"), c("f")], None);
        assert_eq!(r.counts.fail, 7);
        assert_eq!(r.failing.len(), 5);
        assert_eq!(r.failing[0].name, "check");
    }

    fn pr(extra: Value) -> Value {
        let mut base = json!({
            "id": "PR_kwABC", "number": 1, "title": "Arreglo", "url": "https://github.com/o/r/pull/1", "isDraft": false,
            "baseRefName": "staging", "headRefName": "fix/algo", "isCrossRepository": false, "updatedAt": "2026-11-16T10:00:00Z",
            "author": { "login": "yo" }, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "reviewDecision": "APPROVED",
            "reviewRequests": { "nodes": [] },
            "commits": { "nodes": [{ "commit": { "oid": SHA, "statusCheckRollup": { "state": "SUCCESS", "contexts": { "nodes": [] } } } }] }
        });
        for (k, v) in extra.as_object().unwrap() {
            base[k] = v.clone();
        }
        base
    }

    #[test]
    fn arma_filas_descarta_urls_de_otro_host_y_lee_metodos_de_merge() {
        let json = json!({ "data": {
            "viewer": { "login": "yo" },
            "repository": {
                "mergeCommitAllowed": false, "squashMergeAllowed": true, "rebaseMergeAllowed": false,
                "defaultBranchRef": { "name": "main" },
                "pullRequests": { "nodes": [
                    pr(json!({})),
                    pr(json!({ "id": "PR_2", "number": 2, "url": "https://github.com/o/r/pull/2", "author": { "login": "otra" },
                        "reviewRequests": { "nodes": [{ "requestedReviewer": { "login": "yo" } }] }, "reviewDecision": null,
                        "mergeable": "CONFLICTING", "commits": { "nodes": [{ "commit": { "oid": SHA2 } }] } })),
                    pr(json!({ "id": "PR_3", "number": 3, "url": "https://evil.com/o/r/pull/3" })),
                    pr(json!({ "id": "PR_4", "number": 4, "url": "https://github.com/o/r/pull/4", "commits": { "nodes": [{ "commit": { "oid": "nope" } }] } }))
                ] }
            }
        } });
        let r = leer_respuesta_de_texto(&json.to_string(), "o/r").unwrap();
        assert_eq!(r.login, "yo");
        assert_eq!(r.merge_methods, vec![MetodoMerge::Squash]);
        assert_eq!(r.default_branch.as_deref(), Some("main"));
        assert_eq!(r.prs.iter().map(|p| p.number).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(r.ids, BTreeMap::from([(1, "PR_kwABC".to_string()), (2, "PR_2".to_string())]));
        let (a, b) = (&r.prs[0], &r.prs[1]);
        assert!(a.mine);
        assert!(!a.review_requested_from_me);
        assert_eq!(a.review, EstadoReview::Approved);
        assert_eq!(a.checks, EstadoChecks::None);
        assert!(!b.mine);
        assert!(b.review_requested_from_me);
        assert_eq!(b.review, EstadoReview::None);
        assert_eq!(b.mergeable, Mergeable::Conflict);
        assert_eq!(b.head_sha, SHA2);
        assert_eq!(a.merge_state, "CLEAN");
    }

    #[test]
    fn json_roto_o_sin_repo_tira_un_error_legible() {
        assert!(leer_respuesta_de_texto("{nope", "o/r").unwrap_err().contains("no se pudo leer"));
        let e = leer_respuesta(&json!({ "data": { "repository": null }, "errors": [{ "message": "Could not resolve" }] }), "o/r").unwrap_err();
        assert_eq!(e, "GitHub: Could not resolve");
        assert_eq!(leer_respuesta(&json!({ "data": null }), "o/r").unwrap_err(), "No encontré el repo en GitHub o no tenés acceso.");
        assert!(leer_respuesta(&json!([1]), "o/r").is_err());
    }

    #[test]
    fn un_merge_state_raro_queda_en_unknown() {
        let json = json!({ "data": { "viewer": { "login": "" }, "repository": { "pullRequests": { "nodes": [pr(json!({ "mergeStateStatus": "clean<b>" }))] } } } });
        let r = leer_respuesta(&json, "o/r").unwrap();
        assert_eq!(r.prs[0].merge_state, "UNKNOWN");
        assert!(!r.prs[0].mine);
        assert_eq!(r.default_branch, None);
    }

    #[test]
    fn el_merge_nunca_fuerza_y_pasa_el_commit_a_match_head_commit() {
        let t = PrTarget { repo: "o/r".into(), number: 7 };
        let args = args_de_merge(&t, "squash", SHA).unwrap();
        assert_eq!(args, ["pr", "merge", "7", "--repo", "o/r", "--squash", "--match-head-commit", SHA]);
        for f in ["--admin", "--auto", "--delete-branch"] {
            assert!(!args.iter().any(|a| a == f));
        }
        assert!(args_de_merge(&t, "squash", "HEAD").is_err());
        assert!(args_de_merge(&t, "forzado", SHA).is_err());
    }

    #[test]
    fn actualizar_rama_y_consulta_validan_sus_datos() {
        assert_eq!(args_de_actualizar_rama("PR_kwABC", SHA).unwrap().last().unwrap(), &format!("sha={SHA}"));
        assert!(args_de_actualizar_rama("a b", SHA).is_err());
        let q = args_de_consulta("o", "r").unwrap();
        assert_eq!(&q[q.len() - 4..], ["-f", "owner=o", "-f", "name=r"]);
        assert!(args_de_consulta("..", "r").is_err());
    }

    #[test]
    fn worktrees_con_rama_encuentra_la_carpeta_que_tiene_la_rama() {
        let out = "worktree C:/repo\nHEAD 1\nbranch refs/heads/main\n\nworktree C:/wt/x\nHEAD 2\nbranch refs/heads/fix/x\n\n";
        assert_eq!(worktrees_con_rama(out, "fix/x"), vec!["C:/wt/x"]);
        assert!(worktrees_con_rama(out, "fix").is_empty());
        assert_eq!(worktrees_con_rama(&out.replace('\n', "\r\n"), "main"), vec!["C:/repo"]);
    }

    #[test]
    fn head_visto_solo_deja_pasar_el_commit_que_el_usuario_vio() {
        assert_eq!(head_visto(SHA, &json!(SHA)).unwrap(), SHA);
        assert!(head_visto(SHA2, &json!(SHA)).unwrap_err().contains("cambió"));
        assert!(head_visto(SHA, &Value::Null).unwrap_err().contains("inválido"));
        assert!(head_visto(SHA, &json!("HEAD")).unwrap_err().contains("inválido"));
    }

    #[test]
    fn comparar_local_distingue_igual_atrasada_y_divergida() {
        assert_eq!(comparar_local("0\t0\n").unwrap(), (EstadoRamaLocal::Igual, 0, 0));
        assert_eq!(comparar_local("0\t3").unwrap(), (EstadoRamaLocal::Atrasada, 0, 3));
        assert_eq!(comparar_local("2\t0").unwrap(), (EstadoRamaLocal::Divergida, 2, 0));
        assert_eq!(comparar_local("1 4").unwrap(), (EstadoRamaLocal::Divergida, 1, 4));
        assert!(comparar_local("fatal: bad revision").is_err());
    }

    #[test]
    fn rama_libre_busca_un_pr_n_libre_sin_pisar_ramas_existentes() {
        assert_eq!(rama_libre(7, &HashSet::new()).unwrap(), "pr-7");
        assert_eq!(rama_libre(7, &HashSet::from(["pr-7".to_string(), "pr-7-2".to_string()])).unwrap(), "pr-7-3");
        let todas: HashSet<String> = std::iter::once("pr-7".to_string()).chain((2..50).map(|i| format!("pr-7-{i}"))).collect();
        assert!(rama_libre(7, &todas).is_err());
    }

    fn fila(n: u32, base: &str, head: &str) -> FilaPr {
        let v = pr(json!({ "number": n, "url": format!("https://github.com/o/r/pull/{n}"), "baseRefName": base, "headRefName": head }));
        fila_de_nodo(&v, "o/r", "yo").unwrap().0
    }

    fn repo_con(prs: Vec<FilaPr>) -> RepoPrs {
        RepoPrs { repo: "o/r".into(), repo_paths: vec!["C:\\repos\\r".into()], default_branch: Some("main".into()), merge_methods: vec![MetodoMerge::Squash], prs, error: None }
    }

    #[test]
    fn el_rebase_se_bloquea_en_ramas_protegidas_y_con_dependientes() {
        let a = fila(1, "staging", "fix/a");
        let r = repo_con(vec![a.clone()]);
        assert_eq!(bloqueo_de_rebase(&a, &r), None);
        let en_main = fila(2, "staging", "main");
        assert_eq!(bloqueo_de_rebase(&en_main, &repo_con(vec![en_main.clone()])).unwrap(), "main es la rama por defecto del repo.");
        let en_staging = fila(3, "main", "staging");
        assert_eq!(bloqueo_de_rebase(&en_staging, &repo_con(vec![en_staging.clone()])).unwrap(), "staging es una rama protegida.");
        let b = fila(4, "fix/a", "fix/b");
        assert_eq!(bloqueo_de_rebase(&a, &repo_con(vec![a.clone(), b])).unwrap(), "Otros PR salen de fix/a.");
        let mut sin_rama = repo_con(vec![a.clone()]);
        sin_rama.default_branch = None;
        assert!(bloqueo_de_rebase(&a, &sin_rama).unwrap().contains("rama por defecto"));
    }

    #[test]
    fn el_rebase_de_un_fork_depende_de_que_deje_modificar() {
        let mut f = fila(1, "main", "x");
        f.cross_repo = true;
        let r = repo_con(vec![f.clone()]);
        assert!(bloqueo_de_rebase(&f, &r).unwrap().contains("fork"));
        f.maintainer_can_modify = true;
        assert_eq!(bloqueo_de_rebase(&f, &r), None);
    }

    fn instantanea_con(r: RepoPrs) -> Instantanea {
        Instantanea { problem: None, login: Some("yo".into()), repos: vec![r], at: 5, refreshing: false }
    }

    #[test]
    fn fila_de_exige_que_el_repo_siga_en_uso_por_un_espacio() {
        let snap = instantanea_con(repo_con(vec![fila(1, "staging", "fix/a")]));
        let en_uso = vec!["c:/repos/r/".to_string()];
        assert!(fila_de(&snap, &json!({ "repo": "o/r", "number": 1 }), &en_uso).is_ok());
        for (x, rutas) in [(json!({ "repo": "o/r", "number": 2 }), &en_uso), (json!({ "repo": "o/r", "number": 1 }), &vec![]), (json!({ "repo": "o/x", "number": 1 }), &en_uso)] {
            assert_eq!(fila_de(&snap, &x, rutas).unwrap_err(), "Ese PR ya no está en la lista. Refrescá.");
        }
        assert_eq!(fila_de(&snap, &json!({ "repo": "o/r", "number": 0 }), &en_uso).unwrap_err(), "Número de PR inválido.");
    }

    #[test]
    fn metodo_de_pide_un_metodo_habilitado_y_un_pr_que_no_sea_borrador() {
        let f = fila(1, "staging", "fix/a");
        let r = repo_con(vec![f.clone()]);
        assert_eq!(metodo_de(&r, &f, &json!("squash")).unwrap(), MetodoMerge::Squash);
        assert!(metodo_de(&r, &f, &json!("merge")).unwrap_err().contains("no está habilitado"));
        assert!(metodo_de(&r, &f, &json!(3)).is_err());
        let mut borrador = f;
        borrador.is_draft = true;
        assert_eq!(metodo_de(&r, &borrador, &json!("squash")).unwrap_err(), "Es un borrador.");
    }

    #[test]
    fn url_permitida_es_la_del_pr_o_la_de_un_check_fallido() {
        let mut f = fila(1, "staging", "fix/a");
        f.failing = vec![CheckPr { name: "build".into(), url: Some("https://ci/1".into()) }, CheckPr { name: "x".into(), url: None }];
        assert_eq!(url_permitida(&f, &json!("https://github.com/o/r/pull/1")).unwrap(), "https://github.com/o/r/pull/1");
        assert_eq!(url_permitida(&f, &json!("https://ci/1")).unwrap(), "https://ci/1");
        assert_eq!(url_permitida(&f, &json!("https://evil.com")).unwrap_err(), "Ese link no es de este PR.");
        assert_eq!(url_permitida(&f, &Value::Null).unwrap_err(), "Ese link no es de este PR.");
        f.url = "http://github.com/o/r/pull/1".into();
        assert_eq!(url_permitida(&f, &json!("http://github.com/o/r/pull/1")).unwrap_err(), "Solo se abren links https.");
    }

    #[test]
    fn comando_de_merge_antepone_gh_y_valida_el_commit() {
        let f = fila(1, "staging", "fix/a");
        let r = repo_con(vec![f.clone()]);
        let t = PrTarget { repo: "o/r".into(), number: 1 };
        let c = comando_de_merge(&r, &f, &t, &json!("squash"), &json!(SHA)).unwrap();
        assert_eq!(c[0], "gh");
        assert_eq!(&c[1..3], ["pr", "merge"]);
        assert!(comando_de_merge(&r, &f, &t, &json!("squash"), &json!(SHA2)).is_err());
    }

    #[test]
    fn modo_valido_acepta_local_copy_o_nada() {
        assert_eq!(modo_valido(&Value::Null).unwrap(), None);
        assert_eq!(modo_valido(&json!("local")).unwrap(), Some(ModoRama::Local));
        assert_eq!(modo_valido(&json!("copy")).unwrap(), Some(ModoRama::Copia));
        assert_eq!(modo_valido(&json!("otro")).unwrap_err(), "Opción inválida.");
    }

    #[test]
    fn el_refresco_respeta_lo_reciente_lo_forzado_y_lo_en_curso() {
        assert!(!hace_falta_refrescar(false, false, 10_000, 5_000));
        assert!(hace_falta_refrescar(false, false, 40_000, 5_000));
        assert!(hace_falta_refrescar(false, true, 6_000, 5_000));
        assert!(!hace_falta_refrescar(true, true, 99_000, 0));
            }

    #[test]
    fn una_operacion_por_pr_a_la_vez() {
        let o = Ocupados::default();
        let t = PrTarget { repo: "o/r".into(), number: 1 };
        let otro = PrTarget { repo: "o/r".into(), number: 2 };
        {
            let _a = o.reservar(&t).unwrap();
            assert_eq!(o.reservar(&t).err().unwrap(), "Ya hay una operación en curso con ese PR.");
            assert!(o.reservar(&otro).is_ok());
        }
        assert!(o.reservar(&t).is_ok());
    }

    #[test]
    fn fusionar_ids_conserva_los_de_un_repo_que_fallo() {
        let previos = vec![("o/a#1".to_string(), "A1".to_string()), ("o/b#9".to_string(), "B9".to_string()), ("o/b#10".to_string(), "B10".to_string())];
        let leidos = vec![("o/a".to_string(), Some(BTreeMap::from([(2, "A2".to_string())]))), ("o/b".to_string(), None)];
        assert_eq!(
            fusionar_ids(&previos, &leidos),
            vec![("o/a#2".to_string(), "A2".to_string()), ("o/b#9".to_string(), "B9".to_string()), ("o/b#10".to_string(), "B10".to_string())]
        );
    }

    struct Falso(Salida, Mutex<Vec<Vec<String>>>);
    impl Ejecutor for Falso {
        fn ejecutar(&self, cmd: &str, args: &[String], _cwd: Option<&Path>, _t: Duration) -> Salida {
            let mut v = vec![cmd.to_string()];
            v.extend(args.iter().cloned());
            self.1.lock().unwrap().push(v);
            self.0.clone()
        }
    }

    #[test]
    fn leer_repo_conserva_lo_viejo_si_gh_falla() {
        let viejo = repo_con(vec![fila(1, "staging", "fix/a")]);
        let gh = Falso(Salida::error(1, "HTTP 401: Bad credentials"), Mutex::new(vec![]));
        let r = leer_repo(&gh, "o/r", &["C:\\repos\\r".to_string()], Some(&viejo));
        assert_eq!(r.repo.prs.len(), 1);
        assert_eq!(r.repo.error.as_deref(), Some("gh api graphql falló: HTTP 401: Bad credentials"));
        assert!(r.ids.is_none());
        assert_eq!(gh.1.lock().unwrap()[0][..3], ["gh", "api", "graphql"]);
    }

    #[test]
    fn leer_repo_con_error_de_gh_pero_data_completa_igual_usa_la_data() {
        let cuerpo = json!({ "data": { "viewer": { "login": "yo" }, "repository": { "squashMergeAllowed": true, "pullRequests": { "nodes": [pr(json!({}))] } } } });
        let gh = Falso(Salida { code: 1, stdout: cuerpo.to_string(), stderr: "un campo sin permiso".into(), ..Salida::default() }, Mutex::new(vec![]));
        let r = leer_repo(&gh, "o/r", &[], None);
        assert_eq!(r.repo.error, None);
        assert_eq!(r.login, "yo");
        assert_eq!(r.ids.unwrap().get(&1).map(String::as_str), Some("PR_kwABC"));
    }

    #[test]
    fn leer_repo_con_una_respuesta_ilegible_y_gh_en_cero_muestra_el_error_del_parseo() {
        let gh = Falso(Salida::ok("no es json"), Mutex::new(vec![]));
        let r = leer_repo(&gh, "o/r", &[], None);
        assert_eq!(r.repo.error.as_deref(), Some("GitHub devolvió una respuesta que no se pudo leer."));
    }

    #[test]
    fn el_estado_guardado_va_y_vuelve_y_descarta_otra_version() {
        let snap = instantanea_con(repo_con(vec![fila(1, "staging", "fix/a")]));
        let ids = vec![("o/r#1".to_string(), "PR_kwABC".to_string())];
        let v = guardado_a_json(&snap, &ids);
        assert_eq!(v["version"], 2);
        assert_eq!(v["snapshot"].as_object().unwrap().keys().collect::<Vec<_>>(), ["problem", "login", "repos", "at"]);
        assert_eq!(v["snapshot"]["repos"][0]["prs"][0]["headSha"], SHA);
        assert_eq!(v["snapshot"]["repos"][0]["prs"][0]["checkCounts"], json!({ "ok": 0, "fail": 0, "pending": 0 }));
        assert_eq!(v["snapshot"]["problem"], Value::Null);
        let g = guardado_desde_json(&v).unwrap();
        assert_eq!(g.instantanea, snap);
        assert_eq!(g.ids, ids);
        let mut vieja = v.clone();
        vieja["version"] = json!(1);
        assert!(guardado_desde_json(&vieja).is_none());
        assert!(guardado_desde_json(&json!([1])).is_none());
    }

    #[test]
    fn el_estado_guardado_filtra_repos_invalidos_y_problemas_desconocidos() {
        let v = json!({ "version": 2, "snapshot": { "problem": "no-gh", "login": 4, "at": 9, "repos": [
            { "repo": "../x", "prs": [], "repoPaths": [] },
            { "repo": "o/r", "prs": {}, "repoPaths": [] },
            { "repo": "o/r", "prs": [], "repoPaths": ["C:\\r"], "defaultBranch": null, "mergeMethods": ["squash"], "error": null }
        ] }, "ids": { "o/r#1": "PR_1", "o/r#2": 5 } });
        let g = guardado_desde_json(&v).unwrap();
        assert_eq!(g.instantanea.problem, Some(Problema::NoGh));
        assert_eq!(g.instantanea.login, None);
        assert_eq!(g.instantanea.repos.len(), 1);
        assert_eq!(g.instantanea.at, 9);
        assert_eq!(g.ids, vec![("o/r#1".to_string(), "PR_1".to_string())]);
        let g2 = guardado_desde_json(&json!({ "version": 2, "snapshot": { "problem": "raro", "repos": [], "at": 1 } })).unwrap();
        assert_eq!(g2.instantanea.problem, None);
    }

    #[test]
    fn prs_json_se_guarda_y_se_lee_del_disco() {
        let dir = std::env::temp_dir().join(format!("sloth-prs-rs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let ruta = dir.join("prs.json");
        let avisos = Avisos::nuevo();
        assert_eq!(cargar(&ruta, &avisos).instantanea, Instantanea::inicial());
        let snap = instantanea_con(repo_con(vec![fila(1, "staging", "fix/a")]));
        assert!(guardar(&ruta, &snap, &[("o/r#1".into(), "PR_1".into())]).unwrap());
        let g = cargar(&ruta, &avisos);
        assert_eq!(g.instantanea, snap);
        assert_eq!(g.ids.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    struct Mundo {
        dirs: Vec<String>,
        rama_actual: Vec<(String, String)>,
        respuestas: RefCell<VecDeque<(String, Salida)>>,
        llamadas: RefCell<Vec<String>>,
        creados: RefCell<Vec<NuevoEspacio>>,
        mostrados: RefCell<Vec<String>>,
    }

    impl Mundo {
        fn nuevo(respuestas: Vec<(&str, Salida)>) -> Self {
            Mundo {
                dirs: vec!["C:\\repos\\r".into(), "C:\\repos\\r-wt".into()],
                rama_actual: vec![],
                respuestas: RefCell::new(respuestas.into_iter().map(|(k, s)| (k.to_string(), s)).collect()),
                llamadas: RefCell::new(vec![]),
                creados: RefCell::new(vec![]),
                mostrados: RefCell::new(vec![]),
            }
        }

        fn siguiente(&self, args: &[&str]) -> Salida {
            let linea = args.join(" ");
            self.llamadas.borrow_mut().push(linea.clone());
            let (esperado, s) = self.respuestas.borrow_mut().pop_front().unwrap_or_else(|| panic!("llamada inesperada: {linea}"));
            assert!(linea.starts_with(&esperado), "esperaba «{esperado}» y vino «{linea}»");
            s
        }
    }

    impl EntornoPrs for Mundo {
        fn es_dir(&self, p: &str) -> bool {
            self.dirs.iter().any(|d| d == p)
        }
        fn rama_actual(&self, cwd: &str) -> Option<String> {
            self.rama_actual.iter().find(|(c, _)| c == cwd).map(|(_, b)| b.clone())
        }
        fn git(&self, _cwd: &str, args: &[&str]) -> Result<String, String> {
            let s = self.siguiente(args);
            if s.code == 0 { Ok(s.stdout) } else { Err(legible(&s, &format!("git {}", args[0]))) }
        }
        fn git_crudo(&self, _cwd: &str, args: &[&str]) -> Salida {
            self.siguiente(args)
        }
        fn agregar_espacio(&self, nuevo: NuevoEspacio) -> Result<EspacioPrs, String> {
            self.creados.borrow_mut().push(nuevo.clone());
            Ok(EspacioPrs { id: "nuevo".into(), repo_path: nuevo.repo_path.clone(), cwd: nuevo.repo_path, branch: nuevo.branch, account_id: nuevo.account_id })
        }
        fn mostrar_espacio(&self, id: &str) {
            self.mostrados.borrow_mut().push(id.to_string());
        }
        fn registrar(&self, _m: &str) {}
    }

    fn espacio(id: &str, rama: Option<&str>) -> EspacioPrs {
        EspacioPrs { id: id.into(), repo_path: "C:\\repos\\r".into(), cwd: "C:\\repos\\r".into(), branch: rama.map(String::from), account_id: "cuenta1".into() }
    }

    fn correr(mundo: &Mundo, espacios: &[EspacioPrs], f: &FilaPr, modo: Option<ModoRama>) -> Result<ResultadoRama, String> {
        let repo = repo_con(vec![f.clone()]);
        abrir_rama(mundo, &Ocupados::default(), espacios, f, &repo, &PrTarget { repo: "o/r".into(), number: f.number }, modo)
    }

    #[test]
    fn abrir_rama_reusa_el_espacio_que_ya_tiene_la_rama() {
        let m = Mundo::nuevo(vec![]);
        let r = correr(&m, &[espacio("e1", Some("fix/algo"))], &fila(1, "staging", "fix/algo"), None).unwrap();
        assert_eq!(r, ResultadoRama::Opened { id: "e1".into(), created: false });
        assert_eq!(*m.mostrados.borrow(), vec!["e1"]);
    }

    #[test]
    fn abrir_rama_reusa_el_espacio_cuya_carpeta_esta_en_esa_rama() {
        let mut m = Mundo::nuevo(vec![]);
        m.rama_actual = vec![("C:\\repos\\r".into(), "fix/algo".into())];
        let r = correr(&m, &[espacio("e1", Some("otra"))], &fila(1, "staging", "fix/algo"), None).unwrap();
        assert_eq!(r, ResultadoRama::Opened { id: "e1".into(), created: false });
    }

    #[test]
    fn abrir_rama_rechaza_forks_y_nombres_raros_y_pide_un_espacio_del_repo() {
        let m = Mundo::nuevo(vec![]);
        let mut f = fila(1, "staging", "fix/algo");
        f.cross_repo = true;
        assert_eq!(correr(&m, &[], &f, None).unwrap_err(), "Es un PR de un fork: abrilo en GitHub.");
        let raro = fila(2, "staging", "a b");
        assert_eq!(correr(&m, &[], &raro, None).unwrap_err(), "La rama del PR tiene un nombre que no puedo usar.");
        let ok = fila(3, "staging", "fix/algo");
        assert_eq!(correr(&m, &[], &ok, None).unwrap_err(), "No encuentro la carpeta del repo en tus espacios.");
    }

    #[test]
    fn abrir_rama_usa_el_worktree_existente_sin_hacer_fetch() {
        let m = Mundo::nuevo(vec![("worktree list", Salida::ok("worktree C:\\repos\\r-wt\nbranch refs/heads/fix/algo\n\n"))]);
        let r = correr(&m, &[espacio("e1", Some("otra"))], &fila(1, "staging", "fix/algo"), None).unwrap();
        assert_eq!(r, ResultadoRama::Opened { id: "nuevo".into(), created: true });
        let c = m.creados.borrow();
        assert_eq!(c[0], NuevoEspacio { name: "PR #1".into(), repo_path: "C:\\repos\\r-wt".into(), account_id: "cuenta1".into(), branch: None, base_branch: None });
    }

    #[test]
    fn abrir_rama_sin_rama_local_trae_la_remota_y_crea_el_espacio() {
        let m = Mundo::nuevo(vec![
            ("worktree list", Salida::ok("")),
            ("fetch origin +refs/heads/fix/algo:refs/remotes/origin/fix/algo", Salida::ok("")),
            ("rev-parse", Salida::error(1, "")),
            ("branch --set-upstream-to origin/fix/algo fix/algo", Salida::ok("")),
        ]);
        let r = correr(&m, &[espacio("e1", Some("otra"))], &fila(1, "staging", "fix/algo"), None).unwrap();
        assert_eq!(r, ResultadoRama::Opened { id: "nuevo".into(), created: true });
        let c = m.creados.borrow();
        assert_eq!(c[0].branch.as_deref(), Some("fix/algo"));
        assert_eq!(c[0].base_branch.as_deref(), Some("origin/fix/algo"));
    }

    #[test]
    fn abrir_rama_con_el_fetch_roto_tira_el_error_legible() {
        let m = Mundo::nuevo(vec![("worktree list", Salida::ok("")), ("fetch", Salida::error(128, "fatal: Authentication failed"))]);
        let e = correr(&m, &[espacio("e1", Some("otra"))], &fila(1, "staging", "fix/algo"), None).unwrap_err();
        assert!(e.starts_with("No se pudo conectar con el remoto"));
        assert!(m.creados.borrow().is_empty());
    }

    #[test]
    fn abrir_rama_atrasada_avanza_la_local_con_update_ref() {
        let m = Mundo::nuevo(vec![
            ("worktree list", Salida::ok("")),
            ("fetch", Salida::ok("")),
            ("rev-parse", Salida::ok(&format!("{SHA}\n"))),
            ("rev-list", Salida::ok("0\t2\n")),
            (&format!("update-ref refs/heads/fix/algo refs/remotes/origin/fix/algo {SHA}"), Salida::ok("")),
            ("branch --set-upstream-to", Salida::error(1, "no pude")),
        ]);
        let r = correr(&m, &[espacio("e1", Some("otra"))], &fila(1, "staging", "fix/algo"), None).unwrap();
        assert_eq!(r, ResultadoRama::Opened { id: "nuevo".into(), created: true });
    }

    fn divergida(modo: Option<ModoRama>, extra: Vec<(&str, Salida)>) -> (Mundo, Result<ResultadoRama, String>) {
        let mut pasos = vec![
            ("worktree list", Salida::ok("")),
            ("fetch", Salida::ok("")),
            ("rev-parse", Salida::ok(&format!("{SHA}\n"))),
            ("rev-list", Salida::ok("2\t1\n")),
            ("for-each-ref --format=%(refname:short) refs/heads/pr-1*", Salida::ok("pr-1\n")),
        ];
        pasos.extend(extra);
        let m = Mundo::nuevo(pasos);
        let r = correr(&m, &[espacio("e1", Some("otra"))], &fila(1, "staging", "fix/algo"), modo);
        (m, r)
    }

    #[test]
    fn abrir_rama_divergida_sin_modo_pregunta_con_la_copia_libre() {
        let (m, r) = divergida(None, vec![]);
        assert_eq!(r.unwrap(), ResultadoRama::Diverged { branch: "fix/algo".into(), ahead: 2, behind: 1, copy: "pr-1-2".into() });
        assert!(m.creados.borrow().is_empty());
    }

    #[test]
    fn abrir_rama_divergida_con_copia_crea_el_espacio_en_pr_n() {
        let (m, r) = divergida(Some(ModoRama::Copia), vec![("branch --set-upstream-to origin/fix/algo pr-1-2", Salida::ok(""))]);
        assert_eq!(r.unwrap(), ResultadoRama::Opened { id: "nuevo".into(), created: true });
        assert_eq!(m.creados.borrow()[0].branch.as_deref(), Some("pr-1-2"));
    }

    #[test]
    fn abrir_rama_divergida_con_local_usa_la_rama_del_pr() {
        let (m, r) = divergida(Some(ModoRama::Local), vec![("branch --set-upstream-to origin/fix/algo fix/algo", Salida::ok(""))]);
        assert!(r.is_ok());
        assert_eq!(m.creados.borrow()[0].branch.as_deref(), Some("fix/algo"));
    }

    #[test]
    fn el_resultado_de_abrir_rama_se_serializa_como_en_el_ts() {
        assert_eq!(serde_json::to_value(ResultadoRama::Opened { id: "e".into(), created: true }).unwrap(), json!({ "kind": "opened", "id": "e", "created": true }));
        assert_eq!(
            serde_json::to_value(ResultadoRama::Diverged { branch: "b".into(), ahead: 1, behind: 2, copy: "pr-1".into() }).unwrap(),
            json!({ "kind": "diverged", "branch": "b", "ahead": 1, "behind": 2, "copy": "pr-1" })
        );
    }

    #[test]
    fn abrir_rama_no_deja_dos_operaciones_sobre_el_mismo_pr() {
        let m = Mundo::nuevo(vec![]);
        let o = Ocupados::default();
        let f = fila(1, "staging", "fix/algo");
        let repo = repo_con(vec![f.clone()]);
        let t = PrTarget { repo: "o/r".into(), number: 1 };
        let _reserva = o.reservar(&t).unwrap();
        assert_eq!(abrir_rama(&m, &o, &[espacio("e1", Some("fix/algo"))], &f, &repo, &t, None).unwrap_err(), "Ya hay una operación en curso con ese PR.");
    }
}
