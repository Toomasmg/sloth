//! Pedidos de permiso de Claude (`feat:permissions:*`), como src/main/features/permissions.ts: reglas «Permitir siempre»
//! por espacio, historial de decisiones y avisos de Windows. Es del núcleo porque vive de sus pedidos, hooks y
//! terminales; las reglas y decisiones están en `sloth_core::features::permissions`. Todo es por eventos: sin timers.
use super::Nucleo;
use serde_json::{json, Map, Value};
use sloth_core::avisos::Avisos;
use sloth_core::daemon_protocolo::{HookEventPayload, PendingPermission};
use sloth_core::features::permissions::{
    buscar_regla, decision_para, debe_avisar, etiqueta_de, regla_a_valor, regla_de_valor, regla_desde_pedido, respuesta_efectiva, revisar_regla, tipo_de, Eleccion, Pedido, Regla,
};
use sloth_core::features::permissions_paths::dentro_del_repo_en_disco;
use sloth_core::features::poda::podar_segun_store;
use sloth_core::persistencia::{escribir_json_atomico, leer_json, OpcionesLectura};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

pub const NOMBRE: &str = "permissions";

const MAX_HISTORY: usize = 300;
const MAX_RULES: usize = 200;
const MAX_MESSAGE: usize = 1000;
/// Tope de reglas que acepta una importación de una vez (el archivo ya viene acotado).
const MAX_IMPORT: usize = 500;

const NO_PENDIENTE: &str = "Ese permiso ya no está pendiente (venció o se respondió en la terminal).";

#[derive(Default)]
struct Estado {
    /// Tal como están en el archivo: los campos que no se entienden se conservan.
    rules: Vec<Value>,
    history: Vec<Value>,
}

pub struct Permisos {
    archivo: PathBuf,
    estado: Mutex<Estado>,
    /// El espacio que la UI tiene en pantalla: de ese no se avisa si la ventana tiene el foco.
    enfocado: Mutex<Option<String>>,
}

pub fn pedido_de(r: &PendingPermission) -> Pedido {
    Pedido { id: r.id.clone(), ws: r.ws.clone(), tool: r.tool.clone(), input: r.input.as_object().cloned().unwrap_or_default(), at: r.at as f64, expires_at: r.expires_at as f64 }
}

fn texto(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned)
}

/// Lectura tolerante, como `load` de permissions.ts: las entradas que no se entienden se descartan.
fn leer(archivo: &Path, avisos: &Avisos) -> Estado {
    let validar = |v: &Value| v.as_object().map(|_| v.clone());
    let por_defecto = || json!({});
    let raw = leer_json(archivo, &OpcionesLectura::nuevas(&validar, &por_defecto), avisos).valor;
    let lista = |k: &str, ok: &dyn Fn(&Value) -> bool, max: usize| -> Vec<Value> {
        raw.get(k).and_then(Value::as_array).map(|a| a.iter().filter(|x| ok(x)).take(max).cloned().collect()).unwrap_or_default()
    };
    Estado {
        rules: lista("rules", &|r| r.get("id").is_some_and(Value::is_string) && r.get("workspaceId").is_some_and(Value::is_string), MAX_RULES),
        history: lista("history", &|h| h.get("id").is_some_and(Value::is_string) && h.get("at").is_some_and(Value::is_number), MAX_HISTORY),
    }
}

impl Permisos {
    pub fn cargar(archivo: &Path, avisos: &Avisos) -> Permisos {
        Permisos { archivo: archivo.to_path_buf(), estado: Mutex::new(leer(archivo, avisos)), enfocado: Mutex::default() }
    }

    fn estado(&self) -> MutexGuard<'_, Estado> {
        self.estado.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn guardar(&self, n: &Nucleo, e: &Estado) {
        if let Err(err) = escribir_json_atomico(&self.archivo, &json!({ "rules": e.rules, "history": e.history })) {
            sloth_core::logger_global::aviso(NOMBRE, &format!("no se pudo guardar: {err}"));
        }
        n.ui(&format!("feat:{NOMBRE}:changed"), &[]);
    }

