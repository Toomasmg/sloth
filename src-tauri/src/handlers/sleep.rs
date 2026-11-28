//! Despertar un espacio dormido (`feat:sleep:wake`), como src/main/features/sleep.ts. Dormir lo decide el núcleo
//! (`nucleo/dormir.rs`), que tiene los hooks, las escrituras y las terminales.
use super::arg;
use crate::nucleo::arranque::ahora_ms;
use crate::nucleo::Nucleo;
use crate::router::Router;
use serde_json::{json, Value};
use sloth_core::agent_machine::EstadoAgente;
use sloth_core::app_state::EstadoDeAgente;
use sloth_core::features::sleep::validar_despertar;
use std::sync::Arc;

pub use crate::nucleo::dormir::NOMBRE;

pub fn registrar(router: &mut Router, nucleo: &Arc<Nucleo>) {
    let n = nucleo.clone();
    router.registrar("feat:sleep:wake", move |a| {
        let id = validar_despertar(arg(&a, 0), |x| n.espacio(x).is_some())?;
        // Si la terminal no llegó a cerrarse, se reconecta tal cual: ya no hay nada que retomar.
        let viva = n.terminales_si_hay().is_some_and(|t| t.esta_corriendo(&id));
        if !n.dormir.despertar(&id, viva, ahora_ms() as f64) {
            return Ok(Value::Null);
        }
        n.fijar_agente(&id, EstadoDeAgente { estado: EstadoAgente::Idle, detalle: None, at: ahora_ms() });
        n.ui("ui:command", &[json!({ "type": "restart-pane", "id": id })]);
        Ok(Value::Null)
    });
}
