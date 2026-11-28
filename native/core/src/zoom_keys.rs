//! Atajos de zoom de la ventana. Equivale a src/main/zoom-keys.ts.

pub struct TeclaZoom<'a> {
    pub tipo: &'a str,
    pub key: &'a str,
    pub code: &'a str,
    pub control: bool,
    pub alt: bool,
    pub meta: bool,
}

pub const ZOOM_STEP: f64 = 0.5;
pub const ZOOM_LIMIT: f64 = 3.0;

/// Nivel de zoom que corresponde a una tecla, o `None` si no es un atajo de zoom.
/// El menú por defecto de Electron solo toma Ctrl+Shift+= (teclado en inglés): con el «+» propio del
/// teclado en español, o el del numérico, no agrandaba.
pub fn zoom_para(t: &TeclaZoom, actual: f64) -> Option<f64> {
    if t.tipo != "keyDown" || !t.control || t.alt || t.meta {
        return None;
    }
    if t.key == "0" || t.code == "Numpad0" {
        return Some(0.0);
    }
    let dir = if t.key == "+" || t.key == "=" || t.code == "NumpadAdd" {
        1.0
    } else if t.key == "-" || t.code == "NumpadSubtract" {
        -1.0
    } else {
        return None;
    };
    Some((actual + dir * ZOOM_STEP).clamp(-ZOOM_LIMIT, ZOOM_LIMIT))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k<'a>(key: &'a str, code: &'a str) -> TeclaZoom<'a> {
        TeclaZoom { tipo: "keyDown", key, code, control: true, alt: false, meta: false }
    }

    #[test]
    fn ctrl_mas_agranda_con_el_espanol_el_ingles_y_el_numerico() {
        assert_eq!(zoom_para(&k("+", ""), 0.0), Some(0.5));
        assert_eq!(zoom_para(&k("=", ""), 0.0), Some(0.5));
        assert_eq!(zoom_para(&k("+", "NumpadAdd"), 1.0), Some(1.5));
    }

    #[test]
    fn ctrl_menos_achica_y_ctrl_cero_vuelve_al_100() {
        assert_eq!(zoom_para(&k("-", ""), 0.0), Some(-0.5));
        assert_eq!(zoom_para(&k("-", "NumpadSubtract"), 0.0), Some(-0.5));
        assert_eq!(zoom_para(&k("0", ""), 2.0), Some(0.0));
    }

    #[test]
    fn el_zoom_no_pasa_de_los_topes() {
        assert_eq!(zoom_para(&k("+", ""), 3.0), Some(3.0));
        assert_eq!(zoom_para(&k("-", ""), -3.0), Some(-3.0));
    }

    #[test]
    fn sin_ctrl_con_alt_al_soltar_o_con_otra_tecla_no_hace_nada() {
        assert_eq!(zoom_para(&TeclaZoom { control: false, ..k("+", "") }, 0.0), None);
        assert_eq!(zoom_para(&TeclaZoom { alt: true, ..k("+", "") }, 0.0), None);
        assert_eq!(zoom_para(&TeclaZoom { meta: true, ..k("+", "") }, 0.0), None);
        assert_eq!(zoom_para(&TeclaZoom { tipo: "keyUp", ..k("+", "") }, 0.0), None);
        assert_eq!(zoom_para(&k("a", ""), 0.0), None);
    }
}
