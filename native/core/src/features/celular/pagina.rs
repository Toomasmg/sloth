//! La página del celu: HTML, CSS y JS sin dependencias, servidos por la PC. Son archivos estáticos en `pagina/`,
//! idénticos byte a byte a lo que armaba `celular-pagina.ts` (`generar-fixtures.mjs --assets` los extrae y los tests
//! comparan la huella con la del TypeScript). Acostado es el visor; parado, la lista completa. Todo lo que viene de la PC
//! se pone con `textContent`: los nombres de los espacios son datos del usuario.
use serde_json::json;
use std::sync::LazyLock;

pub const PAGINA_HTML: &str = include_str!("pagina/index.html");
pub const PAGINA_CSS: &str = include_str!("pagina/app.css");
/// El sello (AES, HMAC y base64url en JS puro: la página es http y no tiene `crypto.subtle`).
pub const SELLO_JS: &str = include_str!("pagina/sello.js");
const APP_JS: &str = include_str!("pagina/app.js");

/// `SELLO_JS + '\n' + app`.
pub static PAGINA_JS: LazyLock<String> = LazyLock::new(|| format!("{SELLO_JS}\n{APP_JS}"));

/// Lo que pide el navegador para instalarla como app (por HTTPS).
pub fn manifiesto() -> String {
    json!({
        "name": "Sloth",
        "short_name": "Sloth",
        "description": "Cómo van tus sesiones de Claude, desde el celu.",
        "start_url": "/",
        "scope": "/",
        "display": "fullscreen",
        "orientation": "any",
        "background_color": "#08090B",
        "theme_color": "#08090B",
        "icons": [
            { "src": "/icono.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
            { "src": "/icono-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
            { "src": "/icono-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
        ]
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use sha2::{Digest, Sha256};

    fn fixtures() -> Value {
        serde_json::from_str(include_str!("fixtures/ts.json")).unwrap()
    }

    fn comparar(nombre: &str, contenido: &str) {
        let h = &fixtures()["pagina"][nombre];
        assert_eq!(hex::encode(Sha256::digest(contenido.as_bytes())), h["sha256"].as_str().unwrap(), "{nombre}: la huella no es la del TypeScript");
        assert_eq!(contenido.len() as u64, h["utf8"].as_u64().unwrap(), "{nombre}: el largo");
    }

    #[test]
    fn el_html_el_css_y_el_js_son_identicos_byte_a_byte_a_los_del_typescript() {
        comparar("html", PAGINA_HTML);
        comparar("css", PAGINA_CSS);
        comparar("sello_js", SELLO_JS);
        comparar("js", &PAGINA_JS);
    }

    #[test]
    fn el_manifiesto_es_el_mismo_json_que_el_del_typescript() {
        assert_eq!(manifiesto(), fixtures()["pagina"]["manifiesto"].as_str().unwrap());
    }

    #[test]
    fn la_pagina_no_pide_nada_de_afuera_ni_lleva_claves() {
        assert!(!PAGINA_HTML.contains("href=\"http"));
        assert!(!PAGINA_HTML.contains("src=\"http"));
        assert!(PAGINA_JS.contains("slothSello"));
        assert!(PAGINA_JS.starts_with("(function () {"));
    }

    #[test]
    fn los_archivos_no_perdieron_los_saltos_de_linea_en_el_checkout() {
        for (n, t) in [("html", PAGINA_HTML), ("css", PAGINA_CSS), ("sello.js", SELLO_JS), ("app.js", APP_JS)] {
            assert!(!t.contains('\r'), "{n} tiene CRLF: el .gitattributes de esta carpeta tiene que dejarlos como están");
        }
    }
}
