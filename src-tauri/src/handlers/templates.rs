//! Canales `feat:templates:*` en Rust: plantillas de espacio en `features/templates.json` (versionado y escritura atómica
//! en `sloth_core::features::templates::ArchivoPlantillas`). Crear un espacio desde una plantilla lo pide al dueño del
//! store (`workspaces:add`); el uso de las cuentas y sus sesiones también se le piden (`accounts:usage`,
//! `accounts:statuses`), así no hay dos lecturas distintas de lo mismo.
use super::comun::{self, ahora_ms, desfase_local_min, es_dir, texto};
use super::{a_json, arg};
use crate::entorno::Entorno;
use crate::router::Router;
use serde_json::{json, Value};
use sloth_core::avisos::Avisos;
use sloth_core::features::proceso::{normalizar_ruta, Ejecutor, Real};
use sloth_core::features::templates::{armar_espacio, ArchivoPlantillas, Entorno as EntornoPlantillas, Plantilla, VarsDeCreacion, SUGGESTED};
use sloth_core::proveedores::cuenta_sugerida;
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const NOMBRE: &str = "templates";

const ALTA_DE_ESPACIO: Duration = Duration::from_secs(180);
const ESPERA_USO: Duration = Duration::from_secs(4);

pub struct Plantillas {
    entorno: Arc<Entorno>,
    ejecutor: Arc<dyn Ejecutor>,
    archivo: Mutex<Option<ArchivoPlantillas<'static>>>,
    creando: Mutex<bool>,
}

fn avisar_pendientes() {
    for aviso in Avisos::global().tomar() {
        sloth_core::logger_global::aviso(NOMBRE, &aviso);
    }
}

