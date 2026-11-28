//! Pruebas de cuentas.rs: los casos de cuentas.test.ts.
use super::conector::ConectorMcp;
use super::conectores::conector_por_id;
use super::cuentas::*;
use super::descubrir::{build_descubrir_args, Formato};
use super::errores::ErrorTickets;
use super::modelo::{CuentaRevisada, Disponibilidad, EstadoMcp, OpcionServidor, ServidorMcp};
use super::motor::{build_lista_args, Limites};
use super::texto::Num;
use serde_json::{json, Value};

fn mcp(id: &str) -> &'static ConectorMcp {
    conector_por_id(id).and_then(|d| d.mcp()).unwrap()
}

const ATL: &str = "mcp__claude_ai_Atlassian_MCP__";

fn tools_de(d: &ConectorMcp) -> Vec<String> {
    d.herramientas.lista.iter().chain(d.herramientas.detalle.iter()).cloned().collect()
}

fn strs(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|x| x.to_string()).collect()
}

fn srv(nombre: &str, estado: EstadoMcp, herramientas: Option<Vec<String>>) -> ServidorMcp {
    ServidorMcp { nombre: nombre.into(), prefijo: prefijo_de_servidor(nombre).unwrap(), estado, herramientas }
}

fn cuenta(servidores: Vec<ServidorMcp>) -> CuentaRevisada {
    CuentaRevisada { revisada_en: Num(1.0), servidores, error: None }
}

fn nombres(v: &[&ServidorMcp]) -> Vec<String> {
    v.iter().map(|s| s.nombre.clone()).collect()
}

fn salida_cosmos(result: Value) -> String {
    let mut r = json!({ "type": "result", "subtype": "success", "is_error": false });
    for (k, v) in result.as_object().unwrap() {
        r[k] = v.clone();
    }
    json!([
        {
            "type": "system", "subtype": "init",
            "mcp_servers": [
                { "name": "gruv-tomy", "status": "pending" },
                { "name": "claude.ai Atlassian MCP", "status": "connected" },
                { "name": "claude.ai Notion", "status": "needs-auth" },
                { "name": "raro", "status": "algo-nuevo" }
            ],
            "tools": ["Bash", format!("{ATL}searchJiraIssuesUsingJql"), format!("{ATL}getJiraIssue"), format!("{ATL}mal nombre"), "mcp__otro__x"]
        },
        { "type": "assistant" },
        r
    ])
    .to_string()
}

fn tiene_d(nombre: &str, prefijo: &str, estado: EstadoMcp, adaptado: bool, verificado: bool) -> Disponibilidad {
    Disponibilidad::Tiene { nombre: nombre.into(), prefijo: prefijo.into(), estado, adaptado, verificado }
}

fn opcion(nombre: &str, prefijo: &str, estado: EstadoMcp) -> OpcionServidor {
    OpcionServidor { nombre: nombre.into(), prefijo: prefijo.into(), estado }
}

fn tiene_estado(estado: EstadoMcp) -> Disponibilidad {
    tiene_d("gruv-tomy", "mcp__gruv-tomy__", estado, true, estado == EstadoMcp::Conectado)
}

fn prefijo_de(d: &Disponibilidad) -> Option<&str> {
    if let Disponibilidad::Tiene { prefijo, .. } = d {
        Some(prefijo)
    } else {
        None
    }
}

fn estado_de(d: &Disponibilidad) -> Option<EstadoMcp> {
    if let Disponibilidad::Tiene { estado, .. } = d {
        Some(*estado)
    } else {
        None
    }
}

use EstadoMcp::{Conectado, Fallo, NecesitaAuth, Otro, Pendiente};

#[test]
fn prefijo_de_servidor_pasa_a_guion_bajo_lo_que_no_es_letra_numero_o_guiones() {
    assert_eq!(prefijo_de_servidor("claude.ai Atlassian MCP").as_deref(), Some(ATL));
    assert_eq!(prefijo_de_servidor("plugin:design:atlassian").as_deref(), Some("mcp__plugin_design_atlassian__"));
    assert_eq!(prefijo_de_servidor("gruv-tomy").as_deref(), Some("mcp__gruv-tomy__"));
    assert_eq!(prefijo_de_servidor(&"a".repeat(80)), None);
    assert_eq!(prefijo_de_servidor(""), None);
    // JavaScript cuenta por unidades UTF-16: un emoji deja dos guiones bajos.
    assert_eq!(prefijo_de_servidor("a😀b").as_deref(), Some("mcp__a__b__"));
}

