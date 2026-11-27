//! Hook de Claude Code. Equivale a HOOK_SCRIPT (src/daemon/hook-script.ts): solo hace algo si lo lanzó Sloth (variables
//! de entorno presentes), siempre sale con código 0 y nunca bloquea más de unos segundos, salvo PermissionRequest, que
//! espera la decisión de la interfaz.
use crate::http;
use serde_json::{json, Map, Value};
use std::io::Read;
use std::time::Duration;

const LIMITE_NORMAL: usize = 65_536;
const LIMITE_PERMISO: usize = 4_194_304;
const CUERPO_MAXIMO: usize = 250_000;

pub struct Entorno {
    pub url: String,
    pub token: String,
    pub ws: String,
}

fn primera(vars: &[&str], leer: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    vars.iter().filter_map(|v| leer(v)).find(|s| !s.is_empty())
}

/// SLOTH_* y, para versiones viejas, ANTIREA_*. Sin las tres no se hace nada.
pub fn entorno_de(leer: &dyn Fn(&str) -> Option<String>) -> Option<Entorno> {
    Some(Entorno {
        url: primera(&["SLOTH_HOOK_URL", "ANTIREA_HOOK_URL"], leer)?,
        token: primera(&["SLOTH_TOKEN", "ANTIREA_TOKEN"], leer)?,
        ws: primera(&["SLOTH_WS", "ANTIREA_WS"], leer)?,
    })
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `String(x || '')` de JavaScript.
fn texto_de(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) if n.as_f64() != Some(0.0) => n.to_string(),
        Some(Value::Bool(true)) => "true".into(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => "[object Object]".into(),
        _ => String::new(),
    }
}

/// Cuerpo de un hook normal (fire-and-forget).
pub fn cuerpo_evento(evento: &str, j: &Value, ws: &str) -> String {
    let fondo = evento == "PreToolUse" && j.get("tool_input").and_then(|t| t.get("run_in_background")) == Some(&Value::Bool(true));
    let aviso = evento == "UserPromptSubmit" && j.get("prompt").and_then(Value::as_str).is_some_and(|p| p.trim_start().starts_with("<task-notification>"));
    let mut m = Map::new();
    m.insert("ws".into(), json!(ws));
    m.insert("event".into(), json!(evento));
    for (clave, origen) in [("tool", "tool_name"), ("message", "message"), ("notificationType", "notification_type")] {
        if let Some(v) = j.get(origen) {
            m.insert(clave.into(), v.clone());
        }
    }
    if fondo {
        m.insert("enSegundoPlano".into(), json!(true));
    }
    if aviso {
        m.insert("avisoDeTarea".into(), json!(true));
    }
    Value::Object(m).to_string()
}

/// Cuerpo de PermissionRequest. Si es enorme, el `input` se reemplaza por una vista previa y se sacan las sugerencias.
pub fn cuerpo_permiso(j: &Value, ws: &str) -> String {
    let input = match j.get("tool_input") {
        Some(v @ (Value::Object(_) | Value::Array(_))) => v.clone(),
        _ => json!({}),
    };
    let sugerencias = j.get("permission_suggestions").filter(|s| s.is_array()).cloned();
    let tool = texto_de(j.get("tool_name"));
    let armar = |input: Value, sug: Option<Value>| {
        let mut m = Map::new();
        m.insert("ws".into(), json!(ws));
        m.insert("tool".into(), json!(tool));
        m.insert("input".into(), input);
        if let Some(s) = sug {
            m.insert("suggestions".into(), s);
        }
        Value::Object(m).to_string()
    };
    let cuerpo = armar(input.clone(), sugerencias.clone());
    if utf16_len(&cuerpo) <= CUERPO_MAXIMO {
        return cuerpo;
    }
    let completo = input.to_string();
    let vista: String = String::from_utf16_lossy(&completo.encode_utf16().take(4000).collect::<Vec<u16>>());
    armar(json!({ "_truncated": true, "preview": vista }), None)
}

/// Lo que se imprime para Claude: solo si hubo una decisión que es un objeto.
pub fn salida_permiso(codigo: u16, cuerpo: &str) -> Option<String> {
    if codigo != 200 {
        return None;
    }
    let decision = serde_json::from_str::<Value>(cuerpo).ok()?.get("decision")?.clone();
    decision.is_object().then(|| json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } }).to_string())
}

