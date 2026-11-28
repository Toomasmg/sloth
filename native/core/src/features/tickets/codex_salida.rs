//! Traduce el JSONL de `codex exec --json` al sobre `{type:'result',...}` que ya leen los parsers de Claude. Todo lo que
//! llega es dato externo y las formas son supuestas (sin confirmar contra un Codex real): se valida cada campo y lo que no
//! encaja se ignora. Equivale a src/main/features/tickets/codex-salida.ts.
use super::texto::{colapsar, cortar16, len16, trim_js};
use serde_json::{json, Map, Value};

const MAX_STDOUT: usize = 8 * 1024 * 1024;
const MAX_LINEA: usize = 1_000_000;
const MAX_TEXTO: usize = 200_000;
const MAX_ERROR: usize = 300;
const MAX_TOKENS: f64 = 1e12;

pub const ERROR_SIN_COMPLETAR: &str = "Codex terminó sin completar la respuesta";
pub const ERROR_COMANDOS: &str = "Codex intentó correr comandos; se canceló la consulta";
const ERROR_SIN_TEXTO: &str = "Codex terminó sin devolver ninguna respuesta";
/// Sin una llamada lograda al conector la respuesta no sale de sus datos: una lista vacía no puede pasar por «no hay tickets».
pub const ERROR_SIN_LLAMADA: &str = "Codex respondió sin consultar el conector: no hay datos del conector";
pub const ERROR_LLAMADAS_FALLIDAS: &str = "Todas las llamadas de Codex al conector fallaron";
const TIPOS_INOCUOS: [&str; 4] = ["agent_message", "reasoning", "todo_list", "error"];

pub type Evento = Map<String, Value>;

/// Lo único que una consulta puede llamar: el servidor elegido y las herramientas cortas permitidas para la tarea.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReglaConector {
    pub servidor: String,
    pub herramientas: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct SobreCodex {
    /// Último agent_message completo.
    pub texto: String,
    /// Llamadas MCP iniciadas: es lo que cuenta el tope de vueltas emulado.
    pub vueltas: u32,
    pub tokens: Option<f64>,
    /// Hubo turn.completed.
    pub completado: bool,
    pub error: Option<String>,
    /// Comandos que Codex quiso correr (con `-s read-only` y sin herramientas propias no debería haber).
    pub comandos: u32,
    /// Llamadas MCP terminadas sin fallar.
    pub llamadas_ok: u32,
    /// Llamadas MCP terminadas con `status: failed` o con error.
    pub llamadas_fallidas: u32,
    /// Primera cosa que Codex usó fuera del conector elegido (herramienta de otro servidor, búsqueda web, cambios de archivos…).
    pub fuera: Option<String>,
}

pub fn mensaje_error(v: &Value) -> Option<String> {
    let crudo = match v {
        Value::String(s) => s.as_str(),
        Value::Object(o) => o.get("message")?.as_str()?,
        _ => return None,
    };
    let m = cortar16(&colapsar(crudo), MAX_ERROR).to_string();
    (!m.is_empty()).then_some(m)
}

fn objeto_de(linea: &str) -> Option<Evento> {
    let t = trim_js(linea);
    if len16(t) > MAX_LINEA || !t.starts_with('{') {
        return None;
    }
    // Avisos de stderr mezclados o una línea cortada por el tope de stdout: no son eventos.
    match serde_json::from_str::<Value>(t) {
        Ok(Value::Object(o)) if o.get("type").is_some_and(Value::is_string) => Some(o),
        _ => None,
    }
}

fn item_de(e: &Evento) -> Option<&Evento> {
    e.get("item").and_then(Value::as_object).filter(|i| i.get("type").is_some_and(Value::is_string))
}

fn tipo<'a>(o: &'a Evento) -> &'a str {
    o.get("type").and_then(Value::as_str).unwrap_or("")
}

