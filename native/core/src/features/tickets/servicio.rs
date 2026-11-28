//! Las decisiones puras de src/main/features/tickets/index.ts: validar los argumentos que llegan por IPC (no vienen validados),
//! las reglas de cambio de conector, servidor, filtro y configuración, qué se puede hacer con un ticket, y armar lo que ve la
//! interfaz. Lo que depende de Electron, de las cuentas, de las carpetas o de correr un agente queda detrás de `Entorno`, que
//! implementa quien use esto; acá no se corre nada.
use super::acciones::{entrada_de_accion, es_accion, texto, texto_obligatorio, ticket_id, Contexto};
use super::alcance::{conteos, estados_validos, filtro_de, para_equipo, pendientes_de, personas_validas, ventana_valida, visibles};
use super::almacen::Almacen;
use super::conector::{ConectorDef, ConectorMcp};
use super::cuentas::{bloquea_consulta, disponibilidad, elegibles, mensaje_cuenta, usable};
use super::eleccion::{elegir_cuenta, sirve_para_tickets, Candidata, ParaQue};
use super::errores::{ErrorTickets, Res};
use super::estado::{assignee_valido, con_conector, sin_lista, ticket_de_obj, TicketsState, ASSIGNEE_MAX};
use super::modelo::{Accion, AlcanceLeido, CuentaRevisada, Detalle, Disponibilidad, Estado, EstadoBase, OrigenConector, Ordenado, PendientesLista, Ticket, Via, MODELOS, SIN_CONECTOR, VENTANA_MAX};
use super::motor::{acciones_soportadas, con_categoria, estados_por_defecto, filtra_personas, info, lee_detalle, AccionInput};
use super::motor_tickets::motor_de;
use super::propios::{claves_aceptadas, esta_aceptado, validar_propio, vista_herramientas, ArchivoPropios, ConectorRegistrado, PROPIOS_MAX};
use super::texto::len16;
use super::uso::{costo_valido, limites_efectivos, vueltas_validas};
use crate::features::templates::espacio_del_ticket;
use crate::proveedores::{capacidades_de, motivo_sin_capacidad, nombre_proveedor, proveedor_id_de, TICKETS_EXPERIMENTAL};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

/// Una cuenta tal como la ve este módulo. `cuenta` es el JSON de la cuenta (de ahí salen el agente y sus capacidades).
#[derive(Debug, Clone)]
pub struct CuentaInfo {
    pub id: String,
    pub label: String,
    pub cuenta: Value,
    pub con_sesion: bool,
}

#[derive(Debug, Clone)]
pub struct EspacioInfo {
    pub id: String,
    pub repo_path: String,
    pub ticket: Option<String>,
    pub created_at: f64,
}

pub trait Entorno {
    fn cuentas(&self) -> Vec<CuentaInfo>;
    fn es_directorio(&self, ruta: &str) -> bool;
    fn existe(&self, ruta: &str) -> bool;
    fn ahora(&self) -> f64;
    fn espacios(&self) -> Vec<EspacioInfo>;
    fn repo_key(&self, ruta: &str) -> String;
    /// Lo consumido en las últimas 5 h (tokens), si el agente de la cuenta lo informa.
    fn consumo_5h(&self, cuenta_id: &str) -> f64;
}

pub struct Servicio {
    pub estado: TicketsState,
    pub almacen: Almacen,
    pub registro: Vec<ConectorRegistrado>,
    pub archivo_propios: ArchivoPropios,
    pub avisos_propios: Vec<String>,
    pub cuentas_revisadas: Ordenado<CuentaRevisada>,
    pub corriendo: bool,
    pub revisando: bool,
    pub escribiendo: HashSet<String>,
    /// Acciones que esta cuenta no puede hacer (herramienta inexistente o sin conector), con el motivo.
    pub no_disponible: Ordenado<String>,
    /// Detalle de la última lectura por ticket. Solo en memoria.
    pub detalles: HashMap<String, Detalle>,
}

fn otro<T>(m: impl Into<String>) -> Res<T> {
    Err(ErrorTickets::otro(m))
}

pub fn no_esta(id: &str) -> String {
    format!("El conector «{id}» no está en esta versión de Sloth.")
}

pub fn sin_conector(def: &ConectorDef) -> String {
    format!("Esta cuenta no tiene el conector de {}. Hacelo desde {}.", def.nombre(), def.nombre())
}

fn texto_opcional(v: &Value, max: usize, nombre: &str) -> Res<Option<String>> {
    texto(v, max, nombre)
}

/// Cadena vacía o ausente = no hay.
fn id_opcional(v: Option<&Value>) -> Res<Option<String>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.is_empty() => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        _ => otro("Id inválido."),
    }
}

pub fn origen_a_valor(o: &OrigenConector) -> Value {
    match o {
        OrigenConector::Incluido => json!({ "tipo": "incluido" }),
        OrigenConector::Usuario => json!({ "tipo": "usuario" }),
        OrigenConector::Equipo { repo, equipo } => json!({ "tipo": "equipo", "repo": repo, "equipo": equipo }),
    }
}

pub fn disponibilidad_a_valor(d: &Disponibilidad) -> Value {
    match d {
        Disponibilidad::SinRevisar => json!({ "tipo": "sin_revisar" }),
        Disponibilidad::Falta { parecido: None } => json!({ "tipo": "falta" }),
        Disponibilidad::Falta { parecido: Some((nombre, faltan)) } => json!({ "tipo": "falta", "parecido": { "nombre": nombre, "faltan": faltan } }),
        Disponibilidad::Elegir { opciones } => json!({
            "tipo": "elegir",
            "opciones": opciones.iter().map(|o| json!({ "nombre": o.nombre, "prefijo": o.prefijo, "estado": o.estado })).collect::<Vec<_>>()
        }),
        Disponibilidad::Tiene { nombre, prefijo, estado, adaptado, verificado } => {
            json!({ "tipo": "tiene", "nombre": nombre, "prefijo": prefijo, "estado": estado, "adaptado": adaptado, "verificado": verificado })
        }
    }
}

fn estados_a_valor(xs: &[Estado]) -> Value {
    serde_json::to_value(xs).unwrap_or(Value::Null)
}

