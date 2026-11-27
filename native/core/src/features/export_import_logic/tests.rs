use super::*;
use crate::features::export_crypto::encrypt_text;

fn acc(id: &str, label: &str) -> Value {
    json!({ "id": id, "label": label, "configDir": format!("C:\\secreto\\{id}"), "createdAt": 1 })
}

fn ws(id: &str, name: &str, repo_path: &str, account_id: &str) -> Value {
    json!({ "id": id, "name": name, "repoPath": repo_path, "cwd": repo_path, "accountId": account_id, "autoStartClaude": true, "createdAt": 1 })
}

fn con(mut base: Value, extra: Value) -> Value {
    for (k, v) in extra.as_object().unwrap() {
        base[k] = v.clone();
    }
    base
}

fn doc(extra: Value) -> String {
    con(json!({ "formato": FORMAT, "formatoVersion": FORMAT_VERSION, "versión": "1.0.0", "exportado": "hoy" }), extra).to_string()
}

fn parse(extra: Value) -> ParsedImport {
    parse_import(&doc(extra)).unwrap()
}

fn error(extra: Value) -> String {
    parse_import(&doc(extra)).unwrap_err()
}

fn cuenta_a() -> Value {
    json!({ "label": "Trabajo", "shareSetup": true })
}

fn espacio_a() -> Value {
    json!({ "nombre": "api", "ruta": "C:\\repos\\api", "cuenta": "Trabajo" })
}

fn con_texto(e: String, patron: &str) {
    assert!(e.contains(patron), "«{e}» no contiene «{patron}»");
}

#[test]
fn parse_import_rechaza_json_roto_otros_formatos_y_valores_que_no_son_objeto() {
    con_texto(parse_import("{no").unwrap_err(), "no es un JSON válido");
    con_texto(parse_import("").unwrap_err(), "no es un JSON válido");
    con_texto(parse_import("[]").unwrap_err(), "No es una configuración exportada");
    con_texto(parse_import("null").unwrap_err(), "No es una configuración exportada");
    con_texto(parse_import(&json!({ "formato": "otra-cosa" }).to_string()).unwrap_err(), "No es una configuración exportada");
}

#[test]
fn parse_import_tolera_el_bom_del_principio() {
    assert_eq!(parse_import(&format!("\u{feff}{}", doc(json!({})))).unwrap().formato_version, FORMAT_VERSION as f64);
}

#[test]
fn parse_import_rechaza_un_archivo_de_una_version_mas_nueva_y_acepta_la_actual() {
    con_texto(error(json!({ "formatoVersion": FORMAT_VERSION + 1 })), "versión más nueva");
    assert_eq!(parse(json!({})).formato_version, FORMAT_VERSION as f64);
}

#[test]
fn parse_import_sin_formato_version_se_lee_como_formato_1() {
    let p = parse_import(&json!({ "formato": FORMAT, "cuentas": [cuenta_a()], "espacios": [{ "name": "api", "repoPath": "C:\\r\\api", "cuenta": "Trabajo" }] }).to_string()).unwrap();
    assert_eq!(p.formato_version, 1.0);
    assert_eq!(p.version, "?");
    assert_eq!(p.espacios[0].ruta, "C:\\r\\api");
}

#[test]
fn parse_import_formato_1_con_rama_y_sin_carpeta_marca_el_espacio_como_sin_carpeta() {
    let p = parse_import(
        &json!({
            "formato": FORMAT,
            "cuentas": [cuenta_a()],
            "espacios": [{ "name": "wt", "cuenta": "Trabajo", "branch": "feat/x" }, { "name": "wt2", "cuenta": "Trabajo", "branch": "feat/y", "carpeta": "C:\\wt\\y" }]
        })
        .to_string(),
    )
    .unwrap();
    assert!(p.espacios[0].sin_carpeta);
    assert_eq!(p.espacios[0].ruta, "");
    assert_eq!(p.espacios[1].ruta, "C:\\wt\\y");
}

#[test]
fn parse_import_formato_1_descarta_un_primer_mensaje_que_empieza_con_exclamacion_pero_importa_el_espacio() {
    let p = parse_import(
        &json!({
            "formato": FORMAT,
            "cuentas": [cuenta_a()],
            "espacios": [
                { "name": "a", "repoPath": "C:\\a", "cuenta": "Trabajo", "initialPrompt": "  !rm -rf /" },
                { "name": "b", "repoPath": "C:\\b", "cuenta": "Trabajo", "initialPrompt": "/ticket X-1", "ticket": "X-1" }
            ]
        })
        .to_string(),
    )
    .unwrap();
    assert_eq!(p.espacios[0].initial_prompt, None);
    assert!(p.espacios[0].aviso.as_deref().unwrap().contains("«!»"));
    assert_eq!(p.espacios[1].initial_prompt.as_deref(), Some("/ticket X-1"));
    assert_eq!(p.espacios[1].ticket.as_deref(), Some("X-1"));
}

