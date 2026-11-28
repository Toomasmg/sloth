//! Alta, baja y ajustes de cuentas: las decisiones puras de los canales `accounts:*` de src/main/index.ts y
//! src/main/accounts.ts. Lo que toca el daemon, los hooks o el login queda a cargo de quien llama.
use crate::ipc_guard::id_valido;
use crate::perfiles_core::es_blanco_js;
use crate::proveedores::{capacidades_de, motivo_no_agregar, motivo_sin_capacidad, proveedor_id_de, ProveedorId};
use crate::proveedores_fs::{estado_login, preparar_carpeta, subcarpeta_cuenta, Aviso};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub const AVISO_PROVEEDOR_DESCONOCIDO: &str = "Esta cuenta es de un agente que esta versión de Sloth no conoce; actualizá Sloth.";
pub const PEDIDO_INVALIDO: &str = "Pedido inválido.";
pub const CUENTA_INEXISTENTE: &str = "Esa cuenta ya no existe.";
const MAX_LABEL: usize = 80;

pub fn carpeta_de_cuentas(raiz_datos: &Path) -> PathBuf {
    raiz_datos.join("accounts")
}

fn utf16(s: &str) -> usize {
    s.encode_utf16().count()
}

#[derive(Debug)]
pub struct AltaDeCuenta {
    pub label: String,
    pub proveedor: Option<ProveedorId>,
}

/// Lo que llega por `accounts:add`: el nombre (hasta 80 unidades UTF-16) y, si viene, un agente conocido.
pub fn validar_alta_de_cuenta(label: &Value, proveedor: Option<&Value>) -> Result<AltaDeCuenta, String> {
    let label = label.as_str().filter(|s| utf16(s) <= MAX_LABEL).ok_or("El nombre de la cuenta tiene que ser un texto de hasta 80 caracteres.")?;
    let proveedor = match proveedor {
        None => None,
        Some(v) => Some(v.as_str().and_then(ProveedorId::desde_texto).ok_or("Agente inválido.")?),
    };
    Ok(AltaDeCuenta { label: label.to_owned(), proveedor })
}

/// El tope de cuentas de un agente vale entre todos los perfiles: el login del sistema que lo motiva es uno solo.
/// `en_otros_perfiles` se calcula (con `tope_cuentas`) solo si el agente tiene tope.
pub fn motivo_no_agregar_cuenta(cuentas: &[Value], id: ProveedorId, en_otros_perfiles: &mut dyn FnMut() -> usize) -> Option<String> {
    if id != ProveedorId::Copilot {
        return None;
    }
    motivo_no_agregar(cuentas, id, en_otros_perfiles())
}

pub struct CuentaCreada {
    pub cuenta: Value,
    pub avisos: Vec<Aviso>,
}

/// Cada cuenta vive en su propia carpeta: es el CLAUDE_CONFIG_DIR (o CODEX_HOME) de esa cuenta.
/// `proveedor` ausente deja la cuenta sin el campo (las de antes de que hubiera varios agentes).
pub fn crear_cuenta(carpeta_cuentas: &Path, label: &str, proveedor: Option<ProveedorId>, id: String, ahora_ms: u64) -> Result<CuentaCreada, String> {
    let p = proveedor.unwrap_or(crate::proveedores::PROVEEDOR_DEFECTO);
    let config_dir = carpeta_cuentas.join(&id).join(subcarpeta_cuenta(p));
    fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let avisos = preparar_carpeta(p, &config_dir).map_err(|e| e.to_string())?;
    let nombre = label.trim_matches(es_blanco_js);
    let mut o = Map::new();
    o.insert("id".into(), Value::String(id));
    o.insert("label".into(), Value::String(if nombre.is_empty() { "Cuenta".into() } else { nombre.to_owned() }));
    o.insert("configDir".into(), Value::String(config_dir.to_string_lossy().into_owned()));
    o.insert("createdAt".into(), Value::from(ahora_ms));
    if proveedor.is_some() {
        o.insert("proveedor".into(), Value::String(p.como_texto().to_owned()));
    }
    Ok(CuentaCreada { cuenta: Value::Object(o), avisos })
}

/// La cuenta tal como se guarda: con el setup compartido que le corresponde a su agente.
pub fn con_setup_compartido(nueva: Value) -> Value {
    let setup = capacidades_de(&nueva).is_some_and(|c| c.setup_compartido);
    let mut o = nueva.as_object().cloned().unwrap_or_default();
    o.insert("shareSetup".into(), Value::Bool(setup));
    Value::Object(o)
}

