//! Aviso de turno terminado de Codex. Equivale a NOTIFY_SCRIPT (src/daemon/notify-script.ts): Codex le pasa un JSON como
//! último argumento; solo se mira `type`, nada de su texto sale de acá, no lee stdin y el destino es solo la propia máquina.
use crate::http;
use serde_json::{json, Value};
use std::time::Duration;

const LIMITE_ARGUMENTO: usize = 262_144;

/// ¿Es un turno terminado? Cualquier otra cosa se ignora.
pub fn es_turno_terminado(arg: &str) -> bool {
    arg.len() <= LIMITE_ARGUMENTO && serde_json::from_str::<Value>(arg).ok().and_then(|j| j.get("type")?.as_str().map(|t| t == "agent-turn-complete")).unwrap_or(false)
}

/// Solo http hacia esta máquina.
pub fn destino_valido(url: &str) -> bool {
    http::partes(url).is_some_and(|(host, _)| ["127.0.0.1", "localhost", "[::1]"].contains(&http::nombre_de_host(&host)))
}

pub fn run(arg: Option<&str>) {
    let (Some(arg), Some(url), Some(token), Some(ws)) = (arg, var("SLOTH_HOOK_URL"), var("SLOTH_TOKEN"), var("SLOTH_WS")) else { return };
    if !es_turno_terminado(arg) || !destino_valido(&url) {
        return;
    }
    let _ = http::post(&url, &token, &json!({ "ws": ws, "event": "Stop" }).to_string(), Duration::from_secs(2));
}

fn var(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solo_agent_turn_complete() {
        assert!(es_turno_terminado("{\"type\":\"agent-turn-complete\",\"last-assistant-message\":\"secreto\"}"));
        assert!(!es_turno_terminado("{\"type\":\"otro\"}"));
        assert!(!es_turno_terminado("{\"type\":5}"));
        assert!(!es_turno_terminado("no es json"));
        assert!(!es_turno_terminado("null"));
        assert!(!es_turno_terminado(&format!("{{\"type\":\"agent-turn-complete\",\"x\":\"{}\"}}", "a".repeat(300_000))));
    }

    #[test]
    fn el_destino_tiene_que_ser_esta_maquina() {
        assert!(destino_valido("http://127.0.0.1:5000/hook"));
        assert!(destino_valido("http://localhost:5000/hook"));
        assert!(destino_valido("http://[::1]:5000/hook"));
        assert!(!destino_valido("http://192.168.1.5:5000/hook"));
        assert!(!destino_valido("http://evil.com/hook"));
        assert!(!destino_valido("https://127.0.0.1/hook"));
        assert!(!destino_valido("127.0.0.1:5000"));
    }
}