impl Servicio {
    pub fn nuevo(almacen: Almacen, estado: TicketsState) -> Self {
        Servicio {
            estado,
            almacen,
            registro: Vec::new(),
            archivo_propios: ArchivoPropios::vacio(),
            avisos_propios: Vec::new(),
            cuentas_revisadas: Ordenado::default(),
            corriendo: false,
            revisando: false,
            escribiendo: HashSet::new(),
            no_disponible: Ordenado::default(),
            detalles: HashMap::new(),
        }
    }

    pub fn registrado(&self, id: &str) -> Option<&ConectorRegistrado> {
        self.registro.iter().find(|r| r.def.id() == id)
    }

    /// Un incluido que nadie probó todavía contra el sistema real: se lee, pero no se escribe.
    pub fn sin_probar(&self, id: &str) -> bool {
        self.registrado(id).is_some_and(|r| r.origen == OrigenConector::Incluido && !r.def.base().verificado)
    }

    pub fn aceptado(&self, env: &dyn Entorno, r: &ConectorRegistrado) -> bool {
        esta_aceptado(r, &self.archivo_propios.aceptados, &|k| env.repo_key(k))
    }

    /// El del equipo elegido que cambió en el repo desde que se aceptó: hay que volver a aceptarlo.
    pub fn cambiado(&self, env: &dyn Entorno, id: &str) -> Option<&ConectorRegistrado> {
        self.registrado(id).filter(|r| matches!(r.origen, OrigenConector::Equipo { .. }) && !self.aceptado(env, r))
    }

    pub fn no_disponible_conector(&self, env: &dyn Entorno, id: &str) -> String {
        match self.cambiado(env, id) {
            Some(r) => format!("El conector «{}» del equipo cambió en el repo: revisalo y aceptalo de nuevo en los ajustes de Tickets.", r.def.nombre()),
            None => no_esta(id),
        }
    }

    /// Un conector del equipo sin aceptar (o que cambió desde que se aceptó) no está disponible.
    pub fn buscar(&self, env: &dyn Entorno, id: &str) -> Option<&ConectorDef> {
        self.registrado(id).filter(|r| self.aceptado(env, r)).map(|r| &r.def)
    }

    pub fn activo(&self, env: &dyn Entorno) -> Res<&ConectorDef> {
        let id = &self.estado.config.conector_id;
        if id == SIN_CONECTOR {
            return otro("Todavía no elegiste un conector. Elegilo en los ajustes de Tickets.");
        }
        self.buscar(env, id).ok_or_else(|| ErrorTickets::otro(self.no_disponible_conector(env, id)))
    }

    fn cuenta(&self, env: &dyn Entorno, id: &str) -> Option<CuentaInfo> {
        env.cuentas().into_iter().find(|c| c.id == id)
    }

    fn elegido_en(&self, def: &ConectorMcp, cuenta_id: &str) -> Option<String> {
        self.estado.config.servidores.as_ref()?.get(cuenta_id)?.get(def.id()).cloned()
    }

    pub fn disp_en(&self, def: &ConectorMcp, cuenta_id: &str) -> Disponibilidad {
        disponibilidad(def, self.cuentas_revisadas.get(cuenta_id), self.elegido_en(def, cuenta_id).as_deref())
    }

    /// Los tickets corren el agente headless: una cuenta de otro agente nunca cuenta, aunque tenga sesión.
    fn logueadas(&self, env: &dyn Entorno) -> Vec<CuentaInfo> {
        env.cuentas().into_iter().filter(|a| sirve_para_tickets(&a.cuenta, ParaQue::Consulta) && a.con_sesion).collect()
    }

    fn otras_con(&self, env: &dyn Entorno, def: &ConectorMcp, cuenta_id: &str) -> Vec<String> {
        self.logueadas(env).into_iter().filter(|a| a.id != cuenta_id && usable(&self.disp_en(def, &a.id))).map(|a| a.label).collect()
    }

    pub fn texto_cuenta(&self, env: &dyn Entorno, def: &ConectorMcp, d: &Disponibilidad, cuenta_id: &str, label: &str) -> Option<String> {
        let motor = self.cuenta(env, cuenta_id).and_then(|a| motor_de(&a.cuenta));
        // Codex no se configura desde claude.ai ni desde /mcp: la persona lo suma con `codex mcp add`, Sloth no toca su config.
        if motor.is_some_and(|m| !m.lee_init()) && matches!(d, Disponibilidad::Falta { parecido: None }) {
            return Some(format!("La cuenta «{label}» no tiene el servidor MCP de {}. Sumalo vos con «codex mcp add» en esa cuenta (Sloth no toca su configuración) y tocá «Volver a revisar».", def.nombre()));
        }
        mensaje_cuenta(def, d, label, &self.otras_con(env, def, cuenta_id))
    }

    /// Corta antes de gastar una consulta cuando ya se sabe que la cuenta no puede leer el conector. Sin revisar o pending, se prueba.
    pub fn chequear_cuenta(&self, env: &dyn Entorno, def: &ConectorMcp, cuenta_id: &str) -> Res<()> {
        let d = self.disp_en(def, cuenta_id);
        let label = self.cuenta(env, cuenta_id).map_or_else(|| cuenta_id.to_string(), |c| c.label);
        let msg = if bloquea_consulta(&d) { self.texto_cuenta(env, def, &d, cuenta_id, &label) } else { None };
        match msg {
            Some(m) => otro(m),
            None => Ok(()),
        }
    }

    /// Columnas del flujo (si la última consulta no trajo, las del conector).
    pub fn estados(&self, def: &ConectorDef) -> Vec<EstadoBase> {
        match &self.estado.estados {
            Some(e) if !e.is_empty() => e.clone(),
            _ => estados_por_defecto(def).into_iter().map(|e| EstadoBase { clave: e.clave, nombre: e.nombre }).collect(),
        }
    }

    /// El conector filtra por personas: lo que se ve es lo propio, lo de las personas elegidas, por estado y dentro de la ventana.
    pub fn con_filtro(def: &ConectorDef) -> bool {
        def.via() == Via::Mcp && filtra_personas(def)
    }

    pub fn tickets_visibles(&self, env: &dyn Entorno, def: &ConectorDef) -> Vec<Ticket> {
        let todos = self.estado.a_tickets();
        if Self::con_filtro(def) {
            visibles(&todos, &filtro_de(&self.estado.config, def), self.estado.me.as_ref(), def, env.ahora())
        } else {
            todos
        }
    }

    fn pendientes_vista(&self, def: &ConectorDef) -> Option<PendientesLista> {
        self.estado.fetched_at?;
        Some(pendientes_de(&filtro_de(&self.estado.config, def), self.estado.leido.as_ref(), def, self.estado.me.as_ref()))
    }

