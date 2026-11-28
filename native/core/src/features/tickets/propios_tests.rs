//! Pruebas de propios.rs: los casos de propios.test.ts.
use super::conector::{ConectorDef, ConectorMcp};
use super::conectores::{crudo, CONECTORES};
use super::modelo::{Accion, OrigenConector, Ordenado};
use super::motor::{build_accion_args, Limites};
use super::propios::*;
use serde_json::{json, Value};

fn hash(t: &str) -> String {
    hash_corto(t)
}

/// Un incluido clonado con otro id y, si se pide, otras herramientas.
fn propio(id: &str, cambios: Value) -> Value {
    let mut d = crudo("linear");
    d["id"] = json!(id);
    for (k, v) in cambios.as_object().into_iter().flatten() {
        d["herramientas"][k] = v.clone();
    }
    d
}

fn sin_cambios(id: &str) -> Value {
    propio(id, json!({}))
}

fn con(mut v: Value, k: &str, x: Value) -> Value {
    v[k] = x;
    v
}

fn rechaza_en(raw: &Value, ruta: &str) {
    let e = validar_propio(raw).unwrap_err();
    assert_eq!(e.ruta, ruta, "{e}");
}

fn mcp_de(d: &ConectorDef) -> &ConectorMcp {
    d.mcp().unwrap()
}

fn equipo(k: &str) -> EquipoCrudo {
    EquipoCrudo { repo: k.into(), repo_key: k.into(), equipo: "E".into(), conectores: vec![sin_cambios("mio")] }
}

fn ids(l: &LecturaPropios) -> Vec<String> {
    l.archivo.conectores.iter().map(|c| c.id().to_string()).collect()
}

fn registro(equipos: &[EquipoCrudo]) -> Vec<ConectorRegistrado> {
    armar_registro(&EntradaRegistro { incluidos: &[], usuario: &[], equipos, hash: &hash }).0
}

#[test]
fn un_incluido_clonado_con_otro_id_pasa_y_sale_sin_verificar() {
    let def = validar_propio(&con(sin_cambios("mi-linear"), "verificado", json!(true))).unwrap();
    assert_eq!(def.id(), "mi-linear");
    assert!(!def.base().verificado);
}

#[test]
fn una_herramienta_de_lectura_que_parece_de_escritura_se_rechaza_con_su_ruta() {
    rechaza_en(&propio("mi-linear", json!({ "lista": ["get_user", "create_draft"] })), "conector.herramientas.lista[1]");
    let mut con_apoyo = propio("mi-linear", json!({ "apoyo": ["addComment"] }));
    con_apoyo["pistas"]["apoyo"] = json!("Usala si hace falta");
    rechaza_en(&con_apoyo, "conector.herramientas.apoyo[0]");
}

#[test]
fn comando_ticket_de_un_propio_el_valido_se_acepta_y_el_invalido_se_rechaza_con_su_ruta() {
    let ok = validar_propio(&con(sin_cambios("mi-linear"), "comandoTicket", json!("/mi:cmd"))).unwrap();
    assert_eq!(ok.base().comando_ticket.as_deref(), Some("/mi:cmd"));
    assert!(validar_propio(&sin_cambios("mi-linear")).unwrap().base().comando_ticket.is_none());
    for mal in [json!("/ticket; rm -rf"), json!("/ticket\n/otro"), json!("ticket"), json!(7)] {
        rechaza_en(&con(sin_cambios("mi-linear"), "comandoTicket", mal), "conector.comandoTicket");
    }
    let texto = json!({ "version": 1, "conectores": [con(sin_cambios("mio"), "comandoTicket", json!("/x y"))], "aceptados": {} }).to_string();
    let r = parsear_archivo_propios(Some(&texto));
    assert_eq!((r.archivo.conectores.len(), r.archivo.apartados.len()), (0, 1));
    assert!(r.avisos[0].contains("comandoTicket"));
    assert!(parsear_import(&con(sin_cambios("mio"), "comandoTicket", json!("/x;y")).to_string()).unwrap_err().contains("comandoTicket"));
}

