//! Canales `feat:team-config:*` en Rust: la configuración compartida en `<repo>/.sloth/team.json`. Lectura, validación,
//! plan de importación y exportación viven en `sloth_core::features::team_config`; acá están el estado por repo
//! (`<perfil>/features/team-config.json`), la revisión al arrancar y los eventos `feat:team-config:changed`.
use super::{a_json, arg};
use crate::entorno::Entorno;
use crate::router::Router;
use serde_json::{json, Value};
use sloth_core::features::team_config::{
    ajustes_listos, armar_exportacion, confirmar_lo_visto, descartar_aviso, escribir_exportacion, estado_de_equipo, extras_del_scan, leer_team_config_del_repo, link_del_pedido,
    marcar_importado, planificar_importacion, plantillas_del_repo, plantillas_locales, registrar_exportacion, repo_del_pedido, repos_a_revisar, ruta_del_archivo, AlmacenPorRepo,
    EntradaDeExportacion, EstadoDeEquipo, Lectura, PlantillaLocal,
};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use super::comun::ahora_ms;
use std::time::Duration;

pub const NOMBRE: &str = "team-config";

const MAX_PLANTILLAS_BYTES: u64 = 2 * 1024 * 1024;
const ESPERA_PRIMERA_REVISION: Duration = Duration::from_secs(3);

fn es_dir(p: &str) -> bool {
    Path::new(p).is_dir()
}

struct Estado {
    almacen: AlmacenPorRepo,
    ultimo: Vec<EstadoDeEquipo>,
}

pub struct TeamConfig {
    entorno: Arc<Entorno>,
    estado: Mutex<Option<Estado>>,
}

impl TeamConfig {
    /// El estado se carga en la primera llamada: necesita la carpeta del perfil, que avisa el proceso de apoyo al arrancar.
    fn con_estado<T>(&self, f: impl FnOnce(&mut Estado) -> Result<T, String>) -> Result<T, String> {
        let mut g = self.estado.lock().unwrap_or_else(|e| e.into_inner());
        if g.is_none() {
            let archivo = self.entorno.carpeta_features()?.join("team-config.json");
            let almacen = AlmacenPorRepo::cargar(archivo, sloth_core::avisos::Avisos::global());
            for aviso in sloth_core::avisos::Avisos::global().tomar() {
                sloth_core::logger_global::aviso(NOMBRE, &aviso);
            }
            *g = Some(Estado { almacen, ultimo: Vec::new() });
        }
        f(g.as_mut().expect("recién cargado"))
    }

    /// Plantillas guardadas, solo lectura: las escribe la función «templates».
    fn plantillas(&self) -> Vec<PlantillaLocal> {
        let Ok(archivo) = self.entorno.carpeta_features().map(|d| d.join("templates.json")) else { return vec![] };
        if fs::metadata(&archivo).map(|m| m.len() > MAX_PLANTILLAS_BYTES).unwrap_or(true) {
            return vec![];
        }
        let Ok(texto) = fs::read_to_string(&archivo) else { return vec![] };
        serde_json::from_str::<Value>(texto.strip_prefix('\u{feff}').unwrap_or(&texto)).map(|v| plantillas_locales(&v)).unwrap_or_default()
    }

    fn guardar(&self, e: &Estado) -> Result<(), String> {
        e.almacen.guardar().map(|_| ()).map_err(|x| format!("No se pudo guardar team-config.json: {x}"))
    }

    fn estado_de(&self, e: &Estado, repo: &str, locales: &[PlantillaLocal]) -> Option<EstadoDeEquipo> {
        estado_de_equipo(repo, &leer_team_config_del_repo(repo), locales, e.almacen.estado.entrada(repo), &es_dir)
    }

    /// Repos de los espacios (leídos del estado del proceso de apoyo) y los que ya tienen entrada.
    fn revisar(&self, e: &mut Estado, extra: &[String]) -> Value {
        let de_espacios: Vec<String> =
            self.entorno.lista_del_estado("workspaces").iter().filter_map(|w| w.get("repoPath").and_then(Value::as_str).map(String::from)).collect();
        let de_entradas: Vec<String> = e.almacen.estado.equipos.iter().map(|(_, x)| x.repo_path().to_string()).collect();
        let locales = self.plantillas();
        e.ultimo = repos_a_revisar(&de_espacios, &de_entradas, extra, &es_dir).iter().filter_map(|r| self.estado_de(e, r, &locales)).collect();
        let v = serde_json::to_value(&e.ultimo).unwrap_or_else(|_| json!([]));
        self.entorno.emitir(NOMBRE, "changed", &[v.clone()]);
        v
    }

