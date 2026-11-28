//! Canales `feat:worktrees:*` en Rust («Ramas aparte»). El escaneo, la validación y los tamaños viven en
//! `sloth_core::worktrees_feature`; acá está su contexto: los espacios se leen del estado y lo que lo cambia (alta y baja
//! de espacios) o toca terminales se pide al dueño por el router (`workspaces:add`, `workspaces:remove`, `pty:kill`).
//!
//! Diferencia con el TS: el espacio que se abre con una rama nueva se da de alta por `workspaces:add` con la carpeta de
//! la rama como repo (igual que «Abrir rama» de prs). Ese canal crearía otro worktree si se le pasara la rama.
use super::comun::{self, texto};
use super::{a_json, arg};
use crate::entorno::Entorno;
use crate::router::Router;
use serde_json::{json, Value};
use sloth_core::git_run::{Ejecutor, Git, GitError, ProcesoEjecutor};
use sloth_core::worktrees_feature::{ContextoWorktrees, CuentaRef, NuevoEspacio, Worktrees};
use sloth_core::worktrees_scan::{Escaner, WsRef};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const NOMBRE: &str = "worktrees";

const ALTA_DE_ESPACIO: Duration = Duration::from_secs(60);
const PEDIDO: Duration = Duration::from_secs(20);

pub struct Contexto {
    entorno: Arc<Entorno>,
    /// El núcleo elige un id para el espacio nuevo; el dueño del store le pone el suyo. Pedido → real, o el error.
    altas: Altas,
}

type Altas = Arc<Mutex<HashMap<String, Result<String, String>>>>;

fn real(altas: &Altas, pedido: &str) -> Option<Result<String, String>> {
    altas.lock().unwrap_or_else(|e| e.into_inner()).get(pedido).cloned()
}


impl ContextoWorktrees for Contexto {
    fn espacios(&self) -> Vec<WsRef> {
        let cuentas = comun::cuentas(&self.entorno);
        comun::espacios(&self.entorno)
            .iter()
            .filter_map(|w| {
                let acc = texto(w, "accountId");
                Some(WsRef {
                    id: texto(w, "id")?,
                    name: texto(w, "name").unwrap_or_default(),
                    repo_path: texto(w, "repoPath")?,
                    cwd: texto(w, "cwd")?,
                    account_label: cuentas.iter().find(|a| texto(a, "id") == acc).and_then(|a| texto(a, "label")),
                })
            })
            .collect()
    }

    fn cuenta(&self, id: &str) -> Option<CuentaRef> {
        let a = comun::cuenta(&self.entorno, id)?;
        Some(CuentaRef { id: id.to_string(), label: texto(&a, "label").unwrap_or_default(), config_dir: texto(&a, "configDir").unwrap_or_default() })
    }

    fn exigir_escritura(&self) -> Result<(), String> {
        comun::exigir_escritura(&self.entorno)
    }

    fn cerrar_terminal(&self, id: &str) -> Result<(), String> {
        self.entorno.pedir("pty:kill", vec![json!(id)], PEDIDO).map(|_| ())
    }

    fn quitar_espacio(&self, id: &str) {
        if let Err(e) = self.entorno.pedir("workspaces:remove", vec![json!(id)], PEDIDO) {
            sloth_core::logger_global::aviso(NOMBRE, &format!("no se pudo quitar el espacio {id}: {e}"));
        }
    }

    fn nuevo_id(&self) -> String {
        comun::nuevo_uuid()
    }

    fn agregar_espacio(&self, e: NuevoEspacio) {
        let input = json!({ "name": e.name, "repoPath": e.cwd, "accountId": e.account_id, "autoStartClaude": true, "resume": true });
        let r = self.entorno.pedir("workspaces:add", vec![input], ALTA_DE_ESPACIO).and_then(|ws| texto(&ws, "id").ok_or_else(|| "No se pudo crear el espacio.".to_string()));
        self.altas.lock().unwrap_or_else(|e| e.into_inner()).insert(e.id, r);
    }

