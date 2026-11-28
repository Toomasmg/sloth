//! Registro del MCP `sloth` en una cuenta, PURO: qué hay hoy en su .claude.json (solo se lee), qué hay que hacer y los
//! argumentos del CLI oficial (`claude mcp add/remove -s user`), que es el único que lo escribe. Nunca se toca un `sloth`
//! que no haya puesto Sloth. Equivale a chat-mcp-registro.ts.
//!
//! Además del script de Node (`node <userData>/sloth-chat-mcp.cjs`), se reconoce y se arma el registro sin Node:
//! `<sloth-hook> chat-mcp`, que es el subcomando del helper.
use super::Res;
use serde_json::Value;

pub const MCP_NAME: &str = "sloth";
pub const MCP_SCRIPT_NAME: &str = "sloth-chat-mcp.cjs";
pub const MCP_SUBCOMANDO: &str = "chat-mcp";
pub const TOKEN_ENV: &str = "SLOTH_CHAT_TOKEN";

pub fn normalizar_ruta(p: &str) -> String {
    p.replace('\\', "/")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Registro {
    Ausente,
    Ajena,
    /// `script` es el .cjs o, sin Node, el ejecutable del helper.
    Nuestra { script: String, token: Option<String> },
}

fn es_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn es_helper(command: &str) -> bool {
    let c = normalizar_ruta(command).to_lowercase();
    let base = c.rsplit('/').next().unwrap_or("");
    base == "sloth-hook" || base == "sloth-hook.exe"
}

/// El ejecutable o script que hace de MCP en esta entrada, si es de Sloth.
fn ruta_nuestra(v: &Value) -> Option<String> {
    let o = v.as_object()?;
    let args = o.get("args")?.as_array()?;
    let primero = args.first().and_then(Value::as_str)?;
    if normalizar_ruta(primero).ends_with(&format!("/{MCP_SCRIPT_NAME}")) {
        return Some(normalizar_ruta(primero));
    }
    let command = o.get("command").and_then(Value::as_str)?;
    (primero == MCP_SUBCOMANDO && es_helper(command)).then(|| normalizar_ruta(command))
}

pub fn es_nuestra(v: &Value) -> bool {
    ruta_nuestra(v).is_some()
}

/// Lo que hay hoy en el `mcpServers` de usuario. Un `mcpServers` raro cuenta como ajeno: no se toca.
pub fn leer_registro(json: &Value) -> Registro {
    let Some(o) = json.as_object() else { return Registro::Ajena };
    let servers = match o.get("mcpServers") {
        None => return Registro::Ausente,
        Some(Value::Object(s)) => s,
        Some(_) => return Registro::Ajena,
    };
    let Some(cur) = servers.get(MCP_NAME) else { return Registro::Ausente };
    let Some(script) = ruta_nuestra(cur) else { return Registro::Ajena };
    let token = cur.get("env").and_then(|e| e.get(TOKEN_ENV)).and_then(Value::as_str).map(String::from);
    Registro::Nuestra { script, token }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Accion {
    Nada,
    Conflicto,
    Alta,
    Reemplazo,
    Baja,
}

/// `hash_guardado` es el del token que el main reconoce para la cuenta. Si el registro tiene otro token (o ninguno, como
/// los de antes), se reemplaza: con ese token el pipe no lo dejaría pasar.
pub fn planificar(quiere: bool, actual: &Registro, script: &str, hash_guardado: Option<&str>, hash_de: impl Fn(&str) -> String) -> Accion {
    match actual {
        Registro::Ajena => {
            if quiere {
                Accion::Conflicto
            } else {
                Accion::Nada
            }
        }
        Registro::Ausente => {
            if quiere {
                Accion::Alta
            } else {
                Accion::Nada
            }
        }
        Registro::Nuestra { script: s, token } => {
            if !quiere {
                return Accion::Baja;
            }
            let vigente = *s == normalizar_ruta(script) && matches!((token, hash_guardado), (Some(t), Some(h)) if hash_de(t) == h);
            if vigente {
                Accion::Nada
            } else {
                Accion::Reemplazo
            }
        }
    }
}

fn tiene_control(s: &str) -> bool {
    s.chars().any(|c| matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}' | '"'))
}

fn validar_ruta(ruta: &str, termina_en: &str) -> Res<String> {
    let s = normalizar_ruta(ruta);
    let b = s.as_bytes();
    let absoluta = (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'/') || s.starts_with('/');
    if !absoluta || s.encode_utf16().count() > 1024 || tiene_control(&s) || !s.ends_with(termina_en) {
        return Err("Ruta del script inválida.".into());
    }
    Ok(s)
}

fn args_de_alta(token: &str, comando: Vec<String>) -> Res<Vec<String>> {
    if !es_hex64(token) {
        return Err("Token inválido.".into());
    }
    let mut a: Vec<String> = ["mcp", "add", "-s", "user", MCP_NAME, "-e"].iter().map(|s| s.to_string()).collect();
    a.push(format!("{TOKEN_ENV}={token}"));
    a.push("--".into());
    a.extend(comando);
    Ok(a)
}

pub fn args_alta(script: &str, token: &str) -> Res<Vec<String>> {
    if !es_hex64(token) {
        return Err("Token inválido.".into());
    }
    let s = validar_ruta(script, &format!("/{MCP_SCRIPT_NAME}"))?;
    args_de_alta(token, vec!["node".into(), s])
}

/// Alta sin Node: Claude Code arranca `<helper> chat-mcp`.
pub fn args_alta_helper(exe: &str, token: &str) -> Res<Vec<String>> {
    if !es_hex64(token) {
        return Err("Token inválido.".into());
    }
    let s = validar_ruta(exe, "/sloth-hook.exe").or_else(|_| validar_ruta(exe, "/sloth-hook"))?;
    args_de_alta(token, vec![s, MCP_SUBCOMANDO.into()])
}

pub fn args_baja() -> Vec<String> {
    ["mcp", "remove", "-s", "user", MCP_NAME].iter().map(|s| s.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::chat::mcp_core::hash_token;
    use serde_json::json;

    const SCRIPT: &str = "C:\\Users\\x\\AppData\\Roaming\\Sloth\\sloth-chat-mcp.cjs";
    const SCRIPT_N: &str = "C:/Users/x/AppData/Roaming/Sloth/sloth-chat-mcp.cjs";

    fn token() -> String {
        "a".repeat(64)
    }

    fn nuestra() -> Value {
        json!({"type": "stdio", "command": "node", "args": [SCRIPT_N], "env": {TOKEN_ENV: token()}})
    }

    fn otro() -> Value {
        json!({"type": "stdio", "command": "npx", "args": ["otro-mcp"], "env": {}})
    }

    fn con_token() -> Registro {
        leer_registro(&json!({"mcpServers": {"sloth": nuestra()}}))
    }

    #[test]
    fn es_nuestra_mira_el_script_con_cualquier_barra() {
        assert!(es_nuestra(&nuestra()));
        assert!(es_nuestra(&json!({"args": [SCRIPT]})));
        assert!(!es_nuestra(&otro()));
        assert!(!es_nuestra(&json!(null)));
    }

    #[test]
    fn es_nuestra_reconoce_el_helper_sin_node() {
        let h = json!({"type": "stdio", "command": "C:\\Sloth\\sloth-hook.exe", "args": ["chat-mcp"], "env": {TOKEN_ENV: token()}});
        assert_eq!(leer_registro(&json!({"mcpServers": {"sloth": h}})), Registro::Nuestra { script: "C:/Sloth/sloth-hook.exe".into(), token: Some(token()) });
        assert!(!es_nuestra(&json!({"command": "otro.exe", "args": ["chat-mcp"]})));
        assert!(!es_nuestra(&json!({"command": "sloth-hook.exe", "args": ["statusline"]})));
    }

    #[test]
    fn leer_registro_ausente_ajena_nuestra_con_y_sin_token() {
        assert_eq!(leer_registro(&json!({})), Registro::Ausente);
        assert_eq!(leer_registro(&json!({"mcpServers": {"otro": otro()}})), Registro::Ausente);
        assert_eq!(leer_registro(&json!({"mcpServers": {"sloth": otro()}})), Registro::Ajena);
        assert_eq!(leer_registro(&json!({"mcpServers": []})), Registro::Ajena);
        assert_eq!(leer_registro(&json!("x")), Registro::Ajena);
        assert_eq!(con_token(), Registro::Nuestra { script: SCRIPT_N.into(), token: Some(token()) });
        let vieja = json!({"type": "stdio", "command": "node", "args": [SCRIPT_N, "--cuenta", "acc-1"], "env": {}});
        assert_eq!(leer_registro(&json!({"mcpServers": {"sloth": vieja}})), Registro::Nuestra { script: SCRIPT_N.into(), token: None });
    }

    #[test]
    fn planificar_alta_nada_reemplazo_y_baja() {
        let h = hash_token(&token());
        assert_eq!(planificar(true, &Registro::Ausente, SCRIPT, Some(&h), hash_token), Accion::Alta);
        assert_eq!(planificar(false, &Registro::Ausente, SCRIPT, None, hash_token), Accion::Nada);
        assert_eq!(planificar(true, &con_token(), SCRIPT, Some(&h), hash_token), Accion::Nada);
        assert_eq!(planificar(false, &con_token(), SCRIPT, Some(&h), hash_token), Accion::Baja);
    }

    #[test]
    fn planificar_reemplaza_si_el_token_no_es_el_que_reconoce_el_main_o_si_cambio_la_ruta() {
        let h = hash_token(&token());
        assert_eq!(planificar(true, &con_token(), SCRIPT, None, hash_token), Accion::Reemplazo);
        assert_eq!(planificar(true, &con_token(), SCRIPT, Some(&hash_token(&"b".repeat(64))), hash_token), Accion::Reemplazo);
        assert_eq!(planificar(true, &con_token(), "D:/otro/sloth-chat-mcp.cjs", Some(&h), hash_token), Accion::Reemplazo);
        let sin_token = leer_registro(&json!({"mcpServers": {"sloth": {"command": "node", "args": [SCRIPT_N], "env": {}}}}));
        assert_eq!(planificar(true, &sin_token, SCRIPT, Some(&h), hash_token), Accion::Reemplazo);
    }

    #[test]
    fn planificar_no_toca_un_sloth_ajeno() {
        assert_eq!(planificar(true, &Registro::Ajena, SCRIPT, None, hash_token), Accion::Conflicto);
        assert_eq!(planificar(false, &Registro::Ajena, SCRIPT, None, hash_token), Accion::Nada);
    }

    #[test]
    fn args_alta_arma_el_comando_del_cli_con_el_token_en_el_env_del_servidor() {
        assert_eq!(
            args_alta(SCRIPT, &token()).unwrap(),
            ["mcp", "add", "-s", "user", "sloth", "-e", &format!("{TOKEN_ENV}={}", token()), "--", "node", SCRIPT_N]
        );
        assert_eq!(args_baja(), ["mcp", "remove", "-s", "user", "sloth"]);
    }

    #[test]
    fn args_alta_helper_arma_el_comando_sin_node() {
        assert_eq!(
            args_alta_helper("C:\\Sloth\\sloth-hook.exe", &token()).unwrap(),
            ["mcp", "add", "-s", "user", "sloth", "-e", &format!("{TOKEN_ENV}={}", token()), "--", "C:/Sloth/sloth-hook.exe", "chat-mcp"]
        );
        assert!(args_alta_helper("C:/Sloth/otro.exe", &token()).is_err());
    }

    #[test]
    fn args_alta_rechaza_tokens_y_rutas_raras() {
        assert!(args_alta(SCRIPT, "corto").unwrap_err().contains("Token"));
        assert!(args_alta(SCRIPT, &format!("{}\n-e X=1", token())).unwrap_err().contains("Token"));
        for ruta in ["relativo/sloth-chat-mcp.cjs", "C:/x/otro.cjs", "C:/x\"/sloth-chat-mcp.cjs", "C:/x\n/sloth-chat-mcp.cjs"] {
            assert!(args_alta(ruta, &token()).unwrap_err().contains("Ruta"), "{ruta}");
        }
    }
}
