//! `celular.json` en `userData/features`: la configuración de la función, versionada (v2). Equivale a `cargar` y
//! `guardarConfig` de `celular.ts`. Los campos que no conoce se conservan, una versión más nueva queda en solo lectura y
//! antes de reescribir un archivo migrado se hace un respaldo. Lo que sale del azar (clave, tema, secreto) entra como dato.
use super::acceso::{leer_celus, migraciones_celular, CeluGuardado, VERSION_CELULAR};
use super::core::{clave_valida_json, https_tailscale, puerto_valido, servidor_ntfy, tema_valido, token_ntfy_valido, NTFY_POR_DEFECTO};
use super::remoto_core::secreto_valido;
use super::tipos::PUERTO_POR_DEFECTO;
use crate::avisos::Avisos;
use crate::persistencia::{escribir_json_atomico, leer_json, respaldar, OpcionesLectura};
use crate::versionado::{migrar, EstadoVersion};
use serde_json::{json, Map, Value};
use std::cell::Cell;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct ConfigNtfy {
    pub encendido: bool,
    pub tema: String,
    pub servidor: String,
    pub token: Option<String>,
    pub tema_renovado: bool,
    /// Los avisos no llevan el nombre del espacio ni el mensaje de Claude.
    pub privado: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConfigRemoto {
    pub encendido: bool,
    pub aprobar: bool,
    pub secreto: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConfigTailscale {
    pub encendido: bool,
    pub https: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub encendido: bool,
    pub puerto: u16,
    /// La del QR: solo sirve para pedir entrar. Cada celu que la PC deja entrar tiene la suya, en `celus`.
    pub clave: String,
    pub celus: Vec<CeluGuardado>,
    pub aprobar: bool,
    /// Ver y escribir en las terminales desde el celu (solo en el Wi-Fi).
    pub terminal: bool,
    pub ntfy: ConfigNtfy,
    pub remoto: ConfigRemoto,
    pub tailscale: ConfigTailscale,
}

/// Lo que sale del azar y se usa si el archivo no trae algo válido.
#[derive(Debug, Clone)]
pub struct Sorteado {
    pub clave: String,
    pub tema: String,
    pub secreto: String,
}

impl Config {
    pub fn por_defecto(s: &Sorteado) -> Config {
        Config {
            encendido: false,
            puerto: PUERTO_POR_DEFECTO,
            clave: s.clave.clone(),
            celus: vec![],
            aprobar: false,
            terminal: false,
            ntfy: ConfigNtfy { encendido: false, tema: s.tema.clone(), servidor: NTFY_POR_DEFECTO.into(), token: None, tema_renovado: false, privado: false },
            remoto: ConfigRemoto { encendido: false, aprobar: false, secreto: s.secreto.clone() },
            tailscale: ConfigTailscale { encendido: false, https: None },
        }
    }

    /// El orden de las claves es el de `celular.ts` (`{ ...resto, version, ...cfg }`).
    pub fn a_json(&self) -> Value {
        let mut ntfy = Map::new();
        ntfy.insert("encendido".into(), json!(self.ntfy.encendido));
        ntfy.insert("tema".into(), json!(self.ntfy.tema));
        ntfy.insert("servidor".into(), json!(self.ntfy.servidor));
        if let Some(t) = &self.ntfy.token {
            ntfy.insert("token".into(), json!(t));
        }
        if self.ntfy.tema_renovado {
            ntfy.insert("temaRenovado".into(), json!(true));
        }
        if self.ntfy.privado {
            ntfy.insert("privado".into(), json!(true));
        }
        let mut ts = Map::new();
        ts.insert("encendido".into(), json!(self.tailscale.encendido));
        if let Some(h) = &self.tailscale.https {
            ts.insert("https".into(), json!(h));
        }
        json!({
            "encendido": self.encendido,
            "puerto": self.puerto,
            "clave": self.clave,
            "celus": self.celus.iter().map(CeluGuardado::a_json).collect::<Vec<_>>(),
            "aprobar": self.aprobar,
            "terminal": self.terminal,
            "ntfy": Value::Object(ntfy),
            "remoto": { "encendido": self.remoto.encendido, "aprobar": self.remoto.aprobar, "secreto": self.remoto.secreto },
            "tailscale": Value::Object(ts)
        })
    }
}

const CLAVES_PROPIAS: [&str; 10] = ["version", "encendido", "puerto", "clave", "celus", "aprobar", "terminal", "ntfy", "remoto", "tailscale"];

fn objeto_de<'a>(raw: &'a Map<String, Value>, k: &str) -> Option<&'a Map<String, Value>> {
    raw.get(k).and_then(Value::as_object)
}

