//! Qué cuenta consulta los tickets. Equivale a src/main/features/tickets/eleccion.ts.
use super::motor_tickets::motor_de;
use crate::proveedores::capacidades_de;
use serde_json::Value;

/// Para qué se elige la cuenta. `Trabajo` abre una terminal interactiva con el agente y sigue siendo solo de Claude: que una
/// cuenta pueda consultar tickets (`Consulta`) no quiere decir que pueda trabajar por ticket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParaQue {
    Consulta,
    Trabajo,
    Descubrir,
}

pub fn sirve_para_tickets(cuenta: &Value, para: ParaQue) -> bool {
    let c = capacidades_de(cuenta);
    match para {
        ParaQue::Trabajo => c.is_some_and(|c| c.tickets),
        ParaQue::Descubrir => c.is_some_and(|c| c.tickets_headless) && motor_de(cuenta).is_some_and(|m| m.lee_init()),
        ParaQue::Consulta => c.is_some_and(|c| c.tickets_headless),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Candidata {
    pub id: String,
    /// Tiene el conector y anda.
    pub con_conector: bool,
    /// El agente informa su uso: sin dato una cuenta cuenta 0 y ganaría siempre.
    pub con_uso: bool,
    pub consumo: f64,
}

/// Entre las que tienen el conector (si se sabe de alguna), las que informan uso, la de menos consumo.
pub fn elegir_cuenta(cuentas: &[Candidata]) -> Option<String> {
    let con_conector: Vec<&Candidata> = cuentas.iter().filter(|c| c.con_conector).collect();
    let entre: Vec<&Candidata> = if con_conector.is_empty() { cuentas.iter().collect() } else { con_conector };
    let con_uso: Vec<&Candidata> = entre.iter().copied().filter(|c| c.con_uso).collect();
    let mut pool = if con_uso.is_empty() { entre } else { con_uso };
    pool.sort_by(|a, b| a.consumo.partial_cmp(&b.consumo).unwrap_or(std::cmp::Ordering::Equal));
    pool.first().map(|c| c.id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn c(id: &str, con_conector: bool, con_uso: bool, consumo: f64) -> Candidata {
        Candidata { id: id.into(), con_conector, con_uso, consumo }
    }

    #[test]
    fn trabajar_por_ticket_es_solo_de_claude() {
        assert!(sirve_para_tickets(&json!({}), ParaQue::Trabajo));
        assert!(sirve_para_tickets(&json!({ "proveedor": "claude" }), ParaQue::Trabajo));
        assert!(!sirve_para_tickets(&json!({ "proveedor": "codex" }), ParaQue::Trabajo));
        assert!(!sirve_para_tickets(&json!({ "proveedor": "copilot" }), ParaQue::Trabajo));
        assert!(!sirve_para_tickets(&json!({ "proveedor": "otro" }), ParaQue::Trabajo));
    }

    #[test]
    fn consultar_tickets_si_sirve_con_codex_y_buscar_herramientas_solo_con_claude() {
        assert!(sirve_para_tickets(&json!({ "proveedor": "codex" }), ParaQue::Consulta));
        assert!(!sirve_para_tickets(&json!({ "proveedor": "copilot" }), ParaQue::Consulta));
        assert!(sirve_para_tickets(&json!({}), ParaQue::Descubrir));
        assert!(!sirve_para_tickets(&json!({ "proveedor": "codex" }), ParaQue::Descubrir));
    }

    #[test]
    fn si_solo_hay_cuentas_de_codex_con_sesion_el_flujo_de_trabajo_no_tiene_a_quien_elegir() {
        let logueadas = [json!({ "id": "c1", "proveedor": "codex" }), json!({ "id": "c2", "proveedor": "codex" })];
        assert!(logueadas.iter().all(|a| !sirve_para_tickets(a, ParaQue::Trabajo)));
        assert_eq!(elegir_cuenta(&[]), None);
    }

    #[test]
    fn elegir_cuenta_la_de_menos_consumo() {
        assert_eq!(elegir_cuenta(&[c("a", false, true, 9.0), c("b", false, true, 2.0), c("d", false, true, 5.0)]).as_deref(), Some("b"));
    }

    #[test]
    fn elegir_cuenta_una_sin_dato_de_uso_no_gana_a_una_con_dato_aunque_cuente_0() {
        assert_eq!(elegir_cuenta(&[c("codex", false, false, 0.0), c("claude", false, true, 50.0)]).as_deref(), Some("claude"));
        assert_eq!(elegir_cuenta(&[c("codex", false, false, 0.0)]).as_deref(), Some("codex"));
    }

    #[test]
    fn elegir_cuenta_las_que_tienen_el_conector_van_primero_si_se_sabe_de_alguna() {
        assert_eq!(elegir_cuenta(&[c("a", false, true, 1.0), c("b", true, true, 90.0)]).as_deref(), Some("b"));
        assert_eq!(elegir_cuenta(&[c("a", false, true, 1.0), c("b", false, true, 90.0)]).as_deref(), Some("a"));
    }
}
