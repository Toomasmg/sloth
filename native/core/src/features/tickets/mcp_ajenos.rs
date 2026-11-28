//! Los servidores MCP de la cuenta que no son del conector: se niegan en cada consulta. Equivale a
//! src/main/features/tickets/mcp-ajenos.ts.
use super::texto::re;
use serde_json::Value;
use std::collections::BTreeSet;

pub fn servidor_de_prefijo(prefijo: &str) -> String {
    let p = prefijo.strip_prefix("mcp__").unwrap_or(prefijo);
    p.strip_suffix("__").unwrap_or(p).to_string()
}

/// Con --tools '' las herramientas de Claude Code no entran, pero los MCP que la cuenta ya permite sí: un ticket podría hacer
/// que la consulta use uno que no es el del conector.
pub fn mcp_ajenos(settings: &Value, claude_json: &Value, prefijo_conector: &str) -> Vec<String> {
    let mut servidores: BTreeSet<String> = BTreeSet::new();
    let regla = re(r"^mcp__(.+?)(?:__.*)?$");
    if let Some(allow) = settings.get("permissions").and_then(|p| p.get("allow")).and_then(Value::as_array) {
        for r in allow.iter().filter_map(Value::as_str) {
            if let Some(m) = regla.captures(r) {
                servidores.insert(m[1].to_string());
            }
        }
    }
    if let Some(mcp) = claude_json.get("mcpServers").and_then(Value::as_object) {
        for nombre in mcp.keys() {
            // Claude Code pasa a «_» cada unidad UTF-16 que no es letra, número, guion o guion bajo.
            let mut n = String::new();
            for c in nombre.chars() {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    n.push(c);
                } else {
                    (0..c.len_utf16()).for_each(|_| n.push('_'));
                }
            }
            servidores.insert(n);
        }
    }
    servidores.remove(&servidor_de_prefijo(prefijo_conector));
    let valido = re(r"^[A-Za-z0-9_-]+$");
    servidores.into_iter().filter(|s| valido.is_match(s)).map(|s| format!("mcp__{s}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const JIRA: &str = "mcp__claude_ai_Jira__";

    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn servidor_de_prefijo_saca_mcp_y_el_final() {
        assert_eq!(servidor_de_prefijo(JIRA), "claude_ai_Jira");
    }

    #[test]
    fn del_allow_se_queda_con_los_que_no_son_del_conector() {
        let settings = json!({ "permissions": { "allow": ["mcp__claude_ai_Slack__slack_send_message", "mcp__claude_ai_Jira__getJiraIssue", "mcp__claude_ai_Jira", "Bash(ls)"] } });
        assert_eq!(mcp_ajenos(&settings, &json!({}), JIRA), v(&["mcp__claude_ai_Slack"]));
    }

    #[test]
    fn mcp_servers_normaliza_el_nombre_como_claude_code() {
        assert_eq!(mcp_ajenos(&json!({}), &json!({ "mcpServers": { "mi server": {}, "jira": {} } }), "mcp__jira__"), v(&["mcp__mi_server"]));
        assert_eq!(mcp_ajenos(&json!({}), &json!({ "mcpServers": { "a😀b": {} } }), JIRA), v(&["mcp__a__b"]));
    }

    #[test]
    fn junta_allow_y_mcp_servers_sin_repetir_y_ordenado() {
        let settings = json!({ "permissions": { "allow": ["mcp__zeta__x", "mcp__alfa"] } });
        assert_eq!(mcp_ajenos(&settings, &json!({ "mcpServers": { "alfa": {}, "medio": {} } }), JIRA), v(&["mcp__alfa", "mcp__medio", "mcp__zeta"]));
    }

    #[test]
    fn ignora_comodines_y_entradas_raras() {
        let settings = json!({ "permissions": { "allow": ["mcp__*", "mcp__*__algo", "mcp__", 5, null] } });
        assert!(mcp_ajenos(&settings, &Value::Null, JIRA).is_empty());
        assert!(mcp_ajenos(&json!("x"), &json!([]), JIRA).is_empty());
        assert!(mcp_ajenos(&json!({ "permissions": { "allow": "mcp__a" } }), &json!({ "mcpServers": [] }), JIRA).is_empty());
    }
}
