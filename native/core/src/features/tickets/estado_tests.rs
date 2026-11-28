//! Pruebas de estado.rs: los casos de estado.test.ts.
use super::conectores::conector_por_id;
use super::estado::*;
use serde_json::{json, Value};

const AHORA: f64 = 1_700_000_000_000.0;

fn buscar(id: &str) -> Option<&'static super::conector::ConectorDef> {
    conector_por_id(id)
}

fn ok(json: Value, mtime_ms: f64) -> Lectura {
    Lectura::Ok { json, mtime_ms }
}

fn resolver(t: &Lectura, g: &Lectura) -> ResultadoCarga {
    resolver_estado(t, g, &buscar, AHORA)
}

fn gruv_v1() -> Value {
    json!({
        "version": 1,
        "tickets": [
            { "id": "TCK-1", "titulo": "Uno", "estado": "En Curso", "responsable": "Ana" },
            { "id": "malo", "titulo": "Inválido" },
            { "id": "TCK-2", "titulo": "Dos" }
        ],
        "estados": [{ "clave": "abierto", "nombre": "Abierto" }, { "clave": "cerrado", "nombre": "Cerrado" }],
        "me": { "id": "u-1", "nombre": "Tomy" },
        "fetchedAt": 123,
        "fetchedBy": "acc-1",
        "lastRun": { "tokens": 10, "costUsd": 0.01, "durationMs": 900 },
        "lastError": "falló algo",
        "config": { "queryAccountId": "acc-1", "model": "sonnet", "assigneeId": "u-1", "defaultRepo": "C:/repo", "projectRepos": { "Web": "C:/web" }, "confirmRefresh": false }
    })
}

fn tickets_v2() -> Value {
    json!({
        "version": 2,
        "tickets": [{ "id": "TCK-9", "titulo": "Nueve", "estado": "abierto" }],
        "config": { "conectorId": "gruv", "model": "opus", "assigneeId": "", "projectRepos": {}, "confirmRefresh": true }
    })
}

fn migrado_v2(gruv_mtime: f64) -> Value {
    let mut v = tickets_v2();
    v["migradoDe"] = json!({ "archivo": "gruv.json", "en": 1, "gruvMtimeMs": gruv_mtime });
    v
}

fn con_config(base: Value, k: &str, v: Value) -> Value {
    let mut b = base;
    b["config"][k] = v;
    b
}

fn sanear(v: &Value) -> Option<TicketsState> {
    sanear_estado(v, &buscar)
}

#[test]
fn sin_archivos_vacio_sin_conector_y_sin_guardar() {
    let r = resolver(&Lectura::Falta, &Lectura::Falta);
    assert_eq!(r, ResultadoCarga { state: estado_vacio(""), origen: Origen::Vacio, respaldar: None, guardar: false, solo_lectura: None });
    assert_eq!(r.state.config.conector_id, "");
}

#[test]
fn gruv_v1_se_migra_con_todos_sus_campos_y_el_mtime_de_gruv() {
    let r = resolver(&Lectura::Falta, &ok(gruv_v1(), 42.0));
    assert_eq!((r.origen, r.guardar, r.respaldar, r.solo_lectura), (Origen::Gruv, true, None, None));
    assert_eq!(
        r.state.a_valor(),
        json!({
            "version": 2,
            "tickets": [
                { "id": "TCK-1", "titulo": "Uno", "estado": "en_curso", "responsable": "Ana" },
                { "id": "TCK-2", "titulo": "Dos" }
            ],
            "estados": [{ "clave": "abierto", "nombre": "Abierto" }],
            "me": { "id": "u-1", "nombre": "Tomy" },
            "fetchedAt": 123,
            "fetchedBy": "acc-1",
            "lastRun": { "tokens": 10, "costUsd": 0.01, "durationMs": 900 },
            "lastError": "falló algo",
            "migradoDe": { "archivo": "gruv.json", "en": 1_700_000_000_000_i64, "gruvMtimeMs": 42 },
            "config": {
                "conectorId": "gruv", "queryAccountId": "acc-1", "model": "sonnet", "assigneeId": "u-1",
                "defaultRepo": "C:/repo", "projectRepos": { "Web": "C:/web" }, "confirmRefresh": false
            }
        })
    );
}

