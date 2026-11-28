//! El motor de Codex: arma `codex exec` acotado a un solo servidor MCP y lee su salida. Equivale a
//! src/main/features/tickets/motor-codex.ts.
use super::codex_config::{nombre_servidor_valido, servidores_ignorados};
use super::codex_salida::{a_sobre_comun, error_fuera, es_comando, es_llamada_mcp, evento_de, leer_salida_codex, uso_fuera_del_conector, ReglaConector, ERROR_COMANDOS};
use super::conector::ConectorMcp;
use super::errores::{ErrorTickets, Res};
use super::modelo::{Accion, Tope, VUELTAS_DEFECTO};
use super::motor::permisos_por_consulta;
use super::motor_tickets::{incompleto, MotorTickets, PedidoMotor, TareaMotor};
use super::texto::re;
use super::uso::{texto_tope, vueltas_validas_f, UsoCorrida};
use crate::proveedores::ProveedorId;

/// Mientras sea false, la tarea `accion` falla antes de lanzar Codex: que `-c ...enabled_tools` pise lo del config.toml de
/// la cuenta y que con approval_policy never las herramientas MCP corran no está probado a mano. Una escritura necesita
/// además que lo que Codex trae por fuera del conector quede acotado (ver `FUNCIONES_APAGADAS`).
pub const ACCIONES_VERIFICADAS: bool = false;

pub const SOLO_LECTURA: &str = "Las acciones con Codex todavía no se probaron: por ahora es de solo lectura.";
const SIN_DESCUBRIR: &str = "Esta cuenta no puede buscar herramientas todavía: Codex no informa los servidores de la sesión.";

/// Lo que Codex trae por su cuenta además del MCP del conector, apagado con `-c features.<nombre>=false` (lo mismo que
/// `--disable`). Los nombres salen de `codex features list` (0.164, la versión mínima) y la búsqueda web de `web_search`
/// (valores `live|indexed|cached|disabled`, según el propio aviso de Codex). Lo que no se puede apagar desde acá (el
/// `managed_config.toml` de un administrador, por ejemplo) queda acotado solo por `-s read-only`, `approval_policy="never"` y
/// el corte de `cortar_si`, que actúa cuando Codex ya anunció la llamada.
const FUNCIONES_APAGADAS: [&str; 7] = ["shell_tool", "unified_exec", "apps", "plugins", "browser_use", "computer_use", "multi_agent"];

/// Nombres cortos de herramienta que se le dejan al conector en cada tarea: los mismos que `--allowedTools` en Claude.
pub fn herramientas_permitidas(def: &ConectorMcp, tarea: TareaMotor, accion: Option<Accion>) -> Vec<String> {
    let p = permisos_por_consulta(def);
    match tarea {
        TareaMotor::Lista | TareaMotor::Personas => p.lista,
        TareaMotor::Detalle => p.detalle,
        TareaMotor::Accion => accion.and_then(|a| p.acciones.get(a.como_str()).cloned()).unwrap_or_default(),
        _ => Vec::new(),
    }
}

pub fn error_ignorados(nombres: &[String]) -> String {
    let cuales = if nombres.len() == 1 { "un servidor MCP" } else { "servidores MCP" };
    let lista = nombres.iter().take(5).cloned().collect::<Vec<_>>().join(", ");
    format!(
        "La cuenta tiene {cuales} con un nombre que Sloth no puede apagar durante la consulta ({lista}) y dejarlos habilitados le daría a Codex todas sus herramientas. No se consultó nada: renombralos en el config.toml de la cuenta (solo letras, números, guion y guion bajo) y tocá «Volver a revisar»."
    )
}

