//! Tickets sin atarse a un sistema: el modelo que comparten el núcleo y la interfaz. Equivale a src/shared/tickets.ts y
//! a lo puro de src/shared/tickets-uso.ts. Los campos van en el mismo orden que en el TypeScript porque así se escriben
//! en tickets.json.
use super::texto::{colapsar, sin_tildes, Num};
use serde::de::{MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};
use std::fmt;
use std::marker::PhantomData;

/// Un objeto JSON que conserva el orden de inserción (los de JavaScript lo hacen para claves que no son índices).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ordenado<T>(pub Vec<(String, T)>);

impl<T> Default for Ordenado<T> {
    fn default() -> Self {
        Ordenado(Vec::new())
    }
}

impl<T> Ordenado<T> {
    pub fn get(&self, k: &str) -> Option<&T> {
        self.0.iter().find(|(c, _)| c == k).map(|(_, v)| v)
    }
    pub fn get_mut(&mut self, k: &str) -> Option<&mut T> {
        self.0.iter_mut().find(|(c, _)| c == k).map(|(_, v)| v)
    }
    pub fn contains_key(&self, k: &str) -> bool {
        self.get(k).is_some()
    }
    /// Si la clave existe se reemplaza en su lugar; si no, va al final.
    pub fn insert(&mut self, k: impl Into<String>, v: T) {
        let k = k.into();
        match self.0.iter_mut().find(|(c, _)| *c == k) {
            Some(e) => e.1 = v,
            None => self.0.push((k, v)),
        }
    }
    pub fn remove(&mut self, k: &str) -> Option<T> {
        let i = self.0.iter().position(|(c, _)| c == k)?;
        Some(self.0.remove(i).1)
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn iter(&self) -> impl Iterator<Item = (&String, &T)> {
        self.0.iter().map(|(k, v)| (k, v))
    }
    pub fn claves(&self) -> impl Iterator<Item = &String> {
        self.0.iter().map(|(k, _)| k)
    }
    pub fn valores(&self) -> impl Iterator<Item = &T> {
        self.0.iter().map(|(_, v)| v)
    }
}

impl<T: Serialize> Serialize for Ordenado<T> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            m.serialize_entry(k, v)?;
        }
        m.end()
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Ordenado<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V<T>(PhantomData<T>);
        impl<'de, T: Deserialize<'de>> Visitor<'de> for V<T> {
            type Value = Ordenado<T>;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("un objeto")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
                let mut out = Ordenado::default();
                while let Some((k, v)) = a.next_entry::<String, T>()? {
                    out.insert(k, v);
                }
                Ok(out)
            }
        }
        d.deserialize_map(V(PhantomData))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Accion {
    Estado,
    Tomar,
    Soltar,
    Comentar,
    Criterio,
    Horas,
}

pub const ACCIONES: [Accion; 6] = [Accion::Estado, Accion::Tomar, Accion::Soltar, Accion::Comentar, Accion::Criterio, Accion::Horas];

impl Accion {
    pub fn como_str(self) -> &'static str {
        match self {
            Accion::Estado => "estado",
            Accion::Tomar => "tomar",
            Accion::Soltar => "soltar",
            Accion::Comentar => "comentar",
            Accion::Criterio => "criterio",
            Accion::Horas => "horas",
        }
    }
    pub fn de_str(s: &str) -> Option<Accion> {
        ACCIONES.iter().copied().find(|a| a.como_str() == s)
    }
}

/// Qué significa un estado para la app (color, si va al tablero), sea cual sea su nombre.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Categoria {
    Pendiente,
    EnCurso,
    Revision,
    Bloqueado,
    Hecho,
}

pub const CATEGORIAS: [&str; 5] = ["pendiente", "en_curso", "revision", "bloqueado", "hecho"];

