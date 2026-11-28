//! Canales `feat:help:*` en Rust («Novedades»). La decisión vive en `sloth_core::features::help`; el changelog lo genera
//! build.rs desde src/shared/changelog.ts. Estado: `<perfil>/features/help.json` con `{ lastSeen }`, igual que el TS.
use super::arg;
use crate::entorno::Entorno;
use crate::router::Router;
use serde_json::{json, Value};
use sloth_core::features::help::{decidir_novedades, formato_archivo, leer_ultima_vista, validar_visto, ConVersion, Decision, Novedades};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

pub const NOMBRE: &str = "help";

const CHANGELOG_JSON: &str = include_str!(concat!(env!("OUT_DIR"), "/changelog.json"));

/// Una entrada del changelog tal cual viene del .ts: se devuelve entera a la UI.
struct Entrada(Value);

impl ConVersion for Entrada {
    fn version(&self) -> &str {
        self.0.get("version").and_then(Value::as_str).unwrap_or_default()
    }
}

fn changelog() -> &'static [Entrada] {
    static C: OnceLock<Vec<Entrada>> = OnceLock::new();
    C.get_or_init(|| serde_json::from_str::<Vec<Value>>(CHANGELOG_JSON).unwrap_or_default().into_iter().map(Entrada).collect())
}

fn archivo(entorno: &Entorno) -> Result<PathBuf, String> {
    Ok(entorno.carpeta_features()?.join("help.json"))
}

/// Mismo archivo que escribe help.ts: JSON con 2 espacios, sin `version` (nunca la tuvo) y con tmp + rename.
fn escribir_vista(ruta: &Path, version: &str) -> Result<(), String> {
    if let Some(dir) = ruta.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = PathBuf::from(format!("{}.{}.tmp", ruta.display(), std::process::id()));
    fs::write(&tmp, formato_archivo(version)).map_err(|e| e.to_string())?;
    fs::rename(&tmp, ruta).map_err(|e| e.to_string())
}

fn a_valor(n: Novedades<'_, Entrada>) -> Value {
    json!({
        "current": n.actual,
        "lastSeen": n.ultima_vista,
        "show": n.mostrar,
        "entries": n.entradas.iter().map(|e| e.0.clone()).collect::<Vec<_>>()
    })
}

fn whatsnew(entorno: &Entorno) -> Result<Value, String> {
    let ruta = archivo(entorno)?;
    let actual = entorno.plataforma.version();
    let vista = fs::read_to_string(&ruta).ok().and_then(|t| leer_ultima_vista(&t));
    // Cuentas y espacios los sigue guardando el proceso de apoyo: acá solo se leen.
    let hay_datos = !entorno.lista_del_estado("accounts").is_empty() || !entorno.lista_del_estado("workspaces").is_empty();
    Ok(match decidir_novedades(changelog(), vista.as_deref(), &actual, hay_datos) {
        Decision::Desde04(n) | Decision::Normal(n) => a_valor(n),
        Decision::PrimeraInstalacion => {
            if let Err(e) = escribir_vista(&ruta, &actual) {
                sloth_core::logger_global::aviso(NOMBRE, &format!("help: no se pudo guardar la versión vista: {e}"));
            }
            json!({ "current": actual, "lastSeen": null, "show": false, "entries": [] })
        }
    })
}

