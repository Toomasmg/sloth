//! Lógica de «Ramas aparte» (git worktrees) sin Electron. Equivale a src/main/features/worktrees-scan.ts.
//! Todo con git sin shell. El escaneo reparte las ramas en hasta 4 hilos, igual que el `pool` del original.
use crate::git_ops::{default_base, parse_porcelain, resolver};
use crate::git_run::{norm_path, valid_branch_name, Ejecutor, Git, GitError, OpcionesRun, Programa};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const BASE_CANDIDATES: [&str; 4] = ["staging", "develop", "main", "master"];
/// PR mergeado de una rama, por 5 minutos: gh es lento y el escaneo se pide cada vez que se abre el panel.
const GH_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WorktreeEntry {
    pub path: String,
    pub head: Option<String>,
    /// Nombre corto (sin refs/heads/).
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
    pub locked: bool,
    pub prunable: bool,
}

pub fn parse_worktree_list(out: &str) -> Vec<WorktreeEntry> {
    let mut list = Vec::new();
    let mut cur: Option<WorktreeEntry> = None;
    for raw in out.split('\n') {
        let line = raw.trim_end();
        if line.is_empty() {
            if let Some(c) = cur.take() {
                list.push(c);
            }
            continue;
        }
        let (key, val) = match line.find(' ') {
            Some(sp) => (&line[..sp], &line[sp + 1..]),
            None => (line, ""),
        };
        if key == "worktree" {
            if let Some(c) = cur.take() {
                list.push(c);
            }
            cur = Some(WorktreeEntry { path: resolver(val, "").to_string_lossy().into_owned(), ..Default::default() });
            continue;
        }
        let Some(c) = cur.as_mut() else { continue };
        match key {
            "HEAD" => c.head = Some(val.to_string()),
            "branch" => c.branch = Some(val.strip_prefix("refs/heads/").unwrap_or(val).to_string()),
            "bare" => c.bare = true,
            "detached" => c.detached = true,
            "locked" => c.locked = true,
            "prunable" => c.prunable = true,
            _ => {}
        }
    }
    if let Some(c) = cur {
        list.push(c);
    }
    list
}