impl Categoria {
    pub fn de_str(s: &str) -> Option<Categoria> {
        Some(match s {
            "pendiente" => Categoria::Pendiente,
            "en_curso" => Categoria::EnCurso,
            "revision" => Categoria::Revision,
            "bloqueado" => Categoria::Bloqueado,
            "hecho" => Categoria::Hecho,
            _ => return None,
        })
    }
}

pub const MODELOS: [&str; 3] = ["haiku", "sonnet", "opus"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EstadoBase {
    pub clave: String,
    pub nombre: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Estado {
    pub clave: String,
    pub nombre: String,
    pub categoria: Categoria,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Persona {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub id: Option<String>,
    pub nombre: String,
}

/// La persona dueña de la cuenta que consultó.
pub type Yo = Persona;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Criterio {
    /// Solo viene con el detalle; hace falta para tildarlo.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub id: Option<String>,
    pub texto: String,
    pub hecho: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Comentario {
    pub autor: String,
    pub cuerpo: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fecha: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Detalle {
    pub criterios: Vec<Criterio>,
    pub comentarios: Vec<Comentario>,
    /// None = sin registro (no es cero).
    pub minutos: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub descripcion: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Ticket {
    pub id: String,
    pub titulo: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub estado: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub prioridad: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub proyecto: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub responsable: Option<String>,
    #[serde(rename = "responsableId", skip_serializing_if = "Option::is_none", default)]
    pub responsable_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub descripcion: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub criterios: Option<Vec<Criterio>>,
    /// ISO: cuándo se creó, o cuándo se cerró si el estado es de categoría 'hecho'.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fecha: Option<String>,
    /// Lo que un tickets.json de otra versión haya agregado: se conserva.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Ticket {
    pub fn nuevo(id: impl Into<String>, titulo: impl Into<String>) -> Self {
        Ticket { id: id.into(), titulo: titulo.into(), ..Default::default() }
    }
}

/// Una persona del equipo, solo para elegir a quién filtrar: id y nombre, nunca mails ni teléfonos.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersonaEquipo {
    pub id: String,
    pub nombre: String,
}

/// Lo que ya se leyó: «Actualizar» y cambiar el filtro piden solo lo que falta.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlcanceLeido {
    pub personas: Vec<String>,
    #[serde(rename = "sinAsignar")]
    pub sin_asignar: bool,
    pub hechos: bool,
    #[serde(rename = "ventanaDias")]
    pub ventana_dias: u32,
    #[serde(rename = "noLeidos", skip_serializing_if = "Option::is_none", default)]
    pub no_leidos: Option<u32>,
}

/// Qué se ve: lo que eligió la persona, con los valores por defecto ya resueltos.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FiltroVista {
    #[serde(rename = "personasElegidas")]
    pub personas_elegidas: Vec<String>,
    #[serde(rename = "incluirSinAsignar")]
    pub incluir_sin_asignar: bool,
    #[serde(rename = "estadosElegidos")]
    pub estados_elegidos: Vec<String>,
    #[serde(rename = "ventanaDias")]
    pub ventana_dias: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ConteosTickets {
    #[serde(rename = "porPersona")]
    pub por_persona: Ordenado<u32>,
    #[serde(rename = "porEstado")]
    pub por_estado: Ordenado<u32>,
    pub ocultos: u32,
    #[serde(rename = "sinFecha")]
    pub sin_fecha: u32,
    #[serde(rename = "noLeidos", skip_serializing_if = "Option::is_none", default)]
    pub no_leidos: Option<u32>,
}

/// Qué falta leer para que la lista cubra el filtro.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendientesLista {
    pub personas: Vec<String>,
    #[serde(rename = "sinAsignar")]
    pub sin_asignar: bool,
    /// Hay que volver a leer todo (se sumaron los terminados o se alargó la ventana).
    pub todo: bool,
}

pub const SIN_ASIGNAR: &str = "sin_asignar";
pub const VENTANA_DEFECTO: u32 = 4;
pub const VENTANA_MAX: u32 = 14;
pub const PERSONAS_ELEGIDAS_MAX: usize = 20;
/// conectorId de «todavía no elegiste conector» (usuarios nuevos).
pub const SIN_CONECTOR: &str = "";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TicketsConfig {
    #[serde(rename = "conectorId")]
    pub conector_id: String,
    #[serde(rename = "queryAccountId", skip_serializing_if = "Option::is_none", default)]
    pub query_account_id: Option<String>,
    pub model: String,
    /// Vacío = la persona dueña de la cuenta que consulta.
    #[serde(rename = "assigneeId")]
    pub assignee_id: String,
    /// El id de persona que se tenía en cada conector que se dejó, para recuperarlo al volver.
    #[serde(rename = "assigneePrevios", skip_serializing_if = "Option::is_none", default)]
    pub assignee_previos: Option<Ordenado<String>>,
    #[serde(rename = "defaultRepo", skip_serializing_if = "Option::is_none", default)]
    pub default_repo: Option<String>,
    #[serde(rename = "projectRepos")]
    pub project_repos: Ordenado<String>,
    #[serde(rename = "confirmRefresh")]
    pub confirm_refresh: bool,
    /// cuentaId → conectorId → prefijo elegido cuando hay más de un servidor posible.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub servidores: Option<Ordenado<Ordenado<String>>>,
    #[serde(rename = "maxTurns", skip_serializing_if = "Option::is_none", default)]
    pub max_turns: Option<Num>,
    #[serde(rename = "maxCostUsd", skip_serializing_if = "Option::is_none", default)]
    pub max_cost_usd: Option<Num>,
    #[serde(rename = "personasElegidas", skip_serializing_if = "Option::is_none", default)]
    pub personas_elegidas: Option<Vec<String>>,
    #[serde(rename = "incluirSinAsignar", skip_serializing_if = "Option::is_none", default)]
    pub incluir_sin_asignar: Option<bool>,
    #[serde(rename = "estadosElegidos", skip_serializing_if = "Option::is_none", default)]
    pub estados_elegidos: Option<Vec<String>>,
    #[serde(rename = "ventanaDias", skip_serializing_if = "Option::is_none", default)]
    pub ventana_dias: Option<u32>,
}

impl TicketsConfig {
    pub fn nueva(conector_id: &str) -> Self {
        TicketsConfig {
            conector_id: conector_id.to_string(),
            query_account_id: None,
            model: "haiku".into(),
            assignee_id: String::new(),
            assignee_previos: None,
            default_repo: None,
            project_repos: Ordenado::default(),
            confirm_refresh: true,
            servidores: None,
            max_turns: None,
            max_cost_usd: None,
            personas_elegidas: None,
            incluir_sin_asignar: None,
            estados_elegidos: None,
            ventana_dias: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EstadoMcp {
    #[serde(rename = "connected")]
    Conectado,
    #[serde(rename = "needs-auth")]
    NecesitaAuth,
    #[serde(rename = "failed")]
    Fallo,
    #[serde(rename = "pending")]
    Pendiente,
    #[serde(rename = "otro")]
    Otro,
}

pub const ESTADOS_MCP: [&str; 5] = ["connected", "needs-auth", "failed", "pending", "otro"];

impl EstadoMcp {
    pub fn de_str(s: &str) -> Option<EstadoMcp> {
        Some(match s {
            "connected" => EstadoMcp::Conectado,
            "needs-auth" => EstadoMcp::NecesitaAuth,
            "failed" => EstadoMcp::Fallo,
            "pending" => EstadoMcp::Pendiente,
            "otro" => EstadoMcp::Otro,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServidorMcp {
    /// Como lo muestra Claude Code: «claude.ai Gruv», «gruv-tomy».
    pub nombre: String,
    pub prefijo: String,
    pub estado: EstadoMcp,
    /// Nombres cortos. None = no se supo (servidor pending o sin listar).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub herramientas: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CuentaRevisada {
    #[serde(rename = "revisadaEn")]
    pub revisada_en: Num,
    pub servidores: Vec<ServidorMcp>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpcionServidor {
    pub nombre: String,
    pub prefijo: String,
    pub estado: EstadoMcp,
}

/// Si una cuenta puede usar un conector MCP y con qué servidor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Disponibilidad {
    SinRevisar,
    /// `parecido`: un servidor que parece el del conector pero no tiene todas sus herramientas.
    Falta { parecido: Option<(String, Vec<String>)> },
    Elegir { opciones: Vec<OpcionServidor> },
    /// `adaptado`: el servidor tiene otro prefijo que el del conector. `verificado`: se vieron sus herramientas.
    Tiene { nombre: String, prefijo: String, estado: EstadoMcp, adaptado: bool, verificado: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EstadoPrueba {
    Conectado,
    NecesitaSesion,
    SinHerramientas,
    Error,
}

impl EstadoPrueba {
    pub fn como_str(self) -> &'static str {
        match self {
            EstadoPrueba::Conectado => "conectado",
            EstadoPrueba::NecesitaSesion => "necesita-sesion",
            EstadoPrueba::SinHerramientas => "sin-herramientas",
            EstadoPrueba::Error => "error",
        }
    }
}

/// Qué pasó al probar un conector en una cuenta, en palabras para la persona.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResultadoPrueba {
    pub estado: EstadoPrueba,
    pub mensaje: String,
    pub causa: Option<String>,
    pub que_hacer: Option<String>,
    pub ms: u64,
}

/// Cómo habla Sloth con el sistema: Claude con un conector MCP, o GitHub CLI directo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Via {
    Mcp,
    Gh,
}

/// De dónde sale un conector: viene con Sloth, lo armó la persona o lo trae el .sloth/conectores.json de un repo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrigenConector {
    Incluido,
    Usuario,
    Equipo { repo: String, equipo: String },
}

/// Todo lo que un conector le pide a Claude, para revisarlo antes de aceptarlo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HerramientasVista {
    pub prefijo: String,
    pub lista: Vec<String>,
    pub detalle: Vec<String>,
    pub acciones: Ordenado<Vec<String>>,
    pub escritura: Ordenado<String>,
    pub negar: usize,
    pub comando_ticket: Option<String>,
    pub pistas: PistasVista,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PistasVista {
    pub yo_con_id: String,
    pub yo_sin_id: String,
    pub lista: String,
    pub estados: Option<String>,
    pub apoyo: Option<String>,
    pub detalle: Vec<String>,
    /// acción → (args en JSON, nota)
    pub acciones: Ordenado<(String, Option<String>)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConectorInfo {
    pub id: String,
    pub nombre: String,
    pub verificado: bool,
    pub via: Via,
    /// false = el conectorId guardado no existe en esta versión.
    pub disponible: bool,
    pub acciones: Vec<Accion>,
    pub lee_detalle: bool,
    pub ejemplo_id: String,
    pub estados: Vec<Estado>,
    pub comando_ticket: Option<String>,
    /// Forma del id de ticket del conector (anclada con ^…$) y si se normaliza a mayúsculas.
    pub id_regex: String,
    pub id_mayusculas: bool,
    pub filtra_personas: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tope {
    Vueltas,
    Costo,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Corrida {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tokens: Option<Num>,
    #[serde(rename = "costUsd", skip_serializing_if = "Option::is_none", default)]
    pub cost_usd: Option<Num>,
    #[serde(rename = "durationMs", skip_serializing_if = "Option::is_none", default)]
    pub duration_ms: Option<Num>,
    #[serde(rename = "numTurns", skip_serializing_if = "Option::is_none", default)]
    pub num_turns: Option<Num>,
    #[serde(rename = "maxTurns", skip_serializing_if = "Option::is_none", default)]
    pub max_turns: Option<Num>,
    /// Qué cortó la consulta, si la cortó un tope.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tope: Option<Tope>,
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct UsoAcum {
    pub corridas: Num,
    #[serde(rename = "costUsd")]
    pub cost_usd: Num,
    pub vueltas: Num,
    #[serde(rename = "durationMs")]
    pub duration_ms: Num,
}

/// Día local `YYYY-MM-DD` → id de conector → lo gastado ese día.
pub type UsoPorDia = Ordenado<Ordenado<UsoAcum>>;

/// La primera lista que tenga la clave gana; si ninguna la tiene, 'pendiente'.
pub fn categoria_de(clave: Option<&str>, listas: &[&[Estado]]) -> Categoria {
    let Some(clave) = clave else { return Categoria::Pendiente };
    for l in listas {
        if let Some(e) = l.iter().find(|x| x.clave == clave) {
            return e.categoria;
        }
    }
    Categoria::Pendiente
}

/// Nombre para comparar personas: sin espacios de más, sin tildes y en minúsculas.
fn nombre_persona(s: &str) -> String {
    sin_tildes(super::texto::trim_js(s)).to_lowercase()
}

/// El ticket es de la persona que consulta: por id si el conector lo da, si no por nombre.
pub fn es_mio(me: Option<&Yo>, responsable: Option<&str>, responsable_id: Option<&str>) -> bool {
    let (Some(me), Some(resp)) = (me, responsable) else { return false };
    if resp.is_empty() {
        return false;
    }
    if let (Some(mi_id), Some(rid)) = (me.id.as_deref(), responsable_id) {
        if !mi_id.is_empty() && !rid.is_empty() {
            return rid == mi_id;
        }
    }
    nombre_persona(resp) == nombre_persona(&me.nombre)
}

pub fn ticket_es_mio(me: Option<&Yo>, t: &Ticket) -> bool {
    es_mio(me, t.responsable.as_deref(), t.responsable_id.as_deref())
}

pub const VUELTAS_DEFECTO: u32 = 40;
pub const VUELTAS_MAX: u32 = 200;

fn dos(n: u32) -> String {
    format!("{n:02}")
}

/// Día `YYYY-MM-DD` de un instante en milisegundos, en UTC. El TypeScript usa la zona local; quien llama pasa el
/// instante ya corrido por el desfase de la zona (`ms + desfase`).
pub fn dia_de(ms: i64) -> String {
    let (a, m, d) = fecha_civil(ms.div_euclid(86_400_000));
    format!("{a:04}-{}-{}", dos(m), dos(d))
}

/// Días desde 1970-01-01 a año, mes y día (calendario gregoriano).
pub fn fecha_civil(dias: i64) -> (i64, u32, u32) {
    let z = dias + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Días desde 1970-01-01 de una fecha civil.
pub fn dias_civiles(a: i64, m: u32, d: u32) -> i64 {
    let a = if m <= 2 { a - 1 } else { a };
    let era = a.div_euclid(400);
    let yoe = a.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn vacio() -> UsoAcum {
    UsoAcum::default()
}

fn sumar(a: &mut UsoAcum, b: &UsoAcum) {
    a.corridas.0 += b.corridas.0;
    a.cost_usd.0 += b.cost_usd.0;
    a.vueltas.0 += b.vueltas.0;
    a.duration_ms.0 += b.duration_ms.0;
}

/// `hoy` menos `n` días, en `YYYY-MM-DD`; None si `hoy` no tiene esa forma.
fn dias_atras(hoy: &str, n: i64) -> Option<String> {
    let b = hoy.as_bytes();
    let ok = b.len() == 10 && b[4] == b'-' && b[7] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    if !ok {
        return None;
    }
    let (a, m, d): (i64, u32, u32) = (hoy[0..4].parse().ok()?, hoy[5..7].parse().ok()?, hoy[8..10].parse().ok()?);
    Some(dia_de((dias_civiles(a, m, d) - n) * 86_400_000))
}

/// Lo gastado hoy y en los últimos 7 días (con hoy), de un conector o de todos.
pub fn resumen_uso(uso: Option<&UsoPorDia>, hoy: &str, conector_id: Option<&str>) -> (UsoAcum, UsoAcum) {
    let (mut h, mut semana) = (vacio(), vacio());
    let Some(uso) = uso else { return (h, semana) };
    for i in 0..7 {
        let Some(dia) = dias_atras(hoy, i) else { continue };
        let Some(por_conector) = uso.get(&dia) else { continue };
        for (id, acum) in por_conector.iter() {
            if conector_id.is_some_and(|c| c != id) {
                continue;
            }
            sumar(&mut semana, acum);
            if i == 0 {
                sumar(&mut h, acum);
            }
        }
    }
    (h, semana)
}

/// `~US$ 0,123` con coma decimal: tres decimales debajo de un dólar y dos de ahí en más.
pub fn fmt_costo(n: f64) -> String {
    let txt = if n < 1.0 { format!("{n:.3}") } else { format!("{n:.2}") };
    format!("~US$ {}", txt.replace('.', ","))
}

fn miles_es(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push('.');
        }
        out.push(c);
    }
    out
}

pub fn texto_ultima_consulta(r: &Corrida) -> String {
    let mut partes: Vec<String> = Vec::new();
    if let Some(t) = r.tokens {
        partes.push(format!("~{} tokens", miles_es(t.0.round().max(0.0) as u64)));
    }
    if let Some(c) = r.cost_usd {
        partes.push(format!("costo estimado {}", fmt_costo(c.0)));
    }
    if let Some(n) = r.num_turns {
        partes.push(if n.0 == 1.0 { "1 vuelta".to_string() } else { format!("{} vueltas", super::texto::num_a_texto(&serde_json::Number::from_f64(n.0).unwrap_or(0.into()))) });
    }
    if let Some(d) = r.duration_ms {
        partes.push(format!("{} s", (d.0 / 1000.0).round().max(1.0) as u64));
    }
    if partes.is_empty() {
        String::new()
    } else {
        format!("Última consulta: {}", partes.join(" · "))
    }
}

/// Texto de una línea para mostrar (usado por quien arma avisos).
pub fn una_linea(s: &str) -> String {
    colapsar(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn yo() -> Yo {
        Persona { id: Some("u-1".into()), nombre: "Tomy".into() }
    }

    #[test]
    fn es_mio_compara_por_id_si_hay_y_si_no_por_nombre() {
        let me = yo();
        assert!(es_mio(Some(&me), Some("Tomy"), Some("u-1")));
        assert!(!es_mio(Some(&me), Some("Tomy"), Some("u-2")));
        let sin_id = Persona { id: None, nombre: " tomy ".into() };
        assert!(es_mio(Some(&sin_id), Some("Tomy"), None));
        assert!(!es_mio(None, Some("Tomy"), Some("u-1")));
        assert!(!es_mio(Some(&me), None, None));
        let tilde = Persona { id: None, nombre: "Tomás".into() };
        assert!(es_mio(Some(&tilde), Some("TOMAS"), None));
    }

    #[test]
    fn categoria_de_usa_la_primera_lista_que_tenga_la_clave() {
        let a = vec![Estado { clave: "x".into(), nombre: "X".into(), categoria: Categoria::Hecho }];
        let b = vec![Estado { clave: "x".into(), nombre: "X".into(), categoria: Categoria::Bloqueado }, Estado { clave: "y".into(), nombre: "Y".into(), categoria: Categoria::Revision }];
        assert_eq!(categoria_de(Some("x"), &[&a, &b]), Categoria::Hecho);
        assert_eq!(categoria_de(Some("y"), &[&a, &b]), Categoria::Revision);
        assert_eq!(categoria_de(Some("z"), &[&a, &b]), Categoria::Pendiente);
        assert_eq!(categoria_de(None, &[&a]), Categoria::Pendiente);
    }

    #[test]
    fn fechas_civiles_ida_y_vuelta() {
        assert_eq!(dia_de(0), "1970-01-01");
        assert_eq!(dia_de(1_709_164_800_000), "2024-02-29");
        assert_eq!(dias_atras("2024-03-01", 1).as_deref(), Some("2024-02-29"));
        assert_eq!(dias_atras("2025-01-02", 3).as_deref(), Some("2024-12-30"));
        assert_eq!(dias_atras("hoy", 1), None);
    }

    fn acum(c: f64, v: f64, k: f64, d: f64) -> UsoAcum {
        UsoAcum { corridas: Num(c), cost_usd: Num(k), vueltas: Num(v), duration_ms: Num(d) }
    }

    #[test]
    fn resumen_uso_suma_hoy_y_la_semana_de_un_conector_o_de_todos() {
        let mut uso: UsoPorDia = Ordenado::default();
        let mut d1 = Ordenado::default();
        d1.insert("gruv", acum(2.0, 10.0, 0.5, 1000.0));
        d1.insert("jira", acum(1.0, 3.0, 0.25, 500.0));
        uso.insert("2025-03-10", d1);
        let mut d2 = Ordenado::default();
        d2.insert("gruv", acum(1.0, 4.0, 0.1, 200.0));
        uso.insert("2025-03-05", d2);
        let mut viejo = Ordenado::default();
        viejo.insert("gruv", acum(9.0, 9.0, 9.0, 9.0));
        uso.insert("2025-03-03", viejo);
        let (hoy, semana) = resumen_uso(Some(&uso), "2025-03-10", None);
        assert_eq!((hoy.corridas.0, hoy.vueltas.0), (3.0, 13.0));
        assert_eq!((semana.corridas.0, semana.vueltas.0), (4.0, 17.0));
        let (_, sg) = resumen_uso(Some(&uso), "2025-03-10", Some("gruv"));
        assert_eq!(sg.corridas.0, 3.0);
        assert_eq!(resumen_uso(None, "2025-03-10", None).0.corridas.0, 0.0);
    }

    #[test]
    fn formatos_de_costo_y_ultima_consulta() {
        assert_eq!(fmt_costo(0.0123), "~US$ 0,012");
        assert_eq!(fmt_costo(1.5), "~US$ 1,50");
        let r = Corrida { tokens: Some(Num(12345.0)), cost_usd: Some(Num(0.5)), num_turns: Some(Num(1.0)), duration_ms: Some(Num(200.0)), ..Default::default() };
        assert_eq!(texto_ultima_consulta(&r), "Última consulta: ~12.345 tokens · costo estimado ~US$ 0,500 · 1 vuelta · 1 s");
        assert_eq!(texto_ultima_consulta(&Corrida::default()), "");
        let r = Corrida { num_turns: Some(Num(3.0)), ..Default::default() };
        assert_eq!(texto_ultima_consulta(&r), "Última consulta: 3 vueltas");
    }

    #[test]
    fn el_ticket_conserva_campos_desconocidos_y_el_orden() {
        let t: Ticket = serde_json::from_str(r#"{"id":"A-1","titulo":"x","extra":5,"estado":"abierto"}"#).unwrap();
        assert_eq!(t.extra.get("extra").and_then(Value::as_i64), Some(5));
        assert_eq!(serde_json::to_string(&t).unwrap(), r#"{"id":"A-1","titulo":"x","estado":"abierto","extra":5}"#);
    }

    #[test]
    fn el_objeto_ordenado_conserva_el_orden_de_insercion() {
        let o: Ordenado<u32> = serde_json::from_str(r#"{"b":1,"a":2,"b":3}"#).unwrap();
        assert_eq!(serde_json::to_string(&o).unwrap(), r#"{"b":3,"a":2}"#);
    }
}
