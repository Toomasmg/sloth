//! Invitación completa al chat: un texto que trae servidor, clave publicable y código del equipo, así quien entra lo hace
//! en un paso. Equivale a chat-invite.ts.
//!
//! El texto pegado es dato no confiable: se valida entero (mismas reglas que Configuración) y lo único que sale de acá
//! es una config de chat válida, un código con el formato de la base y un nombre limpio.
use super::config::{chequear_anon_key, huella_de_key, normalizar_url_supabase, ChatServerConfig};
use super::mapa::{codepoints, parsear_codigo_invitacion};
use super::tipos::LIMITE_NOMBRE_EQUIPO;
use super::{trim_js, Res};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::{alphabet, Engine};
use serde_json::{json, Value};

pub const INVITE_PREFIX: &str = "sloth-invitacion:v1.";
/// Lo que se acepta pegar entero (el token más un mensaje alrededor).
pub const MAX_INVITE_TEXT: usize = 8000;
/// Largo máximo del token base64url.
pub const MAX_INVITE_TOKEN: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatInvitation {
    pub cfg: ChatServerConfig,
    pub code: String,
    pub team_name: Option<String>,
}

fn utf16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Controles y marcas de dirección: un nombre de equipo no las necesita y sirven para disfrazar texto.
fn caracter_malo_en_nombre(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

fn limpiar_nombre_de_equipo(raw: Option<&Value>) -> Res<Option<String>> {
    let Some(raw) = raw else { return Ok(None) };
    let Some(s) = raw.as_str() else { return Err("La invitación no es válida: el nombre del equipo tiene que ser texto.".into()) };
    let s = trim_js(s);
    if s.is_empty() || codepoints(s) > LIMITE_NOMBRE_EQUIPO || s.chars().any(caracter_malo_en_nombre) {
        return Err("La invitación no es válida: el nombre del equipo no es válido.".into());
    }
    Ok(Some(s.to_string()))
}

/// Arma el texto copiable. Valida todo igual que al leerlo; un nombre de equipo raro se omite.
pub fn armar_invitacion(cfg: &ChatServerConfig, code: &str, team_name: Option<&str>) -> Res<String> {
    let team = team_name.and_then(|t| limpiar_nombre_de_equipo(Some(&Value::from(t))).ok().flatten());
    let mut body = json!({
        "url": normalizar_url_supabase(&Value::from(cfg.supabase_url.as_str()))?,
        "key": chequear_anon_key(&Value::from(cfg.anon_key.as_str()))?,
        "code": parsear_codigo_invitacion(&Value::from(code))?,
    });
    if let Some(t) = team {
        body["team"] = Value::from(t);
    }
    let token = format!("{INVITE_PREFIX}{}", URL_SAFE_NO_PAD.encode(body.to_string()));
    if token.len() - INVITE_PREFIX.len() > MAX_INVITE_TOKEN {
        return Err("La invitación quedó demasiado larga.".into());
    }
    Ok(token)
}

/// ¿El texto parece traer una invitación? Solo mira el prefijo: sirve para ofrecer pegarla.
pub fn parece_invitacion(text: &Value) -> bool {
    text.as_str().is_some_and(|t| utf16(t) <= MAX_INVITE_TEXT && t.contains(INVITE_PREFIX))
}

fn tokens_en(raw: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut resto = raw;
    while let Some(i) = resto.find(INVITE_PREFIX) {
        let despues = &resto[i + INVITE_PREFIX.len()..];
        let fin = despues.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-')).unwrap_or(despues.len());
        out.push(&despues[..fin]);
        resto = &despues[fin..];
    }
    out
}

/// Como `Buffer.from(x, 'base64url')`: sin relleno obligatorio y sin exigir bits finales en cero.
fn decodificar_base64url(token: &str) -> Option<Vec<u8>> {
    let motor = GeneralPurpose::new(
        &alphabet::URL_SAFE,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent).with_decode_allow_trailing_bits(true),
    );
    motor.decode(token).ok()
}

