//! Los conectores que vienen con Sloth. Los datos están en `conectores_incluidos.json`, generado con el validador de
//! TypeScript a partir de src/main/features/tickets/conectores/*.ts, y acá pasan por el mismo validador que los propios.
use super::conector::{validar_conector, ConectorDef};
use serde_json::Value;
use std::sync::LazyLock;

const JSON_INCLUIDOS: &str = include_str!("conectores_incluidos.json");

/// Donde caen gruv.json y los tickets.json viejos sin conector válido: así los usuarios de antes siguen igual.
pub const CONECTOR_LEGADO: &str = "gruv";

/// Los incluidos tal como se escribieron, sin validar.
pub fn crudos() -> Vec<Value> {
    serde_json::from_str::<Vec<Value>>(JSON_INCLUIDOS).unwrap_or_default()
}

pub fn crudo(id: &str) -> Value {
    crudos().into_iter().find(|c| c.get("id").and_then(Value::as_str) == Some(id)).unwrap_or(Value::Null)
}

/// Un conector mal escrito se saltea: no tira la app.
pub static CONECTORES: LazyLock<Vec<ConectorDef>> = LazyLock::new(|| {
    let mut out: Vec<ConectorDef> = Vec::new();
    for d in crudos() {
        if let Ok(def) = validar_conector(&d) {
            if !out.iter().any(|c| c.id() == def.id()) {
                out.push(def);
            }
        }
    }
    out
});

pub fn conector_por_id(id: &str) -> Option<&'static ConectorDef> {
    CONECTORES.iter().find(|c| c.id() == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn los_doce_incluidos_validan() {
        assert_eq!(crudos().len(), 12);
        assert_eq!(CONECTORES.len(), 12);
        for d in crudos() {
            let id = d["id"].as_str().unwrap().to_string();
            assert!(conector_por_id(&id).is_some(), "{id}");
        }
    }

    #[test]
    fn el_conector_legado_existe() {
        assert!(conector_por_id(CONECTOR_LEGADO).is_some());
    }
}
