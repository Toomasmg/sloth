//! Estado persistido de tickets (tickets.json v2) y la migración desde gruv.json v1. Sin fs: quien llama lee los archivos
//! y hace lo que diga `resolver_estado` (ver almacen.rs). Equivale a src/main/features/tickets/estado.ts.
use super::alcance::{estados_validos, personas_validas, ventana_valida};
use super::conector::{regex_de_persona, ConectorDef, ID_CONECTOR_RE, ID_MAX, ID_SEGURO_RE, PREFIJO_RE};
use super::conectores::CONECTOR_LEGADO;
use super::modelo::{AlcanceLeido, Corrida, EstadoBase, Ordenado, PersonaEquipo, Ticket, TicketsConfig, Tope, UsoPorDia, Yo, MODELOS, SIN_CONECTOR};
use super::motor::{id_valido, norm_estado, normalize_estados, normalize_personas, norm_yo};
use super::texto::{len16, numero, re, Num};
use super::uso::{costo_valido, sanear_uso, vueltas_validas};
use serde::Serialize;
use serde_json::{Map, Value};

pub type Obj = Map<String, Value>;

/// `Error`: el archivo está pero no se pudo leer (bloqueado, sin permiso…); no es lo mismo que corrupto.
#[derive(Debug, Clone, PartialEq)]
pub enum Lectura {
    Falta,
    Corrupto,
    Error(String),
    Ok { json: Value, mtime_ms: f64 },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MigradoDe {
    pub archivo: String,
    pub en: Num,
    #[serde(rename = "gruvMtimeMs", skip_serializing_if = "Option::is_none")]
    pub gruv_mtime_ms: Option<Num>,
}

/// Los tickets quedan como objetos JSON: un tickets.json editado a mano puede traer tickets sin título, y el TypeScript
/// los conserva tal cual (con sus claves en su orden). `a_tickets` los tipa para el resto de la lógica.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TicketsState {
    pub version: u32,
    pub tickets: Vec<Obj>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estados: Option<Vec<EstadoBase>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub me: Option<Yo>,
    #[serde(rename = "fetchedAt", skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<Num>,
    #[serde(rename = "fetchedBy", skip_serializing_if = "Option::is_none")]
    pub fetched_by: Option<String>,
    /// Prefijo del servidor MCP con el que se leyó la lista: el detalle y las escrituras van al mismo.
    #[serde(rename = "leidoCon", skip_serializing_if = "Option::is_none")]
    pub leido_con: Option<String>,
    #[serde(rename = "lastRun", skip_serializing_if = "Option::is_none")]
    pub last_run: Option<Corrida>,
    /// Lo gastado por día y conector, para el acumulado de Ajustes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uso: Option<UsoPorDia>,
    #[serde(rename = "lastError", skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub personas: Option<Vec<PersonaEquipo>>,
    #[serde(rename = "personasAt", skip_serializing_if = "Option::is_none")]
    pub personas_at: Option<Num>,
    /// Qué cubre `tickets`: lo que falta leer al cambiar el filtro se pide aparte.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leido: Option<AlcanceLeido>,
    /// `gruv_mtime_ms`: el mtime del gruv.json migrado; si gruv.json cambia, se vuelve a migrar.
    #[serde(rename = "migradoDe", skip_serializing_if = "Option::is_none")]
    pub migrado_de: Option<MigradoDe>,
    pub config: TicketsConfig,
}

