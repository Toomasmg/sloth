//! Qué es un conector de tickets y cómo se valida. Un conector es SOLO datos: nombres de herramientas, pistas para el
//! prompt y estados; el motor arma todo lo demás. Equivale a src/main/features/tickets/conector.ts.
//!
//! Todo conector llega de afuera (un archivo, el repo de un equipo): `validar_conector` es lo único que lo convierte en
//! un `ConectorDef`, y rechaza cualquier clave, forma o carácter que no esté previsto.
use super::errores::ConectorInvalido;
use super::modelo::{Accion, Categoria, Estado, Ordenado, Via, ACCIONES, CATEGORIAS};
use super::texto::{len16, re, regex_js, traducir_js};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub type Obj = Map<String, Value>;
pub type ArgValor = Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PasoLlamada {
    pub herramienta: String,
    pub args: Obj,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PistaAccion {
    pub args: Obj,
    /// Admite los mismos placeholders que los args de la acción.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub nota: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Ejemplo {
    pub id: String,
    pub estado: String,
    pub prioridad: String,
    pub proyecto: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FaltaConector {
    pub clave: String,
    pub mensaje: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConectorBase {
    pub id: String,
    pub nombre: String,
    pub via: Via,
    pub verificado: bool,
    /// Anclada con ^…$; se compila como ^(?:…)$ para que una alternancia no la desancle.
    #[serde(rename = "idRegex")]
    pub id_regex: String,
    #[serde(rename = "idMayusculas")]
    pub id_mayusculas: bool,
    /// Forma del id de persona, anclada como idRegex. Sin esto, letras, números y guiones.
    #[serde(rename = "personaId", skip_serializing_if = "Option::is_none", default)]
    pub persona_id: Option<String>,
    /// Comando con el que arranca el espacio de un ticket (p. ej. /ticket).
    #[serde(rename = "comandoTicket", skip_serializing_if = "Option::is_none", default)]
    pub comando_ticket: Option<String>,
    pub ejemplo: Ejemplo,
    pub estados: Vec<Estado>,
    #[serde(rename = "faltaConector")]
    pub falta_conector: FaltaConector,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Herramientas {
    /// Nombres cortos; el completo es `prefijo + corto`.
    pub prefijo: String,
    pub lista: Vec<String>,
    /// De lectura y también de `lista`: con ella se arma la lista de personas para filtrar por responsable.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub personas: Option<String>,
    pub detalle: Vec<String>,
    pub escritura: Ordenado<String>,
    pub negar: Vec<String>,
    /// De lectura, permitidas también en el detalle y en cada acción.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub apoyo: Option<Vec<String>>,
    /// De lectura, permitidas además del apoyo solo en esa acción.
    #[serde(rename = "apoyoEn", skip_serializing_if = "Option::is_none", default)]
    pub apoyo_en: Option<Ordenado<Vec<String>>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PistaYo {
    /// `conId` lleva `{id}` una sola vez.
    #[serde(rename = "conId")]
    pub con_id: String,
    #[serde(rename = "sinId")]
    pub sin_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pistas {
    pub yo: PistaYo,
    pub lista: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub estados: Option<String>,
    /// Cómo leer los tickets de cada responsable: lleva {asignados} y {desde} (YYYY-MM-DD).
    #[serde(rename = "listaPor", skip_serializing_if = "Option::is_none", default)]
    pub lista_por: Option<String>,
    /// Se suma a `listaPor` cuando se piden también los terminados; admite {desde}.
    #[serde(rename = "listaHechos", skip_serializing_if = "Option::is_none", default)]
    pub lista_hechos: Option<String>,
    /// Cómo armar la lista de personas con `herramientas.personas`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub personas: Option<String>,
    pub detalle: Vec<PasoLlamada>,
    /// De qué campos de lo que traen los pasos de detalle sale la descripción del ticket.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub descripcion: Option<String>,
    /// Cuándo usar las herramientas de apoyo; admite solo `{ticket}`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub apoyo: Option<String>,
    pub acciones: Ordenado<PistaAccion>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ConectorMcp {
    #[serde(flatten)]
    pub base: ConectorBase,
    pub herramientas: Herramientas,
    pub pistas: Pistas,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ConectorGh {
    #[serde(flatten)]
    pub base: ConectorBase,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ConectorDef {
    Mcp(ConectorMcp),
    Gh(ConectorGh),
}

impl ConectorDef {
    pub fn base(&self) -> &ConectorBase {
        match self {
            ConectorDef::Mcp(m) => &m.base,
            ConectorDef::Gh(g) => &g.base,
        }
    }
    pub fn id(&self) -> &str {
        &self.base().id
    }
    pub fn nombre(&self) -> &str {
        &self.base().nombre
    }
    pub fn via(&self) -> Via {
        self.base().via
    }
    pub fn estados(&self) -> &[Estado] {
        &self.base().estados
    }
    pub fn mcp(&self) -> Option<&ConectorMcp> {
        match self {
            ConectorDef::Mcp(m) => Some(m),
            ConectorDef::Gh(_) => None,
        }
    }

    /// Arma el conector tipado desde un JSON que ya pasó `validar_conector`.
    pub fn desde_validado(v: &Value) -> Result<ConectorDef, String> {
        let base: ConectorBase = serde_json::from_value(v.clone()).map_err(|e| e.to_string())?;
        match base.via {
            Via::Gh => Ok(ConectorDef::Gh(ConectorGh { base })),
            Via::Mcp => {
                let herramientas = serde_json::from_value(v.get("herramientas").cloned().unwrap_or(Value::Null)).map_err(|e| e.to_string())?;
                let pistas = serde_json::from_value(v.get("pistas").cloned().unwrap_or(Value::Null)).map_err(|e| e.to_string())?;
                Ok(ConectorDef::Mcp(ConectorMcp { base, herramientas, pistas }))
            }
        }
    }

    pub fn a_valor(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

impl ConectorMcp {
    pub fn nombre_completo(&self, corto: &str) -> String {
        format!("{}{corto}", self.herramientas.prefijo)
    }
    pub fn id(&self) -> &str {
        &self.base.id
    }
    pub fn nombre(&self) -> &str {
        &self.base.nombre
    }
}

/// Lo que gh puede hacer desde Sloth.
pub const ACCIONES_GH: [Accion; 4] = [Accion::Estado, Accion::Tomar, Accion::Soltar, Accion::Comentar];
pub const ESTADOS_GH: [&str; 2] = ["abierto", "cerrado"];

/// Un id de ticket más largo que esto no se evalúa contra la regex (ni se guarda).
pub const ID_MAX: usize = 20;
/// Los ids van sin comillas a los prompts y al PTY (`/ticket <id>`): además de la regex del conector, solo esto.
pub const ID_SEGURO_RE: &str = r"^[A-Za-z0-9_#.-]+$";
pub const ID_CONECTOR_RE: &str = r"^[a-z][a-z0-9-]{1,31}$";
pub const PREFIJO_RE: &str = r"^mcp__[A-Za-z0-9_-]+__$";
/// Llega a la terminal como primer mensaje: una barra y un nombre en minúsculas, sin espacios ni nada de shell.
pub const COMANDO_TICKET_RE: &str = r"^/[a-z][a-z0-9:_-]{0,38}$";
pub const CORTO_RE: &str = r"^[A-Za-z0-9_-]{1,64}$";
pub const PERSONA_POR_DEFECTO: &str = r"^[A-Za-z0-9-]{1,64}$";

/// Comandos incorporados de Claude Code y Codex que cambian la sesión, la cuenta o los permisos: un conector (que puede
/// venir de un repo o de un archivo) no los puede fijar como primer mensaje de cada espacio. Es una lista negra: no
/// cubre los comandos de plugins ni los del repo; por eso el diálogo de revisión muestra siempre el comando.
pub const COMANDOS_PROHIBIDOS: [&str; 25] = [
    "add-dir", "agents", "allowed-tools", "approvals", "bug", "clear", "config", "doctor", "exit", "hooks", "ide", "init", "install-github-app", "install-slack-app", "login", "logout", "mcp", "memory", "model", "new",
    "permissions", "plugin", "plugins", "privacy-settings", "quit",
];
const COMANDOS_PROHIBIDOS_2: [&str; 6] = ["resume", "rewind", "sandbox", "settings", "terminal-setup", "upgrade"];

pub fn comando_prohibido(c: &str) -> bool {
    COMANDOS_PROHIBIDOS.contains(&c) || COMANDOS_PROHIBIDOS_2.contains(&c)
}

/// Por qué un comando de ticket no sirve; None si cumple la forma y no es uno de los prohibidos.
pub fn problema_comando_ticket(c: &str) -> Option<String> {
    if !re(COMANDO_TICKET_RE).is_match(c) {
        return Some("tiene que empezar con / y seguir con una letra minúscula, números, guiones, _ o dos puntos, como /ticket".into());
    }
    if comando_prohibido(&c[1..]) {
        return Some(format!("{c} es un comando de Claude que cambia la sesión, la cuenta o los permisos: no puede ser el del ticket"));
    }
    None
}

pub fn placeholders(a: Accion) -> &'static [&'static str] {
    match a {
        Accion::Estado => &["ticket", "estado"],
        Accion::Tomar => &["ticket", "persona"],
        Accion::Soltar => &["ticket"],
        Accion::Comentar => &["ticket", "cuerpo"],
        Accion::Criterio => &["ticket", "criterioId", "hecho"],
        Accion::Horas => &["ticket", "minutos", "motivo"],
    }
}

// Los args de una pista quedan a 4 niveles de la raíz y admiten 3 más adentro.
const PROF_MAX: usize = 7;
const TAM_MAX: usize = 64 * 1024;
const PISTA_MAX: usize = 1000;
const NOMBRE_RE: &str = r"^[\p{L}\p{N}][\p{L}\p{N} ._&-]{0,39}$";
const CLAVE_ESTADO_RE: &str = r"^[a-z0-9_]{1,40}$";
const CLAVE_FALTA_RE: &str = r"^[a-z_]{3,40}$";
const ARG_RE: &str = r"^[a-z_][A-Za-z0-9_]{0,40}$";
const ARGS_PROF_MAX: usize = 3;
const PLACEHOLDER_RE: &str = r"^\{([A-Za-z]+)\}$";
// Lo que va dentro de un JSON de ejemplo del prompt: sin nada que lo pueda cerrar o escapar.
const SIN_ESCAPE: &str = r#"^[^"\\{}]*$"#;

fn tiene_control(s: &str) -> bool {
    s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}

fn tiene_llaves(s: &str) -> bool {
    s.contains('{') || s.contains('}')
}

type R<T> = Result<T, ConectorInvalido>;

fn fallar<T>(ruta: &str, motivo: impl Into<String>) -> R<T> {
    Err(ConectorInvalido { ruta: ruta.to_string(), motivo: motivo.into() })
}


fn solo_datos(v: &Value, ruta: &str, prof: usize) -> R<()> {
    if prof > PROF_MAX {
        return fallar(ruta, format!("más de {PROF_MAX} niveles"));
    }
    match v {
        Value::Array(xs) => xs.iter().enumerate().try_for_each(|(i, x)| solo_datos(x, &format!("{ruta}[{i}]"), prof + 1)),
        Value::Object(o) => o.iter().try_for_each(|(k, x)| solo_datos(x, &format!("{ruta}.{k}"), prof + 1)),
        _ => Ok(()),
    }
}

fn objeto<'a>(v: &'a Value, ruta: &str, claves: &[&str], opcionales: &[&str]) -> R<&'a Obj> {
    let Some(o) = v.as_object() else { return fallar(ruta, "tiene que ser un objeto") };
    for k in o.keys() {
        if !claves.contains(&k.as_str()) && !opcionales.contains(&k.as_str()) {
            return fallar(&format!("{ruta}.{k}"), "clave desconocida");
        }
    }
    for k in claves {
        if !o.contains_key(*k) {
            return fallar(&format!("{ruta}.{k}"), "falta");
        }
    }
    Ok(o)
}

fn campo<'a>(v: &'a Value, ruta: &str, max: usize, forma: Option<&str>) -> R<&'a str> {
    let Some(s) = v.as_str().filter(|s| !s.is_empty()) else { return fallar(ruta, "tiene que ser un texto no vacío") };
    // El largo antes que la forma: ninguna regex corre sobre textos enormes.
    if len16(s) > max {
        return fallar(ruta, format!("más de {max} caracteres"));
    }
    if tiene_control(s) {
        return fallar(ruta, "tiene caracteres de control o saltos de línea");
    }
    if let Some(f) = forma {
        if !Regex::new(&traducir_js(f)).map(|r| r.is_match(s)).unwrap_or(false) {
            return fallar(ruta, "tiene un formato inválido");
        }
    }
    Ok(s)
}

fn booleano(v: &Value, ruta: &str) -> R<bool> {
    match v.as_bool() {
        Some(b) => Ok(b),
        None => fallar(ruta, "tiene que ser true o false"),
    }
}

fn lista<'a>(v: &'a Value, ruta: &str, min: usize, max: usize) -> R<&'a Vec<Value>> {
    let Some(xs) = v.as_array() else { return fallar(ruta, "tiene que ser una lista") };
    if xs.len() < min || xs.len() > max {
        return fallar(ruta, format!("tiene que tener entre {min} y {max} elementos"));
    }
    Ok(xs)
}

fn sin_repetidos(xs: &[&str], ruta: &str) -> R<()> {
    match xs.iter().enumerate().find(|(i, x)| xs.iter().position(|y| y == *x) != Some(*i)) {
        Some((_, r)) => fallar(ruta, format!("«{r}» está repetido")),
        None => Ok(()),
    }
}

// Con prefijo y nombre corto de hasta 64 cada uno, el nombre completo ya es válido y entra en 128.
fn herramienta<'a>(v: &'a Value, ruta: &str) -> R<&'a str> {
    campo(v, ruta, 64, Some(CORTO_RE))
}

fn herramientas<'a>(v: &'a Value, ruta: &str, min: usize, max: usize) -> R<Vec<&'a str>> {
    let xs = lista(v, ruta, min, max)?;
    let out = xs.iter().enumerate().map(|(i, x)| herramienta(x, &format!("{ruta}[{i}]"))).collect::<R<Vec<_>>>()?;
    sin_repetidos(&out, ruta)?;
    Ok(out)
}

