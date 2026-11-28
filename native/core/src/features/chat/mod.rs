//! Función «chat» (equipo, mensajes directos y MCP para Claude). Equivale a src/main/features/chat*.ts y a
//! src/shared/chat*.ts. Acá va todo lo puro y lo testeable; Supabase, Electron y el SO entran por traits o closures.
pub mod auth;
pub mod callback;
pub mod config;
pub mod datos;
pub mod expulsar;
pub mod fecha;
pub mod fotos;
pub mod fotos_red;
pub mod gotrue;
pub mod http;
pub mod invitacion;
pub mod mapa;
pub mod mcp_atencion;
pub mod mcp_core;
pub mod mcp_main;
pub mod mcp_pipe;
pub mod mcp_registro;
pub mod postgrest;
pub mod principal;
pub mod realtime;
pub mod safestorage;
pub mod sesion;
pub mod texto;
pub mod tipos;
pub mod topicos;
pub mod validar;

/// Los errores de esta función son el texto que se le muestra a la persona.
pub type Res<T> = Result<T, String>;

pub(crate) use super::cortar_utf16;

/// `String(error.message).slice(0, 300)` de los `msgOf` del TypeScript.
pub(crate) fn mensaje_corto(m: &str) -> String {
    if m.is_empty() {
        "Algo salió mal.".to_string()
    } else {
        cortar_utf16(m, 300)
    }
}

/// `String.prototype.trim` de JS.
pub(crate) fn trim_js(s: &str) -> &str {
    s.trim_matches(crate::perfiles_core::es_blanco_js)
}