/// Un espacio de Sloth, con lo que hace falta para asociarlo a una carpeta.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WsRef {
    pub id: String,
    pub name: String,
    pub repo_path: String,
    pub cwd: String,
    /// Nombre de la cuenta (solo para mostrarla).
    pub account_label: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceRef {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PrMerge {
    pub number: u64,
    pub url: String,
}

/// Una fila de «Ramas aparte»: la copia principal o una rama aparte.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRow {
    /// Id del repo (owner/nombre del remoto, o nombre de la carpeta).
    pub repo: String,
    pub path: String,
    pub branch: Option<String>,
    pub is_main: bool,
    pub exists: bool,
    pub locked: bool,
    /// Archivos con cambios sin confirmar (incluye sin trackear). -1 = no se pudo leer.
    pub changes: i64,
    /// Commits que no están en ningún remoto. -1 = no se pudo saber.
    pub ahead: i64,
    /// La rama del remoto se borró (upstream «[gone]»).
    pub gone: bool,
    /// Ya está en la rama base (por git o por un PR mergeado).
    pub merged: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_by: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr: Option<PrMerge>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_commit_at: Option<u64>,
    pub spaces: Vec<SpaceRef>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoScan {
    pub id: String,
    pub main_path: String,
    /// Rama de la copia principal (la que no se quita nunca).
    pub main_branch: Option<String>,
    /// Ramas desde las que se puede crear una rama aparte (las que existen en el repo).
    pub bases: Vec<String>,
    /// Rama base por defecto (staging, origin/HEAD, main o master).
    pub default_base: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// La primera es la copia principal.
    pub rows: Vec<BranchRow>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct MergedPr {
    number: u64,
    url: String,
    head_ref_oid: Option<String>,
}

fn ms(n: u64) -> OpcionesRun {
    OpcionesRun::timeout(n)
}

fn termina_en_git(p: &str) -> bool {
    let l = p.to_lowercase();
    l.ends_with("/.git") || l.ends_with("\\.git")
}

/// `owner/nombre` de una URL de remoto (https o scp-like), o None si no se reconoce.
pub fn repo_id_de_url(url: &str) -> Option<String> {
    let t = url.strip_suffix('/').unwrap_or(url);
    let t = t.strip_suffix(".git").unwrap_or(t);
    let (antes, repo) = t.rsplit_once('/')?;
    if repo.is_empty() {
        return None;
    }
    let ini = antes.rfind(['/', ':'])?;
    let owner = &antes[ini + 1..];
    (!owner.is_empty()).then(|| format!("{owner}/{repo}"))
}

pub fn parse_ahead_count(salida: &str) -> i64 {
    salida.trim().parse::<i64>().unwrap_or(0)
}

/// Carpeta hermana de la copia principal para una rama: `<repo>-<rama con - en lugar de />`.
pub fn sibling_folder(main_path: &str, branch: &str) -> String {
    let p = Path::new(main_path.trim_end_matches(['/', '\\']));
    let nombre = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let dir = p.parent().map(Path::to_path_buf).unwrap_or_default();
    dir.join(format!("{nombre}-{}", branch.replace(['\\', '/'], "-"))).to_string_lossy().into_owned()
}

pub struct RamasTomadas<'a> {
    pub main_branch: Option<&'a str>,
    pub branches: &'a [String],
}

/// Error legible para un nombre de rama nuevo, o '' si sirve. `branches` son las ramas locales del repo;
/// `main_branch` la de la copia principal.
pub fn branch_name_error(raw: &str, taken: &RamasTomadas) -> &'static str {
    let b = raw.trim();
    if b.is_empty() {
        return "Poné un nombre para la rama.";
    }
    if b.chars().any(char::is_whitespace) {
        return "Sin espacios: usá guiones o barras (feat/mi-cambio).";
    }
    if !valid_branch_name(b) {
        return "Esa rama no es válida. Usá letras, números, guiones, puntos o barras.";
    }
    if taken.main_branch == Some(b) {
        return "Esa es la copia principal del repo. Elegí otro nombre.";
    }
    if taken.branches.iter().any(|x| x == b) {
        return "Ya hay una rama con ese nombre en este repo.";
    }
    ""
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FolderSize {
    /// Bytes de los archivos contados (node_modules incluido).
    pub bytes: u64,
    /// Se pasó del tiempo: `bytes` es un mínimo («más de»).
    pub partial: bool,
    /// Se canceló (la pantalla se cerró): el número no sirve.
    pub aborted: bool,
}

/// Tamaño de una carpeta, sumando sus archivos. No sigue enlaces ni junctions (si no, se contaría dos veces).
/// Si pasa `deadline` o se cancela por `cancel`, devuelve lo contado hasta ahí.
pub fn folder_size(root: &Path, deadline: Instant, cancel: &AtomicBool) -> FolderSize {
    let mut bytes = 0u64;
    let parar = |bytes: u64| -> Option<FolderSize> {
        if cancel.load(Ordering::SeqCst) {
            return Some(FolderSize { bytes, partial: true, aborted: true });
        }
        (Instant::now() > deadline).then_some(FolderSize { bytes, partial: true, aborted: false })
    };
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        if let Some(f) = parar(bytes) {
            return f;
        }
        // Sin permiso o ya no existe: no suma.
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for (i, e) in rd.flatten().enumerate() {
            if i % 64 == 0 {
                if let Some(f) = parar(bytes) {
                    return f;
                }
            }
            let Ok(md) = fs::symlink_metadata(e.path()) else { continue };
            let ft = md.file_type();
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                pending.push(e.path());
            } else if ft.is_file() {
                bytes += md.len();
            }
        }
    }
    FolderSize { bytes, partial: false, aborted: false }
}

fn pool<T: Sync, R: Send>(items: &[T], n: usize, f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let out: Mutex<Vec<Option<R>>> = Mutex::new((0..items.len()).map(|_| None).collect());
    let i = AtomicUsize::new(0);
    thread::scope(|s| {
        for _ in 0..n.min(items.len()) {
            s.spawn(|| loop {
                let k = i.fetch_add(1, Ordering::SeqCst);
                if k >= items.len() {
                    break;
                }
                let r = f(&items[k]);
                out.lock().unwrap_or_else(|e| e.into_inner())[k] = Some(r);
            });
        }
    });
    out.into_inner().unwrap_or_else(|e| e.into_inner()).into_iter().flatten().collect()
}

pub struct ScanOptions {
    /// Consultar PRs mergeados con gh (por defecto sí, si gh está instalado).
    pub use_gh: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        ScanOptions { use_gh: true }
    }
}