#[test]
fn servidores_de_salida_lee_estados_y_herramientas_de_init_sin_inventar_servidores() {
    let sv = servidores_de_salida(&salida_cosmos(json!({ "structured_output": { "herramientas": ["mcp__otro__x", "mcp__gruv-tomy__listar_tickets", "mcp__gruv-tomy__mal;rm"] } }))).unwrap();
    assert_eq!(
        sv,
        vec![
            ServidorMcp { nombre: "gruv-tomy".into(), prefijo: "mcp__gruv-tomy__".into(), estado: Pendiente, herramientas: Some(strs(&["listar_tickets"])) },
            ServidorMcp { nombre: "claude.ai Atlassian MCP".into(), prefijo: ATL.into(), estado: Conectado, herramientas: Some(strs(&["getJiraIssue", "searchJiraIssuesUsingJql"])) },
            ServidorMcp { nombre: "claude.ai Notion".into(), prefijo: "mcp__claude_ai_Notion__".into(), estado: NecesitaAuth, herramientas: None },
            ServidorMcp { nombre: "raro".into(), prefijo: "mcp__raro__".into(), estado: Otro, herramientas: None },
        ]
    );
    let sin = servidores_de_salida(&salida_cosmos(json!({}))).unwrap();
    assert_eq!(sin.iter().find(|s| s.nombre == "gruv-tomy").unwrap().herramientas, None);
}

#[test]
fn servidores_de_salida_sin_init_no_hay_nada_y_dos_con_el_mismo_prefijo_se_descartan() {
    assert_eq!(servidores_de_salida("no es json"), None);
    assert_eq!(servidores_de_salida(&json!([{ "type": "result" }]).to_string()), None);
    let sv = servidores_de_salida(
        &json!([{
            "type": "system", "subtype": "init",
            "mcp_servers": [
                { "name": "a.b", "status": "connected" }, { "name": "a:b", "status": "connected" },
                { "name": "gruv", "status": "connected" }, { "name": "gruv__x", "status": "connected" },
                { "name": "con\nsalto", "status": "connected" }, { "name": 7, "status": "connected" }
            ],
            "tools": ["mcp__a_b__t", "mcp__gruv__listar_tickets", "mcp__gruv__x__otra"]
        }])
        .to_string(),
    )
    .unwrap();
    assert_eq!(
        sv,
        vec![
            ServidorMcp { nombre: "gruv".into(), prefijo: "mcp__gruv__".into(), estado: Conectado, herramientas: Some(strs(&["listar_tickets"])) },
            ServidorMcp { nombre: "gruv__x".into(), prefijo: "mcp__gruv__x__".into(), estado: Conectado, herramientas: Some(strs(&["otra"])) },
        ]
    );
}

#[test]
fn revisar_cuenta_falla_si_no_entendio_la_salida() {
    assert!(revisar_cuenta("[]", 5.0).unwrap_err().mensaje().contains("No entendí la respuesta de Claude"));
    let r = revisar_cuenta(&salida_cosmos(json!({})), 5.0).unwrap();
    assert_eq!(r.revisada_en, Num(5.0));
    assert_eq!(r.servidores.len(), 4);
}

#[test]
fn el_prompt_y_el_schema_de_revisar_son_fijos() {
    assert!(build_revisar_prompt().starts_with("No llames a ninguna herramienta."));
    assert_eq!(revisar_schema()["required"], json!(["herramientas"]));
}