    pub fn last_repo(&self, env: &dyn Entorno) -> Option<String> {
        let mut ws = env.espacios();
        ws.sort_by(|a, b| b.created_at.partial_cmp(&a.created_at).unwrap_or(std::cmp::Ordering::Equal));
        ws.into_iter().find(|w| env.existe(&w.repo_path)).map(|w| w.repo_path)
    }

    /// La carpeta de un ticket: la del proyecto, la por defecto o la del último espacio, la primera que exista.
    pub fn repo_for(&self, env: &dyn Entorno, t: Option<&Ticket>) -> Option<String> {
        let por_proyecto = t.and_then(|t| t.proyecto.as_deref()).and_then(|p| self.estado.config.project_repos.get(p).cloned());
        [por_proyecto, self.estado.config.default_repo.clone(), self.last_repo(env)].into_iter().flatten().find(|p| !p.is_empty() && env.existe(p))
    }

    /// La carpeta de cada ticket (la misma que usa «Empezar»), para que las vistas encuentren su espacio.
    pub fn carpetas_de(&self, env: &dyn Entorno) -> Ordenado<String> {
        let mut out = Ordenado::default();
        for t in self.estado.a_tickets() {
            if let Some(p) = self.repo_for(env, Some(&t)) {
                out.insert(t.id.clone(), p);
            }
        }
        out
    }

    fn motor_experimental(&self, env: &dyn Entorno) -> Option<bool> {
        let id = self.estado.config.query_account_id.as_deref()?;
        let p = proveedor_id_de(&self.cuenta(env, id)?.cuenta)?;
        TICKETS_EXPERIMENTAL.contains(&p).then_some(true)
    }

    fn vista_cuentas(&self, env: &dyn Entorno) -> Value {
        let mcps: Vec<&ConectorMcp> = self.registro.iter().filter(|r| self.aceptado(env, r)).filter_map(|r| r.def.mcp()).collect();
        let mut out = Map::new();
        for a in env.cuentas() {
            let c = self.cuentas_revisadas.get(&a.id);
            let mut v = Map::new();
            if let Some(r) = c.map(|c| c.revisada_en) {
                v.insert("revisadaEn".into(), serde_json::to_value(r).unwrap_or(Value::Null));
            }
            if let Some(e) = c.and_then(|c| c.error.clone()) {
                v.insert("error".into(), json!(e));
            }
            v.insert("servidores".into(), Value::Array(c.map(|c| c.servidores.iter().map(|s| json!({ "nombre": s.nombre, "estado": s.estado })).collect()).unwrap_or_default()));
            let mut conectores = Map::new();
            for def in &mcps {
                conectores.insert(def.id().to_string(), disponibilidad_a_valor(&self.disp_en(def, &a.id)));
            }
            v.insert("conectores".into(), Value::Object(conectores));
            out.insert(a.id.clone(), Value::Object(v));
        }
        Value::Object(out)
    }

    /// Lo que ve la interfaz (`TicketsSnapshot`).
    pub fn snapshot(&self, env: &dyn Entorno) -> Value {
        let id = self.estado.config.conector_id.clone();
        let def = self.buscar(env, &id);
        let mut s = Map::new();
        let i = info(def, &id, self.sin_probar(&id));
        s.insert(
            "conector".into(),
            json!({
                "id": i.id, "nombre": i.nombre, "verificado": i.verificado, "via": i.via, "disponible": i.disponible, "acciones": i.acciones.iter().map(|a| a.como_str()).collect::<Vec<_>>(),
                "leeDetalle": i.lee_detalle, "ejemploId": i.ejemplo_id, "estados": estados_a_valor(&i.estados), "comandoTicket": i.comando_ticket, "idRegex": i.id_regex,
                "idMayusculas": i.id_mayusculas, "filtraPersonas": i.filtra_personas
            }),
        );
        s.insert(
            "conectores".into(),
            Value::Array(
                self.registro
                    .iter()
                    .map(|r| {
                        let mut o = Map::new();
                        o.insert("id".into(), json!(r.def.id()));
                        o.insert("nombre".into(), json!(r.def.nombre()));
                        o.insert("verificado".into(), json!(r.def.base().verificado));
                        o.insert("via".into(), json!(r.def.via()));
                        o.insert("origen".into(), origen_a_valor(&r.origen));
                        if matches!(r.origen, OrigenConector::Equipo { .. }) {
                            o.insert("aceptado".into(), json!(self.aceptado(env, r)));
                        }
                        Value::Object(o)
                    })
                    .collect(),
            ),
        );
        let tickets = def.map(|d| self.tickets_visibles(env, d)).unwrap_or_default();
        s.insert("tickets".into(), serde_json::to_value(&tickets).unwrap_or(Value::Null));
        s.insert("estados".into(), def.map_or(json!([]), |d| estados_a_valor(&con_categoria(d, &self.estados(d)))));
        let mut poner = |k: &str, v: Option<Value>| {
            if let Some(v) = v {
                s.insert(k.into(), v);
            }
        };
        poner("me", self.estado.me.as_ref().and_then(|m| serde_json::to_value(m).ok()));
        poner("fetchedAt", self.estado.fetched_at.and_then(|n| serde_json::to_value(n).ok()));
        poner("fetchedBy", self.estado.fetched_by.clone().map(Value::from));
        poner("lastRun", self.estado.last_run.as_ref().and_then(|r| serde_json::to_value(r).ok()));
        poner("uso", self.estado.uso.as_ref().and_then(|r| serde_json::to_value(r).ok()));
        let last_error = if def.is_some() {
            self.estado.last_error.clone()
        } else if id == SIN_CONECTOR {
            None
        } else if self.cambiado(env, &id).is_some() {
            Some(self.no_disponible_conector(env, &id))
        } else {
            Some(format!("{} Elegí otro en los ajustes.", no_esta(&id)))
        };
        poner("lastError", last_error.map(Value::from));
        poner("pendienteAceptar", if def.is_some() { None } else { self.cambiado(env, &id).map(|r| json!(r.def.id())) });
        poner("aviso", self.almacen.aviso().map(Value::from));
        poner("config", serde_json::to_value(&self.estado.config).ok());
        poner("running", Some(json!(self.corriendo)));
        poner("noDisponible", Some(serde_json::to_value(&self.no_disponible).unwrap_or(Value::Null)));
        poner("lastRepo", self.last_repo(env).map(Value::from));
        poner("carpetas", def.filter(|d| d.via() == Via::Gh).and_then(|_| serde_json::to_value(self.carpetas_de(env)).ok()));
        poner("avisosPropios", (!self.avisos_propios.is_empty()).then(|| json!(self.avisos_propios)));
        poner("cuentas", Some(self.vista_cuentas(env)));
        poner("revisando", Some(json!(self.revisando)));
        poner("motorExperimental", self.motor_experimental(env).map(Value::from));
        if let Some(d) = def.filter(|d| Self::con_filtro(d)) {
            let filtro = filtro_de(&self.estado.config, d);
            let mut c = serde_json::to_value(conteos(&self.estado.a_tickets(), &filtro, self.estado.me.as_ref(), d, env.ahora())).unwrap_or(Value::Null);
            if let Some(n) = self.estado.leido.as_ref().and_then(|l| l.no_leidos).filter(|n| *n > 0) {
                c["noLeidos"] = json!(n);
            }
            s.insert("filtro".into(), serde_json::to_value(&filtro).unwrap_or(Value::Null));
            if let Some(p) = &self.estado.personas {
                s.insert("personas".into(), serde_json::to_value(p).unwrap_or(Value::Null));
            }
            if let Some(a) = self.estado.personas_at {
                s.insert("personasAt".into(), serde_json::to_value(a).unwrap_or(Value::Null));
            }
            s.insert("conteos".into(), c);
            if let Some(p) = self.pendientes_vista(d) {
                s.insert("pendientes".into(), serde_json::to_value(p).unwrap_or(Value::Null));
            }
        }
        Value::Object(s)
    }

