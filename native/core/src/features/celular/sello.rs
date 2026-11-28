//! Sellos de la página del celu: AES-256-CTR más HMAC-SHA256 (encrypt-then-MAC), byte a byte iguales a
//! `celular-sello.ts`. Las claves salen de la del QR con HMAC y una etiqueta; el sobre es `iv || cifrado || tag` en
//! base64url sin relleno. El pedido ata la ruta al MAC y la respuesta ata el iv del pedido, así uno no vale como el otro.
use aes::Aes256;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ctr::cipher::{KeyIvInit, StreamCipher};
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use subtle::ConstantTimeEq;

pub const VENTANA_MS: i64 = 5 * 60_000;
pub const MAX_SOBRE_BYTES: usize = 8192;

const IV_BYTES: usize = 16;
const TAG_BYTES: usize = 32;

type Ctr = ctr::Ctr128BE<Aes256>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claves {
    pub enc: [u8; 32],
    pub mac: [u8; 32],
}

fn hmac(clave: &[u8], partes: &[&[u8]]) -> [u8; 32] {
    let mut h = <Hmac<Sha256> as Mac>::new_from_slice(clave).expect("HMAC acepta claves de cualquier largo");
    for p in partes {
        h.update(p);
    }
    h.finalize().into_bytes().into()
}

pub fn codificar(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `Buffer.from(…, 'base64url')` perdona caracteres de más: se exige la forma canónica (el texto que vuelve a dar el mismo).
pub fn decodificar(texto: &str) -> Option<Vec<u8>> {
    if texto.is_empty() || !texto.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(texto).ok()?;
    (codificar(&bytes) == texto).then_some(bytes)
}

pub fn derivar_claves(clave: &str) -> Option<Claves> {
    let bytes = decodificar(clave)?;
    if bytes.len() != 32 {
        return None;
    }
    Some(Claves { enc: hmac(&bytes, &[b"sloth-wifi enc"]), mac: hmac(&bytes, &[b"sloth-wifi mac"]) })
}

fn ctr(c: &Claves, iv: &[u8], datos: &[u8]) -> Vec<u8> {
    let mut salida = datos.to_vec();
    let mut cifra = Ctr::new((&c.enc).into(), iv.into());
    cifra.apply_keystream(&mut salida);
    salida
}

fn sellar(c: &Claves, prefijo: &[u8], json: &str, iv: &[u8]) -> Result<String, String> {
    if iv.len() != IV_BYTES {
        return Err("El iv tiene que medir 16 bytes".into());
    }
    let ct = ctr(c, iv, json.as_bytes());
    let tag = hmac(&c.mac, &[prefijo, iv, &ct]);
    Ok(codificar(&[iv, &ct, &tag].concat()))
}

/// El json en claro y el iv del sobre.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Abierto {
    pub json: String,
    pub iv: Vec<u8>,
}

fn abrir(c: &Claves, prefijo: &[u8], sobre: &str) -> Option<Abierto> {
    if sobre.len() > MAX_SOBRE_BYTES {
        return None;
    }
    let bytes = decodificar(sobre)?;
    if bytes.len() < IV_BYTES + TAG_BYTES {
        return None;
    }
    let (iv, resto) = bytes.split_at(IV_BYTES);
    let (ct, tag) = resto.split_at(resto.len() - TAG_BYTES);
    let esperado = hmac(&c.mac, &[prefijo, iv, ct]);
    if !bool::from(tag.ct_eq(&esperado)) {
        return None;
    }
    // `toString('utf8')` reemplaza lo inválido en vez de fallar.
    Some(Abierto { json: String::from_utf8_lossy(&ctr(c, iv, ct)).into_owned(), iv: iv.to_vec() })
}

fn prefijo_pedido(ruta: &str) -> Vec<u8> {
    [b"q".as_slice(), ruta.as_bytes(), b"\0"].concat()
}

fn prefijo_respuesta(iv_pedido: &[u8]) -> Vec<u8> {
    [b"r".as_slice(), iv_pedido].concat()
}

pub fn iv_aleatorio() -> [u8; IV_BYTES] {
    let mut iv = [0u8; IV_BYTES];
    getrandom::getrandom(&mut iv).expect("el sistema operativo da bytes al azar");
    iv
}

pub fn sellar_pedido(c: &Claves, ruta: &str, json: &str, iv: &[u8]) -> Result<String, String> {
    sellar(c, &prefijo_pedido(ruta), json, iv)
}

pub fn abrir_pedido(c: &Claves, ruta: &str, sobre: &str) -> Option<Abierto> {
    abrir(c, &prefijo_pedido(ruta), sobre)
}