fn es_true(m: Option<&Map<String, Value>>, k: &str) -> bool {
    m.and_then(|m| m.get(k)) == Some(&Value::Bool(true))
}

/// Lo que se entiende de un archivo ya migrado. Tolerante: lo que no vale vuelve al valor por defecto.
/// Devuelve la configuración, si la clave del QR hay que generarla y los campos desconocidos para conservar.
pub fn leer_config(raw: &Map<String, Value>, ahora: i64, base: &Config) -> (Config, bool, Map<String, Value>) {
    let ntfy = objeto_de(raw, "ntfy");
    let tailscale = objeto_de(raw, "tailscale");
    let remoto = objeto_de(raw, "remoto");
    let https = tailscale.and_then(|t| t.get("https")).and_then(https_tailscale);
    let tema_guardado = ntfy.and_then(|n| n.get("tema"));
    let tema_ok = tema_guardado.and_then(Value::as_str).filter(|t| tema_valido(t));
    let token = ntfy.and_then(|n| n.get("token")).and_then(Value::as_str).filter(|t| token_ntfy_valido(t)).map(String::from);
    let renovado = es_true(ntfy, "temaRenovado") || (tema_ok.is_none() && tema_guardado.is_some());
    let clave_nueva = !clave_valida_json(raw.get("clave"));
    let aprobar = raw.get("aprobar") == Some(&Value::Bool(true));
    let cfg = Config {
        encendido: raw.get("encendido") == Some(&Value::Bool(true)),
        puerto: puerto_valido(raw.get("puerto")).unwrap_or(base.puerto),
        clave: if clave_nueva { base.clave.clone() } else { raw["clave"].as_str().unwrap_or_default().to_string() },
        celus: leer_celus(raw.get("celus"), ahora, raw.get("clave").and_then(Value::as_str)),
        aprobar,
        terminal: raw.get("terminal") == Some(&Value::Bool(true)),
        ntfy: ConfigNtfy {
            encendido: tema_ok.is_some() && es_true(ntfy, "encendido"),
            tema: tema_ok.map_or_else(|| base.ntfy.tema.clone(), String::from),
            servidor: servidor_ntfy(ntfy.and_then(|n| n.get("servidor"))).unwrap_or_else(|| NTFY_POR_DEFECTO.into()),
            token,
            tema_renovado: renovado,
            privado: es_true(ntfy, "privado"),
        },
        remoto: ConfigRemoto {
            encendido: es_true(remoto, "encendido"),
            aprobar: aprobar && es_true(remoto, "aprobar"),
            secreto: remoto.and_then(|r| r.get("secreto")).and_then(Value::as_str).filter(|s| secreto_valido(s)).map_or_else(|| base.remoto.secreto.clone(), String::from),
        },
        tailscale: ConfigTailscale { encendido: es_true(tailscale, "encendido"), https },
    };
    let resto = raw.iter().filter(|(k, _)| !CLAVES_PROPIAS.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    (cfg, clave_nueva, resto)
}

/// El archivo en disco: qué se leyó, si hay que respaldarlo antes de reescribirlo y si es de una versión más nueva.
pub struct ArchivoCelular<'a> {
    file: PathBuf,
    avisos: &'a Avisos,
    resto: Map<String, Value>,
    migrado: bool,
    futura: bool,
    existia: bool,
}