/// El evento de una línea de stdout, o None si no es un evento (ruido de stderr, línea cortada).
pub fn evento_de(linea: &str) -> Option<Evento> {
    objeto_de(linea)
}

fn limpio(v: Option<&Value>) -> String {
    let s = v.and_then(Value::as_str).unwrap_or("?");
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' {
            out.push(c);
        } else {
            // JavaScript reemplaza por unidad UTF-16.
            for _ in 0..c.len_utf16() {
                out.push('?');
            }
        }
    }
    cortar16(&out, 60).to_string()
}

/// Qué usó Codex que no es el conector elegido, o None si todo está dentro de la regla. Sin regla no se puede decir qué es el
/// conector: toda llamada MCP cuenta como fuera. Los comandos los cubre `es_comando`.
pub fn uso_fuera_del_conector(e: &Evento, regla: Option<&ReglaConector>) -> Option<String> {
    let t = tipo(e);
    if t != "item.started" && t != "item.completed" {
        return None;
    }
    let item = item_de(e)?;
    let it = tipo(item);
    if it == "command_execution" || TIPOS_INOCUOS.contains(&it) {
        return None;
    }
    if it != "mcp_tool_call" {
        return Some(limpio(item.get("type")));
    }
    let (server, tool) = (item.get("server"), item.get("tool"));
    if let (Some(r), Some(Value::String(s)), Some(Value::String(h))) = (regla, server, tool) {
        if *s == r.servidor && r.herramientas.iter().any(|x| x == h) {
            return None;
        }
    }
    Some(format!("{}/{}", limpio(server), limpio(tool)))
}

pub fn error_fuera(fuera: &str) -> String {
    format!("Codex intentó usar algo fuera del conector ({fuera}); se canceló la consulta")
}

pub fn es_llamada_mcp(linea: &str) -> bool {
    if !linea.contains("mcp_tool_call") {
        return false;
    }
    objeto_de(linea).is_some_and(|e| tipo(&e) == "item.started" && item_de(&e).is_some_and(|i| tipo(i) == "mcp_tool_call"))
}

pub fn es_comando(linea: &str) -> bool {
    if !linea.contains("command_execution") {
        return false;
    }
    objeto_de(linea).is_some_and(|e| tipo(&e) == "item.started" && item_de(&e).is_some_and(|i| tipo(i) == "command_execution"))
}

fn fallo_de(item: &Evento) -> bool {
    item.get("status").and_then(Value::as_str) == Some("failed") || (tipo(item) == "mcp_tool_call" && item.get("error").is_some_and(|e| !e.is_null()))
}

fn tokens_de(usage: Option<&Value>) -> Option<f64> {
    let u = usage?.as_object()?;
    let mut suma: Option<f64> = None;
    for k in ["input_tokens", "output_tokens"] {
        if let Some(n) = u.get(k).and_then(Value::as_f64) {
            if n.is_finite() && (0.0..=MAX_TOKENS).contains(&n) {
                suma = Some(suma.unwrap_or(0.0) + n.floor());
            }
        }
    }
    suma
}