    /// Lo que trajo el conector activo, para la vista Equipo (incluye los estados 'hecho' para poder descartarlos).
    pub fn tickets_para_equipo(&self, env: &dyn Entorno) -> Value {
        let id = self.estado.config.conector_id.clone();
        let def = if id == SIN_CONECTOR { None } else { self.buscar(env, &id) };
        let mut o = Map::new();
        o.insert("running".into(), json!(self.corriendo));
        o.insert("model".into(), json!(self.estado.config.model));
        o.insert("confirmar".into(), json!(self.estado.config.confirm_refresh));
        let Some(def) = def else {
            o.insert("conector".into(), Value::Null);
            o.insert("tickets".into(), json!([]));
            o.insert("estados".into(), json!([]));
            if id != SIN_CONECTOR {
                o.insert("lastError".into(), json!(self.no_disponible_conector(env, &id)));
            }
            return Value::Object(o);
        };
        // Primero los que trajo la consulta, con el nombre que se ve en el tablero.
        let mut por_clave: Vec<Estado> = Vec::new();
        for e in con_categoria(def, &self.estados(def)).into_iter().chain(def.estados().iter().cloned()) {
            if !por_clave.iter().any(|x| x.clave == e.clave) {
                por_clave.push(e);
            }
        }
        let todos = self.estado.a_tickets();
        let tickets = if Self::con_filtro(def) { para_equipo(&todos, &filtro_de(&self.estado.config, def), self.estado.me.as_ref(), def, env.ahora()) } else { todos };
        o.insert("conector".into(), json!({ "id": def.id(), "nombre": def.nombre(), "via": def.via() }));
        o.insert("tickets".into(), serde_json::to_value(&tickets).unwrap_or(Value::Null));
        o.insert("estados".into(), estados_a_valor(&por_clave));
        if let Some(v) = self.estado.fetched_at {
            o.insert("fetchedAt".into(), serde_json::to_value(v).unwrap_or(Value::Null));
        }
        if let Some(v) = &self.estado.fetched_by {
            o.insert("fetchedBy".into(), json!(v));
        }
        if let Some(v) = &self.estado.last_run {
            o.insert("lastRun".into(), serde_json::to_value(v).unwrap_or(Value::Null));
        }
        if let Some(v) = &self.estado.last_error {
            o.insert("lastError".into(), json!(v));
        }
        if def.via() == Via::Gh {
            o.insert("carpetas".into(), serde_json::to_value(self.carpetas_de(env)).unwrap_or(Value::Null));
        }
        if Self::con_filtro(def) {
            o.insert("filtro".into(), serde_json::to_value(filtro_de(&self.estado.config, def)).unwrap_or(Value::Null));
            if let Some(p) = &self.estado.personas {
                o.insert("personas".into(), serde_json::to_value(p).unwrap_or(Value::Null));
            }
            if let Some(p) = self.pendientes_vista(def) {
                o.insert("pendientes".into(), serde_json::to_value(p).unwrap_or(Value::Null));
            }
        }
        Value::Object(o)
    }

    /// La cuenta que consulta: con sesión y menos uso en las últimas 5 h; con un conector MCP, entre las que lo tienen (si se
    /// sabe de alguna). `para` filtra por lo que puede hacer el agente de la cuenta.
    pub fn elegir_cuenta_para(&self, env: &dyn Entorno, def: Option<&ConectorDef>, para: ParaQue) -> Res<String> {
        let con_sesion: Vec<CuentaInfo> = env.cuentas().into_iter().filter(|a| sirve_para_tickets(&a.cuenta, para) && a.con_sesion).collect();
        if con_sesion.is_empty() {
            return otro(if para == ParaQue::Consulta { "No hay ninguna cuenta con sesión iniciada." } else { "No hay ninguna cuenta de Claude Code con sesión iniciada." });
        }
        let candidatas: Vec<Candidata> = con_sesion
            .iter()
            .map(|a| Candidata {
                id: a.id.clone(),
                con_conector: def.and_then(|d| d.mcp()).is_some_and(|m| usable(&self.disp_en(m, &a.id))),
                con_uso: capacidades_de(&a.cuenta).is_some_and(|c| c.uso),
                consumo: env.consumo_5h(&a.id),
            })
            .collect();
        elegir_cuenta(&candidatas).map_or_else(|| otro("No hay ninguna cuenta con sesión iniciada."), Ok)
    }

    /// ¿Hay una carpeta de repo para crear el espacio de este ticket? (sin crear nada).
    pub fn tiene_repo(&self, env: &dyn Entorno, raw_id: &Value) -> Res<bool> {
        let id = ticket_id(self.activo(env)?, raw_id)?;
        let tickets = self.estado.a_tickets();
        Ok(self.repo_for(env, tickets.iter().find(|t| t.id == id)).is_some())
    }

