//! Qué primeros mensajes se le pueden pasar a un agente como argumento. Equivale a src/shared/initial-prompt.ts.

/// Subcomandos y alias de `claude --help` (2.1.326) más el `help` que suma commander. Commander despacha si el primer
/// operando es exactamente uno de estos, aunque venga después de `--`.
pub const CLAUDE_SUBCOMMANDS: [&str; 22] = [
    "agents", "attach", "auth", "auto-mode", "doctor", "gateway", "help", "import", "install", "kill", "logs", "mcp", "plugin", "plugins", "purge", "respawn", "rm", "setup-token", "stop", "ultrareview", "update", "upgrade",
];

/// Subcomandos de `codex --help` (0.164) con sus alias: Codex también los despacha por el primer operando.
pub const CODEX_SUBCOMMANDS: [&str; 20] = [
    "a", "app", "app-server", "apply", "cloud", "completion", "debug", "doctor", "e", "exec", "features", "fork", "help", "login", "logout", "mcp", "mcp-server", "resume", "review", "sandbox",
];

/// Una versión más nueva de Claude Code puede sumar subcomandos: una palabra suelta en minúsculas tampoco va como argumento.
fn palabra_suelta(s: &str) -> bool {
    let mut c = s.chars();
    c.next().is_some_and(|p| p.is_ascii_lowercase()) && c.all(|x| x.is_ascii_lowercase() || x == '-')
}

/// ¿El agente podría tomar este argumento (tal cual se le pasa) como un subcomando?
pub fn podria_ser_subcomando(arg: &str, agente: &str) -> bool {
    let conocidos: &[&str] = if agente == "codex" { &CODEX_SUBCOMMANDS } else { &CLAUDE_SUBCOMMANDS };
    conocidos.contains(&arg) || palabra_suelta(arg)
}

/// Por qué un primer mensaje no se puede mandar a Claude, o None si está bien.
pub fn problema_del_primer_mensaje(prompt: &str) -> Option<&'static str> {
    prompt.trim_start_matches(crate::perfiles_core::es_blanco_js).starts_with('!').then_some("El primer mensaje no puede empezar con «!»: Claude Code lo correría como un comando de la terminal.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subcomandos_conocidos_y_palabras_sueltas() {
        for p in ["update", "mcp", "kill", "continuar", "nuevo-sub", "help"] {
            assert!(podria_ser_subcomando(p, "claude"), "{p}");
        }
        for p in ["Update", "update ", "update the README", "continuá", "", "1abc", "-x", "a_b"] {
            assert!(!podria_ser_subcomando(p, "claude"), "{p:?}");
        }
    }

    #[test]
    fn codex_tiene_sus_propios_subcomandos() {
        assert!(podria_ser_subcomando("exec", "codex"));
        assert!(podria_ser_subcomando("a", "codex"));
        assert!(CLAUDE_SUBCOMMANDS.contains(&"auth") && !CODEX_SUBCOMMANDS.contains(&"auth"));
        // «Arreglar» es una palabra suelta: no va como argumento con ningún agente.
        assert!(podria_ser_subcomando("arreglar", "codex"));
    }

    #[test]
    fn el_primer_mensaje_no_puede_empezar_con_signo_de_exclamacion() {
        assert!(problema_del_primer_mensaje("!ls").unwrap().contains("«!»"));
        assert!(problema_del_primer_mensaje("   !ls").is_some());
        assert!(problema_del_primer_mensaje("hola !").is_none());
        assert!(problema_del_primer_mensaje("").is_none());
    }
}
