//! Ayudas de texto y de números que reproducen lo que hace JavaScript donde cambia el resultado: espacios, largos en
//! unidades UTF-16, tildes y números que se imprimen sin `.0`.
use regex::Regex;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Number, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use unicode_normalization::UnicodeNormalization;

/// Los espacios de `\s` y de `String.prototype.trim` en JavaScript.
pub fn es_espacio_js(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub fn trim_js(s: &str) -> &str {
    s.trim_matches(es_espacio_js)
}

/// `s.replace(/\s+/g, ' ').trim()`
pub fn colapsar(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut en_espacio = false;
    for c in s.chars() {
        if es_espacio_js(c) {
            en_espacio = true;
        } else {
            if en_espacio && !out.is_empty() {
                out.push(' ');
            }
            en_espacio = false;
            out.push(c);
        }
    }
    out
}

pub fn len16(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(0, max)` medido en UTF-16, sin partir un par sustituto.
pub fn cortar16(s: &str, max: usize) -> &str {
    crate::acotar::recortar_utf16(s, max)
}

/// El valor como texto de una línea, acotado: lo que en el TypeScript es `str(v, max)`. Un número se pasa a texto.
pub fn str_js(v: &Value, max: usize) -> Option<String> {
    let crudo = match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => num_a_texto(n),
        _ => return None,
    };
    let s = colapsar(&crudo);
    if s.is_empty() {
        None
    } else {
        Some(cortar16(&s, max).to_string())
    }
}

pub fn num_a_texto(n: &Number) -> String {
    match n.as_f64() {
        Some(f) if n.is_f64() && f.fract() == 0.0 && f.abs() < 1e21 => format!("{f:.0}"),
        _ => n.to_string(),
    }
}

/// Sin tildes ni marcas combinadas (`normalize('NFD')` y quitar U+0300 a U+036F).
pub fn sin_tildes(s: &str) -> String {
    s.nfd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect()
}

/// Orden alfabético de personas, parecido a `localeCompare(…, 'es')`: sin tildes ni mayúsculas, y la `ñ` después de la `n`.
pub fn clave_es(s: &str) -> String {
    s.chars()
        .flat_map(|c| {
            if matches!(c, 'ñ' | 'Ñ') {
                vec!['n', '\u{10000}']
            } else {
                sin_tildes(&c.to_string()).chars().flat_map(char::to_lowercase).collect()
            }
        })
        .collect()
}

pub fn cmp_es(a: &str, b: &str) -> std::cmp::Ordering {
    clave_es(a).cmp(&clave_es(b)).then_with(|| a.cmp(b))
}

/// Un número como el de JavaScript: los enteros sin `.0`.
#[derive(Debug, Clone, Copy, PartialEq, PartialOrd, Default)]
pub struct Num(pub f64);

pub fn num_valor(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 9e15 {
        Value::from(x as i64)
    } else {
        Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
    }
}

impl Serialize for Num {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        num_valor(self.0).serialize(s)
    }
}

impl<'de> Deserialize<'de> for Num {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let n = Number::deserialize(d)?;
        n.as_f64().map(Num).ok_or_else(|| serde::de::Error::custom("número no finito"))
    }
}

/// El número finito de un valor JSON, si lo es.
pub fn numero(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite())
}

/// Convierte una expresión regular escrita para JavaScript a la sintaxis de `regex`: `\d` y `\w` son ASCII en JavaScript
/// y Unicode en Rust.
pub fn traducir_js(patron: &str) -> String {
    let mut out = String::with_capacity(patron.len() + 8);
    let mut en_clase = false;
    let mut it = patron.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '\\' => match it.next() {
                Some('d') => out.push_str(if en_clase { "0-9" } else { "[0-9]" }),
                Some('w') => out.push_str(if en_clase { "A-Za-z0-9_" } else { "[A-Za-z0-9_]" }),
                Some(otro) => {
                    out.push('\\');
                    out.push(otro);
                }
                None => out.push('\\'),
            },
            '[' if !en_clase => {
                en_clase = true;
                out.push(c);
            }
            ']' if en_clase => {
                en_clase = false;
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

fn cache() -> &'static Mutex<HashMap<String, Option<Regex>>> {
    static C: OnceLock<Mutex<HashMap<String, Option<Regex>>>> = OnceLock::new();
    C.get_or_init(Mutex::default)
}

/// Compila (y recuerda) una expresión regular escrita en JavaScript; `None` si no compila.
pub fn regex_js(patron: &str) -> Option<Regex> {
    let mut c = cache().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(r) = c.get(patron) {
        return r.clone();
    }
    let r = Regex::new(&traducir_js(patron)).ok();
    if c.len() > 512 {
        c.clear();
    }
    c.insert(patron.to_string(), r.clone());
    r
}

/// Una expresión fija del código: si no compila es un error de quien la escribió.
pub fn re(patron: &str) -> Regex {
    regex_js(patron).unwrap_or_else(|| panic!("expresión regular inválida: {patron}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn colapsa_espacios_como_javascript() {
        assert_eq!(colapsar("  a \n\t b\u{a0}c  "), "a b c");
        assert_eq!(colapsar("   "), "");
    }

    #[test]
    fn str_js_pasa_numeros_a_texto_y_corta_en_utf16() {
        assert_eq!(str_js(&json!(12), 10).as_deref(), Some("12"));
        assert_eq!(str_js(&json!("  hola   mundo "), 4).as_deref(), Some("hola"));
        assert_eq!(str_js(&json!("   "), 4), None);
        assert_eq!(str_js(&json!(null), 4), None);
        assert_eq!(str_js(&json!("ab😀cd"), 3).as_deref(), Some("ab"));
    }

    #[test]
    fn los_enteros_se_imprimen_sin_punto_cero() {
        assert_eq!(serde_json::to_string(&Num(3.0)).unwrap(), "3");
        assert_eq!(serde_json::to_string(&Num(0.5)).unwrap(), "0.5");
    }

    #[test]
    fn d_y_w_son_ascii_como_en_javascript() {
        let r = re("^[A-Z]-\\d{1,3}$");
        assert!(r.is_match("A-12"));
        assert!(!r.is_match("A-١٢"));
        assert!(re("^[\\w-]+$").is_match("ab_c-1"));
        assert!(!re("^[\\w-]+$").is_match("ñ"));
    }

    #[test]
    fn ordena_como_en_espanol() {
        let mut v = vec!["Óscar", "Ana", "Ñandú", "Nora", "zoe"];
        v.sort_by(|a, b| cmp_es(a, b));
        assert_eq!(v, vec!["Ana", "Nora", "Ñandú", "Óscar", "zoe"]);
    }
}