#[test]
fn comando_ticket_de_afuera_un_comando_que_toca_la_sesion_no_entra_por_importar_el_equipo_ni_el_archivo() {
    let mal = con(sin_cambios("mio"), "comandoTicket", json!("/logout"));
    rechaza_en(&mal, "conector.comandoTicket");
    assert!(parsear_import(&mal.to_string()).unwrap_err().contains("comandoTicket"));
    let r = parsear_archivo_propios(Some(&json!({ "version": 1, "conectores": [mal.clone()], "aceptados": {} }).to_string()));
    assert_eq!(r.archivo.conectores.len(), 0);
    let eq = [EquipoCrudo { repo: "r".into(), repo_key: "r".into(), equipo: "E".into(), conectores: vec![mal, sin_cambios("bueno")] }];
    let (lista, avisos) = armar_registro(&EntradaRegistro { incluidos: &[], usuario: &[], equipos: &eq, hash: &hash });
    assert_eq!(lista.iter().map(|c| c.def.id().to_string()).collect::<Vec<_>>(), vec!["bueno".to_string()]);
    assert!(avisos[0].contains("comandoTicket"));
}

#[test]
fn los_conectores_propios_de_via_gh_se_rechazan() {
    let mut gh = crudo("github");
    gh["id"] = json!("mi-github");
    rechaza_en(&gh, "conector.via");
}

#[test]
fn parece_de_lectura_las_de_lectura_de_los_incluidos_pasan() {
    for c in CONECTORES.iter() {
        let Some(m) = c.mcp() else { continue };
        if c.id() == "jira" || c.id() == "azure-devops" {
            continue;
        }
        let h = &m.herramientas;
        for n in h.lista.iter().chain(h.detalle.iter()).chain(h.apoyo.iter().flatten()) {
            assert!(parece_de_lectura(n), "{}: {n}", c.id());
        }
    }
    for n in ["list_comments", "get_issue", "getJiraIssue", "settings_get", "atlassianUserInfo", "notion-fetch", "users-get-current", "getJQLIssues"] {
        assert!(parece_de_lectura(n), "{n}");
    }
}

#[test]
fn parece_de_lectura_lo_que_escribe_o_no_se_reconoce_como_lectura_no_pasa() {
    for n in [
        "executeWrite", "executeDestructive", "executeRead", "jira_create_issue", "jira_delete_issue", "push_files", "run_workflow", "fork_repository", "bulkDelete", "publishArtifact", "createJiraIssue", "add_comment",
        "editJiraIssue", "transition_issue", "delete", "Update-item", "get_and_delete", "confluence_update_page", "issue_set_assignee", "mergePullRequest", "closeIssue", "assign_issue", "login", "setup", "createissue",
        "do_things",
    ] {
        assert!(!parece_de_lectura(n), "{n}");
    }
}

#[test]
fn revisar_no_confiable_en_lista_detalle_apoyo_y_apoyo_en() {
    rechaza_en(&propio("mi-linear", json!({ "lista": ["get_user", "executeWrite"] })), "conector.herramientas.lista[1]");
    let mut en_detalle = propio("mi-linear", json!({ "detalle": ["get_issue", "jira_create_issue"] }));
    en_detalle["pistas"]["detalle"] = json!([{ "herramienta": "jira_create_issue", "args": { "id": "{ticket}" } }]);
    rechaza_en(&en_detalle, "conector.herramientas.detalle[1]");
    let mut con_apoyo_en = propio("mi-linear", json!({ "escritura": { "comentar": "save_comment" }, "apoyo": ["get_issue"], "apoyoEn": { "comentar": ["search_issues", "executeWrite"] } }));
    con_apoyo_en["pistas"]["apoyo"] = json!("Usala si hace falta");
    con_apoyo_en["pistas"]["acciones"] = json!({ "comentar": { "args": { "issueId": "{ticket}", "body": "{cuerpo}" } } });
    rechaza_en(&con_apoyo_en, "conector.herramientas.apoyoEn.comentar[1]");
}

#[test]
fn armar_registro_un_id_de_incluido_no_entra_y_queda_el_aviso() {
    let usuario = [sin_cambios("linear")];
    let (lista, avisos) = armar_registro(&EntradaRegistro { incluidos: &CONECTORES, usuario: &usuario, equipos: &[], hash: &hash });
    assert_eq!(lista.len(), CONECTORES.len());
    assert!(avisos[0].contains("«linear» usa el id de uno incluido"), "{avisos:?}");
    assert!(lista.iter().all(|c| c.origen == OrigenConector::Incluido && c.hash.len() == 16 && c.hash.chars().all(|x| x.is_ascii_hexdigit())));
}