    fn scan(&self, extra: &Value) -> Result<Value, String> {
        let extra = extras_del_scan(extra);
        self.con_estado(|e| Ok(self.revisar(e, &extra)))
    }

    fn inspect(&self, repo: &Value) -> Result<Value, String> {
        let r = repo_del_pedido(repo, &es_dir)?;
        let locales = self.plantillas();
        self.con_estado(|e| a_json(Ok(self.estado_de(e, &r, &locales))))
    }

    fn plan(&self, repo: &Value) -> Result<Value, String> {
        let r = repo_del_pedido(repo, &es_dir)?;
        let config = match leer_team_config_del_repo(&r) {
            Lectura::Ninguna => return Err("Ese repo no tiene .sloth/team.json.".into()),
            Lectura::Invalida(e) => return Err(format!(".sloth/team.json: {e}")),
            Lectura::Ok { config, .. } => config,
        };
        let locales = self.plantillas();
        self.con_estado(|e| {
            let mapeo = e.almacen.estado.entrada(&r).map(|x| x.mapeo()).unwrap_or_default();
            a_json(Ok(planificar_importacion(&config, &r, &locales, &mapeo, &es_dir)))
        })
    }

    fn mark_imported(&self, repo: &Value, hash: &Value, mapeo: &Value) -> Result<Value, String> {
        let r = repo_del_pedido(repo, &es_dir)?;
        let lectura = leer_team_config_del_repo(&r);
        let ids: HashSet<String> = self.plantillas().into_iter().map(|t| t.id).collect();
        self.con_estado(|e| {
            // Se valida sobre una copia: un pedido inválido no deja una entrada vacía para el repo.
            let mut entrada = e.almacen.estado.entrada(&r).cloned().unwrap_or_else(|| sloth_core::features::team_config::EntradaDeEquipo::nueva(&r, ahora_ms()));
            marcar_importado(&mut entrada, &r, hash, mapeo, &lectura, &ids, ahora_ms())?;
            *e.almacen.estado.entrada_mut(&r, ahora_ms()) = entrada;
            self.guardar(e)?;
            Ok(self.revisar(e, &[]))
        })
    }

    fn dismiss(&self, repo: &Value) -> Result<Value, String> {
        let r = repo_del_pedido(repo, &es_dir)?;
        let lectura = leer_team_config_del_repo(&r);
        self.con_estado(|e| {
            if matches!(lectura, Lectura::Ok { .. }) {
                descartar_aviso(e.almacen.estado.entrada_mut(&r, ahora_ms()), &lectura);
                self.guardar(e)?;
            }
            Ok(self.revisar(e, &[]))
        })
    }

    fn settings_done(&self, repo: &Value) -> Result<Value, String> {
        let r = repo_del_pedido(repo, &es_dir)?;
        let lectura = leer_team_config_del_repo(&r);
        self.con_estado(|e| {
            if matches!(lectura, Lectura::Ok { hash_ajustes: Some(_), .. }) {
                ajustes_listos(e.almacen.estado.entrada_mut(&r, ahora_ms()), &lectura);
                self.guardar(e)?;
            }
            Ok(self.revisar(e, &[]))
        })
    }

    fn repo_templates(&self, repo: &Value) -> Result<Value, String> {
        let r = repo_del_pedido(repo, &es_dir)?;
        a_json(Ok(plantillas_del_repo(&r, &self.plantillas(), &leer_team_config_del_repo(&r))))
    }