/// Lee una invitación. Acepta el token solo o con texto alrededor (como llega por un chat), pero tiene que haber
/// exactamente uno. Rechaza claves desconocidas, http, la secret key y tamaños grandes.
pub fn parsear_invitacion(raw: &Value) -> Res<ChatInvitation> {
    let Some(raw) = raw.as_str().filter(|s| !trim_js(s).is_empty()) else { return Err("Pegá la invitación completa (empieza con sloth-invitacion:).".into()) };
    if utf16(raw) > MAX_INVITE_TEXT {
        return Err("Ese texto es demasiado largo para ser una invitación.".into());
    }
    let found = tokens_en(raw);
    if found.is_empty() {
        return Err("Eso no es una invitación de Sloth. Tiene que empezar con sloth-invitacion:v1.".into());
    }
    if found.len() > 1 {
        return Err("Hay más de una invitación en el texto. Pegá una sola.".into());
    }
    let token = found[0];
    if token.is_empty() {
        return Err("La invitación está incompleta. Pedí que te la copien de nuevo.".into());
    }
    if token.len() > MAX_INVITE_TOKEN {
        return Err("La invitación es demasiado larga.".into());
    }
    let danada = || "La invitación está dañada o incompleta. Pedí que te la copien de nuevo.".to_string();
    let bytes = decodificar_base64url(token).ok_or_else(danada)?;
    let data: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes)).map_err(|_| danada())?;
    let Some(o) = data.as_object() else { return Err(danada()) };
    if o.keys().any(|k| !matches!(k.as_str(), "url" | "key" | "code" | "team")) {
        return Err("La invitación trae datos que Sloth no conoce. ¿Es de una versión más nueva?".into());
    }
    let nulo = Value::Null;
    let supabase_url = normalizar_url_supabase(o.get("url").unwrap_or(&nulo)).map_err(|e| format!("La invitación no es válida: {e}"))?;
    let anon_key = chequear_anon_key(o.get("key").unwrap_or(&nulo)).map_err(|e| format!("Invitación rechazada. {e}"))?;
    let code = parsear_codigo_invitacion(o.get("code").unwrap_or(&nulo))
        .map_err(|_| "La invitación no es válida: el código del equipo no tiene el formato correcto.".to_string())?;
    let team_name = limpiar_nombre_de_equipo(o.get("team"))?;
    Ok(ChatInvitation { cfg: ChatServerConfig { supabase_url, anon_key }, code, team_name })
}

/// Qué hacer con una invitación válida según el estado actual:
/// - `ConfirmarNueva`: no hay chat configurado → mostrar el host y pedir confirmación.
/// - `ConfirmarReemplazo`: hay otra config → avisar y pedir confirmación explícita antes de reemplazarla.
/// - `IniciarSesion`: misma config sin sesión → iniciar sesión y canjear después.
/// - `Canjear`: misma config con sesión → canjear directo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecisionInvitacion {
    ConfirmarNueva,
    ConfirmarReemplazo,
    IniciarSesion,
    Canjear,
}

