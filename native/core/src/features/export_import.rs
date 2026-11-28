//! Lo puro de la función «export-import» (equivale a lo que no toca el store ni los diálogos en
//! src/main/features/export-import.ts): leer la selección y las elecciones que llegan por IPC, armar el documento que se
//! exporta y escribirlo (en claro o cifrado). NUNCA se exporta ni se importa un token, una credencial, una sesión ni la
//! service_role: solo la URL del proyecto de Supabase del equipo.
use super::export_crypto::{encrypt_text, Encrypted, MIN_PASSWORD};
use super::export_import_logic::{cuenta_exportada, export_rules, export_spaces, export_templates, fmt_kb, normalizar_url_supabase, section_sizes, ExportDoc, ExportedAppearance, ExportedTeam, Tamanos, FORMAT, FORMAT_VERSION};
use super::export_regla::trim_js;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Selection {
    pub espacios: Vec<String>,
    pub plantillas: bool,
    pub apariencia: bool,
    pub atajos: bool,
    pub equipo: bool,
    pub permisos: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportGroups {
    pub espacios: bool,
    pub plantillas: bool,
    pub apariencia: bool,
    pub atajos: bool,
    pub equipo: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Conflicto {
    Reemplazar,
    Dos,
    Saltear,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EleccionEspacio {
    pub conflicto: Option<Conflicto>,
    pub carpeta: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportChoices {
    pub grupos: ImportGroups,
    /// Por índice del espacio en el archivo: qué hacer si ya hay uno con ese nombre, y carpeta elegida si faltaba.
    pub espacios: HashMap<String, EleccionEspacio>,
}

fn bool_de(o: &Map<String, Value>, k: &str, def: bool) -> bool {
    o.get(k).and_then(Value::as_bool).unwrap_or(def)
}

/// Los argumentos de IPC no vienen validados: lo que no es del tipo esperado toma el valor por defecto.
pub fn parse_selection(raw: &Value) -> Selection {
    let vacio = Map::new();
    let o = raw.as_object().unwrap_or(&vacio);
    Selection {
        espacios: o.get("espacios").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).take(500).map(String::from).collect()).unwrap_or_default(),
        plantillas: bool_de(o, "plantillas", false),
        apariencia: bool_de(o, "apariencia", false),
        atajos: bool_de(o, "atajos", false),
        equipo: bool_de(o, "equipo", false),
        permisos: bool_de(o, "permisos", false),
    }
}

fn indice_valido(k: &str) -> bool {
    (1..=4).contains(&k.len()) && k.bytes().all(|b| b.is_ascii_digit())
}

pub fn parse_choices(raw: &Value) -> ImportChoices {
    let vacio = Map::new();
    let o = raw.as_object().unwrap_or(&vacio);
    let g = o.get("grupos").and_then(Value::as_object).unwrap_or(&vacio);
    let mut espacios = HashMap::new();
    if let Some(e) = o.get("espacios").and_then(Value::as_object) {
        for (k, v) in e {
            // En JavaScript un arreglo también es `typeof 'object'`: pasa, sin ninguna elección adentro.
            if !indice_valido(k) || !(v.is_object() || v.is_array()) {
                continue;
            }
            let c = v.as_object().unwrap_or(&vacio);
            let conflicto = match c.get("conflicto").and_then(Value::as_str) {
                Some("reemplazar") => Some(Conflicto::Reemplazar),
                Some("dos") => Some(Conflicto::Dos),
                Some("saltear") => Some(Conflicto::Saltear),
                _ => None,
            };
            let carpeta = c.get("carpeta").and_then(Value::as_str).map(trim_js).filter(|s| !s.is_empty()).map(String::from);
            if carpeta.as_ref().is_some_and(|c| c.encode_utf16().count() > 1024) {
                continue;
            }
            espacios.insert(k.clone(), EleccionEspacio { conflicto, carpeta });
        }
    }
    ImportChoices {
        grupos: ImportGroups {
            espacios: bool_de(g, "espacios", true),
            plantillas: bool_de(g, "plantillas", true),
            apariencia: bool_de(g, "apariencia", true),
            atajos: bool_de(g, "atajos", true),
            equipo: bool_de(g, "equipo", true),
        },
        espacios,
    }
}

/// Nombre libre: «X (copia)», «X (copia 2)»…
pub fn unique_name(base: &str, tomados: &HashSet<String>) -> String {
    let mut name = format!("{base} (copia)");
    let mut n = 2;
    while tomados.contains(&name.to_lowercase()) {
        name = format!("{base} (copia {n})");
        n += 1;
    }
    name
}

/// Lo que se lee de disco y del store para armar el documento. `ajustes` son los ajustes ya saneados (los de la
/// Configuración: `theme`, `density`, `uiFontSize`, `accent`, `lightMode`, `accountPlans`, `accountColors`, `shortcuts`).
pub struct EntradaDoc<'a> {
    pub version: &'a str,
    /// `new Date().toISOString()`.
    pub exportado: &'a str,
    pub perfil: &'a str,
    pub cuentas: &'a [Value],
    pub espacios: &'a [Value],
    pub plantillas: &'a Value,
    pub reglas: &'a [Value],
    pub equipo: Option<&'a str>,
    pub ajustes: &'a Map<String, Value>,
}

fn apariencia_de(a: &Map<String, Value>) -> ExportedAppearance {
    ExportedAppearance {
        theme: a.get("theme").and_then(Value::as_str).map(String::from),
        density: a.get("density").and_then(Value::as_str).map(String::from),
        ui_font_size: a.get("uiFontSize").and_then(Value::as_i64),
        accent: a.get("accent").and_then(Value::as_str).map(String::from),
        light_mode: a.get("lightMode").and_then(Value::as_bool),
    }
}

/// URL del proyecto de Supabase del equipo, sin la key, normalizada; None si no hay o no es válida.
pub fn equipo_de_chat(chat: &Value) -> Option<String> {
    let url = chat.get("config")?.get("supabaseUrl")?.as_str()?;
    normalizar_url_supabase(url).ok()
}

/// Lo que se exportaría con esa selección (sin escribir nada).
pub fn build_doc(sel: &Selection, e: &EntradaDoc) -> ExportDoc {
    let vacio = Map::new();
    let mut doc = ExportDoc::nuevo(e.version, e.exportado);
    doc.perfil = Some(e.perfil.to_string());
    let obj = |k: &str| e.ajustes.get(k).and_then(Value::as_object).unwrap_or(&vacio);
    let tiene_cuenta = |w: &Value| w.get("accountId").and_then(Value::as_str).is_some_and(|id| e.cuentas.iter().any(|a| a.get("id").and_then(Value::as_str) == Some(id)));
    let ws: Vec<Value> = e.espacios.iter().filter(|w| w.get("id").and_then(Value::as_str).is_some_and(|id| sel.espacios.iter().any(|s| s == id)) && tiene_cuenta(w)).cloned().collect();
    if !ws.is_empty() {
        let usadas: HashSet<&str> = ws.iter().filter_map(|w| w.get("accountId").and_then(Value::as_str)).collect();
        let planes = obj("accountPlans");
        let colores = obj("accountColors");
        doc.cuentas = Some(e.cuentas.iter().filter(|a| a.get("id").and_then(Value::as_str).is_some_and(|id| usadas.contains(id))).map(|a| cuenta_exportada(a, a.get("id").and_then(Value::as_str).and_then(|id| planes.get(id)).and_then(Value::as_str))).collect());
        doc.espacios = Some(export_spaces(&ws, e.cuentas, &|id| colores.get(id).and_then(Value::as_str).map(String::from)));
        if sel.permisos {
            let perms = export_rules(e.reglas, &ws);
            if !perms.is_empty() {
                doc.permisos = Some(perms);
            }
        }
    }
    if sel.plantillas {
        doc.plantillas = Some(export_templates(e.plantillas, e.cuentas));
    }
    if sel.apariencia {
        doc.apariencia = Some(apariencia_de(e.ajustes));
    }
    let atajos = obj("shortcuts");
    if sel.atajos && !atajos.is_empty() {
        doc.atajos = Some(atajos.clone());
    }
    if sel.equipo {
        if let Some(url) = e.equipo {
            doc.equipo = Some(ExportedTeam { supabase_url: url.into() });
        }
    }
    doc
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VistaPrevia {
    pub json: String,
    pub kb: Tamanos,
    pub total: f64,
    #[serde(rename = "totalTxt")]
    pub total_txt: String,
}

pub fn vista_previa(doc: &ExportDoc) -> VistaPrevia {
    let kb = section_sizes(doc);
    let total = kb.total();
    VistaPrevia { json: serde_json::to_string_pretty(doc).unwrap_or_default(), total_txt: fmt_kb(total), kb, total }
}

/// Las condiciones que pide `export` antes de abrir el diálogo de guardar.
pub fn validar_export(sel: &Selection, password: &Value) -> Result<Option<String>, String> {
    let pw = password.as_str().filter(|p| !p.is_empty()).map(String::from);
    if let Some(p) = &pw {
        if p.encode_utf16().count() < MIN_PASSWORD {
            return Err(format!("La contraseña tiene que tener al menos {MIN_PASSWORD} caracteres."));
        }
    }
    if sel.espacios.is_empty() && !(sel.plantillas || sel.apariencia || sel.atajos || sel.equipo || sel.permisos) {
        return Err("Marcá al menos un grupo para exportar.".into());
    }
    Ok(pw)
}

#[derive(Serialize)]
struct SobreCifrado<'a> {
    formato: &'a str,
    #[serde(rename = "formatoVersion")]
    formato_version: u32,
    #[serde(rename = "versión")]
    version: &'a str,
    exportado: &'a str,
    #[serde(flatten)]
    cifrado: &'a Encrypted,
}

/// El archivo que se escribe: el documento en claro, o el sobre con el documento cifrado. JSON con 2 espacios, como el TS.
pub fn texto_exportado_con(doc: &ExportDoc, cifrado: Option<&Encrypted>) -> String {
    let texto = match cifrado {
        Some(c) => serde_json::to_string_pretty(&SobreCifrado { formato: FORMAT, formato_version: FORMAT_VERSION, version: &doc.version, exportado: &doc.exportado, cifrado: c }),
        None => serde_json::to_string_pretty(doc),
    };
    texto.expect("el documento siempre se puede serializar")
}

pub fn texto_exportado(doc: &ExportDoc, password: Option<&str>) -> Result<String, String> {
    let cifrado = match password {
        Some(pw) => Some(encrypt_text(&serde_json::to_string(doc).map_err(|e| e.to_string())?, pw)?),
        None => None,
    };
    Ok(texto_exportado_con(doc, cifrado.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::export_crypto::{decrypt_text, encrypt_text_con};
    use crate::features::export_import_logic::{open_envelope, parse_import, read_envelope, Envelope};
    use serde_json::json;

    fn cuentas() -> Vec<Value> {
        vec![json!({ "id": "a1", "label": "Trabajo", "configDir": "C:\\secreto\\a1" }), json!({ "id": "a2", "label": "Casa", "proveedor": "codex" }), json!({ "id": "a3", "label": "Sin uso" })]
    }

    fn espacios() -> Vec<Value> {
        vec![
            json!({ "id": "w1", "name": "api", "repoPath": "C:\\r\\api", "accountId": "a1", "color": "lila" }),
            json!({ "id": "w2", "name": "web", "repoPath": "C:\\r\\web", "accountId": "a2" }),
            json!({ "id": "w3", "name": "huérfano", "repoPath": "C:\\r\\h", "accountId": "borrada" }),
        ]
    }

    fn ajustes() -> Map<String, Value> {
        json!({
            "theme": "noche", "density": "compacta", "uiFontSize": 14, "accent": "lila", "lightMode": false,
            "accountPlans": { "a1": "Max" }, "accountColors": { "a1": "#3b82f6" }, "shortcuts": { "palette": "Ctrl K" }
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn doc_de(sel: &Selection, equipo: Option<&str>) -> ExportDoc {
        let (c, w, p, r, a) = (cuentas(), espacios(), json!([{ "name": "t", "repoPath": "C:\\t", "accountId": "a1" }]), vec![json!({ "workspaceId": "w1", "kind": "cmd", "tool": "Bash", "match": "npm test" })], ajustes());
        build_doc(sel, &EntradaDoc { version: "0.8.0", exportado: "2026-01-02T03:04:05.000Z", perfil: "Trabajo", cuentas: &c, espacios: &w, plantillas: &p, reglas: &r, equipo, ajustes: &a })
    }

    fn todo() -> Selection {
        Selection { espacios: vec!["w1".into(), "w2".into(), "w3".into()], plantillas: true, apariencia: true, atajos: true, equipo: true, permisos: true }
    }

    #[test]
    fn parse_selection_toma_solo_lo_que_es_del_tipo_esperado() {
        let s = parse_selection(&json!({ "espacios": ["a", 5, "b", null], "plantillas": true, "apariencia": "sí", "atajos": 1, "equipo": true }));
        assert_eq!(s, Selection { espacios: vec!["a".into(), "b".into()], plantillas: true, apariencia: false, atajos: false, equipo: true, permisos: false });
        assert_eq!(parse_selection(&Value::Null), Selection::default());
        assert_eq!(parse_selection(&json!([1])), Selection::default());
        assert_eq!(parse_selection(&json!({ "espacios": "x" })).espacios, Vec::<String>::new());
    }

    #[test]
    fn parse_selection_se_queda_con_los_primeros_500_espacios() {
        let ids: Vec<Value> = (0..600).map(|i| json!(format!("w{i}"))).collect();
        let s = parse_selection(&json!({ "espacios": ids }));
        assert_eq!(s.espacios.len(), 500);
        assert_eq!(s.espacios[499], "w499");
    }

    #[test]
    fn parse_choices_tiene_todo_activado_por_defecto_y_filtra_las_elecciones_raras() {
        let c = parse_choices(&Value::Null);
        assert!(c.grupos.espacios && c.grupos.plantillas && c.grupos.apariencia && c.grupos.atajos && c.grupos.equipo);
        assert!(c.espacios.is_empty());
        let c = parse_choices(&json!({
            "grupos": { "atajos": false, "equipo": "no" },
            "espacios": {
                "0": { "conflicto": "reemplazar", "carpeta": "  C:\\nueva  " },
                "1": { "conflicto": "dos" },
                "2": { "conflicto": "borrar", "carpeta": "   " },
                "3": [],
                "4": 5,
                "x": { "conflicto": "dos" },
                "12345": { "conflicto": "dos" },
                "5": { "carpeta": "x".repeat(1025) },
                "6": { "conflicto": "saltear" }
            }
        }));
        assert!(!c.grupos.atajos && c.grupos.equipo);
        assert_eq!(c.espacios["0"], EleccionEspacio { conflicto: Some(Conflicto::Reemplazar), carpeta: Some("C:\\nueva".into()) });
        assert_eq!(c.espacios["1"].conflicto, Some(Conflicto::Dos));
        assert_eq!(c.espacios["2"], EleccionEspacio { conflicto: None, carpeta: None });
        assert_eq!(c.espacios["3"], EleccionEspacio { conflicto: None, carpeta: None });
        assert_eq!(c.espacios["6"].conflicto, Some(Conflicto::Saltear));
        let mut claves: Vec<_> = c.espacios.keys().cloned().collect();
        claves.sort();
        assert_eq!(claves, vec!["0", "1", "2", "3", "6"]);
    }

    #[test]
    fn unique_name_busca_el_primer_nombre_libre() {
        let mut tomados = HashSet::new();
        assert_eq!(unique_name("api", &tomados), "api (copia)");
        tomados.insert("api (copia)".to_string());
        assert_eq!(unique_name("api", &tomados), "api (copia 2)");
        tomados.insert("api (copia 2)".to_string());
        tomados.insert("api (copia 3)".to_string());
        assert_eq!(unique_name("api", &tomados), "api (copia 4)");
        assert_eq!(unique_name("API", &HashSet::from(["api (copia)".to_string()])), "API (copia 2)");
    }

    #[test]
    fn build_doc_con_todo_marcado_arma_cada_grupo_y_deja_afuera_lo_que_no_tiene_cuenta() {
        let d = doc_de(&todo(), Some("https://abc.supabase.co"));
        assert_eq!(d.perfil.as_deref(), Some("Trabajo"));
        let cuentas: Vec<_> = d.cuentas.as_ref().unwrap().iter().map(|c| c.label.as_str()).collect();
        assert_eq!(cuentas, vec!["Trabajo", "Casa"]);
        assert_eq!(d.cuentas.as_ref().unwrap()[0].plan.as_deref(), Some("Max"));
        assert_eq!(d.cuentas.as_ref().unwrap()[1].proveedor.as_deref(), Some("codex"));
        let espacios: Vec<_> = d.espacios.as_ref().unwrap().iter().map(|c| c.nombre.as_str()).collect();
        assert_eq!(espacios, vec!["api", "web"]);
        assert_eq!(d.espacios.as_ref().unwrap()[0].color.as_deref(), Some("#3b82f6"));
        assert_eq!(d.permisos.as_ref().unwrap()[0].reglas[0].match_, "npm test");
        assert_eq!(d.plantillas.as_ref().unwrap()[0].cuenta.as_deref(), Some("Trabajo"));
        assert_eq!(d.apariencia.as_ref().unwrap().ui_font_size, Some(14));
        assert_eq!(d.apariencia.as_ref().unwrap().light_mode, Some(false));
        assert_eq!(d.atajos.as_ref().unwrap()["palette"], "Ctrl K");
        assert_eq!(d.equipo.as_ref().unwrap().supabase_url, "https://abc.supabase.co");
    }

    #[test]
    fn build_doc_sin_nada_marcado_solo_lleva_el_encabezado_y_el_perfil() {
        let d = doc_de(&Selection::default(), Some("https://abc.supabase.co"));
        assert_eq!(serde_json::to_value(&d).unwrap(), json!({ "formato": "sloth-config", "formatoVersion": 2, "versión": "0.8.0", "exportado": "2026-01-02T03:04:05.000Z", "perfil": "Trabajo" }));
    }

    #[test]
    fn build_doc_no_exporta_el_equipo_sin_url_ni_atajos_vacios_ni_permisos_sin_espacios() {
        let sel = Selection { equipo: true, atajos: true, permisos: true, plantillas: true, ..Default::default() };
        let d = doc_de(&sel, None);
        assert!(d.equipo.is_none() && d.permisos.is_none() && d.cuentas.is_none());
        assert_eq!(d.plantillas.as_ref().map(Vec::len), Some(1));
        let (c, w, a) = (cuentas(), espacios(), json!({ "shortcuts": {} }).as_object().unwrap().clone());
        let sin_atajos = build_doc(&sel, &EntradaDoc { version: "1", exportado: "x", perfil: "p", cuentas: &c, espacios: &w, plantillas: &Value::Null, reglas: &[], equipo: None, ajustes: &a });
        assert!(sin_atajos.atajos.is_none());
        assert_eq!(sin_atajos.plantillas, Some(vec![]));
    }

    #[test]
    fn build_doc_nunca_lleva_ids_ni_config_dir_ni_credenciales() {
        let json = serde_json::to_string(&doc_de(&todo(), Some("https://abc.supabase.co"))).unwrap();
        for prohibido in ["secreto", "configDir", "\"w1\"", "\"a1\"", "token", "anon", "service_role"] {
            assert!(!json.contains(prohibido), "{prohibido}");
        }
    }

    #[test]
    fn lo_que_se_exporta_se_vuelve_a_importar() {
        let d = doc_de(&todo(), Some("https://abc.supabase.co"));
        let p = parse_import(&texto_exportado(&d, None).unwrap()).unwrap();
        assert_eq!(p.cuentas.len(), 2);
        assert_eq!(p.espacios.iter().map(|e| e.nombre.as_str()).collect::<Vec<_>>(), vec!["api", "web"]);
        assert_eq!(p.espacios[0].color_espacio.as_deref(), Some("lila"));
        assert_eq!(p.plantillas.len(), 1);
        assert_eq!(p.permisos[0].reglas.iter().filter(|r| r.valida).count(), 1);
        assert_eq!(p.equipo.as_deref(), Some("https://abc.supabase.co"));
        assert_eq!(p.atajos.unwrap(), vec![("palette".to_string(), "Ctrl K".to_string())]);
        assert_eq!(p.apariencia.unwrap().theme.as_deref(), Some("noche"));
    }

    #[test]
    fn el_archivo_en_claro_es_json_con_2_espacios_como_el_ts() {
        let d = doc_de(&Selection::default(), None);
        assert_eq!(texto_exportado(&d, None).unwrap(), "{\n  \"formato\": \"sloth-config\",\n  \"formatoVersion\": 2,\n  \"versión\": \"0.8.0\",\n  \"exportado\": \"2026-01-02T03:04:05.000Z\",\n  \"perfil\": \"Trabajo\"\n}");
    }

    #[test]
    fn el_archivo_cifrado_lleva_el_encabezado_en_claro_y_el_cifrado_en_el_orden_del_ts() {
        let d = doc_de(&todo(), None);
        let texto = texto_exportado(&d, Some("contraseña-larga")).unwrap();
        let v: Value = serde_json::from_str(&texto).unwrap();
        let claves: Vec<&String> = v.as_object().unwrap().keys().collect();
        assert_eq!(claves, vec!["formato", "formatoVersion", "versión", "exportado", "cifrado", "datos"]);
        assert!(!texto.contains("api") && !texto.contains("Trabajo"));
        let Envelope::Cifrado { cifrado, datos, version } = read_envelope(&texto).unwrap() else { panic!("se esperaba un archivo cifrado") };
        assert_eq!(version, "0.8.0");
        let interior = open_envelope(&cifrado, &datos, "contraseña-larga").unwrap();
        assert_eq!(interior, serde_json::to_string(&d).unwrap());
        assert_eq!(parse_import(&interior).unwrap().espacios.len(), 2);
    }

    #[test]
    fn con_la_sal_y_el_iv_fijos_el_archivo_cifrado_sale_igual_que_el_de_node() {
        // En Windows, git puede dejar el fixture con CRLF.
        let archivo = include_str!("../../fixtures/export/default.sloth").replace("\r\n", "\n");
        let plano = include_str!("../../fixtures/export/default.plano.json");
        let v: Value = serde_json::from_str(&archivo).unwrap();
        let dec = |k: &str| {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.decode(v["cifrado"][k].as_str().unwrap()).unwrap()
        };
        let enc = encrypt_text_con(plano, "contraseña-larga", &dec("sal").try_into().unwrap(), &dec("iv").try_into().unwrap());
        let mut doc = ExportDoc::nuevo("0.8.0", "2026-01-02T03:04:05.000Z");
        doc.perfil = None;
        assert_eq!(texto_exportado_con(&doc, Some(&enc)), archivo);
    }

    #[test]
    fn validar_export_pide_contrasena_larga_y_algun_grupo() {
        let con_grupo = Selection { plantillas: true, ..Default::default() };
        assert_eq!(validar_export(&con_grupo, &Value::Null), Ok(None));
        assert_eq!(validar_export(&con_grupo, &json!("")), Ok(None));
        assert_eq!(validar_export(&con_grupo, &json!(5)), Ok(None));
        assert_eq!(validar_export(&con_grupo, &json!("12345678")), Ok(Some("12345678".into())));
        assert_eq!(validar_export(&con_grupo, &json!("1234567")).unwrap_err(), "La contraseña tiene que tener al menos 8 caracteres.");
        assert_eq!(validar_export(&Selection::default(), &Value::Null).unwrap_err(), "Marcá al menos un grupo para exportar.");
        assert!(validar_export(&Selection { espacios: vec!["w1".into()], ..Default::default() }, &Value::Null).is_ok());
        assert_eq!(validar_export(&Selection::default(), &json!("corta")).unwrap_err(), "La contraseña tiene que tener al menos 8 caracteres.");
    }

    #[test]
    fn la_vista_previa_mide_cada_grupo_y_arma_el_json() {
        let v = vista_previa(&doc_de(&todo(), Some("https://abc.supabase.co")));
        assert!(v.json.starts_with("{\n  \"formato\""));
        assert!(v.kb.espacios > 0.0 && v.kb.plantillas > 0.0 && v.kb.equipo > 0.0 && v.kb.permisos > 0.0);
        assert_eq!(v.total, v.kb.total());
        assert_eq!(v.total_txt, fmt_kb(v.total));
        let json = serde_json::to_value(&v).unwrap();
        assert!(json.get("totalTxt").is_some() && json["kb"].get("permisos").is_some());
    }

    #[test]
    fn la_url_del_equipo_sale_del_chat_normalizada_o_no_sale() {
        assert_eq!(equipo_de_chat(&json!({ "config": { "supabaseUrl": "https://ABC.supabase.co/" } })).as_deref(), Some("https://abc.supabase.co"));
        for c in [json!({}), json!({ "config": {} }), json!({ "config": { "supabaseUrl": 5 } }), json!({ "config": { "supabaseUrl": "http://x.co" } }), Value::Null] {
            assert_eq!(equipo_de_chat(&c), None, "{c}");
        }
    }

    #[test]
    fn un_archivo_de_node_con_contrasena_se_abre_y_se_vuelve_a_cifrar_igual_de_valido() {
        let archivo = include_str!("../../fixtures/export/params.sloth");
        let Envelope::Cifrado { cifrado, datos, .. } = read_envelope(archivo).unwrap() else { panic!("se esperaba un archivo cifrado") };
        let interior = open_envelope(&cifrado, &datos, "clave ñandú ✓ 12345").unwrap();
        let nuevo = encrypt_text(&interior, "otra clave larga").unwrap();
        let v = serde_json::to_value(&nuevo).unwrap();
        assert_eq!(decrypt_text(&v["cifrado"], &v["datos"], "otra clave larga").unwrap(), interior);
    }
}
