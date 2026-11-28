//! Pruebas de probar.rs: los casos de probar.test.ts.
use super::conector::ConectorMcp;
use super::conectores::conector_por_id;
use super::cuentas::con_prefijo;
use super::modelo::{Disponibilidad, EstadoMcp, EstadoPrueba, ResultadoPrueba};
use super::motor::Limites;
use super::probar::*;
use serde_json::{json, Value};

fn base() -> &'static ConectorMcp {
    conector_por_id("gruv").and_then(|d| d.mcp()).unwrap()
}

fn tomy() -> ConectorMcp {
    con_prefijo(base(), "mcp__gruv-tomy__").unwrap()
}

fn tiene(estado: EstadoMcp, verificado: bool) -> Disponibilidad {
    Disponibilidad::Tiene { nombre: "gruv-tomy".into(), prefijo: "mcp__gruv-tomy__".into(), estado, adaptado: true, verificado }
}

fn dx(d: &Disponibilidad, datos: Option<DatosMcp>, prueba: Option<ResultadoDePrueba>, error_revision: Option<String>) -> ResultadoPrueba {
    diagnosticar(&EntradaDiagnostico { def: &tomy(), cuenta: "Cosmos-Fusion", d, error_revision, datos, prueba, ms: 4200 })
}

fn simple(d: &Disponibilidad) -> ResultadoPrueba {
    dx(d, None, None, None)
}

fn sobre(structured: Value) -> String {
    json!([{ "type": "system", "subtype": "init" }, { "type": "result", "subtype": "success", "is_error": false, "result": "", "structured_output": structured }]).to_string()
}

const GET_ROTO: &str = "stdio-roto:\n  Scope: User config (available in all your projects)\n  Status: ✘ Failed to connect\n  Issue: CONNECTION_CLOSED: Connection closed\n  Type: stdio\n  Command: nodo-que-no-existe\n  Args:\n";
const GET_LENTO: &str = "gruv-lento:\n  Scope: User config (available in all your projects)\n  Status: ✘ Failed to connect\n  Issue: MCP server \"gruv-lento\" connection timed out after 30000ms\n  Type: http\n  URL: http://127.0.0.1:18703\n";
const GET_LOCAL: &str = "otro:\n  Scope: Local config (private to you in this project)\n  Status: ✘ Failed to connect\n  Issue: HTTP 500\n  Type: http\n  URL: https://x.example/mcp\n  Headers:\n    Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEF\n";

fn valor(a: &[String], f: &str) -> String {
    a[a.iter().position(|x| x == f).unwrap() + 1].clone()
}

#[test]
fn la_prueba_llama_a_una_sola_herramienta_de_lectura_del_servidor_de_la_cuenta() {
    let args = build_probar_args(&tomy(), "haiku", &["mcp__otro".to_string()], Limites::default());
    assert_eq!(valor(&args, "--allowedTools"), "mcp__gruv-tomy__listar_tickets");
    assert!(valor(&args, "--disallowedTools").contains("mcp__gruv-tomy__mover_ticket"));
    assert!(valor(&args, "--disallowedTools").ends_with("mcp__otro"));
    assert_eq!(valor(&args, "--max-turns"), "6");
    assert!(args.iter().any(|a| a == "--verbose"));
    assert!(build_probar_prompt(&tomy()).contains("UNA sola vez a listar_tickets"));
}

#[test]
fn el_tope_de_vueltas_del_usuario_no_alarga_la_prueba_pero_el_de_costo_se_respeta() {
    let args = build_probar_args(&tomy(), "haiku", &[], Limites { max_turns: Some(90.0), max_cost_usd: Some(1.5) });
    assert_eq!(valor(&args, "--max-turns"), "6");
    assert_eq!(valor(&args, "--max-budget-usd"), "1.5");
}

#[test]
fn parse_probar_ok_error_con_motivo_y_herramienta_que_falta() {
    let t = tomy();
    assert_eq!(parse_probar(&t, &sobre(json!({ "ok": true }))).unwrap(), Prueba { ok: true, error: None });
    assert_eq!(parse_probar(&t, &sobre(json!({ "ok": false, "error": "HTTP 401" }))).unwrap(), Prueba { ok: false, error: Some("HTTP 401".into()) });
    assert_eq!(parse_probar(&t, &sobre(json!({ "ok": false }))).unwrap(), Prueba { ok: false, error: Some("sin motivo".into()) });
}

