//! Cifrado del archivo .sloth con contraseña (equivale a src/main/features/export-crypto.ts): AES-256-GCM con la clave
//! derivada con scrypt y una sal aleatoria por archivo. El formato es el mismo byte a byte: un export de la versión
//! Electron se abre acá y al revés (ver los fixtures de `native/core/fixtures/export`, generados con Node).
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::alphabet;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD};
use base64::engine::DecodePaddingMode;
use base64::Engine;
use serde::Serialize;
use serde_json::Value;

pub const MIN_PASSWORD: usize = 8;
pub const WRONG_PASSWORD: &str = "La contraseña no es correcta. Revisala y probá de nuevo.";

const KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;
const IV_LEN: usize = 12;
const TAG_LEN: usize = 16;
/// Si el archivo trae otros parámetros de scrypt se rechaza: evita que un archivo cueste mucha memoria.
const MAX_N: f64 = 131_072.0;
const MAX_R: f64 = 16.0;
const MAX_P: f64 = 4.0;
/// El mismo tope de memoria que le ponía el TS a `scryptSync` (maxmem): pasarse es un error, no un cálculo más lento.
const MAXMEM: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CipherBlock {
    pub algoritmo: String,
    pub kdf: String,
    #[serde(rename = "N")]
    pub n: u32,
    pub r: u32,
    pub p: u32,
    pub sal: String,
    pub iv: String,
    pub tag: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Encrypted {
    pub cifrado: CipherBlock,
    pub datos: String,
}

fn clave(password: &str, sal: &[u8], n: u32, r: u32, p: u32) -> Option<[u8; KEY_LEN]> {
    if !n.is_power_of_two() {
        return None;
    }
    let (n64, r64, p64) = (n as u64, r as u64, p as u64);
    // La cuenta de OpenSSL: bloque B más el arreglo V de scrypt.
    if 128 * r64 * p64 + 128 * r64 * (n64 + 2) > MAXMEM {
        return None;
    }
    let params = scrypt::Params::new(n.trailing_zeros() as u8, r, p, KEY_LEN).ok()?;
    let mut k = [0u8; KEY_LEN];
    scrypt::scrypt(password.as_bytes(), sal, &params, &mut k).ok()?;
    Some(k)
}

/// Cifra con sal e iv que pone quien llama (los tests y los fixtures); `encrypt_text` los sortea.
pub fn encrypt_text_con(text: &str, password: &str, sal: &[u8; SALT_LEN], iv: &[u8; IV_LEN]) -> Encrypted {
    let (n, r, p) = (16384u32, 8u32, 1u32);
    let k = clave(password, sal, n, r, p).expect("los parámetros fijos de scrypt entran en el tope de memoria");
    let cifra = Aes256Gcm::new_from_slice(&k).expect("la clave mide 32 bytes");
    let mut salida = cifra.encrypt(Nonce::from_slice(iv), Payload { msg: text.as_bytes(), aad: &[] }).expect("AES-GCM no falla al cifrar");
    // El crate devuelve datos y tag juntos; el archivo los guarda por separado.
    let tag = salida.split_off(salida.len() - TAG_LEN);
    Encrypted {
        cifrado: CipherBlock {
            algoritmo: "aes-256-gcm".into(),
            kdf: "scrypt".into(),
            n,
            r,
            p,
            sal: STANDARD.encode(sal),
            iv: STANDARD.encode(iv),
            tag: STANDARD.encode(tag),
        },
        datos: STANDARD.encode(salida),
    }
}

pub fn encrypt_text(text: &str, password: &str) -> Result<Encrypted, String> {
    let mut sal = [0u8; SALT_LEN];
    let mut iv = [0u8; IV_LEN];
    getrandom::getrandom(&mut sal).map_err(|e| format!("No se pudo generar la sal del cifrado: {e}"))?;
    getrandom::getrandom(&mut iv).map_err(|e| format!("No se pudo generar el iv del cifrado: {e}"))?;
    Ok(encrypt_text_con(text, password, &sal, &iv))
}

fn danado(que: &str) -> String {
    format!("El cifrado del archivo está dañado ({que}).")
}

/// Lo que hace `Buffer.from(v, 'base64')` con un texto que ya pasó la regex: perdona el relleno de más o de menos.
fn base64_node(v: &str) -> Vec<u8> {
    let limpio = v.trim_end_matches('=');
    let limpio = if limpio.len() % 4 == 1 { &limpio[..limpio.len() - 1] } else { limpio };
    let motor = GeneralPurpose::new(&alphabet::STANDARD, GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent).with_decode_allow_trailing_bits(true));
    motor.decode(limpio).unwrap_or_default()
}

