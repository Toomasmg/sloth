//! Pruebas de motor.rs: los casos del `golden_motor.json` (generado corriendo el motor de TypeScript sobre cada conector
//! incluido y sobre salidas del agente) y los tests de motor.test.ts.
use super::alcance::AlcanceLista;
use super::conector::{validar_conector, ConectorDef, ConectorMcp};
use super::conectores::{conector_por_id, crudo, CONECTORES};
use super::errores::ErrorTickets;
use super::modelo::{Accion, Ordenado, ACCIONES};
use super::motor::*;
use super::texto::num_valor;
use serde_json::{json, Value};

fn golden() -> Value {
    serde_json::from_str(include_str!("fixtures/golden_motor.json")).unwrap()
}

fn gruv() -> &'static ConectorMcp {
    conector_por_id("gruv").unwrap().mcp().unwrap()
}

fn gruv_def() -> &'static ConectorDef {
    conector_por_id("gruv").unwrap()
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect()
}

fn accion(s: &str) -> Accion {
    Accion::de_str(s).unwrap()
}

fn entrada(a: Accion, ticket: &str) -> AccionInput {
    let mut i = AccionInput::nuevo(ticket);
    match a {
        Accion::Estado => i.estado = Some("en_qa".into()),
        Accion::Tomar => i.persona = Some(Some("u-1".into())),
        Accion::Soltar => i.persona = Some(None),
        Accion::Comentar => i.cuerpo = Some("Hola \"mundo\"\n{estado}".into()),
        Accion::Criterio => {
            i.criterio_id = Some("0f8c12ab-0000-4000-8000-000000000001".into());
            i.hecho = Some(true);
        }
        Accion::Horas => {
            i.minutos = Some(30);
            i.motivo = Some("Horas cargadas desde Sloth".into());
        }
    }
    i
}

#[test]
fn cada_conector_mcp_arma_los_mismos_prompts_y_argumentos_que_en_typescript() {
    let g = golden();
    let mut vistos = 0;
    for def in CONECTORES.iter() {
        let Some(m) = def.mcp() else { continue };
        let c = &g["conectores"][def.id()];
        let id = def.id();
        assert_eq!(build_prompt(m, "", None), c["prompt"].as_str().unwrap(), "{id} prompt");
        assert_eq!(build_prompt(m, "abc-123", None), c["promptId"].as_str().unwrap(), "{id} promptId");
        let alcance = AlcanceLista { personas: vec!["11111111-1111-1111-1111-111111111111".into()], sin_asignar: true, hechos: true, desde: "2026-11-14".into() };
        if m.pistas.lista_por.is_some() {
            assert_eq!(build_prompt(m, "", Some(&alcance)), c["promptAlcance"].as_str().unwrap(), "{id} alcance");
            let sin = AlcanceLista { hechos: false, sin_asignar: false, ..alcance.clone() };
            assert_eq!(build_prompt(m, "u-9", Some(&sin)), c["promptAlcanceSinHechos"].as_str().unwrap(), "{id} alcance sin hechos");
        }
        let ajenos = vec!["mcp__ajeno".to_string(), "mcp__otro".to_string()];
        let limites = Limites { max_turns: Some(7.0), max_cost_usd: Some(2.5) };
        assert_eq!(build_lista_args(m, "haiku", &ajenos, limites), strs(&c["listaArgs"]), "{id} listaArgs");
        let ej = &m.base.ejemplo.id;
        assert_eq!(build_detalle_prompt(m, ej), c["detallePrompt"].as_str().unwrap(), "{id} detalle");
        assert_eq!(build_detalle_args(m, "sonnet", &[], Limites::default()), strs(&c["detalleArgs"]), "{id} detalleArgs");
        let p = permisos_por_consulta(m);
        assert_eq!(p.lista, strs(&c["permisos"]["lista"]), "{id} permisos.lista");
        assert_eq!(p.detalle, strs(&c["permisos"]["detalle"]), "{id} permisos.detalle");
        let claves_acc: Vec<String> = p.acciones.claves().cloned().collect();
        assert_eq!(claves_acc, c["permisos"]["acciones"].as_object().unwrap().keys().cloned().collect::<Vec<_>>(), "{id} acciones");
        for (a, xs) in p.acciones.iter() {
            assert_eq!(*xs, strs(&c["permisos"]["acciones"][a.as_str()]), "{id} permisos {a}");
        }
        assert_eq!(negadas(m), strs(&c["negadas"]), "{id} negadas");
        for (a, esperado) in c["acciones"].as_object().unwrap() {
            let a = accion(a);
            assert_eq!(build_accion_prompt(m, a, &entrada(a, ej)).unwrap(), esperado["prompt"].as_str().unwrap(), "{id} {a:?} prompt");
            assert_eq!(build_accion_args(m, "opus", a, &["mcp__x".to_string()], Limites::default()).unwrap(), strs(&esperado["args"]), "{id} {a:?} args");
        }
        assert_eq!(c["acciones"].as_object().unwrap().len(), acciones_soportadas(def).len());
        if filtra_personas(def) {
            assert_eq!(build_personas_prompt(m), c["personasPrompt"].as_str().unwrap(), "{id} personas");
            assert_eq!(build_personas_args(m, "haiku", &[], Limites::default()), strs(&c["personasArgs"]), "{id} personasArgs");
        }
        vistos += 1;
    }
    assert_eq!(vistos, 11);
}