pub fn leer_salida_codex(stdout: &str, regla: Option<&ReglaConector>) -> SobreCodex {
    let mut s = SobreCodex::default();
    let (mut fatal, mut aviso, mut fallo): (Option<String>, Option<String>, Option<String>) = (None, None, None);
    for linea in cortar16(stdout, MAX_STDOUT).split('\n') {
        let Some(e) = objeto_de(linea) else { continue };
        let item = item_de(&e);
        if regla.is_some() && s.fuera.is_none() {
            s.fuera = uso_fuera_del_conector(&e, regla);
        }
        let nulo = Value::Null;
        match tipo(&e) {
            "turn.completed" => {
                s.completado = true;
                s.tokens = tokens_de(e.get("usage")).or(s.tokens);
            }
            "turn.failed" => {
                fatal = Some(mensaje_error(e.get("error").unwrap_or(&nulo)).or_else(|| mensaje_error(e.get("message").unwrap_or(&nulo))).unwrap_or_else(|| "Codex no pudo completar el turno".into()));
            }
            // Un error suelto puede ser un aviso que Codex supera (reconexión): solo cuenta si no hubo respuesta.
            "error" => aviso = mensaje_error(e.get("message").unwrap_or(&nulo)).or_else(|| mensaje_error(e.get("error").unwrap_or(&nulo))).or(aviso),
            "item.started" => match item.map(tipo) {
                Some("mcp_tool_call") => s.vueltas += 1,
                Some("command_execution") => s.comandos += 1,
                _ => {}
            },
            "item.completed" => {
                if let Some(i) = item {
                    let it = tipo(i);
                    if it == "agent_message" {
                        if let Some(t) = i.get("text").and_then(Value::as_str) {
                            s.texto = cortar16(t, MAX_TEXTO).to_string();
                        }
                    }
                    if it == "command_execution" {
                        s.comandos += 1;
                    }
                    if it == "mcp_tool_call" {
                        if fallo_de(i) {
                            s.llamadas_fallidas += 1;
                        } else {
                            s.llamadas_ok += 1;
                        }
                    }
                    if it != "agent_message" && fallo_de(i) {
                        fallo = mensaje_error(i.get("error").unwrap_or(&nulo)).or(fallo);
                    }
                }
            }
            _ => {}
        }
    }
    s.error = if s.comandos > 0 {
        Some(ERROR_COMANDOS.to_string())
    } else if let Some(f) = &s.fuera {
        Some(error_fuera(f))
    } else if fatal.is_some() {
        fatal
    } else if !s.completado {
        Some(aviso.or(fallo).unwrap_or_else(|| ERROR_SIN_COMPLETAR.to_string()))
    } else if trim_js(&s.texto).is_empty() {
        Some(fallo.unwrap_or_else(|| ERROR_SIN_TEXTO.to_string()))
    } else if s.llamadas_ok == 0 {
        Some(if s.llamadas_fallidas > 0 {
            match &fallo {
                Some(f) => format!("{ERROR_LLAMADAS_FALLIDAS}: {f}"),
                None => ERROR_LLAMADAS_FALLIDAS.to_string(),
            }
        } else {
            ERROR_SIN_LLAMADA.to_string()
        })
    } else {
        None
    };
    s
}

