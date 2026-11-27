//! Validación y decisiones de carga de sloth-state.json. Equivale a src/main/store-core.ts.
//! Cuentas y espacios son objetos JSON tal cual (con sus campos desconocidos y su orden): si el archivo viene de una
//! versión más nueva de Sloth, nada de lo que esta no conoce se pierde al guardar.
use crate::versionado::{migrar, EstadoVersion, Migraciones, Objeto};
use serde_json::Value;
use std::collections::HashSet;

pub const VERSION_ESTADO: u32 = 1;

pub struct EstadoValidado {
    /// La raíz completa del archivo: `version`, `accounts`, `workspaces`, `openPanes` y lo que traiga de más.
    pub estado: Objeto,
    /// Dañadas más repetidas.
    pub cuentas_descartadas: usize,
    pub espacios_descartados: usize,
    pub cuentas_repetidas: usize,
    pub espacios_repetidos: usize,
    /// El archivo lo escribió una versión de Sloth más nueva (puede traer campos que esta no conoce).
    pub version_futura: bool,
    /// Venía sin `version` o de una versión vieja: hay que reescribirlo con la actual (con respaldo).
    pub migrado: bool,
}

pub fn estado_vacio() -> EstadoValidado {
    let mut estado = Objeto::new();
    estado.insert("version".into(), Value::from(VERSION_ESTADO));
    estado.insert("accounts".into(), Value::Array(vec![]));
    estado.insert("workspaces".into(), Value::Array(vec![]));
    estado.insert("openPanes".into(), Value::Array(vec![]));
    EstadoValidado { estado, cuentas_descartadas: 0, espacios_descartados: 0, cuentas_repetidas: 0, espacios_repetidos: 0, version_futura: false, migrado: false }
}

fn texto(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| !s.trim().is_empty())
}

fn es_numero(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Number(_)))
}

fn sacar_si_no_es(o: &mut Objeto, campos: &[&str], booleano: bool) {
    for c in campos {
        let mal = o.get(*c).map(|v| if booleano { !v.is_boolean() } else { !v.is_string() }).unwrap_or(false);
        if mal {
            o.shift_remove(*c);
        }
    }
}

/// Se conservan los campos desconocidos: si el archivo viene de una versión más nueva, no se pierden al guardar.
pub fn validar_cuenta(v: &Value) -> Option<Objeto> {
    let obj = v.as_object()?;
    let id = texto(obj.get("id"))?.to_owned();
    texto(obj.get("configDir"))?;
    let mut o = obj.clone();
    if !o.get("label").is_some_and(Value::is_string) {
        o.insert("label".into(), Value::String(id));
    }
    if !es_numero(o.get("createdAt")) {
        o.insert("createdAt".into(), Value::from(0));
    }
    sacar_si_no_es(&mut o, &["shareSetup", "limitesExperimentales", "avisoDeTurno"], true);
    sacar_si_no_es(&mut o, &["proveedor"], false);
    Some(o)
}

pub fn validar_espacio(v: &Value) -> Option<Objeto> {
    let obj = v.as_object()?;
    let id = texto(obj.get("id"))?.to_owned();
    let repo = texto(obj.get("repoPath"))?.to_owned();
    texto(obj.get("accountId"))?;
    let mut o = obj.clone();
    if texto(o.get("cwd")).is_none() {
        o.insert("cwd".into(), Value::String(repo));
    }
    if !o.get("name").is_some_and(Value::is_string) {
        o.insert("name".into(), Value::String(id));
    }
    if !o.get("autoStartClaude").is_some_and(Value::is_boolean) {
        o.insert("autoStartClaude".into(), Value::Bool(true));
    }
    if !es_numero(o.get("createdAt")) {
        o.insert("createdAt".into(), Value::from(0));
    }
    sacar_si_no_es(&mut o, &["branch", "initialPrompt", "ticket", "icon", "color"], false);
    sacar_si_no_es(&mut o, &["initialPromptUsed", "resume"], true);
    Some(o)
}

fn filtrar(lista: Option<&Value>, validar: fn(&Value) -> Option<Objeto>) -> (Vec<Value>, usize, usize) {
    let Some(lista) = lista.and_then(Value::as_array) else { return (vec![], 0, 0) };
    let mut ok = Vec::new();
    let mut ids: HashSet<String> = HashSet::new();
    let mut repetidos = 0;
    for v in lista {
        if let Some(x) = validar(v) {
            let id = x.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
            if ids.contains(&id) {
                repetidos += 1;
            } else {
                ids.insert(id);
                ok.push(Value::Object(x));
            }
        }
    }
    (ok.clone(), lista.len() - ok.len(), repetidos)
}

