//! Nombres de los servidores MCP que tiene la cuenta en su `config.toml` (`[mcp_servers.<nombre>]`). Solo texto: quien
//! llama lee el archivo de la carpeta de la cuenta (nunca auth.json) y no lo escribe. Equivale a
//! src/main/features/tickets/codex-config.ts.
use super::modelo::{EstadoMcp, ServidorMcp};
use super::texto::{len16, re};
use crate::toml_escaner::{analizar, Tipo};

pub const MAX_TOML: usize = 1024 * 1024;
const MAX_SERVIDORES: usize = 100;

/// Solo estos nombres se pasan a `-c`: otro texto en una clave de TOML podría cambiar qué se configura.
pub fn nombre_servidor_valido(n: &str) -> bool {
    re(r"^[A-Za-z0-9_-]{1,64}$").is_match(n)
}

/// None si el TOML no se puede leer entero: con duda no se afirma qué servidores hay.
pub fn servidores_de_config_toml(toml: &str) -> Option<Vec<String>> {
    if len16(toml) > MAX_TOML {
        return None;
    }
    let sentencias = analizar(toml).ok()?;
    let mut nombres: Vec<String> = Vec::new();
    for s in &sentencias {
        if s.tipo == Tipo::TablaArray {
            continue;
        }
        let ruta: Vec<&String> = if s.tipo == Tipo::Clave { s.tabla.iter().chain(s.ruta.iter()).collect() } else { s.ruta.iter().collect() };
        // `mcp_servers = { a = { ... } }` en la raíz: el escáner no abre las tablas en línea, así que no se sabe qué servidores hay.
        if s.tipo == Tipo::Clave && ruta.len() == 1 && ruta[0] == "mcp_servers" {
            return None;
        }
        if ruta.first().is_some_and(|r| *r == "mcp_servers") && ruta.len() > 1 && nombres.len() < MAX_SERVIDORES && !nombres.contains(ruta[1]) {
            nombres.push(ruta[1].clone());
        }
    }
    Some(nombres)
}

/// Los que no se pueden desactivar con `-c` por su nombre: con uno así no se consulta.
pub fn servidores_ignorados(servidores: &[String]) -> Vec<String> {
    servidores.iter().filter(|n| !nombre_servidor_valido(n)).cloned().collect()
}

/// El nombre del servidor de `mcp__<nombre>__`. Los de claude.ai no están en el config.toml de ninguna cuenta de Codex.
pub fn servidor_de_prefijo(prefijo: &str) -> Option<String> {
    let n = prefijo.strip_prefix("mcp__")?.strip_suffix("__")?;
    (!n.starts_with("claude_ai_") && nombre_servidor_valido(n)).then(|| n.to_string())
}