    fn ui_recargar(&self) {
        comun::ui(&self.entorno, json!({ "type": "reload" }));
    }

    fn ui_abrir_panel(&self, id: &str) {
        if let Some(Ok(real)) = real(&self.altas, id) {
            comun::ui(&self.entorno, json!({ "type": "open-pane", "id": real }));
        }
    }

    fn actividad_agente(&self, id: &str) -> u64 {
        // Se pide una vez por escaneo a lo sumo por espacio con rama; el estado de los agentes es del dueño de las terminales.
        comun::estado_del_dueno(&self.entorno)["agents"][id]["at"].as_u64().unwrap_or(0)
    }

    fn emitir_tamano(&self, path: &str, bytes: Option<u64>, partial: bool) {
        self.entorno.emitir(NOMBRE, "size", &[json!({ "path": path, "bytes": bytes, "partial": partial })]);
    }

    fn abrir_carpeta(&self, path: &str) -> String {
        self.entorno.plataforma.abrir_ruta(path).err().unwrap_or_default()
    }
}

type Funcion<E> = Worktrees<E, Contexto>;

fn texto_de(r: Result<Value, GitError>) -> Result<Value, String> {
    r.map_err(|e| e.mensaje)
}

fn crear<E: Ejecutor + 'static>(f: &Funcion<E>, altas: &Altas, x: &Value) -> Result<Value, String> {
    let creada = f.create(x).map_err(|e| e.mensaje)?;
    let mut v = serde_json::to_value(&creada).map_err(|e| e.to_string())?;
    if let Some(pedido) = &creada.space_id {
        match real(altas, pedido) {
            Some(Ok(real)) => v["spaceId"] = json!(real),
            Some(Err(e)) => return Err(format!("Se creó la rama aparte en {}, pero no su espacio: {e}", creada.path)),
            None => {}
        }
    }
    Ok(v)
}

fn registrar_con<E: Ejecutor + 'static>(router: &mut Router, f: Arc<Funcion<E>>, altas: Altas) {
    macro_rules! canal {
        ($op:literal, |$f:ident, $a:ident| $cuerpo:expr) => {{
            let $f = f.clone();
            router.registrar(concat!("feat:worktrees:", $op), move |$a: Vec<Value>| {
                let _ = &$a;
                $cuerpo
            });
        }};
    }
    canal!("scan", |f, a| a_json(Ok(f.scan())));
    canal!("create", |f, a| crear(&f, &altas, arg(&a, 0)));
    canal!("remove", |f, a| texto_de(f.remove(arg(&a, 0)).and_then(|r| serde_json::to_value(r).map_err(|e| GitError::nuevo(e.to_string())))));
    canal!("clean", |f, a| texto_de(f.clean(arg(&a, 0)).and_then(|r| serde_json::to_value(r).map_err(|e| GitError::nuevo(e.to_string())))));
    canal!("openFolder", |f, a| f.open_folder(arg(&a, 0)).map(Value::String).map_err(|e| e.mensaje));
    canal!("sizes", |f, a| texto_de(f.sizes(arg(&a, 0)).and_then(|r| serde_json::to_value(r).map_err(|e| GitError::nuevo(e.to_string())))));
    canal!("sizesCancel", |f, a| Ok(json!(f.sizes_cancel())));
}