#[test]
fn limpiar_causa_tapa_tokens_bearer_y_deja_solo_el_origen_de_las_url() {
    let l = limpiar_causa_defecto;
    assert_eq!(l("GET https://api.example.com/v1/x?token=abc123secret falló"), "GET https://api.example.com falló");
    assert_eq!(l("Authorization: Bearer abcdef.ghijkl-mnop"), "Authorization: Bearer ***");
    assert_eq!(l("clave abcdefghijklmnopqrstuvwxyz0123456789ABCDEF rota"), "clave *** rota");
    assert_eq!(l("fallo https://user:pass@host.example/x"), "fallo https://host.example");
    assert_eq!(l("api_key=abc123 y X-Api-Key: zzz"), "api_key=*** y X-Api-Key=***");
    assert_eq!(l("Authorization: Basic dXNlcjpwYXNz"), "Authorization: Basic ***");
    assert_eq!(l("a\nb\u{0}c"), "a b c");
    assert!(l(&"x".repeat(500)).chars().count() <= 200);
}

#[test]
fn datos_de_mcp_get_lee_solo_el_alcance_y_el_motivo_nunca_la_url_ni_las_cabeceras() {
    assert_eq!(datos_de_mcp_get(GET_ROTO), DatosMcp { alcance: Some("usuario".into()), motivo: Some("CONNECTION_CLOSED: Connection closed".into()) });
    assert_eq!(datos_de_mcp_get(GET_LENTO), DatosMcp { alcance: Some("usuario".into()), motivo: Some("MCP server \"gruv-lento\" connection timed out after 30000ms".into()) });
    let local = datos_de_mcp_get(GET_LOCAL);
    assert_eq!(local, DatosMcp { alcance: Some("local".into()), motivo: Some("HTTP 500".into()) });
    let texto = format!("{local:?}");
    assert!(!texto.contains("Bearer") && !texto.contains("abcdefghijkl") && !texto.contains("x.example"));
    assert_eq!(datos_de_mcp_get("nada útil"), DatosMcp::default());
}

#[test]
fn nombre_probable_solo_nombres_simples() {
    for ok in ["gruv-tomy", "gruv.punto", "mi_servidor2"] {
        assert!(nombre_probable(ok), "{ok}");
    }
    for mal in ["claude.ai Gruv", "--help", "-x", "", "a b", "a;b", &"x".repeat(65)] {
        assert!(!nombre_probable(mal), "{mal}");
    }
}

#[test]
fn necesita_sesion_lo_dice_con_el_nombre_del_servidor_y_la_cuenta_y_que_hacer() {
    let r = simple(&tiene(EstadoMcp::NecesitaAuth, false));
    assert_eq!(r.estado, EstadoPrueba::NecesitaSesion);
    assert_eq!(r.mensaje, "El servidor «gruv-tomy» pide iniciar sesión.");
    assert!(r.que_hacer.unwrap().contains("cuenta «Cosmos-Fusion», corré /mcp, elegí «gruv-tomy»"));
}

#[test]
fn no_conecta_dice_la_causa_y_si_es_de_otro_alcance_que_sloth_no_lo_ve() {
    let lento = dx(&tiene(EstadoMcp::Fallo, false), Some(datos_de_mcp_get(GET_LENTO)), None, None);
    assert_eq!(lento.estado, EstadoPrueba::Error);
    assert_eq!(lento.mensaje, "No se pudo conectar a «gruv-tomy».");
    assert!(lento.causa.unwrap().contains("connection timed out after 30000ms"));
    assert!(!lento.que_hacer.unwrap().contains("alcance"));
    let local = dx(&tiene(EstadoMcp::Fallo, false), Some(datos_de_mcp_get(GET_LOCAL)), None, None);
    assert!(local.que_hacer.unwrap().contains("alcance local: Sloth consulta desde otra carpeta y no lo ve"));
    assert_eq!(simple(&tiene(EstadoMcp::Fallo, false)).causa.as_deref(), Some("Claude Code no dijo por qué."));
}

