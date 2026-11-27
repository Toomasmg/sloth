//! La función «worktrees» («Ramas aparte») sin Electron. Equivale a src/main/features/worktrees.ts.
//! Escanea solo a pedido; solo se actúa sobre rutas que salieron del último escaneo. Lo que toca la app entra por
//! `ContextoWorktrees`. Los tamaños se calculan en un hilo aparte y llegan por `emitir_tamano`.
use crate::git_ops::has_ref;
use crate::git_run::{norm_path, readable, Ejecutor, GitError, OpcionesRun};
use crate::worktrees_scan::*;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

type R<T> = Result<T, GitError>;

const SIZE_TTL: Duration = Duration::from_secs(10 * 60);
const SIZE_DEADLINE: Duration = Duration::from_secs(20);
const OCUPADO: &str = "Todavía se está haciendo otra operación. Esperá un momento.";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CuentaRef {
    pub id: String,
    pub label: String,
    pub config_dir: String,
}

/// Lo que hace falta para dar de alta el espacio de una rama nueva (el resto lo completa quien guarda el estado).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NuevoEspacio {
    pub id: String,
    pub name: String,
    pub repo_path: String,
    pub cwd: String,
    pub branch: String,
    pub account_id: String,
    pub created_at: u64,
}

pub trait ContextoWorktrees: Send + Sync + 'static {
    fn espacios(&self) -> Vec<WsRef>;
    fn cuenta(&self, id: &str) -> Option<CuentaRef>;
    /// Con espacios que se van a quitar del estado, sin poder guardar no se toca nada.
    fn exigir_escritura(&self) -> Result<(), String>;
    /// Windows no borra una carpeta que una terminal tiene abierta.
    fn cerrar_terminal(&self, id: &str) -> Result<(), String>;
    fn quitar_espacio(&self, id: &str);
    fn nuevo_id(&self) -> String;
    fn agregar_espacio(&self, e: NuevoEspacio);
    fn ui_recargar(&self);
    fn ui_abrir_panel(&self, id: &str);
    /// Último movimiento del agente de ese espacio (ms), 0 si no hay.
    fn actividad_agente(&self, id: &str) -> u64;
    fn emitir_tamano(&self, path: &str, bytes: Option<u64>, partial: bool);
    fn abrir_carpeta(&self, path: &str) -> String;
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowView {
    #[serde(flatten)]
    pub row: BranchRow,
    /// Último uso: el de sus espacios o el último commit, lo que sea más reciente (ms).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_use_at: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoView {
    pub id: String,
    pub main_path: String,
    pub main_branch: Option<String>,
    pub bases: Vec<String>,
    pub default_base: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub rows: Vec<RowView>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResult {
    pub path: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Nombres de los espacios que se cerraron al quitar la carpeta.
    pub closed_spaces: Vec<String>,
}

fn fallo(path: &str, error: impl Into<String>) -> RemoveResult {
    RemoveResult { path: path.into(), ok: false, error: Some(error.into()), closed_spaces: vec![] }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct SizeView {
    /// None: la carpeta ya no existe.
    pub bytes: Option<u64>,
    /// Se pasó del tiempo: `bytes` es un mínimo («más de»).
    pub partial: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Creada {
    pub path: String,
    pub branch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_id: Option<String>,
}

struct SizeEntry {
    vista: SizeView,
    at: Instant,
    mtime: Option<SystemTime>,
}

#[derive(Default)]
struct Tamanos {
    cache: HashMap<String, SizeEntry>,
    cola: VecDeque<String>,
    encolados: HashSet<String>,
    actual: Option<String>,
    gen: u64,
    corriendo: bool,
    abortar: Option<Arc<AtomicBool>>,
}

#[derive(Default)]
struct Escaneo {
    repos: Vec<RepoScan>,
    /// Ruta normalizada -> (índice del repo, fila).
    filas: HashMap<String, (usize, BranchRow)>,
}

pub struct Worktrees<E: Ejecutor, C: ContextoWorktrees> {
    pub escaner: Escaner<E>,
    ctx: C,
    escaneo: Mutex<Escaneo>,
    escaneando: Mutex<()>,
    ocupado: AtomicBool,
    tamanos: Mutex<Tamanos>,
}

fn clave(p: &str) -> String {
    norm_path(p)
}

fn parse_text<'a>(v: &'a Value, max: usize, what: &str) -> R<&'a str> {
    match v.as_str() {
        Some(s) if !s.is_empty() && s.encode_utf16().count() <= max => Ok(s),
        _ => Err(GitError::nuevo(format!("{what} inválido."))),
    }
}

struct Libre<'a>(&'a AtomicBool);