pub fn registrar(router: &mut Router, entorno: Arc<Entorno>) {
    let e = entorno.clone();
    router.registrar("feat:help:whatsnew", move |_| whatsnew(&e));
    router.registrar("feat:help:seen", move |a| {
        let version = validar_visto(arg(&a, 0))?;
        escribir_vista(&archivo(&entorno)?, version)?;
        Ok(Value::Null)
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_comunes::{EntornoDePrueba, ReenvioNulo};

    fn router(t: &EntornoDePrueba) -> Router {
        let mut r = Router::nuevo(Arc::new(ReenvioNulo));
        registrar(&mut r, t.entorno.clone());
        r
    }

    fn help_json(t: &EntornoDePrueba) -> PathBuf {
        t.carpeta.join("perfil").join("features").join("help.json")
    }

    #[test]
    fn el_changelog_generado_trae_las_entradas_del_ts_de_la_mas_nueva_a_la_mas_vieja() {
        let c = changelog();
        assert!(c.len() > 10, "{}", c.len());
        assert!(c.iter().all(|e| sloth_core::features::help::es_version(e.version())));
        assert!(c[0].0.get("title").and_then(Value::as_str).is_some_and(|t| !t.is_empty()));
        assert!(c[0].0.get("items").is_some_and(Value::is_array));
        assert!(c.iter().any(|e| e.version() == "0.4.0"));
    }

    #[tokio::test]
    async fn primera_instalacion_guarda_la_version_y_no_muestra_nada() {
        let t = EntornoDePrueba::nuevo("help-primera");
        let v = router(&t).invocar("feat:help:whatsnew".into(), vec![]).await.unwrap();
        assert_eq!(v, json!({ "current": "0.0.0", "lastSeen": null, "show": false, "entries": [] }));
        assert_eq!(fs::read_to_string(help_json(&t)).unwrap(), "{\n  \"lastSeen\": \"0.0.0\"\n}");
    }

    #[tokio::test]
    async fn sin_help_json_pero_con_espacios_muestra_desde_la_0_4_sin_escribir() {
        let t = EntornoDePrueba::nuevo("help-04");
        t.plataforma.fijar_version("0.5.0");
        t.fijar_estado(&json!({ "version": 1, "accounts": [], "workspaces": [{ "id": "w" }] }));
        let v = router(&t).invocar("feat:help:whatsnew".into(), vec![]).await.unwrap();
        assert_eq!(v["lastSeen"], json!("0.4.0"));
        assert_eq!(v["show"], json!(true));
        let versiones: Vec<&str> = v["entries"].as_array().unwrap().iter().map(|e| e["version"].as_str().unwrap()).collect();
        assert!(!versiones.is_empty() && versiones.iter().all(|x| x.starts_with("0.4.") || x.starts_with("0.5.0")), "{versiones:?}");
        assert!(!versiones.contains(&"0.4.0"));
        assert!(!help_json(&t).exists());
    }

    #[tokio::test]
    async fn seen_valida_la_version_y_despues_no_hay_novedades() {
        let t = EntornoDePrueba::nuevo("help-seen");
        t.plataforma.fijar_version("0.8.3");
        let r = router(&t);
        for malo in [json!(7), json!("0.8"), json!("0.8.3\n"), Value::Null] {
            assert_eq!(r.invocar("feat:help:seen".into(), vec![malo]).await, Err("Versión inválida".to_string()));
        }
        r.invocar("feat:help:seen".into(), vec![json!("0.8.0")]).await.unwrap();
        let v = r.invocar("feat:help:whatsnew".into(), vec![]).await.unwrap();
        assert_eq!(v["lastSeen"], json!("0.8.0"));
        assert_eq!(v["show"], json!(true));
        r.invocar("feat:help:seen".into(), vec![json!("0.8.3")]).await.unwrap();
        let v = r.invocar("feat:help:whatsnew".into(), vec![]).await.unwrap();
        assert_eq!((v["show"].clone(), v["entries"].clone()), (json!(false), json!([])));
    }

    #[tokio::test]
    async fn un_help_json_roto_cuenta_como_ausente() {
        let t = EntornoDePrueba::nuevo("help-roto");
        fs::create_dir_all(help_json(&t).parent().unwrap()).unwrap();
        fs::write(help_json(&t), "\u{feff}{no").unwrap();
        let v = router(&t).invocar("feat:help:whatsnew".into(), vec![]).await.unwrap();
        assert_eq!(v["lastSeen"], Value::Null);
    }
}