/// Estado de login: lo decide el proveedor de la cuenta sin abrir credenciales.
pub fn estado_de_cuenta(cuenta: &Value) -> Value {
    let config_dir = cuenta.get("configDir").and_then(Value::as_str).unwrap_or_default();
    let existe = Path::new(config_dir).exists();
    let mut o = Map::new();
    match proveedor_id_de(cuenta) {
        Some(id) if existe => {
            let r = estado_login(id, Path::new(config_dir)).estado;
            o.insert("loggedIn".into(), Value::Bool(r.logged_in));
            if let Some(e) = r.email {
                o.insert("email".into(), Value::String(e));
            }
        }
        _ => {
            o.insert("loggedIn".into(), Value::Bool(false));
        }
    }
    o.insert("configDirExists".into(), Value::Bool(existe));
    Value::Object(o)
}

/// Nunca arrancamos una terminal con una cuenta que no sea la elegida.
pub fn exigir_cuenta<'a>(cuenta: Option<&'a Value>, existe_carpeta: &dyn Fn(&str) -> bool) -> Result<&'a Value, String> {
    let c = cuenta.ok_or("La cuenta de este espacio ya no existe. Elegí otra cuenta.")?;
    let dir = c.get("configDir").and_then(Value::as_str).unwrap_or_default();
    if !existe_carpeta(dir) {
        let label = c.get("label").and_then(Value::as_str).unwrap_or_default();
        return Err(format!("Falta la carpeta de la cuenta «{label}»."));
    }
    Ok(c)
}

/// Para todo lo que lanza un proceso con la cuenta: con un agente desconocido no se lanza nada.
pub fn exigir_proveedor(cuenta: &Value) -> Result<ProveedorId, String> {
    proveedor_id_de(cuenta).ok_or_else(|| AVISO_PROVEEDOR_DESCONOCIDO.to_owned())
}

/// Si hay alguna terminal abierta con esta cuenta (Claude puede estar escribiendo su .claude.json).
pub fn cuenta_ocupada(cuenta_id: &str, espacios: &[Value], corriendo: &dyn Fn(&str) -> bool) -> bool {
    if corriendo(&format!("login:{cuenta_id}")) {
        return true;
    }
    espacios.iter().any(|w| w.get("accountId").and_then(Value::as_str) == Some(cuenta_id) && w.get("id").and_then(Value::as_str).is_some_and(corriendo))
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum PermisoLimites {
    Apagada,
    EnUso,
    Ok,
}

/// Leer los límites de Codex lanza su app-server, que puede renovar el token de la cuenta: con una terminal abierta de la
/// misma cuenta (o sin saber todavía cuáles hay, porque el backend no arrancó) no se lanza.
pub fn permiso_de_limites(cuenta: Option<&Value>, backend_listo: bool, ocupada: bool) -> PermisoLimites {
    match cuenta {
        Some(c) if c.get("limitesExperimentales") == Some(&Value::Bool(true)) => {
            if backend_listo && !ocupada {
                PermisoLimites::Ok
            } else {
                PermisoLimites::EnUso
            }
        }
        _ => PermisoLimites::Apagada,
    }
}

pub fn pedido_id_y_booleano<'a>(id: &'a Value, b: &Value) -> Result<(&'a str, bool), String> {
    match (id_valido(id), b.as_bool()) {
        (Some(id), Some(b)) => Ok((id, b)),
        _ => Err(PEDIDO_INVALIDO.into()),
    }
}

/// `accounts:setShareSetup`: solo las cuentas de un agente con setup compartido.
pub fn comprobar_setup_compartido(cuenta: Option<&Value>) -> Result<(), String> {
    if let Some(c) = cuenta {
        exigir_proveedor(c)?;
        if !capacidades_de(c).is_some_and(|k| k.setup_compartido) {
            return Err(motivo_sin_capacidad(c, "setupCompartido").unwrap_or_default());
        }
    }
    Ok(())
}

/// `accounts:setLimitesExperimentales`.
pub fn comprobar_limites_experimentales(cuenta: Option<&Value>) -> Result<(), String> {
    let c = cuenta.ok_or(CUENTA_INEXISTENTE)?;
    if capacidades_de(c).is_some_and(|k| k.limites_experimental) {
        return Ok(());
    }
    Err(motivo_sin_capacidad(c, "limitesExperimental").unwrap_or_default())
}