fn argv(p: &PedidoMotor) -> Res<Vec<String>> {
    if matches!(p.tarea, TareaMotor::Descubrir | TareaMotor::Revisar) {
        return Err(ErrorTickets::otro(SIN_DESCUBRIR));
    }
    if p.tarea == TareaMotor::Accion && !ACCIONES_VERIFICADAS {
        return Err(ErrorTickets::otro(SOLO_LECTURA));
    }
    let def = p.def.ok_or_else(incompleto)?;
    if p.tarea == TareaMotor::Accion && p.accion.is_none() {
        return Err(incompleto());
    }
    // El prefijo del conector (`mcp__claude_ai_Gruv__`) es el nombre que le da Claude: en Codex el servidor se llama como lo
    // puso la persona en su config.
    let (Some(elegido), Some(servidores)) = (p.servidor_elegido.as_deref(), p.servidores_cuenta.as_ref()) else {
        return Err(ErrorTickets::otro("Falta saber qué servidor MCP de la cuenta es el del conector."));
    };
    if !nombre_servidor_valido(elegido) || !servidores.iter().any(|s| s == elegido) {
        return Err(ErrorTickets::otro("El servidor MCP elegido no está en la configuración de la cuenta o su nombre no es válido."));
    }
    // Un servidor que no se puede apagar por su nombre dejaría todas sus herramientas (también las de escritura) a mano de una
    // consulta de lectura: no se consulta.
    let ignorados = servidores_ignorados(servidores);
    if !ignorados.is_empty() {
        return Err(ErrorTickets::otro(error_ignorados(&ignorados)));
    }
    let pedidas = herramientas_permitidas(def, p.tarea, p.accion);
    let herramienta_ok = re(r"^[A-Za-z0-9_.-]{1,128}$");
    let permitidas: Vec<String> = pedidas.iter().filter(|t| herramienta_ok.is_match(t)).cloned().collect();
    if permitidas.is_empty() {
        return Err(ErrorTickets::otro("El conector no tiene herramientas permitidas para esta consulta."));
    }
    // Una que se cae en silencio haría fallar la consulta de una forma que nadie entiende.
    if permitidas.len() != pedidas.len() {
        return Err(ErrorTickets::otro("El conector tiene herramientas con un nombre que Sloth no puede pasarle a Codex."));
    }
    // Sin `-m`: el modelo es el de la cuenta de Codex; p.model es un alias de Claude. Cada valor de `-c` va como un solo
    // elemento: sin shell, nada se concatena ni se separa por espacios.
    let mut apagados: Vec<&String> = Vec::new();
    for n in servidores.iter().filter(|n| n.as_str() != elegido && nombre_servidor_valido(n)) {
        if !apagados.contains(&n) {
            apagados.push(n);
        }
    }
    let mut a: Vec<String> = ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-rules", "-s", "read-only", "-c", "approval_policy=\"never\"", "-c", "web_search=\"disabled\""].iter().map(|s| s.to_string()).collect();
    for f in FUNCIONES_APAGADAS {
        a.push("-c".into());
        a.push(format!("features.{f}=false"));
    }
    for n in apagados {
        a.push("-c".into());
        a.push(format!("mcp_servers.{n}.enabled=false"));
    }
    a.push("-c".into());
    a.push(format!("mcp_servers.{elegido}.enabled_tools={}", serde_json::to_string(&permitidas).unwrap_or_default()));
    a.push("-".into());
    Ok(a)
}

/// Servidor y herramientas del conector para esta tarea; None si el pedido no dice cuál es.
fn regla_de(p: &PedidoMotor) -> Option<ReglaConector> {
    let (def, servidor) = (p.def?, p.servidor_elegido.as_ref()?);
    Some(ReglaConector { servidor: servidor.clone(), herramientas: herramientas_permitidas(def, p.tarea, p.accion) })
}

pub struct MotorCodex;

pub static MOTOR_CODEX: MotorCodex = MotorCodex;

impl MotorTickets for MotorCodex {
    fn id(&self) -> ProveedorId {
        ProveedorId::Codex
    }

    fn experimental(&self) -> bool {
        true
    }

    fn lee_init(&self) -> bool {
        false
    }

    fn argv(&self, p: &PedidoMotor) -> Res<Vec<String>> {
        argv(p)
    }

    fn normalizar(&self, stdout: &str, p: &PedidoMotor) -> String {
        a_sobre_comun(&leer_salida_codex(stdout, regla_de(p).as_ref()))
    }