#[test]
fn parse_import_valida_que_cuentas_espacios_y_plantillas_sean_listas_y_no_pasen_los_topes() {
    con_texto(error(json!({ "cuentas": {} })), "tienen que ser listas");
    con_texto(error(json!({ "espacios": "x" })), "tienen que ser listas");
    con_texto(error(json!({ "plantillas": {} })), "tiene que ser una lista");
    con_texto(error(json!({ "cuentas": (0..101).map(|i| json!({ "label": format!("c{i}") })).collect::<Vec<_>>() })), "Demasiadas cuentas");
    con_texto(error(json!({ "espacios": vec![espacio_a(); 501] })), "Demasiados espacios");
    con_texto(error(json!({ "plantillas": vec![json!({ "name": "a", "repoPath": "C:\\a" }); 201] })), "Demasiadas plantillas");
    con_texto(error(json!({ "permisos": vec![json!({ "espacio": "a", "ruta": "b", "reglas": [] }); 501] })), "Demasiados espacios con reglas");
}

#[test]
fn parse_import_con_cuentas_y_espacios_en_null_los_toma_como_listas_vacias() {
    let p = parse(json!({ "cuentas": null, "espacios": null, "plantillas": null }));
    assert!(p.cuentas.is_empty() && p.espacios.is_empty() && p.plantillas.is_empty());
}

#[test]
fn parse_import_en_cuentas_elementos_invalidos_label_faltante_o_larga_y_duplicadas_sin_distinguir_mayusculas() {
    con_texto(error(json!({ "cuentas": ["x"] })), "Cuenta 1: formato inválido");
    con_texto(error(json!({ "cuentas": [{}] })), "Cuenta 1: falta «label»");
    con_texto(error(json!({ "cuentas": [{ "label": "   " }] })), "falta «label»");
    con_texto(error(json!({ "cuentas": [{ "label": 5 }] })), "tiene que ser texto");
    con_texto(error(json!({ "cuentas": [{ "label": "x".repeat(81) }] })), "demasiado largo");
    let p = parse(json!({ "cuentas": [{ "label": "Trabajo" }, { "label": " trabajo " }, { "label": "Casa", "shareSetup": false }] }));
    assert_eq!(
        p.cuentas,
        vec![
            ExportedAccount { label: "Trabajo".into(), share_setup: true, plan: None, proveedor: None },
            ExportedAccount { label: "Casa".into(), share_setup: false, plan: None, proveedor: None }
        ]
    );
}

#[test]
fn cuenta_exportada_no_escribe_proveedor_para_claude_conserva_uno_desconocido_y_parse_import_descarta_ids_invalidos() {
    let e = |extra: Value, plan: Option<&str>| serde_json::to_value(cuenta_exportada(&con(acc("a1", "Trabajo"), extra), plan)).unwrap();
    assert_eq!(e(json!({}), None), json!({ "label": "Trabajo", "shareSetup": true }));
    assert_eq!(e(json!({ "proveedor": "claude" }), Some("Max")), json!({ "label": "Trabajo", "shareSetup": true, "plan": "Max" }));
    assert_eq!(e(json!({ "proveedor": "xx" }), None), json!({ "label": "Trabajo", "shareSetup": true, "proveedor": "xx" }));
    assert_eq!(e(json!({ "proveedor": "No Valido!" }), None), json!({ "label": "Trabajo", "shareSetup": true }));
    let p = parse(json!({ "cuentas": [{ "label": "a", "proveedor": "xx" }, { "label": "b", "proveedor": 5 }, { "label": "c", "proveedor": "claude" }, { "label": "d", "proveedor": "x y" }] }));
    let provs: Vec<_> = p.cuentas.iter().map(|c| c.proveedor.as_deref()).collect();
    assert_eq!(provs, vec![Some("xx"), None, None, None]);
}

#[test]
fn parse_import_conserva_el_plan_de_la_cuenta_solo_si_es_corto_y_sin_controles() {
    let p = parse(json!({
        "cuentas": [
            { "label": "a", "plan": "Max" },
            { "label": "b", "plan": "x".repeat(21) },
            { "label": "c", "plan": "Pro\nx" },
            { "label": "d", "plan": 42 },
            { "label": "e", "plan": "   " }
        ]
    }));
    let planes: Vec<_> = p.cuentas.iter().map(|c| c.plan.as_deref()).collect();
    assert_eq!(planes, vec![Some("Max"), None, None, None, None]);
}

#[test]
fn parse_import_en_espacios_campos_faltantes_tipos_y_largos() {
    con_texto(error(json!({ "espacios": [5] })), "Espacio 1: formato inválido");
    con_texto(error(json!({ "espacios": [{ "ruta": "C:\\a", "cuenta": "x" }] })), "Espacio 1: falta «name»");
    con_texto(error(json!({ "espacios": [{ "nombre": "a", "cuenta": "x" }] })), "falta «ruta»");
    con_texto(error(json!({ "espacios": [{ "nombre": "a", "ruta": "C:\\a" }] })), "falta «cuenta»");
    con_texto(error(json!({ "espacios": [{ "nombre": "x".repeat(121), "ruta": "C:\\a", "cuenta": "x" }] })), "demasiado largo");
    con_texto(error(json!({ "espacios": [{ "nombre": "a", "ruta": "x".repeat(1025), "cuenta": "x" }] })), "demasiado largo");
    con_texto(error(json!({ "espacios": [{ "nombre": "a", "ruta": ["C:\\a"], "cuenta": "x" }] })), "tiene que ser texto");
}