fn lista_placeholders(permitidos: &[&str]) -> String {
    permitidos.iter().map(|p| format!("{{{p}}}")).collect::<Vec<_>>().join(", ")
}

fn args(v: &Value, ruta: &str, permitidos: &[&str], prof: usize) -> R<()> {
    let Some(o) = v.as_object() else { return fallar(ruta, "tiene que ser un objeto") };
    if o.is_empty() || o.len() > 10 {
        return fallar(ruta, "tiene que tener entre 1 y 10 argumentos");
    }
    for (k, x) in o {
        let r = format!("{ruta}.{k}");
        if !re(ARG_RE).is_match(k) || k == "__proto__" {
            return fallar(&r, "nombre de argumento inválido");
        }
        match x {
            Value::Null | Value::Number(_) | Value::Bool(_) => continue,
            Value::Object(_) => {
                if prof >= ARGS_PROF_MAX {
                    return fallar(&r, format!("más de {ARGS_PROF_MAX} niveles de argumentos"));
                }
                args(x, &r, permitidos, prof + 1)?;
                continue;
            }
            _ => {}
        }
        let s = campo(x, &r, 200, None)?;
        if !tiene_llaves(s) {
            continue;
        }
        let ok = re(PLACEHOLDER_RE).captures(s).map(|m| permitidos.contains(&&m[1])).unwrap_or(false);
        if !ok {
            return fallar(&r, format!("solo admite {} como valor completo", lista_placeholders(permitidos)));
        }
    }
    Ok(())
}