    /// Corta apenas Codex anuncia algo que no es del conector (la llamada ya salió: lo que la previene son los `-c` del argv,
    /// esto la limita a una) o un comando. El tope de vueltas cuenta las llamadas anunciadas, así que deja correr una de más
    /// antes de cortar: al leer no hace daño.
    fn cortar_si(&self, linea: &str, p: &PedidoMotor) -> Option<ErrorTickets> {
        if es_comando(linea) {
            return Some(ErrorTickets::otro(ERROR_COMANDOS));
        }
        if linea.contains("\"item.") {
            if let Some(e) = evento_de(linea) {
                if let Some(fuera) = uso_fuera_del_conector(&e, regla_de(p).as_ref()) {
                    return Some(ErrorTickets::otro(error_fuera(&fuera)));
                }
            }
        }
        if !es_llamada_mcp(linea) {
            return None;
        }
        let n = p.llamadas.get() + 1;
        p.llamadas.set(n);
        let limite = vueltas_validas_f(p.limites.max_turns).unwrap_or(VUELTAS_DEFECTO);
        if n <= limite {
            return None;
        }
        Some(ErrorTickets::Tope {
            mensaje: texto_tope(Tope::Vueltas, f64::from(limite), p.tarea == TareaMotor::Accion),
            tope: Tope::Vueltas,
            uso: UsoCorrida { num_turns: Some(f64::from(n)), tope: Some(Tope::Vueltas), ..UsoCorrida::default() },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::tickets::conectores::conector_por_id;
    use crate::features::tickets::motor::Limites;
    use crate::features::tickets::motor_tickets::{motor_de, TareaMotor::*};
    use serde_json::{json, Value};

    fn gruv() -> &'static ConectorMcp {
        conector_por_id("gruv").unwrap().mcp().unwrap()
    }

    fn lista<'a>(f: impl FnOnce(&mut PedidoMotor<'a>)) -> PedidoMotor<'a> {
        let mut p = PedidoMotor::nuevo(Lista, "haiku");
        p.def = Some(gruv());
        p.servidores_cuenta = Some(vec!["gruv".into(), "otro".into()]);
        p.servidor_elegido = Some("gruv".into());
        f(&mut p);
        p
    }

    fn base() -> PedidoMotor<'static> {
        lista(|_| {})
    }

    fn llamada(server: &str, tool: &str, t: &str) -> String {
        json!({ "type": t, "item": { "type": "mcp_tool_call", "server": server, "tool": tool } }).to_string()
    }

    fn tool() -> String {
        permisos_por_consulta(gruv()).lista[0].clone()
    }

    const MENSAJE: &str = "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"{}\"}}";

    fn cs(p: &PedidoMotor, l: &str) -> Option<ErrorTickets> {
        MOTOR_CODEX.cortar_si(l, p)
    }

    fn msg(r: Res<Vec<String>>) -> String {
        r.unwrap_err().mensaje()
    }

    fn strs(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn argv_de_lista_solo_lectura_funciones_propias_apagadas_ajenos_apagados_el_conector_acotado() {
        let a = MOTOR_CODEX.argv(&base()).unwrap();
        let cortas = permisos_por_consulta(gruv()).lista;
        let mut esperado = strs(&["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-rules", "-s", "read-only", "-c", "approval_policy=\"never\"", "-c", "web_search=\"disabled\""]);
        for f in ["shell_tool", "unified_exec", "apps", "plugins", "browser_use", "computer_use", "multi_agent"] {
            esperado.extend(strs(&["-c", &format!("features.{f}=false")]));
        }
        esperado.extend(strs(&["-c", "mcp_servers.otro.enabled=false", "-c", &format!("mcp_servers.gruv.enabled_tools={}", serde_json::to_string(&cortas).unwrap()), "-"]));
        assert_eq!(a, esperado);
        assert!(!a.contains(&"-m".to_string()));
    }

    #[test]
    fn ningun_elemento_del_argv_lleva_un_nombre_sin_validar_ni_texto_de_un_ticket() {
        let a = MOTOR_CODEX.argv(&lista(|p| p.servidores_cuenta = Some(strs(&["otro", "gruv"])))).unwrap();
        assert!(a.iter().all(|x| !x.chars().any(char::is_whitespace)));
        for hostil in ["GRV-1; rm -rf /", "a\"b", "x y", "mi.server"] {
            let p = lista(|p| p.servidores_cuenta = Some(strs(&["otro", hostil, "gruv"])));
            assert!(msg(MOTOR_CODEX.argv(&p)).contains("no puede apagar"), "{hostil}");
        }
    }

    #[test]
    fn con_un_servidor_de_nombre_no_valido_no_se_consulta_el_motivo_dice_cual_y_como_arreglarlo() {
        let m = msg(MOTOR_CODEX.argv(&lista(|p| p.servidores_cuenta = Some(strs(&["gruv", "mi.server"])))));
        assert!(m.contains("mi.server") && m.contains("No se consultó nada") && m.contains("renombralos"), "{m}");
        assert!(msg(MOTOR_CODEX.argv(&lista(|p| p.servidores_cuenta = Some(strs(&["gruv", "a.b", "c d"]))))).contains("servidores MCP"));
        assert!(MOTOR_CODEX.argv(&lista(|p| p.servidores_cuenta = Some(strs(&["gruv", "ok-1", "ok_2"])))).is_ok());
    }

    #[test]
    fn un_nombre_de_herramienta_que_no_se_puede_pasar_no_se_descarta_en_silencio() {
        let mut raro = gruv().clone();
        raro.herramientas.lista.push("a b".into());
        assert!(msg(MOTOR_CODEX.argv(&lista(|p| p.def = Some(&raro)))).contains("nombre que Sloth no puede pasarle"));
    }

    #[test]
    fn el_servidor_elegido_no_se_apaga_a_si_mismo_y_los_demas_van_una_sola_vez() {
        let a = MOTOR_CODEX.argv(&lista(|p| p.servidores_cuenta = Some(strs(&["otro", "otro", "gruv"])))).unwrap();
        assert_eq!(a.iter().filter(|x| *x == "mcp_servers.otro.enabled=false").count(), 1);
        assert!(!a.contains(&"mcp_servers.gruv.enabled=false".to_string()));
        let b = MOTOR_CODEX.argv(&lista(|p| {
            p.servidor_elegido = Some("otro".into());
            p.servidores_cuenta = Some(strs(&["gruv", "otro"]));
        }))
        .unwrap();
        assert!(b.contains(&"mcp_servers.gruv.enabled=false".to_string()));
        assert!(b.iter().any(|x| x.starts_with("mcp_servers.otro.enabled_tools=")));
    }

    #[test]
    fn sin_saber_los_servidores_de_la_cuenta_o_el_elegido_no_se_lanza() {
        assert!(msg(MOTOR_CODEX.argv(&lista(|p| p.servidores_cuenta = None))).contains("Falta saber"));
        assert!(msg(MOTOR_CODEX.argv(&lista(|p| p.servidor_elegido = None))).contains("Falta saber"));
        assert!(msg(MOTOR_CODEX.argv(&lista(|p| p.servidor_elegido = Some("otro-que-no-esta".into())))).contains("no está en la configuración"));
    }

    #[test]
    fn detalle_usa_las_herramientas_de_detalle() {
        let a = MOTOR_CODEX.argv(&lista(|p| p.tarea = Detalle)).unwrap();
        let esperado = format!("mcp_servers.gruv.enabled_tools={}", serde_json::to_string(&permisos_por_consulta(gruv()).detalle).unwrap());
        assert!(a.contains(&esperado));
    }

    #[test]
    fn accion_falla_antes_de_armar_nada_mientras_no_este_verificada() {
        assert!(!ACCIONES_VERIFICADAS);
        assert!(msg(MOTOR_CODEX.argv(&lista(|p| {
            p.tarea = TareaMotor::Accion;
            p.accion = Some(crate::features::tickets::modelo::Accion::Comentar)
        })))
        .contains("solo lectura"));
        assert!(msg(MOTOR_CODEX.argv(&PedidoMotor::nuevo(TareaMotor::Accion, "m"))).contains("solo lectura"));
    }

    #[test]
    fn descubrir_y_revisar_no_existen_con_codex() {
        for t in [Descubrir, Revisar] {
            assert!(msg(MOTOR_CODEX.argv(&PedidoMotor::nuevo(t, "m"))).contains("no puede buscar herramientas"));
        }
    }

    #[test]
    fn pedido_incompleto_o_prefijo_raro_falla_en_vez_de_armar_a_medias() {
        assert!(msg(MOTOR_CODEX.argv(&PedidoMotor::nuevo(Lista, "m"))).contains("incompleto"));
        assert!(msg(MOTOR_CODEX.argv(&lista(|p| p.servidor_elegido = Some("x y".into())))).contains("no es válido"));
        let mut sin = gruv().clone();
        sin.herramientas.detalle = vec![];
        sin.herramientas.apoyo = Some(vec![]);
        assert!(msg(MOTOR_CODEX.argv(&lista(|p| {
            p.def = Some(&sin);
            p.tarea = Detalle
        })))
        .contains("no tiene herramientas permitidas"));
    }

    #[test]
    fn herramientas_permitidas_coincide_con_permisos_por_consulta() {
        let p = permisos_por_consulta(gruv());
        assert_eq!(herramientas_permitidas(gruv(), Lista, None), p.lista);
        assert_eq!(herramientas_permitidas(gruv(), Detalle, None), p.detalle);
        for (a, xs) in p.acciones.iter() {
            let accion = crate::features::tickets::modelo::Accion::de_str(a).unwrap();
            assert_eq!(&herramientas_permitidas(gruv(), TareaMotor::Accion, Some(accion)), xs);
        }
        assert!(herramientas_permitidas(gruv(), TareaMotor::Accion, None).is_empty());
        assert!(herramientas_permitidas(gruv(), Descubrir, None).is_empty());
        assert!(herramientas_permitidas(gruv(), Lista, None).iter().all(|t| !t.starts_with("mcp__")));
    }

    #[test]
    fn cortar_si_emula_el_tope_de_vueltas_con_las_llamadas_mcp() {
        let p = lista(|p| p.limites = Limites { max_turns: Some(2.0), max_cost_usd: None });
        let mcp = llamada("gruv", &tool(), "item.started");
        assert_eq!(cs(&p, &mcp), None);
        assert_eq!(cs(&p, "{\"type\":\"turn.started\"}"), None);
        assert_eq!(cs(&p, &mcp), None);
        let Some(ErrorTickets::Tope { mensaje, tope, uso }) = cs(&p, &mcp) else { panic!("debía cortar por tope") };
        assert_eq!((tope, uso.num_turns), (Tope::Vueltas, Some(3.0)));
        assert!(mensaje.contains("tope de vueltas (2)"), "{mensaje}");
        let otra = lista(|p| p.limites = Limites { max_turns: Some(2.0), max_cost_usd: None });
        assert_eq!(cs(&otra, &mcp), None);
    }

    #[test]
    fn cortar_si_corta_una_herramienta_de_otro_servidor_o_fuera_de_la_lista_en_started_y_en_completed() {
        let fuera_de_la_lista = "crear_issue";
        assert!(!permisos_por_consulta(gruv()).lista.iter().any(|t| t == fuera_de_la_lista));
        for t in ["item.started", "item.completed"] {
            let otro = cs(&base(), &llamada("mi_otro", &tool(), t)).unwrap();
            assert!(otro.mensaje().contains("fuera del conector (mi_otro/"));
            assert!(!matches!(otro, ErrorTickets::Tope { .. }));
            assert!(cs(&base(), &llamada("gruv", fuera_de_la_lista, t)).unwrap().mensaje().contains("fuera del conector (gruv/crear_issue)"));
        }
        // Server o tool ausentes o de otro tipo: con duda se corta.
        for item in [json!({ "type": "mcp_tool_call" }), json!({ "type": "mcp_tool_call", "server": "gruv" }), json!({ "type": "mcp_tool_call", "server": 7, "tool": 7 })] {
            assert!(cs(&base(), &json!({ "type": "item.started", "item": item }).to_string()).is_some());
        }
        // Una llamada de las permitidas no corta, y tampoco el texto ni el razonamiento.
        assert_eq!(cs(&base(), &llamada("gruv", &tool(), "item.completed")), None);
        assert_eq!(cs(&base(), MENSAJE), None);
        assert_eq!(cs(&base(), &json!({ "type": "item.started", "item": { "type": "reasoning" } }).to_string()), None);
    }

    #[test]
    fn cortar_si_corta_con_un_pedido_que_no_dice_cual_es_el_conector() {
        let mcp = llamada("gruv", &tool(), "item.started");
        assert!(cs(&lista(|p| p.servidor_elegido = None), &mcp).is_some());
        assert!(cs(&lista(|p| p.def = None), &mcp).is_some());
    }

    #[test]
    fn cortar_si_corta_busqueda_web_cambios_de_archivos_subagentes_y_tipos_que_no_conoce() {
        for t in ["web_search", "file_change", "collab_tool_call", "algo_nuevo"] {
            let e = cs(&base(), &json!({ "type": "item.started", "item": { "type": t } }).to_string()).unwrap();
            assert!(e.mensaje().contains(&format!("fuera del conector ({t})")), "{t}");
        }
    }

    #[test]
    fn cortar_si_sanea_lo_que_cuenta_de_la_herramienta_ajena() {
        let e = cs(&base(), &llamada("x\n<script>", &"y".repeat(500), "item.started")).unwrap().mensaje();
        assert!(!e.contains('\n') && !e.contains('<') && e.chars().count() < 200, "{e}");
    }

    #[test]
    fn cortar_si_no_confunde_el_texto_de_un_ticket_con_un_evento() {
        let texto = json!({ "type": "item.completed", "item": { "type": "agent_message", "text": "\"item.started\" mcp_tool_call web_search" } }).to_string();
        assert_eq!(cs(&base(), &texto), None);
        assert_eq!(cs(&base(), "Reading prompt \"item.started\" from stdin"), None);
    }

    #[test]
    fn cortar_si_corta_si_codex_quiere_correr_un_comando() {
        let e = cs(&base(), &json!({ "type": "item.started", "item": { "type": "command_execution" } }).to_string()).unwrap();
        assert!(e.mensaje().contains("intentó correr comandos"));
        assert!(!matches!(e, ErrorTickets::Tope { .. }));
    }

    #[test]
    fn el_motor_es_experimental_no_lee_init_no_suma_entorno_y_normaliza_al_sobre_comun() {
        assert!(MOTOR_CODEX.experimental() && !MOTOR_CODEX.lee_init());
        assert!(MOTOR_CODEX.env_extra(&base()).is_empty());
        let s = format!("{}\n{MENSAJE}\n{{\"type\":\"turn.completed\"}}\n", llamada("gruv", &tool(), "item.completed"));
        let j: Value = serde_json::from_str(&MOTOR_CODEX.normalizar(&s, &base())).unwrap();
        assert_eq!(j["subtype"], json!("success"));
    }

    #[test]
    fn normalizar_una_llamada_a_otra_herramienta_es_un_error_aunque_haya_respuesta() {
        let s = format!("{}\n{}\n{MENSAJE}\n{{\"type\":\"turn.completed\"}}\n", llamada("mi_otro", "x", "item.completed"), llamada("gruv", &tool(), "item.completed"));
        let j: Value = serde_json::from_str(&MOTOR_CODEX.normalizar(&s, &base())).unwrap();
        assert_eq!(j["is_error"], json!(true));
        assert!(j["result"].as_str().unwrap().contains("fuera del conector (mi_otro/x)"));
    }

    #[test]
    fn normalizar_sin_una_llamada_al_conector_no_hay_datos_no_una_lista_vacia() {
        let vacia = "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"{\\\"tickets\\\":[]}\"}}\n{\"type\":\"turn.completed\"}\n";
        let j: Value = serde_json::from_str(&MOTOR_CODEX.normalizar(vacia, &base())).unwrap();
        assert_eq!(j["is_error"], json!(true));
        assert!(j["result"].as_str().unwrap().contains("sin consultar el conector"));
    }

    #[test]
    fn motores_codex_esta_registrado() {
        assert_eq!(motor_de(&json!({ "proveedor": "codex" })).map(|m| m.id()), Some(ProveedorId::Codex));
        assert!(motor_de(&json!({ "proveedor": "codex" })).unwrap().experimental());
    }
}