impl TicketsState {
    pub fn a_valor(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    pub fn a_tickets(&self) -> Vec<Ticket> {
        self.tickets.iter().map(ticket_de_obj).collect()
    }
}

/// Un ticket del archivo como `Ticket`: sin título queda vacío y lo que no tenga la forma esperada se descarta.
pub fn ticket_de_obj(o: &Obj) -> Ticket {
    let mut copia = o.clone();
    if !matches!(copia.get("titulo"), Some(Value::String(_))) {
        copia.insert("titulo".into(), Value::String(String::new()));
    }
    serde_json::from_value(Value::Object(copia)).unwrap_or_else(|_| {
        let id = o.get("id").and_then(Value::as_str).unwrap_or("");
        let titulo = o.get("titulo").and_then(Value::as_str).unwrap_or("");
        Ticket::nuevo(id, titulo)
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Respaldar {
    Corrupto,
    Previo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origen {
    Tickets,
    Gruv,
    Vacio,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SoloLectura {
    Ilegible,
    VersionFutura,
    GruvIlegible,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResultadoCarga {
    pub state: TicketsState,
    pub origen: Origen,
    /// Antes de guardar, tickets.json se aparta: ilegible (.corrupt) o válido pero reemplazado (.bak).
    pub respaldar: Option<Respaldar>,
    pub guardar: bool,
    /// Si hay motivo, tickets.json no se toca en toda la sesión: se trabaja en memoria.
    pub solo_lectura: Option<SoloLectura>,
}

pub type Buscar<'a> = &'a dyn Fn(&str) -> Option<&'a ConectorDef>;

pub const ASSIGNEE_MAX: usize = 80;

/// El id de persona va al prompt de la lista: vacío o con la forma que pide el conector (si no pide ninguna, letras,
/// números y guiones).
pub fn assignee_valido(s: &str, def: Option<&ConectorDef>) -> bool {
    if s.is_empty() {
        return true;
    }
    if len16(s) > ASSIGNEE_MAX {
        return false;
    }
    match def {
        Some(d) if d.base().persona_id.is_some() => regex_de_persona(d.base()).is_match(s),
        _ => re(r"^[A-Za-z0-9-]+$").is_match(s),
    }
}

fn no_vacio(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

fn num(v: Option<&Value>) -> Option<Num> {
    v.and_then(numero).map(Num)
}

pub fn estado_vacio(conector_id: &str) -> TicketsState {
    TicketsState {
        version: 2,
        tickets: Vec::new(),
        estados: None,
        me: None,
        fetched_at: None,
        fetched_by: None,
        leido_con: None,
        last_run: None,
        uso: None,
        last_error: None,
        personas: None,
        personas_at: None,
        leido: None,
        migrado_de: None,
        config: TicketsConfig::nueva(conector_id),
    }
}

/// Saca el BOM; null → falta, JSON roto → corrupto.
pub fn parsear_archivo(texto: Option<&str>, mtime_ms: f64) -> Lectura {
    let Some(t) = texto else { return Lectura::Falta };
    match serde_json::from_str::<Value>(t.strip_prefix('\u{feff}').unwrap_or(t)) {
        Ok(json) => Lectura::Ok { json, mtime_ms },
        Err(_) => Lectura::Corrupto,
    }
}

const PREVIOS_MAX: usize = 20;

fn sanear_previos(raw: Option<&Value>, buscar: Buscar) -> Option<Ordenado<String>> {
    let obj = raw?.as_object()?;
    let clave_ok = re(r"^[a-z0-9][a-z0-9_-]{0,39}$");
    let mut out: Ordenado<String> = Ordenado::default();
    for (k, v) in obj {
        if out.len() >= PREVIOS_MAX {
            break;
        }
        let Some(s) = v.as_str().filter(|s| !s.is_empty() && len16(s) <= ASSIGNEE_MAX) else { continue };
        if !clave_ok.is_match(k) {
            continue;
        }
        if let Some(def) = buscar(k) {
            if !assignee_valido(s, Some(def)) {
                continue;
            }
        }
        out.insert(k.clone(), s.to_string());
    }
    (!out.is_empty()).then_some(out)
}

const SERVIDORES_CUENTAS_MAX: usize = 50;

/// cuentaId → conectorId → prefijo; vacío da None.
fn sanear_servidores(raw: Option<&Value>) -> Option<Ordenado<Ordenado<String>>> {
    let obj = raw?.as_object()?;
    let id_ok = re(ID_CONECTOR_RE);
    let prefijo_ok = re(PREFIJO_RE);
    let mut out: Ordenado<Ordenado<String>> = Ordenado::default();
    for (cuenta, por_conector) in obj.iter().take(SERVIDORES_CUENTAS_MAX) {
        let Some(por_conector) = por_conector.as_object() else { continue };
        if cuenta.is_empty() || len16(cuenta) > 64 || cuenta == "__proto__" {
            continue;
        }
        let mut elegidos: Ordenado<String> = Ordenado::default();
        for (id, prefijo) in por_conector {
            if let Some(p) = prefijo.as_str() {
                if id_ok.is_match(id) && len16(p) <= 64 && prefijo_ok.is_match(p) {
                    elegidos.insert(id.clone(), p.to_string());
                }
            }
        }
        if !elegidos.is_empty() {
            out.insert(cuenta.clone(), elegidos);
        }
    }
    (!out.is_empty()).then_some(out)
}

fn sanear_config(raw: Option<&Value>, buscar: Buscar) -> TicketsConfig {
    let vacio = Obj::new();
    let c = raw.and_then(Value::as_object).unwrap_or(&vacio);
    let conector_id = match c.get("conectorId") {
        Some(Value::String(s)) if s == SIN_CONECTOR => SIN_CONECTOR.to_string(),
        Some(Value::String(s)) if re(ID_CONECTOR_RE).is_match(s) => s.clone(),
        _ => CONECTOR_LEGADO.to_string(),
    };
    let def = buscar(&conector_id);
    let mut project_repos: Ordenado<String> = Ordenado::default();
    if let Some(repos) = c.get("projectRepos").and_then(Value::as_object) {
        for (k, v) in repos {
            if let Some(s) = v.as_str() {
                project_repos.insert(k.clone(), s.to_string());
            }
        }
    }
    let mut cfg = TicketsConfig::nueva(&conector_id);
    cfg.query_account_id = no_vacio(c.get("queryAccountId"));
    cfg.model = match c.get("model").and_then(Value::as_str) {
        Some(m) if MODELOS.contains(&m) => m.to_string(),
        _ => "haiku".into(),
    };
    cfg.assignee_id = match c.get("assigneeId").and_then(Value::as_str) {
        Some(s) if assignee_valido(s, def) => s.to_string(),
        _ => String::new(),
    };
    cfg.assignee_previos = sanear_previos(c.get("assigneePrevios"), buscar);
    cfg.default_repo = no_vacio(c.get("defaultRepo"));
    cfg.project_repos = project_repos;
    cfg.confirm_refresh = c.get("confirmRefresh") != Some(&Value::Bool(false));
    cfg.servidores = sanear_servidores(c.get("servidores"));
    cfg.max_turns = c.get("maxTurns").and_then(vueltas_validas).map(|n| Num(f64::from(n)));
    cfg.max_cost_usd = c.get("maxCostUsd").and_then(costo_valido).map(Num);
    sanear_filtro(c, def, &mut cfg);
    cfg
}

/// Lo que no sirve se descarta de a uno: una persona o un estado mal puestos no tiran el resto de la configuración.
fn sanear_filtro(c: &Obj, def: Option<&ConectorDef>, cfg: &mut TicketsConfig) {
    let nulo = Value::Null;
    let personas = def.and_then(|d| personas_validas(d, c.get("personasElegidas").unwrap_or(&nulo)));
    let estados = match (def, c.get("estadosElegidos")) {
        (Some(d), Some(Value::Array(xs))) => {
            let claves: Vec<String> = d.estados().iter().map(|e| e.clave.clone()).collect();
            let propios: Vec<Value> = xs.iter().filter(|e| e.as_str().is_some_and(|s| claves.iter().any(|k| k == s))).cloned().collect();
            estados_validos(&Value::Array(propios), &claves)
        }
        _ => None,
    };
    cfg.personas_elegidas = personas.filter(|p| !p.is_empty());
    cfg.incluir_sin_asignar = (c.get("incluirSinAsignar") == Some(&Value::Bool(true))).then_some(true);
    cfg.estados_elegidos = estados.filter(|e| !e.is_empty());
    cfg.ventana_dias = ventana_valida(c.get("ventanaDias").unwrap_or(&nulo));
}

fn sanear_leido(raw: Option<&Value>, def: Option<&ConectorDef>) -> Option<AlcanceLeido> {
    let o = raw?.as_object()?;
    let nulo = Value::Null;
    let ventana = ventana_valida(o.get("ventanaDias").unwrap_or(&nulo))?;
    let personas = def.and_then(|d| personas_validas(d, o.get("personas").unwrap_or(&nulo)))?;
    let no_leidos = match o.get("noLeidos").and_then(Value::as_f64) {
        Some(n) if n.fract() == 0.0 && n > 0.0 => Some(n.min(100_000.0) as u32),
        _ => None,
    };
    Some(AlcanceLeido {
        personas,
        sin_asignar: o.get("sinAsignar") == Some(&Value::Bool(true)),
        hechos: o.get("hechos") == Some(&Value::Bool(true)),
        ventana_dias: ventana,
        no_leidos,
    })
}

fn sanear_tickets(raw: Option<&Value>, def: Option<&ConectorDef>) -> Vec<Obj> {
    let Some(xs) = raw.and_then(Value::as_array) else { return Vec::new() };
    let nulo = Value::Null;
    let mut out = Vec::new();
    for t in xs {
        let Some(o) = t.as_object() else { continue };
        let idv = o.get("id").unwrap_or(&nulo);
        // Con un conector que no está en esta versión no se sabe validar el id: solo se acota.
        let id = match def {
            Some(d) => id_valido(d, idv),
            None => idv.as_str().filter(|s| len16(s) <= ID_MAX && re(ID_SEGURO_RE).is_match(s)).map(str::to_string),
        };
        let Some(id) = id else { continue };
        let mut copia = o.clone();
        copia.insert("id".into(), Value::String(id));
        match norm_estado(o.get("estado").unwrap_or(&nulo)) {
            Some(e) => {
                copia.insert("estado".into(), Value::String(e));
            }
            None => {
                copia.shift_remove("estado");
            }
        }
        out.push(copia);
    }
    out
}

fn sanear_corrida(raw: Option<&Value>) -> Option<Corrida> {
    let o = raw?.as_object()?;
    Some(Corrida {
        tokens: num(o.get("tokens")),
        cost_usd: num(o.get("costUsd")),
        duration_ms: num(o.get("durationMs")),
        num_turns: num(o.get("numTurns")),
        max_turns: o.get("maxTurns").and_then(vueltas_validas).map(|n| Num(f64::from(n))),
        tope: match o.get("tope").and_then(Value::as_str) {
            Some("vueltas") => Some(Tope::Vueltas),
            Some("costo") => Some(Tope::Costo),
            _ => None,
        },
    })
}

fn armar(o: &Obj, config: TicketsConfig, buscar: Buscar, migrado_de: Option<&Value>) -> TicketsState {
    let def = buscar(&config.conector_id);
    let nulo = Value::Null;
    let md = migrado_de.and_then(Value::as_object);
    let en = md.filter(|m| m.get("archivo") == Some(&Value::String("gruv.json".into()))).and_then(|m| num(m.get("en")));
    let personas = def.map(|d| normalize_personas(d.base(), o.get("personas").unwrap_or(&nulo))).filter(|p| !p.is_empty());
    TicketsState {
        version: 2,
        tickets: sanear_tickets(o.get("tickets"), def),
        estados: normalize_estados(def, o.get("estados").unwrap_or(&nulo)),
        me: norm_yo(def.map(ConectorDef::base), o.get("me").unwrap_or(&nulo)),
        fetched_at: num(o.get("fetchedAt")),
        fetched_by: no_vacio(o.get("fetchedBy")),
        leido_con: o.get("leidoCon").and_then(Value::as_str).filter(|s| len16(s) <= 64 && re(PREFIJO_RE).is_match(s)).map(str::to_string),
        last_run: sanear_corrida(o.get("lastRun")),
        uso: sanear_uso(o.get("uso").unwrap_or(&nulo)),
        last_error: no_vacio(o.get("lastError")),
        personas,
        personas_at: num(o.get("personasAt")),
        leido: sanear_leido(o.get("leido"), def),
        migrado_de: en.map(|en| MigradoDe { archivo: "gruv.json".into(), en, gruv_mtime_ms: md.and_then(|m| num(m.get("gruvMtimeMs"))) }),
        config,
    }
}

/// Limpia un tickets.json v2 (puede venir editado a mano). None si no es un v2.
pub fn sanear_estado(raw: &Value, buscar: Buscar) -> Option<TicketsState> {
    let o = raw.as_object()?;
    if o.get("version").and_then(Value::as_f64) != Some(2.0) {
        return None;
    }
    Some(armar(o, sanear_config(o.get("config"), buscar), buscar, o.get("migradoDe")))
}

/// gruv.json v1 → v2 con el conector `gruv`. gruv.json no se toca.
pub fn migrar_de_gruv(raw: &Value, buscar: Buscar, ahora: f64, gruv_mtime_ms: f64) -> Option<TicketsState> {
    let o = raw.as_object()?;
    let mut cfg = o.get("config").and_then(Value::as_object).cloned().unwrap_or_default();
    cfg.insert("conectorId".into(), Value::String(CONECTOR_LEGADO.into()));
    let config = sanear_config(Some(&Value::Object(cfg)), buscar);
    let origen = serde_json::json!({ "archivo": "gruv.json", "en": num_js(ahora), "gruvMtimeMs": num_js(gruv_mtime_ms) });
    Some(armar(o, config, buscar, Some(&origen)))
}

fn num_js(n: f64) -> Value {
    super::texto::num_valor(n)
}

/// Lo leído (tickets, columnas, quién sos, la última consulta) fuera; la config y lo gastado quedan igual.
pub fn sin_lista(s: &TicketsState) -> TicketsState {
    TicketsState { uso: s.uso.clone(), migrado_de: s.migrado_de.clone(), config: s.config.clone(), ..estado_vacio(&s.config.conector_id) }
}

/// El estado al pasar a otro conector: lo leído con el anterior no sirve. Se conservan la cuenta, el modelo y los repos, y
/// el id de persona de cada conector queda guardado para cuando se vuelva a él.
pub fn con_conector(s: &TicketsState, conector_id: &str) -> TicketsState {
    if s.config.conector_id == conector_id {
        return s.clone();
    }
    let mut previos = s.config.assignee_previos.clone().unwrap_or_default();
    if !s.config.assignee_id.is_empty() && s.config.conector_id != SIN_CONECTOR {
        previos.insert(s.config.conector_id.clone(), s.config.assignee_id.clone());
    }
    let assignee_id = previos.get(conector_id).cloned().unwrap_or_default();
    previos.remove(conector_id);
    let mut config = s.config.clone();
    config.personas_elegidas = None;
    config.incluir_sin_asignar = None;
    config.estados_elegidos = None;
    config.conector_id = conector_id.to_string();
    config.assignee_id = assignee_id;
    config.assignee_previos = (!previos.is_empty()).then_some(previos);
    TicketsState { config, ..sin_lista(s) }
}

pub fn resolver_estado(tickets: &Lectura, gruv: &Lectura, buscar: Buscar, ahora: f64) -> ResultadoCarga {
    // Quien tiene gruv.json (aunque esté dañado o no se pueda leer) ya usaba el conector `gruv`: no queda sin conector.
    let vacio_segun_gruv = || estado_vacio(if matches!(gruv, Lectura::Falta) { SIN_CONECTOR } else { CONECTOR_LEGADO });
    let migrar = || match gruv {
        Lectura::Ok { json, mtime_ms } => migrar_de_gruv(json, buscar, ahora, *mtime_ms),
        _ => None,
    };
    let en_memoria = |solo_lectura: SoloLectura| {
        let m = migrar();
        ResultadoCarga { origen: if m.is_some() { Origen::Gruv } else { Origen::Vacio }, state: m.unwrap_or_else(vacio_segun_gruv), respaldar: None, guardar: false, solo_lectura: Some(solo_lectura) }
    };

    if matches!(tickets, Lectura::Error(_)) {
        return en_memoria(SoloLectura::Ilegible);
    }
    let mut respaldar = matches!(tickets, Lectura::Corrupto).then_some(Respaldar::Corrupto);
    if let Lectura::Ok { json, .. } = tickets {
        if json.get("version").and_then(Value::as_f64).is_some_and(|v| v > 2.0) {
            return en_memoria(SoloLectura::VersionFutura);
        }
        if let Some(state) = sanear_estado(json, buscar) {
            // gruv.json cambió desde que se migró: se volvió a usar una versión vieja de Sloth y manda gruv.json.
            let registrado = state.migrado_de.as_ref().and_then(|m| m.gruv_mtime_ms).map(|n| n.0);
            let m = match gruv {
                Lectura::Ok { mtime_ms, .. } if Some(*mtime_ms) != registrado => migrar(),
                _ => None,
            };
            if let Some(m) = m {
                return ResultadoCarga { state: m, origen: Origen::Gruv, respaldar: Some(Respaldar::Previo), guardar: true, solo_lectura: None };
            }
            return ResultadoCarga { state, origen: Origen::Tickets, respaldar: None, guardar: false, solo_lectura: None };
        }
        respaldar = Some(Respaldar::Corrupto);
    }

    // Sin tickets.json válido, guardar dejaría uno sin migradoDe y el próximo arranque lo pisaría con gruv.json.
    if matches!(gruv, Lectura::Error(_)) {
        return en_memoria(SoloLectura::GruvIlegible);
    }
    if let Some(m) = migrar() {
        return ResultadoCarga { state: m, origen: Origen::Gruv, respaldar, guardar: true, solo_lectura: None };
    }
    ResultadoCarga { state: vacio_segun_gruv(), origen: Origen::Vacio, respaldar, guardar: false, solo_lectura: None }
}