fn solo_placeholders(v: &Value, ruta: &str, permitidos: &[&str]) -> R<()> {
    let mut resto = campo(v, ruta, PISTA_MAX, None)?.to_string();
    for p in permitidos {
        resto = resto.replace(&format!("{{{p}}}"), "");
    }
    if tiene_llaves(&resto) {
        return fallar(ruta, format!("solo admite {}", lista_placeholders(permitidos)));
    }
    Ok(())
}

/// `^(?:…)$`: el contenido de una regex anclada, sin los anclajes, para que una alternancia no la desancle.
pub fn compilar(id_regex: &str) -> Option<Regex> {
    let inner = id_regex.get(1..id_regex.len().checked_sub(1)?)?;
    regex_js(&format!("^(?:{inner})$"))
}

fn id_regex_valida(v: &Value, ruta: &str) -> R<Regex> {
    let s = campo(v, ruta, 200, None)?;
    let anclada = s.starts_with('^') && s.ends_with('$') && s.len() >= 2 && {
        let antes = &s[..s.len() - 1];
        let barras = antes.len() - antes.trim_end_matches('\\').len();
        barras % 2 == 0
    };
    if !anclada {
        return fallar(ruta, "tiene que estar anclada con ^…$");
    }
    if re(r"\)[*+?{]").is_match(s) {
        return fallar(ruta, "no admite grupos cuantificados");
    }
    if re(r"\\[1-9]|\\k<").is_match(s) {
        return fallar(ruta, "no admite referencias hacia atrás");
    }
    if re(r"\(\?<?[=!]").is_match(s) {
        return fallar(ruta, "no admite lookarounds");
    }
    match compilar(s) {
        Some(r) => Ok(r),
        None => fallar(ruta, "no compila"),
    }
}

fn en(xs: &[&str], v: &Value) -> bool {
    v.as_str().is_some_and(|s| xs.contains(&s))
}

const R_: &str = "conector";
const CLAVES_BASE: [&str; 9] = ["id", "nombre", "via", "verificado", "idRegex", "idMayusculas", "ejemplo", "estados", "faltaConector"];
const OPCIONALES_BASE: [&str; 2] = ["personaId", "comandoTicket"];

/// Valida lo común a toda vía y devuelve las claves de estado.
fn validar_base<'a>(raw: &'a Value, extras: &[&str]) -> R<(&'a Obj, Vec<&'a str>)> {
    let claves_ok: Vec<&str> = CLAVES_BASE.iter().chain(extras.iter()).copied().collect();
    let o = objeto(raw, R_, &claves_ok, &OPCIONALES_BASE)?;
    campo(&o["id"], &format!("{R_}.id"), 32, Some(ID_CONECTOR_RE))?;
    campo(&o["nombre"], &format!("{R_}.nombre"), 40, Some(NOMBRE_RE))?;
    booleano(&o["verificado"], &format!("{R_}.verificado"))?;
    let mayusculas = booleano(&o["idMayusculas"], &format!("{R_}.idMayusculas"))?;
    let rx = id_regex_valida(&o["idRegex"], &format!("{R_}.idRegex"))?;
    if let Some(p) = o.get("personaId") {
        id_regex_valida(p, &format!("{R_}.personaId"))?;
    }
    if let Some(c) = o.get("comandoTicket") {
        let c = campo(c, &format!("{R_}.comandoTicket"), 40, None)?;
        if let Some(problema) = problema_comando_ticket(c) {
            return fallar(&format!("{R_}.comandoTicket"), problema);
        }
    }

    let estados = lista(&o["estados"], &format!("{R_}.estados"), 1, 30)?;
    let mut claves: Vec<&str> = Vec::new();
    for (i, x) in estados.iter().enumerate() {
        let r = format!("{R_}.estados[{i}]");
        let e = objeto(x, &r, &["clave", "nombre", "categoria"], &[])?;
        campo(&e["nombre"], &format!("{r}.nombre"), 40, Some(SIN_ESCAPE))?;
        if !e["categoria"].as_str().is_some_and(|c| CATEGORIAS.contains(&c)) {
            return fallar(&format!("{r}.categoria"), format!("tiene que ser una de {}", CATEGORIAS.join(", ")));
        }
        claves.push(campo(&e["clave"], &format!("{r}.clave"), 40, Some(CLAVE_ESTADO_RE))?);
    }
    sin_repetidos(&claves, &format!("{R_}.estados"))?;
    if estados.iter().all(|e| e["categoria"].as_str() == Some("hecho")) {
        return fallar(&format!("{R_}.estados"), "hace falta al menos uno que no sea 'hecho'");
    }

    let ej = objeto(&o["ejemplo"], &format!("{R_}.ejemplo"), &["id", "estado", "prioridad", "proyecto"], &[])?;
    for (k, v) in ej {
        campo(v, &format!("{R_}.ejemplo.{k}"), 60, Some(SIN_ESCAPE))?;
    }
    let ej_id = ej["id"].as_str().unwrap_or("");
    if (mayusculas && ej_id != ej_id.to_uppercase()) || len16(ej_id) > ID_MAX || !re(ID_SEGURO_RE).is_match(ej_id) || !rx.is_match(ej_id) {
        return fallar(&format!("{R_}.ejemplo.id"), "no cumple idRegex");
    }
    if !claves.contains(&ej["estado"].as_str().unwrap_or("")) {
        return fallar(&format!("{R_}.ejemplo.estado"), "no es la clave de ningún estado");
    }

    let falta = objeto(&o["faltaConector"], &format!("{R_}.faltaConector"), &["clave", "mensaje"], &[])?;
    campo(&falta["clave"], &format!("{R_}.faltaConector.clave"), 40, Some(CLAVE_FALTA_RE))?;
    campo(&falta["mensaje"], &format!("{R_}.faltaConector.mensaje"), 300, None)?;
    Ok((o, claves))
}