#[test]
fn el_orden_de_las_claves_es_el_del_typescript() {
    let r = resolver(&Lectura::Falta, &ok(gruv_v1(), 42.0));
    let texto = serde_json::to_string(&r.state.a_valor()).unwrap();
    let orden = ["\"version\"", "\"tickets\"", "\"estados\"", "\"me\"", "\"fetchedAt\"", "\"fetchedBy\"", "\"lastRun\"", "\"lastError\"", "\"migradoDe\"", "\"config\""];
    let pos: Vec<usize> = orden.iter().map(|k| texto.find(k).unwrap()).collect();
    assert!(pos.windows(2).all(|w| w[0] < w[1]), "{texto}");
    let cfg = ["\"conectorId\"", "\"queryAccountId\"", "\"model\"", "\"assigneeId\"", "\"defaultRepo\"", "\"projectRepos\"", "\"confirmRefresh\""];
    let pos: Vec<usize> = cfg.iter().map(|k| texto.find(k).unwrap()).collect();
    assert!(pos.windows(2).all(|w| w[0] < w[1]), "{texto}");
    // El ticket conserva las claves como venían (`{...t, id, estado}`), no las reordena.
    assert!(texto.contains(r#"{"id":"TCK-1","titulo":"Uno","estado":"en_curso","responsable":"Ana"}"#), "{texto}");
}

#[test]
fn tickets_valido_manda_y_no_guarda_si_gruv_no_cambio_desde_la_migracion() {
    for gruv in [ok(gruv_v1(), 5.0), Lectura::Falta, Lectura::Corrupto, Lectura::Error("EBUSY".into())] {
        let r = resolver(&ok(migrado_v2(5.0), 10.0), &gruv);
        assert_eq!((r.origen, r.guardar, r.respaldar), (Origen::Tickets, false, None));
        assert_eq!(r.state.a_valor()["tickets"], tickets_v2()["tickets"]);
        assert_eq!(r.state.config.model, "opus");
    }
}

#[test]
fn gruv_con_otro_mtime_que_el_migrado_se_vuelve_a_migrar_respaldando() {
    for (registrado, actual) in [(5.0, 10.0), (10.0, 5.0), (5.0, AHORA + 1e9)] {
        let r = resolver(&ok(migrado_v2(registrado), AHORA), &ok(gruv_v1(), actual));
        assert_eq!((r.origen, r.guardar, r.respaldar), (Origen::Gruv, true, Some(Respaldar::Previo)));
        assert_eq!(r.state.migrado_de.unwrap().gruv_mtime_ms.unwrap().0, actual);
    }
    // Un tickets.json sin el mtime registrado (de antes) también se vuelve a migrar.
    assert_eq!(resolver(&ok(tickets_v2(), 1.0), &ok(gruv_v1(), 3.0)).respaldar, Some(Respaldar::Previo));
}

#[test]
fn despues_de_volver_a_migrar_el_mismo_gruv_ya_no_se_migra_otra_vez() {
    let futuro = AHORA + 1e9;
    let una = resolver(&ok(tickets_v2(), 1.0), &ok(gruv_v1(), futuro));
    let dos = resolver_estado(&ok(una.state.a_valor(), AHORA), &ok(gruv_v1(), futuro), &buscar, AHORA + 1.0);
    assert_eq!((dos.origen, dos.guardar), (Origen::Tickets, false));
}

#[test]
fn tickets_corrupto_se_respalda_y_se_migra_gruv() {
    for t in [Lectura::Corrupto, ok(json!([1, 2]), 1.0), ok(json!({ "version": "dos" }), 1.0), ok(Value::Null, 1.0), ok(json!({ "version": 1 }), 1.0)] {
        let r = resolver(&t, &ok(gruv_v1(), 1.0));
        assert_eq!((r.respaldar, r.origen, r.solo_lectura), (Some(Respaldar::Corrupto), Origen::Gruv, None), "{t:?}");
    }
}

#[test]
fn ambos_corruptos_respaldo_y_vacio() {
    let r = resolver(&Lectura::Corrupto, &Lectura::Corrupto);
    assert_eq!(r, ResultadoCarga { state: estado_vacio("gruv"), origen: Origen::Vacio, respaldar: Some(Respaldar::Corrupto), guardar: false, solo_lectura: None });
}

#[test]
fn version_futura_no_se_toca_y_se_trabaja_en_memoria() {
    let mut futuro = tickets_v2();
    futuro["version"] = json!(3);
    let vacio = resolver(&ok(futuro, 1.0), &Lectura::Falta);
    assert_eq!(vacio, ResultadoCarga { state: estado_vacio(""), origen: Origen::Vacio, respaldar: None, guardar: false, solo_lectura: Some(SoloLectura::VersionFutura) });
    let mut futuro = tickets_v2();
    futuro["version"] = json!(7);
    let r = resolver(&ok(futuro, 1.0), &ok(gruv_v1(), 9.0));
    assert_eq!((r.origen, r.respaldar, r.guardar, r.solo_lectura), (Origen::Gruv, None, false, Some(SoloLectura::VersionFutura)));
}

#[test]
fn tickets_que_no_se_pudo_leer_no_es_corrupto_se_trabaja_en_memoria() {
    let r = resolver(&Lectura::Error("EBUSY".into()), &ok(gruv_v1(), 9.0));
    assert_eq!((r.origen, r.respaldar, r.guardar, r.solo_lectura), (Origen::Gruv, None, false, Some(SoloLectura::Ilegible)));
}

#[test]
fn gruv_que_no_se_pudo_leer_sin_tickets_valido_vacio_en_memoria() {
    for t in [Lectura::Falta, Lectura::Corrupto, ok(json!({ "version": 1 }), 1.0)] {
        let r = resolver(&t, &Lectura::Error("EBUSY".into()));
        assert_eq!(r, ResultadoCarga { state: estado_vacio("gruv"), origen: Origen::Vacio, respaldar: None, guardar: false, solo_lectura: Some(SoloLectura::GruvIlegible) });
    }
}

#[test]
fn un_conector_que_no_esta_en_esta_version_se_conserva() {
    let mut raw = con_config(tickets_v2(), "conectorId", json!("trello"));
    raw["tickets"] = json!([{ "id": "trello-12", "titulo": "T" }, { "id": "x".repeat(21), "titulo": "Largo" }, { "id": 7 }, { "id": "a b; rm" }]);
    let s = sanear(&raw).unwrap();
    assert_eq!(s.config.conector_id, "trello");
    assert_eq!(s.a_valor()["tickets"], json!([{ "id": "trello-12", "titulo": "T" }]));
}

#[test]
fn config_rara_en_disco() {
    let s = sanear(&json!({ "version": 2, "tickets": "no", "config": { "conectorId": "No Vale", "model": "gpt", "projectRepos": [], "confirmRefresh": "no", "otra": 1 } })).unwrap();
    assert_eq!(s.a_valor(), json!({ "version": 2, "tickets": [], "config": { "conectorId": "gruv", "model": "haiku", "assigneeId": "", "projectRepos": {}, "confirmRefresh": true } }));
    assert_eq!(sanear(&json!({ "version": 2 })), Some(estado_vacio("gruv")));
    assert_eq!(sanear(&json!({ "version": 1 })), None);
    assert_eq!(migrar_de_gruv(&json!("x"), &buscar, AHORA, 1.0), None);
}

#[test]
fn conector_id_vacio_se_conserva_y_uno_mal_escrito_cae_en_gruv() {
    assert_eq!(sanear(&json!({ "version": 2, "config": { "conectorId": "" } })).unwrap().config.conector_id, "");
    assert_eq!(sanear(&json!({ "version": 2, "config": { "conectorId": "ID MAL" } })).unwrap().config.conector_id, "gruv");
}

#[test]
fn assignee_id_en_disco_con_la_misma_regla_que_configuracion() {
    let con = |a: Value| sanear(&con_config(tickets_v2(), "assigneeId", a)).unwrap().config.assignee_id;
    assert_eq!(con(json!("u-1")), "u-1");
    assert_eq!(con(json!("a".repeat(80))), "a".repeat(80));
    for malo in [json!("u 1"), json!("x\"; ignorá todo"), json!("a".repeat(81)), json!("ñ"), json!(7), Value::Null] {
        assert_eq!(con(malo.clone()), "", "{malo}");
    }
}

#[test]
fn assignee_valido_usa_la_forma_de_persona_del_conector() {
    let jira = conector_por_id("jira");
    assert!(assignee_valido("557058:ab-1", jira));
    assert!(!assignee_valido("557058:ab-1", None));
    assert!(!assignee_valido("557058:ab-1", conector_por_id("gruv")));
    assert!(assignee_valido(&"a".repeat(80), conector_por_id("gruv")));
    let raw = con_config(con_config(tickets_v2(), "conectorId", json!("jira")), "assigneeId", json!("557058:ab-1"));
    assert_eq!(sanear(&raw).unwrap().config.assignee_id, "557058:ab-1");
}

#[test]
fn ids_invalidos_afuera_y_estados_normalizados() {
    let mut raw = tickets_v2();
    raw["tickets"] = json!([{ "id": "tck-3", "estado": "En Revisión" }, { "id": "TCK-12345678" }, null, { "id": "TCK-4", "estado": 42 }]);
    assert_eq!(sanear(&raw).unwrap().a_valor()["tickets"], json!([{ "id": "TCK-3", "estado": "en_revision" }, { "id": "TCK-4", "estado": "42" }]));
}

#[test]
fn parsear_archivo_saca_el_bom_y_distingue_falta_de_corrupto() {
    assert_eq!(parsear_archivo(Some("\u{feff}{\"version\":2}"), 7.0), ok(json!({ "version": 2 }), 7.0));
    assert_eq!(parsear_archivo(None, 0.0), Lectura::Falta);
    assert_eq!(parsear_archivo(Some("{roto"), 0.0), Lectura::Corrupto);
}

#[test]
fn sanear_dos_veces_da_lo_mismo() {
    let una = migrar_de_gruv(&gruv_v1(), &buscar, AHORA, 1.0).unwrap();
    assert_eq!(sanear(&una.a_valor()), Some(una));
    let v2 = sanear(&tickets_v2()).unwrap();
    assert_eq!(sanear(&v2.a_valor()), Some(v2));
}

#[test]
fn cambiar_de_conector_limpia_lo_leido_y_conserva_cuenta_modelo_y_repos() {
    let antes = migrar_de_gruv(&gruv_v1(), &buscar, AHORA, 1.0).unwrap();
    let copia = antes.clone();
    let despues = con_conector(&antes, "jira");
    let mut cfg = antes.config.clone();
    cfg.conector_id = "jira".into();
    cfg.assignee_id = String::new();
    cfg.assignee_previos = Some(serde_json::from_value(json!({ "gruv": "u-1" })).unwrap());
    assert_eq!(
        despues.a_valor(),
        json!({ "version": 2, "tickets": [], "migradoDe": { "archivo": "gruv.json", "en": 1_700_000_000_000_i64, "gruvMtimeMs": 1 }, "config": serde_json::to_value(&cfg).unwrap() })
    );
    assert_eq!(antes, copia);
    assert_eq!(con_conector(&antes, "gruv"), antes);
    assert_eq!(sanear(&despues.a_valor()), Some(despues));
}

#[test]
fn quien_tiene_gruv_danado_o_ilegible_sigue_en_gruv() {
    for gruv in [Lectura::Corrupto, Lectura::Error(String::new())] {
        assert_eq!(resolver(&Lectura::Falta, &gruv).state.config.conector_id, "gruv");
    }
    assert_eq!(resolver(&Lectura::Falta, &Lectura::Falta).state.config.conector_id, "");
}

#[test]
fn volver_a_un_conector_recupera_el_id_de_persona_que_tenia() {
    let gruv = sanear(&con_config(tickets_v2(), "assigneeId", json!("abc"))).unwrap();
    let jira = con_conector(&gruv, "jira");
    assert_eq!(jira.config.assignee_id, "");
    let mut con_id = jira.clone();
    con_id.config.assignee_id = "557058:ab-1".into();
    let vuelta = con_conector(&con_id, "gruv");
    assert_eq!(vuelta.config.assignee_id, "abc");
    assert_eq!(serde_json::to_value(&vuelta.config.assignee_previos).unwrap(), json!({ "jira": "557058:ab-1" }));
    assert_eq!(sanear(&vuelta.a_valor()), Some(vuelta));
}

#[test]
fn sin_id_de_persona_no_se_guarda_nada_para_el_conector_que_se_deja() {
    assert!(con_conector(&estado_vacio("gruv"), "jira").config.assignee_previos.is_none());
}

#[test]
fn el_saneo_de_assignee_previos_descarta_claves_invalidas_valores_raros_y_de_mas() {
    let mut previos = json!({ "gruv": "u-1", "jira": "557058:ab-1", "No Vale": "x", "linear": 7, "asana": "a".repeat(81), "github": "con espacio", "otro": "z-1" });
    for i in 0..30 {
        previos[format!("c{i}")] = json!("ok");
    }
    let s = sanear(&con_config(tickets_v2(), "assigneePrevios", previos)).unwrap();
    let p = s.config.assignee_previos.unwrap();
    assert_eq!(p.get("gruv").map(String::as_str), Some("u-1"));
    assert_eq!(p.get("jira").map(String::as_str), Some("557058:ab-1"));
    assert_eq!(p.get("otro").map(String::as_str), Some("z-1"));
    for k in ["No Vale", "linear", "asana", "github"] {
        assert!(!p.contains_key(k), "{k}");
    }
    assert_eq!(p.len(), 20);
    assert!(sanear(&con_config(tickets_v2(), "assigneePrevios", json!("no"))).unwrap().config.assignee_previos.is_none());
}

#[test]
fn sin_lista_vacia_lo_leido_y_deja_la_config_intacta() {
    let antes = migrar_de_gruv(&gruv_v1(), &buscar, AHORA, 1.0).unwrap();
    let copia = antes.clone();
    let s = sin_lista(&antes);
    assert_eq!(
        s.a_valor(),
        json!({ "version": 2, "tickets": [], "migradoDe": serde_json::to_value(antes.migrado_de.as_ref().unwrap()).unwrap(), "config": serde_json::to_value(&antes.config).unwrap() })
    );
    assert_eq!(antes, copia);
}

#[test]
fn con_conector_un_id_como_constructor_no_recupera_nada_del_prototipo() {
    let despues = con_conector(&estado_vacio("gruv"), "constructor");
    assert_eq!(despues.config.assignee_id, "");
}

#[test]
fn los_servidores_elegidos_por_cuenta_se_sanean() {
    let con = |s: Value| sanear(&con_config(tickets_v2(), "servidores", s)).unwrap().a_valor()["config"].get("servidores").cloned();
    assert_eq!(con(json!("no")), None);
    assert_eq!(con(json!({ "acc-1": { "ID MAL": "mcp__x__" } })), None);
    let mut entrada = json!({
        "acc-1": { "jira": "mcp__atlassian__", "gruv": "mcp__x y__", "linear": 7 },
        "acc-2": "basura",
        "acc-3": {}
    });
    entrada["a".repeat(65)] = json!({ "jira": "mcp__atlassian__" });
    assert_eq!(con(entrada), Some(json!({ "acc-1": { "jira": "mcp__atlassian__" } })));
}

#[test]
fn leido_con_se_conserva_si_es_valido_y_se_va_con_la_lista() {
    let mut raw = tickets_v2();
    raw["leidoCon"] = json!("mcp__mis-tickets__");
    let s = sanear(&raw).unwrap();
    assert_eq!(s.leido_con.as_deref(), Some("mcp__mis-tickets__"));
    raw["leidoCon"] = json!("otra cosa");
    assert_eq!(sanear(&raw).unwrap().leido_con, None);
    assert!(sin_lista(&s).leido_con.is_none());
}

#[test]
fn un_tickets_v2_de_antes_de_los_topes_carga_igual_y_no_suma_claves() {
    let mut viejo = tickets_v2();
    viejo["lastRun"] = json!({ "tokens": 10, "costUsd": 0.01, "durationMs": 900 });
    let s = sanear(&viejo).unwrap();
    assert_eq!(s.a_valor()["lastRun"], json!({ "tokens": 10, "costUsd": 0.01, "durationMs": 900 }));
    let v = s.a_valor();
    for k in ["maxTurns", "maxCostUsd"] {
        assert!(v["config"].get(k).is_none(), "{k}");
    }
    assert!(v.get("uso").is_none());
}

#[test]
fn los_topes_y_el_uso_validos_se_conservan_y_los_malos_se_descartan() {
    let mut bueno = con_config(con_config(tickets_v2(), "maxTurns", json!(25)), "maxCostUsd", json!(1.5));
    bueno["lastRun"] = json!({ "tokens": 1, "numTurns": 12, "maxTurns": 40, "tope": "vueltas" });
    bueno["uso"] = json!({ "2026-11-17": { "gruv": { "corridas": 1, "costUsd": 0.2, "vueltas": 12, "durationMs": 50 } } });
    let b = sanear(&bueno).unwrap();
    let v = b.a_valor();
    assert_eq!((&v["config"]["maxTurns"], &v["config"]["maxCostUsd"]), (&json!(25), &json!(1.5)));
    assert_eq!(v["lastRun"], json!({ "tokens": 1, "numTurns": 12, "maxTurns": 40, "tope": "vueltas" }));
    assert_eq!(v["uso"]["2026-11-17"]["gruv"]["vueltas"], json!(12));

    let mut malo = con_config(con_config(tickets_v2(), "maxTurns", json!("9")), "maxCostUsd", json!(-2));
    malo["lastRun"] = json!({ "tokens": 1, "numTurns": "3", "maxTurns": "9", "tope": "x" });
    malo["uso"] = json!({ "raro": { "gruv": { "corridas": 1 } }, "2026-11-17": { "Mal Id": { "corridas": 1, "costUsd": 0, "vueltas": 0, "durationMs": 0 } } });
    let m = sanear(&malo).unwrap();
    let v = m.a_valor();
    assert!(v["config"].get("maxTurns").is_none() && v["config"].get("maxCostUsd").is_none());
    assert_eq!(v["lastRun"], json!({ "tokens": 1 }));
    assert!(v.get("uso").is_none());
    assert_eq!(sanear(&m.a_valor()), Some(m));
    assert_eq!(sanear(&b.a_valor()), Some(b));
}

#[test]
fn sin_lista_y_con_conector_conservan_lo_gastado() {
    let mut raw = tickets_v2();
    raw["uso"] = json!({ "2026-11-17": { "gruv": { "corridas": 1, "costUsd": 0, "vueltas": 1, "durationMs": 1 } } });
    let s = sanear(&raw).unwrap();
    assert!(s.uso.is_some());
    assert_eq!(sin_lista(&s).uso, s.uso);
    assert_eq!(con_conector(&s, "github").uso, s.uso);
}

#[test]
fn filtro_por_personas_se_guarda_validado_y_se_suelta_al_cambiar_de_conector() {
    let sin = sanear(&tickets_v2()).unwrap();
    assert!(sin.config.personas_elegidas.is_none() && sin.personas.is_none());
    let mut raw = tickets_v2();
    raw["tickets"] = json!([{ "id": "TCK-9", "titulo": "Nueve", "estado": "cerrado", "fecha": "2026-11-17T10:00:00.000Z" }]);
    raw["personas"] = json!([{ "id": "u-1", "nombre": "Mateo", "email": "m@x.com" }, { "id": "mal id", "nombre": "X" }]);
    raw["personasAt"] = json!(5);
    raw["leido"] = json!({ "personas": ["u-1"], "sinAsignar": true, "hechos": true, "ventanaDias": 4 });
    raw["config"]["personasElegidas"] = json!(["u-1", "u-1"]);
    raw["config"]["incluirSinAsignar"] = json!(true);
    raw["config"]["estadosElegidos"] = json!(["en_qa", "inventado"]);
    raw["config"]["ventanaDias"] = json!(30);
    let s = sanear(&raw).unwrap();
    let v = s.a_valor();
    assert_eq!(v["personas"], json!([{ "id": "u-1", "nombre": "Mateo" }]));
    assert_eq!(v["leido"], json!({ "personas": ["u-1"], "sinAsignar": true, "hechos": true, "ventanaDias": 4 }));
    assert_eq!(v["config"]["personasElegidas"], json!(["u-1"]));
    assert_eq!(v["config"]["incluirSinAsignar"], json!(true));
    assert_eq!(v["config"]["estadosElegidos"], json!(["en_qa"]));
    assert!(v["config"].get("ventanaDias").is_none());
    assert_eq!(v["tickets"][0]["fecha"], json!("2026-11-17T10:00:00.000Z"));
    assert_eq!(sanear(&s.a_valor()), Some(s.clone()));
    let otro = con_conector(&s, "github");
    assert!(otro.config.personas_elegidas.is_none() && otro.config.estados_elegidos.is_none() && otro.personas.is_none());
}

#[test]
fn lo_que_no_se_trajo_por_un_tope_se_conserva_si_es_entero_positivo_y_las_personas_pierden_mails() {
    let mut base = tickets_v2();
    base["leido"] = json!({ "personas": [], "sinAsignar": false, "hechos": true, "ventanaDias": 4 });
    let no_leidos = |n: Value| {
        let mut b = base.clone();
        b["leido"]["noLeidos"] = n;
        sanear(&b).unwrap().leido.unwrap().no_leidos
    };
    assert_eq!(no_leidos(json!(25)), Some(25));
    for mal in [json!(0), json!(-3), json!(2.5), json!("9"), Value::Null] {
        assert_eq!(no_leidos(mal.clone()), None, "{mal}");
    }
    base["personas"] = json!([{ "id": "u-1", "nombre": "Ana (ana@x.com)", "telefono": "+54 11 5555 1234" }, { "id": "u-2", "nombre": "zoe@x.com" }]);
    assert_eq!(sanear(&base).unwrap().a_valor()["personas"], json!([{ "id": "u-1", "nombre": "Ana" }, { "id": "u-2", "nombre": "Persona sin nombre" }]));
}
