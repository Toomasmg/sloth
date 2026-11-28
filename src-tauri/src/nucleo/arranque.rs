//! El arranque que antes hacía el proceso de apoyo: carpeta de datos, logger, perfil activo (con sus migraciones) y la
//! ruta del perfil con la que corre toda la sesión. Equivale a src/main/perfil.ts y al principio de src/main/index.ts.
use serde_json::{json, Value};
use sloth_core::avisos::Avisos;
use sloth_core::features::diagnostico::{hubo_cierre_inesperado, leer_sesion};
use sloth_core::features::redactar::{redactar, ContextoRedaccion};
use sloth_core::logger_global as log;
use sloth_core::perfiles_core::{IndicePerfiles, PERFIL_INICIAL_ID};
use sloth_core::perfiles_fs::{iniciar_perfiles_fs, rutas_perfiles};
use sloth_core::persistencia::escribir_json_atomico;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn ahora_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[derive(Debug, Clone)]
pub struct Arranque {
    pub raiz: PathBuf,
    /// Carpeta del perfil de esta sesión (la raíz si los perfiles no se pudieron preparar).
    pub perfil: PathBuf,
    pub id_perfil: String,
    pub modo_raiz: bool,
    /// Ya hay perfiles y no se puede usar ninguno: no hay un lugar seguro donde escribir.
    pub bloqueado: Option<String>,
    pub indice: Value,
}

impl Arranque {
    /// Lo que el proceso de apoyo necesita para no repetir el arranque (ver `SLOTH_PERFIL_RUST` en src/main/perfil.ts).
    pub fn para_el_apoyo(&self) -> Value {
        json!({ "id": self.id_perfil, "carpeta": self.perfil.to_string_lossy(), "modoRaiz": self.modo_raiz, "indice": self.indice })
    }
}

/// `logs/sesion.json`, como src/main/sesion-marcador.ts: al arrancar se lee cómo terminó la sesión anterior y la actual
/// queda en curso hasta que la app cierra bien.
pub struct MarcaDeSesion {
    archivo: PathBuf,
    inicio: u64,
}

impl MarcaDeSesion {
    /// La marca de esta sesión y si la anterior terminó de forma inesperada.
    pub fn iniciar(raiz: &Path) -> (MarcaDeSesion, bool) {
        let archivo = raiz.join("logs").join("sesion.json");
        let previa = match fs::read_to_string(&archivo) {
            Ok(t) => Some(t),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                log::error("sesion", e);
                None
            }
        };
        let marca = MarcaDeSesion { archivo, inicio: ahora_ms() };
        marca.escribir(false);
        (marca, hubo_cierre_inesperado(leer_sesion(previa.as_deref())))
    }

    /// Se marca apenas se decide cerrar: el instalador del updater o el apagado de Windows pueden matar el proceso
    /// mientras se cierran las terminales, y eso no es un cierre inesperado.
    pub fn cerrar(&self) {
        self.escribir(true);
    }

    fn escribir(&self, limpia: bool) {
        if let Err(e) = escribir_json_atomico(&self.archivo, &json!({ "inicio": self.inicio, "limpia": limpia })) {
            log::error("sesion", e);
        }
    }
}

/// Las líneas del log tapan la carpeta de usuario y la de datos, como el logger de Node.
pub fn iniciar_logger(raiz: &Path) {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let user_data = raiz.to_string_lossy().into_owned();
    log::iniciar_logger(&raiz.join("logs"), Box::new(move |s| redactar(s, &ContextoRedaccion { home: &home, user_data: &user_data })));
}

/// La app antes se llamaba AntiRea: si existe su carpeta y todavía no hay datos de Sloth, se trae entera (logins
/// incluidos). Nunca con `SLOTH_USER_DATA`: una instancia de prueba no se lleva datos reales.
fn traer_de_antirea(raiz: &Path, vieja: &Path) {
    if !vieja.exists() || raiz.join("sloth-state.json").exists() || raiz.join("accounts").exists() {
        return;
    }
    let r = if !raiz.exists() {
        fs::rename(vieja, raiz)
    } else {
        ["accounts", "antirea-state.json"].iter().map(|n| (vieja.join(n), raiz.join(n))).filter(|(d, _)| d.exists()).try_for_each(|(d, h)| fs::rename(d, h))
    };
    if let Err(e) = r {
        log::aviso("perfiles", &format!("no se pudo mover %APPDATA%\\AntiRea: {e}"));
    }
}

fn renombrar_estado_viejo(raiz: &Path) {
    let (actual, legado) = (raiz.join("sloth-state.json"), raiz.join("antirea-state.json"));
    if !actual.exists() && legado.exists() {
        if let Err(e) = fs::rename(&legado, &actual) {
            log::aviso("perfiles", &format!("no se pudo renombrar antirea-state.json: {e}"));
        }
    }
}

