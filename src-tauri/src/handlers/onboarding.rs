//! Canales `feat:onboarding:*` en Rust: el asistente de primera vez, con su estado en `features/onboarding.json`. La
//! validación y el chequeo del entorno viven en `sloth_core::features::onboarding`; los programas corren con el ejecutor
//! del núcleo (sin ventana y con plazo). Si mostrarlo depende del store: se lee del estado (cuentas) y del dueño (solo
//! lectura).
use super::comun::{self, ahora_ms, texto};
use super::arg;
use crate::entorno::Entorno;
use crate::router::Router;
use serde_json::{json, Value};
use sloth_core::features::onboarding::{
    aplicar_parche, candidatos_de_repo, chequear_entorno, es_absoluta_win32, nombre_de_repo, rutas_unicas, validar_carpeta_repo, validar_doc, EstadoOnboarding, InformeEntorno, OpcionesEntorno,
    Resultado,
};
use sloth_core::features::proceso::{Ejecutor, Real};
use sloth_core::persistencia::escribir_json_atomico;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

pub const NOMBRE: &str = "onboarding";

const PLAZO_MS: u64 = 6000;

fn es_dir(p: &str) -> bool {
    Path::new(p).is_dir()
}

fn validar_repo(p: &Value) -> Result<String, String> {
    validar_carpeta_repo(p, es_absoluta_win32, es_dir)
}

pub struct Onboarding {
    entorno: Arc<Entorno>,
    ejecutor: Arc<dyn Ejecutor>,
    estado: Mutex<Option<EstadoOnboarding>>,
    /// Un chequeo a la vez (son 5 procesos cortos con plazo): quien llega mientras corre espera ese mismo informe.
    chequeo: Mutex<(bool, Option<InformeEntorno>)>,
    termino: Condvar,
}

impl Onboarding {
    fn archivo(&self) -> Result<PathBuf, String> {
        Ok(self.entorno.carpeta_features()?.join("onboarding.json"))
    }

    fn actual(&self) -> Result<EstadoOnboarding, String> {
        let mut g = self.estado.lock().unwrap_or_else(|e| e.into_inner());
        if g.is_none() {
            *g = Some(fs::read_to_string(self.archivo()?).map(|t| EstadoOnboarding::desde_texto(&t)).unwrap_or_default());
        }
        Ok(g.clone().expect("recién leído"))
    }

    fn state(&self) -> Result<Value, String> {
        let solo_lectura = comun::estado_del_dueno(&self.entorno).get("soloLectura").is_some_and(|s| !s.is_null());
        Ok(self.actual()?.para_la_ui(comun::cuentas(&self.entorno).len(), solo_lectura))
    }

    fn save(&self, patch: &Value) -> Result<Value, String> {
        let next = aplicar_parche(&self.actual()?, patch, ahora_ms() as f64, validar_repo)?;
        escribir_json_atomico(&self.archivo()?, &next.a_json()).map_err(|e| e.to_string())?;
        let v = next.a_json();
        *self.estado.lock().unwrap_or_else(|e| e.into_inner()) = Some(next);
        Ok(v)
    }

    fn correr(&self, exe: &str, args: &[String], plazo_ms: u64) -> Resultado {
        let s = self.ejecutor.ejecutar(exe, args, None, Duration::from_millis(plazo_ms));
        let error = if s.vencio {
            Some("timeout".to_string())
        } else if s.falta {
            Some("ENOENT".to_string())
        } else {
            None
        };
        Resultado { ok: s.code == 0 && error.is_none(), code: (s.code >= 0).then_some(s.code), stdout: s.stdout, stderr: s.stderr, error }
    }

