//! Lógica pura de «help» (Novedades): comparación de versiones x.y.z y filtro del changelog. Equivale a
//! src/main/features/help-core.ts y a la decisión de `feat:help:whatsnew` de help.ts.
use serde_json::{json, Value};
use std::cmp::Ordering;

pub trait ConVersion {
    fn version(&self) -> &str;
}

/// `^\d+\.\d+\.\d+$` con `\d` ASCII; sin flag `m`, el `$` de JS no admite un salto de línea final.
pub fn es_version(v: &str) -> bool {
    let mut partes = v.split('.');
    let mut n = 0;
    for p in partes.by_ref() {
        if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        n += 1;
    }
    n == 3
}

pub fn es_version_valor(v: &Value) -> bool {
    v.as_str().is_some_and(es_version)
}

fn partes(v: &str) -> Vec<f64> {
    v.split('.').map(|p| p.parse::<f64>().unwrap_or(f64::INFINITY)).collect()
}

/// None si alguna no es x.y.z.
pub fn comparar_versiones(a: &str, b: &str) -> Option<Ordering> {
    if !es_version(a) || !es_version(b) {
        return None;
    }
    let (pa, pb) = (partes(a), partes(b));
    for i in 0..3 {
        if pa[i] != pb[i] {
            return Some(if pa[i] < pb[i] { Ordering::Less } else { Ordering::Greater });
        }
    }
    Some(Ordering::Equal)
}

/// Entradas con versión mayor que `ultima_vista` y menor o igual que `actual`, en el orden en que llegan.
/// Sin `ultima_vista` (primera instalación) no hay novedades.
pub fn entradas_entre<'a, T: ConVersion>(entradas: &'a [T], ultima_vista: Option<&str>, actual: &str) -> Vec<&'a T> {
    let Some(vista) = ultima_vista else { return vec![] };
    entradas
        .iter()
        .filter(|e| {
            comparar_versiones(e.version(), vista) == Some(Ordering::Greater)
                && comparar_versiones(e.version(), actual).map_or(false, |o| o != Ordering::Greater)
        })
        .collect()
}

#[derive(Debug, PartialEq)]
pub struct Novedades<'a, T> {
    pub actual: String,
    pub ultima_vista: Option<String>,
    pub mostrar: bool,
    pub entradas: Vec<&'a T>,
}

pub fn novedades_para<'a, T: ConVersion>(entradas: &'a [T], ultima_vista: Option<&str>, actual: &str) -> Novedades<'a, T> {
    let lista = entradas_entre(entradas, ultima_vista, actual);
    Novedades {
        actual: actual.to_string(),
        ultima_vista: ultima_vista.map(str::to_string),
        mostrar: !lista.is_empty() && ultima_vista.is_some(),
        entradas: lista,
    }
}

/// Lee `lastSeen` de un JSON ya parseado. Si no es una versión válida, None.
pub fn leer_estado(raw: &Value) -> Option<String> {
    raw.get("lastSeen").and_then(Value::as_str).filter(|v| es_version(v)).map(str::to_string)
}

/// Lo que dice el archivo `help.json` crudo: sin BOM y, si no es JSON, None (igual que un archivo ausente).
pub fn leer_ultima_vista(texto: &str) -> Option<String> {
    let limpio = texto.strip_prefix('\u{feff}').unwrap_or(texto);
    serde_json::from_str::<Value>(limpio).ok().and_then(|v| leer_estado(&v))
}

pub fn formato_archivo(version: &str) -> String {
    serde_json::to_string_pretty(&json!({ "lastSeen": version })).unwrap_or_default()
}

pub fn validar_visto(version: &Value) -> Result<&str, String> {
    version.as_str().filter(|v| es_version(v)).ok_or_else(|| "Versión inválida".to_string())
}

