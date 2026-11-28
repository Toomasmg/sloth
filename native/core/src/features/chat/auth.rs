//! Login con GitHub por Supabase Auth (PKCE): lo puro del servidor loopback del callback. Equivale a la parte sin red
//! de chat-auth.ts. El servidor HTTP, el canje de `code` y el navegador son del cliente de Supabase y del shell, que
//! entran por el trait de contexto del módulo `principal`; acá quedan las reglas: página de respuesta, formato del
//! `code`, resultado de cada callback y topes.
use serde_json::Value;

pub const HOST: &str = "127.0.0.1";
pub const LOGIN_TIMEOUT_MS: i64 = 5 * 60 * 1000;
pub const MAX_CANJES: u32 = 8;
pub const MAX_EN_COLA: usize = 4;

pub const GITHUB_DESHABILITADO: &str = "El login con GitHub no está habilitado en el Supabase del equipo. Quien administra ese proyecto tiene que activarlo en Authentication → Sign In / Providers → GitHub (con una OAuth App de GitHub) y sumar http://127.0.0.1:53682/auth/callback a las Redirect URLs.";

/// Lee `external.github` de GET /auth/v1/settings; `None` si la respuesta no tiene esa forma.
pub fn github_en_settings(settings: &Value) -> Option<bool> {
    settings.get("external")?.as_object()?.get("github")?.as_bool()
}

/// `^[A-Za-z0-9._~-]{1,512}$`
pub fn codigo_valido(code: &str) -> bool {
    (1..=512).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'-'))
}

fn escapar(s: &str) -> String {
    s.chars().map(|c| if matches!(c, '&' | '<' | '>' | '"' | '\'') { format!("&#{};", c as u32) } else { c.to_string() }).collect()
}