/// Devuelve None si la raíz no es un objeto o su `version` no se entiende (el archivo entero no sirve).
pub fn validar_estado(raw: &Value) -> Option<EstadoValidado> {
    let r = migrar(raw, &Migraciones::new(), VERSION_ESTADO);
    if r.estado == EstadoVersion::Invalida {
        return None;
    }
    let datos = r.datos.as_object()?;
    let (cuentas, cd, cr) = filtrar(datos.get("accounts"), validar_cuenta);
    let (espacios, ed, er) = filtrar(datos.get("workspaces"), validar_espacio);
    let open_panes: Vec<Value> = datos
        .get("openPanes")
        .and_then(Value::as_array)
        .map(|l| l.iter().filter(|p| p.is_string()).cloned().collect())
        .unwrap_or_default();
    let mut estado = datos.clone();
    estado.insert("version".into(), Value::from(VERSION_ESTADO));
    estado.insert("accounts".into(), Value::Array(cuentas));
    estado.insert("workspaces".into(), Value::Array(espacios));
    estado.insert("openPanes".into(), Value::Array(open_panes));
    Some(EstadoValidado {
        estado,
        cuentas_descartadas: cd,
        espacios_descartados: ed,
        cuentas_repetidas: cr,
        espacios_repetidos: er,
        version_futura: r.estado == EstadoVersion::Futura,
        migrado: r.estado == EstadoVersion::Migrado,
    })
}

/// Las cuentas guardan rutas absolutas: si venían de %APPDATA%\AntiRea, apuntarlas a la carpeta nueva.
pub fn corregir_rutas_viejas(cuentas: &mut [Value], vieja_raiz: &str, nueva_raiz: &str) -> bool {
    let mut cambio = false;
    let prefijo = format!("{}\\", vieja_raiz.to_lowercase());
    for acc in cuentas {
        let Some(dir) = acc.get("configDir").and_then(Value::as_str) else { continue };
        if dir.to_lowercase().starts_with(&prefijo) {
            // JS corta por unidades UTF-16; los nombres de ruta de ahí son del largo de la raíz vieja en caracteres.
            let resto: String = dir.chars().skip(vieja_raiz.chars().count()).collect();
            acc["configDir"] = Value::String(format!("{nueva_raiz}{resto}"));
            cambio = true;
        }
    }
    cambio
}

pub struct LecturaEstado {
    pub v: EstadoValidado,
    /// Ruta del archivo roto que se apartó (arranca vacío).
    pub apartado: Option<String>,
    /// No se pudo leer ni apartar: puede estar sano.
    pub solo_lectura: bool,
    pub motivo: Option<String>,
}

pub type AvisoCarga = Box<dyn Fn(Option<&str>) -> String + Send + Sync>;

pub struct DecisionCarga {
    /// No escribir sobre el archivo en esta sesión.
    pub solo_lectura: bool,
    pub respaldar: bool,
    pub guardar: bool,
    /// Cuentas y espacios cargaron enteros: recién ahí otras funciones pueden podar lo suyo según el store.
    pub confiable: bool,
    /// Recibe la ruta del respaldo, o None si no se pudo respaldar.
    pub aviso: Option<AvisoCarga>,
}

fn plural(n: usize, uno: &str, varios: &str) -> String {
    format!("{n} {}", if n == 1 { uno } else { varios })
}

fn describir_descartes(v: &EstadoValidado) -> String {
    let mut partes = Vec::new();
    let cuentas_danadas = v.cuentas_descartadas - v.cuentas_repetidas;
    let espacios_danados = v.espacios_descartados - v.espacios_repetidos;
    if cuentas_danadas > 0 {
        partes.push(plural(cuentas_danadas, "cuenta dañada", "cuentas dañadas"));
    }
    if v.cuentas_repetidas > 0 {
        partes.push(plural(v.cuentas_repetidas, "cuenta repetida", "cuentas repetidas"));
    }
    if espacios_danados > 0 {
        partes.push(plural(espacios_danados, "espacio dañado", "espacios dañados"));
    }
    if v.espacios_repetidos > 0 {
        partes.push(plural(v.espacios_repetidos, "espacio repetido", "espacios repetidos"));
    }
    partes.join(", ")
}