fn forma_base64(v: &str) -> bool {
    let sin_relleno = v.trim_end_matches('=');
    let relleno = v.len() - sin_relleno.len();
    !sin_relleno.is_empty() && relleno <= 2 && sin_relleno.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

fn b64(v: &Value, largo: usize, que: &str) -> Result<Vec<u8>, String> {
    let Some(s) = v.as_str().filter(|s| forma_base64(s)) else { return Err(danado(que)) };
    let buf = base64_node(s);
    if largo != 0 && buf.len() != largo {
        return Err(danado(que));
    }
    Ok(buf)
}

/// Entero de JavaScript (`Number.isInteger`): un 16384.0 también cuenta.
fn entero(v: &Value, min: f64, max: f64) -> Option<u32> {
    let n = v.as_f64()?;
    (n.is_finite() && n.fract() == 0.0 && n >= min && n <= max).then_some(n as u32)
}

/// Descifra. `cifrado` y `datos` vienen de un archivo de afuera, por eso son JSON sin tipar. El error es un mensaje
/// claro si la contraseña no coincide o el archivo está dañado.
pub fn decrypt_text(cifrado: &Value, datos: &Value, password: &str) -> Result<String, String> {
    let c = cifrado.as_object().filter(|c| c.get("algoritmo").and_then(Value::as_str) == Some("aes-256-gcm") && c.get("kdf").and_then(Value::as_str) == Some("scrypt"));
    let Some(c) = c else { return Err("Ese cifrado no lo reconoce esta versión de Sloth.".into()) };
    let nulo = Value::Null;
    let campo = |k: &str| c.get(k).unwrap_or(&nulo);
    let (Some(n), Some(r), Some(p)) = (entero(campo("N"), 2.0, MAX_N), entero(campo("r"), 1.0, MAX_R), entero(campo("p"), 1.0, MAX_P)) else {
        return Err("Los parámetros del cifrado del archivo no son válidos.".into());
    };
    let sal = b64(campo("sal"), 0, "sal")?;
    if sal.len() < SALT_LEN {
        return Err(danado("sal"));
    }
    let iv = b64(campo("iv"), IV_LEN, "iv")?;
    let tag = b64(campo("tag"), TAG_LEN, "tag")?;
    let datos = b64(datos, 0, "datos")?;
    let mala = || WRONG_PASSWORD.to_string();
    let k = clave(password, &sal, n, r, p).ok_or_else(mala)?;
    let cifra = Aes256Gcm::new_from_slice(&k).map_err(|_| mala())?;
    let mut junto = datos;
    junto.extend_from_slice(&tag);
    let claro = cifra.decrypt(Nonce::from_slice(&iv), Payload { msg: &junto, aad: &[] }).map_err(|_| mala())?;
    // Node decodifica con reemplazo: un UTF-8 roto da U+FFFD, no un error.
    Ok(String::from_utf8_lossy(&claro).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PASS: &str = "contraseña-larga";
    const TEXT: &str = r#"{"formato":"sloth-config","espacios":[{"nombre":"ñandú ✓"}]}"#;

    fn sobre(e: &Encrypted) -> (Value, Value) {
        let v = serde_json::to_value(e).unwrap();
        (v["cifrado"].clone(), v["datos"].clone())
    }

    fn abrir(e: &Encrypted, pass: &str) -> Result<String, String> {
        let (c, d) = sobre(e);
        decrypt_text(&c, &d, pass)
    }

    fn voltear(b64s: &str, i: usize) -> String {
        let mut b = STANDARD.decode(b64s).unwrap();
        b[i] ^= 0xff;
        STANDARD.encode(b)
    }

    fn recortar(b64s: &str, largo: usize) -> String {
        STANDARD.encode(&STANDARD.decode(b64s).unwrap()[..largo])
    }

    #[test]
    fn ida_y_vuelta_devuelve_el_mismo_texto_con_acentos_y_simbolos() {
        assert_eq!(abrir(&encrypt_text(TEXT, PASS).unwrap(), PASS).unwrap(), TEXT);
    }

    #[test]
    fn el_sobre_no_deja_el_texto_ni_la_contrasena_a_la_vista() {
        let env = encrypt_text(TEXT, PASS).unwrap();
        let raw = serde_json::to_string(&env).unwrap();
        assert!(!raw.contains("andú") && !raw.contains(PASS));
        let claro = String::from_utf8_lossy(&STANDARD.decode(&env.datos).unwrap()).into_owned();
        assert!(!claro.contains("sloth-config"));
        assert_eq!(env.cifrado.algoritmo, "aes-256-gcm");
        assert_eq!(env.cifrado.kdf, "scrypt");
    }

    #[test]
    fn el_bloque_se_escribe_con_las_mismas_claves_y_el_mismo_orden_que_el_ts() {
        let raw = serde_json::to_string(&encrypt_text(TEXT, PASS).unwrap().cifrado).unwrap();
        let claves: Vec<&str> = ["algoritmo", "kdf", "N", "r", "p", "sal", "iv", "tag"].to_vec();
        let mut ultimo = 0;
        for k in claves {
            let en = raw.find(&format!("\"{k}\":")).unwrap_or_else(|| panic!("falta {k}"));
            assert!(en >= ultimo, "{k} fuera de orden");
            ultimo = en;
        }
    }

    #[test]
    fn cada_cifrado_usa_sal_e_iv_nuevos() {
        let a = encrypt_text(TEXT, PASS).unwrap();
        let b = encrypt_text(TEXT, PASS).unwrap();
        assert_ne!(a.cifrado.sal, b.cifrado.sal);
        assert_ne!(a.cifrado.iv, b.cifrado.iv);
        assert_ne!(a.datos, b.datos);
    }

    #[test]
    fn contrasena_erronea_vacia_o_con_otra_capitalizacion_da_el_mensaje_de_contrasena() {
        let env = encrypt_text(TEXT, PASS).unwrap();
        for mala in ["otra-contraseña", "", &PASS.to_uppercase(), &format!("{PASS} ")] {
            assert_eq!(abrir(&env, mala).unwrap_err(), WRONG_PASSWORD, "{mala:?}");
        }
    }

    #[test]
    fn un_byte_cambiado_en_los_datos_el_tag_el_iv_o_la_sal_se_rechaza() {
        let env = encrypt_text(TEXT, PASS).unwrap();
        let mut datos = env.clone();
        datos.datos = voltear(&env.datos, 0);
        let mut tag = env.clone();
        tag.cifrado.tag = voltear(&env.cifrado.tag, 3);
        let mut iv = env.clone();
        iv.cifrado.iv = voltear(&env.cifrado.iv, 0);
        let mut sal = env.clone();
        sal.cifrado.sal = voltear(&env.cifrado.sal, 0);
        for e in [datos, tag, iv, sal] {
            assert_eq!(abrir(&e, PASS).unwrap_err(), WRONG_PASSWORD);
        }
    }

    #[test]
    fn datos_truncados_o_con_bytes_de_mas_no_se_descifran() {
        let env = encrypt_text(TEXT, PASS).unwrap();
        let bytes = STANDARD.decode(&env.datos).unwrap();
        let mut corto = env.clone();
        corto.datos = STANDARD.encode(&bytes[..bytes.len() - 5]);
        let mut largo = env.clone();
        largo.datos = STANDARD.encode([bytes.as_slice(), b"x"].concat());
        assert_eq!(abrir(&corto, PASS).unwrap_err(), WRONG_PASSWORD);
        assert_eq!(abrir(&largo, PASS).unwrap_err(), WRONG_PASSWORD);
    }

    #[test]
    fn tag_iv_o_sal_truncados_se_detectan_como_archivo_danado() {
        let env = encrypt_text(TEXT, PASS).unwrap();
        let mut tag = env.clone();
        tag.cifrado.tag = recortar(&env.cifrado.tag, 8);
        let mut iv = env.clone();
        iv.cifrado.iv = recortar(&env.cifrado.iv, 8);
        let mut sal = env.clone();
        sal.cifrado.sal = recortar(&env.cifrado.sal, 4);
        assert!(abrir(&tag, PASS).unwrap_err().contains("dañado (tag)"));
        assert!(abrir(&iv, PASS).unwrap_err().contains("dañado (iv)"));
        assert!(abrir(&sal, PASS).unwrap_err().contains("dañado (sal)"));
    }

    #[test]
    fn campos_que_no_son_base64_o_no_son_texto_se_rechazan_como_danados() {
        let env = encrypt_text(TEXT, PASS).unwrap();
        let (c, _) = sobre(&env);
        for valor in [json!("no es base64!"), json!(""), json!(42), Value::Null, json!("====")] {
            let e = decrypt_text(&c, &valor, PASS).unwrap_err();
            assert!(e.contains("dañado (datos)"), "{valor}: {e}");
        }
    }

    #[test]
    fn algoritmo_o_kdf_desconocidos_o_sin_bloque_de_cifrado_no_los_reconoce_esta_version() {
        let env = encrypt_text(TEXT, PASS).unwrap();
        let (c, d) = sobre(&env);
        let mut algo = c.clone();
        algo["algoritmo"] = json!("aes-128-cbc");
        let mut kdf = c.clone();
        kdf["kdf"] = json!("pbkdf2");
        for malo in [algo, kdf, Value::Null, json!([])] {
            assert!(decrypt_text(&malo, &d, PASS).unwrap_err().contains("no lo reconoce"));
        }
    }

    #[test]
    fn parametros_de_scrypt_fuera_de_rango_se_rechazan_antes_de_gastar_memoria() {
        let env = encrypt_text(TEXT, PASS).unwrap();
        let (c, d) = sobre(&env);
        let casos = [("N", json!(1u64 << 20)), ("N", json!(1)), ("N", json!(1000.5)), ("N", json!("16384")), ("N", Value::Null), ("r", json!(0)), ("r", json!(1000)), ("p", json!(0)), ("p", json!(64))];
        for (k, v) in casos {
            let mut e = c.clone();
            e[k] = v.clone();
            assert!(decrypt_text(&e, &d, PASS).unwrap_err().contains("parámetros del cifrado"), "{k}={v}");
        }
    }

    #[test]
    fn un_n_que_no_es_potencia_de_dos_o_que_pasa_el_tope_de_memoria_falla_como_contrasena() {
        let env = encrypt_text(TEXT, PASS).unwrap();
        let (c, d) = sobre(&env);
        for (n, r) in [(1000, 8), (131_072, 16)] {
            let mut e = c.clone();
            e["N"] = json!(n);
            e["r"] = json!(r);
            assert_eq!(decrypt_text(&e, &d, PASS).unwrap_err(), WRONG_PASSWORD, "N={n} r={r}");
        }
    }

    #[test]
    fn un_n_entero_escrito_como_decimal_se_acepta_como_en_javascript() {
        let env = encrypt_text(TEXT, PASS).unwrap();
        let (mut c, d) = sobre(&env);
        c["N"] = serde_json::from_str("16384.0").unwrap();
        assert_eq!(decrypt_text(&c, &d, PASS).unwrap(), TEXT);
    }

    #[test]
    fn la_contrasena_minima_exigida_es_8() {
        assert_eq!(MIN_PASSWORD, 8);
    }

    #[test]
    fn texto_vacio_se_cifra_pero_no_se_descifra_igual_que_en_el_ts() {
        // En el TS esto es un `todo`: cifrar «» deja los datos vacíos y descifrar los rechaza como dañados.
        let env = encrypt_text("", PASS).unwrap();
        assert_eq!(env.datos, "");
        assert!(abrir(&env, PASS).unwrap_err().contains("dañado (datos)"));
    }

    #[test]
    fn el_relleno_de_mas_o_de_menos_en_base64_se_perdona_como_en_node() {
        let env = encrypt_text(TEXT, PASS).unwrap();
        let (c, d) = sobre(&env);
        let sin_relleno = d.as_str().unwrap().trim_end_matches('=').to_string();
        assert_eq!(decrypt_text(&c, &json!(sin_relleno), PASS).unwrap(), TEXT);
        let de_mas = format!("{sin_relleno}==");
        assert_eq!(decrypt_text(&c, &json!(de_mas), PASS).unwrap(), TEXT);
    }

    // Los fixtures los generó Node real (scripts de la rama, con la sal y el iv fijos) y el export-crypto.ts los descifró.
    const DEFAULT_SLOTH: &str = include_str!("../../fixtures/export/default.sloth");
    const DEFAULT_PLANO: &str = include_str!("../../fixtures/export/default.plano.json");
    const PARAMS_SLOTH: &str = include_str!("../../fixtures/export/params.sloth");
    const PARAMS_PLANO: &str = include_str!("../../fixtures/export/params.plano.json");

    fn abrir_archivo(archivo: &str, pass: &str) -> Result<String, String> {
        let v: Value = serde_json::from_str(archivo).unwrap();
        decrypt_text(&v["cifrado"], &v["datos"], pass)
    }

    #[test]
    fn descifra_el_archivo_que_hizo_node_con_los_parametros_de_siempre() {
        assert_eq!(abrir_archivo(DEFAULT_SLOTH, "contraseña-larga").unwrap(), DEFAULT_PLANO);
    }

    #[test]
    fn descifra_el_archivo_que_hizo_node_con_otros_parametros_de_scrypt_y_otra_sal() {
        assert_eq!(abrir_archivo(PARAMS_SLOTH, "clave ñandú ✓ 12345").unwrap(), PARAMS_PLANO);
    }

    #[test]
    fn el_archivo_de_node_con_otra_contrasena_da_el_mensaje_de_contrasena() {
        assert_eq!(abrir_archivo(DEFAULT_SLOTH, "contraseña-larga ").unwrap_err(), WRONG_PASSWORD);
        assert_eq!(abrir_archivo(PARAMS_SLOTH, "contraseña-larga").unwrap_err(), WRONG_PASSWORD);
    }

    #[test]
    fn cifrar_con_la_sal_y_el_iv_del_fixture_da_los_mismos_bytes_que_node() {
        let v: Value = serde_json::from_str(DEFAULT_SLOTH).unwrap();
        let sal: [u8; 16] = STANDARD.decode(v["cifrado"]["sal"].as_str().unwrap()).unwrap().try_into().unwrap();
        let iv: [u8; 12] = STANDARD.decode(v["cifrado"]["iv"].as_str().unwrap()).unwrap().try_into().unwrap();
        let e = encrypt_text_con(DEFAULT_PLANO, "contraseña-larga", &sal, &iv);
        let (c, d) = sobre(&e);
        assert_eq!(c, v["cifrado"]);
        assert_eq!(d, v["datos"]);
    }
}