#[test]
fn parse_import_en_espacios_formato_2_ignora_ticket_y_primer_mensaje_y_valida_colores() {
    let p = parse(json!({
        "cuentas": [cuenta_a()],
        "espacios": [
            con(espacio_a(), json!({ "initialPrompt": "hola", "ticket": "X-1", "color": "#3b82f6", "colorEspacio": "lila" })),
            con(espacio_a(), json!({ "nombre": "b", "color": "#123456", "colorEspacio": "rojo" })),
            con(espacio_a(), json!({ "nombre": "c", "color": 5, "colorEspacio": 5 }))
        ]
    }));
    assert_eq!((p.espacios[0].initial_prompt.clone(), p.espacios[0].ticket.clone()), (None, None));
    assert_eq!(p.espacios[0].color.as_deref(), Some("#3b82f6"));
    assert_eq!(p.espacios[0].color_espacio.as_deref(), Some("lila"));
    assert_eq!((p.espacios[1].color.clone(), p.espacios[1].color_espacio.clone()), (None, None));
    assert_eq!(p.espacios[2].color, None);
}

#[test]
fn parse_import_recorta_espacios_y_conserva_rutas_con_puntos_sin_tocarlas() {
    let p = parse(json!({ "cuentas": [cuenta_a()], "espacios": [{ "nombre": "  api  ", "ruta": " C:\\a\\..\\..\\x ", "cuenta": "Trabajo" }] }));
    assert_eq!(p.espacios[0].nombre, "api");
    assert_eq!(p.espacios[0].ruta, "C:\\a\\..\\..\\x");
}

#[test]
fn parse_import_en_plantillas_requeridos_worktree_y_primer_mensaje_con_exclamacion() {
    let plantillas = |t: Value| error(json!({ "plantillas": [t] }));
    con_texto(plantillas(json!(1)), "Plantilla 1: formato inválido");
    con_texto(plantillas(json!({ "repoPath": "C:\\a" })), "falta «name»");
    con_texto(plantillas(json!({ "name": "a" })), "falta «repoPath»");
    con_texto(plantillas(json!({ "name": "a", "repoPath": "C:\\a", "useWorktree": "x" })), "«useWorktree» inválido");
    con_texto(plantillas(json!({ "name": "a", "repoPath": "C:\\a", "useWorktree": {} })), "falta «branchPattern»");
    con_texto(plantillas(json!({ "name": "a", "repoPath": "x".repeat(1001) })), "demasiado largo");
    let p = parse(json!({
        "plantillas": [
            { "name": "ok", "repoPath": "C:\\a", "cuenta": "Trabajo", "namePattern": "{n}", "initialPrompt": "/x", "useWorktree": { "branchPattern": "f/{n}" }, "autoStartClaude": false, "resume": false },
            { "name": "mala", "repoPath": "C:\\b", "initialPrompt": "!calc" },
            { "name": "nula", "repoPath": "C:\\c", "useWorktree": null }
        ]
    }));
    assert_eq!(p.plantillas.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), vec!["ok", "nula"]);
    assert_eq!(p.plantillas[0].use_worktree.as_ref().unwrap().branch_pattern, "f/{n}");
    assert!(!p.plantillas[0].auto_start_claude);
    assert!(p.plantillas[1].auto_start_claude);
    assert_eq!(p.plantillas_descartadas.len(), 1);
    assert_eq!(p.plantillas_descartadas[0].name, "mala");
}

#[test]
fn parse_import_en_apariencia_deja_pasar_solo_valores_conocidos() {
    let p = parse(json!({ "apariencia": { "theme": "noche", "density": "compacta", "uiFontSize": 14, "accent": "lila", "lightMode": true } }));
    let esperada = ExportedAppearance { theme: Some("noche".into()), density: Some("compacta".into()), ui_font_size: Some(14), accent: Some("lila".into()), light_mode: Some(true) };
    assert_eq!(p.apariencia, Some(esperada));
    let mala = parse(json!({ "apariencia": { "theme": "fucsia", "density": "enorme", "uiFontSize": 99, "accent": "coral", "lightMode": "sí" } }));
    assert_eq!(mala.apariencia, Some(ExportedAppearance::default()));
    assert_eq!(parse(json!({ "apariencia": { "uiFontSize": 14.5 } })).apariencia, Some(ExportedAppearance::default()));
    assert_eq!(parse(json!({ "apariencia": { "uiFontSize": 11 } })).apariencia, Some(ExportedAppearance::default()));
    assert_eq!(parse(json!({ "apariencia": [] })).apariencia, None);
    assert_eq!(parse(json!({})).apariencia, None);
}

#[test]
fn parse_import_en_apariencia_un_entero_escrito_con_decimal_cuenta_como_entero() {
    let p = parse_import(&doc(json!({})).replace("}", ",\"apariencia\":{\"uiFontSize\":14.0}}")).unwrap();
    assert_eq!(p.apariencia.unwrap().ui_font_size, Some(14));
}

#[test]
fn parse_import_en_atajos_descarta_ids_desconocidos_y_combinaciones_invalidas() {
    let p = parse(json!({ "atajos": { "palette": "ctrl k", "hackeo": "ctrl x", "new": "k", "help": 5 } }));
    assert_eq!(p.atajos.unwrap().into_iter().map(|(k, _)| k).collect::<Vec<_>>(), vec!["palette"]);
    assert_eq!(parse(json!({ "atajos": { "hackeo": "ctrl x" } })).atajos, None);
    assert_eq!(parse(json!({ "atajos": "x" })).atajos, None);
}

