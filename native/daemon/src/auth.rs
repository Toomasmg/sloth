//! Mismas pruebas HMAC que src/daemon/auth.ts: el cliente de Node no distingue qué daemon le contesta.
use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

pub fn es_hex64(s: &str, solo_minusculas: bool) -> bool {
    s.len() == 64
        && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || (!solo_minusculas && (b'A'..=b'F').contains(&b)))
}

pub fn hmac_hex(key: &str, data: &str) -> String {
    let mut m = Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("HMAC acepta cualquier largo de clave");
    m.update(data.as_bytes());
    hex::encode(m.finalize().into_bytes())
}

pub fn prueba_daemon(key: &str, nonce_cliente: &str, nonce_daemon: &str) -> String {
    hmac_hex(key, &format!("sloth-daemon|{nonce_cliente}|{nonce_daemon}"))
}

pub fn prueba_cliente(key: &str, nonce_cliente: &str, nonce_daemon: &str) -> String {
    hmac_hex(key, &format!("sloth-client|{nonce_cliente}|{nonce_daemon}"))
}

pub fn misma_prueba(dada: &str, esperada: &str) -> bool {
    dada.len() == esperada.len() && dada.as_bytes().ct_eq(esperada.as_bytes()).into()
}

/// Cada espacio recibe un token derivado: el de uno no sirve para mandar hooks en nombre de otro.
pub fn hook_token_de(hook_token: &str, ws: &str) -> String {
    hmac_hex(hook_token, &format!("ws:{ws}"))
}

pub fn nuevo_nonce() -> String {
    let mut b = [0u8; 32];
    getrandom::getrandom(&mut b).expect("sin fuente de azar del sistema");
    hex::encode(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex64() {
        assert!(es_hex64(&"a".repeat(64), true));
        assert!(!es_hex64(&"A".repeat(64), true));
        assert!(es_hex64(&"A".repeat(64), false));
        assert!(!es_hex64(&"a".repeat(63), true));
        assert!(!es_hex64(&format!("{}g", "a".repeat(63)), false));
    }

    #[test]
    fn pruebas_distintas_y_estables() {
        let k = "k".repeat(64);
        let (nc, nd) = ("1".repeat(64), "2".repeat(64));
        assert_ne!(prueba_daemon(&k, &nc, &nd), prueba_cliente(&k, &nc, &nd));
        assert_eq!(prueba_daemon(&k, &nc, &nd), prueba_daemon(&k, &nc, &nd));
        assert!(misma_prueba(&prueba_cliente(&k, &nc, &nd), &prueba_cliente(&k, &nc, &nd)));
        assert!(!misma_prueba("corta", &prueba_cliente(&k, &nc, &nd)));
    }

    #[test]
    fn nonce_valido() {
        let n = nuevo_nonce();
        assert!(es_hex64(&n, true));
        assert_ne!(n, nuevo_nonce());
    }
}
