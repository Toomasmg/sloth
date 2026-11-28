//! Lo que el proceso de apoyo le pide al dueño del estado (`rust.*` en el puente nativo): las escrituras del store
//! (`rust.store`), de la Configuración (`rust.ajustes`) y lo demás del núcleo (`rust.nucleo`).
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

pub fn atender(app: &AppHandle, op: &str, args: &[Value]) -> Result<Value, String> {
    let n = app.try_state::<Arc<crate::nucleo::Nucleo>>().ok_or("el núcleo de Rust no está listo")?;
    crate::handlers_estado::atender_apoyo(&n, op, args)
}