/// Codex no dice si un servidor anda: quedan en `otro` («sin saber») y solo los de nombre válido, que son los que Sloth
/// puede nombrar en un prefijo.
pub fn servidores_revisados(nombres: &[String]) -> Vec<ServidorMcp> {
    nombres.iter().filter(|n| nombre_servidor_valido(n)).map(|n| ServidorMcp { nombre: n.clone(), prefijo: format!("mcp__{n}__"), estado: EstadoMcp::Otro, herramientas: None }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(xs: &[&str]) -> Option<Vec<String>> {
        Some(xs.iter().map(|x| x.to_string()).collect())
    }

    #[test]
    fn dos_servidores_la_subtabla_env_no_suma_otro_nombre() {
        let toml = "model = \"gpt-5\"\n\n[mcp_servers.gruv]\ncommand = \"npx\"\nargs = [\"-y\", \"gruv-mcp\"]\n\n[mcp_servers.gruv.env]\nTOKEN = \"x\"\n\n[mcp_servers.otro]\nurl = \"https://ejemplo.test/mcp\"\n";
        assert_eq!(servidores_de_config_toml(toml), s(&["gruv", "otro"]));
    }

    #[test]
    fn nombres_con_comillas_claves_con_puntos_y_tabla_en_linea() {
        let toml = "[mcp_servers.\"a b\"]\ncommand = \"x\"\n\n[mcp_servers.'c-d']\ncommand = \"y\"\n\n[mcp_servers.gruv]\ncommand = \"z\"\n";
        assert_eq!(servidores_de_config_toml(toml), s(&["a b", "c-d", "gruv"]));
        assert_eq!(servidores_de_config_toml("mcp_servers.e.command = \"x\"\n"), s(&["e"]));
        assert_eq!(servidores_de_config_toml("[mcp_servers]\nf = { command = \"x\" }\n"), s(&["f"]));
    }

    #[test]
    fn duplicado_una_sola_vez_y_en_orden_de_aparicion() {
        let toml = "[mcp_servers.b]\ncommand = \"x\"\n[mcp_servers.a]\ncommand = \"x\"\n[mcp_servers.b.env]\nK = \"v\"\n";
        assert_eq!(servidores_de_config_toml(toml), s(&["b", "a"]));
    }

    #[test]
    fn sin_mcp_servers_vacio_o_solo_comentarios_lista_vacia() {
        assert_eq!(servidores_de_config_toml(""), s(&[]));
        assert_eq!(servidores_de_config_toml("# nada\n[otra]\nx = 1\n"), s(&[]));
        assert_eq!(servidores_de_config_toml("[mcp_servers]\n"), s(&[]));
    }

    #[test]
    fn un_toml_que_no_se_entiende_o_es_enorme_da_none() {
        assert_eq!(servidores_de_config_toml("[mcp_servers.x\ncommand = "), None);
        assert_eq!(servidores_de_config_toml(&format!("a = \"{}\"", "x".repeat(2 * 1024 * 1024))), None);
    }

    #[test]
    fn nombre_servidor_valido_y_servidores_ignorados() {
        for ok in ["gruv", "a_b", "c-d", "X1"] {
            assert!(nombre_servidor_valido(ok), "{ok}");
        }
        for mal in ["", "x y", "a;b", "..", "a.b", "a\"b", "a\nb", &"x".repeat(65), "ñ"] {
            assert!(!nombre_servidor_valido(mal), "{mal:?}");
        }
        assert_eq!(servidores_ignorados(&["ok".into(), "x y".into(), "a.b".into()]), vec!["x y".to_string(), "a.b".to_string()]);
    }

    #[test]
    fn servidor_de_prefijo_solo_servidores_que_pueden_estar_en_un_config_toml() {
        assert_eq!(servidor_de_prefijo("mcp__gruv__").as_deref(), Some("gruv"));
        assert_eq!(servidor_de_prefijo("mcp__gruv-tomy__").as_deref(), Some("gruv-tomy"));
        for no in ["mcp__claude_ai_Linear__", "mcp__a.b__", "gruv", "mcp____"] {
            assert_eq!(servidor_de_prefijo(no), None, "{no}");
        }
    }

    #[test]
    fn servidores_revisados_sin_saber_si_andan_y_sin_los_nombres_que_no_se_pueden_nombrar() {
        assert_eq!(servidores_revisados(&["gruv".into(), "a b".into()]), vec![ServidorMcp { nombre: "gruv".into(), prefijo: "mcp__gruv__".into(), estado: EstadoMcp::Otro, herramientas: None }]);
        assert!(servidores_revisados(&[]).is_empty());
    }

    #[test]
    fn mcp_servers_como_tabla_en_linea_en_la_raiz_no_se_sabe_que_servidores_hay() {
        assert_eq!(servidores_de_config_toml("mcp_servers = { jira = { command = \"x\" } }\n"), None);
        assert_eq!(servidores_de_config_toml("model = \"x\"\nmcp_servers = {}\n"), None);
    }

    #[test]
    fn mcp_servers_con_subtablas_o_claves_con_punto_si_se_leen() {
        assert_eq!(servidores_de_config_toml("[mcp_servers]\njira = { command = \"x\" }\n"), s(&["jira"]));
        assert_eq!(servidores_de_config_toml("mcp_servers.jira = { command = \"x\" }\n"), s(&["jira"]));
    }
}
