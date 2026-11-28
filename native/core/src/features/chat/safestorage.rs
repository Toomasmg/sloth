//! `safeStorage` de Electron en Windows, byte a byte, para que una sesión que dejó la versión Electron se siga leyendo
//! (y al revés). Es el esquema de Chromium (`os_crypt`):
//!  - `<userData>/Local State` (JSON) guarda `os_crypt.encrypted_key` = base64("DPAPI" + DPAPI(clave de 32 bytes)).
//!  - Cada valor cifrado es `"v10" + nonce(12) + AES-256-GCM(clave, nonce, plano) + tag(16)`, sin datos asociados.
//!  - Un valor sin prefijo `v10` es el formato viejo: DPAPI directo sobre el texto.
//! El formato es puro y se prueba con una `Proteccion` falsa; la real es `DpapiWindows` (CryptProtectData). En macOS y
//! Linux no hay implementación todavía (Keychain y libsecret): ahí la sesión no se guarda entre reinicios, igual que con
//! `isEncryptionAvailable() == false` en Electron. Es la brecha conocida de este módulo.
use super::sesion::AlmacenSecreto;
use super::Res;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;

const PREFIJO_VALOR: &[u8] = b"v10";
const PREFIJO_CLAVE: &[u8] = b"DPAPI";
const NONCE: usize = 12;
const TAG: usize = 16;

/// Protección del SO de una clave: DPAPI en Windows.
pub trait Proteccion: Send + Sync {
    fn proteger(&self, plano: &[u8]) -> Res<Vec<u8>>;
    fn desproteger(&self, protegido: &[u8]) -> Res<Vec<u8>>;
}

pub struct SafeStorage<P: Proteccion> {
    local_state: PathBuf,
    prot: P,
    clave: Mutex<Option<[u8; 32]>>,
}

impl<P: Proteccion> SafeStorage<P> {
    /// `local_state` es `<userData>/Local State`: el mismo archivo que usa Electron.
    pub fn nuevo(local_state: PathBuf, prot: P) -> Self {
        SafeStorage { local_state, prot, clave: Mutex::new(None) }
    }

    fn leer_local_state(&self) -> Res<Value> {
        match std::fs::read_to_string(&self.local_state) {
            Ok(t) => serde_json::from_str::<Value>(t.trim_start_matches('\u{feff}')).ok().filter(Value::is_object).ok_or_else(|| "Local State ilegible".to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
            Err(e) => Err(e.to_string()),
        }
    }

    fn clave_guardada(&self, ls: &Value) -> Res<Option<[u8; 32]>> {
        let Some(b64) = ls.pointer("/os_crypt/encrypted_key").and_then(Value::as_str) else { return Ok(None) };
        let crudo = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| "clave de Local State inválida".to_string())?;
        let protegido = crudo.strip_prefix(PREFIJO_CLAVE).ok_or("clave de Local State sin prefijo DPAPI")?;
        self.prot.desproteger(protegido)?.try_into().map(Some).map_err(|_| "la clave de Local State no mide 32 bytes".to_string())
    }

    /// Lee la clave o, si Local State no tiene una, crea una y la guarda sin perder el resto del archivo. Un Local State que
    /// existe pero no se puede leer NO se pisa: es de Electron (o de Chromium) y la sesión quedaría ilegible.
    fn clave(&self) -> Res<[u8; 32]> {
        let mut c = self.clave.lock().unwrap();
        if let Some(k) = *c {
            return Ok(k);
        }
        let mut ls = self.leer_local_state()?;
        let k = match self.clave_guardada(&ls)? {
            Some(k) => k,
            None => {
                let mut k = [0u8; 32];
                getrandom::getrandom(&mut k).map_err(|e| e.to_string())?;
                let mut envuelta = PREFIJO_CLAVE.to_vec();
                envuelta.extend(self.prot.proteger(&k)?);
                let obj = ls.as_object_mut().expect("Local State es un objeto");
                let crypt = obj.entry("os_crypt").or_insert_with(|| json!({}));
                if !crypt.is_object() {
                    *crypt = json!({});
                }
                crypt["encrypted_key"] = json!(base64::engine::general_purpose::STANDARD.encode(envuelta));
                self.guardar_local_state(&ls)?;
                k
            }
        };
        *c = Some(k);
        Ok(k)
    }

