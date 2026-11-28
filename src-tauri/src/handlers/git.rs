//! Canales `feat:git:*` en Rust. La lógica y la validación viven en `sloth_core::git_feature`; acá solo se
//! conectan sus operaciones con los canales y con la plataforma.
use super::{a_json, arg, AlHook};
use crate::entorno::Entorno;
use crate::router::Router;
use serde_json::{json, Value};
use sloth_core::git_feature::{ContextoGit, GitFeature};
use sloth_core::git_run::{Git, GitError, ProcesoEjecutor};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const NOMBRE: &str = "git";

pub struct ContextoDeGit {
    entorno: Arc<Entorno>,
}

impl ContextoGit for ContextoDeGit {
    fn cwd_de_espacio(&self, id: &str) -> Option<String> {
        self.entorno.cwd_de_espacio(id)
    }

    fn avisar_cambio(&self, id: &str) {
        self.entorno.emitir(NOMBRE, "changed", &[json!(id)]);
    }

    fn registrar_pr(&self, numero: &str) {
        let ahora = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        if let Err(e) = self.entorno.registrar_pr(numero, ahora) {
            sloth_core::logger_global::aviso("perfiles", &format!("no se pudo registrar la actividad: {e}"));
        }
    }

    fn abrir_externo(&self, url: &str) -> Result<(), String> {
        self.entorno.plataforma.abrir_enlace_externo(url)
    }

    fn registrar_error(&self, mensaje: &str) {
        sloth_core::logger_global::aviso(NOMBRE, mensaje);
    }
}

type Funcion = GitFeature<ProcesoEjecutor, ContextoDeGit>;

/// La función se arma en la primera llamada: necesita la carpeta del perfil, que decide el proceso de apoyo al arrancar.
struct Perezosa {
    entorno: Arc<Entorno>,
    dentro: Mutex<Option<Arc<Funcion>>>,
}

impl Perezosa {
    fn obtener(&self) -> Result<Arc<Funcion>, String> {
        let mut g = self.dentro.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(f) = g.as_ref() {
            return Ok(f.clone());
        }
        let archivo = self.entorno.carpeta_features()?.join("git.json");
        let f = Arc::new(GitFeature::new(Git::new(ProcesoEjecutor), ContextoDeGit { entorno: self.entorno.clone() }, archivo));
        for aviso in sloth_core::avisos::Avisos::global().tomar() {
            sloth_core::logger_global::aviso(NOMBRE, &aviso);
        }
        *g = Some(f.clone());
        Ok(f)
    }
}

struct Hook(Arc<Perezosa>);

impl AlHook for Hook {
    fn al_hook(&self, evento: &str, ws: Option<&str>) {
        if let Ok(f) = self.0.obtener() {
            f.al_hook(evento, ws);
        }
    }
}

fn e(r: Result<impl serde::Serialize, GitError>) -> Result<Value, String> {
    a_json(r.map_err(|x| x.mensaje))
}