    fn entrada_de_exportacion(input: &Value) -> Result<EntradaDeExportacion<'_>, String> {
        let o = input.as_object().ok_or("Datos inválidos.")?;
        Ok(EntradaDeExportacion { equipo: o.get("equipo"), links: o.get("links"), ajustes: o.get("ajustes"), include: o.get("include") })
    }

    fn export_preview(&self, repo: &Value, input: &Value) -> Result<Value, String> {
        let r = repo_del_pedido(repo, &es_dir)?;
        let out = armar_exportacion(&r, &self.plantillas(), &Self::entrada_de_exportacion(input)?)?;
        let ruta = ruta_del_archivo(&r);
        Ok(json!({ "text": out.text, "skipped": out.skipped, "count": out.config.plantillas.len(), "path": ruta.to_string_lossy(), "exists": ruta.exists() }))
    }

    fn export_write(&self, repo: &Value, input: &Value, mostrado: &Value) -> Result<Value, String> {
        let r = repo_del_pedido(repo, &es_dir)?;
        let locales = self.plantillas();
        let out = armar_exportacion(&r, &locales, &Self::entrada_de_exportacion(input)?)?;
        confirmar_lo_visto(&out, mostrado)?;
        let destino = escribir_exportacion(&r, &out.text).map_err(|e| e.to_string())?;
        let despues = leer_team_config_del_repo(&r);
        self.con_estado(|e| {
            registrar_exportacion(e.almacen.estado.entrada_mut(&r, ahora_ms()), &out.config, &locales, &despues, ahora_ms());
            self.guardar(e)?;
            sloth_core::logger_global::info(NOMBRE, &format!("team.json escrito en {} ({} plantillas)", destino.display(), out.config.plantillas.len()));
            self.revisar(e, &[]);
            Ok(json!({ "path": destino.to_string_lossy() }))
        })
    }

    fn open_link(&self, repo: &Value, indice: &Value) -> Result<Value, String> {
        let r = repo_del_pedido(repo, &es_dir)?;
        let url = link_del_pedido(&leer_team_config_del_repo(&r), indice)?;
        self.entorno.plataforma.abrir_enlace_externo(&url)?;
        Ok(Value::Null)
    }

    fn last(&self) -> Result<Value, String> {
        let g = self.estado.lock().unwrap_or_else(|e| e.into_inner());
        Ok(g.as_ref().and_then(|e| serde_json::to_value(&e.ultimo).ok()).unwrap_or_else(|| json!([])))
    }
}