fn resultado(r: &Result<Value, ErrorTickets>) -> Value {
    match r {
        Ok(v) => json!({ "ok": v }),
        Err(e) => {
            let clase = match e {
                ErrorTickets::ConectorFalta(_) => "ConectorFaltaError",
                ErrorTickets::HerramientaFalta(_) => "HerramientaFaltaError",
                _ => "Error",
            };
            json!({ "error": e.to_string(), "clase": clase })
        }
    }
}

fn lista_a_valor(r: ResultadoLista) -> Value {
    let mut o = serde_json::Map::new();
    o.insert("tickets".into(), serde_json::to_value(&r.tickets).unwrap());
    if let Some(e) = &r.estados {
        o.insert("estados".into(), serde_json::to_value(e).unwrap());
    }
    if let Some(m) = &r.me {
        o.insert("me".into(), serde_json::to_value(m).unwrap());
    }
    if let Some(n) = r.no_leidos {
        o.insert("noLeidos".into(), json!(n));
    }
    for (k, v) in [("costUsd", r.cost_usd), ("tokens", r.tokens), ("durationMs", r.duration_ms), ("numTurns", r.num_turns)] {
        if let Some(v) = v {
            o.insert(k.into(), num_valor(v));
        }
    }
    Value::Object(o)
}

#[test]
fn la_lista_se_lee_igual_que_en_typescript() {
    for (i, c) in golden()["lista"].as_array().unwrap().iter().enumerate() {
        let r = parse_claude_output(gruv_def(), c["stdout"].as_str().unwrap(), c["porAlcance"].as_bool().unwrap()).map(lista_a_valor);
        assert_eq!(resultado(&r), c["res"], "caso {i}: {}", c["stdout"]);
    }
}

#[test]
fn los_tickets_de_gh_se_normalizan_igual() {
    let g = golden();
    let gh = conector_por_id("github").unwrap();
    let r = normalize_tickets(gh, &json!([{ "number": 1, "id": "12", "titulo": "x", "estado": "cerrado" }, { "id": "13", "title": "y" }]), None).map(|t| serde_json::to_value(t).unwrap());
    assert_eq!(resultado(&r), g["listaGh"][0]);
}

#[test]
fn el_detalle_se_lee_igual_que_en_typescript() {
    for (i, c) in golden()["detalle"].as_array().unwrap().iter().enumerate() {
        let r = parse_detalle(gruv(), c["stdout"].as_str().unwrap()).map(|d| serde_json::to_value(d).unwrap());
        assert_eq!(resultado(&r), c["res"], "caso {i}");
    }
}

#[test]
fn la_respuesta_de_una_accion_se_lee_igual_que_en_typescript() {
    for (i, c) in golden()["accion"].as_array().unwrap().iter().enumerate() {
        let r = parse_accion(gruv(), c["stdout"].as_str().unwrap(), accion(c["accion"].as_str().unwrap())).map(|m| m.map_or(json!({}), |n| json!({ "minutosTotal": n })));
        assert_eq!(resultado(&r), c["res"], "caso {i}");
    }
}

#[test]
fn las_personas_se_leen_igual_que_en_typescript() {
    for (i, c) in golden()["personas"].as_array().unwrap().iter().enumerate() {
        let r = parse_personas(gruv(), c["stdout"].as_str().unwrap()).map(|p| serde_json::to_value(p).unwrap());
        assert_eq!(resultado(&r), c["res"], "caso {i}");
    }
}