    fn guardar_local_state(&self, ls: &Value) -> Res<()> {
        if let Some(d) = self.local_state.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        let tmp = self.local_state.with_extension(format!("{}.tmp", std::process::id()));
        std::fs::write(&tmp, serde_json::to_string(ls).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.local_state).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        })
    }
}

impl<P: Proteccion> AlmacenSecreto for SafeStorage<P> {
    fn disponible(&self) -> bool {
        self.clave().is_ok()
    }

    fn cifrar(&self, plano: &str) -> Res<Vec<u8>> {
        let k = self.clave()?;
        let mut nonce = [0u8; NONCE];
        getrandom::getrandom(&mut nonce).map_err(|e| e.to_string())?;
        let ct = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&k)).encrypt(Nonce::from_slice(&nonce), plano.as_bytes()).map_err(|_| "no se pudo cifrar".to_string())?;
        let mut out = PREFIJO_VALOR.to_vec();
        out.extend(nonce);
        out.extend(ct);
        Ok(out)
    }

    fn descifrar(&self, cifrado: &[u8]) -> Res<String> {
        let Some(resto) = cifrado.strip_prefix(PREFIJO_VALOR) else {
            let plano = self.prot.desproteger(cifrado)?;
            return String::from_utf8(plano).map_err(|_| "texto inválido".to_string());
        };
        if resto.len() < NONCE + TAG {
            return Err("valor cifrado demasiado corto".into());
        }
        let (nonce, ct) = resto.split_at(NONCE);
        let k = self.clave()?;
        let plano = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&k)).decrypt(Nonce::from_slice(nonce), ct).map_err(|_| "no se pudo descifrar".to_string())?;
        String::from_utf8(plano).map_err(|_| "texto inválido".to_string())
    }
}

#[cfg(windows)]
pub use dpapi::DpapiWindows;