impl Drop for Libre<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl<E: Ejecutor + 'static, C: ContextoWorktrees> Worktrees<E, C> {
    pub fn new(escaner: Escaner<E>, ctx: C) -> Arc<Self> {
        Arc::new(Worktrees {
            escaner,
            ctx,
            escaneo: Mutex::new(Escaneo::default()),
            escaneando: Mutex::new(()),
            ocupado: AtomicBool::new(false),
            tamanos: Mutex::new(Tamanos::default()),
        })
    }

    fn tomar(&self) -> R<Libre<'_>> {
        if self.ocupado.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return Err(GitError::nuevo(OCUPADO));
        }
        Ok(Libre(&self.ocupado))
    }

    fn vista(&self) -> Vec<RepoView> {
        let esc = self.escaneo.lock().unwrap_or_else(|e| e.into_inner());
        esc.repos
            .iter()
            .map(|r| RepoView {
                id: r.id.clone(),
                main_path: r.main_path.clone(),
                main_branch: r.main_branch.clone(),
                bases: r.bases.clone(),
                default_base: r.default_base.clone(),
                error: r.error.clone(),
                rows: r
                    .rows
                    .iter()
                    .map(|row| {
                        let agente = row.spaces.iter().map(|s| self.ctx.actividad_agente(&s.id)).max().unwrap_or(0);
                        let ultimo = row.last_commit_at.unwrap_or(0).max(agente);
                        RowView { row: row.clone(), last_use_at: (ultimo != 0).then_some(ultimo) }
                    })
                    .collect(),
            })
            .collect()
    }

    pub fn scan(&self) -> Vec<RepoView> {
        // Un segundo pedido mientras se escanea espera y devuelve lo que dejó el primero, sin repetir el trabajo.
        let (guarda, esperando) = match self.escaneando.try_lock() {
            Ok(g) => (g, false),
            Err(_) => (self.escaneando.lock().unwrap_or_else(|e| e.into_inner()), true),
        };
        if !esperando {
            let wss = self.ctx.espacios();
            let repos = self.escaner.repos_of(&wss);
            let out: Vec<RepoScan> = repos.iter().map(|r| self.escaner.scan_repo(r, &wss, &ScanOptions::default())).collect();
            let mut filas = HashMap::new();
            for (i, r) in out.iter().enumerate() {
                for row in &r.rows {
                    filas.insert(clave(&row.path), (i, row.clone()));
                }
            }
            *self.escaneo.lock().unwrap_or_else(|e| e.into_inner()) = Escaneo { repos: out, filas };
        }
        drop(guarda);
        self.vista()
    }

    /// La fila del último escaneo, o un error que pide volver a abrir el panel.
    fn conocida(&self, path: &Value) -> R<(RepoScan, BranchRow)> {
        let Some(p) = path.as_str().filter(|p| !p.is_empty() && p.encode_utf16().count() <= 1024) else { return Err(GitError::nuevo("Ruta inválida.")) };
        let esc = self.escaneo.lock().unwrap_or_else(|e| e.into_inner());
        match esc.filas.get(&clave(p)) {
            Some((i, row)) => Ok((esc.repos[*i].clone(), row.clone())),
            None => Err(GitError::nuevo("Esa rama aparte no está en la última lista. Volvé a abrir «Ramas aparte».")),
        }
    }

    fn olvidar(&self, path: &str) {
        self.escaneo.lock().unwrap_or_else(|e| e.into_inner()).filas.remove(&clave(path));
    }

    /// Quita una rama aparte: cierra sus espacios y borra la carpeta (la rama queda en el repo).
    fn remove_one(&self, path: &Value, force: bool) -> R<RemoveResult> {
        let (repo, row) = self.conocida(path)?;
        let p = path.as_str().unwrap_or_default();
        if row.is_main {
            return Ok(fallo(p, "La copia principal no se quita."));
        }
        if row.locked {
            return Ok(fallo(p, "La carpeta está bloqueada (git worktree lock)."));
        }
        let spaces: Vec<WsRef> = self.ctx.espacios().into_iter().filter(|w| clave(&w.cwd) == clave(&row.path)).collect();
        if !spaces.is_empty() {
            if let Err(e) = self.ctx.exigir_escritura() {
                return Ok(fallo(p, e));
            }
        }
        if !row.exists {
            // La carpeta ya no está: se limpia el registro de git.
            let pr = self.escaner.git.git_raw(&repo.main_path, &["worktree", "prune"], OpcionesRun::timeout(30_000))?;
            if pr.code != 0 {
                return Ok(fallo(p, readable(&pr, "git worktree prune")));
            }
            self.olvidar(p);
            return Ok(RemoveResult { path: p.into(), ok: true, error: None, closed_spaces: vec![] });
        }
        if !force {
            let dirty = self.escaner.count_dirty(&row.path);
            if dirty < 0 {
                return Ok(fallo(p, "No se pudo leer el estado de la carpeta; no se quita."));
            }
            if dirty > 0 {
                return Ok(fallo(p, format!("Tiene {dirty} cambio{} sin confirmar: confirmá que se pierden.", if dirty == 1 { "" } else { "s" })));
            }
        }
        for w in &spaces {
            // Ya estaba cerrada: no hay nada que cerrar.
            let _ = self.ctx.cerrar_terminal(&w.id);
        }
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(&row.path);
        let r = self.escaner.git.git_raw(&repo.main_path, &args, OpcionesRun::timeout(120_000))?;
        if r.code != 0 {
            return Ok(fallo(p, readable(&r, "git worktree remove")));
        }
        for w in &spaces {
            self.ctx.quitar_espacio(&w.id);
        }
        self.olvidar(p);
        Ok(RemoveResult { path: p.into(), ok: true, error: None, closed_spaces: spaces.into_iter().map(|w| w.name).collect() })
    }

    /// Solo candidatas: sin espacio, sin cambios, sin commits sin subir, y mergeada o borrada en origin. Revalida con git.
    fn clean_one(&self, path: &Value) -> R<RemoveResult> {
        let (_, row) = self.conocida(path)?;
        let p = path.as_str().unwrap_or_default();
        let ok = !row.is_main && row.exists && !row.locked && row.spaces.is_empty() && (row.merged || row.gone);
        if !ok {
            return Ok(fallo(p, "Ya no cumple las condiciones para limpiar."));
        }
        let (dirty, ahead) = (self.escaner.count_dirty(&row.path), self.escaner.count_unpushed(&row.path));
        if dirty != 0 || ahead != 0 {
            return Ok(fallo(p, "Ahora tiene cambios o commits sin subir: no se quita."));
        }
        self.remove_one(path, false)
    }

    pub fn remove(&self, input: &Value) -> R<RemoveResult> {
        let _l = self.tomar()?;
        let force = input.get("force") == Some(&Value::Bool(true));
        let res = self.remove_one(input.get("path").unwrap_or(&Value::Null).pipe_text("Ruta")?, force)?;
        if !res.closed_spaces.is_empty() {
            self.ctx.ui_recargar();
        }
        Ok(res)
    }

    pub fn clean(&self, rutas: &Value) -> R<Vec<RemoveResult>> {
        let Some(lista) = rutas.as_array().filter(|a| !a.is_empty() && a.len() <= 200) else { return Err(GitError::nuevo("Nada para limpiar.")) };
        let _l = self.tomar()?;
        let mut out = Vec::new();
        let mut cerro = false;
        let mut error = None;
        for p in lista {
            if let Err(e) = parse_text(p, 1024, "Ruta") {
                error = Some(e);
                break;
            }
            let res = self.clean_one(p).unwrap_or_else(|e| fallo(p.as_str().unwrap_or_default(), e.mensaje));
            cerro |= !res.closed_spaces.is_empty();
            out.push(res);
        }
        if cerro {
            self.ctx.ui_recargar();
        }
        match error {
            Some(e) => Err(e),
            None => Ok(out),
        }
    }

    /// Crea la rama aparte en su carpeta hermana y, si se pidió, un espacio de Sloth con cuenta.
    pub fn create(&self, input: &Value) -> R<Creada> {
        let _l = self.tomar()?;
        let repo_path = parse_text(input.get("repoPath").unwrap_or(&Value::Null), 1024, "Repo")?;
        let name = input.get("name").and_then(Value::as_str).unwrap_or("");
        let base = parse_text(input.get("base").unwrap_or(&Value::Null), 200, "Rama base")?;
        let open_space = input.get("openSpace") == Some(&Value::Bool(true));
        let account_id = if open_space { Some(parse_text(input.get("accountId").unwrap_or(&Value::Null), 100, "Cuenta")?) } else { None };

        let rs = {
            let esc = self.escaneo.lock().unwrap_or_else(|e| e.into_inner());
            esc.repos.iter().find(|r| clave(&r.main_path) == clave(repo_path)).cloned()
        };
        let Some(rs) = rs else { return Err(GitError::nuevo("Ese repo ya no está en la lista. Volvé a abrir «Ramas aparte».")) };
        let acc = match account_id {
            Some(id) => Some(self.ctx.cuenta(id).ok_or_else(|| GitError::nuevo("Esa cuenta ya no existe."))?),
            None => None,
        };
        if let Some(a) = &acc {
            if !Path::new(&a.config_dir).exists() {
                return Err(GitError::nuevo(format!("Falta la carpeta de la cuenta «{}».", a.label)));
            }
        }
        let branch = name.trim();
        let locales = self.escaner.local_branches(&rs.main_path);
        let e = branch_name_error(branch, &RamasTomadas { main_branch: rs.main_branch.as_deref(), branches: &locales });
        if !e.is_empty() {
            return Err(GitError::nuevo(e));
        }
        if !rs.bases.iter().any(|b| b == base) {
            return Err(GitError::nuevo(format!("La rama base «{base}» no existe en este repo.")));
        }
        let folder = sibling_folder(&rs.main_path, branch);
        if Path::new(&folder).exists() {
            let nombre = Path::new(&folder).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            return Err(GitError::nuevo(format!("Ya existe la carpeta {nombre} al lado de la copia principal.")));
        }
        // Sale de origin/<base> si existe (lo último del remoto); si no, de la rama local.
        let desde_remoto = has_ref(&self.escaner.git, &rs.main_path, &format!("refs/remotes/origin/{base}"))?;
        let start = if desde_remoto { format!("origin/{base}") } else { base.to_string() };
        let r = self.escaner.git.git_raw(&rs.main_path, &["worktree", "add", "-b", branch, &folder, &start], OpcionesRun::timeout(120_000))?;
        if r.code != 0 {
            return Err(GitError::nuevo(readable(&r, "git worktree add")));
        }
        let mut space_id = None;
        if let Some(a) = acc {
            let seg = branch.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or(branch);
            let id = self.ctx.nuevo_id();
            let creado = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            self.ctx.agregar_espacio(NuevoEspacio { id: id.clone(), name: seg.to_string(), repo_path: rs.main_path.clone(), cwd: folder.clone(), branch: branch.to_string(), account_id: a.id, created_at: creado });
            self.ctx.ui_recargar();
            self.ctx.ui_abrir_panel(&id);
            space_id = Some(id);
        }
        Ok(Creada { path: folder, branch: branch.to_string(), space_id })
    }

    /// Abre la carpeta en el Explorador. Solo carpetas del último escaneo. Devuelve '' o el error.
    pub fn open_folder(&self, path: &Value) -> R<String> {
        let (_, row) = self.conocida(parse_text(path, 1024, "Ruta").map(|_| path)?)?;
        if !row.exists || !Path::new(&row.path).is_dir() {
            return Err(GitError::nuevo("La carpeta ya no existe."));
        }
        Ok(self.ctx.abrir_carpeta(&row.path))
    }

    /// Tamaño de la caché si sigue vigente (menos de 10 min y la carpeta raíz no cambió).
    fn tamano_en_cache(&self, path: &str) -> Option<SizeView> {
        let t = self.tamanos.lock().unwrap_or_else(|e| e.into_inner());
        let hit = t.cache.get(&clave(path))?;
        if hit.at.elapsed() > SIZE_TTL {
            return None;
        }
        let mtime = std::fs::symlink_metadata(path).ok()?.modified().ok();
        (mtime == hit.mtime).then_some(hit.vista)
    }

    /// Tamaños de las carpetas del último escaneo. Devuelve los que están en caché y vigentes; el resto se calcula en
    /// segundo plano y llega por `emitir_tamano`. Llamarlo otra vez no repite cálculos.
    pub fn sizes(self: &Arc<Self>, lista: &Value) -> R<HashMap<String, SizeView>> {
        let Some(items) = lista.as_array().filter(|a| a.len() <= 300) else { return Err(GitError::nuevo("Lista de carpetas inválida.")) };
        let mut out = HashMap::new();
        for p in items {
            let path = parse_text(p, 1024, "Ruta")?;
            let k = clave(path);
            if !self.escaneo.lock().unwrap_or_else(|e| e.into_inner()).filas.contains_key(&k) {
                continue;
            }
            if let Some(hit) = self.tamano_en_cache(path) {
                out.insert(path.to_string(), hit);
                continue;
            }
            let mut t = self.tamanos.lock().unwrap_or_else(|e| e.into_inner());
            if !t.encolados.contains(&k) && t.actual.as_deref() != Some(k.as_str()) {
                t.encolados.insert(k);
                t.cola.push_back(path.to_string());
            }
        }
        self.arrancar_tamanos();
        Ok(out)
    }

    fn arrancar_tamanos(self: &Arc<Self>) {
        let gen = {
            let mut t = self.tamanos.lock().unwrap_or_else(|e| e.into_inner());
            if t.corriendo || t.cola.is_empty() {
                return;
            }
            t.corriendo = true;
            t.gen
        };
        let me = Arc::clone(self);
        std::thread::spawn(move || me.correr_tamanos(gen));
    }

    fn correr_tamanos(&self, gen: u64) {
        loop {
            let p = {
                let mut t = self.tamanos.lock().unwrap_or_else(|e| e.into_inner());
                if t.gen != gen {
                    return;
                }
                let Some(p) = t.cola.pop_front() else { break };
                t.encolados.remove(&clave(&p));
                t.actual = Some(clave(&p));
                p
            };
            let md = std::fs::symlink_metadata(&p).ok();
            let abortar = Arc::new(AtomicBool::new(false));
            {
                let mut t = self.tamanos.lock().unwrap_or_else(|e| e.into_inner());
                if t.gen != gen {
                    return;
                }
                if md.is_some() {
                    t.abortar = Some(abortar.clone());
                }
            }
            let Some(md) = md else {
                self.ctx.emitir_tamano(&p, None, false);
                continue;
            };
            let res = folder_size(Path::new(&p), Instant::now() + SIZE_DEADLINE, &abortar);
            let mut t = self.tamanos.lock().unwrap_or_else(|e| e.into_inner());
            if t.gen != gen || res.aborted {
                return;
            }
            t.abortar = None;
            t.actual = None;
            let vista = SizeView { bytes: Some(res.bytes), partial: res.partial };
            t.cache.insert(clave(&p), SizeEntry { vista, at: Instant::now(), mtime: md.modified().ok() });
            drop(t);
            self.ctx.emitir_tamano(&p, Some(res.bytes), res.partial);
        }
        let mut t = self.tamanos.lock().unwrap_or_else(|e| e.into_inner());
        if t.gen == gen {
            t.corriendo = false;
            t.actual = None;
        }
    }

    /// La pantalla se cerró: se cortan los cálculos pendientes.
    pub fn sizes_cancel(&self) -> bool {
        self.cancelar_tamanos();
        true
    }

    fn cancelar_tamanos(&self) {
        let mut t = self.tamanos.lock().unwrap_or_else(|e| e.into_inner());
        t.gen += 1;
        t.cola.clear();
        t.encolados.clear();
        t.actual = None;
        t.corriendo = false;
        if let Some(a) = t.abortar.take() {
            a.store(true, Ordering::SeqCst);
        }
    }

    pub fn dispose(&self) {
        self.cancelar_tamanos();
    }
}

