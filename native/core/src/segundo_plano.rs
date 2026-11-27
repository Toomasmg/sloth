//! Lleva la cuenta de los shells que Claude dejó corriendo en segundo plano (run_in_background). Equivale a
//! src/main/segundo-plano-core.ts. Claude Code no avisa por hook cuando uno termina: vuelve a despertar a Claude con un
//! turno nuevo que no escribió el usuario. Cada turno así descuenta un shell.
use std::collections::HashMap;

/// Si un shell no avisó en este tiempo, se da por perdido para no quedar «trabajando» para siempre.
pub const VENCE_MS: u64 = 30 * 60_000;

#[derive(Debug, Clone, Default)]
pub struct Fondo {
    /// Cuándo se lanzó cada shell que sigue pendiente, del más viejo al más nuevo.
    pub lanzados: Vec<u64>,
    /// El último turno terminó (Stop) y todavía no arrancó otro.
    pub turno_cerrado: bool,
}

/// Lo que importa de un evento de hook para llevar la cuenta.
#[derive(Debug, Clone, Default)]
pub struct EventoFondo<'a> {
    pub ws: &'a str,
    pub evento: &'a str,
    pub notification_type: Option<&'a str>,
    pub en_segundo_plano: bool,
    pub aviso_de_tarea: bool,
}

fn vigentes(f: &Fondo, ahora: u64) -> Vec<u64> {
    f.lanzados.iter().copied().filter(|t| ahora.saturating_sub(*t) < VENCE_MS).collect()
}

/// Actualiza la cuenta con un evento de hook.
pub fn registrar(m: &mut HashMap<String, Fondo>, p: &EventoFondo, ahora: u64) {
    if p.evento == "SessionStart" || p.evento == "SessionEnd" {
        m.remove(p.ws);
        return;
    }
    let mut f = m.remove(p.ws).unwrap_or_default();
    f.lanzados = vigentes(&f, ahora);
    let turno_nuevo = f.turno_cerrado && matches!(p.evento, "PreToolUse" | "Stop" | "UserPromptSubmit");
    if turno_nuevo {
        f.turno_cerrado = false;
        // El usuario escribió: el turno no lo despertó un shell.
        if (p.evento != "UserPromptSubmit" || p.aviso_de_tarea) && !f.lanzados.is_empty() {
            f.lanzados.remove(0);
        }
    }
    if p.evento == "PreToolUse" && p.en_segundo_plano {
        f.lanzados.push(ahora);
    }
    if p.evento == "Stop" {
        f.turno_cerrado = true;
    }
    if !(f.lanzados.is_empty() && !f.turno_cerrado) {
        m.insert(p.ws.to_string(), f);
    }
}

/// Shells que siguen corriendo en ese espacio.
pub fn pendientes(m: &HashMap<String, Fondo>, ws: &str, ahora: u64) -> usize {
    m.get(ws).map_or(0, |f| vigentes(f, ahora).len())
}

/// Cuándo vence el shell más nuevo, para revisar el estado si nunca llega su aviso.
pub fn vence_en(m: &HashMap<String, Fondo>, ws: &str, ahora: u64) -> Option<u64> {
    m.get(ws).and_then(|f| vigentes(f, ahora).last().map(|t| t + VENCE_MS))
}

/// El evento diría «terminó» o «te espera» pero en realidad sigue corriendo algo: Stop, o el aviso de inactividad que
/// Claude Code manda al rato de terminar el turno.
pub fn es_falso_final(p: &EventoFondo, en_fondo: usize) -> bool {
    en_fondo > 0 && (p.evento == "Stop" || (p.evento == "Notification" && p.notification_type == Some("idle_prompt")))
}

#[cfg(test)]
mod tests {
    use super::*;

    const WS: &str = "ws1";
    fn ev(evento: &str) -> EventoFondo<'_> {
        EventoFondo { ws: WS, evento, ..Default::default() }
    }
    fn fondo(evento: &str) -> EventoFondo<'_> {
        EventoFondo { en_segundo_plano: true, ..ev(evento) }
    }
    fn correr(eventos: &[EventoFondo]) -> HashMap<String, Fondo> {
        let mut m = HashMap::new();
        for e in eventos {
            registrar(&mut m, e, 0);
        }
        m
    }

    #[test]
    fn un_shell_de_fondo_sigue_pendiente_cuando_claude_termina_el_turno() {
        let m = correr(&[ev("UserPromptSubmit"), fondo("PreToolUse"), ev("Stop")]);
        assert_eq!(pendientes(&m, WS, 0), 1);
        assert!(es_falso_final(&ev("Stop"), 1));
        assert!(es_falso_final(&EventoFondo { notification_type: Some("idle_prompt"), ..ev("Notification") }, 1));
    }

    #[test]
    fn el_turno_que_despierta_el_shell_al_terminar_lo_descuenta() {
        assert_eq!(pendientes(&correr(&[fondo("PreToolUse"), ev("Stop"), ev("PreToolUse")]), WS, 0), 0);
    }

    #[test]
    fn un_turno_sin_herramientas_tambien_descuenta() {
        assert_eq!(pendientes(&correr(&[fondo("PreToolUse"), ev("Stop"), ev("Stop")]), WS, 0), 0);
    }

    #[test]
    fn si_el_aviso_llega_como_prompt_de_tarea_descuenta_si_escribio_el_usuario_no() {
        let tarea = EventoFondo { aviso_de_tarea: true, ..ev("UserPromptSubmit") };
        assert_eq!(pendientes(&correr(&[fondo("PreToolUse"), ev("Stop"), tarea]), WS, 0), 0);
        assert_eq!(pendientes(&correr(&[fondo("PreToolUse"), ev("Stop"), ev("UserPromptSubmit"), ev("PreToolUse")]), WS, 0), 1);
    }

    #[test]
    fn dos_shells_el_primer_aviso_deja_uno_pendiente() {
        assert_eq!(pendientes(&correr(&[fondo("PreToolUse"), fondo("PreToolUse"), ev("Stop"), ev("Stop")]), WS, 0), 1);
    }

    #[test]
    fn sin_shells_de_fondo_stop_y_el_aviso_de_inactividad_son_finales_de_verdad() {
        let m = correr(&[ev("UserPromptSubmit"), ev("PreToolUse"), ev("Stop")]);
        assert_eq!(pendientes(&m, WS, 0), 0);
        assert!(!es_falso_final(&ev("Stop"), 0));
    }

    #[test]
    fn un_pedido_que_no_es_de_inactividad_sigue_avisando_aunque_haya_shells() {
        assert!(!es_falso_final(&EventoFondo { notification_type: Some("elicitation_dialog"), ..ev("Notification") }, 2));
        assert!(!es_falso_final(&ev("PreToolUse"), 2));
    }

    #[test]
    fn un_shell_que_nunca_avisa_vence_a_los_30_minutos() {
        let m = correr(&[fondo("PreToolUse"), ev("Stop")]);
        assert_eq!(vence_en(&m, WS, 0), Some(VENCE_MS));
        assert_eq!(pendientes(&m, WS, VENCE_MS), 0);
    }

    #[test]
    fn cerrar_o_reabrir_claude_borra_la_cuenta() {
        let m = correr(&[fondo("PreToolUse"), ev("SessionEnd")]);
        assert_eq!(pendientes(&m, WS, 0), 0);
        assert!(m.is_empty());
    }
}