#[test]
fn ids_estados_descripciones_y_json_suelto_se_normalizan_igual() {
    let g = golden();
    let gh = conector_por_id("github").unwrap();
    for c in g["ids"].as_array().unwrap() {
        assert_eq!(id_valido(gruv_def(), &c["v"]).map_or(Value::Null, Value::String), c["res"], "gruv {}", c["v"]);
        assert_eq!(id_valido(gh, &c["v"]).map_or(Value::Null, Value::String), c["gh"], "gh {}", c["v"]);
    }
    for c in g["normEstado"].as_array().unwrap() {
        assert_eq!(norm_estado(&c["v"]).map_or(Value::Null, Value::String), c["res"], "{}", c["v"]);
    }
    for c in g["normDescripcion"].as_array().unwrap() {
        assert_eq!(norm_descripcion(&c["v"]).map_or(Value::Null, Value::String), c["res"], "{}", c["v"]);
    }
    for c in g["extractJson"].as_array().unwrap() {
        let r = extract_json(c["v"].as_str().unwrap());
        assert_eq!(resultado(&r), c["res"], "{}", c["v"]);
    }
}

fn variante(cambiar: impl FnOnce(&mut Value)) -> ConectorDef {
    let mut d = crudo("gruv");
    cambiar(&mut d);
    validar_conector(&d).unwrap()
}

fn mcp(d: &ConectorDef) -> &ConectorMcp {
    d.mcp().unwrap()
}

#[test]
fn estados_de_gruv_los_por_defecto_y_cerrado_oculto() {
    let por_defecto: Vec<(String, String)> = estados_por_defecto(gruv_def()).into_iter().map(|e| (e.clave, e.nombre)).collect();
    let esperado: Vec<(String, String)> = [("abierto", "Abierto"), ("en_curso", "En curso"), ("bloqueado", "Bloqueado"), ("en_revision", "En revisión"), ("pre_rtd", "Pre RTD"), ("en_qa", "En QA"), ("rechazado", "Rechazado")]
        .iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();
    assert_eq!(por_defecto, esperado);
    assert_eq!(claves_ocultas(gruv_def()), vec!["cerrado"]);
    let cat = con_categoria(
        gruv_def(),
        &[super::modelo::EstadoBase { clave: "en_qa".into(), nombre: "QA".into() }, super::modelo::EstadoBase { clave: "nuevo".into(), nombre: "Nuevo".into() }],
    );
    assert_eq!(serde_json::to_value(cat).unwrap(), json!([{ "clave": "en_qa", "nombre": "QA", "categoria": "revision" }, { "clave": "nuevo", "nombre": "Nuevo", "categoria": "pendiente" }]));
}

#[test]
fn id_valido_exige_caracteres_seguros_aunque_la_regex_del_conector_acepte_cualquier_cosa() {
    let laxa = |id: &str| {
        let mut d = crudo("gruv");
        d["id"] = json!("laxo");
        d["idRegex"] = json!("^.+$");
        d["idMayusculas"] = json!(false);
        d["ejemplo"]["id"] = json!(id);
        d
    };
    let laxo = validar_conector(&laxa("x-1")).unwrap();
    for ok in ["x-1", "A_b.9", "#12", "PROJ.sub-3"] {
        assert_eq!(id_valido(&laxo, &json!(ok)).as_deref(), Some(ok));
    }
    for malo in ["a b", "a;rm", "a\"b", "a'b", "a$b", "a`b", "a\nb", "a/b", "a\\b", "{x}", "ñ-1", "a|b"] {
        assert_eq!(id_valido(&laxo, &json!(malo)), None, "{malo:?}");
    }
    assert!(validar_conector(&laxa("x 1")).unwrap_err().to_string().contains("ejemplo.id"));
}

#[test]
fn info_de_un_conector_que_existe_y_de_uno_que_no() {
    let i = info(Some(gruv_def()), "gruv", false);
    assert!(i.disponible && i.lee_detalle);
    assert_eq!(i.ejemplo_id, "TCK-1234");
    assert_eq!(i.comando_ticket.as_deref(), Some("/ticket"));
    assert_eq!(i.acciones, ACCIONES.to_vec());
    assert_eq!(i.estados.len(), 8);
    let n = info(None, "jira", false);
    assert_eq!((n.nombre.as_str(), n.disponible, n.id_regex.as_str(), n.comando_ticket), ("jira", false, "^[A-Za-z0-9_.-]{1,20}$", None));
    assert_eq!(info(None, "", false).nombre, "Sin conector");
}

