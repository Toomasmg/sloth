//! Sesión del chat: almacenamiento clave/valor en memoria que se persiste en `userData/features/chat-session.bin`
//! cifrado con el secreto del sistema. Si el cifrado no está disponible NO se persiste nada (la sesión dura lo que la
//! app). Nunca se loguean valores. Equivale a chat-session.ts; el formato de las claves (`sb-…-auth-token`) es el de
//! supabase-js, así que una sesión que dejó la versión Electron se lee igual.
use super::Res;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// `safeStorage` de Electron. El archivo cifrado es de quien implemente esto: `safestorage::SafeStorageWindows` replica el
/// formato de Electron en Windows; otras plataformas todavía no tienen implementación (ver docs del módulo).
pub trait AlmacenSecreto: Send + Sync {
    fn disponible(&self) -> bool;
    fn cifrar(&self, plano: &str) -> Res<Vec<u8>>;
    fn descifrar(&self, cifrado: &[u8]) -> Res<String>;
}

const MAX_ARCHIVO: usize = 256 * 1024;
const SUFIJO_VERIFICADOR: &str = "-code-verifier";

type Log = Box<dyn Fn(&str) + Send + Sync>;

pub struct Sesion {
    archivo: PathBuf,
    almacen: Arc<dyn AlmacenSecreto>,
    mapa: Mutex<BTreeMap<String, String>>,
    persistente: bool,
    log: Log,
}

fn quitar(archivo: &Path) {
    let _ = std::fs::remove_file(archivo);
}

impl Sesion {
    pub fn abrir(archivo: &Path, almacen: Arc<dyn AlmacenSecreto>, log: impl Fn(&str) + Send + Sync + 'static) -> Self {
        let persistente = almacen.disponible();
        if !persistente {
            log("chat: el cifrado del sistema no está disponible; la sesión de chat no se guarda entre reinicios.");
        }
        let s = Sesion { archivo: archivo.to_path_buf(), almacen, mapa: Mutex::new(BTreeMap::new()), persistente, log: Box::new(log) };
        if persistente && archivo.exists() {
            match s.leer() {
                Ok(m) => *s.mapa.lock().unwrap() = m,
                Err(_) => {
                    (s.log)("chat: la sesión guardada no se pudo leer; hay que volver a iniciar sesión.");
                    quitar(archivo);
                }
            }
        }
        s
    }

    fn leer(&self) -> Res<BTreeMap<String, String>> {
        let datos = std::fs::read(&self.archivo).map_err(|e| e.to_string())?;
        if datos.len() > MAX_ARCHIVO {
            return Err("demasiado grande".into());
        }
        let plano = self.almacen.descifrar(&datos)?;
        let v: serde_json::Value = serde_json::from_str(&plano).map_err(|e| e.to_string())?;
        let obj = v.as_object().ok_or("no es un objeto")?;
        Ok(obj.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
    }

    /// Guarda con tmp más rename. Con el mapa vacío borra el archivo.
    fn persistir(&self, m: &BTreeMap<String, String>) {
        if !self.persistente {
            return;
        }
        if m.is_empty() {
            return quitar(&self.archivo);
        }
        let guardar = || -> Res<()> {
            if let Some(d) = self.archivo.parent() {
                std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
            }
            let cifrado = self.almacen.cifrar(&serde_json::to_string(m).map_err(|e| e.to_string())?)?;
            let tmp = self.archivo.with_extension(format!("bin.{}.tmp", std::process::id()));
            std::fs::write(&tmp, cifrado).map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, &self.archivo).map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                e.to_string()
            })
        };
        if guardar().is_err() {
            (self.log)("chat: no se pudo guardar la sesión de chat.");
        }
    }

    pub fn persistente(&self) -> bool {
        self.persistente
    }

    pub fn get_item(&self, clave: &str) -> Option<String> {
        self.mapa.lock().unwrap().get(clave).cloned()
    }

    pub fn set_item(&self, clave: &str, valor: &str) {
        let mut m = self.mapa.lock().unwrap();
        m.insert(clave.to_string(), valor.to_string());
        self.persistir(&m);
    }

    pub fn remove_item(&self, clave: &str) {
        let mut m = self.mapa.lock().unwrap();
        m.remove(clave);
        self.persistir(&m);
    }

    pub fn tamano(&self) -> usize {
        self.mapa.lock().unwrap().len()
    }

    /// Olvida la sesión en memoria y borra el archivo.
    pub fn limpiar(&self) {
        self.mapa.lock().unwrap().clear();
        quitar(&self.archivo);
    }

    /// Copia los `code_verifier` de PKCE y devuelve con qué volver a ponerlos: GoTrue los borra tras cada canje, salga bien
    /// o mal, y un `code` inventado que llega antes que el bueno no puede dejar sin verifier al canje legítimo.
    pub fn preservar_verificador(self: &Arc<Self>) -> Box<dyn FnOnce() + Send> {
        let copia: Vec<(String, String)> = self.mapa.lock().unwrap().iter().filter(|(k, _)| k.ends_with(SUFIJO_VERIFICADOR)).map(|(k, v)| (k.clone(), v.clone())).collect();
        let s = self.clone();
        Box::new(move || {
            let mut m = s.mapa.lock().unwrap();
            let mut cambio = false;
            for (k, v) in copia {
                if m.get(&k) == Some(&v) {
                    continue;
                }
                m.insert(k, v);
                cambio = true;
            }
            if cambio {
                s.persistir(&m);
            }
        })
    }
}