pub fn sellar_respuesta(c: &Claves, iv_pedido: &[u8], json: &str, iv: &[u8]) -> Result<String, String> {
    sellar(c, &prefijo_respuesta(iv_pedido), json, iv)
}

/// Como `sellar_respuesta` con un iv nuevo, que es como se usa de verdad.
pub fn sellar_respuesta_nueva(c: &Claves, iv_pedido: &[u8], json: &str) -> String {
    sellar_respuesta(c, iv_pedido, json, &iv_aleatorio()).expect("el iv mide 16 bytes")
}

pub fn abrir_respuesta(c: &Claves, iv_pedido: &[u8], sobre: &str) -> Option<String> {
    abrir(c, &prefijo_respuesta(iv_pedido), sobre).map(|a| a.json)
}

struct EstadoRepetidos {
    orden: VecDeque<String>,
    vistos: HashMap<String, i64>,
}

/// Los iv ya vistos: un sobre copiado de la red no se acepta dos veces. Acotado en edad y en cantidad.
pub struct Repetidos {
    ttl_ms: i64,
    tope: usize,
    estado: Mutex<EstadoRepetidos>,
}

impl Default for Repetidos {
    fn default() -> Self {
        Self::nuevos(10 * 60_000, 20_000)
    }
}

impl Repetidos {
    pub fn nuevos(ttl_ms: i64, tope: usize) -> Self {
        Repetidos { ttl_ms, tope, estado: Mutex::new(EstadoRepetidos { orden: VecDeque::new(), vistos: HashMap::new() }) }
    }

    /// true si ese iv ya se había visto (y dentro del ttl); si no, lo anota.
    pub fn visto_antes(&self, iv: &[u8], ahora: i64) -> bool {
        let mut e = self.estado.lock().unwrap_or_else(|p| p.into_inner());
        while let Some(k) = e.orden.front() {
            if ahora - e.vistos[k] <= self.ttl_ms {
                break;
            }
            let k = e.orden.pop_front().expect("hay un primero");
            e.vistos.remove(&k);
        }
        let clave = hex::encode(iv);
        if e.vistos.contains_key(&clave) {
            return true;
        }
        while e.vistos.len() >= self.tope {
            let Some(mas) = e.orden.pop_front() else { break };
            e.vistos.remove(&mas);
        }
        e.orden.push_back(clave.clone());
        e.vistos.insert(clave, ahora);
        false
    }
}