/// JSON de una línea. Sin `total_cost_usd` (Codex no informa costo) ni `duration_ms` (lo mide quien corre).
pub fn a_sobre_comun(s: &SobreCodex) -> String {
    if s.error.is_some() || !s.completado {
        return json!({
            "type": "result", "agente": "Codex", "permission_denials": [],
            "subtype": "error_during_execution", "is_error": true,
            "result": s.error.clone().unwrap_or_else(|| ERROR_SIN_COMPLETAR.to_string()),
            "num_turns": s.vueltas
        })
        .to_string();
    }
    let mut o = json!({
        "type": "result", "agente": "Codex", "permission_denials": [],
        "subtype": "success", "is_error": false, "result": s.texto, "num_turns": s.vueltas
    });
    if let Some(t) = s.tokens {
        o["usage"] = json!({ "input_tokens": super::texto::num_valor(t) });
    }
    o.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::tickets::conectores::conector_por_id;
    use crate::features::tickets::motor::{parse_detalle, parse_envelope};
    use crate::features::tickets::uso::leer_uso;

    fn l(xs: &[Value]) -> String {
        xs.iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n"
    }

    fn tickets() -> Value {
        json!({ "yo": { "id": "u1", "nombre": "Ana" }, "tickets": [{ "id": "GRV-1", "titulo": "Arreglar login", "estado": "pendiente" }] })
    }

    fn feliz() -> String {
        l(&[
            json!({ "type": "thread.started", "thread_id": "t1" }),
            json!({ "type": "turn.started" }),
            json!({ "type": "item.started", "item": { "id": "i1", "type": "mcp_tool_call", "server": "gruv", "tool": "listar_tickets", "status": "in_progress" } }),
            json!({ "type": "item.completed", "item": { "id": "i1", "type": "mcp_tool_call", "server": "gruv", "tool": "listar_tickets", "status": "completed" } }),
            json!({ "type": "item.completed", "item": { "id": "i2", "type": "agent_message", "text": tickets().to_string() } }),
            json!({ "type": "turn.completed", "usage": { "input_tokens": 1200, "cached_input_tokens": 800, "output_tokens": 90 } }),
        ])
    }

    fn regla() -> ReglaConector {
        ReglaConector { servidor: "gruv".into(), herramientas: vec!["listar_tickets".into()] }
    }

    fn ok() -> Value {
        json!({ "type": "item.completed", "item": { "id": "i1", "type": "mcp_tool_call", "server": "gruv", "tool": "listar_tickets", "status": "completed" } })
    }

    fn falla() -> Value {
        json!({ "type": "item.completed", "item": { "id": "i1", "type": "mcp_tool_call", "server": "gruv", "tool": "listar_tickets", "status": "failed", "error": { "message": "servidor caído" } } })
    }

    fn vacia() -> Value {
        json!({ "type": "item.completed", "item": { "type": "agent_message", "text": json!({ "yo": { "id": "u1", "nombre": "Ana" }, "tickets": [] }).to_string() } })
    }

    fn fin() -> Value {
        json!({ "type": "turn.completed" })
    }

    fn mensaje(t: &str) -> Value {
        json!({ "type": "item.completed", "item": { "type": "agent_message", "text": t } })
    }

    fn gruv_base() -> &'static crate::features::tickets::conector::ConectorBase {
        &conector_por_id("gruv").unwrap().mcp().unwrap().base
    }

    fn sobre(s: &SobreCodex) -> Value {
        serde_json::from_str(&a_sobre_comun(s)).unwrap()
    }

    #[test]
    fn salida_feliz_una_vuelta_texto_y_sobre_de_exito_sin_costo() {
        let s = leer_salida_codex(&feliz(), None);
        assert!(s.completado && s.error.is_none());
        assert_eq!((s.vueltas, s.tokens), (1, Some(1290.0)));
        assert_eq!(s.texto, tickets().to_string());
        let txt = a_sobre_comun(&s);
        assert!(!txt.contains('\n'));
        let j = sobre(&s);
        assert_eq!((&j["type"], &j["subtype"], &j["is_error"], &j["num_turns"], &j["permission_denials"]), (&json!("result"), &json!("success"), &json!(false), &json!(1), &json!([])));
        assert!(j.get("total_cost_usd").is_none() && j.get("duration_ms").is_none());
    }

    #[test]
    fn el_sobre_lo_leen_los_parsers_de_claude() {
        let txt = a_sobre_comun(&leer_salida_codex(&feliz(), None));
        assert_eq!(parse_envelope(gruv_base(), &txt).unwrap().data, tickets());
        let u = leer_uso(&txt).unwrap();
        assert_eq!((u.num_turns, u.tokens, u.cost_usd, u.duration_ms), (Some(1.0), Some(1290.0), None, None));
    }

    #[test]
    fn la_respuesta_de_detalle_tambien_pasa_por_el_sobre() {
        let detalle = json!({ "id": "GRV-1", "titulo": "Arreglar login", "criterios": [{ "texto": "anda", "hecho": false }], "comentarios": [] });
        let s = l(&[ok(), mensaje(&detalle.to_string()), fin()]);
        let m = conector_por_id("gruv").unwrap().mcp().unwrap();
        let d = parse_detalle(m, &a_sobre_comun(&leer_salida_codex(&s, None))).unwrap();
        assert_eq!(d.criterios.len(), 1);
    }

    #[test]
    fn sin_tokens_no_hay_usage() {
        let s = leer_salida_codex(&l(&[mensaje("{}"), fin()]), None);
        assert!(sobre(&s).get("usage").is_none());
    }

    #[test]
    fn turn_failed_con_mensaje_largo_error_recortado_a_300_y_sobre_de_error() {
        let largo = format!("{}\nsegunda línea", "x".repeat(2000));
        let s = leer_salida_codex(&l(&[json!({ "type": "thread.started" }), json!({ "type": "turn.failed", "error": { "message": largo } })]), None);
        let e = s.error.clone().unwrap();
        assert_eq!(e.chars().count(), 300);
        assert!(!e.contains('\n'));
        let j = sobre(&s);
        assert_eq!((&j["subtype"], &j["is_error"]), (&json!("error_during_execution"), &json!(true)));
        let m = parse_envelope(gruv_base(), &j.to_string()).unwrap_err().mensaje();
        assert!(m.starts_with("Codex no pudo completar la consulta: x") && m.chars().skip(40).all(|c| c == 'x'), "{m}");
    }

    #[test]
    fn un_turn_failed_gana_aunque_haya_texto_antes() {
        let s = leer_salida_codex(&l(&[mensaje("hola"), json!({ "type": "turn.failed", "error": { "message": "cuota agotada" } })]), None);
        assert_eq!(s.error.as_deref(), Some("cuota agotada"));
    }

    #[test]
    fn sin_turn_completed_proceso_cortado_es_un_error() {
        let s = leer_salida_codex(&l(&[json!({ "type": "turn.started" }), mensaje("{\"tickets\":[]}")]), None);
        assert!(!s.completado);
        assert!(s.error.clone().unwrap().contains("terminó sin completar"));
        assert_eq!(sobre(&s)["is_error"], json!(true));
        assert_eq!(leer_salida_codex("", None).error.as_deref(), Some("Codex terminó sin completar la respuesta"));
    }

    #[test]
    fn un_error_suelto_no_tumba_una_respuesta_completa_pero_si_explica_una_cortada() {
        let aviso = json!({ "type": "error", "message": "Reconnecting... 1/5" });
        let bien = leer_salida_codex(&l(&[aviso.clone(), ok(), mensaje("{}"), fin()]), None);
        assert_eq!(bien.error, None);
        assert_eq!(leer_salida_codex(&l(&[aviso]), None).error.as_deref(), Some("Reconnecting... 1/5"));
    }

    #[test]
    fn completado_sin_texto_es_un_error_y_usa_el_fallo_de_la_herramienta_si_lo_hay() {
        assert!(leer_salida_codex(&l(&[fin()]), None).error.unwrap().contains("sin devolver ninguna respuesta"));
        let s = leer_salida_codex(&l(&[json!({ "type": "item.completed", "item": { "type": "mcp_tool_call", "status": "failed", "error": { "message": "no autorizado" } } }), fin()]), None);
        assert_eq!(s.error.as_deref(), Some("no autorizado"));
    }

    #[test]
    fn lineas_basura_vacias_arrays_null_tipos_raros_y_una_linea_enorme_se_ignoran_sin_tirar() {
        let enorme = format!("{{\"type\":\"item.completed\",\"item\":{{\"type\":\"agent_message\",\"text\":\"{}\"}}}}", "a".repeat(5 * 1024 * 1024));
        let basura = ["", "   ", "Reading prompt from stdin...", "[]", "null", "{\"type\":5}", "{\"type\":\"x\"", "{\"sin\":\"tipo\"}", "\"texto\"", "42", enorme.as_str()].join("\n");
        let s = leer_salida_codex(&format!("{basura}\n{}", feliz()), None);
        assert_eq!(s.vueltas, 1);
        assert_eq!(s.texto, tickets().to_string());
        assert_eq!(s.error, None);
        let solo = leer_salida_codex(&basura, None);
        assert!(!solo.completado);
        assert_eq!(solo.texto, "");
    }

    #[test]
    fn campos_con_tipos_inesperados_no_cuentan() {
        let s = leer_salida_codex(
            &l(&[
                json!({ "type": "item.started", "item": "mcp_tool_call" }),
                json!({ "type": "item.started", "item": null }),
                json!({ "type": "item.completed", "item": { "type": "agent_message", "text": 7 } }),
                json!({ "type": "turn.completed", "usage": { "input_tokens": "mucho", "output_tokens": -3 } }),
            ]),
            None,
        );
        assert_eq!((s.vueltas, s.texto.as_str(), s.tokens), (0, "", None));
    }

    #[test]
    fn el_texto_del_agente_se_limita_a_200000_caracteres() {
        let s = leer_salida_codex(&l(&[mensaje(&"z".repeat(300_000)), fin()]), None);
        assert_eq!(s.texto.chars().count(), 200_000);
    }

    #[test]
    fn un_command_execution_cancela_la_consulta_aunque_haya_respuesta() {
        let s = leer_salida_codex(&l(&[json!({ "type": "item.started", "item": { "type": "command_execution", "command": "ls" } }), mensaje("{}"), fin()]), None);
        assert_eq!(s.comandos, 1);
        assert_eq!(s.error.as_deref(), Some("Codex intentó correr comandos; se canceló la consulta"));
        assert_eq!(sobre(&s)["is_error"], json!(true));
    }

    #[test]
    fn una_lista_vacia_sin_ninguna_llamada_al_conector_es_un_error_no_no_hay_tickets() {
        let s = leer_salida_codex(&l(&[json!({ "type": "turn.started" }), vacia(), fin()]), Some(&regla()));
        assert_eq!(s.llamadas_ok, 0);
        assert_eq!(s.error.as_deref(), Some(ERROR_SIN_LLAMADA));
        let j = sobre(&s);
        assert_eq!(j["is_error"], json!(true));
        assert!(parse_envelope(gruv_base(), &j.to_string()).unwrap_err().mensaje().contains("sin consultar el conector"));
    }

    #[test]
    fn una_lista_vacia_con_todas_las_llamadas_fallidas_es_un_error_con_el_motivo_de_la_ultima() {
        let inicio = json!({ "type": "item.started", "item": { "type": "mcp_tool_call", "server": "gruv", "tool": "listar_tickets" } });
        let s = leer_salida_codex(&l(&[inicio, falla(), falla(), vacia(), fin()]), Some(&regla()));
        assert_eq!((s.llamadas_fallidas, s.llamadas_ok), (2, 0));
        assert_eq!(s.error, Some(format!("{ERROR_LLAMADAS_FALLIDAS}: servidor caído")));
        assert_eq!(sobre(&s)["is_error"], json!(true));
    }

    #[test]
    fn una_llamada_fallida_con_un_error_sin_status_tambien_cuenta_como_fallida() {
        let s = leer_salida_codex(&l(&[json!({ "type": "item.completed", "item": { "type": "mcp_tool_call", "server": "gruv", "tool": "listar_tickets", "error": "no autorizado" } }), vacia(), fin()]), None);
        assert_eq!(s.llamadas_fallidas, 1);
        assert!(s.error.unwrap().contains("fallaron"));
    }

    #[test]
    fn con_una_llamada_lograda_aunque_otra_haya_fallado_la_lista_vacia_es_una_respuesta() {
        let s = leer_salida_codex(&l(&[falla(), ok(), vacia(), fin()]), Some(&regla()));
        assert_eq!((s.llamadas_ok, s.error.clone()), (1, None));
        assert_eq!(sobre(&s)["subtype"], json!("success"));
    }

    #[test]
    fn una_llamada_con_error_null_o_sin_error_cuenta_como_lograda() {
        let s = leer_salida_codex(&l(&[json!({ "type": "item.completed", "item": { "type": "mcp_tool_call", "server": "gruv", "tool": "listar_tickets", "status": "completed", "error": null } }), vacia(), fin()]), None);
        assert_eq!((s.llamadas_ok, s.error), (1, None));
    }

    #[test]
    fn con_regla_usar_otro_servidor_otra_herramienta_o_la_web_cancela_la_consulta() {
        let otro = json!({ "type": "item.started", "item": { "type": "mcp_tool_call", "server": "mi_otro", "tool": "listar_tickets" } });
        let s = leer_salida_codex(&l(&[otro.clone(), ok(), vacia(), fin()]), Some(&regla()));
        assert_eq!(s.fuera.as_deref(), Some("mi_otro/listar_tickets"));
        assert!(s.error.unwrap().contains("fuera del conector (mi_otro/listar_tickets)"));
        let web = leer_salida_codex(&l(&[ok(), json!({ "type": "item.started", "item": { "type": "web_search" } }), vacia(), fin()]), Some(&regla()));
        assert!(web.error.unwrap().contains("(web_search)"));
        // Sin regla no se juzga qué es el conector.
        assert_eq!(leer_salida_codex(&l(&[otro, ok(), vacia(), fin()]), None).fuera, None);
    }

    #[test]
    fn uso_fuera_del_conector_lo_inocuo_y_lo_ajeno() {
        let ev = |item: Value, t: &str| json!({ "type": t, "item": item }).as_object().unwrap().clone();
        for t in ["agent_message", "reasoning", "todo_list", "error"] {
            assert_eq!(uso_fuera_del_conector(&ev(json!({ "type": t }), "item.started"), Some(&regla())), None);
        }
        assert_eq!(uso_fuera_del_conector(&ev(json!({ "type": "command_execution" }), "item.started"), Some(&regla())), None);
        assert_eq!(uso_fuera_del_conector(json!({ "type": "turn.completed" }).as_object().unwrap(), Some(&regla())), None);
        let mcp = json!({ "type": "mcp_tool_call", "server": "gruv", "tool": "listar_tickets" });
        assert_eq!(uso_fuera_del_conector(&ev(mcp.clone(), "item.started"), Some(&regla())), None);
        assert_eq!(uso_fuera_del_conector(&ev(mcp, "item.started"), None).as_deref(), Some("gruv/listar_tickets"));
        assert_eq!(uso_fuera_del_conector(&ev(json!({ "type": "file_change" }), "item.completed"), Some(&regla())).as_deref(), Some("file_change"));
    }

    #[test]
    fn es_llamada_mcp_y_es_comando_solo_item_started_del_tipo_justo() {
        let mcp = json!({ "type": "item.started", "item": { "type": "mcp_tool_call" } });
        assert!(es_llamada_mcp(&mcp.to_string()));
        assert!(!es_llamada_mcp(&json!({ "type": "item.completed", "item": { "type": "mcp_tool_call" } }).to_string()));
        assert!(!es_llamada_mcp(&json!({ "type": "item.started", "item": { "type": "reasoning" } }).to_string()));
        assert!(!es_llamada_mcp(&json!({ "type": "item.started", "item": { "type": "agent_message", "text": "mcp_tool_call" } }).to_string()));
        assert!(!es_llamada_mcp("mcp_tool_call"));
        assert!(!es_llamada_mcp(""));
        assert!(es_comando(&json!({ "type": "item.started", "item": { "type": "command_execution" } }).to_string()));
        assert!(!es_comando(&json!({ "type": "item.completed", "item": { "type": "command_execution" } }).to_string()));
    }

    #[test]
    fn mensaje_error_recorta_junta_espacios_y_acepta_string_u_objeto_con_message() {
        assert_eq!(mensaje_error(&json!("  a\n\nb  ")).as_deref(), Some("a b"));
        assert_eq!(mensaje_error(&json!({ "message": "x".repeat(400) })).unwrap().chars().count(), 300);
        for v in [json!(""), json!(5), json!({ "message": 5 }), Value::Null] {
            assert_eq!(mensaje_error(&v), None, "{v}");
        }
    }
}