    fn chequear(&self) -> InformeEntorno {
        let path_env = std::env::var("PATH").or_else(|_| std::env::var("Path")).unwrap_or_default();
        let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
        let app_data = std::env::var("APPDATA").unwrap_or_else(|_| Path::new(&home).join("AppData").join("Roaming").to_string_lossy().into_owned());
        let run = |exe: &str, args: &[String], plazo: u64| self.correr(exe, args, plazo);
        let es_archivo = |p: &str| Path::new(p).is_file();
        chequear_entorno(&OpcionesEntorno { path_env: &path_env, home: &home, app_data: &app_data, run: &run, timeout_ms: PLAZO_MS, es_archivo: &es_archivo, ahora: ahora_ms() as f64 })
    }

    fn env(&self) -> Result<Value, String> {
        let mut g = self.chequeo.lock().unwrap_or_else(|e| e.into_inner());
        if g.0 {
            while g.0 {
                g = self.termino.wait(g).unwrap_or_else(|e| e.into_inner());
            }
            return serde_json::to_value(&g.1).map_err(|e| e.to_string());
        }
        g.0 = true;
        drop(g);
        let informe = self.chequear();
        let mut g = self.chequeo.lock().unwrap_or_else(|e| e.into_inner());
        *g = (false, Some(informe.clone()));
        self.termino.notify_all();
        serde_json::to_value(informe).map_err(|e| e.to_string())
    }

    fn suggest_repos(&self) -> Result<Value, String> {
        let mut extra: Vec<String> = self.actual()?.repo_path.into_iter().collect();
        extra.extend(rutas_unicas(&comun::espacios(&self.entorno).iter().filter_map(|w| texto(w, "repoPath")).collect::<Vec<_>>()));
        let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
        let hijos = |p: &str| -> std::io::Result<Vec<String>> { fs::read_dir(p)?.map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned())).collect() };
        let tiene_git = |p: &str| Path::new(p).exists();
        Ok(json!({ "list": candidatos_de_repo(&home, &extra, &es_dir, &hijos, &tiene_git) }))
    }

    fn inspect_repo(&self, p: &Value) -> Result<Value, String> {
        let repo = validar_repo(p)?;
        Ok(json!({ "repoPath": repo, "isGit": Path::new(&repo).join(".git").exists(), "name": nombre_de_repo(&repo) }))
    }

    fn open_doc(&self, k: &Value) -> Result<Value, String> {
        self.entorno.plataforma.abrir_enlace_externo(validar_doc(k)?)?;
        Ok(Value::Null)
    }
}

pub fn armar(entorno: Arc<Entorno>, ejecutor: Arc<dyn Ejecutor>) -> Arc<Onboarding> {
    Arc::new(Onboarding { entorno, ejecutor, estado: Mutex::new(None), chequeo: Mutex::new((false, None)), termino: Condvar::new() })
}

pub fn registrar(router: &mut Router, entorno: Arc<Entorno>) {
    registrar_con(router, armar(entorno, Arc::new(Real)));
}

