//! Migración de archivos versionados. Equivale a src/main/versionado.ts: sin `version` el archivo es de la v1;
//! una versión más nueva que la de la app vuelve intacta (quien llama no la reescribe); nunca tira ni muta la entrada.
use serde_json::{Map, Value};
use std::collections::HashMap;

pub type Objeto = Map<String, Value>;
/// `migraciones[n]` lleva de la versión n a la n+1.
pub type Migracion = Box<dyn Fn(Objeto) -> Result<Objeto, String> + Send + Sync>;
pub type Migraciones = HashMap<u32, Migracion>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EstadoVersion {
    Actual,
    Migrado,
    Futura,
    Invalida,
}

#[derive(Debug, Clone)]
pub struct ResultadoMigrar {
    pub datos: Value,
    pub desde: f64,
    pub hasta: f64,
    pub estado: EstadoVersion,
    pub motivo: Option<String>,
}

fn invalida(desde: f64, motivo: String) -> ResultadoMigrar {
    ResultadoMigrar { datos: Value::Object(Map::new()), desde, hasta: desde, estado: EstadoVersion::Invalida, motivo: Some(motivo) }
}

pub fn migrar(datos: &Value, migraciones: &Migraciones, version_actual: u32) -> ResultadoMigrar {
    let Some(obj) = datos.as_object() else { return invalida(0.0, "no es un objeto".into()) };
    let explicita = obj.contains_key("version");
    // Un `version: null` es una versión que no se entiende, no «sin versión» (igual que en el TypeScript).
    let version = obj.get("version").cloned().unwrap_or_else(|| Value::from(1));
    let n = match version.as_f64() {
        Some(n) if n.is_finite() && n.fract() == 0.0 && n >= 1.0 => n,
        _ => return invalida(0.0, format!("tiene una versión que no entiendo ({version})")),
    };
    let actual = f64::from(version_actual);
    if n > actual {
        return ResultadoMigrar { datos: datos.clone(), desde: n, hasta: n, estado: EstadoVersion::Futura, motivo: None };
    }
    if n == actual && explicita {
        return ResultadoMigrar { datos: datos.clone(), desde: n, hasta: n, estado: EstadoVersion::Actual, motivo: None };
    }
    let mut copia: Objeto = obj.clone();
    for v in (n as u32)..version_actual {
        let Some(paso) = migraciones.get(&v) else {
            return invalida(n, format!("falta la migración de la versión {v} a la {}", v + 1));
        };
        match paso(copia) {
            Ok(salida) => copia = salida,
            Err(e) => return invalida(n, format!("falló la migración de la versión {v} a la {} ({e})", v + 1)),
        }
    }
    copia.insert("version".into(), Value::from(version_actual));
    ResultadoMigrar { datos: Value::Object(copia), desde: n, hasta: actual, estado: EstadoVersion::Migrado, motivo: None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn vacia() -> Migraciones {
        HashMap::new()
    }

    #[test]
    fn sin_version_con_actual_1_migra_y_no_pierde_campos() {
        let entrada = json!({ "accounts": [{ "id": "a" }], "extra": { "x": 1 } });
        let r = migrar(&entrada, &vacia(), 1);
        assert_eq!(r.estado, EstadoVersion::Migrado);
        assert_eq!(r.datos, json!({ "accounts": [{ "id": "a" }], "extra": { "x": 1 }, "version": 1 }));
        assert_eq!((r.desde, r.hasta), (1.0, 1.0));
    }

    #[test]
    fn version_explicita_igual_a_la_actual_es_actual() {
        let entrada = json!({ "version": 1, "a": 1 });
        let r = migrar(&entrada, &vacia(), 1);
        assert_eq!(r.estado, EstadoVersion::Actual);
        assert_eq!(r.datos, entrada);
    }

    #[test]
    fn la_cadena_v1_a_v3_aplica_las_migraciones_en_orden() {
        let orden = Arc::new(Mutex::new(Vec::new()));
        let mut m = vacia();
        let o1 = orden.clone();
        m.insert(1, Box::new(move |mut d| {
            o1.lock().unwrap().push(1);
            d.insert("paso1".into(), json!(true));
            Ok(d)
        }));
        let o2 = orden.clone();
        m.insert(2, Box::new(move |mut d| {
            o2.lock().unwrap().push(2);
            let paso1 = d.get("paso1") == Some(&json!(true));
            d.insert("paso2".into(), json!(paso1));
            Ok(d)
        }));
        let r = migrar(&json!({ "version": 1, "dato": "x" }), &m, 3);
        assert_eq!(*orden.lock().unwrap(), vec![1, 2]);
        assert_eq!(r.estado, EstadoVersion::Migrado);
        assert_eq!(r.datos, json!({ "version": 3, "dato": "x", "paso1": true, "paso2": true }));
        assert_eq!((r.desde, r.hasta), (1.0, 3.0));
    }

    #[test]
    fn una_migracion_no_puede_dejar_una_version_vieja() {
        let mut m = vacia();
        m.insert(1, Box::new(|mut d| {
            d.insert("version".into(), json!(7));
            Ok(d)
        }));
        assert_eq!(migrar(&json!({ "version": 1 }), &m, 2).datos["version"], json!(2));
    }

    #[test]
    fn no_muta_la_entrada() {
        let entrada = json!({ "version": 1, "lista": [1, 2], "anidado": { "n": 1 } });
        let copia = entrada.clone();
        let mut m = vacia();
        m.insert(1, Box::new(|mut d| {
            d["lista"].as_array_mut().unwrap().push(json!(3));
            d["anidado"]["n"] = json!(99);
            Ok(d)
        }));
        let r = migrar(&entrada, &m, 2);
        assert_eq!(r.estado, EstadoVersion::Migrado);
        assert_eq!(entrada, copia);
        assert_eq!(r.datos["lista"], json!([1, 2, 3]));
    }

    #[test]
    fn falta_un_eslabon_es_invalida_con_motivo() {
        let mut m = vacia();
        m.insert(2, Box::new(Ok));
        let r = migrar(&json!({ "version": 1 }), &m, 3);
        assert_eq!(r.estado, EstadoVersion::Invalida);
        assert!(r.motivo.unwrap().contains("falta la migración de la versión 1 a la 2"));
    }

    #[test]
    fn una_migracion_que_falla_es_invalida_y_no_tira() {
        let mut m = vacia();
        m.insert(1, Box::new(|_| Err("boom".into())));
        let r = migrar(&json!({ "version": 1 }), &m, 2);
        assert_eq!(r.estado, EstadoVersion::Invalida);
        assert!(r.motivo.unwrap().contains("boom"));
    }

    #[test]
    fn version_futura_vuelve_sin_tocar() {
        let entrada = json!({ "version": 2, "accounts": [], "campoNuevo": { "a": 1 } });
        let r = migrar(&entrada, &vacia(), 1);
        assert_eq!(r.estado, EstadoVersion::Futura);
        assert_eq!(r.datos, entrada);
        assert_eq!(r.desde, 2.0);
    }

    #[test]
    fn version_rara_es_invalida() {
        for version in [json!("2"), json!("1"), json!(1.5), json!(0), json!(-1), json!(null), json!(true), json!([]), json!({})] {
            let r = migrar(&json!({ "version": version }), &vacia(), 1);
            assert_eq!(r.estado, EstadoVersion::Invalida, "{version}");
            assert!(r.motivo.is_some());
        }
    }

    #[test]
    fn lo_que_no_es_un_objeto_es_invalido() {
        for x in [json!(null), json!([]), json!([{ "version": 1 }]), json!("texto"), json!(3), json!(true)] {
            assert_eq!(migrar(&x, &vacia(), 1).estado, EstadoVersion::Invalida);
        }
    }

    #[test]
    fn un_numero_enorme_es_futuro_no_un_error() {
        assert_eq!(migrar(&json!({ "version": 1e300 }), &vacia(), 1).estado, EstadoVersion::Futura);
    }
}