#[test]
fn candidatos_exacto_por_palabras_y_nada_cuando_no_esta() {
    let gruv = mcp("gruv");
    let jira = mcp("jira");
    let a = vec![srv("claude.ai Atlassian MCP", Conectado, None), srv("gruv-tomy", Pendiente, None)];
    assert_eq!(nombres(&candidatos(gruv, &a)), strs(&["gruv-tomy"]));
    let personales = vec![srv("atlassian", Conectado, Some(jira.herramientas.lista.clone())), srv("plugin:design:atlassian", Conectado, None), srv("claude.ai Notion", NecesitaAuth, None)];
    assert_eq!(nombres(&candidatos(jira, &personales)), strs(&["atlassian", "plugin:design:atlassian"]));
    let mut con_exacto = personales.clone();
    con_exacto.push(srv("claude.ai Atlassian MCP", Conectado, None));
    assert_eq!(nombres(&candidatos(jira, &con_exacto)), strs(&["claude.ai Atlassian MCP", "atlassian", "plugin:design:atlassian"]));
    assert!(candidatos(gruv, &[srv("claude.ai Atlassian MCP", Conectado, None), srv("context7", Pendiente, None)]).is_empty());
}

#[test]
fn candidatos_uno_con_herramientas_conocidas_que_no_tiene_las_de_la_lista_se_descarta() {
    let gruv = mcp("gruv");
    assert!(candidatos(gruv, &[srv("gruv-tomy", Conectado, Some(strs(&["ver_mi_inicio"])))]).is_empty());
    assert_eq!(candidatos(gruv, &[srv("gruv-tomy", Conectado, Some(tools_de(gruv)))]).len(), 1);
}

#[test]
fn disponibilidad_en_sus_cuatro_tipos() {
    let gruv = mcp("gruv");
    let jira = mcp("jira");
    assert_eq!(disponibilidad(gruv, None, None), Disponibilidad::SinRevisar);
    assert_eq!(disponibilidad(gruv, Some(&cuenta(vec![srv("context7", Conectado, None)])), None), Disponibilidad::Falta { parecido: None });
    assert_eq!(disponibilidad(gruv, Some(&cuenta(vec![srv("gruv-tomy", Pendiente, None)])), None), tiene_d("gruv-tomy", "mcp__gruv-tomy__", Pendiente, true, false));
    assert_eq!(
        disponibilidad(gruv, Some(&cuenta(vec![srv("claude.ai Gruv", Conectado, Some(tools_de(gruv)))])), None),
        tiene_d("claude.ai Gruv", "mcp__claude_ai_Gruv__", Conectado, false, true)
    );
    let dos = cuenta(vec![srv("atlassian", Conectado, None), srv("plugin:design:atlassian", Conectado, None)]);
    assert_eq!(
        disponibilidad(jira, Some(&dos), None),
        Disponibilidad::Elegir { opciones: vec![opcion("atlassian", "mcp__atlassian__", Conectado), opcion("plugin:design:atlassian", "mcp__plugin_design_atlassian__", Conectado)] }
    );
}

#[test]
fn disponibilidad_el_elegido_manda_uno_invalido_se_ignora_y_el_unico_verificado_gana() {
    let jira = mcp("jira");
    let dos = cuenta(vec![srv("atlassian", Conectado, None), srv("plugin:design:atlassian", Conectado, None)]);
    let elegido = disponibilidad(jira, Some(&dos), Some("mcp__plugin_design_atlassian__"));
    assert_eq!(prefijo_de(&elegido), Some("mcp__plugin_design_atlassian__"));
    assert!(matches!(disponibilidad(jira, Some(&dos), Some("mcp__claude_ai_Gruv__")), Disponibilidad::Elegir { .. }));
    let uno = cuenta(vec![srv("atlassian", Conectado, Some(jira.herramientas.lista.clone())), srv("plugin:design:atlassian", Pendiente, None)]);
    assert!(matches!(disponibilidad(jira, Some(&uno), None), Disponibilidad::Tiene { nombre, .. } if nombre == "atlassian"));
}

#[test]
fn disponibilidad_con_el_de_claude_ai_sin_autorizar_y_gruv_tomy_andando_se_adapta() {
    let gruv = mcp("gruv");
    let t = tools_de(gruv);
    let d = disponibilidad(gruv, Some(&cuenta(vec![srv("claude.ai Gruv", NecesitaAuth, None), srv("gruv-tomy", Conectado, Some(t.clone()))])), None);
    assert_eq!(d, tiene_d("gruv-tomy", "mcp__gruv-tomy__", Conectado, true, true));
    let exacto = disponibilidad(gruv, Some(&cuenta(vec![srv("claude.ai Gruv", Conectado, Some(t.clone())), srv("gruv-tomy", Conectado, Some(t))])), None);
    assert_eq!(prefijo_de(&exacto), Some("mcp__claude_ai_Gruv__"));
    let solo = disponibilidad(gruv, Some(&cuenta(vec![srv("claude.ai Gruv", NecesitaAuth, None), srv("gruv-tomy", Pendiente, None)])), None);
    assert_eq!(estado_de(&solo), Some(NecesitaAuth));
}