#[test]
fn armar_registro_el_del_usuario_gana_al_del_equipo_y_entre_repos_gana_el_de_repo_key_menor() {
    let usuario = [sin_cambios("mio")];
    let equipos = [
        EquipoCrudo { repo: "Z:/b".into(), repo_key: "z:/b".into(), equipo: "B".into(), conectores: vec![propio("compartido", json!({ "lista": ["get_user"] }))] },
        EquipoCrudo { repo: "Z:/a".into(), repo_key: "z:/a".into(), equipo: "A".into(), conectores: vec![sin_cambios("mio"), sin_cambios("compartido")] },
    ];
    let (lista, avisos) = armar_registro(&EntradaRegistro { incluidos: &CONECTORES, usuario: &usuario, equipos: &equipos, hash: &hash });
    let origen = |id: &str| lista.iter().find(|c| c.def.id() == id).map(|c| c.origen.clone());
    assert_eq!(origen("mio"), Some(OrigenConector::Usuario));
    assert_eq!(origen("compartido"), Some(OrigenConector::Equipo { repo: "Z:/a".into(), equipo: "A".into() }));
    assert_eq!(avisos.len(), 2);
    assert!(avisos.iter().all(|a| a.starts_with("Del equipo ") && a.chars().count() <= 200));
}

#[test]
fn armar_registro_un_equipo_con_mas_de_equipo_max_conectores_se_corta() {
    let conectores: Vec<Value> = (0..EQUIPO_MAX + 2).map(|i| sin_cambios(&format!("eq-{i}"))).collect();
    let eq = [EquipoCrudo { repo: "r".into(), repo_key: "r".into(), equipo: "E".into(), conectores }];
    let (lista, avisos) = armar_registro(&EntradaRegistro { incluidos: &[], usuario: &[], equipos: &eq, hash: &hash });
    assert_eq!(lista.len(), EQUIPO_MAX);
    assert!(avisos[0].contains("más de 10"));
}

#[test]
fn json_canonico_no_depende_del_orden_de_las_claves_y_cambia_si_cambia_una_herramienta() {
    let a = sin_cambios("mi-linear");
    let b: serde_json::Map<String, Value> = a.as_object().unwrap().iter().rev().map(|(k, v)| (k.clone(), v.clone())).collect();
    assert_eq!(json_canonico(&a), json_canonico(&Value::Object(b)));
    assert_ne!(json_canonico(&a), json_canonico(&propio("mi-linear", json!({ "lista": ["get_user"] }))));
}

#[test]
fn parsear_import_ida_y_vuelta_con_texto_export_y_errores_legibles() {
    let def = validar_propio(&sin_cambios("mi-linear")).unwrap();
    assert_eq!(parsear_import(&texto_export(&def)).unwrap(), def);
    assert!(parsear_import(&" ".repeat(IMPORT_MAX_BYTES + 1)).unwrap_err().contains("pesa más de 64 KB"));
    assert!(parsear_import("{\"__proto__\": {}}").unwrap_err().contains("clave no permitida «__proto__»"));
    assert!(parsear_import("{roto").unwrap_err().contains("no es un JSON válido"));
    let mut gh = crudo("github");
    gh["id"] = json!("mi-github");
    assert!(parsear_import(&gh.to_string()).unwrap_err().contains("vía mcp"));
}

#[test]
fn parsear_archivo_propios_casos_basicos() {
    assert_eq!(parsear_archivo_propios(None), LecturaPropios { archivo: ArchivoPropios::vacio(), corrupto: false, futuro: false, avisos: vec![] });
    assert!(parsear_archivo_propios(Some("{roto")).corrupto);
    assert!(parsear_archivo_propios(Some("{\"version\":0,\"conectores\":[],\"aceptados\":{}}")).corrupto);
    let mut aceptados = json!({ "z:/a::x": "a".repeat(16), "z:/a::y": "no-es-hash" });
    aceptados["k".repeat(1101)] = json!("b".repeat(16));
    let texto = json!({ "version": 1, "conectores": [sin_cambios("bueno"), propio("malo", json!({ "lista": ["create_draft"] }))], "aceptados": aceptados }).to_string();
    let r = parsear_archivo_propios(Some(&texto));
    assert!(!r.corrupto);
    assert_eq!(ids(&r), vec!["bueno".to_string()]);
    assert_eq!(r.avisos.len(), 1);
    assert_eq!(serde_json::to_value(&r.archivo.aceptados).unwrap(), json!({ "z:/a::x": "a".repeat(16) }));
}

