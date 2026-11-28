//! Canales `feat:prs:*` en Rust: los PR abiertos de los repos de GitHub que usan los espacios. Validación, lectura de gh
//! y la decisión de abrir la rama viven en `sloth_core::features::prs`; acá están la instantánea en memoria, `prs.json`,
//! el refresco (con la vista abierta, al enfocar la ventana) y los eventos `feat:prs:updated`.
//!
//! Abrir la rama de un PR puede crear un espacio: eso lo sigue haciendo el dueño del store, por `workspaces:add`.
use super::{a_json, arg, AlHook};
use crate::entorno::Entorno;
use crate::router::Router;
use serde_json::{json, Value};
use sloth_core::features::proceso::{legible, normalizar_ruta, Ejecutor, Real, Salida};
use sloth_core::features::prs::{
    abrir_rama, args_de_actualizar_rama, args_de_merge, bloqueo_de_rebase, cargar, comando_de_merge, fila_de, fusionar_ids, guardar, hace_falta_refrescar, head_visto, leer_repo,
    metodo_de, modo_valido, remoto_de_github, url_permitida, EntornoPrs, EspacioPrs, FilaPr, Instantanea, NuevoEspacio, Ocupados, PrTarget, Problema, RepoLeido, RepoPrs,
    AUTH_TTL_MS, PARALELO,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const NOMBRE: &str = "prs";

const ALTA_DE_ESPACIO: Duration = Duration::from_secs(180);

fn ahora_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Como `isDir` de git-run.ts: ruta absoluta, razonable y que exista como carpeta.
fn es_dir(p: &str) -> bool {
    !p.is_empty() && p.chars().count() <= 1024 && Path::new(p).is_absolute() && Path::new(p).is_dir()
}

fn texto(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(String::from)
}

struct Datos {
    archivo: PathBuf,
    snap: Instantanea,
    ids: Vec<(String, String)>,
    /// Carpeta normalizada → «dueño/repo» de su remoto origin.
    slugs: HashMap<String, String>,
    auth: Option<(bool, u64)>,
    vista_abierta: bool,
}

pub struct Prs {
    entorno: Arc<Entorno>,
    ejecutor: Arc<dyn Ejecutor>,
    datos: Mutex<Option<Datos>>,
    en_curso: Mutex<bool>,
    termino: Condvar,
    ocupados: Ocupados,
}

/// Lo que devuelve la fila de un PR: copias, para no tener tomado el estado mientras corren gh o git.
struct Fila {
    fila: FilaPr,
    repo: RepoPrs,
    target: PrTarget,
}

impl Prs {
    fn con_datos<T>(&self, f: impl FnOnce(&mut Datos) -> T) -> Result<T, String> {
        let mut g = self.datos.lock().unwrap_or_else(|e| e.into_inner());
        if g.is_none() {
            let archivo = self.entorno.carpeta_features()?.join("prs.json");
            let guardado = cargar(&archivo, sloth_core::avisos::Avisos::global());
            for aviso in sloth_core::avisos::Avisos::global().tomar() {
                sloth_core::logger_global::aviso(NOMBRE, &aviso);
            }
            *g = Some(Datos { archivo, snap: guardado.instantanea, ids: guardado.ids, slugs: HashMap::new(), auth: None, vista_abierta: false });
        }
        Ok(f(g.as_mut().expect("recién cargado")))
    }

    fn instantanea(&self) -> Result<Value, String> {
        self.con_datos(|d| serde_json::to_value(&d.snap).map_err(|e| e.to_string()))?
    }

    fn emitir(&self, snap: &Instantanea) {
        self.entorno.emitir(NOMBRE, "updated", &[serde_json::to_value(snap).unwrap_or(Value::Null)]);
    }

    fn correr(&self, cmd: &str, args: &[String], cwd: Option<&Path>, segundos: u64) -> Salida {
        self.ejecutor.ejecutar(cmd, args, cwd, Duration::from_secs(segundos))
    }

    fn git_crudo(&self, cwd: &str, args: &[&str]) -> Salida {
        let mut todos: Vec<String> = vec!["-C".into(), cwd.into(), "-c".into(), "core.quotepath=false".into()];
        todos.extend(args.iter().map(|s| s.to_string()));
        let segundos = if args.first() == Some(&"fetch") { 120 } else { 15 };
        self.correr("git", &todos, None, segundos)
    }

    fn espacios(&self) -> Vec<Value> {
        // El store lo sigue guardando el proceso de apoyo: acá solo se lee.
        self.entorno.lista_del_estado("workspaces")
    }

    fn rutas_de_espacios(&self) -> Vec<String> {
        self.espacios().iter().filter_map(|w| texto(w, "repoPath")).collect()
    }

    /// Repos de GitHub de los espacios, en el orden en que aparecen: «dueño/repo» → carpetas.
    fn repos_de_espacios(&self, slugs: &mut HashMap<String, String>) -> Vec<(String, Vec<String>)> {
        let mut carpetas: Vec<(String, String)> = Vec::new();
        for p in self.rutas_de_espacios() {
            let k = normalizar_ruta(&p);
            if !carpetas.iter().any(|(c, _)| *c == k) && es_dir(&p) {
                carpetas.push((k, p));
            }
        }
        for (k, p) in &carpetas {
            if slugs.contains_key(k) {
                continue;
            }
            let r = self.git_crudo(p, &["remote", "get-url", "origin"]);
            if let Some(slug) = (r.code == 0).then(|| remoto_de_github(r.stdout.trim())).flatten() {
                slugs.insert(k.clone(), slug);
            }
        }
        let mut out: Vec<(String, Vec<String>)> = Vec::new();
        for (k, p) in carpetas {
            let Some(slug) = slugs.get(&k) else { continue };
            match out.iter_mut().find(|(s, _)| s == slug) {
                Some((_, ps)) => ps.push(p),
                None => out.push((slug.clone(), vec![p])),
            }
        }
        out
    }

    fn sesion_iniciada(&self, auth: &mut Option<(bool, u64)>) -> bool {
        if let Some((true, at)) = *auth {
            if ahora_ms().saturating_sub(at) < AUTH_TTL_MS {
                return true;
            }
        }
        let r = self.correr("gh", &["auth".into(), "status".into(), "--hostname".into(), "github.com".into()], None, 10);
        *auth = Some((r.code == 0, ahora_ms()));
        r.code == 0
    }

    fn calcular(&self, previa: &Instantanea, ids: &mut Vec<(String, String)>, slugs: &mut HashMap<String, String>, auth: &mut Option<(bool, u64)>) -> Instantanea {
        let at = ahora_ms();
        let problema = |p: Problema| Instantanea { problem: Some(p), at, ..previa.clone() };
        let version = self.correr("gh", &["--version".into()], None, 8);
        if version.code != 0 || version.falta {
            return problema(Problema::NoGh);
        }
        if !self.sesion_iniciada(auth) {
            return problema(Problema::NoLogin);
        }
        let repos = self.repos_de_espacios(slugs);
        if repos.is_empty() {
            ids.clear();
            return Instantanea { problem: Some(Problema::NoRepos), login: previa.login.clone(), repos: vec![], at, refreshing: true };
        }
        let viejos: HashMap<&str, &RepoPrs> = previa.repos.iter().map(|r| (r.repo.as_str(), r)).collect();
        let siguiente = AtomicUsize::new(0);
        let leidos: Mutex<Vec<Option<RepoLeido>>> = Mutex::new((0..repos.len()).map(|_| None).collect());
        std::thread::scope(|s| {
            for _ in 0..PARALELO.min(repos.len()) {
                s.spawn(|| loop {
                    let i = siguiente.fetch_add(1, Ordering::SeqCst);
                    let Some((slug, rutas)) = repos.get(i) else { break };
                    let r = leer_repo(self.ejecutor.as_ref(), slug, rutas, viejos.get(slug.as_str()).copied());
                    leidos.lock().unwrap_or_else(|e| e.into_inner())[i] = Some(r);
                });
            }
        });
        let leidos: Vec<RepoLeido> = leidos.into_inner().unwrap_or_else(|e| e.into_inner()).into_iter().flatten().collect();
        let mut login = previa.login.clone();
        for l in &leidos {
            if !l.login.is_empty() {
                login = Some(l.login.clone());
            }
        }
        let por_repo: Vec<(String, Option<_>)> = leidos.iter().map(|l| (l.repo.repo.clone(), l.ids.clone())).collect();
        *ids = fusionar_ids(ids, &por_repo);
        Instantanea { problem: None, login, repos: leidos.into_iter().map(|l| l.repo).collect(), at, refreshing: true }
    }

    fn hacer_refresco(&self) -> Result<(), String> {
        let (previa, mut ids, mut slugs, mut auth) = self.con_datos(|d| {
            d.snap.refreshing = true;
            (d.snap.clone(), d.ids.clone(), std::mem::take(&mut d.slugs), d.auth)
        })?;
        self.emitir(&previa);
        let nueva = self.calcular(&previa, &mut ids, &mut slugs, &mut auth);
        let snap = self.con_datos(|d| {
            d.snap = Instantanea { refreshing: false, ..nueva };
            d.ids = ids;
            d.slugs = slugs;
            d.auth = auth;
            if let Err(e) = guardar(&d.archivo, &d.snap, &d.ids) {
                sloth_core::logger_global::aviso(NOMBRE, &format!("no se pudo guardar prs.json: {e}"));
            }
            d.snap.clone()
        })?;
        self.emitir(&snap);
        Ok(())
    }

    /// Un refresco en curso se espera y se reusa; sin `forzar`, un dato de hace menos de 30 s alcanza.
    fn refrescar(&self, forzar: bool) -> Result<(), String> {
        let mut c = self.en_curso.lock().unwrap_or_else(|e| e.into_inner());
        if *c {
            while *c {
                c = self.termino.wait(c).unwrap_or_else(|e| e.into_inner());
            }
            return Ok(());
        }
        let at = self.con_datos(|d| d.snap.at)?;
        if !hace_falta_refrescar(false, forzar, ahora_ms(), at) {
            return Ok(());
        }
        *c = true;
        drop(c);
        struct Fin<'a>(&'a Prs);
        impl Drop for Fin<'_> {
            fn drop(&mut self) {
                *self.0.en_curso.lock().unwrap_or_else(|e| e.into_inner()) = false;
                self.0.termino.notify_all();
            }
        }
        let _fin = Fin(self);
        self.hacer_refresco()
    }

    fn refrescar_de_fondo(self: &Arc<Self>, forzar: bool) {
        let p = self.clone();
        std::thread::spawn(move || {
            if let Err(e) = p.refrescar(forzar) {
                sloth_core::logger_global::aviso(NOMBRE, &format!("prs: refresco: {e}"));
            }
        });
    }

    /// Después de cambiar un PR: espera un refresco en curso (que pudo leer el estado viejo) y vuelve a leer, sin trabar
    /// al que llama.
    fn refrescar_tras_cambio(self: &Arc<Self>) {
        let p = self.clone();
        std::thread::spawn(move || {
            let _ = p.refrescar(false);
            if let Err(e) = p.refrescar(true) {
                sloth_core::logger_global::aviso(NOMBRE, &format!("prs: refresco: {e}"));
            }
        });
    }

    fn fila(&self, x: &Value) -> Result<Fila, String> {
        let rutas = self.rutas_de_espacios();
        self.con_datos(|d| fila_de(&d.snap, x, &rutas).map(|(f, r, t)| Fila { fila: f.clone(), repo: r.clone(), target: t }))?
    }

    fn list(self: &Arc<Self>) -> Result<Value, String> {
        let snap = self.instantanea()?;
        self.refrescar_de_fondo(false);
        Ok(snap)
    }

    fn refresh(&self) -> Result<Value, String> {
        // El remoto de un repo puede haber cambiado (fork a upstream, renombre).
        if !*self.en_curso.lock().unwrap_or_else(|e| e.into_inner()) {
            self.con_datos(|d| d.slugs.clear())?;
        }
        self.refrescar(true)?;
        self.instantanea()
    }

    fn set_open(&self, b: &Value) -> Result<Value, String> {
        let Some(b) = b.as_bool() else { return Err("Valor inválido.".into()) };
        self.con_datos(|d| d.vista_abierta = b)?;
        Ok(Value::Null)
    }

    fn open_url(&self, x: &Value, url: &Value) -> Result<Value, String> {
        let f = self.fila(x)?;
        let u = url_permitida(&f.fila, url)?;
        self.entorno.plataforma.abrir_enlace_externo(u)?;
        Ok(Value::Null)
    }

    fn open_branch(&self, x: &Value, modo: &Value) -> Result<Value, String> {
        let f = self.fila(x)?;
        let modo = modo_valido(modo)?;
        let espacios: Vec<EspacioPrs> = self
            .espacios()
            .iter()
            .filter_map(|w| Some(EspacioPrs { id: texto(w, "id")?, repo_path: texto(w, "repoPath")?, cwd: texto(w, "cwd")?, branch: texto(w, "branch"), account_id: texto(w, "accountId")? }))
            .collect();
        a_json(abrir_rama(self, &self.ocupados, &espacios, &f.fila, &f.repo, &f.target, modo))
    }

    fn rebase(self: &Arc<Self>, x: &Value, sha: &Value) -> Result<Value, String> {
        let f = self.fila(x)?;
        if let Some(motivo) = bloqueo_de_rebase(&f.fila, &f.repo) {
            return Err(motivo);
        }
        let head = head_visto(&f.fila.head_sha, sha)?;
        let clave = format!("{}#{}", f.target.repo, f.target.number);
        let id = self.con_datos(|d| d.ids.iter().find(|(k, _)| *k == clave).map(|(_, v)| v.clone()))?.ok_or("Ese PR ya no está en la lista. Refrescá.")?;
        {
            let _reserva = self.ocupados.reservar(&f.target)?;
            let r = self.correr("gh", &args_de_actualizar_rama(&id, &head)?, None, 60);
            if r.code != 0 {
                return Err(legible(&r, "gh api graphql"));
            }
        }
        self.refrescar_tras_cambio();
        Ok(json!({ "ok": true }))
    }

    fn merge(self: &Arc<Self>, x: &Value, metodo: &Value, sha: &Value) -> Result<Value, String> {
        let f = self.fila(x)?;
        let m = metodo_de(&f.repo, &f.fila, metodo)?;
        let head = head_visto(&f.fila.head_sha, sha)?;
        {
            let _reserva = self.ocupados.reservar(&f.target)?;
            // Fuera del repo: así gh no toca ramas locales.
            let raiz = self.entorno.raiz();
            let r = self.correr("gh", &args_de_merge(&f.target, m.como_texto(), &head)?, Some(&raiz), 120);
            if r.code != 0 {
                return Err(legible(&r, "gh pr merge"));
            }
        }
        self.refrescar_tras_cambio();
        Ok(json!({ "ok": true }))
    }

    fn merge_command(&self, x: &Value, metodo: &Value, sha: &Value) -> Result<Value, String> {
        let f = self.fila(x)?;
        a_json(comando_de_merge(&f.repo, &f.fila, &f.target, metodo, sha))
    }
}