#[test]
fn disponibilidad_un_servidor_de_otro_nombre_con_todas_las_herramientas_se_ofrece_no_se_adapta_solo() {
    let gruv = mcp("gruv");
    let t = tools_de(gruv);
    let c = cuenta(vec![srv("mis-tickets", Conectado, Some(t.clone()))]);
    assert_eq!(nombres(&por_herramientas(gruv, &c.servidores)), strs(&["mis-tickets"]));
    assert_eq!(disponibilidad(gruv, Some(&c), None), Disponibilidad::Elegir { opciones: vec![opcion("mis-tickets", "mcp__mis-tickets__", Conectado)] });
    assert_eq!(prefijo_de(&disponibilidad(gruv, Some(&c), Some("mcp__mis-tickets__"))), Some("mcp__mis-tickets__"));
    let m = mensaje_cuenta(gruv, &disponibilidad(gruv, Some(&c), None), "Cosmos", &[]).unwrap();
    assert!(m.starts_with("«mis-tickets» de la cuenta «Cosmos» tiene las herramientas de Gruv con otro nombre."), "{m}");
    assert!(por_herramientas(gruv, &[srv("mis-tickets", Pendiente, None)]).is_empty());
    assert!(por_herramientas(gruv, &[srv("gruv-tomy", Conectado, Some(t))]).is_empty());
}

#[test]
fn por_herramientas_con_una_lista_de_una_sola_herramienta_no_alcanza() {
    let gruv = mcp("gruv");
    let mut uno = gruv.clone();
    uno.herramientas.lista = strs(&["listar_tickets"]);
    let s = vec![srv("mis-tickets", Conectado, Some(tools_de(gruv)))];
    assert!(por_herramientas(&uno, &s).is_empty());
    assert_eq!(disponibilidad(&uno, Some(&cuenta(s)), None), Disponibilidad::Falta { parecido: None });
}

#[test]
fn disponibilidad_al_parecido_le_faltan_herramientas_y_el_mensaje_las_nombra() {
    let gruv = mcp("gruv");
    let sin: Vec<String> = tools_de(gruv).into_iter().filter(|t| t != "ver_mi_inicio").collect();
    let d = disponibilidad(gruv, Some(&cuenta(vec![srv("gruv-tomy", Conectado, Some(sin)), srv("gruv-viejo", Conectado, Some(strs(&["ver_reloj"])))])), None);
    assert_eq!(d, Disponibilidad::Falta { parecido: Some(("gruv-tomy".into(), strs(&["ver_mi_inicio"]))) });
    assert_eq!(
        mensaje_cuenta(gruv, &d, "Cosmos", &strs(&["Personal"])).unwrap(),
        "La cuenta «Cosmos» tiene «gruv-tomy», pero le faltan herramientas que usa Gruv: ver_mi_inicio. Copiá Gruv como conector propio y ajustá sus herramientas, o agregalas al servidor. Lo tiene: «Personal»."
    );
}

#[test]
fn revisar_temprano_solo_con_un_init_sin_servidores_pending() {
    let init = |servers: Value| json!({ "type": "system", "subtype": "init", "mcp_servers": servers, "tools": ["mcp__gruv-tomy__listar_tickets"] }).to_string();
    assert_eq!(
        revisar_temprano(&init(json!([{ "name": "gruv-tomy", "status": "connected" }])), 7.0),
        Some(CuentaRevisada { revisada_en: Num(7.0), servidores: vec![ServidorMcp { nombre: "gruv-tomy".into(), prefijo: "mcp__gruv-tomy__".into(), estado: Conectado, herramientas: Some(strs(&["listar_tickets"])) }], error: None })
    );
    assert_eq!(revisar_temprano(&init(json!([{ "name": "gruv-tomy", "status": "connected" }, { "name": "otro", "status": "pending" }])), 7.0), None);
    assert_eq!(revisar_temprano("no es json", 7.0), None);
    assert_eq!(revisar_temprano(&json!({ "type": "assistant" }).to_string(), 7.0), None);
}