#[test]
fn info_de_github_via_gh_con_detalle_y_las_acciones_de_gh() {
    let def = conector_por_id("github").unwrap();
    let i = info(Some(def), "github", false);
    assert!(i.lee_detalle);
    assert_eq!(i.comando_ticket, None);
    assert_eq!(i.acciones, vec![Accion::Estado, Accion::Tomar, Accion::Soltar, Accion::Comentar]);
    assert_eq!(misma_herramienta(def, Accion::Tomar), vec![Accion::Tomar]);
    assert_eq!(claves_ocultas(def), vec!["cerrado"]);
    assert_eq!(id_valido(def, &json!(" 42 ")).as_deref(), Some("42"));
    for malo in ["0", "-1", "1;x", "12345678"] {
        assert_eq!(id_valido(def, &json!(malo)), None);
    }
}

#[test]
fn sin_pistas_estados_no_hay_paso_3_ni_estados_en_el_ejemplo() {
    let sin = variante(|d| {
        d["pistas"].as_object_mut().unwrap().shift_remove("estados");
    });
    let p = build_prompt(mcp(&sin), "", None);
    assert!(!p.lines().any(|l| l.starts_with("3. ")));
    assert!(!p.contains("\"estados\""));
    assert!(build_prompt(gruv(), "", None).lines().any(|l| l.starts_with("3. Llamá a ver_flujo_tickets")));
}

#[test]
fn otro_nombre_de_conector_llega_a_los_textos_y_al_reconocimiento_de_no_tengo() {
    let otro = variante(|d| {
        d["nombre"] = json!("Mesa.Ayuda");
        d["faltaConector"] = json!({ "clave": "sin_mesa", "mensaje": "Conectá Mesa.Ayuda." });
    });
    let p = build_prompt(mcp(&otro), "", None);
    assert!(p.starts_with("Tarea de solo lectura. No modifiques nada en Mesa.Ayuda:"));
    assert!(p.ends_with("{\"error\":\"sin_mesa\",\"tickets\":[]}."));
    let sin_json = json!({ "type": "result", "subtype": "success", "result": "No tengo Mesa.Ayuda acá." }).to_string();
    assert!(matches!(parse_claude_output(&otro, &sin_json, false), Err(ErrorTickets::ConectorFalta(_))));
    let parecido = json!({ "type": "result", "subtype": "success", "result": "No tengo MesaXAyuda acá." }).to_string();
    assert!(parse_claude_output(&otro, &parecido, false).unwrap_err().to_string().contains("JSON válido"));
}

#[test]
fn un_conector_sin_comentar_no_lo_ofrece_ni_arma_su_prompt() {
    let sin = variante(|d| {
        d["herramientas"]["escritura"].as_object_mut().unwrap().shift_remove("comentar");
        d["pistas"]["acciones"].as_object_mut().unwrap().shift_remove("comentar");
    });
    assert_eq!(acciones_soportadas(&sin), vec![Accion::Estado, Accion::Tomar, Accion::Soltar, Accion::Criterio, Accion::Horas]);
    assert_eq!(misma_herramienta(&sin, Accion::Comentar), vec![]);
    assert_eq!(misma_herramienta(&sin, Accion::Tomar), vec![Accion::Tomar, Accion::Soltar]);
    let mut i = AccionInput::nuevo("TCK-1");
    i.cuerpo = Some("x".into());
    assert!(build_accion_prompt(mcp(&sin), Accion::Comentar, &i).unwrap_err().to_string().contains("no permite la acción «comentar»"));
    assert!(build_accion_args(mcp(&sin), "haiku", Accion::Comentar, &[], Limites::default()).unwrap_err().to_string().contains("no permite"));
}

#[test]
fn un_placeholder_sin_valor_deja_afuera_la_clave_y_los_literales_quedan_tipados() {
    let mut i = AccionInput::nuevo("TCK-1");
    i.persona = Some(None);
    assert!(build_accion_prompt(gruv(), Accion::Tomar, &i).unwrap().contains("Llamá a asignar_ticket con {\"id\":\"TCK-1\",\"persona\":null}."));
    let mut h = AccionInput::nuevo("TCK-1");
    h.minutos = Some(30);
    assert!(build_accion_prompt(gruv(), Accion::Horas, &h).unwrap().contains("{\"entidad\":\"ticket\",\"id\":\"TCK-1\",\"minutos\":30}"));
}

fn permitidas(args: &[String]) -> Vec<String> {
    let i = args.iter().position(|a| a == "--allowedTools").unwrap();
    args[i + 1].split(',').filter(|s| !s.is_empty()).map(String::from).collect()
}