impl Plantillas {
    fn con_archivo<T>(&self, f: impl FnOnce(&mut ArchivoPlantillas<'static>) -> Result<T, String>) -> Result<T, String> {
        let mut g = self.archivo.lock().unwrap_or_else(|e| e.into_inner());
        if g.is_none() {
            let file = self.entorno.carpeta_features()?.join("templates.json");
            *g = Some(ArchivoPlantillas::abrir(&file, Avisos::global(), Box::new(comun::nuevo_uuid)));
        }
        let r = f(g.as_mut().expect("recién abierto"));
        drop(g);
        avisar_pendientes();
        r
    }

    /// Ids de plantillas que vienen del equipo (team-config las mapea al importarlas). Solo lectura.
    fn ids_del_equipo(&self) -> HashSet<String> {
        let Ok(dir) = self.entorno.carpeta_features() else { return HashSet::new() };
        let Ok(t) = std::fs::read_to_string(dir.join("team-config.json")) else { return HashSet::new() };
        let Ok(v) = serde_json::from_str::<Value>(t.strip_prefix('\u{feff}').unwrap_or(&t)) else { return HashSet::new() };
        let mut ids = HashSet::new();
        for e in v.get("teams").and_then(Value::as_object).into_iter().flat_map(|m| m.values()) {
            for id in e.get("mapping").and_then(Value::as_object).into_iter().flat_map(|m| m.values()).filter_map(Value::as_str) {
                ids.insert(id.to_string());
            }
        }
        ids
    }

    fn vista(&self) -> Result<Value, String> {
        let equipo = self.ids_del_equipo();
        self.con_archivo(|f| {
            let lista: Vec<Value> = f
                .todas()
                .iter()
                .map(|t| {
                    let mut v = t.a_json();
                    v["team"] = json!(equipo.contains(&t.id));
                    v
                })
                .collect();
            Ok(json!({ "list": lista, "defaultId": f.id_predeterminada() }))
        })
    }

    fn cambio(&self) {
        match self.vista() {
            Ok(v) => self.entorno.emitir(NOMBRE, "changed", &[v]),
            Err(e) => sloth_core::logger_global::aviso(NOMBRE, &e),
        }
    }

    fn entorno_plantillas<T>(&self, f: impl FnOnce(&EntornoPlantillas) -> T) -> T {
        let ids: HashSet<String> = comun::cuentas(&self.entorno).iter().filter_map(|a| texto(a, "id")).collect();
        let ahora = ahora_ms();
        let existe = |id: &str| ids.contains(id);
        let carpeta = |p: &str| es_dir(p) && p.chars().count() <= 1000;
        f(&EntornoPlantillas { cuenta_existe: &existe, carpeta_valida: &carpeta, ahora_ms: ahora as f64, desfase_min: desfase_local_min(ahora) })
    }

    fn save(&self, raw: &Value) -> Result<Value, String> {
        let t = self.entorno_plantillas(|e| self.con_archivo(|f| f.guardar_plantilla(raw, e)))?;
        self.cambio();
        Ok(t.a_json())
    }

    fn remove(&self, id: &Value) -> Result<Value, String> {
        if id.as_str().is_some_and(|i| self.ids_del_equipo().contains(i)) {
            return Err("Las plantillas del equipo no se borran. Duplicala y borrá tu copia.".into());
        }
        self.con_archivo(|f| f.quitar(id))?;
        self.cambio();
        Ok(Value::Null)
    }

    fn duplicate(&self, id: &Value) -> Result<Value, String> {
        let t = self.con_archivo(|f| f.duplicar(id, ahora_ms() as f64))?;
        self.cambio();
        Ok(t.a_json())
    }

    fn set_default(&self, id: &Value) -> Result<Value, String> {
        if !id.is_null() && !id.is_string() {
            return Err("Datos inválidos.".into());
        }
        self.con_archivo(|f| f.fijar_predeterminada(id))?;
        self.cambio();
        Ok(Value::Null)
    }

    fn used(&self, id: &Value) -> Result<Value, String> {
        self.con_archivo(|f| f.sumar_uso(id))?;
        self.cambio();
        Ok(Value::Null)
    }

    fn git(&self, cwd: &str, args: &[&str]) -> sloth_core::features::proceso::Salida {
        let mut todos: Vec<String> = vec!["-C".into(), cwd.into(), "-c".into(), "core.quotepath=false".into()];
        todos.extend(args.iter().map(|s| s.to_string()));
        self.ejecutor.ejecutar("git", &todos, None, Duration::from_secs(15))
    }

    fn folder(&self, p: &Value) -> Value {
        let path = p.as_str().map(str::trim).unwrap_or_default().to_string();
        let name = comun::nombre_base(&path);
        if path.is_empty() || path.encode_utf16().count() > 1000 || !Path::new(&path).is_absolute() || !es_dir(&path) {
            return json!({ "path": path, "name": name, "exists": false, "isGit": false, "branch": null, "spaces": [] });
        }
        let r = self.git(&path, &["rev-parse", "--is-inside-work-tree"]);
        let es_git = r.code == 0 && r.stdout.trim() == "true";
        let rama = es_git
            .then(|| self.git(&path, &["symbolic-ref", "--short", "-q", "HEAD"]))
            .filter(|b| b.code == 0 && !b.stdout.trim().is_empty())
            .map(|b| b.stdout.trim().to_string());
        let clave = normalizar_ruta(&path);
        let cuentas = comun::cuentas(&self.entorno);
        let espacios: Vec<Value> = comun::espacios(&self.entorno)
            .iter()
            .filter(|w| [texto(w, "repoPath"), texto(w, "cwd")].iter().flatten().any(|c| normalizar_ruta(c) == clave))
            .map(|w| {
                let acc = texto(w, "accountId").unwrap_or_default();
                let label = cuentas.iter().find(|a| texto(a, "id").as_deref() == Some(acc.as_str())).and_then(|a| texto(a, "label")).unwrap_or_else(|| "cuenta borrada".into());
                json!({ "id": texto(w, "id"), "name": texto(w, "name"), "accountId": acc, "accountLabel": label })
            })
            .collect();
        json!({ "path": path, "name": name, "exists": true, "isGit": es_git, "branch": rama, "spaces": espacios })
    }

    fn recent(&self) -> Result<Value, String> {
        let espacios = comun::espacios(&self.entorno);
        let mut vistos = HashSet::new();
        let mut rutas: Vec<String> = Vec::new();
        for w in espacios.iter().rev() {
            let Some(p) = texto(w, "repoPath") else { continue };
            if vistos.insert(normalizar_ruta(&p)) {
                rutas.push(p);
            }
        }
        let carpetas: Vec<Value> = rutas.iter().take(6).map(|p| self.folder(&json!(p))).filter(|f| f["exists"] == json!(true)).collect();
        let mut cuentas = serde_json::Map::new();
        for w in &espacios {
            let k = texto(w, "accountId").unwrap_or_default();
            let n = cuentas.get(&k).and_then(Value::as_u64).unwrap_or(0) + 1;
            cuentas.insert(k, json!(n));
        }
        Ok(json!({ "folders": carpetas, "counts": cuentas }))
    }

    fn branches(&self, p: &Value) -> Value {
        let path = p.as_str().map(str::trim).unwrap_or_default();
        let vacio = json!({ "branches": [], "defaultBase": null });
        if path.is_empty() || !es_dir(path) {
            return vacio;
        }
        let r = self.git(path, &["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"]);
        if r.code != 0 {
            return vacio;
        }
        let lista: Vec<String> = r.stdout.lines().map(str::trim).filter(|x| !x.is_empty() && *x != "origin/HEAD").take(300).map(String::from).collect();
        let cur = self.git(path, &["symbolic-ref", "--short", "-q", "HEAD"]);
        let actual = if cur.code == 0 { cur.stdout.trim().to_string() } else { String::new() };
        // Por defecto: staging del remoto si existe; si no, la rama actual.
        let base = if lista.iter().any(|b| b == "origin/staging") {
            Some("origin/staging".to_string())
        } else if !actual.is_empty() {
            Some(actual)
        } else {
            lista.first().cloned()
        };
        json!({ "branches": lista, "defaultBase": base })
    }

    fn resolver_cuenta(&self, t: &Plantilla) -> Result<String, String> {
        let cuentas = comun::cuentas(&self.entorno);
        if t.account_id != SUGGESTED {
            if !cuentas.iter().any(|a| texto(a, "id").as_deref() == Some(t.account_id.as_str())) {
                return Err(format!("La cuenta de la plantilla «{}» ya no existe. Editala y elegí otra.", t.name));
            }
            return Ok(t.account_id.clone());
        }
        if cuentas.is_empty() {
            return Err("Agregá una cuenta primero.".into());
        }
        // Incremental y cacheado del lado del dueño; si tarda, se elige solo por la sesión.
        let uso = self.entorno.pedir("accounts:usage", vec![], ESPERA_USO).unwrap_or(Value::Null);
        let estados = self.entorno.pedir("accounts:statuses", vec![], ESPERA_USO).unwrap_or(Value::Null);
        let total = |id: &str| {
            let t = &uso[id]["last5h"];
            ["input", "output", "cacheWrite", "cacheRead"].iter().map(|k| t[*k].as_f64().unwrap_or(0.0)).sum::<f64>()
        };
        let con_sesion = |id: &str| estados[id]["loggedIn"].as_bool().unwrap_or(false);
        cuenta_sugerida(&cuentas, &con_sesion, &total).ok_or_else(|| "No hay ninguna cuenta para usar.".to_string())
    }

    fn create(&self, id: &Value, vars: &Value) -> Result<Value, String> {
        let t = self.con_archivo(|f| Ok(f.obtener(id).cloned()))?.ok_or("Esa plantilla ya no existe.")?;
        if !vars.is_null() && !vars.is_object() {
            return Err("Datos inválidos.".into());
        }
        // Un argumento que no vino llega como null: equivale al `undefined` del TS.
        let repo_var = vars.get("repoPath").and_then(Value::as_str).map(String::from);
        let ticket = vars.get("ticket").and_then(Value::as_str).map(String::from);
        {
            let mut c = self.creando.lock().unwrap_or_else(|e| e.into_inner());
            if *c {
                return Err("Ya se está creando un espacio; esperá un momento.".into());
            }
            if t.repo_path.is_none() && repo_var.is_none() {
                return Err("Esta plantilla no tiene carpeta: elegila al crear el espacio.".into());
            }
            *c = true;
        }
        struct Fin<'a>(&'a Mutex<bool>);
        impl Drop for Fin<'_> {
            fn drop(&mut self) {
                *self.0.lock().unwrap_or_else(|e| e.into_inner()) = false;
            }
        }
        let _fin = Fin(&self.creando);
        let cuenta = self.resolver_cuenta(&t)?;
        let repo = t.repo_path.clone().or(repo_var);
        let rama = repo.as_ref().and_then(|r| self.folder(&json!(r))["branch"].as_str().map(String::from));
        let ahora = ahora_ms();
        let (input, n) = armar_espacio(&t, &VarsDeCreacion { ticket, repo_path: repo, current_branch: rama }, &cuenta, ahora as f64, desfase_local_min(ahora))?;
        let ws = self.entorno.pedir("workspaces:add", vec![serde_json::to_value(&input).map_err(|e| e.to_string())?], ALTA_DE_ESPACIO)?;
        self.con_archivo(|f| f.fijar_contador(&t.id, n))?;
        self.cambio();
        if let Some(wid) = texto(&ws, "id") {
            comun::ui(&self.entorno, json!({ "type": "open-pane", "id": wid }));
        }
        Ok(ws)
    }
}