pub fn registrar(router: &mut Router, entorno: Arc<Entorno>) {
    let altas = Altas::default();
    let f = Worktrees::new(Escaner::new(Git::new(ProcesoEjecutor)), Contexto { entorno, altas: altas.clone() });
    registrar_con(router, f, altas);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_comunes::{EntornoDePrueba, ReenvioNulo};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn git(cwd: &Path, args: &[&str]) {
        let s = Command::new("git").arg("-C").arg(cwd).args(args).output().expect("git instalado");
        assert!(s.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&s.stderr));
    }

    struct Prueba {
        t: EntornoDePrueba,
        router: Router,
        repo: PathBuf,
        pedidos: Arc<Mutex<Vec<(String, Vec<Value>)>>>,
    }

    /// Un repo git real con un commit en `main` y un espacio que lo usa.
    fn armar_prueba(nombre: &str) -> Prueba {
        let t = EntornoDePrueba::nuevo(nombre);
        let repo = t.carpeta.join("repo");
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "uno"]);
        let config = t.carpeta.join("cuenta");
        fs::create_dir_all(&config).unwrap();
        let r = repo.to_string_lossy().into_owned();
        t.fijar_estado(&json!({ "version": 1, "accounts": [{ "id": "acc", "label": "Trabajo", "configDir": config.to_string_lossy() }], "workspaces": [
            { "id": "w1", "name": "Repo", "repoPath": r, "cwd": r, "accountId": "acc" }
        ] }));
        let pedidos: Arc<Mutex<Vec<(String, Vec<Value>)>>> = Arc::default();
        let anotados = pedidos.clone();
        t.fijar_apoyo(move |canal, args| {
            anotados.lock().unwrap().push((canal.to_string(), args.to_vec()));
            match canal {
                "workspaces:add" => Ok(json!({ "id": "real", "name": args[0]["name"] })),
                "state:get" => Ok(json!({ "agents": {} })),
                _ => Ok(Value::Null),
            }
        });
        let mut router = Router::nuevo(Arc::new(ReenvioNulo));
        registrar(&mut router, t.entorno.clone());
        Prueba { t, router, repo, pedidos }
    }

    impl Prueba {
        async fn pedir(&self, op: &str, args: Vec<Value>) -> Result<Value, String> {
            self.router.invocar(format!("feat:worktrees:{op}"), args).await
        }
    }

    #[test]
    fn registra_los_siete_canales() {
        let p = armar_prueba("wt-canales");
        for op in ["scan", "create", "remove", "clean", "openFolder", "sizes", "sizesCancel"] {
            assert!(p.router.atiende(&format!("feat:worktrees:{op}")), "{op}");
        }
        assert_eq!(p.router.canales().len(), 7);
    }

    #[tokio::test]
    async fn crear_con_espacio_lo_pide_al_dueno_y_devuelve_su_id() {
        let p = armar_prueba("wt-crear");
        let v = p.pedir("scan", vec![]).await.unwrap();
        let main = v[0]["mainPath"].as_str().unwrap().to_string();
        assert_eq!(v[0]["rows"][0]["isMain"], json!(true));
        let c = p.pedir("create", vec![json!({ "repoPath": main, "name": "fix/algo", "base": "main", "openSpace": true, "accountId": "acc" })]).await.unwrap();
        assert_eq!(c["branch"], json!("fix/algo"));
        assert_eq!(c["spaceId"], json!("real"));
        let carpeta = c["path"].as_str().unwrap().to_string();
        assert!(Path::new(&carpeta).is_dir());
        let add = p.pedidos.lock().unwrap().iter().find(|(c, _)| c == "workspaces:add").cloned().unwrap();
        assert_eq!(add.1[0], json!({ "name": "algo", "repoPath": carpeta, "accountId": "acc", "autoStartClaude": true, "resume": true }));
        let ev = p.t.eventos();
        assert!(ev.contains(&("ui:command".to_string(), vec![json!({ "type": "reload" })])));
        assert!(ev.contains(&("ui:command".to_string(), vec![json!({ "type": "open-pane", "id": "real" })])));
        let _ = fs::remove_dir_all(&carpeta);
    }

    #[tokio::test]
    async fn la_validacion_es_la_del_ts() {
        let p = armar_prueba("wt-valida");
        assert_eq!(p.pedir("openFolder", vec![json!("C:\\nada")]).await.unwrap_err(), "Esa rama aparte no está en la última lista. Volvé a abrir «Ramas aparte».");
        assert_eq!(p.pedir("clean", vec![json!([])]).await.unwrap_err(), "Nada para limpiar.");
        assert_eq!(p.pedir("sizes", vec![json!("x")]).await.unwrap_err(), "Lista de carpetas inválida.");
        assert_eq!(p.pedir("create", vec![json!({ "repoPath": "C:\\x", "base": "main" })]).await.unwrap_err(), "Ese repo ya no está en la lista. Volvé a abrir «Ramas aparte».");
        assert_eq!(p.pedir("sizesCancel", vec![]).await.unwrap(), json!(true));
    }

    #[tokio::test]
    async fn quitar_la_copia_principal_no_se_puede() {
        let p = armar_prueba("wt-quitar");
        let v = p.pedir("scan", vec![]).await.unwrap();
        let main = v[0]["mainPath"].clone();
        let r = p.pedir("remove", vec![json!({ "path": main })]).await.unwrap();
        assert_eq!((r["ok"].clone(), r["error"].clone()), (json!(false), json!("La copia principal no se quita.")));
        assert!(p.repo.is_dir());
    }

    #[tokio::test]
    async fn quitar_una_rama_con_espacio_cierra_su_terminal_y_pide_la_baja() {
        let p = armar_prueba("wt-quitar-esp");
        let v = p.pedir("scan", vec![]).await.unwrap();
        let main = v[0]["mainPath"].as_str().unwrap().to_string();
        let c = p.pedir("create", vec![json!({ "repoPath": main, "name": "otra", "base": "main" })]).await.unwrap();
        let carpeta = c["path"].as_str().unwrap().to_string();
        let r = p.repo.to_string_lossy().into_owned();
        p.t.fijar_estado(&json!({ "version": 1, "accounts": [], "workspaces": [
            { "id": "w1", "name": "Repo", "repoPath": r, "cwd": r, "accountId": "acc" },
            { "id": "w2", "name": "Otra", "repoPath": r, "cwd": carpeta, "accountId": "acc" }
        ] }));
        p.pedir("scan", vec![]).await.unwrap();
        let res = p.pedir("remove", vec![json!({ "path": carpeta })]).await.unwrap();
        assert_eq!(res, json!({ "path": carpeta, "ok": true, "closedSpaces": ["Otra"] }));
        let canales: Vec<(String, Vec<Value>)> = p.pedidos.lock().unwrap().clone();
        assert!(canales.contains(&("pty:kill".to_string(), vec![json!("w2")])));
        assert!(canales.contains(&("workspaces:remove".to_string(), vec![json!("w2")])));
        assert!(!Path::new(&carpeta).exists());
    }

    #[tokio::test]
    async fn con_el_estado_en_solo_lectura_no_se_quita_nada() {
        let p = armar_prueba("wt-solo-lectura");
        p.t.fijar_apoyo(|canal, _| match canal {
            "state:get" => Ok(json!({ "agents": {}, "soloLectura": { "motivo": "sloth-state.json está dañado", "causa": "ilegible" } })),
            _ => Ok(Value::Null),
        });
        let v = p.pedir("scan", vec![]).await.unwrap();
        let main = v[0]["mainPath"].as_str().unwrap().to_string();
        let c = p.pedir("create", vec![json!({ "repoPath": main, "name": "tercera", "base": "main" })]).await.unwrap();
        let carpeta = c["path"].as_str().unwrap().to_string();
        let r = p.repo.to_string_lossy().into_owned();
        p.t.fijar_estado(&json!({ "version": 1, "accounts": [], "workspaces": [{ "id": "w3", "name": "T", "repoPath": r, "cwd": carpeta, "accountId": "acc" }] }));
        p.pedir("scan", vec![]).await.unwrap();
        let res = p.pedir("remove", vec![json!({ "path": carpeta })]).await.unwrap();
        assert_eq!(res["error"], json!("No se va a guardar: sloth-state.json está dañado. Reiniciá Sloth cuando sloth-state.json se pueda leer."));
        assert!(Path::new(&carpeta).is_dir());
        let _ = fs::remove_dir_all(&carpeta);
    }
}