trait PipeTexto {
    fn pipe_text(&self, what: &str) -> R<&Value>;
}

impl PipeTexto for Value {
    /// Valida que sea una ruta de texto y la devuelve tal cual para pasarla a `conocida`.
    fn pipe_text(&self, what: &str) -> R<&Value> {
        parse_text(self, 1024, what).map(|_| self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_run::prueba::*;
    use crate::git_run::{Git, ProcesoEjecutor};
    use serde_json::json;
    use std::fs;

    #[derive(Default)]
    struct Datos {
        espacios: Mutex<Vec<WsRef>>,
        cuentas: Mutex<Vec<CuentaRef>>,
        cerradas: Mutex<Vec<String>>,
        quitados: Mutex<Vec<String>>,
        nuevos: Mutex<Vec<NuevoEspacio>>,
        eventos: Mutex<Vec<String>>,
        tamanos: Mutex<Vec<(String, Option<u64>, bool)>>,
        sin_escritura: AtomicBool,
    }

    impl ContextoWorktrees for Arc<Datos> {
        fn espacios(&self) -> Vec<WsRef> {
            self.espacios.lock().unwrap().clone()
        }
        fn cuenta(&self, id: &str) -> Option<CuentaRef> {
            self.cuentas.lock().unwrap().iter().find(|c| c.id == id).cloned()
        }
        fn exigir_escritura(&self) -> Result<(), String> {
            if self.sin_escritura.load(Ordering::SeqCst) {
                Err("El estado está en solo lectura.".into())
            } else {
                Ok(())
            }
        }
        fn cerrar_terminal(&self, id: &str) -> Result<(), String> {
            self.cerradas.lock().unwrap().push(id.into());
            Ok(())
        }
        fn quitar_espacio(&self, id: &str) {
            self.quitados.lock().unwrap().push(id.into());
        }
        fn nuevo_id(&self) -> String {
            "nuevo-id".into()
        }
        fn agregar_espacio(&self, e: NuevoEspacio) {
            self.nuevos.lock().unwrap().push(e);
        }
        fn ui_recargar(&self) {
            self.eventos.lock().unwrap().push("reload".into());
        }
        fn ui_abrir_panel(&self, id: &str) {
            self.eventos.lock().unwrap().push(format!("open-pane {id}"));
        }
        fn actividad_agente(&self, id: &str) -> u64 {
            if id == "1" {
                9_999_999_999_999
            } else {
                0
            }
        }
        fn emitir_tamano(&self, path: &str, bytes: Option<u64>, partial: bool) {
            self.tamanos.lock().unwrap().push((path.into(), bytes, partial));
        }
        fn abrir_carpeta(&self, _path: &str) -> String {
            String::new()
        }
    }

    struct Entorno {
        t: Temporal,
        d: Arc<Datos>,
        w: Arc<Worktrees<ProcesoEjecutor, Arc<Datos>>>,
        main: String,
    }

    fn git_ok(g: &Git<ProcesoEjecutor>, dir: &str, args: &[&str]) {
        g.git(dir, args, OpcionesRun::timeout(30_000)).unwrap();
    }

    fn entorno() -> Entorno {
        let t = Temporal::nueva("sloth-wtfeat");
        let main_dir = t.0.join("repo");
        fs::create_dir_all(&main_dir).unwrap();
        let main = main_dir.to_string_lossy().into_owned();
        let g = git_real();
        repo_con_commit(&g, &main);
        let d = Arc::new(Datos::default());
        d.espacios.lock().unwrap().push(WsRef { id: "0".into(), name: "principal".into(), repo_path: main.clone(), cwd: main.clone(), account_label: None });
        let w = Worktrees::new(Escaner::new(g), d.clone());
        Entorno { t, d, w, main }
    }

    fn agregar(e: &Entorno, rama: &str) -> String {
        let carpeta = sibling_folder(&e.main, rama);
        git_ok(&e.w.escaner.git, &e.main, &["worktree", "add", "-b", rama, &carpeta, "main"]);
        carpeta
    }

    #[test]
    fn scan_arma_la_vista_con_ultimo_uso_y_solo_se_actua_sobre_lo_escaneado() {
        let e = entorno();
        let carpeta = agregar(&e, "feat/a");
        e.d.espacios.lock().unwrap().push(WsRef { id: "1".into(), name: "a".into(), repo_path: e.main.clone(), cwd: carpeta.clone(), account_label: None });
        assert_eq!(e.w.remove(&json!({"path": carpeta})).unwrap_err().mensaje, "Esa rama aparte no está en la última lista. Volvé a abrir «Ramas aparte».");
        let v = e.w.scan();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].rows.len(), 2);
        let fila = v[0].rows.iter().find(|r| r.row.branch.as_deref() == Some("feat/a")).unwrap();
        assert_eq!(fila.last_use_at, Some(9_999_999_999_999));
        let main = &v[0].rows[0];
        assert!(main.row.is_main);
        assert_eq!(main.last_use_at.map(|m| m > 1_000_000_000_000), Some(true));
        let json = serde_json::to_value(&v[0]).unwrap();
        assert_eq!(json["rows"][1]["isMain"], false);
        assert_eq!(json["rows"][1]["lastUseAt"], 9_999_999_999_999u64);
        assert_eq!(json["defaultBase"], "main");
        assert_eq!(e.w.remove(&json!({"path": 5})).unwrap_err().mensaje, "Ruta inválido.");
        assert_eq!(e.w.remove(&json!({"path": "x"})).unwrap_err().mensaje, "Esa rama aparte no está en la última lista. Volvé a abrir «Ramas aparte».");
    }