#[test]
fn parse_import_en_equipo_acepta_solo_una_url_https_de_proyecto() {
    let equipo = |u: Value| parse(json!({ "equipo": { "supabaseUrl": u } })).equipo;
    assert_eq!(equipo(json!("https://abc.supabase.co")).as_deref(), Some("https://abc.supabase.co"));
    for url in [json!("http://abc.supabase.co"), json!("https://u:p@abc.supabase.co"), json!("https://abc.supabase.co/x"), json!("https://abc.supabase.co/?a=1"), json!("no"), json!(""), json!(5)] {
        assert_eq!(equipo(url.clone()), None, "{url}");
    }
}

#[test]
fn la_url_de_supabase_se_normaliza_a_su_origen_y_los_mensajes_son_los_del_ts() {
    assert_eq!(normalizar_url_supabase("  HTTPS://ABC.supabase.co:443  ").unwrap(), "https://abc.supabase.co");
    assert_eq!(normalizar_url_supabase("https://abc.supabase.co/").unwrap(), "https://abc.supabase.co");
    assert_eq!(normalizar_url_supabase("https://abc.supabase.co?").unwrap(), "https://abc.supabase.co");
    con_texto(normalizar_url_supabase("").unwrap_err(), "no es válida");
    con_texto(normalizar_url_supabase(&format!("https://{}.co", "a".repeat(300))).unwrap_err(), "no es válida");
    con_texto(normalizar_url_supabase("abc.supabase.co").unwrap_err(), "<ref>.supabase.co");
    con_texto(normalizar_url_supabase("http://abc.supabase.co").unwrap_err(), "empezar con https://");
    con_texto(normalizar_url_supabase("ftp://abc.supabase.co").unwrap_err(), "empezar con https://");
    con_texto(normalizar_url_supabase("https://u@abc.supabase.co").unwrap_err(), "usuario ni contraseña");
    con_texto(normalizar_url_supabase("https://abc.supabase.co/?a=1").unwrap_err(), "? ni #");
    con_texto(normalizar_url_supabase("https://abc.supabase.co/#x").unwrap_err(), "? ni #");
    con_texto(normalizar_url_supabase("https://abc.supabase.co/x").unwrap_err(), "no puede tener ruta");
}

#[test]
fn parse_import_en_permisos_estructura_invalida_falla_reglas_invalidas_quedan_marcadas() {
    let permisos = |p: Value| error(json!({ "permisos": [p] }));
    con_texto(permisos(json!(5)), "Permisos 1: formato inválido");
    con_texto(permisos(json!({ "espacio": "a", "ruta": "b" })), "Permisos 1: formato inválido");
    con_texto(permisos(json!({ "ruta": "b", "reglas": [] })), "falta «espacio»");
    con_texto(permisos(json!({ "espacio": "a", "ruta": "b", "reglas": vec!["Edit"; 501] })), "demasiadas reglas");
    let p = parse(json!({
        "permisos": [{
            "espacio": "api",
            "ruta": "C:\\repos\\api",
            "reglas": [
                { "kind": "cmd", "tool": "Bash", "match": "npm test" },
                { "kind": "cmd", "tool": "Bash", "match": "npm *" },
                { "kind": "edit", "tool": "Edit", "match": "src/**" },
                { "kind": "net", "tool": "WebFetch", "match": "Example.com" },
                { "kind": "otro", "tool": "Bash", "match": "x" },
                null,
                7
            ]
        }]
    }));
    let r = &p.permisos[0].reglas;
    assert_eq!(r.iter().map(|x| x.valida).collect::<Vec<_>>(), vec![true, false, false, true, false, false, false]);
    assert_eq!(r[3].draft.as_ref().unwrap().match_, "example.com");
    assert!(r[1].draft.is_none());
    assert!(r[1].motivo.is_some());
}

#[test]
fn parse_import_convierte_reglas_de_texto_del_formato_viejo_solo_si_no_amplian_el_permiso() {
    let p = parse(json!({
        "permisos": [{
            "espacio": "a",
            "ruta": "b",
            "reglas": ["Bash(npm test)", "Bash", "Bash(*)", "WebFetch(domain:docs.x.com)", "WebFetch", "WebFetch(https://x.com)", "Edit", "Edit(src/**)", "mcp__s__t", "mcp__s__t(x)", "Raro", "((("]
        }]
    }));
    assert_eq!(p.permisos[0].reglas.iter().map(|x| x.valida).collect::<Vec<_>>(), vec![true, false, false, true, false, false, true, false, true, false, false, false]);
}

#[test]
fn parse_import_corta_el_texto_mostrado_de_una_regla_enorme() {
    let p = parse(json!({ "permisos": [{ "espacio": "a", "ruta": "b", "reglas": ["x".repeat(5000)] }] }));
    assert!(p.permisos[0].reglas[0].texto.len() <= 200);
}

#[test]
fn read_envelope_distingue_plano_de_cifrado_y_rechaza_lo_danado() {
    assert!(matches!(read_envelope(&doc(json!({}))).unwrap(), Envelope::Plano { .. }));
    con_texto(read_envelope("x").unwrap_err(), "no es un JSON válido");
    con_texto(read_envelope(&json!({ "formato": "otro" }).to_string()).unwrap_err(), "No es una configuración exportada");
    con_texto(read_envelope(&json!({ "formato": FORMAT, "cifrado": {} }).to_string()).unwrap_err(), "cifrado está dañado");
    con_texto(read_envelope(&json!({ "formato": FORMAT, "cifrado": {}, "datos": 5 }).to_string()).unwrap_err(), "cifrado está dañado");
}

