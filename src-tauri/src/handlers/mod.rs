//! Handlers de Rust del router: un archivo por función. Cada una lista sus canales en `CANALES` para que el proceso
//! de apoyo no la registre (lo avisa `SLOTH_RUST_FEATURES`, ver `funciones_en_rust`).
use crate::entorno::Entorno;
use crate::router::{Respuesta, Router};
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;

pub mod chat;
pub mod comun;
pub mod dictado;
pub mod export_import;
pub mod git;
pub mod help;
pub mod history;
pub mod onboarding;
pub mod prs;
pub mod report;
pub mod team;
pub mod team_config;
pub mod templates;
pub mod tickets;
pub mod tray;
pub mod updater;
pub mod worktrees;

static NULO: Value = Value::Null;

/// El argumento `i` del pedido de la UI, o `null` si no vino: los argumentos llegan sin validar.
pub fn arg(args: &[Value], i: usize) -> &Value {
    args.get(i).unwrap_or(&NULO)
}

pub fn a_json<T: Serialize>(r: Result<T, String>) -> Respuesta {
    r.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

/// Las funciones del lado main que atiende Rust. El proceso de apoyo no las registra ni las corre.
pub const FUNCIONES_EN_RUST: &[&str] = &[git::NOMBRE, help::NOMBRE, report::NOMBRE, team_config::NOMBRE, prs::NOMBRE, chat::NOMBRE, history::NOMBRE, templates::NOMBRE, worktrees::NOMBRE, dictado::NOMBRE, export_import::NOMBRE, onboarding::NOMBRE, tickets::NOMBRE, team::NOMBRE, tray::NOMBRE, updater::NOMBRE];

pub fn funciones_en_rust() -> String {
    FUNCIONES_EN_RUST.join(",")
}

pub fn registrar_todo(router: &mut Router, entorno: &Arc<Entorno>) -> Vec<Arc<dyn AlHook>> {
    help::registrar(router, entorno.clone());
    report::registrar(router, entorno.clone());
    team_config::registrar(router, entorno.clone());
    history::registrar(router, entorno.clone());
    templates::registrar(router, entorno.clone());
    worktrees::registrar(router, entorno.clone());
    dictado::registrar(router, entorno.clone());
    export_import::registrar(router, entorno.clone());
    onboarding::registrar(router, entorno.clone());
    // Equipo arma su vista con lo que Tickets tiene en memoria: van juntas.
    let t = tickets::registrar(router, entorno.clone());
    team::registrar(router, entorno.clone(), t.clone());
    vec![git::registrar(router, entorno.clone()), prs::registrar(router, entorno.clone()), chat::registrar(router, entorno.clone()), t as Arc<dyn AlHook>]
}

/// Lo que el proceso de apoyo reenvía de sus hooks de Claude a las funciones que pasaron a Rust.
pub trait AlHook: Send + Sync {
    fn al_hook(&self, evento: &str, ws: Option<&str>);

    /// La ventana principal tomó el foco (prs refresca si su vista está abierta).
    fn al_enfocar(&self) {}

    /// Lo que pasa en lo que todavía es de otro dueño: `cuentaPreparada` y `cuentaBorrada` (con la cuenta) y
    /// `terminalCerrada`. Llega por el puente (`rust.evento`) desde quien sea el dueño de cuentas y terminales.
    fn al_evento(&self, _evento: &str, _datos: &Value) {}

    /// Pasó un evento hacia la UI (`agent:status`, `permission:new`...), venga de Rust o del proceso de apoyo.
    fn al_evento_ui(&self, _canal: &str) {}

    /// Un pedido `rust.<algo>` del proceso de apoyo para esta función; `None` si no es suyo.
    fn nativo(&self, _op: &str, _args: &[Value]) -> Option<Respuesta> {
        None
    }

    /// Al salir de la app.
    fn al_salir(&self) {}

    /// El proceso de apoyo avisó la carpeta del perfil: lo que la UI pidió antes recibió «Sloth todavía está arrancando.»
    /// y una función que la UI carga una sola vez al abrir le manda ahora su estado.
    fn al_perfil(&self) {}
}