    #[test]
    fn remove_respeta_principal_cambios_force_y_cierra_los_espacios() {
        let e = entorno();
        let carpeta = agregar(&e, "feat/b");
        e.d.espacios.lock().unwrap().push(WsRef { id: "2".into(), name: "b".into(), repo_path: e.main.clone(), cwd: carpeta.clone(), account_label: None });
        e.w.scan();
        let r = e.w.remove(&json!({"path": e.main})).unwrap();
        assert_eq!((r.ok, r.error.as_deref()), (false, Some("La copia principal no se quita.")));
        fs::write(Path::new(&carpeta).join("sucio.txt"), "x").unwrap();
        e.d.sin_escritura.store(true, Ordering::SeqCst);
        let r = e.w.remove(&json!({"path": carpeta})).unwrap();
        assert_eq!(r.error.as_deref(), Some("El estado está en solo lectura."));
        assert!(Path::new(&carpeta).exists());
        e.d.sin_escritura.store(false, Ordering::SeqCst);
        let r = e.w.remove(&json!({"path": carpeta})).unwrap();
        assert_eq!(r.error.as_deref(), Some("Tiene 1 cambio sin confirmar: confirmá que se pierden."));
        assert!(e.d.cerradas.lock().unwrap().is_empty());
        let r = e.w.remove(&json!({"path": carpeta, "force": true})).unwrap();
        assert!(r.ok, "{r:?}");
        assert_eq!(r.closed_spaces, ["b"]);
        assert!(!Path::new(&carpeta).exists());
        assert_eq!(e.d.cerradas.lock().unwrap().as_slice(), ["2"]);
        assert_eq!(e.d.quitados.lock().unwrap().as_slice(), ["2"]);
        assert_eq!(e.d.eventos.lock().unwrap().as_slice(), ["reload"]);
        assert!(e.w.remove(&json!({"path": carpeta})).is_err());
    }