fn valor_de(args: &[String], flag: &str) -> String {
    args[args.iter().position(|a| a == flag).unwrap() + 1].clone()
}

#[test]
fn permisos_por_consulta_es_exactamente_lo_que_va_a_allowed_tools() {
    for def in CONECTORES.iter() {
        let Some(m) = def.mcp() else { continue };
        let p = permisos_por_consulta(m);
        let full = |xs: &[String]| xs.iter().map(|t| m.nombre_completo(t)).collect::<Vec<_>>();
        assert_eq!(permitidas(&build_lista_args(m, "haiku", &[], Limites::default())), full(&p.lista), "{}", def.id());
        assert_eq!(permitidas(&build_detalle_args(m, "haiku", &[], Limites::default())), full(&p.detalle), "{}", def.id());
        let claves: Vec<Accion> = p.acciones.claves().map(|a| accion(a)).collect();
        assert_eq!(claves, acciones_soportadas(def), "{}", def.id());
        for a in acciones_soportadas(def) {
            let args = build_accion_args(m, "haiku", a, &[], Limites::default()).unwrap();
            assert_eq!(permitidas(&args), full(p.acciones.get(a.como_str()).unwrap()), "{} {a:?}", def.id());
        }
    }
}

#[test]
fn los_mcp_ajenos_van_a_disallowed_tools_en_la_lista_el_detalle_y_las_acciones() {
    let ajenos = vec!["mcp__claude_ai_Slack".to_string(), "mcp__mi_server".to_string()];
    let negadas_de = |args: &[String]| valor_de(args, "--disallowedTools").split(',').map(String::from).collect::<Vec<_>>();
    let a = acciones_soportadas(gruv_def())[0];
    for args in [build_lista_args(gruv(), "haiku", &ajenos, Limites::default()), build_detalle_args(gruv(), "haiku", &ajenos, Limites::default()), build_accion_args(gruv(), "haiku", a, &ajenos, Limites::default()).unwrap()] {
        for x in &ajenos {
            assert!(negadas_de(&args).contains(x), "{x}");
        }
    }
    assert!(!negadas_de(&build_lista_args(gruv(), "haiku", &[], Limites::default())).contains(&"mcp__claude_ai_Slack".to_string()));
}

#[test]
fn max_turns_sale_de_un_entero_validado_y_cae_a_40_con_cualquier_otra_cosa() {
    let turnos = |args: Vec<String>| args[args.iter().position(|a| a == "--max-turns").unwrap()..].to_vec();
    let l = |t: f64| Limites { max_turns: Some(t), max_cost_usd: None };
    assert_eq!(turnos(build_lista_args(gruv(), "haiku", &[], l(7.0))), vec!["--max-turns", "7"]);
    assert_eq!(turnos(build_detalle_args(gruv(), "haiku", &[], l(200.0))), vec!["--max-turns", "200"]);
    assert_eq!(turnos(build_accion_args(gruv(), "haiku", accion("estado"), &[], l(1.0)).unwrap()), vec!["--max-turns", "1"]);
    for malo in [0.0, 201.0, 999.0, f64::NAN, f64::INFINITY, 1.5, -3.0] {
        assert_eq!(turnos(build_lista_args(gruv(), "haiku", &[], l(malo))), vec!["--max-turns", "40"], "{malo}");
    }
    assert_eq!(build_lista_args(gruv(), "haiku", &[], Limites::default()).iter().filter(|a| *a == "--max-turns").count(), 1);
}

#[test]
fn max_budget_usd_solo_va_con_un_costo_valido_y_en_texto() {
    let args = build_lista_args(gruv(), "haiku", &[], Limites { max_turns: None, max_cost_usd: Some(2.5) });
    assert_eq!(args[args.len() - 2..], ["--max-budget-usd", "2.5"]);
    for malo in [0.0, -1.0, 101.0, f64::NAN, f64::INFINITY] {
        assert!(!build_lista_args(gruv(), "haiku", &[], Limites { max_turns: None, max_cost_usd: Some(malo) }).contains(&"--max-budget-usd".to_string()), "{malo}");
    }
    assert!(!build_lista_args(gruv(), "haiku", &[], Limites::default()).contains(&"--max-budget-usd".to_string()));
}

fn sobre(o: Value) -> String {
    json!({ "type": "result", "subtype": "success", "is_error": false, "result": "", "structured_output": o }).to_string()
}