#[cfg(windows)]
mod dpapi {
    use super::{Proteccion, Res};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};

    /// DPAPI con el contexto del usuario actual, sin entropía extra ni interfaz (como Chromium).
    pub struct DpapiWindows;

    fn con_blob(datos: &[u8], f: impl FnOnce(*const CRYPT_INTEGER_BLOB, *mut CRYPT_INTEGER_BLOB) -> i32) -> Res<Vec<u8>> {
        let entrada = CRYPT_INTEGER_BLOB { cbData: datos.len() as u32, pbData: datos.as_ptr() as *mut u8 };
        let mut salida = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        if f(&entrada, &mut salida) == 0 || salida.pbData.is_null() {
            return Err("DPAPI falló".into());
        }
        // SAFETY: DPAPI llenó `salida` con un buffer de `cbData` bytes que hay que liberar con LocalFree.
        let v = unsafe { std::slice::from_raw_parts(salida.pbData, salida.cbData as usize).to_vec() };
        unsafe { LocalFree(salida.pbData as _) };
        Ok(v)
    }

    impl Proteccion for DpapiWindows {
        fn proteger(&self, plano: &[u8]) -> Res<Vec<u8>> {
            // SAFETY: los punteros salen de blobs vivos durante la llamada; el resto son nulos permitidos.
            con_blob(plano, |e, s| unsafe { CryptProtectData(e, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, s) })
        }

        fn desproteger(&self, protegido: &[u8]) -> Res<Vec<u8>> {
            // SAFETY: igual que arriba.
            con_blob(protegido, |e, s| unsafe { CryptUnprotectData(e, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, s) })
        }
    }

    #[test]
    fn dpapi_va_y_vuelve() {
        let p = DpapiWindows.proteger(b"secreto").unwrap();
        assert_ne!(p, b"secreto");
        assert_eq!(DpapiWindows.desproteger(&p).unwrap(), b"secreto");
        assert!(DpapiWindows.desproteger(b"basura").is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::chat::sesion::pruebas::carpeta;

    /// Envuelve con un byte fijo: reversible y distinto del plano.
    struct Falsa;
    impl Proteccion for Falsa {
        fn proteger(&self, p: &[u8]) -> Res<Vec<u8>> {
            Ok(p.iter().map(|b| b ^ 0xa5).collect())
        }
        fn desproteger(&self, p: &[u8]) -> Res<Vec<u8>> {
            if p == b"basura" {
                return Err("no es mío".into());
            }
            Ok(p.iter().map(|b| b ^ 0xa5).collect())
        }
    }

    #[test]
    fn crea_la_clave_en_local_state_y_conserva_lo_que_ya_tenia() {
        let d = carpeta("ss-1");
        let ls = d.join("Local State");
        std::fs::write(&ls, r#"{"browser":{"x":1},"os_crypt":{"otro":true}}"#).unwrap();
        let s = SafeStorage::nuevo(ls.clone(), Falsa);
        assert!(s.disponible());
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&ls).unwrap()).unwrap();
        assert_eq!(v["browser"]["x"], 1);
        assert_eq!(v["os_crypt"]["otro"], true);
        let crudo = base64::engine::general_purpose::STANDARD.decode(v["os_crypt"]["encrypted_key"].as_str().unwrap()).unwrap();
        assert!(crudo.starts_with(b"DPAPI"));
        assert_eq!(crudo.len(), 5 + 32);
    }

    #[test]
    fn el_valor_cifrado_tiene_el_formato_de_electron() {
        let d = carpeta("ss-2");
        let s = SafeStorage::nuevo(d.join("Local State"), Falsa);
        let c = s.cifrar("hola").unwrap();
        assert!(c.starts_with(b"v10"));
        assert_eq!(c.len(), 3 + 12 + 4 + 16);
        assert_eq!(s.descifrar(&c).unwrap(), "hola");
        assert_ne!(s.cifrar("hola").unwrap(), c, "el nonce cambia en cada cifrado");
    }

    #[test]
    fn lee_lo_que_cifro_otra_instancia_con_la_misma_clave() {
        let d = carpeta("ss-3");
        let ls = d.join("Local State");
        let c = SafeStorage::nuevo(ls.clone(), Falsa).cifrar("de Electron").unwrap();
        assert_eq!(SafeStorage::nuevo(ls, Falsa).descifrar(&c).unwrap(), "de Electron");
    }

    #[test]
    fn descifra_un_vector_armado_a_mano_como_lo_hace_chromium() {
        let d = carpeta("ss-4");
        let ls = d.join("Local State");
        let clave = [7u8; 32];
        let envuelta: Vec<u8> = b"DPAPI".iter().copied().chain(Falsa.proteger(&clave).unwrap()).collect();
        std::fs::write(&ls, json!({"os_crypt": {"encrypted_key": base64::engine::general_purpose::STANDARD.encode(envuelta)}}).to_string()).unwrap();
        let nonce = [1u8; 12];
        let ct = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&clave)).encrypt(Nonce::from_slice(&nonce), b"{\"k\":\"v\"}".as_ref()).unwrap();
        let mut valor = b"v10".to_vec();
        valor.extend(nonce);
        valor.extend(ct);
        assert_eq!(SafeStorage::nuevo(ls, Falsa).descifrar(&valor).unwrap(), "{\"k\":\"v\"}");
    }

    #[test]
    fn sin_prefijo_es_dpapi_directo_y_lo_que_no_sirve_falla() {
        let d = carpeta("ss-5");
        let s = SafeStorage::nuevo(d.join("Local State"), Falsa);
        assert_eq!(s.descifrar(&Falsa.proteger(b"viejo").unwrap()).unwrap(), "viejo");
        assert!(s.descifrar(b"basura").is_err());
        assert!(s.descifrar(b"v10corto").is_err());
        let mut c = s.cifrar("x").unwrap();
        let n = c.len();
        c[n - 1] ^= 1;
        assert!(s.descifrar(&c).is_err(), "el tag protege de cambios");
    }

    #[test]
    fn un_local_state_ilegible_no_se_pisa() {
        let d = carpeta("ss-6");
        let ls = d.join("Local State");
        std::fs::write(&ls, "{ roto").unwrap();
        let s = SafeStorage::nuevo(ls.clone(), Falsa);
        assert!(!s.disponible());
        assert_eq!(std::fs::read_to_string(&ls).unwrap(), "{ roto");
    }
}