impl DecisionInvitacion {
    /// El nombre que usa la UI.
    pub fn como_str(self) -> &'static str {
        match self {
            DecisionInvitacion::ConfirmarNueva => "confirmNew",
            DecisionInvitacion::ConfirmarReemplazo => "confirmReplace",
            DecisionInvitacion::IniciarSesion => "signIn",
            DecisionInvitacion::Canjear => "redeem",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigActiva {
    pub supabase_url: String,
    pub key_hash: String,
}

pub struct EstadoActual {
    /// La config activa (su URL y la huella de la key), si hay.
    pub active: Option<ConfigActiva>,
    pub signed_in: bool,
}

pub fn mismo_servidor(cfg: &ChatServerConfig, active: &ConfigActiva) -> bool {
    cfg.supabase_url == active.supabase_url && huella_de_key(&cfg.anon_key) == active.key_hash
}

pub fn decidir_invitacion(inv: &ChatInvitation, cur: &EstadoActual) -> DecisionInvitacion {
    let Some(active) = &cur.active else { return DecisionInvitacion::ConfirmarNueva };
    if !mismo_servidor(&inv.cfg, active) {
        return DecisionInvitacion::ConfirmarReemplazo;
    }
    if cur.signed_in {
        DecisionInvitacion::Canjear
    } else {
        DecisionInvitacion::IniciarSesion
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL_OK: &str = "https://abcd.supabase.co";
    const KEY: &str = "sb_publishable_abcdefgh12345";
    const CODE: &str = "0123456789abcdef";

    fn cfg() -> ChatServerConfig {
        ChatServerConfig { supabase_url: URL_OK.into(), anon_key: KEY.into() }
    }

    fn token_de(obj: Value) -> String {
        format!("{INVITE_PREFIX}{}", URL_SAFE_NO_PAD.encode(obj.to_string()))
    }

    fn jwt(payload: Value) -> String {
        format!("eyJhbGciOiJIUzI1NiJ9.{}.firma", URL_SAFE_NO_PAD.encode(payload.to_string()))
    }

    fn parsear(s: &str) -> Res<ChatInvitation> {
        parsear_invitacion(&Value::from(s))
    }

    #[test]
    fn ida_y_vuelta_con_y_sin_nombre_de_equipo() {
        let t = armar_invitacion(&cfg(), CODE, Some("Equipo Ñandú")).unwrap();
        assert!(t.starts_with(INVITE_PREFIX));
        assert_eq!(parsear(&t).unwrap(), ChatInvitation { cfg: cfg(), code: CODE.into(), team_name: Some("Equipo Ñandú".into()) });
        assert_eq!(parsear(&armar_invitacion(&cfg(), CODE, None).unwrap()).unwrap(), ChatInvitation { cfg: cfg(), code: CODE.into(), team_name: None });
    }

    #[test]
    fn el_cuerpo_va_con_las_claves_en_orden_url_key_code_team() {
        let t = armar_invitacion(&cfg(), CODE, Some("Eq")).unwrap();
        let json = String::from_utf8(URL_SAFE_NO_PAD.decode(&t[INVITE_PREFIX.len()..]).unwrap()).unwrap();
        assert_eq!(json, format!(r#"{{"url":"{URL_OK}","key":"{KEY}","code":"{CODE}","team":"Eq"}}"#));
    }

    #[test]
    fn acepta_el_token_con_texto_alrededor_como_llega_por_un_chat() {
        let t = armar_invitacion(&cfg(), CODE, None).unwrap();
        assert_eq!(parsear(&format!("Sumate al chat:\n  {t}  \n¡Nos vemos!")).unwrap().code, CODE);
    }

    #[test]
    fn un_nombre_de_equipo_raro_no_entra_en_la_invitacion() {
        assert_eq!(parsear(&armar_invitacion(&cfg(), CODE, Some("a\u{202e}b")).unwrap()).unwrap().team_name, None);
        assert_eq!(parsear(&armar_invitacion(&cfg(), CODE, Some(&"x".repeat(61))).unwrap()).unwrap().team_name, None);
    }

    #[test]
    fn rechaza_la_secret_key_y_la_service_role_con_su_mensaje() {
        for key in ["sb_secret_abcdefgh12345".to_string(), jwt(json!({"role": "service_role"}))] {
            assert!(parsear(&token_de(json!({"url": URL_OK, "key": key, "code": CODE}))).unwrap_err().contains("service_role / secret key"));
            let c = ChatServerConfig { supabase_url: URL_OK.into(), anon_key: key };
            assert!(armar_invitacion(&c, CODE, None).unwrap_err().contains("service_role"));
        }
    }

    #[test]
    fn acepta_una_anon_key_jwt() {
        let key = jwt(json!({"role": "anon"}));
        assert_eq!(parsear(&token_de(json!({"url": URL_OK, "key": key, "code": CODE}))).unwrap().cfg.anon_key, key);
    }

    #[test]
    fn rechaza_url_http_con_ruta_o_con_usuario() {
        for url in ["http://abcd.supabase.co", "https://abcd.supabase.co/rest", "https://u:p@abcd.supabase.co", "javascript:alert(1)"] {
            assert!(parsear(&token_de(json!({"url": url, "key": KEY, "code": CODE}))).unwrap_err().contains("La invitación no es válida"), "{url}");
        }
    }

    #[test]
    fn rechaza_claves_desconocidas_faltantes_o_con_tipo_equivocado() {
        assert!(parsear(&token_de(json!({"url": URL_OK, "key": KEY, "code": CODE, "cmd": "rm -rf"}))).unwrap_err().contains("no conoce"));
        assert!(parsear(&token_de(json!({"url": URL_OK, "key": KEY}))).unwrap_err().contains("código"));
        assert!(parsear(&token_de(json!({"url": URL_OK, "key": KEY, "code": "ABC"}))).unwrap_err().contains("código"));
        assert!(parsear(&token_de(json!({"url": URL_OK, "key": KEY, "code": CODE, "team": 5}))).unwrap_err().contains("nombre del equipo"));
        assert!(parsear(&token_de(json!([URL_OK, KEY, CODE]))).unwrap_err().contains("dañada"));
    }

    #[test]
    fn rechaza_json_roto_base64_invalido_y_texto_que_no_es_invitacion() {
        assert!(parsear(&format!("{INVITE_PREFIX}{}", URL_SAFE_NO_PAD.encode(r#"{"url":"#))).unwrap_err().contains("dañada"));
        assert!(parsear(INVITE_PREFIX).unwrap_err().contains("incompleta"));
        assert!(parsear("hola").unwrap_err().contains("no es una invitación"));
        assert!(parsear("").unwrap_err().contains("Pegá"));
        assert!(parsear_invitacion(&json!(42)).unwrap_err().contains("Pegá"));
        let t = armar_invitacion(&cfg(), CODE, None).unwrap();
        assert!(parsear(&format!("{t} {t}")).unwrap_err().contains("más de una"));
    }

    #[test]
    fn rechaza_tamanos_grandes() {
        assert!(parsear(&"x".repeat(MAX_INVITE_TEXT + 1)).unwrap_err().contains("demasiado largo"));
        assert!(parsear(&format!("{INVITE_PREFIX}{}", "A".repeat(5000))).unwrap_err().contains("demasiado larga"));
        assert!(!parece_invitacion(&Value::from(format!("{}{INVITE_PREFIX}", "x".repeat(MAX_INVITE_TEXT + 1)))));
        assert!(parece_invitacion(&Value::from(format!("hola {INVITE_PREFIX}abc"))));
        assert!(!parece_invitacion(&Value::Null));
    }

    #[test]
    fn decision_sin_config_misma_config_config_distinta_con_sesion() {
        let inv = parsear(&armar_invitacion(&cfg(), CODE, None).unwrap()).unwrap();
        let igual = ConfigActiva { supabase_url: URL_OK.into(), key_hash: huella_de_key(KEY) };
        let estado = |active: Option<ConfigActiva>, signed_in| EstadoActual { active, signed_in };
        assert_eq!(decidir_invitacion(&inv, &estado(None, false)), DecisionInvitacion::ConfirmarNueva);
        assert_eq!(decidir_invitacion(&inv, &estado(Some(igual.clone()), false)), DecisionInvitacion::IniciarSesion);
        assert_eq!(decidir_invitacion(&inv, &estado(Some(igual.clone()), true)), DecisionInvitacion::Canjear);
        let otra_url = ConfigActiva { supabase_url: "https://otro.supabase.co".into(), key_hash: igual.key_hash.clone() };
        assert_eq!(decidir_invitacion(&inv, &estado(Some(otra_url), true)), DecisionInvitacion::ConfirmarReemplazo);
        let otra_key = ConfigActiva { supabase_url: URL_OK.into(), key_hash: huella_de_key("sb_publishable_otraotra99") };
        assert_eq!(decidir_invitacion(&inv, &estado(Some(otra_key), true)), DecisionInvitacion::ConfirmarReemplazo);
        assert_eq!(DecisionInvitacion::ConfirmarReemplazo.como_str(), "confirmReplace");
    }
}