#[test]
fn parse_claude_output_trae_las_vueltas_del_sobre() {
    let s = json!({ "type": "result", "subtype": "success", "num_turns": 5, "result": "", "structured_output": { "tickets": [] } }).to_string();
    assert_eq!(parse_claude_output(gruv_def(), &s, false).unwrap().num_turns, Some(5.0));
}

fn alcance() -> AlcanceLista {
    AlcanceLista { personas: vec!["11111111-1111-1111-1111-111111111111".into()], sin_asignar: true, hechos: true, desde: "2026-11-14".into() }
}

#[test]
fn lista_por_alcance_los_ids_y_la_fecha_van_en_el_pedido_sin_descripcion_ni_criterios() {
    let p = build_prompt(gruv(), "", Some(&alcance()));
    assert!(p.contains("[\"tu id\",\"11111111-1111-1111-1111-111111111111\",\"sin_asignar\"]"));
    assert!(p.contains("cerrados con \"fecha\" anterior a 2026-11-14"));
    assert!(!p.contains("dejá de paginar"));
    assert!(p.contains("estado: \"cerrado\"") && p.contains("ver_mi_perfil"));
    assert!(!p.contains("\"criterios\"") && !p.contains("\"descripcion\""));
    assert!(p.contains("\"fecha\":\"<fecha ISO>\""));
    assert!(!build_prompt(gruv(), "", Some(&AlcanceLista { hechos: false, ..alcance() })).contains("estado: \"cerrado\""));
    assert!(build_prompt(gruv(), "abc-123", Some(&alcance())).contains("Tu id en Gruv es \"abc-123\""));
    assert!(p.contains("\"no_leidos\""));
}

#[test]
fn sin_alcance_o_sin_lista_por_la_lista_es_la_de_todo_el_equipo() {
    assert_eq!(build_prompt(gruv(), "", None), build_prompt(gruv(), "", None));
    assert!(build_prompt(gruv(), "", None).contains("limite: 50"));
    let sin = variante(|d| {
        d["pistas"].as_object_mut().unwrap().shift_remove("listaPor");
        d["pistas"].as_object_mut().unwrap().shift_remove("listaHechos");
        d["pistas"].as_object_mut().unwrap().shift_remove("personas");
        d["herramientas"].as_object_mut().unwrap().shift_remove("personas");
    });
    assert_eq!(build_prompt(mcp(&sin), "", Some(&alcance())), build_prompt(mcp(&sin), "", None));
}

#[test]
fn la_lista_pide_como_mucho_50_por_pagina_y_nunca_descripcion_larga_ni_criterios() {
    let s = output_schema();
    let props = &s["properties"]["tickets"]["items"]["properties"];
    assert!(props.get("fecha").is_some() && props.get("criterios").is_none());
    assert!(build_prompt(gruv(), "", None).contains("recortado a 120 caracteres"));
}

#[test]
fn normalize_tickets_fecha_iso_validada_y_terminados_solo_si_se_piden() {
    let raw = json!({ "tickets": [
        { "id": "TCK-1", "titulo": "a", "estado": "en_curso", "fecha": "2026-11-17T10:00:00+00:00" },
        { "id": "TCK-2", "titulo": "b", "estado": "en_curso", "fecha": "ayer" },
        { "id": "TCK-3", "titulo": "c", "estado": "cerrado", "fecha": "2026-11-16T10:00:00Z" }
    ] });
    let ids: Vec<String> = normalize_tickets(gruv_def(), &raw, None).unwrap().into_iter().map(|t| t.id).collect();
    assert_eq!(ids, vec!["TCK-1", "TCK-2"]);
    let todos = normalize_tickets(gruv_def(), &raw, Some(OpcionesTickets { conservar_hechos: true, max: 250 })).unwrap();
    let pares: Vec<(String, Option<String>)> = todos.into_iter().map(|t| (t.id, t.fecha)).collect();
    assert_eq!(pares, vec![("TCK-1".into(), Some("2026-11-17T10:00:00.000Z".into())), ("TCK-2".into(), None), ("TCK-3".into(), Some("2026-11-16T10:00:00.000Z".into()))]);
}

