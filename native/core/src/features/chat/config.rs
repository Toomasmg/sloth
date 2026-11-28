//! Configuración del chat (Supabase propio del equipo): validación de la URL y de la key. Equivale a chat-config.ts.
//!
//! Regla de seguridad: Sloth solo acepta la anon / publishable key. La service_role / secret key da acceso total a la
//! base y NUNCA puede entrar a la app: se rechaza con un mensaje claro y sin repetir el valor de la key en ningún error.
use super::{trim_js, Res};
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::{alphabet, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatServerConfig {
    /// Origen normalizado: https://<ref>.supabase.co
    pub supabase_url: String,
    /// Anon / publishable key. Es pública por diseño; la protege la RLS.
    pub anon_key: String,
}

const MAX_KEY_LENGTH: usize = 2048;
const MAX_URL_LENGTH: usize = 300;

pub const SECRET_MSG: &str =
    "Esa es una service_role / secret key. Nunca va en Sloth ni en .sloth/team.json: da acceso total a la base. Usá la anon / publishable key (Project Settings → API).";

fn utf16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Valida y normaliza la URL del proyecto. Solo https, sin usuario, sin query, sin hash, sin ruta.
pub fn normalizar_url_supabase(raw: &Value) -> Res<String> {
    let Some(raw) = raw.as_str() else { return Err("La URL de Supabase tiene que ser texto.".into()) };
    let s = trim_js(raw);
    if s.is_empty() || utf16(s) > MAX_URL_LENGTH {
        return Err("La URL de Supabase no es válida.".into());
    }
    let u = Url::parse(s).map_err(|_| "La URL de Supabase no es válida. Tiene que ser https://<ref>.supabase.co.".to_string())?;
    if u.scheme() != "https" {
        return Err("La URL de Supabase tiene que empezar con https://.".into());
    }
    if !u.username().is_empty() || u.password().is_some_and(|p| !p.is_empty()) {
        return Err("La URL de Supabase no puede llevar usuario ni contraseña.".into());
    }
    if u.query().is_some_and(|q| !q.is_empty()) || u.fragment().is_some_and(|f| !f.is_empty()) {
        return Err("La URL de Supabase no puede tener ? ni # al final.".into());
    }
    if u.path() != "/" && !u.path().is_empty() {
        return Err("La URL de Supabase no puede tener ruta: va solo la URL del proyecto.".into());
    }
    if u.host_str().is_none_or(str::is_empty) {
        return Err("La URL de Supabase no tiene dominio.".into());
    }
    Ok(u.origin().ascii_serialization())
}

fn parte_jwt(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn payload_jwt(parte: &str) -> Option<serde_json::Map<String, Value>> {
    // Como Buffer.from(x, 'base64url'): sin relleno obligatorio y sin exigir bits finales en cero.
    let motor = GeneralPurpose::new(
        &alphabet::URL_SAFE,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent).with_decode_allow_trailing_bits(true),
    );
    let bytes = motor.decode(parte).ok()?;
    match serde_json::from_slice::<Value>(&bytes).ok()? {
        Value::Object(o) => Some(o),
        _ => None,
    }
}

fn es_publishable(k: &str) -> bool {
    k.strip_prefix("sb_publishable_").is_some_and(|r| r.len() >= 8 && r.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
}

/// Acepta solo una anon key: un JWT con role «anon», o una «sb_publishable_…». Rechaza service_role, «sb_secret_…» y
/// cualquier otra cosa. No verifica la firma: lo que importa es que no sea la de servicio.
pub fn chequear_anon_key(raw: &Value) -> Res<String> {
    let Some(raw) = raw.as_str() else { return Err("La anon key tiene que ser texto.".into()) };
    let k = trim_js(raw);
    if k.is_empty() {
        return Err("Falta la anon key.".into());
    }
    if utf16(k) > MAX_KEY_LENGTH {
        return Err("La key es demasiado larga.".into());
    }
    if k.starts_with("sb_secret_") {
        return Err(SECRET_MSG.into());
    }
    if k.starts_with("sb_publishable_") {
        return if es_publishable(k) { Ok(k.to_string()) } else { Err("La publishable key no tiene un formato válido.".into()) };
    }
    let partes: Vec<&str> = k.split('.').collect();
    if partes.len() == 3 && partes.iter().all(|p| parte_jwt(p)) {
        let rol = payload_jwt(partes[1]).and_then(|p| p.get("role").cloned());
        return match rol.as_ref().and_then(Value::as_str) {
            Some("service_role") => Err(SECRET_MSG.into()),
            Some("anon") => Ok(k.to_string()),
            _ => Err("Esa key no es una anon key (el rol del JWT no es «anon»).".into()),
        };
    }
    Err("No reconozco esa key. Usá la anon / publishable key del proyecto (empieza con eyJ… o sb_publishable_…).".into())
}

/// Valida {supabaseUrl, anonKey} (de Configuración o de .sloth/team.json). Las claves que empiezan con «_» o «$» son
/// comentarios y se ignoran; cualquier otra clave desconocida es un error.
pub fn parsear_config_servidor(raw: &Value) -> Res<ChatServerConfig> {
    let Some(o) = raw.as_object() else { return Err("La configuración del chat tiene que ser un objeto con supabaseUrl y anonKey.".into()) };
    for k in o.keys() {
        if k.starts_with('_') || k.starts_with('$') {
            continue;
        }
        if k != "supabaseUrl" && k != "anonKey" {
            return Err(format!("En el chat no conozco la clave «{k}»."));
        }
    }
    let nulo = Value::Null;
    Ok(ChatServerConfig {
        supabase_url: normalizar_url_supabase(o.get("supabaseUrl").unwrap_or(&nulo))?,
        anon_key: chequear_anon_key(o.get("anonKey").unwrap_or(&nulo))?,
    })
}

/// Lo que se muestra de la key: primeros 6 y últimos 4 caracteres.
pub fn vista_previa_de_key(key: &str) -> String {
    let c: Vec<char> = key.chars().collect();
    if utf16(key) < 14 {
        return "…".into();
    }
    format!("{}…{}", c[..6].iter().collect::<String>(), c[c.len() - 4..].iter().collect::<String>())
}

/// Huella de la key (sha256). Sirve para recordar qué se aceptó sin guardar la key aparte.
pub fn huella_de_key(key: &str) -> String {
    hex::encode(Sha256::digest(key.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use serde_json::json;

    fn jwt(payload: Value) -> String {
        format!("eyJhbGciOiJIUzI1NiJ9.{}.firma", URL_SAFE_NO_PAD.encode(payload.to_string()))
    }

    #[test]
    fn la_url_se_normaliza_al_origen() {
        assert_eq!(normalizar_url_supabase(&json!("  https://abcd.supabase.co/  ")).unwrap(), "https://abcd.supabase.co");
        assert_eq!(normalizar_url_supabase(&json!("https://ABCD.supabase.co:443")).unwrap(), "https://abcd.supabase.co");
        assert_eq!(normalizar_url_supabase(&json!("https://chat.propio.com:8443")).unwrap(), "https://chat.propio.com:8443");
    }

    #[test]
    fn la_url_rechaza_lo_que_no_es_solo_el_proyecto() {
        let casos = [
            ("http://abcd.supabase.co", "tiene que empezar con https"),
            ("https://u:p@abcd.supabase.co", "usuario ni contraseña"),
            ("https://abcd.supabase.co/rest", "no puede tener ruta"),
            ("https://abcd.supabase.co?x=1", "? ni #"),
            ("https://abcd.supabase.co/#x", "? ni #"),
            ("javascript:alert(1)", "tiene que empezar con https"),
            ("no es url", "no es válida"),
            ("", "no es válida"),
        ];
        for (url, texto) in casos {
            let e = normalizar_url_supabase(&json!(url)).unwrap_err();
            assert!(e.contains(texto), "{url}: {e}");
        }
        assert_eq!(normalizar_url_supabase(&json!(5)), Err("La URL de Supabase tiene que ser texto.".into()));
        assert!(normalizar_url_supabase(&json!(format!("https://{}.supabase.co", "a".repeat(300)))).is_err());
    }

    #[test]
    fn acepta_publishable_y_jwt_anon() {
        assert_eq!(chequear_anon_key(&json!(" sb_publishable_abcdefgh12345 ")).unwrap(), "sb_publishable_abcdefgh12345");
        let k = jwt(json!({"role": "anon"}));
        assert_eq!(chequear_anon_key(&json!(k)).unwrap(), k);
    }

    #[test]
    fn rechaza_la_service_role_sin_repetir_la_key() {
        for k in ["sb_secret_abcdefgh12345".to_string(), jwt(json!({"role": "service_role"}))] {
            assert_eq!(chequear_anon_key(&json!(k)), Err(SECRET_MSG.into()));
        }
    }

    #[test]
    fn rechaza_lo_que_no_es_una_anon_key() {
        assert!(chequear_anon_key(&json!("sb_publishable_corta")).unwrap_err().contains("formato válido"));
        assert!(chequear_anon_key(&json!(jwt(json!({"role": "authenticated"})))).unwrap_err().contains("no es una anon key"));
        assert!(chequear_anon_key(&json!("a.b.c")).unwrap_err().contains("no es una anon key"));
        assert!(chequear_anon_key(&json!("cualquier cosa")).unwrap_err().contains("No reconozco"));
        assert_eq!(chequear_anon_key(&json!("  ")), Err("Falta la anon key.".into()));
        assert_eq!(chequear_anon_key(&json!(3)), Err("La anon key tiene que ser texto.".into()));
        assert_eq!(chequear_anon_key(&json!("x".repeat(2049))), Err("La key es demasiado larga.".into()));
    }

    #[test]
    fn la_config_ignora_comentarios_y_rechaza_claves_desconocidas() {
        let ok = parsear_config_servidor(&json!({"_nota": "x", "$schema": "y", "supabaseUrl": "https://abcd.supabase.co/", "anonKey": "sb_publishable_abcdefgh12345"})).unwrap();
        assert_eq!(ok, ChatServerConfig { supabase_url: "https://abcd.supabase.co".into(), anon_key: "sb_publishable_abcdefgh12345".into() });
        assert_eq!(
            parsear_config_servidor(&json!({"supabaseUrl": "https://abcd.supabase.co", "anonKey": "sb_publishable_abcdefgh12345", "otra": 1})),
            Err("En el chat no conozco la clave «otra».".into())
        );
        assert!(parsear_config_servidor(&json!([])).is_err());
        assert!(parsear_config_servidor(&json!({})).is_err());
    }

    #[test]
    fn vista_previa_y_huella() {
        assert_eq!(vista_previa_de_key("sb_publishable_abcdefgh12345"), "sb_pub…2345");
        assert_eq!(vista_previa_de_key("corta"), "…");
        assert_eq!(huella_de_key("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