    #[test]
    fn remove_de_una_carpeta_que_ya_no_esta_poda_el_registro() {
        let e = entorno();
        let carpeta = agregar(&e, "feat/c");
        fs::remove_dir_all(&carpeta).unwrap();
        e.w.scan();
        let r = e.w.remove(&json!({"path": carpeta})).unwrap();
        assert!(r.ok, "{r:?}");
        let lista = e.w.escaner.git.git(&e.main, &["worktree", "list", "--porcelain"], OpcionesRun::default()).unwrap();
        assert!(!lista.contains("feat/c"));
    }

    #[test]
    fn clean_solo_quita_las_que_siguen_cumpliendo() {
        let e = entorno();
        let hecha = agregar(&e, "hecha");
        let avance = agregar(&e, "avance");
        fs::write(Path::new(&avance).join("n.txt"), "n").unwrap();
        git_ok(&e.w.escaner.git, &avance, &["add", "n.txt"]);
        git_ok(&e.w.escaner.git, &avance, &["commit", "-q", "-m", "n"]);
        e.w.scan();
        assert_eq!(e.w.clean(&json!([])).unwrap_err().mensaje, "Nada para limpiar.");
        assert_eq!(e.w.clean(&json!("x")).unwrap_err().mensaje, "Nada para limpiar.");
        let esperaba_ahead_cero = e.w.escaner.count_unpushed(&hecha);
        // Sin remotos, «ahead» cuenta el commit inicial: la rama mergeada no es limpiable hasta que no quede nada sin subir.
        assert_eq!(esperaba_ahead_cero, 1);
        let r = e.w.clean(&json!([hecha, avance, e.main])).unwrap();
        assert_eq!(r[0].error.as_deref(), Some("Ahora tiene cambios o commits sin subir: no se quita."));
        assert_eq!(r[1].error.as_deref(), Some("Ya no cumple las condiciones para limpiar."));
        assert_eq!(r[2].error.as_deref(), Some("Ya no cumple las condiciones para limpiar."));
        assert!(Path::new(&hecha).exists());
        assert!(e.w.clean(&json!([5])).is_err());
        assert!(e.w.ocupado.load(Ordering::SeqCst) == false);
    }