const PAGE_CSS: &str = "
:root{color-scheme:dark;--bg:#0c0e13;--card:#15171d;--line:#262932;--text:#ecedf0;--text-2:#a3a7b3;--ok:#3fbf7f;--ok-soft:rgba(63,191,127,.14);--bad:#f07178;--bad-soft:rgba(240,113,120,.14)}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f6f6f4;--card:#fff;--line:#e2e3e7;--text:#16181d;--text-2:#545966;--ok:#16794a;--ok-soft:rgba(22,121,74,.1);--bad:#b4232c;--bad-soft:rgba(180,35,44,.1)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font:15px/1.5 \"Segoe UI Variable\",\"Segoe UI\",system-ui,sans-serif}
main{width:100%;max-width:420px;padding:32px;border:1px solid var(--line);border-radius:10px;background:var(--card);text-align:center;box-shadow:0 16px 40px rgba(0,0,0,.18)}
.brand{margin:0 0 24px;font-size:13px;font-weight:600;letter-spacing:.02em;color:var(--text-2)}
.icon{width:56px;height:56px;margin:0 auto 16px;display:grid;place-items:center;border-radius:50%}
.ok .icon{background:var(--ok-soft);color:var(--ok)}
.bad .icon{background:var(--bad-soft);color:var(--bad)}
h1{margin:0 0 8px;font-size:24px;line-height:1.25;font-weight:650}
p{margin:0;color:var(--text-2)}
.hint{margin-top:16px;padding-top:16px;border-top:1px solid var(--line);font-size:13px}
";
const ICON_OK: &str = "<svg width=\"28\" height=\"28\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M5 12.5l4.5 4.5L19 7.5\"/></svg>";
const ICON_BAD: &str = "<svg width=\"28\" height=\"28\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" aria-hidden=\"true\"><path d=\"M12 7v6M12 17h.01\"/></svg>";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tono {
    Ok,
    Malo,
}

/// Página que ve el navegador al volver del login: sin scripts, con tema claro u oscuro según el sistema.
pub fn pagina(titulo: &str, texto: &str, tono: Tono) -> String {
    let (clase, icono, pista) = match tono {
        Tono::Ok => ("ok", ICON_OK, "Ya podés cerrar esta pestaña y volver a Sloth."),
        Tono::Malo => ("bad", ICON_BAD, "Cerrá esta pestaña y volvé a intentarlo desde Sloth."),
    };
    format!(
        "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{} · Sloth</title><style>{PAGE_CSS}</style></head><body><main class=\"{clase}\" aria-labelledby=\"t\"><p class=\"brand\">Sloth</p><div class=\"icon\">{icono}</div><h1 id=\"t\">{}</h1><p>{}</p><p class=\"hint\">{pista}</p></main></body></html>",
        escapar(titulo),
        escapar(titulo),
        escapar(texto)
    )
}

/// Cabeceras de toda respuesta del callback.
pub const CABECERAS: [(&str, &str); 6] = [
    ("Content-Type", "text/html; charset=utf-8"),
    ("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'"),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
    ("Cache-Control", "no-store"),
    ("Connection", "close"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResultadoCallback {
    Ok,
    Cancelado,
    VencioElTiempo { ultimo_error: Option<String> },
    Demasiados,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResultadoLogin {
    Ok,
    Cancelado,
    Fallo(String),
}

/// Lo que ve la persona según cómo terminó el callback.
pub fn resultado_de_login(o: &ResultadoCallback) -> ResultadoLogin {
    match o {
        ResultadoCallback::Cancelado => ResultadoLogin::Cancelado,
        ResultadoCallback::Demasiados => ResultadoLogin::Fallo("Llegaron demasiados códigos que no sirvieron. Probá iniciar sesión de nuevo.".into()),
        ResultadoCallback::VencioElTiempo { ultimo_error } => ResultadoLogin::Fallo(format!(
            "Se venció el tiempo del login (5 minutos).{} Probá de nuevo.",
            ultimo_error.as_ref().map(|e| format!(" {e}")).unwrap_or_default()
        )),
        ResultadoCallback::Ok => ResultadoLogin::Ok,
    }
}

/// Qué responde el servidor a un GET: (estado, título, texto, tono). `canje` es `Some(true/false)` si el `code` se canjeó.
pub fn respuesta_de_callback(canje: Option<bool>, error_del_proveedor: Option<&str>, hay_codigo: bool) -> (u16, String, String, Tono) {
    match canje {
        Some(true) => (200, "Listo, ya iniciaste sesión".into(), "Tu cuenta de GitHub quedó conectada al chat del equipo.".into(), Tono::Ok),
        Some(false) => (400, "No se pudo completar".into(), "El código no sirvió. Probá iniciar sesión de nuevo desde Sloth.".into(), Tono::Malo),
        None => match error_del_proveedor {
            Some(e) if !hay_codigo => (400, "No se pudo iniciar sesión".into(), e.chars().take(200).collect(), Tono::Malo),
            _ => (400, "Falta el código".into(), "Probá iniciar sesión de nuevo desde Sloth.".into(), Tono::Malo),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn github_en_settings_lee_external_github() {
        assert_eq!(github_en_settings(&json!({"external": {"github": true, "email": true}})), Some(true));
        assert_eq!(github_en_settings(&json!({"external": {"github": false, "email": true}})), Some(false));
        assert_eq!(github_en_settings(&json!({"external": {"email": true}})), None);
        assert_eq!(github_en_settings(&json!({"external": "x"})), None);
        assert_eq!(github_en_settings(&json!(null)), None);
    }

    #[test]
    fn la_pagina_de_exito_muestra_el_icono_de_ok_y_como_seguir() {
        let html = pagina("Listo, ya iniciaste sesión", "Tu cuenta quedó conectada.", Tono::Ok);
        assert!(html.contains("<main class=\"ok\""));
        assert!(html.contains("Ya podés cerrar esta pestaña"));
        assert!(html.contains("prefers-color-scheme:light"));
    }

    #[test]
    fn la_pagina_de_error_escapa_el_texto_del_proveedor_y_no_tiene_scripts() {
        let html = pagina("No se pudo iniciar sesión", "<script>alert(1)</script>", Tono::Malo);
        assert!(html.contains("<main class=\"bad\""));
        assert!(!html.contains("<script"));
        assert!(html.contains("&#60;script&#62;"));
        assert!(html.contains("Cerrá esta pestaña y volvé a intentarlo desde Sloth."));
    }

    #[test]
    fn el_codigo_del_callback_tiene_forma_de_codigo() {
        assert!(codigo_valido("abc.DEF_1~2-3"));
        for malo in ["", "a b", "a/b", "a?b", &"x".repeat(513)] {
            assert!(!codigo_valido(malo), "{malo}");
        }
    }

    #[test]
    fn un_error_o_un_canje_que_falla_no_cortan_el_login_uno_que_funciona_si() {
        assert_eq!(respuesta_de_callback(None, Some("x"), false).0, 400);
        assert_eq!(respuesta_de_callback(Some(false), None, true).0, 400);
        let (estado, _, _, tono) = respuesta_de_callback(Some(true), None, true);
        assert_eq!((estado, tono), (200, Tono::Ok));
        assert_eq!(respuesta_de_callback(None, None, false).1, "Falta el código");
        assert_eq!(respuesta_de_callback(None, Some(&"e".repeat(300)), false).2.len(), 200);
    }

    #[test]
    fn al_vencer_el_tiempo_informa_el_ultimo_error() {
        let r = resultado_de_login(&ResultadoCallback::VencioElTiempo { ultimo_error: Some("No se pudo completar el login. Probá de nuevo.".into()) });
        assert!(matches!(&r, ResultadoLogin::Fallo(m) if m.contains("No se pudo completar") && m.starts_with("Se venció el tiempo del login (5 minutos).")));
        assert_eq!(resultado_de_login(&ResultadoCallback::Cancelado), ResultadoLogin::Cancelado);
        assert_eq!(resultado_de_login(&ResultadoCallback::Ok), ResultadoLogin::Ok);
        assert!(matches!(resultado_de_login(&ResultadoCallback::Demasiados), ResultadoLogin::Fallo(m) if m.contains("demasiados códigos")));
    }
}