#[derive(Debug, PartialEq)]
pub enum Decision<'a, T> {
    /// Viene de la 0.4 (sin help.json pero con datos): novedades desde la 0.4.0, una vez.
    Desde04(Novedades<'a, T>),
    /// Primera instalación: se guarda la versión actual y no hay novedades.
    PrimeraInstalacion,
    Normal(Novedades<'a, T>),
}

pub fn decidir_novedades<'a, T: ConVersion>(entradas: &'a [T], ultima_vista: Option<&str>, actual: &str, hay_datos: bool) -> Decision<'a, T> {
    match ultima_vista {
        None if hay_datos => Decision::Desde04(novedades_para(entradas, Some("0.4.0"), actual)),
        None => Decision::PrimeraInstalacion,
        Some(v) => Decision::Normal(novedades_para(entradas, Some(v), actual)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq)]
    struct E(&'static str);
    impl ConVersion for E {
        fn version(&self) -> &str {
            self.0
        }
    }
    fn lista() -> Vec<E> {
        vec![E("0.8.1"), E("0.8.0"), E("0.5.0"), E("0.4.0")]
    }
    fn versiones<'a>(v: &[&'a E]) -> Vec<&'a str> {
        v.iter().map(|e| e.0).collect()
    }

    #[test]
    fn es_version_pide_tres_numeros_ascii() {
        assert!(es_version("0.4.0"));
        assert!(es_version("10.20.30"));
        for malo in ["", "1.2", "1.2.3.4", "1.2.x", "v1.2.3", "1.2.3\n", " 1.2.3", "1..3", "١.٢.٣"] {
            assert!(!es_version(malo), "{malo:?}");
        }
        assert!(!es_version_valor(&json!(123)));
    }

    #[test]
    fn compara_numericamente_y_no_como_texto() {
        assert_eq!(comparar_versiones("0.10.0", "0.9.0"), Some(Ordering::Greater));
        assert_eq!(comparar_versiones("1.0.0", "1.0.0"), Some(Ordering::Equal));
        assert_eq!(comparar_versiones("0.4.9", "0.5.0"), Some(Ordering::Less));
        assert_eq!(comparar_versiones("x", "1.0.0"), None);
    }

    #[test]
    fn entradas_entre_deja_las_mayores_a_la_vista_y_hasta_la_actual() {
        let l = lista();
        assert_eq!(versiones(&entradas_entre(&l, Some("0.5.0"), "0.8.0")), vec!["0.8.0"]);
        assert_eq!(versiones(&entradas_entre(&l, Some("0.4.0"), "0.8.1")), vec!["0.8.1", "0.8.0", "0.5.0"]);
        assert!(entradas_entre(&l, None, "0.8.1").is_empty());
        assert!(entradas_entre(&l, Some("0.8.1"), "0.8.1").is_empty());
    }

    #[test]
    fn una_version_invalida_en_el_changelog_no_entra() {
        let l = vec![E("raro"), E("0.5.0")];
        assert_eq!(versiones(&entradas_entre(&l, Some("0.4.0"), "0.5.0")), vec!["0.5.0"]);
    }

    #[test]
    fn novedades_para_muestra_solo_con_entradas_y_con_vista_previa() {
        let l = lista();
        let n = novedades_para(&l, Some("0.5.0"), "0.8.1");
        assert!(n.mostrar);
        assert_eq!(n.ultima_vista.as_deref(), Some("0.5.0"));
        let n = novedades_para(&l, Some("0.8.1"), "0.8.1");
        assert!(!n.mostrar && n.entradas.is_empty());
        assert!(!novedades_para(&l, None, "0.8.1").mostrar);
    }

    #[test]
    fn leer_estado_acepta_solo_versiones_validas() {
        assert_eq!(leer_estado(&json!({ "lastSeen": "0.4.0" })).as_deref(), Some("0.4.0"));
        assert_eq!(leer_estado(&json!({ "lastSeen": "0.4" })), None);
        assert_eq!(leer_estado(&json!({ "lastSeen": 4 })), None);
        assert_eq!(leer_estado(&json!(null)), None);
        assert_eq!(leer_estado(&json!("0.4.0")), None);
    }

    #[test]
    fn leer_ultima_vista_ignora_el_bom_y_lo_roto() {
        assert_eq!(leer_ultima_vista("\u{feff}{\"lastSeen\":\"0.7.0\"}").as_deref(), Some("0.7.0"));
        assert_eq!(leer_ultima_vista("{roto"), None);
        assert_eq!(leer_ultima_vista(""), None);
    }

    #[test]
    fn el_archivo_se_escribe_con_dos_espacios() {
        assert_eq!(formato_archivo("0.8.1"), "{\n  \"lastSeen\": \"0.8.1\"\n}");
    }

    #[test]
    fn visto_rechaza_lo_que_no_es_version() {
        assert_eq!(validar_visto(&json!("0.8.1")), Ok("0.8.1"));
        assert_eq!(validar_visto(&json!("0.8")), Err("Versión inválida".to_string()));
        assert!(validar_visto(&json!(null)).is_err());
    }

    #[test]
    fn decidir_novedades_cubre_los_tres_caminos() {
        let l = lista();
        assert_eq!(decidir_novedades(&l, None, "0.8.1", false), Decision::PrimeraInstalacion);
        match decidir_novedades(&l, None, "0.8.1", true) {
            Decision::Desde04(n) => assert_eq!(versiones(&n.entradas), vec!["0.8.1", "0.8.0", "0.5.0"]),
            _ => panic!("tenía que ser Desde04"),
        }
        match decidir_novedades(&l, Some("0.8.0"), "0.8.1", true) {
            Decision::Normal(n) => assert!(n.mostrar),
            _ => panic!("tenía que ser Normal"),
        }
    }
}