/// `accounts:setAvisoDeTurno`: solo Codex.
pub fn comprobar_aviso_de_turno(cuenta: Option<&Value>) -> Result<(), String> {
    let c = cuenta.ok_or(CUENTA_INEXISTENTE)?;
    let id = exigir_proveedor(c)?;
    if id != ProveedorId::Codex || !capacidades_de(c).is_some_and(|k| k.aviso_turno) {
        return Err(motivo_sin_capacidad(c, "avisoTurno").unwrap_or_else(|| "Esta cuenta no usa el aviso de «terminó» de Codex.".into()));
    }
    Ok(())
}

/// `accounts:remove`: una cuenta con espacios no se borra.
pub fn comprobar_baja_de_cuenta(cuenta_id: &str, espacios: &[Value]) -> Result<(), String> {
    let usados: Vec<&str> = espacios.iter().filter(|w| w.get("accountId").and_then(Value::as_str) == Some(cuenta_id)).map(|w| w.get("name").and_then(Value::as_str).unwrap_or_default()).collect();
    if usados.is_empty() {
        return Ok(());
    }
    Err(format!("La usan {} espacio(s): {}", usados.len(), usados.join(", ")))
}

/// Si el aviso de «terminó» no se pudo activar vuelve a apagado: no queda un switch prendido que no hace nada.
pub fn debe_revertir_aviso_de_turno(activo: bool, motivo: Option<&str>) -> bool {
    activo && motivo.is_some()
}

/// Motivo si falla preparar la carpeta de una cuenta de Codex para el aviso de turno.
pub fn motivo_carpeta_de_codex(codigo: Option<&str>) -> String {
    format!("No pude preparar la carpeta de la cuenta de Codex ({}).", codigo.unwrap_or("error"))
}