#[test]
fn armar_registro_el_mismo_conector_en_otra_copia_del_repo_no_avisa() {
    let eq = [equipo("z:/wt"), equipo("z:/repo")];
    let (lista, avisos) = armar_registro(&EntradaRegistro { incluidos: &[], usuario: &[], equipos: &eq, hash: &hash });
    assert!(avisos.is_empty());
    assert_eq!(lista[0].origen, OrigenConector::Equipo { repo: "z:/repo".into(), equipo: "E".into() });
}

#[test]
fn aceptado_en_cualquier_copia_del_repo_vale_para_el_conector_registrado() {
    let r = registro(&[equipo("z:/wt"), equipo("z:/repo")]).remove(0);
    assert!(matches!(&r.origen, OrigenConector::Equipo { repo, .. } if repo == "z:/repo"));
    assert_eq!(r.otros_repos, Some(vec!["z:/wt".to_string()]));
    let clave = |k: &str| k.to_string();
    let aceptados = |k: &str, v: &str| {
        let mut o: Ordenado<String> = Ordenado::default();
        o.insert(clave_aceptado(k, "mio"), v.to_string());
        o
    };
    assert!(esta_aceptado(&r, &aceptados("z:/wt", &r.hash), &clave));
    assert!(esta_aceptado(&r, &aceptados("z:/repo", &r.hash), &clave));
    assert!(!esta_aceptado(&r, &aceptados("z:/wt", "otro"), &clave));
    assert!(!esta_aceptado(&r, &Ordenado::default(), &clave));
    let de_usuario = ConectorRegistrado { origen: OrigenConector::Usuario, ..r };
    assert!(esta_aceptado(&de_usuario, &Ordenado::default(), &clave));
}

#[test]
fn parsear_conectores_equipo_devuelve_la_lista_cruda_e_ignora_las_claves_guion_bajo_de_arriba() {
    let conectores = json!([{ "id": "mio", "cualquier": "cosa" }]);
    let t = json!({ "formato": "sloth-conectores", "versión": 1, "_nota": "x", "conectores": conectores }).to_string();
    assert_eq!(Value::Array(parsear_conectores_equipo(&t).unwrap()), conectores);
}

#[test]
fn parsear_conectores_equipo_rechaza_formato_version_claves_desconocidas_mas_de_10_y_proto() {
    let t = |k: &str, v: Value| {
        let mut o = json!({ "formato": "sloth-conectores", "versión": 1, "conectores": [] });
        o[k] = v;
        o.to_string()
    };
    assert!(parsear_conectores_equipo(&t("formato", json!("sloth-team"))).unwrap_err().contains("formato"));
    assert!(parsear_conectores_equipo(&t("versión", json!(2))).unwrap_err().contains("Actualizá Sloth"));
    assert!(parsear_conectores_equipo(&t("plantillas", json!([]))).unwrap_err().contains("plantillas"));
    assert!(parsear_conectores_equipo(&t("conectores", Value::Array((0..11).map(|_| json!({})).collect()))).unwrap_err().contains("como mucho 10"));
    assert!(parsear_conectores_equipo(&t("conectores", json!({ "id": "x" }))).unwrap_err().contains("tiene que ser una lista"));
    assert!(parsear_conectores_equipo("{\"formato\":\"sloth-conectores\",\"versión\":1,\"conectores\":[{\"__proto__\":{}}]}").unwrap_err().contains("__proto__"));
    assert!(parsear_conectores_equipo("{").unwrap_err().contains("JSON"));
}

