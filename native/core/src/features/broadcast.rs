//! «Últimos envíos» de Enviar a varios: validación de cada entrada y la lista guardada en `broadcast.json`. Equivale a
//! src/main/features/broadcast.ts; el envío en sí lo hace la interfaz.
use crate::perfiles_core::es_blanco_js;
use serde_json::{json, Map, Number, Value};

pub const MAX_ENTRIES: usize = 6;
const MAX_TEXT: usize = 2000;
const MAX_IDS: usize = 50;

#[derive(Debug, Clone, PartialEq)]
pub struct Envio {
    pub id: String,
    /// Epoch ms.
    pub time: Number,
    pub text: String,
    /// Ids de espacio a los que se mandó.
    pub ids: Vec<String>,
    /// Nombres en el momento del envío (por si el espacio se borra después).
    pub names: Vec<String>,
}

impl Envio {
    pub fn a_json(&self) -> Value {
        json!({ "id": self.id, "time": self.time, "text": self.text, "ids": self.ids, "names": self.names })
    }
}

fn textos(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).take(MAX_IDS).collect(),
        _ => vec![],
    }
}

/// Valida una entrada guardada o recibida. None si no sirve.
pub fn limpiar(raw: &Value) -> Option<Envio> {
    let o: &Map<String, Value> = raw.as_object()?;
    let text = o.get("text")?.as_str().filter(|t| t.encode_utf16().count() <= MAX_TEXT)?.trim_matches(es_blanco_js);
    let id = o.get("id")?.as_str()?;
    let time = o.get("time")?.as_number()?.clone();
    if text.is_empty() {
        return None;
    }
    let mut unidades = 0;
    let id: String = id
        .chars()
        .take_while(|c| {
            unidades += c.len_utf16();
            unidades <= 64
        })
        .collect();
    Some(Envio { id, time, text: text.to_string(), ids: textos(o.get("ids")), names: textos(o.get("names")) })
}

/// Lo que valida la lectura del archivo: un arreglo da hasta 6 entradas válidas; cualquier otra cosa se rechaza.
pub fn leer_lista(raw: &Value) -> Option<Vec<Envio>> {
    let a = raw.as_array()?;
    Some(a.iter().filter_map(limpiar).take(MAX_ENTRIES).collect())
}

pub fn lista_a_json(l: &[Envio]) -> Value {
    Value::Array(l.iter().map(Envio::a_json).collect())
}

/// `feat:broadcast:add`: la entrada nueva va primera y reemplaza a la de igual id.
pub fn sumar(actual: &[Envio], raw: &Value) -> Result<Vec<Envio>, String> {
    let e = limpiar(raw).ok_or("Envío inválido.")?;
    let mut nueva = vec![e.clone()];
    nueva.extend(actual.iter().filter(|x| x.id != e.id).cloned());
    nueva.truncate(MAX_ENTRIES);
    Ok(nueva)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(id: &str) -> Value {
        json!({ "id": id, "time": 5, "text": "hola", "ids": ["a"], "names": ["A"] })
    }

    #[test]
    fn limpia_y_recorta_una_entrada() {
        let r = limpiar(&json!({ "id": "x".repeat(70), "time": 1.5, "text": "  hola  ", "ids": ["a", 3, "b"], "names": "n" })).unwrap();
        assert_eq!((r.id.len(), r.text.as_str(), r.ids, r.names), (64, "hola", vec!["a".to_string(), "b".to_string()], vec![]));
        assert_eq!(r.time.as_f64(), Some(1.5));
        let muchos: Vec<String> = (0..80).map(|i| i.to_string()).collect();
        assert_eq!(limpiar(&json!({ "id": "a", "time": 1, "text": "t", "ids": muchos })).unwrap().ids.len(), 50);
    }

    #[test]
    fn rechaza_lo_que_no_sirve() {
        for malo in [
            json!(null),
            json!("x"),
            json!([]),
            json!({ "id": "a", "time": 1, "text": "   " }),
            json!({ "id": "a", "time": 1, "text": "t".repeat(2001) }),
            json!({ "id": 1, "time": 1, "text": "t" }),
            json!({ "id": "a", "time": "1", "text": "t" }),
            json!({ "id": "a", "text": "t" }),
        ] {
            assert_eq!(limpiar(&malo), None, "{malo}");
        }
        assert!(limpiar(&json!({ "id": "a", "time": 1, "text": "t".repeat(2000) })).is_some());
    }

    #[test]
    fn la_lectura_filtra_y_corta_a_seis() {
        let raw = json!([e("1"), 5, e("2"), e("3"), e("4"), e("5"), e("6"), e("7")]);
        let l = leer_lista(&raw).unwrap();
        assert_eq!(l.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["1", "2", "3", "4", "5", "6"]);
        assert_eq!(leer_lista(&json!({})), None);
        assert_eq!(lista_a_json(&l)[0], e("1"));
    }

    #[test]
    fn sumar_pone_primero_y_reemplaza_el_mismo_id() {
        let actual = leer_lista(&json!([e("1"), e("2"), e("3"), e("4"), e("5"), e("6")])).unwrap();
        let n = sumar(&actual, &e("3")).unwrap();
        assert_eq!(n.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["3", "1", "2", "4", "5", "6"]);
        let n = sumar(&actual, &e("9")).unwrap();
        assert_eq!(n.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["9", "1", "2", "3", "4", "5"]);
        assert_eq!(sumar(&actual, &json!({})), Err("Envío inválido.".to_string()));
    }
}
