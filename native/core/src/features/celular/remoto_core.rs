//! «Celular desde cualquier red»: el contrato (`src/shared/celu-remoto.ts`) y el ritmo de publicación
//! (`celular-remoto-core.ts`). La PC y la página del celu hablan por un canal privado de Supabase Realtime con todo
//! cifrado (AES-256-GCM); la clave sale del secreto del QR (HKDF-SHA-256, con el id del usuario de sal), que viaja en el
//! `#` del enlace y nunca llega a ningún servidor. El canal en sí (el cliente de Supabase) no está en Rust todavía.
use super::tipos::EstadoCelular;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::alphabet::URL_SAFE;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, URL_SAFE_NO_PAD};
use base64::engine::DecodePaddingMode;
use base64::Engine;
use hkdf::Hkdf;
use serde_json::{json, Map, Value};
use sha2::Sha256;
use std::collections::{HashSet, VecDeque};

pub const CELU_WEB_URL: &str = "https://toomasmg.github.io/sloth/celu/";
pub const HOLA_CADA_MS: i64 = 30_000;
pub const CELU_ACTIVO_MS: i64 = 75_000;
pub const LATIDO_MS: i64 = 15_000;
pub const MIN_ENTRE_ESTADOS_MS: i64 = 2_000;
pub const VIEJO_MS: i64 = 40_000;
pub const DECISION_VENTANA_MS: i64 = 60_000;
pub const MAX_SOBRE: usize = 200_000;

const IV_BYTES: usize = 12;
const MAX_ENLACE: usize = 8000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Evento {
    Estado,
    Hola,
    Decision,
    Resultado,
}

impl Evento {
    pub fn como_texto(self) -> &'static str {
        match self {
            Evento::Estado => "estado",
            Evento::Hola => "hola",
            Evento::Decision => "decision",
            Evento::Resultado => "resultado",
        }
    }
}

