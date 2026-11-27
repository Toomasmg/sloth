//! Validación de los cambios a un espacio (renombrar, ícono) que llegan por IPC (`workspaces:update`).
//! Equivale a src/main/workspace-patch.ts. Devuelve un mensaje para mostrar si algo no es válido.
use crate::perfiles_core::es_blanco_js;
use serde_json::Value;
use unicode_segmentation::UnicodeSegmentation;

const MAX_NAME: usize = 80;
const MAX_ICON_UNITS: usize = 16;
const MAX_ICON_GRAPHEMES: usize = 2;

#[derive(Debug, PartialEq, Default)]
pub struct CambioEspacio {
    pub name: Option<String>,
    /// `Some(None)` es quitar el ícono.
    pub icon: Option<Option<String>>,
}

fn tiene_control(s: &str) -> bool {
    s.chars().any(|c| matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{2028}' | '\u{2029}'))
}

fn utf16(s: &str) -> usize {
    s.encode_utf16().count()
}

pub fn validar_cambio_de_espacio(raw: &Value) -> Result<CambioEspacio, String> {
    let patch = raw.as_object().ok_or("Cambio inválido.")?;
    for k in patch.keys() {
        if k != "name" && k != "icon" {
            return Err(format!("No se puede cambiar «{k}»."));
        }
    }
    let mut out = CambioEspacio::default();
    if let Some(n) = patch.get("name") {
        let name = n.as_str().ok_or("El nombre tiene que ser texto.")?.trim_matches(es_blanco_js);
        if name.is_empty() {
            return Err("Poné un nombre.".into());
        }
        if utf16(name) > MAX_NAME {
            return Err(format!("El nombre puede tener hasta {MAX_NAME} caracteres."));
        }
        if tiene_control(name) {
            return Err("El nombre tiene caracteres no válidos.".into());
        }
        out.name = Some(name.to_string());
    }
    if let Some(icon) = patch.get("icon") {
        out.icon = Some(match icon {
            Value::Null => None,
            Value::String(s) if s.is_empty() => None,
            Value::String(s) => {
                let t = s.trim_matches(es_blanco_js);
                let ascii_raro = t.chars().any(|c| c.is_ascii_alphanumeric() || "<>&\"'`\\/".contains(c));
                if t.is_empty() || utf16(t) > MAX_ICON_UNITS || t.graphemes(true).count() > MAX_ICON_GRAPHEMES || tiene_control(t) || ascii_raro {
                    return Err("El ícono tiene que ser un emoji (uno o dos).".into());
                }
                Some(t.to_string())
            }
            _ => return Err("El ícono tiene que ser un emoji.".into()),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn err(v: Value) -> String {
        validar_cambio_de_espacio(&v).unwrap_err()
    }

    #[test]
    fn nombre_se_recorta_y_valida() {
        assert_eq!(validar_cambio_de_espacio(&json!({ "name": "  api-pagos " })).unwrap().name.as_deref(), Some("api-pagos"));
        assert_eq!(err(json!({ "name": "   " })), "Poné un nombre.");
        assert_eq!(err(json!({ "name": 5 })), "El nombre tiene que ser texto.");
        assert!(err(json!({ "name": "x".repeat(81) })).contains("hasta 80"));
        assert!(validar_cambio_de_espacio(&json!({ "name": "x".repeat(80) })).is_ok());
        assert_eq!(err(json!({ "name": "a\nb" })), "El nombre tiene caracteres no válidos.");
        assert_eq!(err(json!({ "name": "a\u{2028}b" })), "El nombre tiene caracteres no válidos.");
    }

    #[test]
    fn campos_que_no_se_pueden_cambiar_y_raices_invalidas() {
        assert_eq!(err(json!({ "cwd": "C:\\" })), "No se puede cambiar «cwd».");
        assert_eq!(err(json!({ "name": "a", "accountId": "x" })), "No se puede cambiar «accountId».");
        for mal in [json!(null), json!([]), json!("x"), json!(3)] {
            assert_eq!(err(mal), "Cambio inválido.");
        }
        assert_eq!(validar_cambio_de_espacio(&json!({})).unwrap(), CambioEspacio::default());
    }

    #[test]
    fn icono_uno_o_dos_emojis_o_quitarlo() {
        assert_eq!(validar_cambio_de_espacio(&json!({ "icon": "🦥" })).unwrap().icon, Some(Some("🦥".into())));
        assert_eq!(validar_cambio_de_espacio(&json!({ "icon": "🦥🔥" })).unwrap().icon, Some(Some("🦥🔥".into())));
        assert_eq!(validar_cambio_de_espacio(&json!({ "icon": "👨‍👩‍👧" })).unwrap().icon, Some(Some("👨‍👩‍👧".into())), "una familia es un solo grafema");
        assert_eq!(validar_cambio_de_espacio(&json!({ "icon": null })).unwrap().icon, Some(None));
        assert_eq!(validar_cambio_de_espacio(&json!({ "icon": "" })).unwrap().icon, Some(None));
        for mal in ["🦥🔥🚀", "a", "<", "🦥&", "\n", "\"", "  "] {
            assert_eq!(err(json!({ "icon": mal })), "El ícono tiene que ser un emoji (uno o dos).", "{mal:?}");
        }
        assert_eq!(err(json!({ "icon": 5 })), "El ícono tiene que ser un emoji.");
    }

    #[test]
    fn nombre_e_icono_a_la_vez() {
        let c = validar_cambio_de_espacio(&json!({ "name": "x", "icon": null })).unwrap();
        assert_eq!((c.name.as_deref(), c.icon), (Some("x"), Some(None)));
    }
}