/// Primera revisión unos segundos después de arrancar, como el setTimeout de team-config.ts. Espera a que el proceso de
/// apoyo avise el perfil; después la UI pide otra al volver la ventana visible.
fn revisar_al_arrancar(f: Arc<TeamConfig>) {
    std::thread::spawn(move || {
        for _ in 0..600 {
            if f.entorno.perfil().is_ok() {
                std::thread::sleep(ESPERA_PRIMERA_REVISION);
                if let Err(e) = f.scan(&Value::Null) {
                    sloth_core::logger_global::aviso(NOMBRE, &format!("scan inicial falló: {e}"));
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    });
}

pub fn armar(entorno: Arc<Entorno>) -> Arc<TeamConfig> {
    Arc::new(TeamConfig { entorno, estado: Mutex::new(None) })
}

pub fn registrar(router: &mut Router, entorno: Arc<Entorno>) {
    let f = armar(entorno);
    registrar_canales(router, &f);
    revisar_al_arrancar(f);
}

fn registrar_canales(router: &mut Router, f: &Arc<TeamConfig>) {
    macro_rules! canal {
        ($op:literal, |$t:ident, $a:ident| $cuerpo:expr) => {{
            let $t = f.clone();
            router.registrar(concat!("feat:team-config:", $op), move |$a: Vec<Value>| {
                let _ = &$a;
                $cuerpo
            });
        }};
    }
    canal!("scan", |t, a| t.scan(arg(&a, 0)));
    canal!("inspect", |t, a| t.inspect(arg(&a, 0)));
    canal!("plan", |t, a| t.plan(arg(&a, 0)));
    canal!("markImported", |t, a| t.mark_imported(arg(&a, 0), arg(&a, 1), arg(&a, 2)));
    canal!("dismiss", |t, a| t.dismiss(arg(&a, 0)));
    canal!("settingsDone", |t, a| t.settings_done(arg(&a, 0)));
    canal!("repoTemplates", |t, a| t.repo_templates(arg(&a, 0)));
    canal!("exportPreview", |t, a| t.export_preview(arg(&a, 0), arg(&a, 1)));
    canal!("exportWrite", |t, a| t.export_write(arg(&a, 0), arg(&a, 1), arg(&a, 2)));
    canal!("openLink", |t, a| t.open_link(arg(&a, 0), arg(&a, 1)));
    canal!("last", |t, a| t.last());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_comunes::{EntornoDePrueba, ReenvioNulo};
    use std::path::PathBuf;

    struct Prueba {
        t: EntornoDePrueba,
        repo: PathBuf,
        router: Router,
    }

    fn armar_prueba(nombre: &str, team_json: Option<Value>) -> Prueba {
        let t = EntornoDePrueba::nuevo(nombre);
        let repo = t.carpeta.join("repo");
        fs::create_dir_all(&repo).unwrap();
        if let Some(j) = team_json {
            fs::create_dir_all(repo.join(".sloth")).unwrap();
            fs::write(repo.join(".sloth").join("team.json"), serde_json::to_string_pretty(&j).unwrap()).unwrap();
        }
        t.fijar_estado(&json!({ "version": 1, "accounts": [], "workspaces": [{ "id": "w", "repoPath": repo.to_string_lossy(), "cwd": repo.to_string_lossy() }] }));
        let mut router = Router::nuevo(Arc::new(ReenvioNulo));
        registrar_canales(&mut router, &armar(t.entorno.clone()));
        Prueba { t, repo, router }
    }

    fn equipo() -> Value {
        json!({
            "formato": "sloth-team", "versión": 1, "equipo": "Equipo A",
            "plantillas": [{ "name": "Arreglo", "repoPath": ".", "cuenta": "sugerida", "initialPrompt": "Mirá el ticket {ticket}" }],
            "links": [{ "nombre": "Tablero", "url": "https://example.com/tablero" }, { "nombre": "Raro", "url": "https://example.com/x" }]
        })
    }

    fn mis_plantillas(p: &Prueba, plantillas: Value) {
        let dir = p.t.carpeta.join("perfil").join("features");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("templates.json"), json!({ "version": 1, "templates": plantillas }).to_string()).unwrap();
    }

    fn repo(p: &Prueba) -> Value {
        json!(p.repo.to_string_lossy())
    }

    #[tokio::test]
    async fn scan_encuentra_el_repo_del_espacio_avisa_a_la_ui_y_last_lo_repite() {
        let p = armar_prueba("tc-scan", Some(equipo()));
        let v = p.router.invocar("feat:team-config:scan".into(), vec![]).await.unwrap();
        assert_eq!(v.as_array().unwrap().len(), 1);
        assert_eq!(v[0]["state"], json!("ok"));
        assert_eq!(v[0]["equipo"], json!("Equipo A"));
        assert_eq!((v[0]["pending"].clone(), v[0]["total"].clone(), v[0]["notify"].clone()), (json!(1), json!(1), json!(true)));
        assert_eq!(p.t.eventos(), vec![("feat:team-config:changed".to_string(), vec![v.clone()])]);
        assert_eq!(p.router.invocar("feat:team-config:last".into(), vec![]).await.unwrap(), v);
    }

    #[tokio::test]
    async fn los_repos_invalidos_se_rechazan_con_los_mensajes_del_ts() {
        let p = armar_prueba("tc-invalidos", None);
        let r = &p.router;
        assert_eq!(r.invocar("feat:team-config:inspect".into(), vec![json!(3)]).await, Err("Repo inválido.".to_string()));
        assert_eq!(r.invocar("feat:team-config:inspect".into(), vec![json!("   ")]).await, Err("Repo inválido.".to_string()));
        assert_eq!(r.invocar("feat:team-config:inspect".into(), vec![json!("relativo")]).await, Err("Esa carpeta no existe.".to_string()));
        assert_eq!(r.invocar("feat:team-config:inspect".into(), vec![repo(&p)]).await, Ok(Value::Null));
        assert_eq!(r.invocar("feat:team-config:plan".into(), vec![repo(&p)]).await, Err("Ese repo no tiene .sloth/team.json.".to_string()));
        assert_eq!(r.invocar("feat:team-config:openLink".into(), vec![repo(&p), json!(0)]).await, Err("Link inválido.".to_string()));
        assert_eq!(r.invocar("feat:team-config:exportPreview".into(), vec![repo(&p), json!([])]).await, Err("Datos inválidos.".to_string()));
    }

    #[tokio::test]
    async fn plan_y_mark_imported_dejan_el_repo_al_dia_en_team_config_json() {
        let p = armar_prueba("tc-importar", Some(equipo()));
        let plan = p.router.invocar("feat:team-config:plan".into(), vec![repo(&p)]).await.unwrap();
        assert_eq!(plan["items"][0]["action"], json!("new"));
        let hash = plan["hash"].clone();
        mis_plantillas(&p, json!([{ "id": "t1", "name": "Arreglo", "repoPath": p.repo.to_string_lossy(), "accountId": "sugerida", "initialPrompt": "Mirá el ticket {ticket}", "autoStartClaude": true, "resume": true }]));
        assert_eq!(p.router.invocar("feat:team-config:markImported".into(), vec![repo(&p), json!("corto"), json!({})]).await, Err("Datos inválidos.".to_string()));
        let estado = p.t.carpeta.join("perfil").join("features").join("team-config.json");
        assert!(!estado.exists(), "un pedido inválido no escribe nada");
        let v = p.router.invocar("feat:team-config:markImported".into(), vec![repo(&p), hash.clone(), json!({ "arreglo": "t1", "otra": "t1" })]).await.unwrap();
        assert_eq!(v[0]["notify"], json!(false));
        let guardado: Value = serde_json::from_str(&fs::read_to_string(&estado).unwrap()).unwrap();
        assert_eq!(guardado["version"], json!(1));
        let entrada = guardado["teams"].as_object().unwrap().values().next().unwrap();
        assert_eq!(entrada["mapping"], json!({ "arreglo": "t1" }));
        assert_eq!(entrada["importedHash"], hash);
        assert_eq!(entrada["equipo"], json!("Equipo A"));
    }

    #[tokio::test]
    async fn dismiss_oculta_el_aviso_hasta_el_proximo_cambio() {
        let p = armar_prueba("tc-dismiss", Some(equipo()));
        let v = p.router.invocar("feat:team-config:dismiss".into(), vec![repo(&p)]).await.unwrap();
        assert_eq!((v[0]["pending"].clone(), v[0]["notify"].clone()), (json!(1), json!(false)));
    }

    #[tokio::test]
    async fn exportar_escribe_lo_que_se_vio_y_rechaza_si_cambio() {
        let p = armar_prueba("tc-exportar", None);
        mis_plantillas(&p, json!([{ "id": "t1", "name": "Mía", "repoPath": p.repo.to_string_lossy(), "accountId": "sugerida", "initialPrompt": "Hacé {ticket}", "autoStartClaude": true, "resume": true }]));
        let entrada = json!({ "equipo": "Los de acá" });
        let previa = p.router.invocar("feat:team-config:exportPreview".into(), vec![repo(&p), entrada.clone()]).await.unwrap();
        assert_eq!((previa["count"].clone(), previa["exists"].clone()), (json!(1), json!(false)));
        let texto = previa["text"].clone();
        assert_eq!(
            p.router.invocar("feat:team-config:exportWrite".into(), vec![repo(&p), entrada.clone(), json!("otra cosa")]).await,
            Err("Tus plantillas cambiaron mientras mirabas la vista previa. Revisala de nuevo.".to_string())
        );
        let v = p.router.invocar("feat:team-config:exportWrite".into(), vec![repo(&p), entrada, texto.clone()]).await.unwrap();
        let destino = p.repo.join(".sloth").join("team.json");
        assert_eq!(v["path"], json!(destino.to_string_lossy()));
        assert_eq!(fs::read_to_string(&destino).unwrap(), texto.as_str().unwrap());
        let estado = p.router.invocar("feat:team-config:last".into(), vec![]).await.unwrap();
        assert_eq!((estado[0]["pending"].clone(), estado[0]["imported"].clone()), (json!(0), json!(1)));
    }

    #[tokio::test]
    async fn open_link_solo_abre_links_https_del_archivo() {
        let p = armar_prueba("tc-link", Some(equipo()));
        p.router.invocar("feat:team-config:openLink".into(), vec![repo(&p), json!(0)]).await.unwrap();
        assert_eq!(p.router.invocar("feat:team-config:openLink".into(), vec![repo(&p), json!(9)]).await, Err("Link inválido.".to_string()));
        assert_eq!(p.router.invocar("feat:team-config:openLink".into(), vec![repo(&p), json!(0.5)]).await, Err("Link inválido.".to_string()));
        assert_eq!(*p.t.plataforma.abiertos.lock().unwrap(), vec!["https://example.com/tablero".to_string()]);
    }

    #[tokio::test]
    async fn repo_templates_lista_mis_plantillas_del_repo_y_lo_actual() {
        let p = armar_prueba("tc-plantillas", Some(equipo()));
        mis_plantillas(&p, json!([{ "id": "t1", "name": "Mía", "repoPath": p.repo.join("sub").to_string_lossy() }, { "id": "t2", "name": "Ajena", "repoPath": "C:\\otro" }]));
        let v = p.router.invocar("feat:team-config:repoTemplates".into(), vec![repo(&p)]).await.unwrap();
        assert_eq!(v["templates"], json!(["Mía"]));
        assert_eq!(v["exists"], json!(true));
        assert_eq!(v["current"]["equipo"], json!("Equipo A"));
    }
}
