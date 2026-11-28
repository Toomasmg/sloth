//! `features/settings.json`: la Configuración. Equivale a la parte de disco de src/main/features/settings.ts y a
//! src/main/features/settings-archivo.ts. Lo que una versión más nueva agregó al archivo y esta no conoce se conserva.
use serde_json::{Map, Value};
use sloth_core::avisos::Avisos;
use sloth_core::persistencia::{escribir_json_atomico, leer_json, respaldar, OpcionesLectura};
use sloth_core::settings_model::{normalizar, por_defecto};
use sloth_core::versionado::{migrar, EstadoVersion, Migraciones, Objeto};
use std::path::{Path, PathBuf};

pub const VERSION_SETTINGS: u32 = 1;
const SECCIONES: [&str; 2] = ["terminal", "notify"];

pub fn campos_desconocidos(raw: &Value) -> Objeto {
    let Some(o) = raw.as_object() else { return Map::new() };
    let defecto = por_defecto();
    let mut out = Map::new();
    for (k, v) in o {
        if k != "version" && !defecto.contains_key(k) {
            out.insert(k.clone(), v.clone());
        }
    }
    for sec in SECCIONES {
        let (Some(Value::Object(dentro)), Some(Value::Object(conocidas))) = (o.get(sec), defecto.get(sec)) else { continue };
        let extra: Objeto = dentro.iter().filter(|(k, _)| !conocidas.contains_key(*k)).map(|(k, v)| (k.clone(), v.clone())).collect();
        if !extra.is_empty() {
            out.insert(sec.into(), Value::Object(extra));
        }
    }
    out
}

/// Lo vigente pisa lo conocido; lo desconocido (raíz, `terminal` y `notify`) se conserva.
pub fn armar_archivo(settings: &Objeto, resto: &Objeto, version: u32) -> Value {
    let mut out = resto.clone();
    for (k, v) in settings {
        out.insert(k.clone(), v.clone());
    }
    out.insert("version".into(), Value::from(version));
    for sec in SECCIONES {
        if let (Some(Value::Object(extra)), Some(Value::Object(vigente))) = (resto.get(sec), settings.get(sec)) {
            let mut junto = extra.clone();
            for (k, v) in vigente {
                junto.insert(k.clone(), v.clone());
            }
            out.insert(sec.into(), Value::Object(junto));
        }
    }
    Value::Object(out)
}

struct Lectura {
    settings: Objeto,
    resto: Objeto,
    estado: EstadoVersion,
}

pub struct Ajustes {
    archivo: PathBuf,
    settings: Objeto,
    resto: Objeto,
    futura: bool,
    solo_lectura: bool,
    por_respaldar: bool,
}

impl Ajustes {
    pub fn cargar(archivo: &Path, avisos: &Avisos) -> Ajustes {
        let validar = |v: &Value| {
            let r = migrar(v, &Migraciones::new(), VERSION_SETTINGS);
            (r.estado != EstadoVersion::Invalida).then(|| Lectura { settings: normalizar(&r.datos), resto: campos_desconocidos(&r.datos), estado: r.estado })
        };
        let vacio = || Lectura { settings: normalizar(&Value::Null), resto: Map::new(), estado: EstadoVersion::Actual };
        let l = leer_json(archivo, &OpcionesLectura::nuevas(&validar, &vacio), avisos).valor;
        let futura = l.estado == EstadoVersion::Futura;
        if futura {
            avisos.version_futura(archivo);
        }
        Ajustes { archivo: archivo.to_path_buf(), settings: l.settings, resto: l.resto, futura, solo_lectura: futura, por_respaldar: l.estado == EstadoVersion::Migrado }
    }

    pub fn actuales(&self) -> &Objeto {
        &self.settings
    }

    /// Lo que dice Windows manda sobre «abrir al iniciar»: se refleja sin guardarlo.
    pub fn fijar_sin_guardar(&mut self, k: &str, v: Value) {
        self.settings.insert(k.into(), v);
    }