#[test]
fn revisar_cuenta_entiende_la_salida_de_stream_json_una_linea_por_mensaje() {
    let msgs: Vec<Value> = serde_json::from_str(&salida_cosmos(json!({}))).unwrap();
    let lineas = msgs.iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\nbasura\n";
    assert_eq!(revisar_cuenta(&lineas, 5.0).unwrap(), revisar_cuenta(&salida_cosmos(json!({})), 5.0).unwrap());
}

#[test]
fn usable_solo_lo_que_esta_y_no_pide_autorizacion_ni_fallo() {
    assert!(!usable(&Disponibilidad::Falta { parecido: None }));
    assert!(!usable(&Disponibilidad::SinRevisar));
    for (e, ok) in [(Pendiente, true), (NecesitaAuth, false), (Fallo, false)] {
        assert_eq!(usable(&tiene_d("x", "mcp__x__", e, true, false)), ok);
    }
}

#[test]
fn con_prefijo_cambia_solo_el_prefijo_y_no_toca_el_original() {
    let gruv = mcp("gruv");
    let d = con_prefijo(gruv, "mcp__gruv-tomy__").unwrap();
    assert_eq!(d.herramientas.prefijo, "mcp__gruv-tomy__");
    assert_eq!(gruv.herramientas.prefijo, "mcp__claude_ai_Gruv__");
    let mut vuelta = d.clone();
    vuelta.herramientas.prefijo = gruv.herramientas.prefijo.clone();
    assert_eq!(&vuelta, gruv);
    assert!(con_prefijo(gruv, "mcp__x__ y más").unwrap_err().mensaje().contains("prefijo"));
}

#[test]
fn mensaje_cuenta_dice_que_hacer() {
    let gruv = mcp("gruv");
    let jira = mcp("jira");
    let falta = Disponibilidad::Falta { parecido: None };
    assert_eq!(mensaje_cuenta(jira, &falta, "Personal", &[]).unwrap(), "Conectá Jira en claude.ai con la cuenta «Personal» (claude.ai → Configuración → Conectores) y tocá «Volver a revisar».");
    let mut propio = gruv.clone();
    propio.herramientas.prefijo = "mcp__gruv-tomy__".into();
    assert_eq!(
        mensaje_cuenta(&propio, &falta, "Personal", &strs(&["Cosmos", "Otra"])).unwrap(),
        "La cuenta «Personal» no tiene el servidor MCP de Gruv. Agregalo en esa cuenta con alcance usuario (claude mcp add --scope user) y tocá «Volver a revisar»: uno de alcance local o de proyecto solo anda dentro de su carpeta y Sloth consulta desde otra. Lo tiene: «Cosmos», «Otra»."
    );
    let t = |nombre: &str, prefijo: &str, estado, verificado| tiene_d(nombre, prefijo, estado, false, verificado);
    assert_eq!(
        mensaje_cuenta(gruv, &t("claude.ai Gruv", "mcp__claude_ai_Gruv__", NecesitaAuth, true), "Cosmos", &[]).unwrap(),
        "Gruv necesita que lo vuelvas a autorizar en claude.ai con la cuenta «Cosmos»."
    );
    assert_eq!(
        mensaje_cuenta(gruv, &t("gruv-tomy", "mcp__gruv-tomy__", NecesitaAuth, true), "Cosmos", &[]).unwrap(),
        "El servidor «gruv-tomy» pide iniciar sesión. Abrí una terminal con la cuenta «Cosmos», corré /mcp, elegí «gruv-tomy», autenticalo y volvé a actualizar."
    );
    let f = mensaje_cuenta(gruv, &t("gruv-tomy", "mcp__gruv-tomy__", Fallo, true), "Cosmos", &[]).unwrap();
    assert!(f.contains("No se pudo conectar a «gruv-tomy»") && f.contains("no arrancó") && f.contains("Probar"), "{f}");
    let p = mensaje_cuenta(gruv, &t("gruv-tomy", "mcp__gruv-tomy__", Pendiente, false), "Cosmos", &[]).unwrap();
    assert!(p.contains("no respondió a tiempo") && p.contains("/mcp"), "{p}");
    let c = mensaje_cuenta(gruv, &t("gruv-tomy", "mcp__gruv-tomy__", Conectado, false), "Cosmos", &[]).unwrap();
    assert!(c.contains("figura conectado") && c.contains("todavía no se revisaron sus herramientas") && c.contains("Volver a revisar"), "{c}");
    assert!(!c.contains("no respondió") && !c.contains("autenticar") && !c.contains("/mcp"), "{c}");
    assert!(mensaje_cuenta(jira, &Disponibilidad::Elegir { opciones: vec![] }, "Personal", &[]).unwrap().contains("más de un servidor que puede ser Jira"));
    assert_eq!(mensaje_cuenta(gruv, &t("claude.ai Gruv", "mcp__claude_ai_Gruv__", Conectado, true), "Cosmos", &[]), None);
}