    /// «Empezar en Sloth»: el espacio que ya existe, o la carpeta y la cuenta con las que crear uno. El comando de la
    /// terminal es `<comando> <id>` si el conector declara uno.
    pub fn planear_inicio(&self, env: &dyn Entorno, raw_id: &Value, raw_cuenta: &Value) -> Res<PlanInicio> {
        let def = self.activo(env)?;
        let id = ticket_id(def, raw_id)?;
        let comando = super::motor::comando_de_ticket(def);
        let tickets = self.estado.a_tickets();
        let repo_path = self.repo_for(env, tickets.iter().find(|t| t.id == id));
        let espacios = env.espacios();
        if let Some(e) = espacio_del_ticket(&espacios, &id, repo_path.as_deref(), def.via() == Via::Gh, |w| (w.ticket.as_deref(), w.repo_path.as_str())) {
            return Ok(PlanInicio::Existente { espacio_id: e.id.clone() });
        }
        let Some(repo_path) = repo_path else { return otro("No hay carpeta de repo para este ticket. Creá el espacio desde Nuevo espacio y elegí la carpeta.") };
        let cuenta_id = match raw_cuenta.as_str().filter(|s| !s.is_empty()) {
            Some(rc) => {
                let Some(acc) = self.cuenta(env, rc).filter(|a| a.con_sesion) else { return otro("Esa cuenta no tiene sesión iniciada.") };
                if !sirve_para_tickets(&acc.cuenta, ParaQue::Trabajo) {
                    let m = motivo_sin_capacidad(&acc.cuenta, "tickets").unwrap_or_else(|| "no puede trabajar por ticket.".into());
                    return otro(format!("La cuenta «{}» es de {}: {m}", acc.label, nombre_proveedor(&acc.cuenta)));
                }
                acc.id
            }
            None => self.elegir_cuenta_para(env, None, ParaQue::Trabajo)?,
        };
        let prompt_inicial = comando.map(|c| format!("{c} {id}"));
        Ok(PlanInicio::Crear { id, repo_path, cuenta_id, prompt_inicial })
    }

    /// Todo se valida antes de tocar nada: los argumentos del IPC no vienen validados. Cambiar el filtro no consulta.
    pub fn set_filtro(&mut self, env: &dyn Entorno, raw: &Value) -> Res<()> {
        let Some(p) = raw.as_object() else { return otro("Filtro inválido.") };
        let def = self.activo(env)?.clone();
        if !Self::con_filtro(&def) {
            return otro(format!("{} no filtra por personas desde Sloth.", def.nombre()));
        }
        let mut c = self.estado.config.clone();
        if let Some(v) = p.get("personasElegidas") {
            let Some(v) = personas_validas(&def, v) else { return otro("Las personas elegidas no son válidas (hasta 20, con el id que da el conector).") };
            if let Some(conocidas) = &self.estado.personas {
                if v.iter().any(|id| !conocidas.iter().any(|x| &x.id == id)) {
                    return otro("Esa persona no está en la lista. Actualizá las personas.");
                }
            }
            c.personas_elegidas = (!v.is_empty()).then_some(v);
        }
        if let Some(v) = p.get("incluirSinAsignar") {
            let Some(b) = v.as_bool() else { return otro("«Sin asignar» tiene que ser sí o no.") };
            c.incluir_sin_asignar = b.then_some(true);
        }
        if let Some(v) = p.get("estadosElegidos") {
            let claves: Vec<String> = def.estados().iter().map(|e| e.clave.clone()).collect();
            let valido = if v.is_null() { Some(vec![]) } else { estados_validos(v, &claves) };
            let Some(v) = valido else { return otro(format!("Algún estado elegido no es de {}.", def.nombre())) };
            c.estados_elegidos = (!v.is_empty()).then_some(v);
        }
        if let Some(v) = p.get("ventanaDias") {
            if v.is_null() {
                c.ventana_dias = None;
            } else {
                let Some(n) = ventana_valida(v) else { return otro(format!("La ventana va de 1 a {VENTANA_MAX} días.")) };
                c.ventana_dias = Some(n);
            }
        }
        self.estado.config = c;
        self.guardar();
        Ok(())
    }

    pub fn guardar(&mut self) {
        self.almacen.guardar(&self.estado);
    }

    fn sin_nada_en_curso(&self) -> Res<()> {
        if self.corriendo || !self.escribiendo.is_empty() {
            return otro("Esperá a que termine lo que está en curso.");
        }
        Ok(())
    }

    /// El id del conector al que se pasa, o None si es el mismo. No cambia nada.
    pub fn conector_nuevo(&self, env: &dyn Entorno, v: &Value) -> Res<Option<String>> {
        let en_curso = || self.corriendo || !self.escribiendo.is_empty();
        if v.as_str() == Some(SIN_CONECTOR) {
            if self.estado.config.conector_id == SIN_CONECTOR {
                return Ok(None);
            }
            if en_curso() {
                return otro("Esperá a que termine lo que está en curso para cambiar de conector.");
            }
            return Ok(Some(SIN_CONECTOR.to_string()));
        }
        let Some(r) = v.as_str().and_then(|id| self.registrado(id)) else { return otro("Ese conector no está en esta versión de Sloth.") };
        if !self.aceptado(env, r) {
            return otro("Antes de usar un conector del equipo, revisalo y aceptalo.");
        }
        let id = r.def.id().to_string();
        if id == self.estado.config.conector_id {
            return Ok(None);
        }
        if en_curso() {
            return otro("Esperá a que termine lo que está en curso para cambiar de conector.");
        }
        Ok(Some(id))
    }