    pub fn cambiar(&mut self, nuevos: Objeto, avisos: &Avisos) {
        self.settings = nuevos;
        self.guardar(avisos);
    }

    fn guardar(&mut self, avisos: &Avisos) {
        if self.solo_lectura {
            if self.futura {
                avisos.version_futura(&self.archivo);
            }
            return;
        }
        if self.por_respaldar {
            match respaldar(&self.archivo) {
                Ok(_) => self.por_respaldar = false,
                Err(e) => {
                    self.solo_lectura = true;
                    avisos.avisar(format!("No pude respaldar settings.json antes de actualizarlo ({e}); no voy a guardar cambios hasta que reinicies Sloth."));
                    return;
                }
            }
        }
        if let Some(dir) = self.archivo.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Err(e) = escribir_json_atomico(&self.archivo, &armar_archivo(&self.settings, &self.resto, VERSION_SETTINGS)) {
            sloth_core::logger_global::error("settings", format!("no se pudo guardar settings.json: {e}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn carpeta(n: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sloth-ajustes-{n}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn sin_archivo_quedan_los_valores_por_defecto_y_al_guardar_lleva_version() {
        let d = carpeta("vacio");
        let f = d.join("settings.json");
        let avisos = Avisos::nuevo();
        let mut a = Ajustes::cargar(&f, &avisos);
        assert_eq!(a.actuales()["theme"], "oscuro");
        let mut n = a.actuales().clone();
        n.insert("theme".into(), json!("claro"));
        a.cambiar(n, &avisos);
        let v: Value = serde_json::from_str(&fs::read_to_string(&f).unwrap()).unwrap();
        assert_eq!(v["theme"], "claro");
        assert_eq!(v["version"], 1);
    }

    #[test]
    fn los_campos_desconocidos_sobreviven_al_guardar() {
        let d = carpeta("resto");
        let f = d.join("settings.json");
        fs::write(&f, json!({ "version": 1, "theme": "claro", "nuevo": 7, "terminal": { "fontSize": 14, "rarito": true } }).to_string()).unwrap();
        let avisos = Avisos::nuevo();
        let mut a = Ajustes::cargar(&f, &avisos);
        assert_eq!(a.actuales()["terminal"]["fontSize"], 14);
        let n = a.actuales().clone();
        a.cambiar(n, &avisos);
        let v: Value = serde_json::from_str(&fs::read_to_string(&f).unwrap()).unwrap();
        assert_eq!(v["nuevo"], 7);
        assert_eq!(v["terminal"]["rarito"], true);
        assert_eq!(v["terminal"]["fontSize"], 14);
    }

    #[test]
    fn una_version_futura_queda_en_solo_lectura_y_no_se_reescribe() {
        let d = carpeta("futura");
        let f = d.join("settings.json");
        let texto = json!({ "version": 9, "theme": "claro" }).to_string();
        fs::write(&f, &texto).unwrap();
        let avisos = Avisos::nuevo();
        let mut a = Ajustes::cargar(&f, &avisos);
        assert!(avisos.tomar().iter().any(|t| t.contains("más nueva")));
        let mut n = a.actuales().clone();
        n.insert("theme".into(), json!("oscuro"));
        a.cambiar(n, &avisos);
        assert_eq!(fs::read_to_string(&f).unwrap(), texto);
    }

    #[test]
    fn un_archivo_sin_version_se_respalda_antes_de_guardar_la_migracion() {
        let d = carpeta("migra");
        let f = d.join("settings.json");
        fs::write(&f, json!({ "theme": "claro" }).to_string()).unwrap();
        let avisos = Avisos::nuevo();
        let mut a = Ajustes::cargar(&f, &avisos);
        let n = a.actuales().clone();
        a.cambiar(n, &avisos);
        let respaldos = fs::read_dir(&d).unwrap().filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().contains(".bak")).count();
        assert_eq!(respaldos, 1);
    }
}