impl<'a> ArchivoCelular<'a> {
    /// Abre `celular.json` (o lo deja listo si no existe). `ahora` fecha la migración de v1.
    pub fn abrir(file: &Path, avisos: &'a Avisos, ahora: i64, sorteado: &Sorteado) -> (Self, Config, bool) {
        let estado = Cell::new(None);
        let migraciones = migraciones_celular(ahora);
        let validar = |v: &Value| {
            let r = migrar(v, &migraciones, VERSION_CELULAR);
            if r.estado == EstadoVersion::Invalida {
                return None;
            }
            estado.set(Some(r.estado));
            r.datos.as_object().cloned()
        };
        let por_defecto = Map::new;
        let existia = file.exists();
        let lectura = leer_json(file, &OpcionesLectura::nuevas(&validar, &por_defecto), avisos);
        let futura = estado.get() == Some(EstadoVersion::Futura);
        if futura {
            avisos.version_futura(file);
        }
        let (cfg, clave_nueva, resto) = leer_config(&lectura.valor, ahora, &Config::por_defecto(sorteado));
        let migrado = estado.get() == Some(EstadoVersion::Migrado);
        let a = ArchivoCelular { file: file.to_path_buf(), avisos, resto, migrado, futura, existia: existia && lectura.apartado.is_none() };
        let guardar_ya = !a.existia || clave_nueva || cfg.ntfy.tema_renovado || migrado;
        (a, cfg, guardar_ya)
    }

    /// Guarda con tmp más rename. Una versión futura no se toca; un archivo migrado se respalda antes de la primera escritura.
    pub fn guardar(&mut self, cfg: &Config) -> Result<(), String> {
        if self.futura {
            self.avisos.version_futura(&self.file);
            return Ok(());
        }
        if self.migrado && self.file.exists() {
            respaldar(&self.file).map_err(|e| format!("no se pudo respaldar {}: {e}", self.file.display()))?;
            self.migrado = false;
        }
        let mut datos = self.resto.clone();
        datos.insert("version".into(), json!(VERSION_CELULAR));
        if let Value::Object(o) = cfg.a_json() {
            datos.extend(o);
        }
        escribir_json_atomico(&self.file, &Value::Object(datos)).map(|_| ()).map_err(|e| e.to_string())
    }