/// El escáner guarda lo que el original tenía en variables del módulo: si gh anda y los PRs mergeados ya consultados.
pub struct Escaner<E: Ejecutor> {
    pub git: Git<E>,
    gh_ok: Mutex<Option<bool>>,
    gh_merged: Mutex<HashMap<String, (Instant, Option<MergedPr>)>>,
}

struct Contexto<'a> {
    id: &'a str,
    main_path: &'a str,
    def: &'a Option<String>,
    tracks: &'a HashMap<String, String>,
    use_gh: bool,
    workspaces: &'a [WsRef],
}

impl<E: Ejecutor> Escaner<E> {
    pub fn new(git: Git<E>) -> Self {
        Escaner { git, gh_ok: Mutex::new(None), gh_merged: Mutex::new(HashMap::new()) }
    }

    fn raw(&self, cwd: &str, args: &[&str], t: u64) -> Result<crate::git_run::Resultado, GitError> {
        self.git.git_raw(cwd, args, ms(t))
    }

    fn ref_exists(&self, repo: &str, r: &str) -> bool {
        self.raw(repo, &["rev-parse", "--verify", "--quiet", r], 10_000).map(|r| r.code == 0).unwrap_or(false)
    }

    /// Repo principal de una carpeta (aunque sea un worktree): padre de --git-common-dir.
    pub fn main_repo_of(&self, path: &str) -> Option<String> {
        if !Path::new(path).exists() {
            return None;
        }
        let r = self.raw(path, &["rev-parse", "--path-format=absolute", "--git-common-dir"], 10_000).ok()?;
        if r.code != 0 {
            return None;
        }
        let common = r.stdout.trim();
        if common.is_empty() || !crate::git_run::es_absoluta(common) {
            return None;
        }
        // Repo normal: <repo>/.git ; bare: la carpeta misma.
        let abs = resolver(common, "");
        if termina_en_git(common) {
            abs.parent().map(|p| p.to_string_lossy().into_owned())
        } else {
            Some(abs.to_string_lossy().into_owned())
        }
    }