#[test]
fn personas_solo_id_y_nombre_validados_y_sin_repetir() {
    let id1 = "11111111-1111-1111-1111-111111111111";
    let id2 = "22222222-2222-2222-2222-222222222222";
    let raw = json!([{ "id": id2, "nombre": "Zoe", "email": "zoe@x.com" }, { "id": id1, "nombre": "Ana", "celular": "123" }, { "id": id1, "nombre": "Ana de nuevo" }, { "id": "mal id", "nombre": "Mal" }, { "id": "sin-nombre" }, null]);
    let p = normalize_personas(&gruv().base, &raw);
    assert_eq!(serde_json::to_value(&p).unwrap(), json!([{ "id": id1, "nombre": "Ana" }, { "id": id2, "nombre": "Zoe" }]));
    assert!(normalize_personas(&gruv().base, &json!("x")).is_empty());
    let s = sobre(json!({ "personas": raw }));
    assert_eq!(parse_personas(gruv(), &s).unwrap().len(), 2);
    let faltante = json!({ "type": "result", "subtype": "success", "result": "{\"error\":\"sin_gruv\",\"personas\":[]}" }).to_string();
    assert!(matches!(parse_personas(gruv(), &faltante), Err(ErrorTickets::ConectorFalta(_))));
}

#[test]
fn la_consulta_de_personas_solo_deja_usar_la_herramienta_de_personas() {
    let a = build_personas_args(gruv(), "haiku", &[], Limites::default());
    assert_eq!(valor_de(&a, "--allowedTools"), "mcp__claude_ai_Gruv__buscar_persona");
    assert!(build_personas_prompt(gruv()).contains("No pongas mails, teléfonos"));
    assert!(filtra_personas(gruv_def()));
    assert!(!filtra_personas(conector_por_id("github").unwrap()));
}

#[test]
fn el_detalle_de_gruv_lee_ver_ticket_y_pide_la_descripcion_acotada_y_sin_datos_de_contacto() {
    assert!(gruv().herramientas.detalle.contains(&"ver_ticket".to_string()));
    assert!(!gruv().herramientas.negar.contains(&"ver_ticket".to_string()));
    assert!(!gruv().herramientas.escritura.valores().any(|t| t == "ver_ticket"));
    let p = build_detalle_prompt(gruv(), "TCK-1");
    assert!(p.contains("Llamá a ver_ticket con {\"id\":\"TCK-1\"}"));
    assert!(p.contains("\"ocurrido\"") && p.contains("hasta 1500 caracteres") && p.contains("sin copiar datos de contacto"));
    let args = build_detalle_args(gruv(), "haiku", &[], Limites::default());
    assert!(valor_de(&args, "--allowedTools").contains("mcp__claude_ai_Gruv__ver_ticket"));
    assert!(!valor_de(&args, "--disallowedTools").split(',').any(|t| t == "mcp__claude_ai_Gruv__ver_ticket"));
}

#[test]
fn un_conector_sin_descripcion_no_la_pide_ni_la_lee_en_el_detalle() {
    let sin = variante(|d| {
        d["pistas"].as_object_mut().unwrap().shift_remove("descripcion");
    });
    assert!(!build_detalle_prompt(mcp(&sin), "TCK-1").contains("descripcion"));
    let s = sobre(json!({ "descripcion": "algo", "criterios": [], "comentarios": [] }));
    assert_eq!(parse_detalle(mcp(&sin), &s).unwrap().descripcion, None);
}

#[test]
fn norm_descripcion_texto_plano_con_tope_de_largo_y_de_renglones() {
    assert_eq!(norm_descripcion(&json!("  Hola\r\n\r\n\r\n\r\nmundo\t  feliz  ")).as_deref(), Some("Hola\n\nmundo feliz"));
    assert_eq!(norm_descripcion(&json!("a\u{0}b\u{202e}c\u{200b}d")).as_deref(), Some("abcd"));
    assert_eq!(norm_descripcion(&json!("<img src=x onerror=alert(1)>")).as_deref(), Some("<img src=x onerror=alert(1)>"));
    assert_eq!(norm_descripcion(&json!("   \n \n ")), None);
    for mal in [json!(null), json!(3), json!({}), json!(["x"])] {
        assert_eq!(norm_descripcion(&mal), None);
    }
    let larga = norm_descripcion(&json!("x".repeat(5000))).unwrap();
    assert_eq!(larga.chars().count(), 1500);
    assert!(larga.ends_with('…'));
    let muchas: Vec<String> = (0..80).map(|i| format!("r{i}")).collect();
    assert_eq!(norm_descripcion(&json!(muchas.join("\n"))).unwrap().split('\n').count(), 25);
}

#[test]
fn un_nombre_con_correo_o_telefono_los_pierde() {
    assert_eq!(nombre_sin_contacto("José Álvarez"), "José Álvarez");
    assert_eq!(nombre_sin_contacto("Ana 2"), "Ana 2");
    assert_eq!(nombre_sin_contacto("Ana (ana@empresa.com)"), "Ana");
    assert_eq!(nombre_sin_contacto("zoe@empresa.com"), "Persona sin nombre");
    assert_eq!(nombre_sin_contacto("Luis +54 9 11 5555 1234"), "Luis");
}