#[test]
fn parsear_archivo_propios_el_que_no_valida_queda_apartado_tal_cual_y_vuelve_a_cargarse_si_despues_valida() {
    let malo = con(propio("mi-viejo", json!({ "lista": ["get_user", "executeWrite"] })), "_extra", json!(1));
    let bueno = sin_cambios("mi-linear");
    let r = parsear_archivo_propios(Some(&json!({ "version": 1, "conectores": [bueno, malo.clone()], "aceptados": {} }).to_string()));
    assert!(!r.corrupto);
    assert_eq!(ids(&r), vec!["mi-linear".to_string()]);
    assert_eq!(r.archivo.apartados, vec![malo.clone()]);
    assert!(r.avisos[0].contains("mi-viejo") && r.avisos[0].contains("no se borra"));

    let otra_vez = parsear_archivo_propios(Some(&r.archivo.a_valor().to_string()));
    assert_eq!(otra_vez.archivo.apartados, vec![malo]);
    let mut arreglado = r.archivo.a_valor();
    arreglado["apartados"] = json!([sin_cambios("mi-viejo")]);
    let a = parsear_archivo_propios(Some(&arreglado.to_string()));
    assert_eq!(ids(&a), vec!["mi-linear".to_string(), "mi-viejo".to_string()]);
    assert!(a.archivo.apartados.is_empty());
}

#[test]
fn parsear_archivo_propios_una_version_mas_nueva_no_es_corrupta_ni_se_toca() {
    let r = parsear_archivo_propios(Some(&json!({ "version": 2, "conectores": [] }).to_string()));
    assert!(!r.corrupto && r.futuro);
    assert!(r.avisos[0].contains("actualizá Sloth"));
    assert!(parsear_archivo_propios(Some(&json!({ "version": "x" }).to_string())).corrupto);
}

#[test]
fn vista_herramientas_cada_accion_muestra_lo_mismo_que_va_a_allowed_tools_con_apoyo_en_y_la_nota() {
    let mut def = propio("mi-linear", json!({ "escritura": { "comentar": "save_comment" }, "apoyo": ["get_issue"], "apoyoEn": { "comentar": ["search_issues"] } }));
    def["pistas"]["apoyo"] = json!("Leé {ticket} antes");
    def["pistas"]["acciones"] = json!({ "comentar": { "args": { "issueId": "{ticket}", "body": "{cuerpo}" }, "nota": "Pegá lo que encuentres" } });
    let validado = validar_propio(&def).unwrap();
    let m = mcp_de(&validado);
    let v = vista_herramientas(m);
    assert_eq!(v.acciones.get("comentar"), Some(&vec!["save_comment".to_string(), "get_issue".into(), "search_issues".into()]));
    let args = build_accion_args(m, "haiku", Accion::Comentar, &[], Limites::default()).unwrap();
    let permitidas: Vec<String> = args[args.iter().position(|x| x == "--allowedTools").unwrap() + 1].split(',').map(str::to_string).collect();
    assert_eq!(permitidas, v.acciones.get("comentar").unwrap().iter().map(|t| format!("{}{t}", m.herramientas.prefijo)).collect::<Vec<_>>());
    let mut detalle: Vec<String> = Vec::new();
    for t in m.herramientas.detalle.iter().cloned().chain(["get_issue".to_string()]) {
        if !detalle.contains(&t) {
            detalle.push(t);
        }
    }
    assert_eq!(v.detalle, detalle);
    assert_eq!(v.pistas.acciones.get("comentar"), Some(&("{\"issueId\":\"{ticket}\",\"body\":\"{cuerpo}\"}".to_string(), Some("Pegá lo que encuentres".to_string()))));
    assert_eq!(v.pistas.apoyo.as_deref(), Some("Leé {ticket} antes"));
    assert_eq!(v.pistas.yo_con_id, m.pistas.yo.con_id);
    assert_eq!(v.pistas.detalle.len(), m.pistas.detalle.len());
    assert_eq!(v.comando_ticket, None);
    let con_cmd = validar_propio(&con(def, "comandoTicket", json!("/mi:cmd"))).unwrap();
    assert_eq!(vista_herramientas(mcp_de(&con_cmd)).comando_ticket.as_deref(), Some("/mi:cmd"));
}

#[test]
fn claves_aceptadas_la_copia_registrada_y_todas_las_otras() {
    let r = registro(&[equipo("z:/wt"), equipo("z:/repo")]).remove(0);
    assert_eq!(claves_aceptadas(&r, &|k| k.to_string()), vec![clave_aceptado("z:/repo", "mio"), clave_aceptado("z:/wt", "mio")]);
}

#[test]
fn el_hash_es_el_sha256_corto_de_siempre() {
    assert_eq!(hash_corto("abc"), "ba7816bf8f01cfea");
}