    pub fn solo_lectura(&self) -> bool {
        self.futura
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::celular::pruebas::{clave_de, carpeta_temporal};
    use std::fs;

    const AHORA: i64 = 1_800_000_000_000;

    fn sorteado() -> Sorteado {
        Sorteado { clave: clave_de(1), tema: "sloth-0123456789abcdef01234567".into(), secreto: clave_de(2) }
    }

    fn base() -> Config {
        Config::por_defecto(&sorteado())
    }

    fn leer(v: Value) -> (Config, bool, Map<String, Value>) {
        leer_config(v.as_object().unwrap(), AHORA, &base())
    }

    #[test]
    fn un_archivo_vacio_da_los_valores_por_defecto_y_pide_clave_nueva() {
        let (cfg, clave_nueva, resto) = leer(json!({}));
        assert_eq!(cfg, base());
        assert!(clave_nueva);
        assert!(resto.is_empty());
        assert_eq!(cfg.puerto, 47321);
        assert!(!cfg.encendido && !cfg.aprobar && !cfg.terminal && !cfg.ntfy.encendido);
    }

    #[test]
    fn lo_valido_se_lee_y_lo_roto_vuelve_al_defecto() {
        let tema = "sloth-abcdefabcdefabcdefabcdef";
        let (cfg, clave_nueva, _) = leer(json!({
            "encendido": true, "puerto": 50000, "clave": clave_de(5), "aprobar": true, "terminal": true,
            "ntfy": { "encendido": true, "tema": tema, "servidor": "https://ntfy.ejemplo.com", "token": "tk_1", "privado": true },
            "remoto": { "encendido": true, "aprobar": true, "secreto": clave_de(6) },
            "tailscale": { "encendido": true, "https": "https://Mi-PC.tail.ts.net/" }
        }));
        assert!(!clave_nueva);
        assert_eq!((cfg.encendido, cfg.puerto, cfg.clave.as_str(), cfg.aprobar, cfg.terminal), (true, 50000, clave_de(5).as_str(), true, true));
        assert_eq!((cfg.ntfy.encendido, cfg.ntfy.tema.as_str(), cfg.ntfy.servidor.as_str(), cfg.ntfy.token.as_deref(), cfg.ntfy.privado, cfg.ntfy.tema_renovado), (true, tema, "https://ntfy.ejemplo.com/", Some("tk_1"), true, false));
        assert_eq!((cfg.remoto.encendido, cfg.remoto.aprobar, cfg.remoto.secreto.as_str()), (true, true, clave_de(6).as_str()));
        assert_eq!((cfg.tailscale.encendido, cfg.tailscale.https.as_deref()), (true, Some("https://mi-pc.tail.ts.net")));
        let (roto, _, _) = leer(json!({ "encendido": "si", "puerto": 80, "clave": "corta", "ntfy": "no", "remoto": [], "tailscale": 3, "aprobar": 1 }));
        assert_eq!(roto, base());
    }

    #[test]
    fn un_tema_malo_se_renueva_y_apaga_los_avisos() {
        let (cfg, _, _) = leer(json!({ "ntfy": { "encendido": true, "tema": "corto" } }));
        assert!(!cfg.ntfy.encendido, "con un tema que no vale, ntfy queda apagado");
        assert_eq!(cfg.ntfy.tema, base().ntfy.tema);
        assert!(cfg.ntfy.tema_renovado);
        let (sin_tema, _, _) = leer(json!({ "ntfy": { "encendido": true } }));
        assert!(!sin_tema.ntfy.tema_renovado, "sin tema guardado no hay nada que renovar");
        let (marcado, _, _) = leer(json!({ "ntfy": { "tema": "sloth-abcdefabcdefabcdefabcdef", "temaRenovado": true } }));
        assert!(marcado.ntfy.tema_renovado);
    }

    #[test]
    fn la_segunda_llave_remota_solo_vale_con_aprobar_prendido() {
        let (cfg, _, _) = leer(json!({ "aprobar": false, "remoto": { "aprobar": true } }));
        assert!(!cfg.remoto.aprobar);
    }

    #[test]
    fn los_campos_desconocidos_se_conservan_y_el_orden_de_las_claves_es_el_del_typescript() {
        let raw = json!({ "zeta": 1, "encendido": true, "alfa": { "x": 2 } });
        let (cfg, _, resto) = leer(raw);
        assert_eq!(resto.keys().collect::<Vec<_>>(), ["zeta", "alfa"]);
        let claves: Vec<String> = cfg.a_json().as_object().unwrap().keys().cloned().collect();
        assert_eq!(claves, ["encendido", "puerto", "clave", "celus", "aprobar", "terminal", "ntfy", "remoto", "tailscale"]);
    }

    #[test]
    fn el_json_de_ntfy_y_tailscale_solo_lleva_lo_que_esta() {
        let mut cfg = base();
        assert_eq!(cfg.a_json()["ntfy"], json!({ "encendido": false, "tema": cfg.ntfy.tema, "servidor": "https://ntfy.sh/" }));
        assert_eq!(cfg.a_json()["tailscale"], json!({ "encendido": false }));
        cfg.ntfy.token = Some("t".into());
        cfg.ntfy.tema_renovado = true;
        cfg.ntfy.privado = true;
        cfg.tailscale.https = Some("https://a.ts.net".into());
        let j = cfg.a_json();
        assert_eq!(j["ntfy"].as_object().unwrap().keys().collect::<Vec<_>>(), ["encendido", "tema", "servidor", "token", "temaRenovado", "privado"]);
        assert_eq!(j["tailscale"]["https"], "https://a.ts.net");
    }

    #[test]
    fn un_archivo_nuevo_se_crea_y_se_vuelve_a_leer_igual() {
        let d = carpeta_temporal("config-nuevo");
        let file = d.join("celular.json");
        let avisos = Avisos::nuevo();
        let (mut a, cfg, guardar_ya) = ArchivoCelular::abrir(&file, &avisos, AHORA, &sorteado());
        assert!(guardar_ya, "sin archivo hay que crearlo");
        a.guardar(&cfg).unwrap();
        let (_, otra, guardar_ya) = ArchivoCelular::abrir(&file, &avisos, AHORA, &Sorteado { clave: clave_de(9), tema: "x".into(), secreto: clave_de(9) });
        assert_eq!(otra, cfg);
        assert!(!guardar_ya);
        let escrito: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(escrito["version"], 2);
        assert_eq!(escrito.as_object().unwrap().keys().next().unwrap(), "version", "sin desconocidos, `version` va primero");
    }

    #[test]
    fn un_archivo_v1_se_migra_se_respalda_antes_de_reescribir_y_conserva_lo_que_no_conoce() {
        let d = carpeta_temporal("config-v1");
        let file = d.join("celular.json");
        let original = include_str!("fixtures/celular-v1.json");
        fs::write(&file, original).unwrap();
        let avisos = Avisos::nuevo();
        let (mut a, cfg, guardar_ya) = ArchivoCelular::abrir(&file, &avisos, AHORA, &sorteado());
        assert!(guardar_ya, "migrado: hay que guardarlo");
        assert_eq!(cfg.celus.len(), 1);
        assert_eq!(cfg.celus[0].id, "antes");
        assert_eq!(cfg.clave, clave_de(1), "el QR pasa a tener una clave nueva");
        assert_eq!(fs::read_to_string(&file).unwrap(), original, "hasta guardar no se toca");
        a.guardar(&cfg).unwrap();
        let respaldos: Vec<_> = fs::read_dir(&d).unwrap().filter_map(Result::ok).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n != "celular.json").collect();
        assert_eq!(respaldos.len(), 1, "{respaldos:?}");
        assert_eq!(fs::read_to_string(d.join(&respaldos[0])).unwrap(), original);
        let nuevo: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(nuevo["version"], 2);
        assert_eq!(nuevo["campoQueNoConozco"], 1);
        assert_eq!(nuevo["celus"][0]["clave"], clave_de(7));
        a.guardar(&cfg).unwrap();
        assert_eq!(fs::read_dir(&d).unwrap().count(), 2, "el respaldo se hace una sola vez");
    }