fn indice_json(i: &IndicePerfiles) -> Value {
    json!({ "version": 1, "activo": i.activo, "perfiles": i.perfiles.iter().map(|p| p.a_json()).collect::<Vec<_>>() })
}

/// `antirea`: la carpeta vieja, o None en una instancia de prueba.
pub fn arrancar(raiz: &Path, antirea: Option<&Path>, avisos: &Avisos) -> Arranque {
    if let Some(v) = antirea {
        traer_de_antirea(raiz, v);
    }
    let _ = fs::create_dir_all(raiz);
    renombrar_estado_viejo(raiz);
    let r = iniciar_perfiles_fs(raiz, &ahora_ms);
    let id = if r.indice.activo.is_empty() { PERFIL_INICIAL_ID.to_string() } else { r.indice.activo.clone() };
    if let Some(b) = &r.bloqueado {
        log::error("perfiles", format!("no se pueden usar los perfiles: {b}"));
    } else if let Some(e) = &r.error {
        log::aviso("perfiles", &format!("sigo con la raíz de siempre: {e}"));
        avisos.avisar(format!("No pude preparar los perfiles ({e}). Sloth sigue con tus datos de siempre; reiniciá para reintentar."));
    } else {
        if r.migrado {
            log::info("perfiles", "datos copiados al perfil principal");
        }
        if r.reconstruido {
            log::aviso("perfiles", "perfiles.json rearmado a partir de las carpetas");
        }
        if let Some(a) = &r.aviso {
            log::aviso("perfiles", a);
        }
        if let Some(a) = &r.aviso_usuario {
            log::aviso("perfiles", a);
            avisos.avisar(a.clone());
        }
    }
    let modo_raiz = r.error.is_some();
    let perfil = if modo_raiz { raiz.to_path_buf() } else { rutas_perfiles(raiz).carpeta.join(&id) };
    if r.bloqueado.is_none() {
        let _ = fs::create_dir_all(&perfil);
    }
    Arranque { raiz: raiz.to_path_buf(), perfil, id_perfil: id, modo_raiz, bloqueado: r.bloqueado.clone(), indice: indice_json(&r.indice) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn carpeta(n: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sloth-arranque-{n}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn la_sesion_que_no_cerro_bien_se_ve_al_arrancar_la_siguiente() {
        let raiz = carpeta("sesion");
        let (primera, crash) = MarcaDeSesion::iniciar(&raiz);
        assert!(!crash, "sin sesión anterior no hay cierre inesperado");
        let (segunda, crash) = MarcaDeSesion::iniciar(&raiz);
        assert!(crash, "la primera quedó en curso");
        segunda.cerrar();
        let (_, crash) = MarcaDeSesion::iniciar(&raiz);
        assert!(!crash, "la segunda cerró bien");
        let guardada: Value = serde_json::from_str(&fs::read_to_string(raiz.join("logs").join("sesion.json")).unwrap()).unwrap();
        assert_eq!(guardada["limpia"], false);
        assert!(guardada["inicio"].as_u64().unwrap() >= primera.inicio);
        let _ = fs::remove_dir_all(&raiz);
    }

    #[test]
    fn una_carpeta_nueva_arranca_en_el_perfil_principal() {
        let raiz = carpeta("nueva");
        let a = arrancar(&raiz, None, &Avisos::nuevo());
        assert!(a.bloqueado.is_none() && !a.modo_raiz);
        assert_eq!(a.id_perfil, PERFIL_INICIAL_ID);
        assert_eq!(a.perfil, raiz.join("perfiles").join(PERFIL_INICIAL_ID));
        assert!(a.perfil.is_dir());
        assert_eq!(a.para_el_apoyo()["indice"]["activo"], PERFIL_INICIAL_ID);
        let _ = fs::remove_dir_all(&raiz);
    }

    #[test]
    fn el_estado_de_la_raiz_se_migra_al_perfil_sin_perderse() {
        let raiz = carpeta("migra");
        fs::create_dir_all(&raiz).unwrap();
        fs::write(raiz.join("antirea-state.json"), r#"{"version":1,"accounts":[],"workspaces":[],"openPanes":["x"]}"#).unwrap();
        let a = arrancar(&raiz, None, &Avisos::nuevo());
        let texto = fs::read_to_string(a.perfil.join("sloth-state.json")).unwrap();
        assert!(texto.contains("\"x\""), "{texto}");
        let _ = fs::remove_dir_all(&raiz);
    }

    #[test]
    fn la_carpeta_de_antirea_se_trae_solo_si_no_hay_datos_de_sloth() {
        let base = carpeta("antirea");
        let (vieja, raiz) = (base.join("AntiRea"), base.join("Sloth"));
        fs::create_dir_all(vieja.join("accounts").join("a")).unwrap();
        arrancar(&raiz, Some(&vieja), &Avisos::nuevo());
        assert!(!vieja.exists());
        assert!(raiz.join("accounts").join("a").is_dir() || raiz.join("perfiles").exists());
        let _ = fs::remove_dir_all(&base);
    }
}