    /// Bases que existen en el repo (local o en origin), con la por defecto primero.
    fn bases_of(&self, repo: &str, def: &Option<String>) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for b in BASE_CANDIDATES {
            if self.ref_exists(repo, &format!("refs/remotes/origin/{b}")) || self.ref_exists(repo, &format!("refs/heads/{b}")) {
                out.push(b.to_string());
            }
        }
        match def {
            Some(d) => std::iter::once(d.clone()).chain(out.into_iter().filter(|b| b != d)).collect(),
            None => out,
        }
    }

    /// Nombre del repo para mostrar: owner/nombre del remoto origin; si no hay, el nombre de la carpeta.
    fn repo_id_of(&self, main_path: &str) -> String {
        let url = match self.raw(main_path, &["config", "--get", "remote.origin.url"], 8000) {
            Ok(r) if r.code == 0 => r.stdout.trim().to_string(),
            _ => String::new(),
        };
        repo_id_de_url(&url).unwrap_or_else(|| Path::new(main_path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
    }

    /// Todas las ramas locales (para no repetir nombres al crear).
    pub fn local_branches(&self, repo: &str) -> Vec<String> {
        match self.raw(repo, &["for-each-ref", "--format=%(refname:short)", "refs/heads"], 15_000) {
            Ok(r) if r.code == 0 => r.stdout.split('\n').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
            _ => vec![],
        }
    }

    /// Rama → estado de su upstream (p. ej. «[gone]», «[ahead 2]»). Una sola llamada por repo.
    fn track_map(&self, repo: &str) -> HashMap<String, String> {
        let mut out = HashMap::new();
        let Ok(r) = self.raw(repo, &["for-each-ref", "--format=%(refname:short)%09%(upstream:track)", "refs/heads"], 15_000) else { return out };
        if r.code != 0 {
            return out;
        }
        for line in r.stdout.split('\n') {
            let mut it = line.split('\t');
            let name = it.next().unwrap_or("");
            if !name.is_empty() {
                out.insert(name.to_string(), it.next().unwrap_or("").trim().to_string());
            }
        }
        out
    }

    pub fn count_dirty(&self, path: &str) -> i64 {
        match self.raw(path, &["status", "--porcelain=v1", "-z"], 20_000) {
            Ok(r) if r.code == 0 => parse_porcelain(&r.stdout).len() as i64,
            _ => -1,
        }
    }

    pub fn count_unpushed(&self, path: &str) -> i64 {
        let up = self.raw(path, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], 10_000);
        let rango = match &up {
            Ok(u) if u.code == 0 => Some(format!("{}..HEAD", u.stdout.trim())),
            _ => None,
        };
        let r = match &rango {
            Some(r) => self.raw(path, &["rev-list", "--count", r], 15_000),
            None => self.raw(path, &["rev-list", "--count", "HEAD", "--not", "--remotes"], 15_000),
        };
        match r {
            Ok(r) if r.code == 0 => parse_ahead_count(&r.stdout),
            _ => -1,
        }
    }

    fn gh_available(&self) -> bool {
        let mut ok = self.gh_ok.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(v) = *ok {
            return v;
        }
        let v = self.git.run(Programa::Gh, &["--version"], ms(8000)).map(|r| r.code == 0).unwrap_or(false);
        *ok = Some(v);
        v
    }

    /// Último PR mergeado de la rama (o None). Si gh falla, no se guarda nada y se consulta de nuevo después.
    fn merged_pr_for(&self, repo: &str, cwd: &str, branch: &str) -> Option<MergedPr> {
        let key = format!("{repo}\u{0}{branch}");
        if let Some((at, pr)) = self.gh_merged.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
            if at.elapsed() < GH_TTL {
                return pr.clone();
            }
        }
        let args = ["pr", "list", "--state", "merged", "--head", branch, "--json", "number,url,headRefOid", "--limit", "1"];
        let r = self.git.run(Programa::Gh, &args, ms(20_000).con_cwd(cwd)).ok()?;
        if r.code != 0 {
            return None;
        }
        // Salida rara: se ignora y se guarda «sin PR».
        let pr = serde_json::from_str::<Value>(&r.stdout).ok().and_then(|v| v.get(0).cloned()).and_then(|o| {
            Some(MergedPr {
                number: o.get("number")?.as_u64()?,
                url: o.get("url")?.as_str()?.to_string(),
                head_ref_oid: o.get("headRefOid").and_then(Value::as_str).map(String::from),
            })
        });
        self.gh_merged.lock().unwrap_or_else(|e| e.into_inner()).insert(key, (Instant::now(), pr.clone()));
        pr
    }

    /// Escanea un repo: copia principal + ramas aparte, con su estado real.
    pub fn scan_repo(&self, main_path: &str, workspaces: &[WsRef], opts: &ScanOptions) -> RepoScan {
        let id = self.repo_id_of(main_path);
        let lista = self.git.git(main_path, &["worktree", "list", "--porcelain"], ms(20_000));
        let entries: Vec<WorktreeEntry> = match lista {
            Ok(out) => parse_worktree_list(&out).into_iter().filter(|e| !e.bare).collect(),
            Err(e) => {
                return RepoScan { id, main_path: main_path.into(), main_branch: None, bases: vec![], default_base: None, error: Some(e.mensaje), rows: vec![] };
            }
        };
        let def = default_base(&self.git, main_path).unwrap_or(None);
        let bases = self.bases_of(main_path, &def);
        let tracks = self.track_map(main_path);
        let use_gh = opts.use_gh && self.gh_available();
        let c = Contexto { id: &id, main_path, def: &def, tracks: &tracks, use_gh, workspaces };
        let primera = entries.first().map(|e| e.path.clone());
        let rows = pool(&entries, 4, |e| self.row_of(e, Some(&e.path) == primera.as_ref(), &c));
        RepoScan { main_branch: entries.first().and_then(|e| e.branch.clone()), id, main_path: main_path.into(), bases, default_base: def, error: None, rows }
    }

    fn row_of(&self, e: &WorktreeEntry, is_main: bool, c: &Contexto) -> BranchRow {
        let key = norm_path(&e.path);
        let spaces = c
            .workspaces
            .iter()
            .filter(|w| norm_path(&w.cwd) == key)
            .map(|w| SpaceRef { id: w.id.clone(), name: w.name.clone(), account_label: w.account_label.clone() })
            .collect();
        let mut row = BranchRow {
            repo: c.id.to_string(),
            path: e.path.clone(),
            branch: e.branch.clone(),
            is_main,
            exists: Path::new(&e.path).exists(),
            locked: e.locked,
            changes: 0,
            ahead: 0,
            gone: e.branch.as_ref().is_some_and(|b| c.tracks.get(b).map(String::as_str) == Some("[gone]")),
            merged: false,
            merged_by: None,
            pr: None,
            last_commit_at: None,
            spaces,
        };
        if !row.exists {
            return row;
        }
        row.changes = self.count_dirty(&e.path);
        row.ahead = self.count_unpushed(&e.path);
        if let Ok(lc) = self.raw(&e.path, &["log", "-1", "--format=%ct", "HEAD"], 10_000) {
            if lc.code == 0 {
                if let Some(t) = lc.stdout.trim().parse::<u64>().ok().filter(|t| *t != 0) {
                    row.last_commit_at = Some(t * 1000);
                }
            }
        }
        if let (false, Some(def)) = (is_main, c.def) {
            let remoto = format!("refs/remotes/origin/{def}");
            let def_ref = if self.ref_exists(c.main_path, &remoto) { remoto } else { format!("refs/heads/{def}") };
            let anc = self.raw(&e.path, &["merge-base", "--is-ancestor", "HEAD", &def_ref], 15_000);
            if anc.map(|a| a.code == 0).unwrap_or(false) {
                row.merged = true;
                row.merged_by = Some("git");
            }
        }
        if !is_main && !row.merged && c.use_gh {
            if let Some(branch) = &e.branch {
                if let Some(pr) = self.merged_pr_for(c.main_path, &e.path, branch) {
                    row.pr = Some(PrMerge { number: pr.number, url: pr.url.clone() });
                    row.merged = true;
                    row.merged_by = Some("pr");
                    // Squash/rebase: si el HEAD local es el que se mergeó, no queda nada sin subir.
                    if pr.head_ref_oid.is_some() && pr.head_ref_oid == e.head {
                        row.ahead = 0;
                    }
                }
            }
        }
        row
    }

    /// Repos distintos de los espacios (resolviendo worktrees a su repo principal).
    pub fn repos_of(&self, workspaces: &[WsRef]) -> Vec<String> {
        let mut seen: Vec<(String, String)> = Vec::new();
        for w in workspaces {
            for p in [&w.repo_path, &w.cwd] {
                if p.is_empty() {
                    continue;
                }
                if let Some(main) = self.main_repo_of(p) {
                    let k = norm_path(&main);
                    if !seen.iter().any(|(sk, _)| *sk == k) {
                        seen.push((k, main));
                    }
                }
            }
        }
        seen.into_iter().map(|(_, m)| m).collect()
    }
}