pub fn run(evento: &str) {
    let Some(e) = entorno_de(&|k| std::env::var(k).ok()) else { return };
    let permiso = evento == "PermissionRequest";
    let limite = if permiso { LIMITE_PERMISO } else { LIMITE_NORMAL };
    let mut crudo = Vec::new();
    let _ = std::io::stdin().take(limite as u64).read_to_end(&mut crudo);
    let j: Value = serde_json::from_slice(&crudo).unwrap_or_else(|_| json!({}));
    if permiso {
        let Some(origen) = http::origen(&e.url) else { return };
        let cuerpo = cuerpo_permiso(&j, &e.ws);
        if let Ok((codigo, resp)) = http::post(&format!("{origen}/permission"), &e.token, &cuerpo, Duration::from_secs(125)) {
            if let Some(salida) = salida_permiso(codigo, &resp) {
                print!("{salida}");
            }
        }
    } else {
        let _ = http::post(&e.url, &e.token, &cuerpo_evento(evento, &j, &e.ws), Duration::from_millis(2500));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn con(pares: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |k| pares.iter().find(|(c, _)| *c == k).map(|(_, v)| v.to_string())
    }

    #[test]
    fn sin_las_tres_variables_no_hace_nada() {
        assert!(entorno_de(&con(&[("SLOTH_HOOK_URL", "u"), ("SLOTH_TOKEN", "t")])).is_none());
        assert!(entorno_de(&con(&[("SLOTH_HOOK_URL", ""), ("SLOTH_TOKEN", "t"), ("SLOTH_WS", "w")])).is_none());
        let e = entorno_de(&con(&[("ANTIREA_HOOK_URL", "u"), ("SLOTH_TOKEN", "t"), ("ANTIREA_WS", "w")])).unwrap();
        assert_eq!((e.url.as_str(), e.token.as_str(), e.ws.as_str()), ("u", "t", "w"));
        let prioridad = entorno_de(&con(&[("SLOTH_HOOK_URL", "nuevo"), ("ANTIREA_HOOK_URL", "viejo"), ("SLOTH_TOKEN", "t"), ("SLOTH_WS", "w")])).unwrap();
        assert_eq!(prioridad.url, "nuevo");
    }

    #[test]
    fn cuerpo_de_un_evento_normal() {
        let j = json!({ "tool_name": "Bash", "message": "hola", "notification_type": "idle_prompt", "otro": 1 });
        let v: Value = serde_json::from_str(&cuerpo_evento("Notification", &j, "w1")).unwrap();
        assert_eq!(v, json!({ "ws": "w1", "event": "Notification", "tool": "Bash", "message": "hola", "notificationType": "idle_prompt" }));
        let solo: Value = serde_json::from_str(&cuerpo_evento("Stop", &json!({}), "w1")).unwrap();
        assert_eq!(solo, json!({ "ws": "w1", "event": "Stop" }));
    }

    #[test]
    fn marca_segundo_plano_y_aviso_de_tarea() {
        let fondo = json!({ "tool_name": "Bash", "tool_input": { "run_in_background": true } });
        assert_eq!(serde_json::from_str::<Value>(&cuerpo_evento("PreToolUse", &fondo, "w")).unwrap()["enSegundoPlano"], json!(true));
        assert!(serde_json::from_str::<Value>(&cuerpo_evento("PostToolUse", &fondo, "w")).unwrap().get("enSegundoPlano").is_none());
        let normal = json!({ "tool_input": { "run_in_background": false } });
        assert!(serde_json::from_str::<Value>(&cuerpo_evento("PreToolUse", &normal, "w")).unwrap().get("enSegundoPlano").is_none());
        let tarea = json!({ "prompt": "  <task-notification>x</task-notification>" });
        assert_eq!(serde_json::from_str::<Value>(&cuerpo_evento("UserPromptSubmit", &tarea, "w")).unwrap()["avisoDeTarea"], json!(true));
        assert!(serde_json::from_str::<Value>(&cuerpo_evento("UserPromptSubmit", &json!({ "prompt": "hola" }), "w")).unwrap().get("avisoDeTarea").is_none());
    }

    #[test]
    fn cuerpo_de_permiso() {
        let j = json!({ "tool_name": "Bash", "tool_input": { "command": "ls" }, "permission_suggestions": [{ "a": 1 }] });
        let v: Value = serde_json::from_str(&cuerpo_permiso(&j, "w1")).unwrap();
        assert_eq!(v, json!({ "ws": "w1", "tool": "Bash", "input": { "command": "ls" }, "suggestions": [{ "a": 1 }] }));
        let sin: Value = serde_json::from_str(&cuerpo_permiso(&json!({ "tool_input": "texto", "permission_suggestions": "no" }), "w1")).unwrap();
        assert_eq!(sin, json!({ "ws": "w1", "tool": "", "input": {} }));
    }

    #[test]
    fn un_permiso_enorme_se_trunca_a_una_vista_previa() {
        let grande = "x".repeat(300_000);
        let j = json!({ "tool_name": "Write", "tool_input": { "contenido": grande }, "permission_suggestions": [1] });
        let cuerpo = cuerpo_permiso(&j, "w1");
        assert!(utf16_len(&cuerpo) < 5000);
        let v: Value = serde_json::from_str(&cuerpo).unwrap();
        assert_eq!(v["input"]["_truncated"], json!(true));
        assert_eq!(v["input"]["preview"].as_str().unwrap().chars().count(), 4000);
        assert!(v.get("suggestions").is_none());
        assert_eq!(v["tool"], json!("Write"));
    }

    #[test]
    fn la_salida_del_permiso_solo_si_hay_una_decision_objeto() {
        let ok = salida_permiso(200, "{\"decision\":{\"behavior\":\"allow\"}}").unwrap();
        assert_eq!(serde_json::from_str::<Value>(&ok).unwrap(), json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "allow" } } }));
        assert!(salida_permiso(200, "{\"decision\":null}").is_none());
        assert!(salida_permiso(200, "{\"decision\":[1]}").is_none());
        assert!(salida_permiso(403, "{\"decision\":{\"a\":1}}").is_none());
        assert!(salida_permiso(200, "no es json").is_none());
    }
}