/// `t` tiene que ser un número finito a menos de `VENTANA_MS` de la hora de la PC.
pub fn fecha_valida(t: Option<&Value>, ahora: i64) -> bool {
    t.and_then(Value::as_f64).is_some_and(|t| t.is_finite() && (ahora as f64 - t).abs() <= VENTANA_MS as f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::celular::pruebas::clave_de;
    use serde_json::json;

    fn claves(clave: &str) -> Claves {
        derivar_claves(clave).expect("clave buena")
    }

    fn base() -> Claves {
        claves(&clave_de(7))
    }

    fn cambiar_bit(sobre: &str, byte: usize) -> String {
        let mut b = decodificar(sobre).unwrap();
        b[byte] ^= 1;
        codificar(&b)
    }

    #[test]
    fn derivar_claves_sigue_el_esquema_hmac_con_las_etiquetas() {
        let c = base();
        assert_eq!(c.enc, hmac(&[7; 32], &[b"sloth-wifi enc"]));
        assert_eq!(c.mac, hmac(&[7; 32], &[b"sloth-wifi mac"]));
    }

    #[test]
    fn derivar_claves_rechaza_lo_que_no_son_32_bytes_en_base64url() {
        let clave = clave_de(7);
        assert!(derivar_claves("corta").is_none());
        assert!(derivar_claves("").is_none());
        assert!(derivar_claves(&codificar(&[1; 31])).is_none());
        assert!(derivar_claves(&codificar(&[1; 33])).is_none());
        assert!(derivar_claves(&format!("{clave}=")).is_none());
        assert!(derivar_claves(&format!("{}+", &clave[..42])).is_none());
    }

    #[test]
    fn el_pedido_sellado_coincide_con_una_construccion_independiente() {
        let c = base();
        let iv = [4u8; 16];
        let json = r#"{"t":1,"b":"á"}"#;
        let sobre = sellar_pedido(&c, "/api/x", json, &iv).unwrap();
        let ct = ctr(&c, &iv, json.as_bytes());
        let tag = hmac(&c.mac, &[b"q/api/x\0", &iv, &ct]);
        assert_eq!(sobre, codificar(&[iv.as_slice(), &ct, &tag].concat()));
    }

    #[test]
    fn pedido_ida_y_vuelta_devuelve_el_json_y_el_iv() {
        let c = base();
        let iv = [9u8; 16];
        let a = abrir_pedido(&c, "/api/estado", &sellar_pedido(&c, "/api/estado", r#"{"a":"ñ😀"}"#, &iv).unwrap()).unwrap();
        assert_eq!(a.json, r#"{"a":"ñ😀"}"#);
        assert_eq!(a.iv, iv);
    }

    #[test]
    fn pedido_dos_sellados_del_mismo_texto_usan_iv_distintos() {
        let c = base();
        let a = sellar_pedido(&c, "/r", "x", &iv_aleatorio()).unwrap();
        let b = sellar_pedido(&c, "/r", "x", &iv_aleatorio()).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn pedido_ruta_distinta_clave_equivocada_o_sobre_invalido_dan_none() {
        let c = base();
        let sobre = sellar_pedido(&c, "/a", "{}", &iv_aleatorio()).unwrap();
        assert!(abrir_pedido(&c, "/b", &sobre).is_none());
        assert!(abrir_pedido(&claves(&clave_de(8)), "/a", &sobre).is_none());
        assert!(abrir_pedido(&c, "/a", "").is_none());
        assert!(abrir_pedido(&c, "/a", "!!!!").is_none());
        assert!(abrir_pedido(&c, "/a", &format!("{sobre}=")).is_none());
    }

    #[test]
    fn pedido_un_bit_cambiado_en_el_iv_el_texto_o_el_tag_da_none() {
        let c = base();
        let sobre = sellar_pedido(&c, "/a", r#"{"x":1}"#, &iv_aleatorio()).unwrap();
        let largo = decodificar(&sobre).unwrap().len();
        assert!(abrir_pedido(&c, "/a", &sobre).is_some());
        for i in [3, 17, largo - 1] {
            assert!(abrir_pedido(&c, "/a", &cambiar_bit(&sobre, i)).is_none(), "byte {i}");
        }
    }

    #[test]
    fn pedido_truncado_o_recortado_da_none() {
        let c = base();
        let sobre = sellar_pedido(&c, "/a", r#"{"x":1}"#, &iv_aleatorio()).unwrap();
        let bytes = decodificar(&sobre).unwrap();
        for n in [bytes.len() - 1, 47, 16] {
            assert!(abrir_pedido(&c, "/a", &codificar(&bytes[..n])).is_none(), "{n} bytes");
        }
        assert!(abrir_pedido(&c, "/a", &sobre[..sobre.len() - 2]).is_none());
    }

    #[test]
    fn pedido_el_texto_vacio_se_sella_y_se_abre() {
        let c = base();
        let sobre = sellar_pedido(&c, "/a", "", &iv_aleatorio()).unwrap();
        assert_eq!(decodificar(&sobre).unwrap().len(), 48);
        assert_eq!(abrir_pedido(&c, "/a", &sobre).unwrap().json, "");
    }

    #[test]
    fn un_sobre_de_mas_de_max_sobre_bytes_da_none_aunque_este_bien_sellado() {
        let c = base();
        let sobre = sellar_pedido(&c, "/a", &"x".repeat(MAX_SOBRE_BYTES), &iv_aleatorio()).unwrap();
        assert!(sobre.len() > MAX_SOBRE_BYTES);
        assert!(abrir_pedido(&c, "/a", &sobre).is_none());
        let justo = sellar_pedido(&c, "/a", &"x".repeat(5000), &iv_aleatorio()).unwrap();
        assert!(justo.len() <= MAX_SOBRE_BYTES);
        assert!(abrir_pedido(&c, "/a", &justo).is_some());
    }

    #[test]
    fn respuesta_ida_y_vuelta_atada_al_iv_del_pedido() {
        let c = base();
        let iv_pedido = [1u8; 16];
        let sobre = sellar_respuesta_nueva(&c, &iv_pedido, r#"{"ok":true,"n":"ü"}"#);
        assert_eq!(abrir_respuesta(&c, &iv_pedido, &sobre).as_deref(), Some(r#"{"ok":true,"n":"ü"}"#));
    }

    #[test]
    fn respuesta_otro_iv_pedido_clave_equivocada_o_bit_cambiado_dan_none() {
        let c = base();
        let iv_pedido = [1u8; 16];
        let sobre = sellar_respuesta_nueva(&c, &iv_pedido, r#"{"ok":true}"#);
        assert!(abrir_respuesta(&c, &[2u8; 16], &sobre).is_none());
        assert!(abrir_respuesta(&claves(&clave_de(8)), &iv_pedido, &sobre).is_none());
        let largo = decodificar(&sobre).unwrap().len();
        for i in [0, 16, largo - 1] {
            assert!(abrir_respuesta(&c, &iv_pedido, &cambiar_bit(&sobre, i)).is_none(), "byte {i}");
        }
        assert!(abrir_respuesta(&c, &iv_pedido, &"x".repeat(MAX_SOBRE_BYTES + 1)).is_none());
    }

    #[test]
    fn un_pedido_no_se_acepta_como_respuesta_ni_al_reves() {
        let c = base();
        let iv = [5u8; 16];
        assert!(abrir_respuesta(&c, &iv, &sellar_pedido(&c, "/a", "{}", &iv).unwrap()).is_none());
        assert!(abrir_pedido(&c, "", &sellar_respuesta_nueva(&c, &iv, "{}")).is_none());
    }

    #[test]
    fn sellar_rechaza_un_iv_que_no_mide_16_bytes() {
        assert!(sellar_pedido(&base(), "/a", "{}", &[0u8; 12]).is_err());
        assert!(sellar_respuesta(&base(), &[0u8; 16], "{}", &[0u8; 12]).is_err());
    }

    #[test]
    fn repetidos_la_primera_vez_es_false_la_segunda_true() {
        let r = Repetidos::default();
        let iv = iv_aleatorio();
        assert!(!r.visto_antes(&iv, 1000));
        assert!(r.visto_antes(&iv, 1001));
        assert!(!r.visto_antes(&iv_aleatorio(), 1002));
    }

    #[test]
    fn repetidos_pasado_el_ttl_el_iv_vuelve_a_valer() {
        let r = Repetidos::nuevos(1000, 20_000);
        let iv = iv_aleatorio();
        assert!(!r.visto_antes(&iv, 0));
        assert!(r.visto_antes(&iv, 1000));
        assert!(!r.visto_antes(&iv, 1001));
    }

    #[test]
    fn repetidos_al_llegar_al_tope_se_descarta_el_mas_viejo() {
        let r = Repetidos::nuevos(60_000, 3);
        let ivs: Vec<[u8; 16]> = (1..=4u8).map(|i| [i; 16]).collect();
        for (i, iv) in ivs.iter().enumerate() {
            r.visto_antes(iv, i as i64 + 1);
        }
        assert!(r.visto_antes(&ivs[1], 5));
        assert!(r.visto_antes(&ivs[2], 5));
        assert!(r.visto_antes(&ivs[3], 5));
        assert!(!r.visto_antes(&ivs[0], 5));
    }

    #[test]
    fn fecha_valida_acepta_hasta_la_ventana_y_rechaza_lo_que_no_es_un_numero_finito() {
        let ahora = 1_700_000_000_000i64;
        assert_eq!(VENTANA_MS, 300_000);
        let ok = |t: i64| fecha_valida(Some(&json!(t)), ahora);
        assert!(ok(ahora));
        assert!(ok(ahora - VENTANA_MS));
        assert!(ok(ahora + VENTANA_MS));
        assert!(!ok(ahora - VENTANA_MS - 1));
        assert!(!ok(ahora + VENTANA_MS + 1));
        for malo in [json!("1700000000000"), json!(null), json!({}), json!([])] {
            assert!(!fecha_valida(Some(&malo), ahora), "{malo}");
        }
        assert!(!fecha_valida(None, ahora));
    }

    // Vectores generados por `generar-fixtures.mjs` con el celular-sello.ts real sobre node:crypto.
    fn fixtures() -> Value {
        serde_json::from_str(include_str!("fixtures/ts.json")).expect("fixtures/ts.json es JSON")
    }

    #[test]
    fn coincide_byte_a_byte_con_el_typescript() {
        let f = fixtures();
        let s = &f["sello"];
        let c = claves(s["clave"].as_str().unwrap());
        assert_eq!(hex::encode(c.enc), s["enc"].as_str().unwrap());
        assert_eq!(hex::encode(c.mac), s["mac"].as_str().unwrap());
        let iv = hex::decode(s["iv"].as_str().unwrap()).unwrap();
        let iv_r = hex::decode(s["iv_respuesta"].as_str().unwrap()).unwrap();
        let ruta = s["ruta"].as_str().unwrap();
        let json = s["json"].as_str().unwrap();
        let pedido = sellar_pedido(&c, ruta, json, &iv).unwrap();
        assert_eq!(pedido, s["pedido"].as_str().unwrap());
        assert_eq!(sellar_respuesta(&c, &iv, r#"{"ok":true,"n":"ü"}"#, &iv_r).unwrap(), s["respuesta"].as_str().unwrap());
        assert_eq!(sellar_pedido(&c, "/a", "", &iv).unwrap(), s["vacio"].as_str().unwrap());
        assert_eq!(abrir_pedido(&c, ruta, &pedido).unwrap().json, json);
        assert_eq!(abrir_respuesta(&c, &iv, s["respuesta"].as_str().unwrap()).as_deref(), Some(r#"{"ok":true,"n":"ü"}"#));
    }
}