fn sobre(extra: Value, enc: &crate::features::export_crypto::Encrypted) -> (Value, String, String) {
    let mut v = con(json!({ "formato": FORMAT, "formatoVersion": FORMAT_VERSION, "versión": "9.9.9", "exportado": "hoy" }), extra);
    let e = serde_json::to_value(enc).unwrap();
    v["cifrado"] = e["cifrado"].clone();
    v["datos"] = e["datos"].clone();
    match read_envelope(&v.to_string()).unwrap() {
        Envelope::Cifrado { cifrado, datos, version } => (cifrado, datos, version),
        _ => panic!("se esperaba un archivo cifrado"),
    }
}

#[test]
fn archivo_cifrado_ida_y_vuelta_por_el_sobre_y_parse_import() {
    let interior = doc(json!({ "cuentas": [cuenta_a()], "espacios": [espacio_a()] }));
    let enc = encrypt_text(&interior, "contraseña-larga").unwrap();
    let (c, d, version) = sobre(json!({}), &enc);
    assert_eq!(version, "9.9.9");
    let p = parse_import(&open_envelope(&c, &d, "contraseña-larga").unwrap()).unwrap();
    assert_eq!(p.espacios[0].nombre, "api");
}

#[test]
fn archivo_cifrado_contrasena_vacia_o_erronea_y_datos_manipulados_no_abren_nada() {
    let enc = encrypt_text(&doc(json!({})), "contraseña-larga").unwrap();
    let (c, d, _) = sobre(json!({}), &enc);
    assert_eq!(open_envelope(&c, &d, "").unwrap_err(), WRONG_PASSWORD);
    assert_eq!(open_envelope(&c, &d, "otra-contraseña").unwrap_err(), WRONG_PASSWORD);
    let mut bytes = base64_decodificar(&d);
    bytes[0] ^= 1;
    assert_eq!(open_envelope(&c, &base64_codificar(&bytes), "contraseña-larga").unwrap_err(), WRONG_PASSWORD);
}

fn base64_decodificar(s: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}

fn base64_codificar(b: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(b)
}

#[test]
fn archivo_cifrado_sin_version_se_lee_como_interrogacion() {
    let enc = encrypt_text(&doc(json!({})), "contraseña-larga").unwrap();
    let mut v = json!({ "formato": FORMAT });
    let e = serde_json::to_value(&enc).unwrap();
    v["cifrado"] = e["cifrado"].clone();
    v["datos"] = e["datos"].clone();
    let Envelope::Cifrado { version, .. } = read_envelope(&v.to_string()).unwrap() else { panic!("se esperaba un archivo cifrado") };
    assert_eq!(version, "?");
}

#[test]
fn archivo_cifrado_con_un_algoritmo_desconocido_no_lo_abre_esta_version() {
    let enc = encrypt_text(&doc(json!({})), "contraseña-larga").unwrap();
    let (mut c, d, _) = sobre(json!({}), &enc);
    c["algoritmo"] = json!("rot13");
    con_texto(open_envelope(&c, &d, "contraseña-larga").unwrap_err(), "no lo reconoce");
}

#[test]
fn el_archivo_cifrado_por_node_se_lee_por_el_sobre_y_se_importa() {
    let archivo = include_str!("../../../fixtures/export/default.sloth");
    let Envelope::Cifrado { cifrado, datos, version } = read_envelope(archivo).unwrap() else { panic!("se esperaba un archivo cifrado") };
    assert_eq!(version, "0.8.0");
    let p = parse_import(&open_envelope(&cifrado, &datos, "contraseña-larga").unwrap()).unwrap();
    assert_eq!(p.espacios[0].nombre, "ñandú ✓");
    assert_eq!(p.cuentas[0].plan.as_deref(), Some("Max"));
    assert_eq!(p.atajos.unwrap(), vec![("palette".to_string(), "Ctrl K".to_string())]);
}

fn cuentas() -> Vec<Value> {
    vec![acc("a1", "Trabajo")]
}

fn en_c(p: &str) -> bool {
    p.to_lowercase().starts_with("c:")
}

#[test]
fn build_plan_clasifica_cuentas_y_espacios_ok_ya_conflicto_faltante_y_saltear() {
    let parsed = parse(json!({
        "cuentas": [cuenta_a(), { "label": "Casa" }],
        "espacios": [
            { "nombre": "nuevo", "ruta": "C:\\repos\\nuevo", "cuenta": "Casa" },
            { "nombre": "API", "ruta": "c:/repos/api/", "cuenta": "Trabajo" },
            { "nombre": "web", "ruta": "C:\\repos\\otra", "cuenta": "Trabajo" },
            { "nombre": "lejos", "ruta": "D:\\no-existe", "cuenta": "Trabajo" },
            { "nombre": "huérfano", "ruta": "C:\\repos\\h", "cuenta": "Fantasma" }
        ]
    }));
    let locales = [ws("w1", "api", "C:\\repos\\api", "a1"), ws("w2", "web", "C:\\repos\\web", "a1")];
    let plan = build_plan(&parsed, &cuentas(), &locales, &en_c, &Value::Null);
    assert_eq!(plan.cuentas, vec![PlanAccount { label: "Trabajo".into(), action: AccionCuenta::Existe }, PlanAccount { label: "Casa".into(), action: AccionCuenta::Crear }]);
    assert_eq!(plan.espacios.iter().map(|e| e.status).collect::<Vec<_>>(), vec![SpaceStatus::Ok, SpaceStatus::Ya, SpaceStatus::Conflicto, SpaceStatus::Faltante, SpaceStatus::Saltear]);
    assert_eq!(plan.espacios[2].existente.as_deref(), Some("web"));
    con_texto(plan.espacios[4].motivo.clone().unwrap(), "«Fantasma»");
}

