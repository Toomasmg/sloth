//! Handlers de Rust del router: un archivo por función. Cada una lista sus canales en `CANALES` para que el proceso
//! de apoyo no la registre (lo avisa `SLOTH_RUST_FEATURES`, ver `funciones_en_rust`).
use crate::entorno::Entorno;
use crate::router::{Respuesta, Router};
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;

pub mod git;
pub mod help;
pub mod report;
pub mod team_config;

static NULO: Value = Value::Null;

/// El argumento `i` del pedido de la UI, o `null` si no vino: los argumentos llegan sin validar.
pub fn arg(args: &[Value], i: usize) -> &Value {
    args.get(i).unwrap_or(&NULO)
}

pub fn a_json<T: Serialize>(r: Result<T, String>) -> Respuesta {
    r.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

/// Las funciones del lado main que atiende Rust. El proceso de apoyo no las registra ni las corre.
pub const FUNCIONES_EN_RUST: &[&str] = &[git::NOMBRE, help::NOMBRE, report::NOMBRE, team_config::NOMBRE];

pub fn funciones_en_rust() -> String {
    FUNCIONES_EN_RUST.join(",")
}

pub fn registrar_todo(router: &mut Router, entorno: &Arc<Entorno>) -> Vec<Arc<dyn AlHook>> {
    help::registrar(router, entorno.clone());
    report::registrar(router, entorno.clone());
    team_config::registrar(router, entorno.clone());
    vec![git::registrar(router, entorno.clone())]
}

/// Lo que el proceso de apoyo reenvía de sus hooks de Claude a las funciones que pasaron a Rust.
pub trait AlHook: Send + Sync {
    fn al_hook(&self, evento: &str, ws: Option<&str>);
}
