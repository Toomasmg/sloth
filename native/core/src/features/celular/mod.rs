//! Función «celular»: un visor en el celu con las sesiones, el uso de cada cuenta y, si se deja, aprobar permisos y abrir
//! las terminales. Equivale a `src/main/features/celular*.ts`. Lo puro (sellos, validación, estado, acceso, esperas) vive
//! en módulos que se prueban solos; lo que toca Electron o el SO entra por `contexto::ContextoCelular`, que acá no se implementa.
pub mod acceso;
pub mod actividad;
pub mod conexiones;
pub mod config;
pub mod contexto;
pub mod core;
pub mod escrituras;
pub mod espera;
pub mod limite;
pub mod pagina;
pub mod remoto_core;
pub mod sello;
pub mod servidor;
pub mod terminal_core;
pub mod tipos;

use std::time::{SystemTime, UNIX_EPOCH};

/// Milisegundos desde 1970, como `Date.now()`.
pub fn ahora_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// `s.length` de JavaScript: unidades UTF-16.
pub(crate) fn largo_utf16(s: &str) -> usize {
    s.encode_utf16().count()
}

pub(crate) use super::cortar_utf16;

#[cfg(test)]
pub(crate) mod pruebas {
    use super::sello::codificar;

    use super::core::ClasificadorPermisos;
    use serde_json::{Map, Value};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// `Buffer.alloc(32, v).toString('base64url')`
    pub fn clave_de(v: u8) -> String {
        codificar(&[v; 32])
    }

    pub fn carpeta_temporal(nombre: &str) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let d = std::env::temp_dir().join(format!("sloth-celular-rs-{nombre}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        std::fs::create_dir_all(&d).expect("carpeta temporal");
        d
    }

    /// Un reemplazo mínimo de `permissions-core.ts` (que todavía no está en Rust) con lo que usan los tests de acá.
    pub struct FalsoPermisos;

    fn texto<'a>(input: &'a Map<String, Value>, k: &str) -> &'a str {
        input.get(k).and_then(Value::as_str).unwrap_or("")
    }

    impl ClasificadorPermisos for FalsoPermisos {
        fn clase(&self, tool: &str) -> String {
            match tool {
                "Bash" => "cmd",
                "Edit" | "Write" => "edit",
                "WebFetch" | "WebSearch" => "net",
                _ => "other",
            }
            .into()
        }
        fn etiqueta(&self, clase: &str, _tool: &str, input: &Map<String, Value>) -> String {
            match clase {
                "cmd" => texto(input, "command").into(),
                "edit" => format!("Editar {}", texto(input, "file_path")),
                "net" => format!("Acceder a {}", texto(input, "url").trim_start_matches("https://").split('/').next().unwrap_or("")),
                _ => String::new(),
            }
        }
        fn titulo(&self, clase: &str, _tool: &str, _input: &Map<String, Value>) -> String {
            match clase {
                "cmd" => "Claude quiere ejecutar un comando",
                "edit" => "Claude quiere editar un archivo",
                _ => "Claude quiere usar una herramienta",
            }
            .into()
        }
        fn destructivo(&self, clase: &str, input: &Map<String, Value>) -> Option<String> {
            let c = texto(input, "command");
            (clase == "cmd" && (c.contains("rm -rf") || c.contains("push --force"))).then(|| "borra o pisa sin vuelta atrás".to_string())
        }
    }
}