#[test]
fn build_plan_salta_un_worktree_sin_carpeta_y_no_toca_los_espacios_locales() {
    let parsed = parse_import(&json!({ "formato": FORMAT, "cuentas": [cuenta_a()], "espacios": [{ "name": "wt", "cuenta": "Trabajo", "branch": "f/x" }] }).to_string()).unwrap();
    let locales = [ws("w1", "local", "C:\\l", "a1")];
    let copia = serde_json::to_string(&locales).unwrap();
    let plan = build_plan(&parsed, &cuentas(), &locales, &|_| true, &Value::Null);
    assert_eq!(plan.espacios[0].status, SpaceStatus::Saltear);
    assert_eq!(serde_json::to_string(&locales).unwrap(), copia);
}

#[test]
fn build_plan_no_pisa_plantillas_con_el_mismo_nombre_y_salta_las_de_carpetas_inexistentes() {
    let parsed = parse(json!({
        "plantillas": [
            { "name": "Existe", "repoPath": "C:\\a" },
            { "name": "nueva", "repoPath": "C:\\b" },
            { "name": "NUEVA", "repoPath": "C:\\b2" },
            { "name": "sin-carpeta", "repoPath": "D:\\x" },
            { "name": "mala", "repoPath": "C:\\c", "initialPrompt": "!x" }
        ]
    }));
    let plan = build_plan(&parsed, &cuentas(), &[], &|p| p.starts_with("C:"), &json!({ "templates": [{ "name": "existe" }] }));
    assert_eq!(plan.plantillas.nuevas, vec!["nueva"]);
    assert_eq!(plan.plantillas.existentes, vec!["Existe", "NUEVA"]);
    assert_eq!(plan.plantillas.salteadas.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["mala", "sin-carpeta"]);
}

#[test]
fn build_plan_cuenta_atajos_apariencia_equipo_y_reglas_validas() {
    let parsed = parse(json!({
        "apariencia": { "theme": "claro" },
        "atajos": { "palette": "ctrl k", "new": "alt n" },
        "equipo": { "supabaseUrl": "https://abc.supabase.co" },
        "cuentas": [cuenta_a()],
        "espacios": [espacio_a()],
        "permisos": [
            { "espacio": "api", "ruta": "C:\\repos\\api", "reglas": ["Bash(npm test)", "Bash"] },
            { "espacio": "otro", "ruta": "C:\\x", "reglas": [] }
        ]
    }));
    let plan = build_plan(&parsed, &cuentas(), &[], &|_| true, &Value::Null);
    assert!(plan.apariencia);
    assert_eq!(plan.apariencia_valores, Some(ExportedAppearance { theme: Some("claro".into()), ..Default::default() }));
    assert_eq!(plan.atajos, 2);
    assert!(plan.equipo.is_some());
    assert_eq!((plan.reglas, plan.reglas_validas), (2, 1));
    assert_eq!((plan.permisos[0].espacio_index, plan.permisos[1].espacio_index), (0, -1));
    assert_eq!(plan.permisos[0].reglas.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["0.0", "0.1"]);
}

#[test]
fn build_plan_de_un_archivo_vacio_no_propone_nada() {
    let plan = build_plan(&parse(json!({})), &cuentas(), &[], &|_| true, &Value::Null);
    assert!(!plan.apariencia);
    assert_eq!(plan.apariencia_valores, None);
    assert_eq!(plan.atajos, 0);
    assert_eq!(plan.equipo, None);
    assert!(plan.espacios.is_empty());
    assert!(!build_plan(&parse(json!({ "apariencia": { "theme": "x" } })), &cuentas(), &[], &|_| true, &Value::Null).apariencia);
}

#[test]
fn el_plan_se_serializa_con_las_claves_del_ts() {
    let parsed = parse(json!({ "cuentas": [cuenta_a()], "espacios": [espacio_a()], "permisos": [{ "espacio": "api", "ruta": "C:\\repos\\api", "reglas": ["Bash(npm test)"] }] }));
    let v = serde_json::to_value(build_plan(&parsed, &cuentas(), &[], &|_| true, &Value::Null)).unwrap();
    for k in ["version", "cuentas", "espacios", "plantillas", "apariencia", "aparienciaValores", "atajos", "equipo", "permisos", "reglas", "reglasValidas"] {
        assert!(v.get(k).is_some(), "falta {k}");
    }
    assert!(v["aparienciaValores"].is_null() && v["equipo"].is_null());
    assert_eq!(v["permisos"][0]["espacioIndex"], 0);
    assert_eq!(v["permisos"][0]["reglas"][0]["draft"], json!({ "kind": "cmd", "tool": "Bash", "match": "npm test", "label": "npm test" }));
    assert_eq!(v["espacios"][0]["status"], "ok");
}