fn registrar_con(router: &mut Router, o: Arc<Onboarding>) {
    macro_rules! canal {
        ($op:literal, |$f:ident, $a:ident| $cuerpo:expr) => {{
            let $f = o.clone();
            router.registrar(concat!("feat:onboarding:", $op), move |$a: Vec<Value>| {
                let _ = &$a;
                $cuerpo
            });
        }};
    }
    canal!("state", |f, a| f.state());
    canal!("save", |f, a| f.save(arg(&a, 0)));
    canal!("env", |f, a| f.env());
    canal!("suggestRepos", |f, a| f.suggest_repos());
    canal!("inspectRepo", |f, a| f.inspect_repo(arg(&a, 0)));
    canal!("openDoc", |f, a| f.open_doc(arg(&a, 0)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_comunes::{EntornoDePrueba, ReenvioNulo};
    use sloth_core::features::proceso::Salida;

    struct SinProgramas;

    impl Ejecutor for SinProgramas {
        fn ejecutar(&self, _: &str, _: &[String], _: Option<&Path>, _: Duration) -> Salida {
            Salida { code: -1, falta: true, ..Salida::default() }
        }
    }

    fn armar_prueba(nombre: &str, cuentas: Value) -> (EntornoDePrueba, Router) {
        let t = EntornoDePrueba::nuevo(nombre);
        t.fijar_estado(&json!({ "version": 1, "accounts": cuentas, "workspaces": [] }));
        t.fijar_apoyo(|canal, _| if canal == "state:get" { Ok(json!({ "agents": {} })) } else { Ok(Value::Null) });
        let mut router = Router::nuevo(Arc::new(ReenvioNulo));
        registrar_con(&mut router, armar(t.entorno.clone(), Arc::new(SinProgramas)));
        (t, router)
    }

    #[tokio::test]
    async fn sin_cuentas_se_muestra_y_save_guarda_el_paso() {
        let (t, r) = armar_prueba("onb-state", json!([]));
        let s = r.invocar("feat:onboarding:state".into(), vec![]).await.unwrap();
        assert_eq!((s["show"].clone(), s["step"].clone(), s["steps"][0].clone()), (json!(true), json!(0), json!("entorno")));
        assert_eq!(r.invocar("feat:onboarding:save".into(), vec![json!({ "step": 9 })]).await.unwrap_err(), "Paso inválido.");
        assert_eq!(r.invocar("feat:onboarding:save".into(), vec![json!("x")]).await.unwrap_err(), "Datos inválidos.");
        let v = r.invocar("feat:onboarding:save".into(), vec![json!({ "step": 2, "completed": true })]).await.unwrap();
        assert_eq!(v["step"], json!(2));
        let guardado: Value = serde_json::from_str(&fs::read_to_string(t.carpeta.join("perfil/features/onboarding.json")).unwrap()).unwrap();
        assert_eq!((guardado["version"].clone(), guardado["completed"].clone()), (json!(1), json!(true)));
        assert_eq!(r.invocar("feat:onboarding:state".into(), vec![]).await.unwrap()["show"], json!(false));
    }

    #[tokio::test]
    async fn con_cuentas_no_se_muestra() {
        let (_t, r) = armar_prueba("onb-cuentas", json!([{ "id": "a" }]));
        assert_eq!(r.invocar("feat:onboarding:state".into(), vec![]).await.unwrap()["show"], json!(false));
    }

    #[tokio::test]
    async fn sin_programas_el_entorno_dice_que_falta_claude() {
        let (_t, r) = armar_prueba("onb-env", json!([]));
        let v = r.invocar("feat:onboarding:env".into(), vec![]).await.unwrap();
        assert!(v["items"].as_array().unwrap().iter().any(|i| i["id"] == json!("claude")));
        assert!(v["checkedAt"].as_f64().unwrap() > 0.0);
    }

    #[tokio::test]
    async fn inspect_repo_y_open_doc_validan() {
        let (t, r) = armar_prueba("onb-repo", json!([]));
        let repo = t.carpeta.join("mi-repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        let v = r.invocar("feat:onboarding:inspectRepo".into(), vec![json!(repo.to_string_lossy())]).await.unwrap();
        assert_eq!((v["isGit"].clone(), v["name"].clone()), (json!(true), json!("mi-repo")));
        assert_eq!(r.invocar("feat:onboarding:inspectRepo".into(), vec![json!("relativa")]).await.unwrap_err(), "Esa carpeta no existe.");
        assert_eq!(r.invocar("feat:onboarding:openDoc".into(), vec![json!("otro")]).await.unwrap_err(), "Documento desconocido.");
        r.invocar("feat:onboarding:openDoc".into(), vec![json!("git")]).await.unwrap();
        assert!(t.plataforma.abiertos.lock().unwrap()[0].starts_with("https://"));
        let s = r.invocar("feat:onboarding:suggestRepos".into(), vec![]).await.unwrap();
        assert!(s["list"].is_array());
    }
}