#[test]
fn problema_en_sesion_sin_el_servidor_o_sin_sus_herramientas_la_lista_vacia_no_es_no_hay_tickets() {
    let gruv = mcp("gruv");
    let cosmos = servidores_de_salida(&salida_cosmos(json!({})));
    assert_eq!(problema_en_sesion(gruv, "mcp__claude_ai_Gruv__", cosmos.as_deref()), Some(Disponibilidad::Falta { parecido: None }));
    let p = problema_en_sesion(gruv, "mcp__gruv-tomy__", cosmos.as_deref());
    assert_eq!(p.as_ref().and_then(estado_de), Some(Pendiente));
    assert_eq!(problema_en_sesion(gruv, "mcp__claude_ai_Gruv__", Some(&[srv("claude.ai Gruv", Conectado, Some(tools_de(gruv)))])), None);
    assert_eq!(
        problema_en_sesion(gruv, "mcp__claude_ai_Gruv__", Some(&[srv("claude.ai Gruv", Conectado, Some(strs(&["ver_reloj"])))])),
        Some(Disponibilidad::Falta { parecido: Some(("claude.ai Gruv".into(), strs(&["buscar_persona", "listar_tickets", "ver_flujo_tickets", "ver_mi_inicio", "ver_mi_perfil"]))) })
    );
    assert_eq!(problema_en_sesion(gruv, "mcp__claude_ai_Gruv__", None), None);
}

#[test]
fn sanear_cache_descarta_lo_invalido() {
    assert!(sanear_cache(&json!("x")).is_none());
    assert!(sanear_cache(&json!({ "version": 2, "cuentas": {} })).is_none());
    let r = sanear_cache(&json!({
        "version": 1,
        "cuentas": {
            "ok": {
                "revisadaEn": 3, "error": "falló",
                "servidores": [
                    { "nombre": "gruv-tomy", "prefijo": "mcp__gruv-tomy__", "estado": "pending" },
                    { "nombre": "x", "prefijo": "mcp__x y__", "estado": "connected" },
                    { "nombre": "y", "prefijo": "mcp__y__", "estado": "raro" },
                    { "nombre": "z".repeat(129), "prefijo": "mcp__z__", "estado": "connected" },
                    { "nombre": "w", "prefijo": "mcp__w__", "estado": "connected", "herramientas": ["bien", "mal;rm", 7] }
                ]
            },
            "sinFecha": { "servidores": [] },
            "basura": "no"
        }
    }))
    .unwrap();
    assert_eq!(
        serde_json::to_value(&r).unwrap(),
        json!({ "ok": { "revisadaEn": 3, "servidores": [
            { "nombre": "gruv-tomy", "prefijo": "mcp__gruv-tomy__", "estado": "pending" },
            { "nombre": "w", "prefijo": "mcp__w__", "estado": "connected", "herramientas": ["bien"] }
        ], "error": "falló" } })
    );
}