#[test]
fn templates_to_save_devuelve_solo_las_nuevas_con_la_cuenta_por_nombre_o_sugerida() {
    let parsed = parse(json!({
        "plantillas": [
            { "name": "a", "repoPath": "C:\\a", "cuenta": "Trabajo" },
            { "name": "b", "repoPath": "C:\\b", "cuenta": "Desconocida" },
            { "name": "c", "repoPath": "C:\\c" },
            { "name": "ya", "repoPath": "C:\\d" }
        ]
    }));
    let plan = build_plan(&parsed, &cuentas(), &[], &|_| true, &json!([{ "name": "ya" }]));
    let ids: HashMap<String, String> = [("trabajo".to_string(), "a1".to_string())].into();
    let out = templates_to_save(&parsed, &plan, &ids);
    assert_eq!(out.iter().map(|t| (t["name"].as_str().unwrap(), t["accountId"].as_str().unwrap())).collect::<Vec<_>>(), vec![("a", "a1"), ("b", "sugerida"), ("c", "sugerida")]);
    assert!(out.iter().all(|t| t.get("id").is_none() && t.get("namePattern").is_none()));
}

#[test]
fn export_spaces_no_lleva_ids_ni_config_dir_y_omite_espacios_sin_cuenta() {
    let espacios = [
        ws("w1", "api", "C:\\r\\api", "a1"),
        ws("w2", "huérfano", "C:\\r\\h", "borrada"),
        con(ws("w3", "web", "C:\\r\\w", "a1"), json!({ "color": "coral" })),
        con(ws("w4", "x", "C:\\r\\x", "a1"), json!({ "color": "rojo" })),
    ];
    let out = export_spaces(&espacios, &cuentas(), &|id| (id == "a1").then(|| "#3b82f6".to_string()));
    assert_eq!(out.iter().map(|e| e.nombre.as_str()).collect::<Vec<_>>(), vec!["api", "web", "x"]);
    assert_eq!(out[1].color_espacio.as_deref(), Some("coral"));
    assert_eq!(out[2].color_espacio, None);
    let json = serde_json::to_string(&out).unwrap();
    assert!(!json.contains("secreto") && !json.contains("w1") && !json.contains("a1"));
}

#[test]
fn export_templates_traduce_la_cuenta_a_su_nombre_y_deja_afuera_lo_invalido() {
    let out = export_templates(
        &json!({
            "templates": [
                { "id": "t1", "name": "a", "repoPath": "C:\\a", "accountId": "a1", "resume": false, "namePattern": "p", "useWorktree": { "branchPattern": "f/x" }, "initialPrompt": "/x" },
                { "name": "b", "repoPath": "C:\\b", "accountId": "sugerida" },
                { "name": 5, "repoPath": "C:\\c" },
                "x"
            ]
        }),
        &cuentas(),
    );
    assert_eq!(out.len(), 2);
    assert_eq!(out[0].cuenta.as_deref(), Some("Trabajo"));
    assert!(!out[0].resume);
    assert_eq!(out[1].cuenta, None);
    assert!(serde_json::to_value(&out[0]).unwrap().get("id").is_none());
    assert!(export_templates(&json!("basura"), &cuentas()).is_empty());
    assert!(export_templates(&Value::Null, &cuentas()).is_empty());
}

#[test]
fn export_templates_escribe_las_claves_en_el_orden_del_ts() {
    let out = export_templates(&json!([{ "name": "a", "repoPath": "C:\\a", "accountId": "a1", "namePattern": "p", "useWorktree": { "branchPattern": "f" }, "initialPrompt": "/x" }]), &cuentas());
    let claves: Vec<String> = serde_json::to_value(&out[0]).unwrap().as_object().unwrap().keys().cloned().collect();
    assert_eq!(claves, vec!["name", "repoPath", "autoStartClaude", "resume", "cuenta", "namePattern", "initialPrompt", "useWorktree"]);
}

#[test]
fn export_rules_incluye_solo_reglas_validas_y_activas_de_cada_espacio() {
    let w = [ws("w1", "api", "C:\\r\\api", "a1"), ws("w2", "vacío", "C:\\r\\v", "a1")];
    let out = export_rules(
        &[
            json!({ "workspaceId": "w1", "kind": "cmd", "tool": "Bash", "match": "npm test" }),
            json!({ "workspaceId": "w1", "kind": "cmd", "tool": "Bash", "match": "npm test", "on": false }),
            json!({ "workspaceId": "w1", "kind": "cmd", "tool": "Bash", "match": "rm *" }),
            json!({ "workspaceId": "otro", "kind": "edit", "tool": "Edit", "match": "*" }),
            Value::Null,
            json!("x"),
        ],
        &w,
    );
    assert_eq!(serde_json::to_value(out).unwrap(), json!([{ "espacio": "api", "ruta": "C:\\r\\api", "reglas": [{ "kind": "cmd", "tool": "Bash", "match": "npm test" }] }]));
}

#[test]
fn lo_exportado_se_vuelve_a_leer_igual_ida_y_vuelta_de_espacios_y_plantillas() {
    let espacios = export_spaces(&[ws("w1", "api", "C:\\r\\api", "a1")], &cuentas(), &|_| Some("#3b82f6".into()));
    let plantillas = export_templates(&json!([{ "name": "t", "repoPath": "C:\\t", "accountId": "a1" }]), &cuentas());
    let p = parse(json!({ "cuentas": [cuenta_a()], "espacios": espacios, "plantillas": plantillas }));
    assert_eq!(p.espacios[0].nombre, "api");
    assert_eq!(p.espacios[0].color.as_deref(), Some("#3b82f6"));
    assert_eq!(p.plantillas[0].cuenta.as_deref(), Some("Trabajo"));
}