pub fn armar(entorno: Arc<Entorno>, ejecutor: Arc<dyn Ejecutor>) -> Arc<Plantillas> {
    Arc::new(Plantillas { entorno, ejecutor, archivo: Mutex::new(None), creando: Mutex::new(false) })
}

pub fn registrar(router: &mut Router, entorno: Arc<Entorno>) {
    registrar_con(router, armar(entorno, Arc::new(Real)));
}

fn registrar_con(router: &mut Router, p: Arc<Plantillas>) {
    macro_rules! canal {
        ($op:literal, |$f:ident, $a:ident| $cuerpo:expr) => {{
            let $f = p.clone();
            router.registrar(concat!("feat:templates:", $op), move |$a: Vec<Value>| {
                let _ = &$a;
                $cuerpo
            });
        }};
    }
    canal!("list", |f, a| f.vista());
    canal!("save", |f, a| f.save(arg(&a, 0)));
    canal!("remove", |f, a| f.remove(arg(&a, 0)));
    canal!("duplicate", |f, a| f.duplicate(arg(&a, 0)));
    canal!("setDefault", |f, a| f.set_default(arg(&a, 0)));
    canal!("used", |f, a| f.used(arg(&a, 0)));
    canal!("folder", |f, a| Ok(f.folder(arg(&a, 0))));
    canal!("recent", |f, a| f.recent());
    canal!("branches", |f, a| Ok(f.branches(arg(&a, 0))));
    canal!("create", |f, a| a_json(f.create(arg(&a, 0), arg(&a, 1))));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_comunes::{EntornoDePrueba, ReenvioNulo};
    use sloth_core::features::proceso::Salida;
    use std::fs;
    use std::path::PathBuf;

    struct GitSimulado;

    impl Ejecutor for GitSimulado {
        fn ejecutar(&self, _: &str, args: &[String], _: Option<&Path>, _: Duration) -> Salida {
            let linea = args.join(" ");
            if linea.contains("rev-parse --is-inside-work-tree") {
                Salida::ok("true\n")
            } else if linea.contains("symbolic-ref") {
                Salida::ok("main\n")
            } else if linea.contains("for-each-ref") {
                Salida::ok("main\norigin/HEAD\norigin/main\norigin/staging\n")
            } else {
                Salida::error(1, "no simulado")
            }
        }
    }

    struct Prueba {
        t: EntornoDePrueba,
        router: Router,
        repo: PathBuf,
        pedidos: Arc<Mutex<Vec<(String, Vec<Value>)>>>,
    }

    fn armar_prueba(nombre: &str) -> Prueba {
        let t = EntornoDePrueba::nuevo(nombre);
        let repo = t.carpeta.join("repo");
        fs::create_dir_all(&repo).unwrap();
        let r = repo.to_string_lossy().into_owned();
        t.fijar_estado(&json!({ "version": 1, "accounts": [{ "id": "a1", "label": "Uno" }, { "id": "a2", "label": "Dos" }], "workspaces": [
            { "id": "w1", "name": "Repo", "repoPath": r, "cwd": r, "accountId": "a1" }
        ] }));
        let pedidos: Arc<Mutex<Vec<(String, Vec<Value>)>>> = Arc::default();
        let anotados = pedidos.clone();
        t.fijar_apoyo(move |canal, args| {
            anotados.lock().unwrap().push((canal.to_string(), args.to_vec()));
            match canal {
                "accounts:usage" => Ok(json!({ "a1": { "last5h": { "input": 900, "output": 0, "cacheWrite": 0, "cacheRead": 0 } }, "a2": { "last5h": { "input": 5, "output": 0, "cacheWrite": 0, "cacheRead": 0 } } })),
                "accounts:statuses" => Ok(json!({ "a1": { "loggedIn": true }, "a2": { "loggedIn": true } })),
                "workspaces:add" => Ok(json!({ "id": "nuevo", "name": args[0]["name"], "accountId": args[0]["accountId"] })),
                _ => Ok(Value::Null),
            }
        });
        let mut router = Router::nuevo(Arc::new(ReenvioNulo));
        registrar_con(&mut router, armar(t.entorno.clone(), Arc::new(GitSimulado)));
        Prueba { t, router, repo, pedidos }
    }

    impl Prueba {
        async fn pedir(&self, op: &str, args: Vec<Value>) -> Result<Value, String> {
            self.router.invocar(format!("feat:templates:{op}"), args).await
        }
        fn guardado(&self) -> Value {
            serde_json::from_str(&fs::read_to_string(self.t.carpeta.join("perfil/features/templates.json")).unwrap()).unwrap()
        }
    }

    #[test]
    fn registra_los_diez_canales() {
        let p = armar_prueba("tpl-canales");
        for op in ["list", "save", "remove", "duplicate", "setDefault", "used", "folder", "recent", "branches", "create"] {
            assert!(p.router.atiende(&format!("feat:templates:{op}")), "{op}");
        }
        assert_eq!(p.router.canales().len(), 10);
    }

    #[tokio::test]
    async fn save_valida_guarda_con_version_y_avisa_el_cambio() {
        let p = armar_prueba("tpl-save");
        assert_eq!(p.pedir("save", vec![json!("x")]).await.unwrap_err(), "Plantilla inválida.");
        let t = p.pedir("save", vec![json!({ "name": "Arreglo", "repoPath": p.repo.to_string_lossy(), "accountId": "a1" })]).await.unwrap();
        assert_eq!(t["name"], json!("Arreglo"));
        let g = p.guardado();
        assert_eq!(g["version"], json!(1));
        assert_eq!(g["templates"][0]["id"], t["id"]);
        let ev = p.t.eventos();
        assert_eq!(ev.last().unwrap().0, "feat:templates:changed");
        assert_eq!(ev.last().unwrap().1[0]["list"][0]["team"], json!(false));
        assert_eq!(p.pedir("save", vec![json!({ "name": "arreglo" })]).await.unwrap_err(), "Ya hay una plantilla «arreglo».");
    }

    #[tokio::test]
    async fn las_plantillas_del_equipo_no_se_borran() {
        let p = armar_prueba("tpl-equipo");
        let t = p.pedir("save", vec![json!({ "name": "Del equipo" })]).await.unwrap();
        fs::write(p.t.carpeta.join("perfil/features/team-config.json"), json!({ "teams": { "x": { "mapping": { "remota": t["id"] } } } }).to_string()).unwrap();
        assert_eq!(p.pedir("list", vec![]).await.unwrap()["list"][0]["team"], json!(true));
        assert_eq!(p.pedir("remove", vec![t["id"].clone()]).await.unwrap_err(), "Las plantillas del equipo no se borran. Duplicala y borrá tu copia.");
        let copia = p.pedir("duplicate", vec![t["id"].clone()]).await.unwrap();
        assert_eq!(copia["name"], json!("Copia de Del equipo"));
        p.pedir("remove", vec![copia["id"].clone()]).await.unwrap();
        assert_eq!(p.guardado()["templates"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn set_default_valida_el_tipo() {
        let p = armar_prueba("tpl-def");
        assert_eq!(p.pedir("setDefault", vec![json!(3)]).await.unwrap_err(), "Datos inválidos.");
        assert_eq!(p.pedir("setDefault", vec![json!("nada")]).await.unwrap_err(), "Esa plantilla ya no existe.");
        let t = p.pedir("save", vec![json!({ "name": "A" })]).await.unwrap();
        p.pedir("setDefault", vec![t["id"].clone()]).await.unwrap();
        assert_eq!(p.pedir("list", vec![]).await.unwrap()["defaultId"], t["id"]);
        p.pedir("setDefault", vec![Value::Null]).await.unwrap();
        assert_eq!(p.guardado()["defaultId"], Value::Null);
    }

    #[tokio::test]
    async fn folder_recent_y_branches_leen_git_y_los_espacios() {
        let p = armar_prueba("tpl-folder");
        let r = p.repo.to_string_lossy().into_owned();
        let f = p.pedir("folder", vec![json!(r)]).await.unwrap();
        assert_eq!((f["exists"].clone(), f["isGit"].clone(), f["branch"].clone()), (json!(true), json!(true), json!("main")));
        assert_eq!(f["spaces"], json!([{ "id": "w1", "name": "Repo", "accountId": "a1", "accountLabel": "Uno" }]));
        assert_eq!(p.pedir("folder", vec![json!("relativa")]).await.unwrap()["exists"], json!(false));
        let rec = p.pedir("recent", vec![]).await.unwrap();
        assert_eq!(rec["folders"].as_array().unwrap().len(), 1);
        assert_eq!(rec["counts"], json!({ "a1": 1 }));
        let b = p.pedir("branches", vec![json!(r)]).await.unwrap();
        assert_eq!(b, json!({ "branches": ["main", "origin/main", "origin/staging"], "defaultBase": "origin/staging" }));
    }

    #[tokio::test]
    async fn create_elige_la_cuenta_sugerida_pide_el_espacio_y_sube_el_contador() {
        let p = armar_prueba("tpl-create");
        let t = p.pedir("save", vec![json!({ "name": "Fix", "repoPath": p.repo.to_string_lossy() })]).await.unwrap();
        let ws = p.pedir("create", vec![t["id"].clone(), json!({})]).await.unwrap();
        assert_eq!(ws["id"], json!("nuevo"));
        let add = p.pedidos.lock().unwrap().iter().find(|(c, _)| c == "workspaces:add").cloned().unwrap();
        assert_eq!(add.1[0]["accountId"], json!("a2"));
        assert_eq!(add.1[0]["name"], json!("Fix #1"));
        assert_eq!(p.guardado()["templates"][0]["counter"], json!(1));
        assert!(p.t.eventos().contains(&("ui:command".to_string(), vec![json!({ "type": "open-pane", "id": "nuevo" })])));
    }

    #[tokio::test]
    async fn create_sin_carpeta_ni_plantilla_falla_con_el_mensaje_del_ts() {
        let p = armar_prueba("tpl-create-mal");
        assert_eq!(p.pedir("create", vec![json!("nada"), Value::Null]).await.unwrap_err(), "Esa plantilla ya no existe.");
        let t = p.pedir("save", vec![json!({ "name": "Sin carpeta" })]).await.unwrap();
        assert_eq!(p.pedir("create", vec![t["id"].clone(), json!([])]).await.unwrap_err(), "Datos inválidos.");
        assert_eq!(p.pedir("create", vec![t["id"].clone(), json!({})]).await.unwrap_err(), "Esta plantilla no tiene carpeta: elegila al crear el espacio.");
    }
}