    #[test]
    fn clean_con_un_remoto_quita_la_mergeada() {
        let e = entorno();
        let remoto = Temporal::nueva("sloth-wtremoto");
        let g = &e.w.escaner.git;
        git_ok(g, &remoto.ruta(), &["init", "-q", "--bare", "-b", "main"]);
        git_ok(g, &e.main, &["remote", "add", "origin", &remoto.ruta()]);
        git_ok(g, &e.main, &["push", "-q", "origin", "main"]);
        git_ok(g, &e.main, &["fetch", "-q", "origin"]);
        let hecha = agregar(&e, "hecha");
        e.w.scan();
        let r = e.w.clean(&json!([hecha])).unwrap();
        assert!(r[0].ok, "{r:?}");
        assert!(!Path::new(&hecha).exists());
    }

    #[test]
    fn create_valida_y_crea_la_carpeta_hermana_con_espacio() {
        let e = entorno();
        let carpeta_cuenta = e.t.0.join("cuenta");
        fs::create_dir_all(&carpeta_cuenta).unwrap();
        e.d.cuentas.lock().unwrap().push(CuentaRef { id: "acc".into(), label: "Tomy".into(), config_dir: carpeta_cuenta.to_string_lossy().into_owned() });
        e.d.cuentas.lock().unwrap().push(CuentaRef { id: "rota".into(), label: "Rota".into(), config_dir: e.t.0.join("nada").to_string_lossy().into_owned() });
        let msg = |v: Value| e.w.create(&v).unwrap_err().mensaje;
        assert_eq!(msg(json!({"repoPath": e.main, "name": "x", "base": "main"})), "Ese repo ya no está en la lista. Volvé a abrir «Ramas aparte».");
        e.w.scan();
        assert_eq!(msg(json!({"name": "x", "base": "main"})), "Repo inválido.");
        assert_eq!(msg(json!({"repoPath": e.main, "name": "x"})), "Rama base inválido.");
        assert_eq!(msg(json!({"repoPath": e.main, "name": "x", "base": "main", "openSpace": true})), "Cuenta inválido.");
        assert_eq!(msg(json!({"repoPath": e.main, "name": "x", "base": "main", "openSpace": true, "accountId": "zzz"})), "Esa cuenta ya no existe.");
        assert_eq!(msg(json!({"repoPath": e.main, "name": "x", "base": "main", "openSpace": true, "accountId": "rota"})), "Falta la carpeta de la cuenta «Rota».");
        assert_eq!(msg(json!({"repoPath": e.main, "name": "  ", "base": "main"})), "Poné un nombre para la rama.");
        assert_eq!(msg(json!({"repoPath": e.main, "name": "main", "base": "main"})), "Esa es la copia principal del repo. Elegí otro nombre.");
        assert_eq!(msg(json!({"repoPath": e.main, "name": "-x", "base": "main"})), "Esa rama no es válida. Usá letras, números, guiones, puntos o barras.");
        assert_eq!(msg(json!({"repoPath": e.main, "name": "x", "base": "otra"})), "La rama base «otra» no existe en este repo.");
        let c = e.w.create(&json!({"repoPath": e.main, "name": " feat/nueva ", "base": "main", "openSpace": true, "accountId": "acc"})).unwrap();
        assert_eq!(c.branch, "feat/nueva");
        assert_eq!(c.space_id.as_deref(), Some("nuevo-id"));
        assert!(c.path.ends_with("repo-feat-nueva"));
        assert!(Path::new(&c.path).join("a.txt").exists());
        let n = e.d.nuevos.lock().unwrap()[0].clone();
        assert_eq!((n.name.as_str(), n.branch.as_str(), n.account_id.as_str()), ("nueva", "feat/nueva", "acc"));
        assert_eq!(e.d.eventos.lock().unwrap().as_slice(), ["reload", "open-pane nuevo-id"]);
        assert_eq!(msg(json!({"repoPath": e.main, "name": "feat/nueva", "base": "main"})), "Ya hay una rama con ese nombre en este repo.");
        fs::create_dir_all(e.t.0.join("repo-otra")).unwrap();
        assert_eq!(msg(json!({"repoPath": e.main, "name": "otra", "base": "main"})), "Ya existe la carpeta repo-otra al lado de la copia principal.");
        let sin = e.w.create(&json!({"repoPath": e.main, "name": "sin-espacio", "base": "main"})).unwrap();
        assert_eq!(sin.space_id, None);
        assert_eq!(e.d.nuevos.lock().unwrap().len(), 1);
    }