#[test]
fn pending_al_terminar_la_revision_es_un_error_de_tiempo_no_conectado() {
    let r = simple(&tiene(EstadoMcp::Pendiente, false));
    assert_eq!(r.estado, EstadoPrueba::Error);
    assert!(r.mensaje.contains("no terminó de conectar a tiempo"));
}

#[test]
fn sin_el_servidor_sin_herramientas_y_avisa_del_alcance_local_o_de_proyecto() {
    let r = simple(&Disponibilidad::Falta { parecido: None });
    assert_eq!(r.estado, EstadoPrueba::SinHerramientas);
    assert!(r.que_hacer.unwrap().contains("--scope user"));
    let parecido = simple(&Disponibilidad::Falta { parecido: Some(("gruv-tomy".into(), vec!["ver_mi_perfil".into(), "buscar_persona".into()])) });
    assert_eq!(parecido.estado, EstadoPrueba::SinHerramientas);
    assert_eq!(parecido.causa.as_deref(), Some("Le faltan: ver_mi_perfil, buscar_persona."));
}

#[test]
fn un_conector_de_claude_ai_sin_conectar_manda_a_claude_ai_no_a_mcp() {
    let r = diagnosticar(&EntradaDiagnostico { def: base(), cuenta: "Cosmos-Fusion", d: &Disponibilidad::Falta { parecido: None }, error_revision: None, datos: None, prueba: None, ms: 1 });
    assert!(r.que_hacer.unwrap().contains("claude.ai"));
}

#[test]
fn mas_de_un_servidor_posible_pide_elegir() {
    let r = simple(&Disponibilidad::Elegir { opciones: vec![] });
    assert_eq!(r.estado, EstadoPrueba::Error);
    assert!(r.que_hacer.unwrap().contains("Conectores por cuenta"));
}

#[test]
fn conectado_con_herramientas_sin_prueba_ok_error_sin_la_herramienta_y_por_plazo() {
    let d = tiene(EstadoMcp::Conectado, true);
    let con = |p: ResultadoDePrueba| dx(&d, None, Some(p), None);
    assert_eq!(simple(&d).estado, EstadoPrueba::Conectado);
    let ok = con(ResultadoDePrueba::Prueba(Prueba { ok: true, error: None }));
    assert_eq!(ok.estado, EstadoPrueba::Conectado);
    assert!(ok.mensaje.contains("respondió a una consulta de prueba (4 s)"), "{}", ok.mensaje);
    let mal = con(ResultadoDePrueba_err("HTTP 401: token vencido"));
    assert_eq!(mal.estado, EstadoPrueba::Error);
    assert_eq!(mal.causa.as_deref(), Some("HTTP 401: token vencido"));
    assert_eq!(con(ResultadoDePrueba_err("sin_herramienta")).estado, EstadoPrueba::SinHerramientas);
    let plazo = con(ResultadoDePrueba::PlazoS(75.0));
    assert_eq!(plazo.estado, EstadoPrueba::Error);
    assert!(plazo.mensaje.contains("tardó más de 75 s"));
    assert_eq!(con(ResultadoDePrueba::Cayo("No pude abrir Claude".into())).causa.as_deref(), Some("No pude abrir Claude"));
}

#[allow(non_snake_case)]
fn ResultadoDePrueba_err(e: &str) -> ResultadoDePrueba {
    ResultadoDePrueba::Prueba(Prueba { ok: false, error: Some(e.into()) })
}

#[test]
fn conectado_pero_sin_haberle_visto_las_herramientas_no_se_da_por_bueno() {
    assert_eq!(simple(&tiene(EstadoMcp::Conectado, false)).estado, EstadoPrueba::SinHerramientas);
}

#[test]
fn cuenta_sin_revisar_el_error_de_la_revision_llega_como_causa() {
    let r = dx(&Disponibilidad::SinRevisar, None, None, Some("No encontré el ejecutable de Claude Code".into()));
    assert_eq!(r.estado, EstadoPrueba::Error);
    assert_eq!(r.causa.as_deref(), Some("No encontré el ejecutable de Claude Code"));
}