#[test]
fn con_la_cuenta_de_cosmos_la_lista_pide_solo_las_herramientas_del_preset_con_el_prefijo_de_gruv_tomy() {
    let gruv = mcp("gruv");
    let d = disponibilidad(gruv, Some(&revisar_cuenta(&salida_cosmos(json!({})), 1.0).unwrap()), None);
    let Disponibilidad::Tiene { adaptado: true, prefijo, .. } = d else { panic!("{d:?}") };
    let a = build_lista_args(&con_prefijo(gruv, &prefijo).unwrap(), "haiku", &[], Limites::default());
    let valor = |f: &str| a[a.iter().position(|x| x == f).unwrap() + 1].clone();
    let permitidas: Vec<String> = valor("--allowedTools").split(',').map(str::to_string).collect();
    assert_eq!(permitidas, gruv.herramientas.lista.iter().map(|t| format!("mcp__gruv-tomy__{t}")).collect::<Vec<_>>());
    assert!(valor("--disallowedTools").split(',').all(|t| t.starts_with("mcp__gruv-tomy__")));
    assert!(!a.join(" ").contains("mcp__claude_ai_Gruv__"));
}

#[test]
fn revisar_usa_los_args_de_descubrir_con_su_propio_schema() {
    let a = build_descubrir_args(&revisar_schema(), Formato::Json);
    assert_eq!(a[a.iter().position(|x| x == "--json-schema").unwrap() + 1], revisar_schema().to_string());
    assert_eq!(a[a.iter().position(|x| x == "--allowedTools").unwrap() + 1], "");
}

#[test]
fn elegibles_lo_que_se_ofrece_para_elegir_se_puede_guardar() {
    let gruv = mcp("gruv");
    let t = tools_de(gruv);
    let c = cuenta(vec![srv("mis-tickets", Conectado, Some(t.clone())), srv("gruv-tomy", Pendiente, None), srv("context7", Conectado, None)]);
    let d = disponibilidad(gruv, Some(&cuenta(vec![srv("mis-tickets", Conectado, Some(t))])), None);
    let Disponibilidad::Elegir { opciones } = d else { panic!("{d:?}") };
    for o in &opciones {
        assert!(elegibles(gruv, &c.servidores).iter().any(|s| s.prefijo == o.prefijo));
    }
    assert_eq!(nombres(&elegibles(gruv, &c.servidores)), strs(&["gruv-tomy", "mis-tickets"]));
}

#[test]
fn disponibilidad_con_el_exacto_caido_y_un_servidor_de_otro_nombre_andando_se_ofrece_elegir() {
    let gruv = mcp("gruv");
    let t = tools_de(gruv);
    let c = cuenta(vec![srv("claude.ai Gruv", NecesitaAuth, None), srv("mis-tickets", Conectado, Some(t.clone()))]);
    assert_eq!(
        disponibilidad(gruv, Some(&c), None),
        Disponibilidad::Elegir { opciones: vec![opcion("claude.ai Gruv", "mcp__claude_ai_Gruv__", NecesitaAuth), opcion("mis-tickets", "mcp__mis-tickets__", Conectado)] }
    );
    assert_eq!(estado_de(&disponibilidad(gruv, Some(&c), Some("mcp__claude_ai_Gruv__"))), Some(NecesitaAuth));
    let caido = disponibilidad(gruv, Some(&cuenta(vec![srv("claude.ai Gruv", NecesitaAuth, None), srv("mis-tickets", Fallo, Some(t))])), None);
    assert_eq!(prefijo_de(&caido), Some("mcp__claude_ai_Gruv__"));
}

#[test]
fn disponibilidad_con_el_exacto_caido_y_dos_del_mismo_nombre_andando_se_elige_entre_los_tres() {
    let gruv = mcp("gruv");
    let t = tools_de(gruv);
    let c = cuenta(vec![srv("claude.ai Gruv", Fallo, None), srv("gruv-a", Conectado, Some(t.clone())), srv("gruv-b", Conectado, Some(t))]);
    let Disponibilidad::Elegir { opciones } = disponibilidad(gruv, Some(&c), None) else { panic!() };
    assert_eq!(opciones.iter().map(|o| o.nombre.as_str()).collect::<Vec<_>>(), vec!["claude.ai Gruv", "gruv-a", "gruv-b"]);
}