    /// Elige (o con prefijo '' olvida) qué servidor de una cuenta usa un conector. Devuelve el mapa nuevo.
    pub fn servidor_elegido(&self, env: &dyn Entorno, raw: &Value, previos: Option<&Ordenado<Ordenado<String>>>, nuevo: Option<&str>) -> Res<Option<Ordenado<Ordenado<String>>>> {
        let o = raw.as_object();
        let campo = |k: &str| o.and_then(|o| o.get(k)).and_then(Value::as_str);
        let (Some(cuenta_id), Some(conector), Some(prefijo)) = (campo("cuenta"), campo("conector"), campo("prefijo")) else { return otro("Servidor inválido.") };
        if self.cuenta(env, cuenta_id).is_none() {
            return otro("Esa cuenta no existe.");
        }
        let Some(def) = self.buscar(env, conector).and_then(ConectorDef::mcp) else { return otro(no_esta(conector)) };
        let mut por_cuenta: Ordenado<String> = previos.and_then(|p| p.get(cuenta_id)).cloned().unwrap_or_default();
        if prefijo.is_empty() {
            por_cuenta.remove(conector);
        } else {
            let servidores = self.cuentas_revisadas.get(cuenta_id).map(|c| c.servidores.clone()).unwrap_or_default();
            if !elegibles(def, &servidores).iter().any(|s| s.prefijo == prefijo) {
                return otro("Ese servidor no está en esa cuenta. Tocá «Volver a revisar».");
            }
            por_cuenta.insert(conector, prefijo.to_string());
        }
        // Cambiar el servidor del conector activo en la cuenta que consulta deja de lado lo leído con el otro.
        let en_uso = conector == nuevo.unwrap_or(self.estado.config.conector_id.as_str()) && Some(cuenta_id) == self.estado.config.query_account_id.as_deref();
        if en_uso && (self.corriendo || !self.escribiendo.is_empty()) {
            return otro("Esperá a que termine lo que está en curso para cambiar de servidor.");
        }
        let mut out = previos.cloned().unwrap_or_default();
        if por_cuenta.is_empty() {
            out.remove(cuenta_id);
        } else {
            out.insert(cuenta_id, por_cuenta);
        }
        Ok((!out.is_empty()).then_some(out))
    }

    fn dir(&self, env: &dyn Entorno, v: &Value, nombre: &str) -> Res<Option<String>> {
        let Some(s) = texto_opcional(v, 400, nombre)? else { return Ok(None) };
        if !env.es_directorio(&s) {
            return otro(format!("{nombre}: la carpeta no existe."));
        }
        Ok(Some(s))
    }

    /// Todo se valida sobre una copia: si algo falla, no queda nada aplicado a medias.
    pub fn set_config(&mut self, env: &dyn Entorno, raw: &Value) -> Res<()> {
        let Some(p) = raw.as_object() else { return otro("Configuración inválida.") };
        let nuevo = match p.get("conectorId") {
            Some(v) => self.conector_nuevo(env, v)?,
            None => None,
        };
        let mut c = self.estado.config.clone();
        let id_destino = nuevo.clone().unwrap_or_else(|| self.estado.config.conector_id.clone());
        if let Some(id) = p.get("queryAccountId") {
            match id {
                Value::Null => c.query_account_id = None,
                Value::String(s) if s.is_empty() => c.query_account_id = None,
                Value::String(s) => {
                    let Some(acc) = self.cuenta(env, s) else { return otro("Esa cuenta no existe.") };
                    if !sirve_para_tickets(&acc.cuenta, ParaQue::Consulta) {
                        let m = motivo_sin_capacidad(&acc.cuenta, "ticketsHeadless").unwrap_or_else(|| "no consulta tickets.".into());
                        return otro(format!("La cuenta «{}» es de {}: {m}", acc.label, nombre_proveedor(&acc.cuenta)));
                    }
                    if let Some(m) = self.buscar(env, &id_destino).and_then(ConectorDef::mcp) {
                        if Some(s.as_str()) != self.estado.config.query_account_id.as_deref() && matches!(self.disp_en(m, s), Disponibilidad::Falta { .. }) {
                            if let Some(msg) = self.texto_cuenta(env, m, &Disponibilidad::Falta { parecido: None }, s, &acc.label) {
                                return otro(msg);
                            }
                        }
                    }
                    c.query_account_id = Some(s.clone());
                }
                _ => return otro("Esa cuenta no existe."),
            }
        }
        if let Some(s) = p.get("servidor") {
            c.servidores = self.servidor_elegido(env, s, c.servidores.as_ref(), nuevo.as_deref())?;
        }
        if let Some(m) = p.get("model") {
            match m.as_str() {
                Some(m) if MODELOS.contains(&m) => c.model = m.to_string(),
                _ => return otro("Modelo inválido."),
            }
        }
        if let Some(a) = p.get("assigneeId") {
            let s = texto(a, ASSIGNEE_MAX, "El id de persona")?.unwrap_or_default();
            let def = self.buscar(env, &id_destino);
            if !assignee_valido(&s, def) {
                return otro(match def {
                    Some(d) => format!("Ese id de persona no tiene el formato de {}.", d.nombre()),
                    None => "El id de persona solo lleva letras, números y guiones.".to_string(),
                });
            }
            c.assignee_id = s;
        }
        if let Some(d) = p.get("defaultRepo") {
            c.default_repo = self.dir(env, d, "Repo por defecto")?;
        }
        // Con gh la carpeta es el repo de donde salen los tickets: lo leído de la anterior ya no corresponde.
        let otra_carpeta_gh = nuevo.is_none() && c.default_repo != self.estado.config.default_repo && self.buscar(env, &self.estado.config.conector_id).is_some_and(|d| d.via() == Via::Gh);
        if otra_carpeta_gh && (self.corriendo || !self.escribiendo.is_empty()) {
            return otro("Esperá a que termine lo que está en curso para cambiar la carpeta.");
        }
        if let Some(pr) = p.get("projectRepo") {
            let vacio = Map::new();
            let pr = pr.as_object().unwrap_or(&vacio);
            let nulo = Value::Null;
            let project = texto_obligatorio(pr.get("project").unwrap_or(&nulo), 80, "El proyecto")?;
            let repo = self.dir(env, pr.get("repo").unwrap_or(&nulo), &format!("Repo de {project}"))?;
            match repo {
                Some(r) => c.project_repos.insert(project, r),
                None => {
                    c.project_repos.remove(&project);
                }
            }
        }
        if let Some(v) = p.get("confirmRefresh") {
            c.confirm_refresh = v != &Value::Bool(false);
        }
        if let Some(v) = p.get("maxTurns") {
            if v.is_null() || v.as_str() == Some("") {
                c.max_turns = None;
            } else {
                let Some(n) = vueltas_validas(v) else { return otro("El tope de vueltas va de 1 a 200.") };
                c.max_turns = Some(super::texto::Num(f64::from(n)));
            }
        }
        if let Some(v) = p.get("maxCostUsd") {
            if v.is_null() || v.as_str() == Some("") {
                c.max_cost_usd = None;
            } else {
                let Some(n) = costo_valido(v) else { return otro("El tope de costo va de 0,01 a 100 dólares.") };
                c.max_cost_usd = Some(super::texto::Num(n));
            }
        }
        if let Some(n) = nuevo {
            // Pasar a otro conector deja de lado lo leído con el anterior.
            self.estado = con_conector(&self.estado, &n);
            self.no_disponible = Ordenado::default();
            self.detalles.clear();
            c.conector_id = n.clone();
            c.assignee_previos = self.estado.config.assignee_previos.clone();
            if !p.contains_key("assigneeId") {
                // El que se recupera se guardó con otro conector cargado: se vuelve a validar con este.
                let previo = self.estado.config.assignee_id.clone();
                c.assignee_id = if assignee_valido(&previo, self.buscar(env, &n)) { previo } else { String::new() };
            }
        } else if otra_carpeta_gh {
            self.estado = sin_lista(&self.estado);
            self.no_disponible = Ordenado::default();
            self.detalles.clear();
        }
        self.estado.config = c;
        self.guardar();
        Ok(())
    }