pub type Clave = [u8; 32];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Emparejamiento {
    pub u: String,
    pub k: String,
    pub s: String,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Destino {
    pub u: String,
    pub k: String,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatoDecision {
    pub id: String,
    pub permitir: bool,
    pub at: i64,
    pub nonce: String,
}

pub fn topic_celu(user_id: &str) -> String {
    format!("celu:{}", user_id.to_lowercase())
}

pub fn secreto_valido(s: &str) -> bool {
    s.len() <= 128 && s.len() >= 43 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn a_base64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `atob` perdona los bits sobrantes del final; lo único que no acepta es un largo imposible o un carácter de otro alfabeto.
pub fn de_base64url(s: &str) -> Result<Vec<u8>, String> {
    if !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err("base64url inválido".into());
    }
    let motor = GeneralPurpose::new(&URL_SAFE, GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true).with_decode_padding_mode(DecodePaddingMode::RequireNone));
    motor.decode(s).map_err(|e| e.to_string())
}

fn es_https(u: &str) -> bool {
    let t = u.trim_matches(|c: char| c <= ' ');
    t.len() > 8 && t[..8].eq_ignore_ascii_case("https://") && !t[8..].starts_with('/') && !t[8..].starts_with('?') && !t[8..].starts_with('#')
}

fn es_uuid(id: &str) -> bool {
    let partes: Vec<&str> = id.split('-').collect();
    partes.len() == 5 && [8, 4, 4, 4, 12].iter().zip(&partes).all(|(n, p)| p.len() == *n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Un destino válido: url https, la anon key (hasta 2000 caracteres) y el uuid del usuario.
pub fn validar_destino(raw: &Value) -> Option<Destino> {
    let o = raw.as_object()?;
    let (u, k, id) = (o.get("u")?.as_str()?, o.get("k")?.as_str()?, o.get("id")?.as_str()?);
    if !es_https(u) || k.is_empty() || k.encode_utf16().count() > 2000 || !es_uuid(id) {
        return None;
    }
    Some(Destino { u: u.into(), k: k.into(), id: id.to_lowercase() })
}

pub fn enlace_celu(p: &Emparejamiento, base: Option<&str>) -> String {
    let json = json!({ "u": p.u, "k": p.k, "s": p.s, "id": p.id }).to_string();
    format!("{}#p={}", base.unwrap_or(CELU_WEB_URL), a_base64url(json.as_bytes()))
}

pub fn leer_emparejamiento(hash: &str) -> Option<Emparejamiento> {
    if hash.encode_utf16().count() > MAX_ENLACE {
        return None;
    }
    let consulta = hash.strip_prefix('#').unwrap_or(hash);
    let p = consulta.split('&').find_map(|par| par.strip_prefix("p=")).filter(|p| !p.is_empty())?;
    let bytes = de_base64url(p).ok()?;
    let raw: Value = serde_json::from_str(std::str::from_utf8(&bytes).ok()?).ok()?;
    let d = validar_destino(&raw)?;
    let s = raw.get("s")?.as_str().filter(|s| secreto_valido(s))?;
    Some(Emparejamiento { u: d.u, k: d.k, id: d.id, s: s.into() })
}

/// Mismo proyecto y misma cuenta: un enlace así reemplaza al guardado sin preguntar.
pub fn mismo_destino(a: &Destino, b: &Destino) -> bool {
    a.u == b.u && a.id.to_lowercase() == b.id.to_lowercase()
}

/// El celu descarta un estado más viejo que el último (un sobre reenviado). Si el último ya venció, acepta cualquiera:
/// así se recupera si el reloj de la PC volvió para atrás. `ultimo` es `(ahora de la PC, recibido en el celu)`.
pub fn estado_mas_nuevo(ultimo: Option<(i64, i64)>, ahora_pc: i64, ahora_celu: i64) -> bool {
    match ultimo {
        Some((ahora, recibido)) if ahora_celu - recibido <= VIEJO_MS => ahora_pc > ahora,
        _ => true,
    }
}

/// HKDF-SHA-256 del secreto, con el userId de sal: el mismo secreto con otra cuenta da otra clave.
pub fn clave_celu(secreto: &str, user_id: &str) -> Result<Clave, String> {
    let base = de_base64url(secreto)?;
    let mut clave = [0u8; 32];
    Hkdf::<Sha256>::new(Some(user_id.to_lowercase().as_bytes()), &base).expand(b"sloth-celu-v1", &mut clave).map_err(|e| e.to_string())?;
    Ok(clave)
}

// El AAD ata el sobre a su topic y a su evento: un `estado` no se puede reenviar como `decision`.
fn aad(topic: &str, evento: Evento) -> Vec<u8> {
    format!("{topic}|{}", evento.como_texto()).into_bytes()
}

/// El sobre `{v:1, iv, ct}`. El iv es parámetro para poder probar contra el TypeScript; en uso va uno al azar.
pub fn sellar(clave: &Clave, topic: &str, evento: Evento, dato: &Value, iv: &[u8; IV_BYTES]) -> Result<Value, String> {
    let cifra = Aes256Gcm::new(clave.into());
    let ct = cifra.encrypt(Nonce::from_slice(iv), Payload { msg: dato.to_string().as_bytes(), aad: &aad(topic, evento) }).map_err(|e| e.to_string())?;
    Ok(json!({ "v": 1, "iv": a_base64url(iv), "ct": a_base64url(&ct) }))
}

/// None si no es un sobre, si es demasiado grande o si no lo selló esta clave para este topic y evento.
pub fn abrir(clave: &Clave, topic: &str, evento: Evento, sobre: &Value) -> Option<Value> {
    let o = sobre.as_object()?;
    if o.get("v") != Some(&json!(1)) {
        return None;
    }
    let (iv, ct) = (o.get("iv")?.as_str()?, o.get("ct")?.as_str()?);
    if ct.encode_utf16().count() > MAX_SOBRE || iv.encode_utf16().count() > 32 {
        return None;
    }
    let iv = de_base64url(iv).ok().filter(|iv| iv.len() == IV_BYTES)?;
    let claro = Aes256Gcm::new(clave.into()).decrypt(Nonce::from_slice(&iv), Payload { msg: &de_base64url(ct).ok()?, aad: &aad(topic, evento) }).ok()?;
    serde_json::from_str(std::str::from_utf8(&claro).ok()?).ok()
}

fn en_ventana(at: Option<&Value>, ahora: i64) -> Option<i64> {
    let at = at?.as_f64().filter(|a| a.is_finite() && (a - ahora as f64).abs() <= DECISION_VENTANA_MS as f64)?;
    Some(at as i64)
}

/// Un `hola` del celu: solo vale si su hora está dentro de la ventana.
pub fn validar_hola(d: &Value, ahora: i64) -> Option<i64> {
    en_ventana(d.as_object()?.get("at"), ahora)
}

pub fn validar_decision(d: &Value, ahora: i64) -> Option<DatoDecision> {
    let o = d.as_object()?;
    let id = o.get("id")?.as_str().filter(|i| (1..=100).contains(&i.encode_utf16().count()))?;
    let permitir = match o.get("decision")?.as_str()? {
        "allow" => true,
        "deny" => false,
        _ => return None,
    };
    let at = en_ventana(o.get("at"), ahora)?;
    let nonce = o.get("nonce")?.as_str().filter(|n| (16..=64).contains(&n.encode_utf16().count()))?;
    Some(DatoDecision { id: id.into(), permitir, at, nonce: nonce.into() })
}

#[derive(Debug, Clone, Copy)]
pub struct RitmoEntrada {
    pub ahora: i64,
    pub ultimo_hola: Option<i64>,
    pub ultimo_envio: Option<i64>,
    pub cambio: bool,
    pub hola_nuevo: bool,
}

/// Solo se publica con un celu mirando: al toque ante un hola, con cambios cada 2 s como mucho y un latido.
pub fn debe_publicar(e: &RitmoEntrada) -> bool {
    if !celu_activo(e.ultimo_hola, e.ahora) {
        return false;
    }
    let Some(envio) = e.ultimo_envio else { return true };
    if e.hola_nuevo {
        return true;
    }
    let desde = e.ahora - envio;
    (e.cambio && desde >= MIN_ENTRE_ESTADOS_MS) || desde >= LATIDO_MS
}

pub fn celu_activo(ultimo_hola: Option<i64>, ahora: i64) -> bool {
    ultimo_hola.is_some_and(|h| ahora - h <= CELU_ACTIVO_MS)
}

/// `ahora` cambia en cada lectura: sin sacarlo, todo parecería un cambio.
pub fn huella(e: &EstadoCelular) -> String {
    let mut v = serde_json::to_value(e).expect("el estado se serializa");
    if let Some(o) = v.as_object_mut() {
        o.shift_remove("ahora");
    }
    v.to_string()
}

/// Los nonces de decisión ya usados: una decisión repetida (un sobre reenviado) no se aplica dos veces.
pub struct Nonces {
    vistos: HashSet<String>,
    orden: VecDeque<String>,
    max: usize,
}

impl Nonces {
    pub fn nuevos(max: usize) -> Self {
        Nonces { vistos: HashSet::new(), orden: VecDeque::new(), max }
    }

    /// false si ya se usó.
    pub fn usar(&mut self, n: &str) -> bool {
        if !self.vistos.insert(n.to_string()) {
            return false;
        }
        self.orden.push_back(n.to_string());
        if self.orden.len() > self.max {
            if let Some(viejo) = self.orden.pop_front() {
                self.vistos.remove(&viejo);
            }
        }
        true
    }
}

impl Default for Nonces {
    fn default() -> Self {
        Self::nuevos(500)
    }
}

/// El estado que sale por el canal remoto: la terminal no va (se abre solo por el Wi-Fi) y aprobar necesita también la segunda llave.
pub fn estado_para_remoto(mut e: EstadoCelular, puede_aprobar_remoto: bool) -> EstadoCelular {
    e.terminal_en_wifi = Some(e.terminal);
    e.aprobar = e.aprobar && puede_aprobar_remoto;
    e.terminal = false;
    e
}

/// Un objeto JSON vacío, para armar datos a mano.
pub fn objeto() -> Map<String, Value> {
    Map::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::celular::pruebas::clave_de;

    fn base() -> RitmoEntrada {
        RitmoEntrada { ahora: 100_000, ultimo_hola: Some(99_000), ultimo_envio: Some(99_500), cambio: false, hola_nuevo: false }
    }

    fn estado() -> EstadoCelular {
        EstadoCelular { ahora: 1, aprobar: false, terminal: false, terminal_en_wifi: None, cuentas: vec![], sesiones: vec![], pedidos: vec![] }
    }

    #[test]
    fn sin_hola_o_con_un_hola_viejo_no_publica() {
        assert!(!debe_publicar(&RitmoEntrada { ultimo_hola: None, hola_nuevo: true, ..base() }));
        assert!(!debe_publicar(&RitmoEntrada { ultimo_hola: Some(base().ahora - CELU_ACTIVO_MS - 1), hola_nuevo: true, cambio: true, ultimo_envio: None, ..base() }));
    }

    #[test]
    fn con_un_hola_nuevo_publica_al_toque() {
        assert!(debe_publicar(&RitmoEntrada { hola_nuevo: true, ultimo_envio: Some(base().ahora), ..base() }));
        assert!(debe_publicar(&RitmoEntrada { ultimo_envio: None, ..base() }));
    }

    #[test]
    fn ante_cambios_respeta_el_minimo_entre_estados() {
        let con = |cambio, hace| RitmoEntrada { cambio, ultimo_envio: Some(base().ahora - hace), ..base() };
        assert!(!debe_publicar(&con(true, MIN_ENTRE_ESTADOS_MS - 1)));
        assert!(debe_publicar(&con(true, MIN_ENTRE_ESTADOS_MS)));
        assert!(!debe_publicar(&con(false, MIN_ENTRE_ESTADOS_MS)));
    }

    #[test]
    fn sin_cambios_manda_un_latido() {
        assert!(!debe_publicar(&RitmoEntrada { ultimo_envio: Some(base().ahora - LATIDO_MS + 1), ..base() }));
        assert!(debe_publicar(&RitmoEntrada { ultimo_envio: Some(base().ahora - LATIDO_MS), ..base() }));
    }

    #[test]
    fn celu_activo_mira_los_ultimos_75_s() {
        assert!(!celu_activo(None, 1000));
        assert!(celu_activo(Some(1000), 1000 + CELU_ACTIVO_MS));
        assert!(!celu_activo(Some(1000), 1001 + CELU_ACTIVO_MS));
    }

    #[test]
    fn huella_ignora_ahora_y_ve_lo_demas() {
        let e = estado();
        assert_eq!(huella(&e), huella(&EstadoCelular { ahora: 2, ..estado() }));
        assert_ne!(huella(&e), huella(&EstadoCelular { aprobar: true, ..estado() }));
        assert!(!huella(&e).contains("ahora"));
    }

    #[test]
    fn nonces_rechaza_un_repetido_y_olvida_los_mas_viejos() {
        let mut n = Nonces::nuevos(2);
        assert!(n.usar("a"));
        assert!(!n.usar("a"));
        assert!(n.usar("b"));
        assert!(n.usar("c"));
        assert!(!n.usar("b"));
        assert!(n.usar("a"));
    }

    #[test]
    fn el_estado_remoto_no_lleva_la_terminal_y_pide_la_segunda_llave() {
        let e = estado_para_remoto(EstadoCelular { aprobar: true, terminal: true, ..estado() }, false);
        assert_eq!((e.aprobar, e.terminal, e.terminal_en_wifi), (false, false, Some(true)));
        assert!(estado_para_remoto(EstadoCelular { aprobar: true, ..estado() }, true).aprobar);
    }

    const USUARIO: &str = "0a1b2c3d-0000-4000-8000-00000000abcd";

    #[test]
    fn el_sobre_ida_y_vuelta_atado_al_topic_y_al_evento() {
        let secreto = clave_de(9);
        let clave = clave_celu(&secreto, USUARIO).unwrap();
        let topic = topic_celu(&USUARIO.to_uppercase());
        assert_eq!(topic, format!("celu:{USUARIO}"));
        let dato = json!({ "id": "p1", "ok": true });
        let sobre = sellar(&clave, &topic, Evento::Resultado, &dato, &[7; 12]).unwrap();
        assert_eq!(abrir(&clave, &topic, Evento::Resultado, &sobre), Some(dato));
        assert_eq!(abrir(&clave, &topic, Evento::Estado, &sobre), None, "otro evento");
        assert_eq!(abrir(&clave, "celu:otro", Evento::Resultado, &sobre), None, "otro topic");
        let otra = clave_celu(&secreto, "ffffffff-0000-4000-8000-00000000abcd").unwrap();
        assert_ne!(otra, clave, "la sal es el usuario");
        assert_eq!(abrir(&otra, &topic, Evento::Resultado, &sobre), None);
    }

    #[test]
    fn abrir_rechaza_lo_que_no_es_un_sobre() {
        let clave = clave_celu(&clave_de(9), USUARIO).unwrap();
        let sobre = sellar(&clave, "t", Evento::Hola, &json!({ "at": 1 }), &[1; 12]).unwrap();
        for malo in [json!(null), json!("x"), json!({ "v": 2, "iv": sobre["iv"], "ct": sobre["ct"] }), json!({ "v": 1, "iv": sobre["iv"] }), json!({ "v": 1, "iv": a_base64url(&[0; 11]), "ct": sobre["ct"] }), json!({ "v": 1, "iv": sobre["iv"], "ct": "x".repeat(MAX_SOBRE + 1) })] {
            assert_eq!(abrir(&clave, "t", Evento::Hola, &malo), None, "{malo}");
        }
    }

    #[test]
    fn abre_el_sobre_que_sello_el_typescript() {
        let f: Value = serde_json::from_str(include_str!("fixtures/ts.json")).unwrap();
        let r = &f["remoto"];
        let clave = clave_celu(r["secreto"].as_str().unwrap(), r["userId"].as_str().unwrap()).unwrap();
        assert_eq!(topic_celu(r["userId"].as_str().unwrap()), r["topic"].as_str().unwrap());
        assert_eq!(abrir(&clave, r["topic"].as_str().unwrap(), Evento::Estado, &r["sobre"]), Some(r["dato"].clone()));
        assert_eq!(abrir(&clave, r["topic"].as_str().unwrap(), Evento::Decision, &r["sobre"]), None);
    }

    #[test]
    fn validar_hola_y_decision_miran_la_ventana_y_los_largos() {
        let ahora = 1_800_000_000_000i64;
        assert_eq!(validar_hola(&json!({ "at": ahora }), ahora), Some(ahora));
        assert_eq!(validar_hola(&json!({ "at": ahora - DECISION_VENTANA_MS - 1 }), ahora), None);
        assert_eq!(validar_hola(&json!({ "at": "x" }), ahora), None);
        assert_eq!(validar_hola(&json!([]), ahora), None);
        let nonce = "n".repeat(16);
        let ok = json!({ "id": "p1", "decision": "allow", "at": ahora, "nonce": nonce });
        assert_eq!(validar_decision(&ok, ahora), Some(DatoDecision { id: "p1".into(), permitir: true, at: ahora, nonce: nonce.clone() }));
        assert!(!validar_decision(&json!({ "id": "p1", "decision": "deny", "at": ahora, "nonce": nonce }), ahora).unwrap().permitir);
        for (campo, malo) in [("id", json!("")), ("id", json!("i".repeat(101))), ("decision", json!("allowAlways")), ("at", json!(ahora + DECISION_VENTANA_MS + 1)), ("nonce", json!("corto")), ("nonce", json!("n".repeat(65)))] {
            let mut o = ok.clone();
            o[campo] = malo.clone();
            assert_eq!(validar_decision(&o, ahora), None, "{campo} {malo}");
        }
    }

    #[test]
    fn el_enlace_del_qr_ida_y_vuelta_y_lo_que_no_vale() {
        let p = Emparejamiento { u: "https://x.supabase.co".into(), k: "anon".into(), s: clave_de(9), id: USUARIO.into() };
        let enlace = enlace_celu(&p, None);
        assert!(enlace.starts_with(&format!("{CELU_WEB_URL}#p=")));
        let hash = &enlace[CELU_WEB_URL.len() - 0..];
        assert_eq!(leer_emparejamiento(hash), Some(p.clone()));
        assert_eq!(leer_emparejamiento(&hash.replacen("p=", "q=", 1)), None);
        assert_eq!(leer_emparejamiento(&format!("#p={}", a_base64url(b"no json"))), None);
        let http = json!({ "u": "http://x.co", "k": "a", "s": clave_de(9), "id": USUARIO });
        assert_eq!(leer_emparejamiento(&format!("#p={}", a_base64url(http.to_string().as_bytes()))), None);
        let corto = json!({ "u": "https://x.co", "k": "a", "s": "corto", "id": USUARIO });
        assert_eq!(leer_emparejamiento(&format!("#p={}", a_base64url(corto.to_string().as_bytes()))), None);
        assert_eq!(leer_emparejamiento(&format!("#p={}", "a".repeat(MAX_ENLACE))), None);
    }

    #[test]
    fn estado_mas_nuevo_descarta_el_reenviado_pero_se_recupera_si_el_ultimo_vencio() {
        assert!(estado_mas_nuevo(None, 5, 0));
        assert!(!estado_mas_nuevo(Some((10, 1000)), 10, 1500));
        assert!(estado_mas_nuevo(Some((10, 1000)), 11, 1500));
        assert!(estado_mas_nuevo(Some((10, 1000)), 5, 1000 + VIEJO_MS + 1), "el reloj de la PC volvió para atrás");
    }

    #[test]
    fn validar_destino_pide_https_y_un_uuid() {
        let ok = json!({ "u": "https://x.co", "k": "a", "id": USUARIO.to_uppercase() });
        assert_eq!(validar_destino(&ok).unwrap().id, USUARIO);
        for malo in [json!({ "u": "http://x.co", "k": "a", "id": USUARIO }), json!({ "u": "https://x.co", "k": "", "id": USUARIO }), json!({ "u": "https://x.co", "k": "a", "id": "no" }), json!({ "u": "https://", "k": "a", "id": USUARIO }), json!([])] {
            assert_eq!(validar_destino(&malo), None, "{malo}");
        }
    }
}