    fn reglas(e: &Estado) -> Vec<Regla> {
        e.rules.iter().filter_map(regla_de_valor).collect()
    }

    fn recordar(e: &mut Estado, n: &Nucleo, req: &Pedido, tag: &str, rule_id: Option<&str>) {
        let kind = tipo_de(&req.tool);
        let mut entrada = json!({
            "id": crate::handlers::comun::nuevo_uuid(),
            "at": super::arranque::ahora_ms(),
            "workspaceId": req.ws,
            "spaceName": nombre_del_espacio(n, &req.ws),
            "tool": req.tool,
            "kind": kind.texto(),
            "label": etiqueta_de(kind, &req.tool, &req.input),
            "tag": tag,
        });
        if let Some(r) = rule_id {
            entrada["ruleId"] = json!(r);
        }
        e.history.insert(0, entrada);
        e.history.truncate(MAX_HISTORY);
    }

    /// Responde un pedido que sigue pendiente. Error si ya no lo está (venció o se respondió en la terminal).
    pub fn decidir(&self, n: &Nucleo, id: &str, pedida: Eleccion, mensaje: Option<&str>) -> Result<(), String> {
        let t = n.terminales_si_hay().ok_or("Las terminales todavía no están listas. Probá de nuevo.")?;
        let req = t.permisos().iter().find(|r| r.id == id).map(pedido_de).ok_or(NO_PENDIENTE)?;
        let eleccion = respuesta_efectiva(pedida, &req);
        let mut e = self.estado();
        match eleccion {
            Eleccion::AllowAlways => {
                let nueva = regla_desde_pedido(&req, &crate::handlers::comun::nuevo_uuid(), super::arranque::ahora_ms() as f64);
                let existente = Self::reglas(&e).into_iter().find(|x| x.on && x.workspace_id == nueva.workspace_id && x.kind == nueva.kind && x.tool == nueva.tool && x.match_ == nueva.match_);
                let id_regla = match existente {
                    Some(r) => r.id,
                    None => {
                        e.rules.insert(0, regla_a_valor(&nueva));
                        e.rules.truncate(MAX_RULES);
                        nueva.id
                    }
                };
                Self::recordar(&mut e, n, &req, "always", Some(&id_regla));
            }
            Eleccion::Allow => Self::recordar(&mut e, n, &req, "once", None),
            Eleccion::Deny => Self::recordar(&mut e, n, &req, "deny", None),
            Eleccion::Terminal => Self::recordar(&mut e, n, &req, "terminal", None),
        }
        n.responder_permiso(id, decision_para(eleccion, mensaje).unwrap_or(Value::Null));
        self.guardar(n, &e);
        Ok(())
    }

    /// Pedido nuevo: si una regla lo cubre se aprueba solo (true) y no hace falta la tarjeta; si no, aviso de Windows.
    pub fn al_pedido(&self, n: &Nucleo, r: &PendingPermission) -> bool {
        let Some(ws) = n.espacio(&r.ws) else { return false };
        let req = pedido_de(r);
        let mut e = self.estado();
        let regla = buscar_regla(&Self::reglas(&e), &req, ws["cwd"].as_str(), &dentro_del_repo_en_disco).map(|x| x.id.clone());
        let Some(id_regla) = regla else {
            drop(e);
            self.avisar_pedido(n, &ws, &req);
            return false;
        };
        n.responder_permiso(&req.id, decision_para(Eleccion::Allow, None).unwrap_or(Value::Null));
        Self::recordar(&mut e, n, &req, "rule", Some(&id_regla));
        self.guardar(n, &e);
        true
    }

    fn puede_avisar(&self, n: &Nucleo, clave: &str, ws: &str) -> bool {
        let ajustes = n.ajustes();
        let notify = ajustes.get("notify").and_then(|v| v.get(clave)).and_then(Value::as_bool).unwrap_or(false);
        let dnd = ajustes.get("noMolestar").and_then(Value::as_bool).unwrap_or(false);
        let enfocado = self.enfocado.lock().unwrap_or_else(|e| e.into_inner()).clone();
        notify && debe_avisar(dnd, n.ventana_con_foco(), enfocado.as_deref(), ws)
    }