pub fn ahora_s() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn ruta_existe(p: &str) -> bool {
    PathBuf::from(p).exists()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_run::prueba::*;
    use crate::git_run::Resultado;

    fn ws(id: &str, repo: &str, cwd: &str) -> WsRef {
        WsRef { id: id.into(), name: format!("espacio {id}"), repo_path: repo.into(), cwd: cwd.into(), account_label: Some("Tomy".into()) }
    }

    fn git_ok(g: &Git<crate::git_run::ProcesoEjecutor>, dir: &str, args: &[&str]) -> String {
        g.git(dir, args, OpcionesRun::timeout(30_000)).unwrap()
    }

    #[test]
    fn parse_worktree_list_lee_cada_bloque() {
        let sal = "worktree C:/repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree C:/repo-feat\nHEAD def456\nbranch refs/heads/feat/x\nlocked\n\nworktree C:/repo-det\nHEAD 111\ndetached\nprunable gitdir file points to non-existent location\n\nworktree C:/bare\nbare\n";
        let l = parse_worktree_list(sal);
        assert_eq!(l.len(), 4);
        assert_eq!((l[0].branch.as_deref(), l[0].head.as_deref()), (Some("main"), Some("abc123")));
        assert_eq!((l[1].branch.as_deref(), l[1].locked), (Some("feat/x"), true));
        assert!(l[2].detached && l[2].prunable && l[2].branch.is_none());
        assert!(l[3].bare);
        assert!(parse_worktree_list("").is_empty());
        let crlf = parse_worktree_list("worktree C:/a\r\nbranch refs/heads/b\r\n\r\n");
        assert_eq!(crlf[0].branch.as_deref(), Some("b"));
        assert!(parse_worktree_list("HEAD abc\n").is_empty());
    }

    #[test]
    fn repo_id_de_url_reconoce_https_y_scp() {
        assert_eq!(repo_id_de_url("https://github.com/o/r.git").as_deref(), Some("o/r"));
        assert_eq!(repo_id_de_url("https://github.com/o/r/").as_deref(), Some("o/r"));
        assert_eq!(repo_id_de_url("git@github.com:o/r.git").as_deref(), Some("o/r"));
        assert_eq!(repo_id_de_url("C:/x/y").as_deref(), Some("x/y"));
        assert_eq!(repo_id_de_url("solo"), None);
        assert_eq!(repo_id_de_url(""), None);
        assert_eq!(repo_id_de_url("host:repo"), None);
    }

    #[test]
    fn sibling_folder_y_branch_name_error() {
        let s = sibling_folder("C:/Users/t/Sloth", "feat/mi-cambio");
        assert!(s.ends_with("Sloth-feat-mi-cambio"), "{s}");
        assert!(sibling_folder("/a/b/", "x\\y").ends_with("b-x-y"));
        let ramas = vec!["feat/ya".to_string()];
        let t = RamasTomadas { main_branch: Some("main"), branches: &ramas };
        assert_eq!(branch_name_error("  ", &t), "Poné un nombre para la rama.");
        assert_eq!(branch_name_error("a b", &t), "Sin espacios: usá guiones o barras (feat/mi-cambio).");
        assert_eq!(branch_name_error("-x", &t), "Esa rama no es válida. Usá letras, números, guiones, puntos o barras.");
        assert_eq!(branch_name_error("a..b", &t), "Esa rama no es válida. Usá letras, números, guiones, puntos o barras.");
        assert_eq!(branch_name_error("main", &t), "Esa es la copia principal del repo. Elegí otro nombre.");
        assert_eq!(branch_name_error("feat/ya", &t), "Ya hay una rama con ese nombre en este repo.");
        assert_eq!(branch_name_error(" feat/nueva ", &t), "");
    }

    #[test]
    fn folder_size_suma_archivos_y_respeta_el_tope_y_la_cancelacion() {
        let t = Temporal::nueva("sloth-size");
        fs::create_dir_all(t.0.join("a/b")).unwrap();
        fs::write(t.0.join("x.bin"), vec![0u8; 100]).unwrap();
        fs::write(t.0.join("a/y.bin"), vec![0u8; 50]).unwrap();
        fs::write(t.0.join("a/b/z.bin"), vec![0u8; 7]).unwrap();
        let no = AtomicBool::new(false);
        let r = folder_size(&t.0, Instant::now() + Duration::from_secs(10), &no);
        assert_eq!(r, FolderSize { bytes: 157, partial: false, aborted: false });
        let vencido = folder_size(&t.0, Instant::now() - Duration::from_secs(1), &no);
        assert!(vencido.partial && !vencido.aborted);
        let cancelado = folder_size(&t.0, Instant::now() + Duration::from_secs(10), &AtomicBool::new(true));
        assert!(cancelado.partial && cancelado.aborted);
        assert_eq!(folder_size(&t.0.join("nada"), Instant::now() + Duration::from_secs(10), &no).bytes, 0);
    }

    #[test]
    fn pool_conserva_el_orden() {
        let r = pool(&[1, 2, 3, 4, 5, 6, 7], 4, |n| n * 10);
        assert_eq!(r, vec![10, 20, 30, 40, 50, 60, 70]);
        assert!(pool::<i32, i32>(&[], 4, |n| *n).is_empty());
    }

    #[test]
    fn scan_con_ejecutor_simulado_arma_filas_y_cachea_gh() {
        let sim = Simulado::con(|l| {
            if l.prog == Programa::Gh {
                return match l.args[0].as_str() {
                    "--version" => Ok(Resultado::ok("gh version 2\n")),
                    _ => Ok(Resultado::ok(r#"[{"number":7,"url":"https://github.com/o/r/pull/7","headRefOid":"h2"}]"#)),
                };
            }
            let sub = l.sub();
            match sub.as_slice() {
                ["worktree", "list", ..] => Ok(Resultado::ok(&format!("worktree {0}\nHEAD h1\nbranch refs/heads/main\n\nworktree {0}-feat\nHEAD h2\nbranch refs/heads/feat\n", std::env::temp_dir().join("nada-sloth-r").to_string_lossy()))),
                ["config", "--get", ..] => Ok(Resultado::ok("git@github.com:o/r.git\n")),
                ["for-each-ref", f, ..] if f.contains("upstream:track") => Ok(Resultado::ok("main\t\nfeat\t[gone]\n")),
                ["symbolic-ref", ..] => Ok(Resultado::falla(1, "")),
                ["rev-parse", "--verify", "--quiet", r] => Ok(if r.ends_with("origin/main") { Resultado::ok("x\n") } else { Resultado::falla(1, "") }),
                _ => Ok(Resultado::ok("")),
            }
        });
        let e = Escaner::new(Git::new(sim));
        let main = std::env::temp_dir().join("nada-sloth-r").to_string_lossy().into_owned();
        let scan = e.scan_repo(&main, &[], &ScanOptions::default());
        assert_eq!(scan.id, "o/r");
        assert_eq!(scan.main_branch.as_deref(), Some("main"));
        assert_eq!(scan.default_base.as_deref(), Some("main"));
        assert_eq!(scan.bases, vec!["main".to_string()]);
        assert_eq!(scan.rows.len(), 2);
        assert!(scan.rows[0].is_main);
        // Las carpetas no existen: filas mínimas, sin consultar nada más.
        assert!(!scan.rows[1].exists);
        assert!(scan.rows[1].gone);
        assert!(!scan.rows[1].merged);
        assert_eq!(e.git.ejecutor.registro().iter().filter(|l| l.prog == Programa::Gh).count(), 1);
    }

    #[test]
    fn scan_real_con_ramas_aparte_mergeada_sucia_y_con_espacio() {
        let t = Temporal::nueva("sloth-wt");
        let main_dir = t.0.join("repo");
        fs::create_dir_all(&main_dir).unwrap();
        let main = main_dir.to_string_lossy().into_owned();
        let g = git_real();
        repo_con_commit(&g, &main);
        let hecha = t.0.join("repo-hecha").to_string_lossy().into_owned();
        let sucia = t.0.join("repo-sucia").to_string_lossy().into_owned();
        git_ok(&g, &main, &["worktree", "add", "-b", "hecha", &hecha, "main"]);
        git_ok(&g, &main, &["worktree", "add", "-b", "sucia", &sucia, "main"]);
        fs::write(Path::new(&sucia).join("n.txt"), "x").unwrap();
        fs::write(Path::new(&sucia).join("a.txt"), "cambio\n").unwrap();
        git_ok(&g, &sucia, &["add", "a.txt"]);
        git_ok(&g, &sucia, &["commit", "-q", "-m", "avance"]);
        let e = Escaner::new(g);
        assert_eq!(e.main_repo_of(&sucia).map(|p| norm_path(&p)), Some(norm_path(&main)));
        assert_eq!(e.main_repo_of(&main).map(|p| norm_path(&p)), Some(norm_path(&main)));
        assert_eq!(e.main_repo_of(&t.0.join("nada").to_string_lossy()), None);
        let wss = vec![ws("1", &main, &sucia), ws("2", &main, &main)];
        assert_eq!(e.repos_of(&wss).len(), 1);
        let scan = e.scan_repo(&main, &wss, &ScanOptions { use_gh: false });
        assert_eq!(scan.error, None);
        assert_eq!(scan.main_branch.as_deref(), Some("main"));
        assert_eq!(scan.default_base.as_deref(), Some("main"));
        assert_eq!(scan.bases, vec!["main".to_string()]);
        assert_eq!(scan.rows.len(), 3);
        let fila = |b: &str| scan.rows.iter().find(|r| r.branch.as_deref() == Some(b)).unwrap();
        assert!(fila("main").is_main && !fila("main").merged);
        assert_eq!(fila("main").spaces.len(), 1);
        let h = fila("hecha");
        assert!(h.merged && h.merged_by == Some("git") && h.changes == 0 && h.ahead == 1 && h.spaces.is_empty());
        let s = fila("sucia");
        assert!(!s.merged);
        assert_eq!(s.changes, 1);
        assert_eq!(s.spaces.len(), 1);
        assert_eq!(s.spaces[0].account_label.as_deref(), Some("Tomy"));
        assert!(s.last_commit_at.is_some());
        let mut ramas = e.local_branches(&main);
        ramas.sort();
        assert_eq!(ramas, ["hecha", "main", "sucia"]);
        assert_eq!(e.count_dirty(&sucia), 1);
        assert_eq!(e.count_unpushed(&sucia), 2);
        assert_eq!(e.count_dirty(&t.0.join("nada").to_string_lossy()), -1);
        let fuera = Temporal::nueva("sloth-nogit2");
        assert!(e.scan_repo(&fuera.ruta(), &[], &ScanOptions { use_gh: false }).error.is_some());
    }
}