#[test]
fn section_sizes_mide_cada_grupo_y_fmt_kb_lo_muestra() {
    let mut d = ExportDoc::nuevo("1", "x");
    d.atajos = Some(json!({ "palette": "Ctrl K" }).as_object().unwrap().clone());
    let s = section_sizes(&d);
    assert_eq!(s.plantillas, 0.0);
    assert!(s.atajos > 0.0);
    assert_eq!(s.espacios, 2.0 / 1024.0);
    assert_eq!(fmt_kb(0.0), "0 KB");
    assert_eq!(fmt_kb(0.3), "< 1 KB");
    assert_eq!(fmt_kb(10.4), "≈ 10 KB");
    assert_eq!(fmt_kb(10.5), "≈ 11 KB");
}

#[test]
fn el_nombre_del_perfil_en_el_archivo_no_cambia_lo_que_se_importa() {
    let extra = json!({ "cuentas": [cuenta_a()], "espacios": [espacio_a()], "atajos": { "palette": "Ctrl K" } });
    let sin = parse(extra.clone());
    assert_eq!(parse(con(extra.clone(), json!({ "perfil": "Trabajo" }))), sin);
    assert_eq!(parse(con(extra, json!({ "perfil": { "x": 1 } }))), sin);
}

#[test]
fn lo_exportado_lleva_solo_el_nombre_del_perfil_ni_ids_ni_usuario_de_github_ni_rutas_del_perfil() {
    let mut d = ExportDoc::nuevo("1", "x");
    d.perfil = Some("Trabajo".into());
    d.espacios = Some(export_spaces(&[ws("w1", "api", "C:\\repos\\api", "a1")], &[acc("a1", "Trabajo")], &|_| None));
    let json = serde_json::to_string(&d).unwrap();
    assert!(json.contains("\"perfil\":\"Trabajo\""));
    for prohibido in ["ghLogin", "p-", "perfiles", "principal", "secreto"] {
        assert!(!json.contains(prohibido), "{prohibido}");
    }
}

#[test]
fn el_documento_exportado_escribe_las_claves_en_el_orden_del_ts() {
    let mut d = ExportDoc::nuevo("0.8.0", "2026-01-02T03:04:05.000Z");
    d.perfil = Some("P".into());
    d.cuentas = Some(vec![]);
    d.espacios = Some(vec![]);
    d.permisos = Some(vec![]);
    d.plantillas = Some(vec![]);
    d.apariencia = Some(ExportedAppearance::default());
    d.atajos = Some(Map::new());
    d.equipo = Some(ExportedTeam { supabase_url: "https://a.supabase.co".into() });
    let claves: Vec<String> = serde_json::to_value(&d).unwrap().as_object().unwrap().keys().cloned().collect();
    assert_eq!(claves, vec!["formato", "formatoVersion", "versión", "exportado", "perfil", "cuentas", "espacios", "permisos", "plantillas", "apariencia", "atajos", "equipo"]);
}

#[test]
fn cuenta_exportada_conserva_codex_y_no_lleva_carpeta_ni_nada_de_login() {
    let e = cuenta_exportada(&con(acc("a1", "Trabajo"), json!({ "proveedor": "codex" })), None);
    assert_eq!(serde_json::to_value(&e).unwrap(), json!({ "label": "Trabajo", "shareSetup": true, "proveedor": "codex" }));
    assert!(!serde_json::to_string(&e).unwrap().contains("secreto"));
    assert_eq!(parse(json!({ "cuentas": [{ "label": "a", "proveedor": "codex" }] })).cuentas[0].proveedor.as_deref(), Some("codex"));
}

#[test]
fn share_setup_al_importar_una_cuenta_de_codex_no_activa_el_setup_compartido_aunque_el_archivo_lo_traiga() {
    assert!(!share_setup_al_importar(true, &json!({ "proveedor": "codex" })));
    assert!(share_setup_al_importar(true, &json!({})));
    assert!(share_setup_al_importar(true, &json!({ "proveedor": "claude" })));
    assert!(!share_setup_al_importar(false, &json!({})));
    assert!(share_setup_al_importar(true, &json!({ "proveedor": "agente-futuro" })));
}

#[test]
fn template_name_y_template_list_aceptan_las_formas_viejas() {
    assert_eq!(template_name(&json!({ "nombre": " x " })).as_deref(), Some("x"));
    assert_eq!(template_name(&json!({ "title": "t" })).as_deref(), Some("t"));
    assert_eq!(template_name(&json!({ "name": 5, "nombre": "x" })), None);
    assert_eq!(template_name(&json!({ "name": null, "nombre": "x" })).as_deref(), Some("x"));
    assert_eq!(template_name(&json!({ "name": "  " })), None);
    assert_eq!(template_list(&json!({ "plantillas": [1] })).map(Vec::len), Some(1));
    assert!(template_list(&json!("x")).is_none());
}

#[test]
fn cortar16_no_parte_un_par_sustituto() {
    assert_eq!(cortar16("ab😀c", 3), "ab");
    assert_eq!(cortar16("ab😀c", 4), "ab😀");
    assert_eq!(cortar16("abc", 10), "abc");
}