#[test]
fn lista_por_alcance_lo_que_no_entro_se_cuenta() {
    let tickets = |n: usize| Value::Array((0..n).map(|i| json!({ "id": format!("TCK-{}", i + 1), "titulo": "t", "estado": "en_curso" })).collect());
    let r = parse_claude_output(gruv_def(), &sobre(json!({ "tickets": tickets(650) })), true).unwrap();
    assert_eq!((r.tickets.len(), r.no_leidos), (600, Some(50)));
    assert_eq!(parse_claude_output(gruv_def(), &sobre(json!({ "tickets": tickets(3), "no_leidos": 40 })), true).unwrap().no_leidos, Some(40));
    assert_eq!(parse_claude_output(gruv_def(), &sobre(json!({ "tickets": tickets(3) })), true).unwrap().no_leidos, None);
    assert_eq!(parse_claude_output(gruv_def(), &sobre(json!({ "tickets": tickets(3), "no_leidos": -5 })), true).unwrap().no_leidos, None);
    assert_eq!(parse_claude_output(gruv_def(), &sobre(json!({ "tickets": tickets(3), "no_leidos": 40 })), false).unwrap().no_leidos, None);
}

#[test]
fn si_las_herramientas_fallaron_se_muestra_el_motivo_en_vez_de_no_hay_tickets() {
    let e = |r: Result<_, ErrorTickets>| -> String { r.map(|_: Value| Value::Null).unwrap_err().to_string() };
    assert_eq!(e(parse_claude_output(gruv_def(), &sobre(json!({ "error": "HTTP 401: token vencido", "tickets": [] })), false).map(|_| Value::Null)), "Gruv respondió con un error: HTTP 401: token vencido");
    assert_eq!(e(parse_personas(gruv(), &sobre(json!({ "error": "tiempo agotado", "personas": [] }))).map(|_| Value::Null)), "Gruv respondió con un error: tiempo agotado");
    assert_eq!(e(parse_detalle(gruv(), &sobre(json!({ "error": "ticket no encontrado", "criterios": [], "comentarios": [] }))).map(|_| Value::Null)), "Gruv respondió con un error: ticket no encontrado");
    let r = parse_claude_output(gruv_def(), &sobre(json!({ "error": "una página falló", "tickets": [{ "id": "TCK-1", "titulo": "Uno", "estado": "abierto" }] })), false).unwrap();
    assert_eq!(r.tickets.len(), 1);
    assert!(parse_claude_output(gruv_def(), &sobre(json!({ "tickets": [] })), false).unwrap().tickets.is_empty());
}

#[test]
fn los_prompts_de_lectura_piden_el_motivo_y_la_linea_de_no_tenes_el_conector_es_la_ultima() {
    for p in [build_prompt(gruv(), "", None), build_detalle_prompt(gruv(), "TCK-1"), build_personas_prompt(gruv())] {
        assert!(p.contains("Si las herramientas de Gruv fallan y no pudiste leer nada, respondé {\"error\":"));
        assert!(p.lines().last().unwrap().contains("sin_gruv"));
    }
}

#[test]
fn un_conector_en_solo_lectura_no_ofrece_acciones_y_sus_escrituras_siguen_negadas() {
    let asana = conector_por_id("asana").unwrap();
    assert!(!acciones_soportadas(asana).is_empty());
    assert!(info(Some(asana), "asana", true).acciones.is_empty());
    assert_eq!(info(Some(asana), "asana", false).acciones, acciones_soportadas(asana));
    assert!(negadas(asana.mcp().unwrap()).contains(&asana.mcp().unwrap().nombre_completo("add_comment")));
}

#[test]
fn las_constantes_del_motor_son_las_esperadas() {
    assert_eq!(TOOL_MISSING, "sin_herramienta");
    assert_eq!(conector_falta(&gruv().base).to_string(), gruv().base.falta_conector.mensaje);
    assert_eq!(herramienta_falta(&gruv().base).to_string(), "Esta cuenta no tiene disponible esta acción de Gruv. Hacela desde Gruv.");
    assert_eq!(accion_schema()["required"], json!(["ok"]));
    assert_eq!(detail_schema()["required"], json!(["criterios", "comentarios"]));
    let _ = Ordenado::<u8>::default();
}