pub fn registrar(router: &mut Router, entorno: Arc<Entorno>) -> Arc<dyn AlHook> {
    let p = Arc::new(Perezosa { entorno, dentro: Mutex::new(None) });
    macro_rules! canal {
        ($op:literal, |$f:ident, $a:ident| $cuerpo:expr) => {{
            let p = p.clone();
            router.registrar(concat!("feat:git:", $op), move |$a: Vec<Value>| {
                let $f = p.obtener()?;
                let _ = &$a;
                $cuerpo
            });
        }};
    }
    canal!("count", |f, a| e(f.count(arg(&a, 0))));
    canal!("status", |f, a| e(f.status(arg(&a, 0))));
    canal!("diff", |f, a| e(f.diff(arg(&a, 0), arg(&a, 1), arg(&a, 2))));
    canal!("setBase", |f, a| e(f.set_base(arg(&a, 0), arg(&a, 1))));
    canal!("stage", |f, a| e(f.stage(arg(&a, 0), arg(&a, 1))));
    canal!("unstage", |f, a| e(f.unstage(arg(&a, 0), arg(&a, 1))));
    canal!("stageAll", |f, a| e(f.stage_all(arg(&a, 0))));
    canal!("unstageAll", |f, a| e(f.unstage_all(arg(&a, 0))));
    canal!("discard", |f, a| e(f.discard(arg(&a, 0), arg(&a, 1), arg(&a, 2))));
    canal!("commit", |f, a| e(f.commit(arg(&a, 0), arg(&a, 1))));
    canal!("createBranch", |f, a| e(f.create_branch(arg(&a, 0), arg(&a, 1), arg(&a, 2))));
    canal!("log", |f, a| e(f.log(arg(&a, 0))));
    canal!("commitFiles", |f, a| e(f.commit_files(arg(&a, 0), arg(&a, 1))));
    canal!("sync", |f, a| e(f.sync(arg(&a, 0))));
    canal!("push", |f, a| e(f.push(arg(&a, 0), arg(&a, 1))));
    canal!("pull", |f, a| e(f.pull(arg(&a, 0))));
    canal!("branches", |f, a| e(f.branches(arg(&a, 0))));
    canal!("switch", |f, a| e(f.switch(arg(&a, 0), arg(&a, 1), arg(&a, 2))));
    canal!("stashInfo", |f, a| e(f.stash_info(arg(&a, 0))));
    canal!("stashPush", |f, a| e(f.stash_push(arg(&a, 0))));
    canal!("stashRestore", |f, a| e(f.stash_restore(arg(&a, 0))));
    canal!("gh", |f, a| e(Ok::<_, GitError>(f.gh())));
    canal!("prPrepare", |f, a| e(f.pr_prepare(arg(&a, 0), arg(&a, 1))));
    canal!("prCommand", |f, a| e(f.pr_command(arg(&a, 0))));
    canal!("createPr", |f, a| e(f.create_pr(arg(&a, 0), arg(&a, 1))));
    canal!("openUrl", |f, a| e(f.open_url(arg(&a, 0))));
    Arc::new(Hook(p))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_comunes::{EntornoDePrueba, ReenvioNulo};
    use std::fs;
    use std::process::Command;

    fn git(cwd: &std::path::Path, args: &[&str]) {
        let s = Command::new("git").args(args).current_dir(cwd).output().expect("git");
        assert!(s.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&s.stderr));
    }

    fn repo(nombre: &str) -> (EntornoDePrueba, std::path::PathBuf) {
        let t = EntornoDePrueba::nuevo(nombre);
        let r = t.carpeta.join("repo");
        fs::create_dir_all(&r).unwrap();
        git(&r, &["init", "-q", "-b", "trabajo"]);
        git(&r, &["config", "user.email", "t@t"]);
        git(&r, &["config", "user.name", "t"]);
        git(&r, &["config", "commit.gpgsign", "false"]);
        fs::write(r.join("a.txt"), "uno\n").unwrap();
        git(&r, &["add", "."]);
        git(&r, &["commit", "-q", "-m", "inicial"]);
        t.fijar_estado(&json!({ "version": 1, "accounts": [], "workspaces": [{ "id": "w1", "cwd": r.to_string_lossy() }] }));
        (t, r)
    }

    fn router(t: &EntornoDePrueba) -> Router {
        let mut r = Router::nuevo(Arc::new(ReenvioNulo));
        registrar(&mut r, t.entorno.clone());
        r
    }

    #[test]
    fn registra_los_26_canales_de_git_con_los_nombres_de_la_ui() {
        let t = EntornoDePrueba::nuevo("canales");
        let r = router(&t);
        let esperados = [
            "count", "status", "diff", "setBase", "stage", "unstage", "stageAll", "unstageAll", "discard", "commit", "createBranch", "log", "commitFiles", "sync", "push", "pull", "branches",
            "switch", "stashInfo", "stashPush", "stashRestore", "gh", "prPrepare", "prCommand", "createPr", "openUrl",
        ];
        assert_eq!(r.canales().len(), esperados.len());
        for op in esperados {
            assert!(r.atiende(&format!("feat:git:{op}")), "{op}");
        }
    }

    #[tokio::test]
    async fn antes_de_que_el_apoyo_avise_el_perfil_responde_que_esta_arrancando() {
        let t = EntornoDePrueba::sin_perfil("sinperfil");
        let r = router(&t);
        assert_eq!(r.invocar("feat:git:status".into(), vec![json!("w1")]).await, Err("Sloth todavía está arrancando.".to_string()));
    }

    #[tokio::test]
    async fn los_argumentos_invalidos_se_rechazan_con_el_mensaje_de_siempre() {
        let (t, _) = repo("invalidos");
        let r = router(&t);
        assert_eq!(r.invocar("feat:git:status".into(), vec![json!(7)]).await, Err("Espacio inválido.".to_string()));
        assert_eq!(r.invocar("feat:git:status".into(), vec![]).await, Err("Espacio inválido.".to_string()));
        assert_eq!(r.invocar("feat:git:status".into(), vec![json!("fantasma")]).await, Err("El espacio ya no existe.".to_string()));
        assert_eq!(r.invocar("feat:git:commit".into(), vec![json!("w1"), json!("  ")]).await, Err("El mensaje del commit es obligatorio.".to_string()));
        assert_eq!(
            r.invocar("feat:git:openUrl".into(), vec![json!("https://evil.example/pull/1")]).await,
            Err("Solo se abren links https://github.com/…/pull/N.".to_string())
        );
        assert_eq!(r.invocar("feat:git:stage".into(), vec![json!("w1"), json!("../../etc/passwd")]).await, Err("Ese archivo ya no tiene cambios.".to_string()));
    }

    #[tokio::test]
    async fn status_stage_commit_y_log_andan_de_punta_a_punta_sobre_un_repo_real() {
        let (t, r) = repo("flujo");
        let router = router(&t);
        fs::write(r.join("a.txt"), "uno\ndos\n").unwrap();
        let st = router.invocar("feat:git:status".into(), vec![json!("w1")]).await.unwrap();
        assert_eq!(st["isRepo"], json!(true));
        assert_eq!(st["branch"], json!("trabajo"));
        assert_eq!(st["files"][0]["path"], json!("a.txt"));
        assert_eq!(router.invocar("feat:git:count".into(), vec![json!("w1")]).await.unwrap(), json!(1));
        assert_eq!(router.invocar("feat:git:stage".into(), vec![json!("w1"), json!("a.txt")]).await.unwrap(), json!(true));
        router.invocar("feat:git:commit".into(), vec![json!("w1"), json!("segundo")]).await.unwrap();
        let log = router.invocar("feat:git:log".into(), vec![json!("w1")]).await.unwrap();
        assert_eq!(log[0]["title"], json!("segundo"));
        assert_eq!(log.as_array().unwrap().len(), 2);
        let cambios = t.eventos();
        assert_eq!(cambios.iter().filter(|(c, _)| c == "feat:git:changed").count(), 2);
        assert!(cambios.iter().all(|(_, a)| a == &vec![json!("w1")]));
    }

    #[test]
    fn el_hook_stop_avisa_a_la_ui_y_los_demas_no() {
        let (t, _) = repo("hook");
        let mut r = Router::nuevo(Arc::new(ReenvioNulo));
        let h = registrar(&mut r, t.entorno.clone());
        h.al_hook("PreToolUse", Some("w1"));
        h.al_hook("Stop", None);
        assert!(t.eventos().is_empty());
        h.al_hook("Stop", Some("w1"));
        assert_eq!(t.eventos(), vec![("feat:git:changed".to_string(), vec![json!("w1")])]);
    }

}