fn validar_gh(raw: &Value) -> R<()> {
    let (_, claves) = validar_base(raw, &[])?;
    for (i, c) in claves.iter().enumerate() {
        if !ESTADOS_GH.contains(c) {
            return fallar(&format!("{R_}.estados[{i}].clave"), format!("con gh tiene que ser una de {}", ESTADOS_GH.join(", ")));
        }
    }
    if !claves.contains(&"abierto") {
        return fallar(&format!("{R_}.estados"), "con gh hace falta el estado 'abierto'");
    }
    Ok(())
}

fn validar_mcp(raw: &Value) -> R<()> {
    let (o, _) = validar_base(raw, &["herramientas", "pistas"])?;
    let h_ruta = format!("{R_}.herramientas");
    let h = objeto(&o["herramientas"], &h_ruta, &["prefijo", "lista", "detalle", "escritura", "negar"], &["apoyo", "apoyoEn", "personas"])?;
    campo(&h["prefijo"], &format!("{h_ruta}.prefijo"), 64, Some(PREFIJO_RE))?;
    let de_lista = herramientas(&h["lista"], &format!("{h_ruta}.lista"), 1, 20)?;
    let de_detalle = herramientas(&h["detalle"], &format!("{h_ruta}.detalle"), 0, 20)?;
    let negar = herramientas(&h["negar"], &format!("{h_ruta}.negar"), 0, 100)?;
    let acciones_str: Vec<&str> = ACCIONES.iter().map(|a| a.como_str()).collect();
    let escritura = objeto(&h["escritura"], &format!("{h_ruta}.escritura"), &[], &acciones_str)?;
    let mut de_escritura: Vec<&str> = Vec::new();
    for (a, t) in escritura {
        de_escritura.push(herramienta(t, &format!("{h_ruta}.escritura.{a}"))?);
    }
    let lectura: Vec<&str> = de_lista.iter().chain(de_detalle.iter()).copied().collect();
    if let Some(choca) = negar.iter().chain(de_escritura.iter()).find(|t| lectura.contains(t)) {
        return fallar(&h_ruta, format!("«{choca}» no puede ser de lectura y estar negada o escribir"));
    }
    let apoyo = match h.get("apoyo") {
        Some(v) => herramientas(v, &format!("{h_ruta}.apoyo"), 0, 10)?,
        None => Vec::new(),
    };
    if let Some(choca) = apoyo.iter().find(|t| negar.contains(t) || de_escritura.contains(t)) {
        return fallar(&format!("{h_ruta}.apoyo"), format!("«{choca}» no puede ser de apoyo y estar negada o escribir"));
    }
    let claves_escritura: Vec<&str> = escritura.keys().map(String::as_str).collect();
    let apoyo_en = match h.get("apoyoEn") {
        Some(v) => Some(objeto(v, &format!("{h_ruta}.apoyoEn"), &[], &claves_escritura)?),
        None => None,
    };
    if let Some(ae) = apoyo_en {
        for (a, x) in ae {
            let ruta = format!("{h_ruta}.apoyoEn.{a}");
            if let Some(choca) = herramientas(x, &ruta, 1, 5)?.iter().find(|t| negar.contains(t) || de_escritura.contains(t)) {
                return fallar(&ruta, format!("«{choca}» no puede ser de apoyo y estar negada o escribir"));
            }
        }
    }
    let de_personas = match h.get("personas") {
        Some(v) => Some(herramienta(v, &format!("{h_ruta}.personas"))?),
        None => None,
    };
    if let Some(p) = de_personas {
        if !de_lista.contains(&p) {
            return fallar(&format!("{h_ruta}.personas"), "tiene que estar también en herramientas.lista");
        }
    }
    if escritura.contains_key("criterio") && de_detalle.is_empty() {
        return fallar(&format!("{h_ruta}.escritura.criterio"), "tildar criterios necesita herramientas de detalle (de ahí salen sus ids)");
    }

    let p_ruta = format!("{R_}.pistas");
    let p = objeto(&o["pistas"], &p_ruta, &["yo", "lista", "detalle", "acciones"], &["estados", "apoyo", "listaPor", "listaHechos", "personas", "descripcion"])?;
    let yo = objeto(&p["yo"], &format!("{p_ruta}.yo"), &["conId", "sinId"], &[])?;
    let con_id = campo(&yo["conId"], &format!("{p_ruta}.yo.conId"), PISTA_MAX, None)?;
    if con_id.split("{id}").count() != 2 || tiene_llaves(&con_id.replacen("{id}", "", 1)) {
        return fallar(&format!("{p_ruta}.yo.conId"), "tiene que llevar {id} una sola vez y ninguna otra llave");
    }
    campo(&yo["sinId"], &format!("{p_ruta}.yo.sinId"), PISTA_MAX, None)?;
    campo(&p["lista"], &format!("{p_ruta}.lista"), PISTA_MAX, None)?;
    if let Some(e) = p.get("estados") {
        campo(e, &format!("{p_ruta}.estados"), PISTA_MAX, None)?;
    }
    if let Some(lp) = p.get("listaPor") {
        solo_placeholders(lp, &format!("{p_ruta}.listaPor"), &["asignados", "desde"])?;
        if !lp.as_str().unwrap_or("").contains("{asignados}") {
            return fallar(&format!("{p_ruta}.listaPor"), "tiene que llevar {asignados}");
        }
    }
    if let Some(lh) = p.get("listaHechos") {
        solo_placeholders(lh, &format!("{p_ruta}.listaHechos"), &["desde"])?;
    }
    if let Some(pe) = p.get("personas") {
        campo(pe, &format!("{p_ruta}.personas"), PISTA_MAX, None)?;
    }
    if p.contains_key("listaPor") != de_personas.is_some() || p.contains_key("personas") != de_personas.is_some() {
        return fallar(&p_ruta, "herramientas.personas, pistas.personas y pistas.listaPor van juntas");
    }
    if p.contains_key("listaHechos") && !p.contains_key("listaPor") {
        return fallar(&format!("{p_ruta}.listaHechos"), "necesita pistas.listaPor");
    }
    if let Some(a) = p.get("apoyo") {
        solo_placeholders(a, &format!("{p_ruta}.apoyo"), &["ticket"])?;
    }
    if p.contains_key("apoyo") == apoyo.is_empty() {
        return fallar(&format!("{p_ruta}.apoyo"), "la pista de apoyo y las herramientas de apoyo van juntas");
    }
    if apoyo_en.is_some_and(|m| !m.is_empty()) && !p.contains_key("apoyo") {
        return fallar(&format!("{h_ruta}.apoyoEn"), "necesita la pista de apoyo");
    }

    let pasos = lista(&p["detalle"], &format!("{p_ruta}.detalle"), 0, 20)?;
    if pasos.is_empty() == !de_detalle.is_empty() {
        return fallar(&format!("{p_ruta}.detalle"), "hay pasos de detalle sin herramientas de detalle o al revés");
    }
    if let Some(d) = p.get("descripcion") {
        campo(d, &format!("{p_ruta}.descripcion"), PISTA_MAX, None)?;
        if pasos.is_empty() {
            return fallar(&format!("{p_ruta}.descripcion"), "necesita pasos de detalle de donde sacarla");
        }
    }
    for (i, x) in pasos.iter().enumerate() {
        let r = format!("{p_ruta}.detalle[{i}]");
        let paso = objeto(x, &r, &["herramienta", "args"], &[])?;
        if !en(&de_detalle, &paso["herramienta"]) {
            return fallar(&format!("{r}.herramienta"), "no está en herramientas.detalle");
        }
        args(&paso["args"], &format!("{r}.args"), &["ticket"], 1)?;
    }

    let acciones = objeto(&p["acciones"], &format!("{p_ruta}.acciones"), &claves_escritura, &[])?;
    for (a, x) in acciones {
        let r = format!("{p_ruta}.acciones.{a}");
        let pista = objeto(x, &r, &["args"], &["nota"])?;
        let permitidos = placeholders(Accion::de_str(a).unwrap_or(Accion::Soltar));
        args(&pista["args"], &format!("{r}.args"), permitidos, 1)?;
        if let Some(n) = pista.get("nota") {
            solo_placeholders(n, &format!("{r}.nota"), permitidos)?;
        }
    }
    Ok(())
}