    /// En Tauri el aviso no tiene botones ni avisa el clic (Windows): «Permitir» y «Ver» quedan para la tarjeta.
    fn avisar_pedido(&self, n: &Nucleo, ws: &Value, req: &Pedido) {
        let id = ws["id"].as_str().unwrap_or_default();
        if !self.puede_avisar(n, "perm", id) {
            return;
        }
        let kind = tipo_de(&req.tool);
        n.avisar_al_sistema(&format!("{} pide permiso", ws["name"].as_str().unwrap_or_default()), &etiqueta_de(kind, &req.tool, &req.input));
    }

    /// Aviso de un espacio (terminó o te espera): lo gobierna «notify.done».
    pub fn al_hook(&self, n: &Nucleo, p: &HookEventPayload) {
        if p.en_fondo.is_some_and(|x| x > 0) {
            return;
        }
        let (titulo, cuerpo) = match (p.event.as_str(), p.notification_type.as_deref()) {
            ("Stop", _) => {
                let agente = n.espacio(&p.ws).and_then(|w| w["accountId"].as_str().and_then(|a| n.cuenta(a))).map(|c| sloth_core::proveedores::agente_de(&c)).unwrap_or_else(|| sloth_core::proveedores::agente_de(&json!({})));
                ("terminó", format!("{agente} terminó. Revisá los cambios antes de seguir."))
            }
            ("Notification", t) if t != Some("permission_prompt") => ("te espera", p.message.clone().filter(|m| !m.is_empty()).unwrap_or_else(|| "Claude necesita tu atención.".into())),
            _ => return,
        };
        let Some(ws) = n.espacio(&p.ws) else { return };
        if self.puede_avisar(n, "done", &p.ws) {
            n.avisar_al_sistema(&format!("{} {titulo}", ws["name"].as_str().unwrap_or_default()), &cuerpo);
        }
    }

    pub fn lista(&self, n: &Nucleo) -> Value {
        let (confiable, espacios): (bool, Vec<Value>) = {
            let s = n.store();
            (s.confiable(), s.workspaces().to_vec())
        };
        let existe = |id: &str| espacios.iter().any(|w| w["id"] == id);
        let mut e = self.estado();
        // Reglas de espacios que ya no existen: no quedan huérfanas en el archivo.
        let p = podar_segun_store(&e.rules, |r| r["workspaceId"].as_str().is_some_and(existe), confiable);
        if p.guardar.len() != e.rules.len() {
            e.rules = p.guardar;
            self.guardar(n, &e);
        }
        let ahora = super::arranque::ahora_ms();
        let hoy = sloth_core::usage::medianoche_local(ahora as i64, crate::handlers::comun::desfase_local_min(ahora)) as f64;
        let history: Vec<&Value> = e.history.iter().filter(|h| h["at"].as_f64().is_some_and(|t| t >= hoy)).collect();
        let spaces: Map<String, Value> = espacios
            .iter()
            .filter_map(|w| Some((w["id"].as_str()?.to_string(), json!({ "name": w["name"], "cwd": w["cwd"], "accountId": w["accountId"] }))))
            .collect();
        json!({ "rules": p.vista, "history": history, "spaces": spaces })
    }

    pub fn fijar_regla(&self, n: &Nucleo, id: &Value, on: &Value) -> Result<(), String> {
        let (Some(id), Some(on)) = (id.as_str(), on.as_bool()) else { return Err("Cambio inválido.".into()) };
        let mut e = self.estado();
        let r = e.rules.iter_mut().find(|r| r["id"] == id).ok_or("Esa regla ya no existe.")?;
        r["on"] = Value::Bool(on);
        self.guardar(n, &e);
        Ok(())
    }

    pub fn quitar_regla(&self, n: &Nucleo, id: &Value) -> Result<(), String> {
        let id = id.as_str().ok_or("Regla inválida.")?;
        let mut e = self.estado();
        e.rules.retain(|r| r["id"] != id);
        self.guardar(n, &e);
        Ok(())
    }

