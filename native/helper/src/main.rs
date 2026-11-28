//! sloth-hook: lo que ejecutan Claude Code y Codex en cada hook, en la statusline y al terminar un turno.
//!
//!   sloth-hook <Evento>              hook de Claude Code (JSON por stdin)
//!   sloth-hook statusline [<cmd>]    envoltorio de la statusline; <cmd> es la original en base64url
//!   sloth-hook notify <json>         aviso de turno terminado de Codex
//!   sloth-hook chat-mcp              MCP stdio del chat de Sloth (JSON-RPC por stdin/stdout)
//!
//! Siempre sale con código 0 (salvo la statusline original, que devuelve el suyo): un hook roto no puede frenar a Claude.
mod chat_mcp;
mod hook;
mod http;
mod notify;
mod statusline;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("statusline") => statusline::run(args.get(1).map(String::as_str)),
        Some("chat-mcp") => chat_mcp::run(),
        Some("notify") => notify::run(args.last().filter(|_| args.len() > 1).map(String::as_str)),
        Some(evento) => hook::run(evento),
        None => {}
    }
}