fn validar(raw: &Value) -> R<()> {
    let Some(o) = raw.as_object() else { return fallar(R_, "tiene que ser un objeto") };
    match o.get("via").and_then(Value::as_str) {
        Some("mcp") => validar_mcp(raw),
        Some("gh") => validar_gh(raw),
        _ => fallar(&format!("{R_}.via"), "vía no soportada"),
    }
}

/// Valida un conector y devuelve una copia nueva. Falla con la ruta del problema.
pub fn validar_conector(raw: &Value) -> R<ConectorDef> {
    solo_datos(raw, "conector", 0)?;
    let json = serde_json::to_string(raw).unwrap_or_default();
    if len16(&json) > TAM_MAX {
        return fallar("conector", "pesa más de 64 KB");
    }
    let copia: Value = serde_json::from_str(&json).unwrap_or(Value::Null);
    validar(&copia)?;
    ConectorDef::desde_validado(&copia).or_else(|e| fallar("conector", e))
}

pub fn regex_de_id(id_regex: &str) -> Option<Regex> {
    compilar(id_regex)
}

/// El id normalizado si es válido para el conector; si no, None. Lo usan el motor, el tablero y el diálogo de espacio nuevo.
pub fn id_normalizado(id_regex: &str, id_mayusculas: bool, v: &Value) -> Option<String> {
    let t = super::texto::trim_js(v.as_str()?);
    let s = if id_mayusculas { t.to_uppercase() } else { t.to_string() };
    (len16(&s) <= ID_MAX && re(ID_SEGURO_RE).is_match(&s) && regex_de_id(id_regex)?.is_match(&s)).then_some(s)
}