/// El setup de una cuenta que no se pudo compartir se avisa una vez por cuenta y causa; devuelve el texto del log
/// (sin el nombre de la cuenta: la gente le pone su nombre y el diagnóstico se comparte).
pub fn aviso_de_setup(ya_avisados: &mut std::collections::HashSet<String>, cuenta_id: &str, posicion: usize, omitidos: &[String]) -> Option<String> {
    if omitidos.is_empty() {
        return None;
    }
    let motivo = omitidos.join("; ");
    ya_avisados.insert(format!("{cuenta_id}|{motivo}")).then(|| format!("cuenta {}: {motivo}", posicion + 1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn tmp() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        std::env::temp_dir().join(format!("sloth-cuentas-rs-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)))
    }

    #[test]
    fn el_alta_pide_un_nombre_de_hasta_80_y_un_agente_conocido() {
        assert!(validar_alta_de_cuenta(&json!("Trabajo"), None).is_ok());
        assert!(validar_alta_de_cuenta(&json!("a".repeat(80)), None).is_ok());
        assert!(validar_alta_de_cuenta(&json!("a".repeat(81)), None).unwrap_err().contains("hasta 80"));
        assert!(validar_alta_de_cuenta(&json!(5), None).is_err());
        assert_eq!(validar_alta_de_cuenta(&json!("x"), Some(&json!("codex"))).unwrap().proveedor, Some(ProveedorId::Codex));
        assert_eq!(validar_alta_de_cuenta(&json!("x"), Some(&json!("gpt"))).err().as_deref(), Some("Agente inválido."));
        assert_eq!(validar_alta_de_cuenta(&json!("x"), Some(&json!(null))).err().as_deref(), Some("Agente inválido."));
    }

    #[test]
    fn el_tope_solo_se_consulta_para_agentes_con_tope() {
        let mut llamadas = 0;
        assert_eq!(motivo_no_agregar_cuenta(&[], ProveedorId::Claude, &mut || { llamadas += 1; 9 }), None);
        assert_eq!(llamadas, 0);
        let cuentas = [json!({ "id": "a", "proveedor": "copilot" })];
        assert!(motivo_no_agregar_cuenta(&cuentas, ProveedorId::Copilot, &mut || 0).unwrap().contains("Ya tenés una cuenta"));
        assert!(motivo_no_agregar_cuenta(&[], ProveedorId::Copilot, &mut || 1).unwrap().contains("en otro perfil"));
    }

    #[test]
    fn crear_cuenta_arma_la_carpeta_y_el_registro_en_orden() {
        let raiz = tmp();
        let c = crear_cuenta(&raiz, "  Personal ", None, "abc".into(), 7).unwrap();
        assert_eq!(c.cuenta, json!({ "id": "abc", "label": "Personal", "configDir": raiz.join("abc").join("claude").to_string_lossy(), "createdAt": 7 }));
        assert_eq!(c.cuenta.as_object().unwrap().keys().collect::<Vec<_>>(), ["id", "label", "configDir", "createdAt"]);
        assert!(raiz.join("abc").join("claude").is_dir());
        let _ = fs::remove_dir_all(&raiz);
    }

    #[test]
    fn crear_cuenta_con_agente_lo_guarda_y_con_nombre_vacio_se_llama_cuenta() {
        let raiz = tmp();
        let c = crear_cuenta(&raiz, "   ", Some(ProveedorId::Codex), "x1".into(), 1).unwrap();
        assert_eq!(c.cuenta["label"], "Cuenta");
        assert_eq!(c.cuenta["proveedor"], "codex");
        assert!(raiz.join("x1").join("codex").join("config.toml").is_file());
        let _ = fs::remove_dir_all(&raiz);
    }

    #[test]
    fn el_setup_compartido_sale_de_las_capacidades_del_agente() {
        assert_eq!(con_setup_compartido(json!({ "id": "a" }))["shareSetup"], true);
        assert_eq!(con_setup_compartido(json!({ "id": "a", "proveedor": "codex" }))["shareSetup"], false);
        assert_eq!(con_setup_compartido(json!({ "id": "a", "proveedor": "otro" }))["shareSetup"], false);
    }

    #[test]
    fn el_estado_sin_carpeta_o_con_agente_desconocido_no_tiene_sesion() {
        assert_eq!(estado_de_cuenta(&json!({ "id": "a", "configDir": "Z:/no/existe/nunca" })), json!({ "loggedIn": false, "configDirExists": false }));
        let raiz = tmp();
        fs::create_dir_all(&raiz).unwrap();
        let c = json!({ "id": "a", "proveedor": "otro", "configDir": raiz.to_string_lossy() });
        assert_eq!(estado_de_cuenta(&c), json!({ "loggedIn": false, "configDirExists": true }));
        let c = json!({ "id": "a", "configDir": raiz.to_string_lossy() });
        assert_eq!(estado_de_cuenta(&c)["configDirExists"], true);
        assert_eq!(estado_de_cuenta(&c)["loggedIn"], false);
        let _ = fs::remove_dir_all(&raiz);
    }

    #[test]
    fn exigir_cuenta_distingue_cuenta_borrada_de_carpeta_faltante() {
        assert_eq!(exigir_cuenta(None, &|_| true).unwrap_err(), "La cuenta de este espacio ya no existe. Elegí otra cuenta.");
        let c = json!({ "id": "a", "label": "Trabajo", "configDir": "X" });
        assert_eq!(exigir_cuenta(Some(&c), &|_| false).unwrap_err(), "Falta la carpeta de la cuenta «Trabajo».");
        assert!(exigir_cuenta(Some(&c), &|_| true).is_ok());
    }

    #[test]
    fn exigir_proveedor_rechaza_agentes_que_no_se_conocen() {
        assert_eq!(exigir_proveedor(&json!({ "id": "a" })), Ok(ProveedorId::Claude));
        assert_eq!(exigir_proveedor(&json!({ "proveedor": "x" })), Err(AVISO_PROVEEDOR_DESCONOCIDO.into()));
    }

    #[test]
    fn cuenta_ocupada_mira_el_login_y_los_espacios_de_esa_cuenta() {
        let ws = [json!({ "id": "w1", "accountId": "a" }), json!({ "id": "w2", "accountId": "b" })];
        assert!(cuenta_ocupada("a", &ws, &|id| id == "w1"));
        assert!(!cuenta_ocupada("a", &ws, &|id| id == "w2"));
        assert!(cuenta_ocupada("b", &[], &|id| id == "login:b"));
        assert!(!cuenta_ocupada("a", &ws, &|_| false));
    }

    #[test]
    fn los_limites_solo_se_leen_con_el_switch_prendido_backend_listo_y_sin_terminales() {
        let on = json!({ "id": "a", "limitesExperimentales": true });
        assert_eq!(permiso_de_limites(Some(&on), true, false), PermisoLimites::Ok);
        assert_eq!(permiso_de_limites(Some(&on), false, false), PermisoLimites::EnUso);
        assert_eq!(permiso_de_limites(Some(&on), true, true), PermisoLimites::EnUso);
        assert_eq!(permiso_de_limites(Some(&json!({ "id": "a" })), true, false), PermisoLimites::Apagada);
        assert_eq!(permiso_de_limites(Some(&json!({ "limitesExperimentales": "si" })), true, false), PermisoLimites::Apagada);
        assert_eq!(permiso_de_limites(None, true, false), PermisoLimites::Apagada);
    }

    #[test]
    fn los_pedidos_con_id_y_booleano_se_validan() {
        assert_eq!(pedido_id_y_booleano(&json!("a"), &json!(true)), Ok(("a", true)));
        assert!(pedido_id_y_booleano(&json!(""), &json!(true)).is_err());
        assert!(pedido_id_y_booleano(&json!("a"), &json!("true")).is_err());
        assert!(pedido_id_y_booleano(&json!(null), &json!(false)).is_err());
    }

    #[test]
    fn setup_compartido_solo_con_agentes_que_lo_tienen() {
        assert!(comprobar_setup_compartido(None).is_ok());
        assert!(comprobar_setup_compartido(Some(&json!({ "id": "a" }))).is_ok());
        assert!(comprobar_setup_compartido(Some(&json!({ "id": "a", "proveedor": "codex" }))).unwrap_err().contains("no aplica a Codex"));
        assert_eq!(comprobar_setup_compartido(Some(&json!({ "proveedor": "x" }))), Err(AVISO_PROVEEDOR_DESCONOCIDO.into()));
    }

    #[test]
    fn limites_experimentales_solo_donde_el_agente_los_tiene() {
        assert_eq!(comprobar_limites_experimentales(None), Err(CUENTA_INEXISTENTE.into()));
        assert!(comprobar_limites_experimentales(Some(&json!({ "id": "a" }))).is_err());
    }

    #[test]
    fn el_aviso_de_turno_es_de_codex() {
        assert_eq!(comprobar_aviso_de_turno(None), Err(CUENTA_INEXISTENTE.into()));
        assert!(comprobar_aviso_de_turno(Some(&json!({ "id": "a" }))).is_err());
        assert!(comprobar_aviso_de_turno(Some(&json!({ "id": "a", "proveedor": "codex" }))).is_ok());
        assert!(comprobar_aviso_de_turno(Some(&json!({ "id": "a", "proveedor": "copilot" }))).is_err());
        assert!(debe_revertir_aviso_de_turno(true, Some("x")));
        assert!(!debe_revertir_aviso_de_turno(false, Some("x")));
        assert!(!debe_revertir_aviso_de_turno(true, None));
    }

    #[test]
    fn una_cuenta_con_espacios_no_se_borra() {
        let ws = [json!({ "accountId": "a", "name": "uno" }), json!({ "accountId": "b", "name": "otro" }), json!({ "accountId": "a", "name": "dos" })];
        assert_eq!(comprobar_baja_de_cuenta("a", &ws), Err("La usan 2 espacio(s): uno, dos".into()));
        assert!(comprobar_baja_de_cuenta("c", &ws).is_ok());
    }

    #[test]
    fn el_motivo_de_la_carpeta_de_codex_lleva_el_codigo() {
        assert_eq!(motivo_carpeta_de_codex(Some("EACCES")), "No pude preparar la carpeta de la cuenta de Codex (EACCES).");
        assert_eq!(motivo_carpeta_de_codex(None), "No pude preparar la carpeta de la cuenta de Codex (error).");
    }

    #[test]
    fn el_aviso_de_setup_sale_una_vez_por_cuenta_y_causa_y_sin_el_nombre() {
        let mut vistos = HashSet::new();
        let om = vec!["a".to_owned(), "b".to_owned()];
        assert_eq!(aviso_de_setup(&mut vistos, "c1", 0, &om), Some("cuenta 1: a; b".into()));
        assert_eq!(aviso_de_setup(&mut vistos, "c1", 0, &om), None);
        assert_eq!(aviso_de_setup(&mut vistos, "c2", 1, &om), Some("cuenta 2: a; b".into()));
        assert_eq!(aviso_de_setup(&mut vistos, "c1", 0, &["otro".to_owned()]), Some("cuenta 1: otro".into()));
        assert_eq!(aviso_de_setup(&mut vistos, "c1", 0, &[]), None);
    }
}