pub fn texto_respaldo(respaldo: Option<&str>) -> String {
    match respaldo {
        Some(r) => format!("guardé el original como {r}"),
        None => "no pude respaldarlo, así que no voy a guardar cambios hasta que se pueda (reiniciá Sloth para reintentar)".into(),
    }
}

/// Qué hacer con sloth-state.json según cómo se leyó: respaldar, reescribir, quedar en solo lectura y qué avisar.
pub fn decidir_carga(l: &LecturaEstado, rutas_corregidas: bool) -> DecisionCarga {
    if l.solo_lectura {
        let motivo = l.motivo.clone().unwrap_or_else(|| "no se pudo leer".into());
        return DecisionCarga {
            solo_lectura: true,
            respaldar: false,
            guardar: false,
            confiable: false,
            aviso: Some(Box::new(move |_| {
                format!("sloth-state.json {motivo}. Arranqué sin cuentas ni espacios y no voy a guardar cambios hasta que reinicies Sloth; el archivo quedó como estaba.")
            })),
        };
    }
    if let Some(apartado) = &l.apartado {
        let apartado = apartado.clone();
        return DecisionCarga {
            solo_lectura: false,
            respaldar: false,
            guardar: false,
            confiable: false,
            aviso: Some(Box::new(move |_| format!("sloth-state.json estaba dañado: lo guardé como {apartado} y arranqué sin cuentas ni espacios."))),
        };
    }
    let v = &l.v;
    let descartes = v.cuentas_descartadas + v.espacios_descartados;
    if v.version_futura {
        return DecisionCarga {
            solo_lectura: true,
            respaldar: true,
            guardar: false,
            confiable: false,
            aviso: Some(Box::new(|bak| {
                format!(
                    "sloth-state.json lo guardó una versión más nueva de Sloth ({}). Lo abrí en solo lectura: no voy a guardar cambios para no pisarlo. Actualizá Sloth para seguir.",
                    texto_respaldo(bak)
                )
            })),
        };
    }
    if descartes == 0 && !rutas_corregidas && !v.migrado {
        return DecisionCarga { solo_lectura: false, respaldar: false, guardar: false, confiable: true, aviso: None };
    }
    let descripcion = describir_descartes(v);
    DecisionCarga {
        solo_lectura: false,
        respaldar: true,
        guardar: true,
        confiable: descartes == 0,
        aviso: (descartes > 0).then(|| -> AvisoCarga { Box::new(move |bak| format!("sloth-state.json tenía {descripcion}. Los saqué y {}.", texto_respaldo(bak))) }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cuenta() -> Value {
        json!({ "id": "a1", "label": "A", "configDir": "C:\\datos\\accounts\\a1", "createdAt": 1 })
    }
    fn espacio() -> Value {
        json!({ "id": "w1", "name": "Uno", "repoPath": "C:\\repo", "cwd": "C:\\repo", "accountId": "a1", "autoStartClaude": true, "createdAt": 2 })
    }
    fn con(base: Value, campo: &str, valor: Value) -> Value {
        let mut b = base;
        b[campo] = valor;
        b
    }
    fn lista(v: &EstadoValidado, k: &str) -> Value {
        v.estado[k].clone()
    }
    fn leido(raw: Value) -> EstadoValidado {
        validar_estado(&raw).expect("se entiende")
    }
    fn lectura(v: EstadoValidado) -> LecturaEstado {
        LecturaEstado { v, apartado: None, solo_lectura: false, motivo: None }
    }

    #[test]
    fn una_cuenta_nula_se_descarta_y_el_resto_se_carga() {
        let v = leido(json!({ "version": 1, "accounts": [null, cuenta()], "workspaces": [], "openPanes": [] }));
        assert_eq!(lista(&v, "accounts"), json!([cuenta()]));
        assert_eq!(v.cuentas_descartadas, 1);
        assert!(!v.version_futura);
    }

    #[test]
    fn una_cuenta_sin_config_dir_se_descarta() {
        let v = leido(json!({ "version": 1, "accounts": [{ "id": "a1", "label": "A" }], "workspaces": [], "openPanes": [] }));
        assert_eq!(lista(&v, "accounts"), json!([]));
        assert_eq!(v.cuentas_descartadas, 1);
        let mut vacias: Vec<Value> = vec![];
        corregir_rutas_viejas(&mut vacias, "C:\\AppData\\AntiRea", "C:\\AppData\\Sloth");
    }

    #[test]
    fn espacios_nulos_o_sin_repo_path_se_descartan_y_quedan_los_buenos() {
        let v = leido(json!({ "version": 1, "accounts": [cuenta()], "workspaces": [null, { "id": "x" }, espacio()], "openPanes": ["w1", "x", 3] }));
        assert_eq!(lista(&v, "workspaces"), json!([espacio()]));
        assert_eq!(v.espacios_descartados, 2);
        assert_eq!(lista(&v, "openPanes"), json!(["w1", "x"]));
    }

    #[test]
    fn campos_obligatorios_de_tipo_raro_descartan_la_entrada() {
        assert!(validar_cuenta(&con(cuenta(), "id", json!(5))).is_none());
        assert!(validar_cuenta(&con(cuenta(), "configDir", json!(""))).is_none());
        assert!(validar_cuenta(&json!("a1")).is_none());
        assert!(validar_espacio(&con(espacio(), "repoPath", json!(["C:\\repo"]))).is_none());
        assert!(validar_espacio(&con(espacio(), "accountId", json!(null))).is_none());
        assert!(validar_espacio(&json!([espacio()])).is_none());
    }

    #[test]
    fn campos_opcionales_de_tipo_raro_se_sacan_y_los_que_faltan_toman_su_valor() {
        let c = validar_cuenta(&json!({ "id": "a1", "configDir": "C:\\x", "shareSetup": "sí", "createdAt": "ayer" })).unwrap();
        assert_eq!(Value::Object(c), json!({ "id": "a1", "configDir": "C:\\x", "createdAt": 0, "label": "a1" }));
        let w = validar_espacio(&json!({ "id": "w1", "repoPath": "C:\\repo", "accountId": "a1", "icon": 7, "resume": "true", "branch": "main", "autoStartClaude": "no" })).unwrap();
        assert_eq!(
            Value::Object(w),
            json!({ "id": "w1", "repoPath": "C:\\repo", "accountId": "a1", "branch": "main", "autoStartClaude": true, "cwd": "C:\\repo", "name": "w1", "createdAt": 0 })
        );
    }

    #[test]
    fn limites_experimentales_aviso_de_turno_y_proveedor() {
        let con_campo = |k: &str, v: Value| validar_cuenta(&con(cuenta(), k, v)).unwrap();
        assert_eq!(con_campo("limitesExperimentales", json!(true))["limitesExperimentales"], json!(true));
        assert_eq!(con_campo("limitesExperimentales", json!(false))["limitesExperimentales"], json!(false));
        assert!(!con_campo("limitesExperimentales", json!("si")).contains_key("limitesExperimentales"));
        assert!(!con_campo("avisoDeTurno", json!(1)).contains_key("avisoDeTurno"));
        assert!(!validar_cuenta(&cuenta()).unwrap().contains_key("proveedor"));
        assert!(!con_campo("proveedor", json!(5)).contains_key("proveedor"));
        assert_eq!(con_campo("proveedor", json!("codex"))["proveedor"], json!("codex"));
        assert_eq!(Value::Object(validar_cuenta(&cuenta()).unwrap()), cuenta());
    }

    #[test]
    fn se_conservan_los_campos_que_esta_version_no_conoce() {
        let v = leido(json!({ "version": 1, "accounts": [con(cuenta(), "futuro", json!({ "x": 1 }))], "workspaces": [], "openPanes": [] }));
        assert_eq!(lista(&v, "accounts")[0], con(cuenta(), "futuro", json!({ "x": 1 })));
    }

    #[test]
    fn ids_repetidos_queda_el_primero() {
        let v = leido(json!({ "accounts": [cuenta(), con(cuenta(), "label", json!("B"))], "workspaces": [espacio(), espacio()] }));
        assert_eq!(lista(&v, "accounts").as_array().unwrap().len(), 1);
        assert_eq!(lista(&v, "accounts")[0]["label"], json!("A"));
        assert_eq!((v.cuentas_descartadas, v.espacios_descartados, v.cuentas_repetidas, v.espacios_repetidos), (1, 1, 1, 1));
    }

    #[test]
    fn version_futura_se_marca_la_conocida_o_ausente_no() {
        assert!(leido(json!({ "version": 2, "accounts": [cuenta()] })).version_futura);
        assert!(!leido(json!({ "version": 1 })).version_futura);
        assert!(!leido(json!({})).version_futura);
    }

    #[test]
    fn listas_ausentes_quedan_vacias_sin_contar_descartes_y_la_raiz_que_no_es_objeto_no_sirve() {
        let v = leido(json!({ "accounts": "x", "workspaces": {} }));
        assert_eq!(Value::Object(v.estado.clone()), json!({ "accounts": [], "workspaces": [], "version": 1, "openPanes": [] }));
        assert_eq!((v.cuentas_descartadas, v.espacios_descartados, v.cuentas_repetidas, v.espacios_repetidos), (0, 0, 0, 0));
        assert!(!v.version_futura && v.migrado);
        assert!(validar_estado(&json!(null)).is_none());
        assert!(validar_estado(&json!([])).is_none());
    }

    #[test]
    fn corregir_rutas_viejas_mueve_solo_las_cuentas_que_vivian_en_antirea() {
        let mut accs = vec![
            con(cuenta(), "configDir", json!("C:\\AppData\\antirea\\accounts\\a1")),
            con(con(cuenta(), "id", json!("a2")), "configDir", json!("C:\\AppData\\Sloth\\accounts\\a2")),
        ];
        assert!(corregir_rutas_viejas(&mut accs, "C:\\AppData\\AntiRea", "C:\\AppData\\Sloth"));
        let dirs: Vec<&str> = accs.iter().map(|a| a["configDir"].as_str().unwrap()).collect();
        assert_eq!(dirs, ["C:\\AppData\\Sloth\\accounts\\a1", "C:\\AppData\\Sloth\\accounts\\a2"]);
        assert!(!corregir_rutas_viejas(&mut accs, "C:\\AppData\\AntiRea", "C:\\AppData\\Sloth"));
    }

    #[test]
    fn archivo_sano_no_respalda_no_guarda_y_es_confiable() {
        let d = decidir_carga(&lectura(leido(json!({ "version": 1, "accounts": [cuenta()], "workspaces": [espacio()] }))), false);
        assert_eq!((d.solo_lectura, d.respaldar, d.guardar, d.confiable), (false, false, false, true));
        assert!(d.aviso.is_none());
    }

    #[test]
    fn no_se_pudo_leer_solo_lectura_sin_guardar_ni_respaldar() {
        let l = LecturaEstado { v: estado_vacio(), apartado: None, solo_lectura: true, motivo: Some("no se pudo leer (EBUSY)".into()) };
        let d = decidir_carga(&l, false);
        assert_eq!((d.solo_lectura, d.respaldar, d.guardar, d.confiable), (true, false, false, false));
        let t = (d.aviso.unwrap())(None);
        assert!(t.starts_with("sloth-state.json no se pudo leer (EBUSY). Arranqué sin cuentas") && t.contains("no voy a guardar"));
    }

    #[test]
    fn archivo_roto_y_apartado_arranca_vacio_y_no_es_confiable() {
        let l = LecturaEstado { v: estado_vacio(), apartado: Some("sloth-state.json.corrupt-1".into()), solo_lectura: false, motivo: None };
        let d = decidir_carga(&l, false);
        assert_eq!((d.solo_lectura, d.guardar, d.confiable), (false, false, false));
        assert!((d.aviso.unwrap())(None).contains("corrupt-1"));
    }

    #[test]
    fn con_descartes_respalda_y_guarda_pero_no_es_confiable() {
        let d = decidir_carga(&lectura(leido(json!({ "accounts": [cuenta(), cuenta(), null], "workspaces": [{ "id": "x" }] }))), false);
        assert_eq!((d.respaldar, d.guardar, d.confiable), (true, true, false));
        let aviso = d.aviso.unwrap();
        let t = aviso(Some("sloth-state.json.bak-9"));
        assert!(t.contains("1 cuenta dañada, 1 cuenta repetida, 1 espacio dañado"), "{t}");
        assert!(t.contains("sloth-state.json.bak-9"));
        assert!(aviso(None).contains("no pude respaldarlo") && aviso(None).contains("hasta que se pueda"));
    }

    #[test]
    fn solo_rutas_corregidas_respalda_y_guarda_en_silencio_y_sigue_confiable() {
        let d = decidir_carga(&lectura(leido(json!({ "accounts": [cuenta()] }))), true);
        assert_eq!((d.respaldar, d.guardar, d.confiable), (true, true, true));
        assert!(d.aviso.is_none());
    }

    #[test]
    fn version_futura_respalda_queda_en_solo_lectura_y_no_guarda() {
        let d = decidir_carga(&lectura(leido(json!({ "version": 2, "accounts": [cuenta()] }))), false);
        assert_eq!((d.solo_lectura, d.respaldar, d.guardar, d.confiable), (true, true, false, false));
        let t = (d.aviso.unwrap())(Some("bak"));
        assert!(t.contains("versión más nueva") && t.contains("guardé el original como bak") && t.contains("solo lectura") && t.contains("no voy a guardar"));
        let d2 = decidir_carga(&lectura(leido(json!({ "version": 9, "accounts": [cuenta(), null] }))), true);
        assert_eq!((d2.solo_lectura, d2.guardar), (true, false));
    }

    #[test]
    fn sin_version_se_migra_respalda_y_guarda_en_silencio() {
        let d = decidir_carga(&lectura(leido(json!({ "accounts": [cuenta()], "workspaces": [espacio()] }))), false);
        assert_eq!((d.solo_lectura, d.respaldar, d.guardar, d.confiable), (false, true, true, true));
        assert!(d.aviso.is_none());
    }

    // El mismo archivo que usa el test del TypeScript: las dos implementaciones tienen que leerlo igual.
    const FIXTURE_V1: &str = include_str!("../../../src/main/fixtures/sloth-state-v1.json");

    #[test]
    fn fixture_v1_con_version_explicita_se_lee_idéntico_al_archivo() {
        let crudo: Value = serde_json::from_str(FIXTURE_V1).unwrap();
        let v = leido(crudo.clone());
        assert_eq!(v.estado["version"], json!(1));
        assert!(!v.migrado && !v.version_futura);
        assert_eq!(v.cuentas_descartadas + v.espacios_descartados, 0);
        assert_eq!(Value::Object(v.estado.clone()), crudo);
        let d = decidir_carga(&lectura(v), false);
        assert_eq!((d.respaldar, d.guardar, d.confiable), (false, false, true));
    }

    #[test]
    fn fixture_v1_sin_version_se_lee_sin_perdida_y_queda_migrado() {
        let mut crudo: Value = serde_json::from_str(FIXTURE_V1).unwrap();
        crudo.as_object_mut().unwrap().shift_remove("version");
        let v = leido(crudo);
        assert!(v.migrado);
        assert_eq!(v.cuentas_descartadas + v.espacios_descartados, 0);
        let original: Value = serde_json::from_str(FIXTURE_V1).unwrap();
        assert_eq!(Value::Object(v.estado.clone()), original);
        let mut claves: Vec<&str> = v.estado.keys().map(String::as_str).collect();
        claves.sort();
        assert_eq!(claves, ["accounts", "openPanes", "version", "workspaces"]);
        let d = decidir_carga(&lectura(v), false);
        assert_eq!((d.respaldar, d.guardar, d.confiable), (true, true, true));
    }

    #[test]
    fn version_futura_conserva_los_campos_nuevos() {
        let crudo = json!({ "version": 2, "accounts": [con(cuenta(), "nuevo", json!({ "n": 1 }))], "workspaces": [], "openPanes": [], "sync": { "id": "x" } });
        let copia = crudo.clone();
        let v = leido(crudo.clone());
        assert!(v.version_futura);
        assert_eq!(lista(&v, "accounts")[0], con(cuenta(), "nuevo", json!({ "n": 1 })));
        assert_eq!(crudo, copia);
    }

    #[test]
    fn campos_desconocidos_en_la_raiz_se_conservan_al_migrar() {
        let v = leido(json!({ "accounts": [cuenta()], "preferencia": { "a": [1, 2] } }));
        assert_eq!(v.estado["preferencia"], json!({ "a": [1, 2] }));
    }

    #[test]
    fn version_que_no_se_entiende_deja_el_archivo_invalido() {
        for version in [json!("x"), json!("1"), json!(1.5), json!(0), json!(-1), json!(null), json!(true)] {
            assert!(validar_estado(&json!({ "version": version, "accounts": [cuenta()] })).is_none(), "{version}");
        }
        for x in [json!(null), json!("no es json"), json!(42), json!([]), json!([cuenta()])] {
            assert!(validar_estado(&x).is_none());
        }
    }
}