    fn pasar_a(&mut self, id: &str) {
        self.estado = con_conector(&self.estado, id);
        self.no_disponible = Ordenado::default();
        self.detalles.clear();
    }

    pub fn guardar_propio(&mut self, raw: &Value, raw_anterior: &Value, incluidos: &[ConectorDef]) -> Res<ArchivoPropios> {
        let def = validar_propio(raw).map_err(ErrorTickets::from)?;
        let anterior = id_opcional(Some(raw_anterior))?;
        let actuales = &self.archivo_propios.conectores;
        if anterior.as_deref().is_some_and(|a| !actuales.iter().any(|c| c.id() == a)) {
            return otro("Ese conector propio ya no existe.");
        }
        if incluidos.iter().any(|c| c.id() == def.id()) {
            return otro(format!("«{}» es el id de un conector incluido. Elegí otro.", def.id()));
        }
        let ocupado = Some(def.id()) != anterior.as_deref() && (actuales.iter().any(|c| c.id() == def.id()) || self.registro.iter().any(|r| r.def.id() == def.id()));
        if ocupado {
            return otro(format!("Ya hay un conector «{}». Elegí otro id.", def.id()));
        }
        if anterior.is_none() && actuales.len() >= PROPIOS_MAX {
            return otro(format!("Podés tener hasta {PROPIOS_MAX} conectores propios."));
        }
        let era_activo = anterior.as_deref().is_some_and(|a| a == self.estado.config.conector_id);
        if era_activo {
            self.sin_nada_en_curso()?;
        }
        let conectores: Vec<ConectorDef> = match &anterior {
            None => actuales.iter().cloned().chain([def.clone()]).collect(),
            Some(a) => actuales.iter().map(|c| if c.id() == a { def.clone() } else { c.clone() }).collect(),
        };
        let nuevo = ArchivoPropios { conectores, ..self.archivo_propios.clone() };
        if era_activo && Some(def.id()) != anterior.as_deref() {
            self.pasar_a(def.id());
        } else if era_activo {
            self.no_disponible = Ordenado::default();
            self.detalles.clear();
        }
        Ok(nuevo)
    }

    pub fn borrar_propio(&mut self, raw_id: &Value) -> Res<ArchivoPropios> {
        let id = id_opcional(Some(raw_id))?;
        let Some(id) = id.filter(|i| self.archivo_propios.conectores.iter().any(|c| c.id() == i)) else {
            return otro("Ese conector propio ya no existe. Los del equipo se sacan de .sloth/conectores.json.");
        };
        let era_activo = id == self.estado.config.conector_id;
        if era_activo {
            self.sin_nada_en_curso()?;
        }
        let nuevo = ArchivoPropios { conectores: self.archivo_propios.conectores.iter().filter(|c| c.id() != id).cloned().collect(), ..self.archivo_propios.clone() };
        if era_activo {
            self.pasar_a(SIN_CONECTOR);
        }
        Ok(nuevo)
    }

    fn no_incluido(&self, v: &Value) -> Res<&ConectorRegistrado> {
        match v.as_str().and_then(|id| self.registrado(id)) {
            Some(r) if r.origen != OrigenConector::Incluido => Ok(r),
            _ => otro("Ese conector propio ya no existe."),
        }
    }

    /// Lo que se guarda al aceptar un conector del equipo: una clave por copia del repo, con el hash que se miró.
    pub fn aceptar(&self, env: &dyn Entorno, raw_id: &Value, raw_hash: &Value) -> Res<ArchivoPropios> {
        let r = self.no_incluido(raw_id)?;
        if !matches!(r.origen, OrigenConector::Equipo { .. }) {
            return otro("Solo se aceptan los conectores del equipo.");
        }
        if raw_hash.as_str() != Some(r.hash.as_str()) {
            return otro("El conector del equipo cambió mientras lo mirabas. Revisalo de nuevo.");
        }
        let mut a = self.archivo_propios.clone();
        for k in claves_aceptadas(r, &|k| env.repo_key(k)) {
            a.aceptados.insert(k, r.hash.clone());
        }
        Ok(a)
    }

    pub fn vista_propio(&self, env: &dyn Entorno, r: &ConectorRegistrado, def: &ConectorMcp) -> Value {
        json!({
            "id": def.id(), "nombre": def.nombre(), "origen": origen_a_valor(&r.origen), "aceptado": self.aceptado(env, r), "hash": r.hash,
            "herramientas": herramientas_a_valor(&vista_herramientas(def))
        })
    }

    /// Los propios y los del equipo (los incluidos no) que son de vía mcp.
    pub fn lista_propios(&self, env: &dyn Entorno) -> Vec<Value> {
        self.registro.iter().filter(|r| r.origen != OrigenConector::Incluido).filter_map(|r| r.def.mcp().map(|m| self.vista_propio(env, r, m))).collect()
    }

    /// Los argumentos de «Actualizar»: modo, tope de vueltas. Devuelve las vueltas a usar y si se pidió solo lo que falta.
    pub fn args_de_refresh(&self, raw_vueltas: &Value, raw_modo: &Value) -> Res<(u32, bool)> {
        if self.corriendo {
            return otro("Ya hay una consulta en curso.");
        }
        let solo_faltante = match raw_modo {
            Value::Null => false,
            Value::String(m) if m == "todo" => false,
            Value::String(m) if m == "faltante" => true,
            _ => return otro("Modo de actualización inválido."),
        };
        let mut usadas = limites_efectivos(self.estado.config.max_turns.map(|n| n.0), self.estado.config.max_cost_usd.map(|n| n.0)).vueltas;
        if !raw_vueltas.is_null() {
            let Some(v) = vueltas_validas(raw_vueltas) else { return otro("Tope de vueltas inválido.") };
            usadas = v;
        }
        Ok((usadas, solo_faltante))
    }

