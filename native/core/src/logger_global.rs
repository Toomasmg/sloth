//! El logger de todo el proceso. Equivale a src/main/logger-global.ts: quien lo usa no necesita saber si ya se inició;
//! antes de `iniciar_logger` solo guarda en memoria.
use crate::logger::{EntradaLog, Logger, OpcionesLogger, Redactor};
use std::fmt::Display;
use std::path::Path;
use std::sync::{Arc, OnceLock, RwLock};

fn actual() -> &'static RwLock<Arc<Logger>> {
    static ACTUAL: OnceLock<RwLock<Arc<Logger>>> = OnceLock::new();
    ACTUAL.get_or_init(|| {
        let mut o = OpcionesLogger::nuevas("", Box::new(|s| s.to_string()));
        o.solo_memoria = true;
        RwLock::new(Arc::new(Logger::nuevo(o)))
    })
}

fn logger() -> Arc<Logger> {
    Arc::clone(&actual().read().unwrap_or_else(|p| p.into_inner()))
}

/// `dir` es `<userData>/logs`. Lo que se anotó antes de iniciar queda en el buffer del logger anterior y no se copia.
pub fn iniciar_logger(dir: &Path, redactar: Redactor) {
    *actual().write().unwrap_or_else(|p| p.into_inner()) = Arc::new(Logger::nuevo(OpcionesLogger::nuevas(dir, redactar)));
}

pub fn error(origen: &str, e: impl Display) {
    logger().error(origen, e);
}

pub fn aviso(origen: &str, msg: &str) {
    logger().aviso(origen, msg);
}

pub fn info(origen: &str, msg: &str) {
    logger().info(origen, msg);
}

pub fn recientes(n: usize) -> Vec<EntradaLog> {
    logger().recientes(n)
}

pub fn fallo() -> Option<String> {
    logger().fallo()
}

#[cfg(test)]
mod tests {
    use super::*;

    // El logger es global: un solo test para que no se pisen entre hilos.
    #[test]
    fn antes_de_iniciar_solo_memoria_y_despues_escribe_en_el_archivo() {
        info("antes", "en memoria");
        assert!(recientes(1000).iter().any(|e| e.origen == "antes"));
        let dir = std::env::temp_dir().join(format!("sloth-logger-global-rs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        iniciar_logger(&dir.join("logs"), Box::new(|s| s.to_string()));
        aviso("despues", "en disco");
        let texto = std::fs::read_to_string(dir.join("logs").join("sloth.log")).unwrap();
        assert!(texto.contains("aviso [despues] en disco"), "{texto}");
        assert!(recientes(1000).iter().all(|e| e.origen != "antes"));
        assert_eq!(fallo(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