#[test]
fn disponibilidad_un_parecido_sin_ninguna_herramienta_en_comun_no_cuenta() {
    let gruv = mcp("gruv");
    let c = cuenta(vec![srv("gruv-viejo", Conectado, Some(strs(&["ver_reloj"]))), srv("plugin:gruv", Conectado, Some(vec![]))]);
    assert_eq!(disponibilidad(gruv, Some(&c), None), Disponibilidad::Falta { parecido: None });
}

#[test]
fn servidor_de_la_lista_solo_con_el_mismo_servidor_con_que_se_leyo_la_lista() {
    let gruv = mcp("gruv");
    let adaptado = con_prefijo(gruv, "mcp__mis-tickets__").unwrap();
    assert_eq!(servidor_de_la_lista(Some("mcp__mis-tickets__"), &adaptado).unwrap(), &adaptado);
    let e = servidor_de_la_lista(Some(&gruv.herramientas.prefijo), &adaptado).unwrap_err().mensaje();
    assert!(e.contains("cambió desde que se leyó la lista. Actualizá Gruv"), "{e}");
    assert!(servidor_de_la_lista(None, gruv).unwrap_err().mensaje().contains("Actualizá Gruv"));
}

#[test]
fn mensaje_cuenta_el_pending_de_claude_ai_no_habla_de_servidores_propios() {
    let gruv = mcp("gruv");
    let ai = mensaje_cuenta(gruv, &tiene_d("claude.ai Gruv", "mcp__claude_ai_Gruv__", Pendiente, false, false), "Cosmos", &[]).unwrap();
    assert!(!ai.contains("/mcp") && !ai.contains("tarda en arrancar"), "{ai}");
    let propio = mensaje_cuenta(gruv, &tiene_d("mis-tickets", "mcp__mis-tickets__", Pendiente, false, false), "Cosmos", &[]).unwrap();
    assert!(propio.contains("tarda en arrancar"), "{propio}");
}

#[test]
fn un_servidor_pendiente_lleva_lo_que_gasto_el_intento_para_descontarlo_del_tope_de_costo() {
    let e = servidor_pendiente("pendiente", Some(0.04));
    assert_eq!(e, ErrorTickets::ServidorPendiente { mensaje: "pendiente".into(), costo_usd: Some(0.04) });
    assert_eq!(servidor_pendiente("pendiente", None), ErrorTickets::ServidorPendiente { mensaje: "pendiente".into(), costo_usd: None });
}

#[test]
fn bloquea_consulta_falta_elegir_sin_sesion_o_caido_cortan_conectado_y_pending_se_prueban() {
    assert!(bloquea_consulta(&Disponibilidad::Falta { parecido: None }));
    assert!(bloquea_consulta(&Disponibilidad::Elegir { opciones: vec![] }));
    assert!(bloquea_consulta(&tiene_estado(NecesitaAuth)));
    assert!(bloquea_consulta(&tiene_estado(Fallo)));
    assert!(!bloquea_consulta(&tiene_estado(Conectado)));
    assert!(!bloquea_consulta(&tiene_estado(Pendiente)));
    assert!(!bloquea_consulta(&Disponibilidad::SinRevisar));
}

#[test]
fn conviene_revisar_un_necesita_sesion_viejo_se_vuelve_a_mirar_antes_de_cortar() {
    let ahora = 1_000_000.0;
    assert!(conviene_revisar(&tiene_estado(NecesitaAuth), Some(ahora - REVISION_VIGENTE_MS - 1.0), ahora));
    assert!(conviene_revisar(&tiene_estado(Fallo), Some(ahora - REVISION_VIGENTE_MS), ahora));
    assert!(conviene_revisar(&Disponibilidad::Falta { parecido: None }, None, ahora));
}

#[test]
fn conviene_revisar_una_revision_reciente_se_cree_y_lo_que_anda_o_pide_elegir_no_se_revisa() {
    let ahora = 1_000_000.0;
    assert!(!conviene_revisar(&tiene_estado(NecesitaAuth), Some(ahora - 5_000.0), ahora));
    assert!(!conviene_revisar(&tiene_estado(Conectado), Some(ahora - 10.0 * REVISION_VIGENTE_MS), ahora));
    assert!(!conviene_revisar(&tiene_estado(Pendiente), None, ahora));
    assert!(!conviene_revisar(&Disponibilidad::Elegir { opciones: vec![] }, None, ahora));
}