/// Lo mismo que `normTicketId` de templates-shared: un id que va al PTY y a nombres de rama.
pub fn norm_ticket_id(raw: &str) -> Option<String> {
    let t = super::texto::trim_js(raw);
    if re(r"^[A-Z][A-Z0-9]*-\d+$").is_match(&t.to_uppercase()) {
        return Some(t.to_uppercase());
    }
    (re(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$").is_match(t) && !t.contains("..")).then(|| t.to_string())
}

/// El id con el que arranca un espacio que lleva comando: el del conector y, además, uno que main acepta como `ticket`.
pub fn id_para_comando(id_regex: &str, id_mayusculas: bool, v: &Value) -> Option<String> {
    let id = id_normalizado(id_regex, id_mayusculas, v)?;
    norm_ticket_id(&id).is_some().then_some(id)
}

pub fn regex_de_persona(base: &ConectorBase) -> Regex {
    match &base.persona_id {
        None => re(PERSONA_POR_DEFECTO),
        Some(p) => compilar(p).unwrap_or_else(|| re(PERSONA_POR_DEFECTO)),
    }
}

pub fn es_categoria_hecho(e: &Estado) -> bool {
    e.categoria == Categoria::Hecho
}

#[cfg(test)]
mod tests {
    use super::super::conectores::{conector_por_id, crudo, CONECTORES};
    use super::*;
    use serde_json::json;

    /// Copia de Gruv con un valor cambiado en `ruta` (a.b.0.c); `None` saca la clave.
    fn con(ruta: &str, valor: Option<Value>) -> Value {
        let mut d = crudo("gruv");
        poner(&mut d, &ruta.split('.').collect::<Vec<_>>(), valor);
        d
    }

    fn poner(d: &mut Value, partes: &[&str], valor: Option<Value>) {
        let (p, resto) = partes.split_first().unwrap();
        let hijo = match d {
            Value::Array(xs) => xs.get_mut(p.parse::<usize>().unwrap()),
            Value::Object(o) => {
                if resto.is_empty() {
                    match valor {
                        Some(v) => {
                            o.insert((*p).to_string(), v);
                        }
                        None => {
                            o.shift_remove(*p);
                        }
                    }
                    return;
                }
                o.get_mut(*p)
            }
            _ => None,
        };
        let hijo = hijo.unwrap();
        if resto.is_empty() {
            *hijo = valor.unwrap();
        } else {
            poner(hijo, resto, valor);
        }
    }

    fn c(ruta: &str, v: Value) -> Value {
        con(ruta, Some(v))
    }

    fn rechaza(raw: &Value, motivo: &str) {
        let e = validar_conector(raw).expect_err("tenía que rechazarlo");
        let msg = e.to_string();
        assert!(Regex::new(motivo).unwrap().is_match(&msg), "{msg} no calza con {motivo}");
    }

    #[test]
    fn gruv_valida_y_la_copia_es_igual_e_idempotente() {
        let raw = crudo("gruv");
        let def = validar_conector(&raw).unwrap();
        assert_eq!(def.a_valor(), raw);
        assert_eq!(validar_conector(&def.a_valor()).unwrap(), def);
    }

    #[test]
    fn el_registro_trae_gruv_y_github_validados() {
        let ids: Vec<&str> = CONECTORES.iter().map(|c| c.id()).filter(|id| *id == "gruv" || *id == "github").collect();
        assert_eq!(ids, vec!["github", "gruv"]);
        assert_eq!(conector_por_id("github").unwrap().a_valor(), crudo("github"));
        assert!(conector_por_id("trello").is_none());
        assert_eq!(CONECTORES.len(), 12);
    }

    #[test]
    fn una_alternancia_no_desancla_la_regex_de_id() {
        let alt = validar_conector(&c("idRegex", json!("^TCK-\\d+|B-\\d+$"))).unwrap();
        let r = regex_de_id(&alt.base().id_regex).unwrap();
        assert!(r.is_match("TCK-1"));
        assert!(!r.is_match("TCK-1xx"));
        assert!(!r.is_match("xxB-1"));
        let def = validar_conector(&crudo("gruv")).unwrap();
        assert_eq!(def.mcp().unwrap().nombre_completo("ver_reloj"), "mcp__claude_ai_Gruv__ver_reloj");
    }

    #[test]
    fn rechazos() {
        let gruv = crudo("gruv");
        let sin_detalle = {
            let mut d = c("herramientas.detalle", json!([]));
            d["pistas"]["detalle"] = json!([]);
            d
        };
        let apoyo_otra_llave = {
            let mut d = c("herramientas.apoyo", json!(["ver_mi_inicio"]));
            d["pistas"]["apoyo"] = json!("Para {estado}");
            d
        };
        let casos: Vec<(&str, Value, &str)> = vec![
            ("raíz que no es objeto", json!([]), "tiene que ser un objeto"),
            ("demasiado anidado", c("pistas.acciones.horas.args.minutos", json!({ "a": { "b": { "c": 1 } } })), "niveles"),
            ("más de 64 KB", c("herramientas.negar", Value::Array((0..3000).map(|i| json!(format!("herramienta_{i}_{}", "x".repeat(20)))).collect())), "64 KB"),
            ("clave desconocida arriba", c("extra", json!(1)), r"conector\.extra: clave desconocida"),
            ("clave desconocida adentro", c("pistas.yo.otro", json!("x")), r"pistas\.yo\.otro: clave desconocida"),
            ("vía desconocida", c("via", json!("jira")), "conector.via: vía no soportada"),
            ("vía gh con herramientas", c("via", json!("gh")), "conector.herramientas: clave desconocida"),
            ("falta una clave", con("faltaConector", None), "faltaConector: falta"),
            ("id de conector", c("id", json!("Gruv")), r"conector\.id: tiene un formato inválido"),
            ("nombre con símbolos", c("nombre", json!("Gr<uv>")), r"conector\.nombre: tiene un formato inválido"),
            ("booleano", c("verificado", json!("si")), "true o false"),
            ("salto de línea en una pista", c("pistas.lista", json!("a\nb")), "control o saltos de línea"),
            ("pista larga", c("pistas.lista", json!("x".repeat(1001))), "más de 1000 caracteres"),
            ("comillas en el ejemplo", c("ejemplo.proyecto", json!("a\"b")), r"ejemplo\.proyecto: tiene un formato inválido"),
            ("llave en un nombre de estado", c("estados.0.nombre", json!("A{b}")), r"estados\[0\]\.nombre"),
            ("clave de estado", c("estados.0.clave", json!("Abierto")), r"estados\[0\]\.clave"),
            ("categoría", c("estados.0.categoria", json!("cerrado")), r"estados\[0\]\.categoria"),
            ("estado repetido", c("estados.1.clave", json!("abierto")), "«abierto» está repetido"),
            ("sin estados", c("estados", json!([])), "entre 1 y 30"),
            ("todos hecho", c("estados", json!([{ "clave": "cerrado", "nombre": "Cerrado", "categoria": "hecho" }])), "al menos uno que no sea 'hecho'"),
            ("clave de faltaConector", c("faltaConector.clave", json!("X")), r"faltaConector\.clave"),
            ("mensaje largo", c("faltaConector.mensaje", json!("x".repeat(301))), "más de 300"),
            ("prefijo", c("herramientas.prefijo", json!("mcp__Gruv_")), "prefijo: tiene un formato inválido"),
            ("nombre de herramienta", c("herramientas.lista.0", json!("listar tickets")), r"lista\[0\]: tiene un formato inválido"),
            ("herramienta repetida", c("herramientas.lista", json!(["listar_tickets", "listar_tickets"])), "repetido"),
            ("lista vacía", c("herramientas.lista", json!([])), "entre 1 y 20"),
            ("lectura negada", c("herramientas.negar", json!(["listar_tickets"])), "«listar_tickets» no puede ser de lectura"),
            ("lectura que escribe", c("herramientas.escritura.comentar", json!("ver_reloj")), "«ver_reloj» no puede ser de lectura"),
            ("acción desconocida", c("herramientas.escritura.borrar", json!("borrar_ticket")), r"escritura\.borrar: clave desconocida"),
            ("criterio sin detalle", sin_detalle, "tildar criterios necesita"),
            ("pasos sin herramientas de detalle", c("pistas.detalle", json!([])), "pasos de detalle"),
            ("paso con herramienta ajena", c("pistas.detalle.0.herramienta", json!("listar_tickets")), r"no está en herramientas\.detalle"),
            ("placeholder ajeno en el detalle", c("pistas.detalle.0.args.id", json!("{estado}")), r"solo admite \{ticket\}"),
            ("sin argumentos", c("pistas.acciones.estado.args", json!({})), "entre 1 y 10 argumentos"),
            ("nombre de argumento", c("pistas.acciones.estado.args", json!({ "Id": "{ticket}" })), "nombre de argumento inválido"),
            ("argumento lista", c("pistas.acciones.estado.args.id", json!(["x"])), "texto no vacío"),
            ("placeholder de otra acción", c("pistas.acciones.estado.args.id", json!("{cuerpo}")), r"solo admite \{ticket\}, \{estado\}"),
            ("placeholder a medias", c("pistas.acciones.estado.args.id", json!("TCK {ticket}")), "como valor completo"),
            ("nota con otra llave", c("pistas.acciones.estado.nota", json!("Para {persona}")), r"nota: solo admite \{ticket\}, \{estado\}"),
            ("nota de comentar con {estado}", c("pistas.acciones.comentar.nota", json!("Pasalo a {estado}")), r"comentar\.nota: solo admite \{ticket\}, \{cuerpo\}"),
            ("personaId sin anclar", c("personaId", json!("[a-z]+")), "personaId: tiene que estar anclada"),
            ("apoyo negado", c("herramientas.apoyo", json!(["mover_ticket"])), "«mover_ticket» no puede ser de apoyo"),
            ("apoyo que escribe", c("herramientas.apoyo", json!(["sumar_al_reloj"])), "«sumar_al_reloj» no puede ser de apoyo"),
            ("pista de apoyo sin herramientas", c("pistas.apoyo", json!("Antes mirá el ticket {ticket}.")), "pistas.apoyo: la pista de apoyo"),
            ("herramientas de apoyo sin pista", c("herramientas.apoyo", json!(["ver_mi_inicio"])), "pistas.apoyo: la pista de apoyo"),
            ("pista de apoyo con otra llave", apoyo_otra_llave, r"pistas\.apoyo: solo admite \{ticket\}"),
            ("args anidados de más", c("pistas.acciones.tomar.args", json!({ "id": "{ticket}", "a": { "b": { "c": { "d": "{persona}" } } } })), "niveles"),
            ("placeholder ajeno anidado", c("pistas.acciones.tomar.args", json!({ "id": "{ticket}", "a": { "b": "{cuerpo}" } })), r"tomar\.args\.a\.b: solo admite"),
            ("lista en los args", c("pistas.acciones.tomar.args", json!({ "id": "{ticket}", "a": { "b": ["x"] } })), "texto no vacío"),
            ("pista de acción que falta", con("pistas.acciones.comentar", None), r"acciones\.comentar: falta"),
            ("pista de acción sin herramienta", con("herramientas.escritura.comentar", None), r"acciones\.comentar: clave desconocida"),
            ("personas fuera de la lista", c("herramientas.personas", json!("ver_reloj")), r"personas: tiene que estar también en herramientas\.lista"),
            ("personas sin pistas", con("pistas.personas", None), r"herramientas\.personas, pistas\.personas y pistas\.listaPor van juntas"),
            ("pistas de personas sin herramienta", con("herramientas.personas", None), "van juntas"),
            ("listaPor con otra llave", c("pistas.listaPor", json!("Con {asignados} y {estado}")), r"listaPor: solo admite \{asignados\}, \{desde\}"),
            ("listaPor sin {asignados}", c("pistas.listaPor", json!("Con {desde}")), r"listaPor: tiene que llevar \{asignados\}"),
            ("listaHechos con otra llave", c("pistas.listaHechos", json!("Con {asignados}")), r"listaHechos: solo admite \{desde\}"),
            ("conId sin {id}", c("pistas.yo.conId", json!("Tu id es fijo.")), "una sola vez"),
            ("conId con dos {id}", c("pistas.yo.conId", json!("{id} y {id}")), "una sola vez"),
            ("regex sin ^", c("idRegex", json!("[A-Z]+-\\d+$")), "anclada"),
            ("regex con $ escapado", c("idRegex", json!("^[A-Z]+-\\d+\\$")), "anclada"),
            ("grupo cuantificado", c("idRegex", json!("^(A+)+-\\d$")), "grupos cuantificados"),
            ("referencia hacia atrás", c("idRegex", json!("^(A)\\1-\\d$")), "referencias hacia atrás"),
            ("lookaround", c("idRegex", json!("^(?=A)A-\\d$")), "lookarounds"),
            ("regex que no compila", c("idRegex", json!("^[A-$")), "no compila"),
            ("ejemplo en minúsculas", c("ejemplo.id", json!("tck-1234")), r"ejemplo\.id: no cumple idRegex"),
            ("ejemplo largo", c("ejemplo.id", json!("ABCDEFGHIJKLMNOP-1234")), r"ejemplo\.id: no cumple idRegex"),
            ("ejemplo de estado", c("ejemplo.estado", json!("hecho")), "ningún estado"),
        ];
        assert!(!gruv.is_null());
        for (nombre, raw, motivo) in casos {
            let e = validar_conector(&raw).err().unwrap_or_else(|| panic!("{nombre}: tenía que rechazarlo"));
            let msg = e.to_string();
            assert!(Regex::new(motivo).unwrap().is_match(&msg), "{nombre}: {msg} no calza con {motivo}");
        }
    }

    #[test]
    fn la_ruta_del_error_queda_en_el_error() {
        let e = validar_conector(&c("herramientas.lista.1", json!("x y"))).unwrap_err();
        assert_eq!(e.ruta, "conector.herramientas.lista[1]");
    }

    #[test]
    fn github_valida_no_lleva_herramientas_ni_pistas_y_solo_admite_los_estados_de_gh() {
        let gh = crudo("github");
        assert_eq!(validar_conector(&gh).unwrap().a_valor(), gh);
        let mut con_pistas = gh.clone();
        con_pistas["pistas"] = json!({});
        rechaza(&con_pistas, r"conector\.pistas: clave desconocida");
        let mut otro = gh.clone();
        otro["estados"].as_array_mut().unwrap().push(json!({ "clave": "en_curso", "nombre": "En curso", "categoria": "en_curso" }));
        rechaza(&otro, r"estados\[2\]\.clave: con gh");
        let mut sin_abierto = gh.clone();
        sin_abierto["estados"] = json!([{ "clave": "cerrado", "nombre": "Cerrado", "categoria": "pendiente" }]);
        sin_abierto["ejemplo"]["estado"] = json!("cerrado");
        rechaza(&sin_abierto, "hace falta el estado 'abierto'");
    }

    #[test]
    fn acepta_args_anidados_notas_con_placeholders_de_la_accion_apoyo_y_persona_id() {
        let mut d = crudo("gruv");
        d["personaId"] = json!("^[A-Za-z0-9:-]{1,128}$");
        d["herramientas"]["apoyo"] = json!(["ver_mi_inicio", "buscar_persona"]);
        d["pistas"]["apoyo"] = json!("Mirá antes el ticket {ticket}.");
        d["pistas"]["acciones"]["tomar"] = json!({ "args": { "id": "{ticket}", "campos": { "responsable": { "id": "{persona}" } } }, "nota": "Para {persona} en {ticket}." });
        d["pistas"]["acciones"]["estado"] = json!({ "args": { "id": "{ticket}", "estado": "{estado}" }, "nota": "Al estado {estado}." });
        assert!(validar_conector(&d).is_ok());
    }

    fn con_apoyo_en(apoyo_en: Value, pista: bool) -> Value {
        let mut d = c("herramientas.apoyoEn", apoyo_en);
        d["herramientas"]["apoyo"] = json!(["ver_mi_inicio"]);
        if pista {
            d["pistas"]["apoyo"] = json!("Mirá antes el ticket {ticket}.");
        } else {
            d["herramientas"].as_object_mut().unwrap().shift_remove("apoyo");
        }
        d
    }

    #[test]
    fn apoyo_en_herramientas_de_lectura_solo_para_una_accion() {
        assert!(validar_conector(&con_apoyo_en(json!({ "estado": ["buscar_persona"] }), true)).is_ok());
        rechaza(&con_apoyo_en(json!({ "estado": ["mover_ticket"] }), true), "«mover_ticket» no puede ser de apoyo");
        rechaza(&con_apoyo_en(json!({ "borrar": ["buscar_persona"] }), true), r"apoyoEn\.borrar: clave desconocida");
        rechaza(&con_apoyo_en(json!({ "estado": [] }), true), r"apoyoEn\.estado");
        rechaza(&con_apoyo_en(json!({ "estado": ["buscar_persona"] }), false), "apoyoEn: necesita la pista de apoyo");
    }

    #[test]
    fn regex_de_persona_la_del_conector_o_la_de_siempre() {
        let g = validar_conector(&crudo("gruv")).unwrap();
        assert!(regex_de_persona(g.base()).is_match("a1-b"));
        assert!(!regex_de_persona(g.base()).is_match("557058:abc"));
        let mut raw = crudo("gruv");
        raw["personaId"] = json!("^[a-z]+|[0-9]+$");
        let d = validar_conector(&raw).unwrap();
        assert!(regex_de_persona(d.base()).is_match("abc"));
        assert!(!regex_de_persona(d.base()).is_match("abc1"));
    }

    #[test]
    fn comando_ticket_opcional_con_forma_de_comando() {
        let largo = format!("/{}", "a".repeat(39));
        for ok in ["/ticket", "/mi:cmd", "/a", "/x_y-z9", largo.as_str()] {
            let d = validar_conector(&c("comandoTicket", json!(ok))).unwrap();
            assert_eq!(d.base().comando_ticket.as_deref(), Some(ok));
        }
        let largo40 = format!("/{}", "a".repeat(40));
        for mal in [json!("ticket"), json!("/Ticket"), json!("/a b"), json!("/x;rm"), json!("/ticket\n"), json!("/ticket\r"), json!("/"), json!("/1a"), json!("/$(x)"), json!("/a|b"), json!(largo40), json!(5), json!(""), json!(null), json!(["/ticket"])] {
            rechaza(&c("comandoTicket", mal), "comandoTicket");
        }
        assert_eq!(validar_conector(&con("comandoTicket", None)).unwrap().base().comando_ticket, None);
        assert_eq!(validar_conector(&crudo("github")).unwrap().base().comando_ticket, None);
    }

    #[test]
    fn comando_ticket_los_comandos_que_cambian_la_sesion_no_pasan() {
        for cmd in ["/logout", "/login", "/add-dir", "/config", "/permissions", "/mcp", "/plugin", "/exit", "/clear", "/model", "/install-github-app"] {
            rechaza(&c("comandoTicket", json!(cmd)), "comandoTicket.*no puede ser el del ticket");
        }
        for cmd in COMANDOS_PROHIBIDOS.iter().chain(COMANDOS_PROHIBIDOS_2.iter()) {
            assert!(problema_comando_ticket(&format!("/{cmd}")).is_some(), "{cmd}");
        }
        for ok in ["/ticket", "/mi:cmd", "/plugin:logout", "/logout2", "/clear-ticket"] {
            assert_eq!(problema_comando_ticket(ok), None, "{ok}");
        }
    }

    #[test]
    fn id_normalizado_e_id_para_comando() {
        let g = validar_conector(&crudo("gruv")).unwrap();
        let b = g.base();
        assert_eq!(id_normalizado(&b.id_regex, b.id_mayusculas, &json!(" abc-12 ")).as_deref(), Some("ABC-12"));
        assert_eq!(id_normalizado(&b.id_regex, b.id_mayusculas, &json!("123")), None);
        assert_eq!(id_normalizado(&b.id_regex, b.id_mayusculas, &json!(7)), None);
        assert_eq!(id_para_comando(r"^\d+$", false, &json!("123")).as_deref(), Some("123"));
        assert_eq!(id_para_comando(r"^\d+$", false, &json!("abc")), None);
        assert_eq!(id_para_comando(r"^[a-z]+-\d+$", false, &json!("proj-12")).as_deref(), Some("proj-12"));
        assert_eq!(id_normalizado(r"^#\d+$", false, &json!("#12")).as_deref(), Some("#12"));
        assert_eq!(id_para_comando(r"^#\d+$", false, &json!("#12")), None);
        assert_eq!(id_para_comando("^.+$", false, &json!("a b")), None);
        assert_eq!(id_para_comando("^.+$", false, &json!("a..b")), None);
    }

    #[test]
    fn pistas_descripcion_es_un_texto_acotado_y_necesita_pasos_de_detalle() {
        assert!(validar_conector(&crudo("gruv")).is_ok());
        assert!(crudo("gruv")["pistas"]["descripcion"].is_string());
        rechaza(&c("pistas.descripcion", json!("")), "descripcion: tiene que ser un texto no vacío");
        rechaza(&c("pistas.descripcion", json!("x".repeat(1001))), "más de 1000 caracteres");
        let mut sin_criterio = crudo("gruv");
        sin_criterio["herramientas"]["escritura"].as_object_mut().unwrap().shift_remove("criterio");
        sin_criterio["pistas"]["acciones"].as_object_mut().unwrap().shift_remove("criterio");
        sin_criterio["herramientas"]["detalle"] = json!([]);
        sin_criterio["pistas"]["detalle"] = json!([]);
        rechaza(&sin_criterio, "necesita pasos de detalle");
    }
}