    #[test]
    fn una_version_futura_queda_en_solo_lectura_y_no_se_reescribe() {
        let d = carpeta_temporal("config-futuro");
        let file = d.join("celular.json");
        let futuro = r#"{"version":3,"encendido":true,"nuevo":"formato"}"#;
        fs::write(&file, futuro).unwrap();
        let avisos = Avisos::nuevo();
        let (mut a, cfg, _) = ArchivoCelular::abrir(&file, &avisos, AHORA, &sorteado());
        assert!(a.solo_lectura());
        a.guardar(&cfg).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), futuro);
        assert_eq!(fs::read_dir(&d).unwrap().count(), 1, "ni siquiera un respaldo");
    }

    #[test]
    fn un_archivo_dañado_se_aparta_y_se_arranca_de_cero() {
        let d = carpeta_temporal("config-roto");
        let file = d.join("celular.json");
        fs::write(&file, "{roto").unwrap();
        let avisos = Avisos::nuevo();
        let (mut a, cfg, guardar_ya) = ArchivoCelular::abrir(&file, &avisos, AHORA, &sorteado());
        assert!(guardar_ya);
        assert_eq!(cfg, base());
        a.guardar(&cfg).unwrap();
        let nombres: Vec<String> = fs::read_dir(&d).unwrap().filter_map(Result::ok).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(nombres.iter().any(|n| n.contains(".corrupt-")), "{nombres:?}");
    }
}