    pub fn ticket_en_lista(&self, def: &ConectorDef, id: &str) -> Res<Ticket> {
        self.estado.tickets.iter().map(ticket_de_obj).find(|t| t.id == id).ok_or_else(|| ErrorTickets::otro(format!("Ese ticket ya no está en la lista. Actualizá {}.", def.nombre())))
    }

    /// Lo que hay que saber antes de leer el detalle de un ticket: su id y el ticket de la lista.
    pub fn preparar_detalle(&self, env: &dyn Entorno, raw_id: &Value) -> Res<(String, Ticket)> {
        let def = self.activo(env)?;
        if !lee_detalle(def) {
            return otro(format!("{} no tiene detalle de tickets en Sloth.", def.nombre()));
        }
        let id = ticket_id(def, raw_id)?;
        let t = self.ticket_en_lista(def, &id)?;
        Ok((id, t))
    }

    /// Valida una acción pedida con un clic. `None` = no hay nada que hacer (ya estaba así).
    pub fn preparar_accion(&self, env: &dyn Entorno, raw_a: &Value, raw_id: &Value, raw_in: &Value) -> Res<Option<(Accion, Ticket, AccionInput)>> {
        let Some(a) = es_accion(raw_a) else { return otro("Acción inválida.") };
        let def = self.activo(env)?;
        if !acciones_soportadas(def).contains(&a) {
            return otro(format!("{} no permite esa acción desde Sloth.", def.nombre()));
        }
        if self.sin_probar(def.id()) {
            return otro(format!("Las acciones de {} todavía no se probaron: por ahora es de solo lectura. Si querés escribir, copialo como propio y revisá sus herramientas.", def.nombre()));
        }
        let id = ticket_id(def, raw_id)?;
        let t = self.ticket_en_lista(def, &id)?;
        if self.escribiendo.contains(&id) {
            return otro("Ya hay un cambio en curso en este ticket.");
        }
        if let Some(no) = self.no_disponible.get(a.como_str()) {
            return otro(no.clone());
        }
        let ctx = Contexto { estados: self.estados(def), me: self.estado.me.clone(), detalle: self.detalles.get(&id).cloned() };
        Ok(entrada_de_accion(def, a, &t, raw_in, &ctx)?.map(|i| (a, t, i)))
    }

    /// Qué cuentas revisar: todas las que sirven con sesión, o la pedida.
    pub fn ids_a_revisar(&self, env: &dyn Entorno, raw: &Value) -> Res<Vec<String>> {
        let ids = match raw {
            Value::Null => self.logueadas(env).into_iter().map(|a| a.id).collect(),
            Value::String(s) if s.is_empty() => self.logueadas(env).into_iter().map(|a| a.id).collect(),
            Value::String(s) if self.cuenta(env, s).is_some() => vec![s.clone()],
            _ => return otro("Esa cuenta no existe."),
        };
        if self.revisando {
            return otro("Ya se están revisando las cuentas. Esperá a que termine.");
        }
        if self.corriendo {
            return otro("Esperá a que termine la consulta en curso.");
        }
        Ok(ids)
    }

    /// El prefijo para descubrir herramientas: nunca llega al prompt sin validar.
    pub fn prefijo_a_descubrir(&self, raw: &Value) -> Res<String> {
        let Some(p) = raw.as_str().filter(|p| len16(p) <= 64) else { return otro("Prefijo inválido.") };
        super::descubrir::build_descubrir_prompt(p)?;
        if self.revisando {
            return otro("Ya se están buscando herramientas. Esperá a que termine.");
        }
        Ok(p.to_string())
    }

    /// Antes de «Probar» un conector: que se pueda y que no haya nada corriendo.
    pub fn preparar_probar(&self, env: &dyn Entorno) -> Res<&ConectorMcp> {
        let def = self.activo(env)?;
        let Some(m) = def.mcp() else { return otro(format!("{} no usa un servidor MCP: no hay nada que probar.", def.nombre())) };
        if self.revisando {
            return otro("Ya se están revisando las cuentas. Esperá a que termine.");
        }
        if self.corriendo || !self.escribiendo.is_empty() {
            return otro("Esperá a que termine lo que está en curso.");
        }
        Ok(m)
    }

    /// El detalle ya leído sigue valiendo mientras el ticket esté en la lista.
    pub fn guardar_detalle(&mut self, id: &str, d: Detalle) {
        self.detalles.insert(id.to_string(), d);
    }

    pub fn leido(&self) -> Option<&AlcanceLeido> {
        self.estado.leido.as_ref()
    }

}

#[derive(Debug, Clone, PartialEq)]
pub enum PlanInicio {
    Existente { espacio_id: String },
    Crear { id: String, repo_path: String, cuenta_id: String, prompt_inicial: Option<String> },
}

fn herramientas_a_valor(h: &super::modelo::HerramientasVista) -> Value {
    let acciones: Map<String, Value> = h.acciones.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
    let escritura: Map<String, Value> = h.escritura.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
    let pistas_acciones: Map<String, Value> = h
        .pistas
        .acciones
        .iter()
        .map(|(k, (args, nota))| {
            let mut o = Map::new();
            o.insert("args".into(), json!(args));
            if let Some(n) = nota {
                o.insert("nota".into(), json!(n));
            }
            (k.clone(), Value::Object(o))
        })
        .collect();
    let mut pistas = Map::new();
    pistas.insert("yoConId".into(), json!(h.pistas.yo_con_id));
    pistas.insert("yoSinId".into(), json!(h.pistas.yo_sin_id));
    pistas.insert("lista".into(), json!(h.pistas.lista));
    if let Some(e) = &h.pistas.estados {
        pistas.insert("estados".into(), json!(e));
    }
    if let Some(a) = &h.pistas.apoyo {
        pistas.insert("apoyo".into(), json!(a));
    }
    pistas.insert("detalle".into(), json!(h.pistas.detalle));
    pistas.insert("acciones".into(), Value::Object(pistas_acciones));
    json!({
        "prefijo": h.prefijo, "lista": h.lista, "detalle": h.detalle, "acciones": acciones, "escritura": escritura, "negar": h.negar,
        "comandoTicket": h.comando_ticket, "pistas": pistas
    })
}