#[cfg(test)]
pub mod pruebas {
    use super::*;

    /// Cifrado de mentira reversible (XOR): alcanza para probar el flujo sin tocar el SO.
    pub struct AlmacenFalso(pub bool);
    impl AlmacenSecreto for AlmacenFalso {
        fn disponible(&self) -> bool {
            self.0
        }
        fn cifrar(&self, plano: &str) -> Res<Vec<u8>> {
            Ok(plano.bytes().map(|b| b ^ 0x5a).collect())
        }
        fn descifrar(&self, c: &[u8]) -> Res<String> {
            String::from_utf8(c.iter().map(|b| b ^ 0x5a).collect()).map_err(|_| "basura".to_string())
        }
    }

    pub fn carpeta(n: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sloth-chat-{n}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn abrir(archivo: &Path, hay_cifrado: bool) -> Arc<Sesion> {
        Arc::new(Sesion::abrir(archivo, Arc::new(AlmacenFalso(hay_cifrado)), |_| {}))
    }

    #[test]
    fn lo_que_se_guarda_vuelve_despues_de_reabrir_y_va_cifrado() {
        let d = carpeta("ses-1");
        let f = d.join("features").join("chat-session.bin");
        let s = abrir(&f, true);
        s.set_item("sb-x-auth-token", "{\"a\":1}");
        s.set_item("sloth:owner", "id");
        let crudo = std::fs::read(&f).unwrap();
        assert!(!String::from_utf8_lossy(&crudo).contains("sb-x-auth-token"));
        let otra = abrir(&f, true);
        assert_eq!(otra.get_item("sb-x-auth-token").as_deref(), Some("{\"a\":1}"));
        assert_eq!(otra.tamano(), 2);
        otra.remove_item("sloth:owner");
        assert_eq!(abrir(&f, true).tamano(), 1);
    }

    #[test]
    fn sin_cifrado_no_se_escribe_nada() {
        let d = carpeta("ses-2");
        let f = d.join("chat-session.bin");
        let s = abrir(&f, false);
        assert!(!s.persistente());
        s.set_item("k", "v");
        assert_eq!(s.get_item("k").as_deref(), Some("v"));
        assert!(!f.exists());
    }

    #[test]
    fn un_archivo_ilegible_se_descarta() {
        let d = carpeta("ses-3");
        let f = d.join("chat-session.bin");
        std::fs::write(&f, [0xffu8, 0x00, 0x01]).unwrap();
        let s = abrir(&f, true);
        assert_eq!(s.tamano(), 0);
        assert!(!f.exists());
    }

    #[test]
    fn un_archivo_demasiado_grande_se_descarta() {
        let d = carpeta("ses-4");
        let f = d.join("chat-session.bin");
        std::fs::write(&f, vec![b'a'; MAX_ARCHIVO + 1]).unwrap();
        assert_eq!(abrir(&f, true).tamano(), 0);
        assert!(!f.exists());
    }

    #[test]
    fn solo_se_conservan_los_valores_de_texto() {
        let d = carpeta("ses-5");
        let f = d.join("chat-session.bin");
        let plano = serde_json::json!({"a": "x", "b": 3, "c": null}).to_string();
        std::fs::write(&f, AlmacenFalso(true).cifrar(&plano).unwrap()).unwrap();
        let s = abrir(&f, true);
        assert_eq!((s.tamano(), s.get_item("a").as_deref()), (1, Some("x")));
    }

    #[test]
    fn limpiar_borra_memoria_y_archivo() {
        let d = carpeta("ses-6");
        let f = d.join("chat-session.bin");
        let s = abrir(&f, true);
        s.set_item("k", "v");
        s.limpiar();
        assert_eq!(s.tamano(), 0);
        assert!(!f.exists());
    }

    #[test]
    fn el_verificador_de_pkce_se_restaura_tras_un_canje_fallido() {
        let d = carpeta("ses-7");
        let s = abrir(&d.join("chat-session.bin"), true);
        s.set_item("sb-x-auth-token-code-verifier", "v1");
        s.set_item("otro", "z");
        let restaurar = s.preservar_verificador();
        s.remove_item("sb-x-auth-token-code-verifier");
        assert_eq!(s.get_item("sb-x-auth-token-code-verifier"), None);
        restaurar();
        assert_eq!(s.get_item("sb-x-auth-token-code-verifier").as_deref(), Some("v1"));
        assert_eq!(abrir(&d.join("chat-session.bin"), true).get_item("sb-x-auth-token-code-verifier").as_deref(), Some("v1"));
    }

    #[test]
    fn restaurar_no_pisa_un_verificador_nuevo_igual_al_guardado() {
        let d = carpeta("ses-8");
        let s = abrir(&d.join("chat-session.bin"), true);
        s.set_item("a-code-verifier", "v1");
        let restaurar = s.preservar_verificador();
        restaurar();
        assert_eq!(s.tamano(), 1);
    }
}
