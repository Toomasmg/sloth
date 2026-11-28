//! Variables de entorno de cada consulta de tickets con Claude que no dependen de la cuenta. Equivale a
//! src/main/features/tickets/entorno-consulta.ts.
use std::collections::BTreeMap;

/// Los conectores de claude.ai llevan este prefijo; los demás servidores MCP son de la cuenta (`claude mcp add`).
pub const PREFIJO_CLAUDE_AI: &str = "mcp__claude_ai_";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntornoConsulta {
    pub env: BTreeMap<String, String>,
    /// La sesión corre sin los conectores de claude.ai: su system/init no los trae.
    pub sin_claude_ai: bool,
}

/// `prefijo` es el del servidor que va a usar la consulta; sin él (revisar, descubrir) la sesión ve todo.
///
/// Un MCP propio lento puede tardar más que el tope por defecto de Claude Code en arrancar, y con el tope de salida por
/// defecto (25.000 tokens) una página grande de tickets se rechaza: por eso MCP_TIMEOUT y MAX_MCP_OUTPUT_TOKENS.
///
/// Claude Code en modo -p ya no espera a que conecten los servidores MCP de la cuenta (alcance usuario o proyecto): arma la
/// lista de herramientas del primer turno antes, el system/init los muestra `pending` y sin herramientas, y el modelo
/// contesta que no tiene el conector. Probado con claude 2.1.332 contra un servidor http local: 4 de 4 consultas quedaban
/// `pending` y con MCP_CONNECTION_NONBLOCKING=false 4 de 4 conectaban. Los de claude.ai ya tienen su propia espera previa, así
/// que con ellos no se toca. Una versión que no conozca la variable la ignora.
pub fn entorno_consulta(prefijo: Option<&str>) -> EntornoConsulta {
    let mut env: BTreeMap<String, String> = BTreeMap::new();
    env.insert("MCP_TIMEOUT".into(), "30000".into());
    env.insert("MAX_MCP_OUTPUT_TOKENS".into(), "50000".into());
    if prefijo.is_some_and(|p| p.starts_with(PREFIJO_CLAUDE_AI)) {
        return EntornoConsulta { env, sin_claude_ai: false };
    }
    // Conectar todos los de claude.ai solo para no usarlos demora cada consulta; si la variable no existe en esta versión, el
    // init los trae igual.
    env.insert("MCP_CONNECTION_NONBLOCKING".into(), "false".into());
    match prefijo {
        None => EntornoConsulta { env, sin_claude_ai: false },
        Some(_) => {
            env.insert("ENABLE_CLAUDEAI_MCP_SERVERS".into(), "false".into());
            EntornoConsulta { env, sin_claude_ai: true }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g<'a>(e: &'a EntornoConsulta, k: &str) -> Option<&'a str> {
        e.env.get(k).map(String::as_str)
    }

    #[test]
    fn un_servidor_de_la_cuenta_espera_a_que_conecte_antes_del_primer_turno_y_deja_afuera_a_los_de_claude_ai() {
        let r = entorno_consulta(Some("mcp__gruv-tomy__"));
        assert_eq!((g(&r, "MCP_CONNECTION_NONBLOCKING"), g(&r, "ENABLE_CLAUDEAI_MCP_SERVERS")), (Some("false"), Some("false")));
        assert!(r.sin_claude_ai);
        assert_eq!((g(&r, "MCP_TIMEOUT"), g(&r, "MAX_MCP_OUTPUT_TOKENS")), (Some("30000"), Some("50000")));
    }

    #[test]
    fn un_conector_de_claude_ai_no_cambia_como_conecta_ni_se_apagan_los_demas() {
        let r = entorno_consulta(Some("mcp__claude_ai_Gruv__"));
        assert!(g(&r, "MCP_CONNECTION_NONBLOCKING").is_none() && g(&r, "ENABLE_CLAUDEAI_MCP_SERVERS").is_none());
        assert!(!r.sin_claude_ai);
    }

    #[test]
    fn revisar_y_descubrir_sin_prefijo_esperan_la_conexion_con_todos_los_de_claude_ai() {
        let r = entorno_consulta(None);
        assert_eq!(g(&r, "MCP_CONNECTION_NONBLOCKING"), Some("false"));
        assert!(g(&r, "ENABLE_CLAUDEAI_MCP_SERVERS").is_none());
        assert!(!r.sin_claude_ai);
    }
}