    #[test]
    fn una_operacion_en_curso_rechaza_a_las_demas() {
        let e = entorno();
        e.w.scan();
        let _l = e.w.tomar().unwrap();
        assert_eq!(e.w.create(&json!({})).unwrap_err().mensaje, OCUPADO);
        assert_eq!(e.w.remove(&json!({"path": e.main})).unwrap_err().mensaje, OCUPADO);
        assert_eq!(e.w.clean(&json!([e.main])).unwrap_err().mensaje, OCUPADO);
    }

    fn esperar(cond: impl Fn() -> bool) {
        let fin = Instant::now() + Duration::from_secs(10);
        while !cond() && Instant::now() < fin {
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn sizes_calcula_en_segundo_plano_cachea_y_se_puede_cancelar() {
        let e = entorno();
        let carpeta = agregar(&e, "feat/s");
        e.w.scan();
        let lista = json!([carpeta, e.main, "C:/no/escaneada"]);
        let primera = e.w.sizes(&lista).unwrap();
        assert!(primera.is_empty());
        esperar(|| e.d.tamanos.lock().unwrap().len() >= 2);
        let emitidos = e.d.tamanos.lock().unwrap().clone();
        assert_eq!(emitidos.len(), 2);
        assert!(emitidos.iter().all(|(_, b, p)| b.is_some() && !*p));
        esperar(|| !e.w.tamanos.lock().unwrap().corriendo);
        let segunda = e.w.sizes(&lista).unwrap();
        assert_eq!(segunda.len(), 2);
        assert_eq!(segunda[&carpeta].bytes, emitidos.iter().find(|(p, _, _)| *p == carpeta).unwrap().1);
        assert_eq!(e.d.tamanos.lock().unwrap().len(), 2);
        fs::write(Path::new(&carpeta).join("nuevo.bin"), vec![0u8; 10]).unwrap();
        fs::create_dir_all(Path::new(&carpeta).join("d")).unwrap();
        assert!(e.w.sizes(&json!([carpeta])).unwrap().is_empty());
        assert!(e.w.sizes_cancel());
        e.w.dispose();
        assert_eq!(e.w.sizes(&json!("x")).unwrap_err().mensaje, "Lista de carpetas inválida.");
        assert!(e.w.sizes(&json!([5])).is_err());
    }

    #[test]
    fn open_folder_solo_abre_carpetas_escaneadas_que_existen() {
        let e = entorno();
        let carpeta = agregar(&e, "feat/o");
        e.w.scan();
        assert_eq!(e.w.open_folder(&json!(carpeta)).unwrap(), "");
        assert_eq!(e.w.open_folder(&json!("C:/Windows")).unwrap_err().mensaje, "Esa rama aparte no está en la última lista. Volvé a abrir «Ramas aparte».");
        assert_eq!(e.w.open_folder(&json!("")).unwrap_err().mensaje, "Ruta inválido.");
        fs::remove_dir_all(&carpeta).unwrap();
        assert_eq!(e.w.open_folder(&json!(carpeta)).unwrap_err().mensaje, "La carpeta ya no existe.");
    }
}