    /// Reglas «Permitir siempre» elegidas al importar un archivo: cada una con la misma validación de siempre y en un
    /// espacio que existe. Las repetidas o inválidas se cuentan como omitidas. Nunca toca la configuración de Claude.
    pub fn agregar_reglas(&self, n: &Nucleo, payload: &Value) -> Result<Value, String> {
        let lista = payload.get("reglas").and_then(Value::as_array).filter(|l| l.len() <= MAX_IMPORT).ok_or("La lista de reglas no es válida.")?;
        let (mut agregadas, mut omitidas) = (0, 0);
        let mut e = self.estado();
        for item in lista {
            let ws = item.get("workspaceId").and_then(Value::as_str).unwrap_or_default();
            let (true, Ok(r)) = (!ws.is_empty() && n.espacio(ws).is_some(), revisar_regla(item)) else {
                omitidas += 1;
                continue;
            };
            let repetida = Self::reglas(&e).iter().any(|x| x.on && x.workspace_id == ws && x.kind == r.kind && x.tool == r.tool && x.match_ == r.match_);
            if repetida || e.rules.len() >= MAX_RULES {
                omitidas += 1;
                continue;
            }
            let nueva = Regla { id: crate::handlers::comun::nuevo_uuid(), workspace_id: ws.into(), kind: r.kind, tool: r.tool, match_: r.match_, label: r.label, on: true, created_at: super::arranque::ahora_ms() as f64 };
            e.rules.insert(0, regla_a_valor(&nueva));
            agregadas += 1;
        }
        if agregadas > 0 {
            self.guardar(n, &e);
        }
        sloth_core::logger_global::info(NOMBRE, &format!("reglas importadas: {agregadas} agregadas, {omitidas} omitidas"));
        Ok(json!({ "agregadas": agregadas, "omitidas": omitidas }))
    }

    /// Deshacer «Permitir siempre»: quita la regla y marca la decisión. Solo sirve para reglas guardadas.
    pub fn deshacer(&self, n: &Nucleo, id: &Value) -> Result<(), String> {
        let id = id.as_str().ok_or("Decisión inválida.")?;
        let mut e = self.estado();
        let entrada = e.history.iter_mut().find(|h| h["id"] == id).filter(|h| h["tag"] == "always" && h["ruleId"].is_string() && h["undone"] != Value::Bool(true));
        let Some(entrada) = entrada else { return Err("Esa decisión no se puede deshacer.".into()) };
        entrada["undone"] = Value::Bool(true);
        let regla = texto(entrada, "ruleId").unwrap_or_default();
        e.rules.retain(|r| r["id"] != regla.as_str());
        self.guardar(n, &e);
        Ok(())
    }

    /// La UI avisa qué espacio tiene en pantalla (para no avisar de lo que ya se ve).
    pub fn enfocar(&self, n: &Nucleo, id: &Value) {
        let id = id.as_str().filter(|x| n.espacio(x).is_some()).map(str::to_owned);
        *self.enfocado.lock().unwrap_or_else(|e| e.into_inner()) = id;
    }

    /// Un pedido `decide` de la UI: valida la forma antes de buscar el pedido.
    pub fn decidir_desde_ui(&self, n: &Nucleo, payload: &Value) -> Result<(), String> {
        let id = payload.get("id").and_then(Value::as_str);
        let eleccion = payload.get("answer").and_then(Value::as_str).and_then(Eleccion::desde_texto);
        let (Some(id), Some(eleccion)) = (id, eleccion) else { return Err("Respuesta inválida.".into()) };
        let mensaje: Option<String> = payload.get("message").and_then(Value::as_str).map(|m| m.chars().take(MAX_MESSAGE).collect());
        self.decidir(n, id, eleccion, mensaje.as_deref())
    }
}

fn nombre_del_espacio(n: &Nucleo, ws: &str) -> String {
    n.espacio(ws).and_then(|w| texto(&w, "name")).unwrap_or_else(|| "Espacio borrado".into())
}