impl EntornoPrs for Prs {
    fn es_dir(&self, p: &str) -> bool {
        es_dir(p)
    }

    /// Como `repoInfo(cwd).branch` de git-ops.ts.
    fn rama_actual(&self, cwd: &str) -> Option<String> {
        let r = self.git_crudo(cwd, &["rev-parse", "--is-inside-work-tree", "--show-toplevel"]);
        if r.code != 0 || r.stdout.trim().lines().next() != Some("true") {
            return None;
        }
        let b = self.git_crudo(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"]);
        (b.code == 0).then(|| b.stdout.trim().to_string())
    }

    fn git(&self, cwd: &str, args: &[&str]) -> Result<String, String> {
        let r = self.git_crudo(cwd, args);
        if r.code != 0 {
            return Err(legible(&r, &format!("git {}", args.first().copied().unwrap_or_default())));
        }
        Ok(r.stdout)
    }

    fn git_crudo(&self, cwd: &str, args: &[&str]) -> Salida {
        Prs::git_crudo(self, cwd, args)
    }

    fn agregar_espacio(&self, nuevo: NuevoEspacio) -> Result<EspacioPrs, String> {
        let mut input = json!({ "name": nuevo.name, "repoPath": nuevo.repo_path, "accountId": nuevo.account_id, "autoStartClaude": false });
        if let Some(b) = nuevo.branch {
            input["branch"] = json!(b);
        }
        if let Some(b) = nuevo.base_branch {
            input["baseBranch"] = json!(b);
        }
        let ws = self.entorno.pedir("workspaces:add", vec![input], ALTA_DE_ESPACIO)?;
        let falta = || "No se pudo crear el espacio del PR.".to_string();
        Ok(EspacioPrs {
            id: texto(&ws, "id").ok_or_else(falta)?,
            repo_path: texto(&ws, "repoPath").ok_or_else(falta)?,
            cwd: texto(&ws, "cwd").ok_or_else(falta)?,
            branch: texto(&ws, "branch"),
            account_id: texto(&ws, "accountId").unwrap_or_default(),
        })
    }

    fn mostrar_espacio(&self, id: &str) {
        self.entorno.plataforma.enviar_a_la_ventana("ui:command", &[json!({ "type": "open-pane", "id": id })]);
    }

    fn registrar(&self, mensaje: &str) {
        sloth_core::logger_global::aviso(NOMBRE, mensaje);
    }
}

struct AlEnfocar(Arc<Prs>);

impl AlHook for AlEnfocar {
    fn al_hook(&self, _: &str, _: Option<&str>) {}

    fn al_enfocar(&self) {
        if self.0.con_datos(|d| d.vista_abierta).unwrap_or(false) {
            self.0.refrescar_de_fondo(false);
        }
    }
}

pub fn armar(entorno: Arc<Entorno>, ejecutor: Arc<dyn Ejecutor>) -> Arc<Prs> {
    Arc::new(Prs { entorno, ejecutor, datos: Mutex::new(None), en_curso: Mutex::new(false), termino: Condvar::new(), ocupados: Ocupados::default() })
}

pub fn registrar(router: &mut Router, entorno: Arc<Entorno>) -> Arc<dyn AlHook> {
    registrar_con(router, armar(entorno, Arc::new(Real)))
}

fn registrar_con(router: &mut Router, p: Arc<Prs>) -> Arc<dyn AlHook> {
    macro_rules! canal {
        ($op:literal, |$f:ident, $a:ident| $cuerpo:expr) => {{
            let $f = p.clone();
            router.registrar(concat!("feat:prs:", $op), move |$a: Vec<Value>| {
                let _ = &$a;
                $cuerpo
            });
        }};
    }
    canal!("list", |f, a| f.list());
    // Solo lo guardado: el riel lo pide al arrancar y no debe costar una llamada a GitHub.
    canal!("peek", |f, a| f.instantanea());
    canal!("refresh", |f, a| f.refresh());
    canal!("setOpen", |f, a| f.set_open(arg(&a, 0)));
    canal!("openUrl", |f, a| f.open_url(arg(&a, 0), arg(&a, 1)));
    canal!("openBranch", |f, a| f.open_branch(arg(&a, 0), arg(&a, 1)));
    canal!("rebase", |f, a| f.rebase(arg(&a, 0), arg(&a, 1)));
    canal!("merge", |f, a| f.merge(arg(&a, 0), arg(&a, 1), arg(&a, 2)));
    canal!("mergeCommand", |f, a| f.merge_command(arg(&a, 0), arg(&a, 1), arg(&a, 2)));
    Arc::new(AlEnfocar(p))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_comunes::{EntornoDePrueba, ReenvioNulo};
    use std::fs;

    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    type Guion = dyn Fn(&str, &[String]) -> Salida + Send + Sync;

    /// gh y git simulados: el guion decide la salida y se anota cada llamada.
    struct Simulado {
        guion: Box<Guion>,
        llamadas: Mutex<Vec<(String, Vec<String>, Option<PathBuf>)>>,
    }

    impl Ejecutor for Simulado {
        fn ejecutar(&self, cmd: &str, args: &[String], cwd: Option<&Path>, _: Duration) -> Salida {
            self.llamadas.lock().unwrap().push((cmd.to_string(), args.to_vec(), cwd.map(Path::to_path_buf)));
            (self.guion)(cmd, args)
        }
    }

    impl Simulado {
        fn llamo(&self, que: &str) -> bool {
            self.llamadas.lock().unwrap().iter().any(|(c, a, _)| format!("{c} {}", a.join(" ")).contains(que))
        }
    }

    fn respuesta(head: &str) -> String {
        json!({ "data": {
            "viewer": { "login": "yo" },
            "repository": {
                "mergeCommitAllowed": false, "squashMergeAllowed": true, "rebaseMergeAllowed": false,
                "defaultBranchRef": { "name": "main" },
                "pullRequests": { "nodes": [{
                    "id": "PR_kwABC", "number": 7, "title": "Arreglo", "url": "https://github.com/o/r/pull/7", "isDraft": false,
                    "baseRefName": "main", "headRefName": head, "isCrossRepository": false, "updatedAt": "2026-11-16T10:00:00Z",
                    "author": { "login": "yo" }, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "reviewDecision": "APPROVED",
                    "reviewRequests": { "nodes": [] },
                    "commits": { "nodes": [{ "commit": { "oid": SHA, "statusCheckRollup": { "state": "SUCCESS", "contexts": { "nodes": [] } } } }] }
                }] }
            }
        } })
        .to_string()
    }

    /// Un mundo con gh logueado, un espacio cuyo origin es github.com/o/r y un PR abierto (#7 desde `fix/algo`).
    fn mundo_normal(worktrees: String) -> impl Fn(&str, &[String]) -> Salida + Send + Sync {
        move |cmd, args| {
            let linea = args.join(" ");
            match cmd {
                "gh" if linea == "--version" => Salida::ok("gh version 2.60.0\n"),
                "gh" if linea.starts_with("auth status") => Salida::ok(""),
                "gh" if linea.starts_with("api graphql") && linea.contains("updatePullRequestBranch") => Salida::ok("{}"),
                "gh" if linea.starts_with("api graphql") => Salida::ok(&respuesta("fix/algo")),
                "gh" if linea.starts_with("pr merge") => Salida::ok(""),
                "git" if linea.ends_with("remote get-url origin") => Salida::ok("https://github.com/o/r.git\n"),
                "git" if linea.ends_with("worktree list --porcelain") => Salida::ok(&worktrees),
                "git" if linea.contains("rev-parse --is-inside-work-tree") => Salida::ok("true\nC:/x\n"),
                "git" if linea.contains("symbolic-ref") => Salida::ok("main\n"),
                _ => Salida::error(1, &format!("no simulado: {cmd} {linea}")),
            }
        }
    }

    struct Prueba {
        t: EntornoDePrueba,
        sim: Arc<Simulado>,
        router: Router,
        repo: PathBuf,
        hook: Arc<dyn AlHook>,
    }

    fn armar_prueba(nombre: &str, guion: impl Fn(&str, &[String]) -> Salida + Send + Sync + 'static) -> Prueba {
        let t = EntornoDePrueba::nuevo(nombre);
        let repo = t.carpeta.join("repo");
        fs::create_dir_all(&repo).unwrap();
        t.fijar_estado(&json!({ "version": 1, "accounts": [{ "id": "acc" }], "workspaces": [
            { "id": "w1", "repoPath": repo.to_string_lossy(), "cwd": repo.to_string_lossy(), "accountId": "acc", "branch": "main" }
        ] }));
        let sim = Arc::new(Simulado { guion: Box::new(guion), llamadas: Mutex::new(vec![]) });
        let mut router = Router::nuevo(Arc::new(ReenvioNulo));
        let hook = registrar_con(&mut router, armar(t.entorno.clone(), sim.clone()));
        Prueba { t, sim, router, repo, hook }
    }

    fn pr7() -> Value {
        json!({ "repo": "o/r", "number": 7 })
    }

    async fn refrescada(p: &Prueba) -> Value {
        p.router.invocar("feat:prs:refresh".into(), vec![]).await.unwrap()
    }

    #[test]
    fn registra_los_nueve_canales_de_prs() {
        let p = armar_prueba("prs-canales", |_, _| Salida::ok(""));
        for op in ["list", "peek", "refresh", "setOpen", "openUrl", "openBranch", "rebase", "merge", "mergeCommand"] {
            assert!(p.router.atiende(&format!("feat:prs:{op}")), "{op}");
        }
        assert_eq!(p.router.canales().len(), 9);
    }

    #[tokio::test]
    async fn sin_gh_la_instantanea_dice_no_gh_avisa_dos_veces_y_queda_en_prs_json() {
        let p = armar_prueba("prs-singh", |_, _| Salida { code: -1, falta: true, ..Salida::default() });
        let v = refrescada(&p).await;
        assert_eq!((v["problem"].clone(), v["refreshing"].clone()), (json!("no-gh"), json!(false)));
        let ev = p.t.eventos();
        assert_eq!(ev.len(), 2);
        assert_eq!(ev[0].0, "feat:prs:updated");
        assert_eq!((ev[0].1[0]["refreshing"].clone(), ev[1].1[0]["refreshing"].clone()), (json!(true), json!(false)));
        let guardado: Value = serde_json::from_str(&fs::read_to_string(p.t.carpeta.join("perfil/features/prs.json")).unwrap()).unwrap();
        assert_eq!(guardado["version"], json!(2));
        assert_eq!(guardado["snapshot"]["problem"], json!("no-gh"));
        assert!(guardado["snapshot"].get("refreshing").is_none());
    }

    #[tokio::test]
    async fn sin_sesion_de_gh_es_no_login() {
        let p = armar_prueba("prs-sinlogin", |_, a| if a[0] == "--version" { Salida::ok("gh") } else { Salida::error(1, "not logged in") });
        assert_eq!(refrescada(&p).await["problem"], json!("no-login"));
    }

    #[tokio::test]
    async fn refresh_lee_los_pr_de_los_repos_de_los_espacios_y_peek_no_llama_a_gh() {
        let p = armar_prueba("prs-lee", mundo_normal(String::new()));
        let v = refrescada(&p).await;
        assert_eq!(v["problem"], Value::Null);
        assert_eq!(v["login"], json!("yo"));
        assert_eq!(v["repos"][0]["repo"], json!("o/r"));
        assert_eq!(v["repos"][0]["repoPaths"], json!([p.repo.to_string_lossy()]));
        assert_eq!(v["repos"][0]["prs"][0]["number"], json!(7));
        let llamadas = p.sim.llamadas.lock().unwrap().len();
        assert_eq!(p.router.invocar("feat:prs:peek".into(), vec![]).await.unwrap(), v);
        assert_eq!(p.sim.llamadas.lock().unwrap().len(), llamadas);
        let guardado: Value = serde_json::from_str(&fs::read_to_string(p.t.carpeta.join("perfil/features/prs.json")).unwrap()).unwrap();
        assert_eq!(guardado["ids"], json!({ "o/r#7": "PR_kwABC" }));
    }

    #[tokio::test]
    async fn los_pedidos_invalidos_se_rechazan_con_los_mensajes_del_ts() {
        let p = armar_prueba("prs-invalidos", mundo_normal(String::new()));
        refrescada(&p).await;
        let r = &p.router;
        let err = |c: &str, a: Vec<Value>| {
            let c = c.to_string();
            async move { r.invocar(c, a).await.unwrap_err() }
        };
        assert_eq!(err("feat:prs:setOpen", vec![json!("si")]).await, "Valor inválido.");
        assert_eq!(err("feat:prs:openUrl", vec![json!({ "repo": "o/r", "number": 8 }), json!("x")]).await, "Ese PR ya no está en la lista. Refrescá.");
        assert_eq!(err("feat:prs:openUrl", vec![pr7(), json!("https://evil.example")]).await, "Ese link no es de este PR.");
        assert_eq!(err("feat:prs:merge", vec![pr7(), json!("merge"), json!(SHA)]).await, "Ese método de merge no está habilitado en el repo.");
        assert_eq!(err("feat:prs:merge", vec![pr7(), json!("squash"), json!("b".repeat(40))]).await, "El PR cambió desde que lo abriste: revisalo y confirmá de nuevo.");
        assert_eq!(err("feat:prs:openBranch", vec![pr7(), json!("otra")]).await, "Opción inválida.");
        assert!(!p.sim.llamo("pr merge"));
    }

    #[tokio::test]
    async fn merge_corre_gh_fuera_del_repo_y_merge_command_muestra_el_mismo_comando() {
        let p = armar_prueba("prs-merge", mundo_normal(String::new()));
        refrescada(&p).await;
        let cmd = p.router.invocar("feat:prs:mergeCommand".into(), vec![pr7(), json!("squash"), json!(SHA)]).await.unwrap();
        assert_eq!(cmd, json!(["gh", "pr", "merge", "7", "--repo", "o/r", "--squash", "--match-head-commit", SHA]));
        assert_eq!(p.router.invocar("feat:prs:merge".into(), vec![pr7(), json!("squash"), json!(SHA)]).await.unwrap(), json!({ "ok": true }));
        let llamadas = p.sim.llamadas.lock().unwrap().clone();
        let (_, args, cwd) = llamadas.iter().find(|(c, a, _)| c == "gh" && a[0] == "pr").unwrap();
        assert_eq!(args[..], cmd.as_array().unwrap()[1..].iter().map(|x| x.as_str().unwrap().to_string()).collect::<Vec<_>>()[..]);
        assert_eq!(cwd.as_deref(), Some(p.t.carpeta.as_path()));
    }

    #[tokio::test]
    async fn rebase_usa_el_id_de_graphql_guardado() {
        let p = armar_prueba("prs-rebase", mundo_normal(String::new()));
        refrescada(&p).await;
        assert_eq!(p.router.invocar("feat:prs:rebase".into(), vec![pr7(), json!(SHA)]).await.unwrap(), json!({ "ok": true }));
        assert!(p.sim.llamo("id=PR_kwABC"));
    }

    #[tokio::test]
    async fn open_url_abre_solo_el_link_del_pr() {
        let p = armar_prueba("prs-url", mundo_normal(String::new()));
        refrescada(&p).await;
        p.router.invocar("feat:prs:openUrl".into(), vec![pr7(), json!("https://github.com/o/r/pull/7")]).await.unwrap();
        assert_eq!(*p.t.plataforma.abiertos.lock().unwrap(), vec!["https://github.com/o/r/pull/7".to_string()]);
    }

    #[tokio::test]
    async fn open_branch_con_un_worktree_existente_pide_el_espacio_al_dueno_del_store_y_lo_muestra() {
        let wt = std::env::temp_dir().join(format!("sloth-prs-wt-{}", std::process::id()));
        fs::create_dir_all(&wt).unwrap();
        let porcelain = format!("worktree {}\nHEAD {SHA}\nbranch refs/heads/fix/algo\n\n", wt.to_string_lossy());
        let p = armar_prueba("prs-rama", mundo_normal(porcelain));
        let pedidos: Arc<Mutex<Vec<(String, Vec<Value>)>>> = Arc::default();
        let anotados = pedidos.clone();
        p.t.fijar_apoyo(move |canal, args| {
            anotados.lock().unwrap().push((canal.to_string(), args.to_vec()));
            Ok(json!({ "id": "nuevo", "repoPath": args[0]["repoPath"], "cwd": args[0]["repoPath"], "accountId": "acc" }))
        });
        refrescada(&p).await;
        let v = p.router.invocar("feat:prs:openBranch".into(), vec![pr7(), Value::Null]).await.unwrap();
        assert_eq!(v, json!({ "kind": "opened", "id": "nuevo", "created": true }));
        let pedidos = pedidos.lock().unwrap().clone();
        assert_eq!(pedidos.len(), 1);
        assert_eq!(pedidos[0].0, "workspaces:add");
        assert_eq!(pedidos[0].1[0], json!({ "name": "PR #7", "repoPath": wt.to_string_lossy(), "accountId": "acc", "autoStartClaude": false }));
        assert!(p.t.eventos().contains(&("ui:command".to_string(), vec![json!({ "type": "open-pane", "id": "nuevo" })])));
        let _ = fs::remove_dir_all(&wt);
    }

    #[tokio::test]
    async fn al_enfocar_solo_refresca_con_la_vista_abierta() {
        let p = armar_prueba("prs-foco", mundo_normal(String::new()));
        p.hook.al_enfocar();
        std::thread::sleep(Duration::from_millis(200));
        assert!(p.sim.llamadas.lock().unwrap().is_empty());
        p.router.invocar("feat:prs:setOpen".into(), vec![json!(true)]).await.unwrap();
        p.hook.al_enfocar();
        for _ in 0..50 {
            if p.sim.llamo("api graphql") {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(p.sim.llamo("api graphql"));
    }
}
