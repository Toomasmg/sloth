//! Qué servidores MCP tiene cada cuenta y cuál le sirve a cada conector. Un preset espera un prefijo (p. ej. el conector de
//! claude.ai `mcp__claude_ai_Gruv__`), pero la cuenta puede tener el mismo sistema como MCP propio con otro nombre
//! (`gruv-tomy`): se adapta solo el prefijo, nunca las herramientas. Lo que viene de `system/init` o de Claude es dato no
//! confiable: se valida todo. Equivale a src/main/features/tickets/cuentas.ts.
use super::conector::{ConectorMcp, CORTO_RE, PREFIJO_RE};
use super::errores::{ErrorTickets, Res};
use super::modelo::{CuentaRevisada, Disponibilidad, EstadoMcp, OpcionServidor, Ordenado, ServidorMcp};
use super::texto::{cortar16, len16, num_valor, numero, re, trim_js, Num};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

pub const REVISAR_MAX: usize = 400;
const HERRAMIENTAS_MAX: usize = 150;
const SERVIDORES_MAX: usize = 100;
const NOMBRE_MAX: usize = 128;
const ERROR_MAX: usize = 500;
const CUENTAS_MAX: usize = 50;
const PALABRAS_FUERA: [&str; 3] = ["mcp", "claude", "com"];
const FALTAN_MAX: usize = 10;

/// Una revisión más nueva que esto se cree: el problema es de ahora, no de antes de que la persona lo arreglara.
pub const REVISION_VIGENTE_MS: f64 = 60_000.0;

pub fn revisar_schema() -> Value {
    json!({ "type": "object", "properties": { "herramientas": { "type": "array", "items": { "type": "string" }, "maxItems": REVISAR_MAX } }, "required": ["herramientas"] })
}

pub fn build_revisar_prompt() -> String {
    "No llames a ninguna herramienta. Devolvé en \"herramientas\" los nombres completos de todas tus herramientas que empiezan con «mcp__». Si no hay ninguna, devolvé la lista vacía.".into()
}

/// Como arma Claude Code el prefijo: «claude.ai Atlassian MCP» → `mcp__claude_ai_Atlassian_MCP__`.
pub fn prefijo_de_servidor(nombre: &str) -> Option<String> {
    if nombre.is_empty() || len16(nombre) > 64 {
        return None;
    }
    // JavaScript reemplaza por unidad UTF-16: un carácter fuera del plano básico deja dos guiones bajos.
    let mut cuerpo = String::new();
    for c in nombre.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            cuerpo.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                cuerpo.push('_');
            }
        }
    }
    let p = format!("mcp__{cuerpo}__");
    re(PREFIJO_RE).is_match(&p).then_some(p)
}

type Msg = Map<String, Value>;

fn textos(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(xs)) => xs.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
        _ => Vec::new(),
    }
}

fn estado_de(v: Option<&Value>) -> EstadoMcp {
    match v.and_then(Value::as_str) {
        Some(s) if s != "otro" => EstadoMcp::de_str(s).unwrap_or(EstadoMcp::Otro),
        _ => EstadoMcp::Otro,
    }
}

fn nombre_valido(v: Option<&Value>) -> Option<&str> {
    let s = v?.as_str()?;
    (!s.is_empty() && len16(s) <= NOMBRE_MAX && !s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')).then_some(s)
}

fn parsear(texto: &str) -> Option<Value> {
    serde_json::from_str(texto).ok()
}

fn solo_objetos(v: Vec<Value>) -> Vec<Msg> {
    v.into_iter().filter_map(|x| if let Value::Object(o) = x { Some(o) } else { None }).collect()
}

/// Acepta la salida de `--output-format json` (un arreglo) y la de `stream-json` (un mensaje por línea).
fn mensajes(stdout: &str) -> Option<Vec<Msg>> {
    if let Some(raw) = parsear(trim_js(stdout)) {
        return Some(solo_objetos(if let Value::Array(xs) = raw { xs } else { vec![raw] }));
    }
    let xs = solo_objetos(stdout.split('\n').filter(|l| !trim_js(l).is_empty()).filter_map(|l| parsear(trim_js(l))).collect());
    (!xs.is_empty()).then_some(xs)
}

/// Reparte los nombres completos entre los servidores. Cada uno va al prefijo más largo que calce: `mcp__gruv__x__otra`
/// es del servidor `gruv__x`, no una herramienta `x__otra` de `gruv`.
fn repartir(servidores: &[ServidorMcp], nombres: &[String]) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    let mut por_largo: Vec<&ServidorMcp> = servidores.iter().collect();
    por_largo.sort_by_key(|s| std::cmp::Reverse(s.prefijo.len()));
    let corto_ok = re(CORTO_RE);
    for n in nombres {
        let Some(s) = por_largo.iter().find(|x| n.starts_with(&x.prefijo)) else { continue };
        let corto = &n[s.prefijo.len()..];
        if !corto_ok.is_match(corto) {
            continue;
        }
        let xs = out.entry(s.prefijo.clone()).or_default();
        if !xs.iter().any(|x| x == corto) && xs.len() < HERRAMIENTAS_MAX {
            xs.push(corto.to_string());
        }
    }
    for xs in out.values_mut() {
        xs.sort();
    }
    out
}

/// Los servidores del `system/init` de `--verbose` (con `json` o `stream-json`). La respuesta de Claude solo completa
/// herramientas de servidores que ya vinieron en init y no las listaron. None sin init.
pub fn servidores_de_salida(stdout: &str) -> Option<Vec<ServidorMcp>> {
    let msgs = mensajes(stdout)?;
    let init = msgs.iter().find(|m| m.get("type") == Some(&json!("system")) && m.get("subtype") == Some(&json!("init")))?;
    let crudos: Vec<&Value> = match init.get("mcp_servers") {
        Some(Value::Array(xs)) => xs.iter().take(SERVIDORES_MAX).collect(),
        _ => Vec::new(),
    };
    let mut leidos: Vec<ServidorMcp> = Vec::new();
    for c in crudos {
        let Some(o) = c.as_object() else { continue };
        let Some(nombre) = nombre_valido(o.get("name")) else { continue };
        if let Some(prefijo) = prefijo_de_servidor(nombre) {
            leidos.push(ServidorMcp { nombre: nombre.to_string(), prefijo, estado: estado_de(o.get("status")), herramientas: None });
        }
    }
    // Dos servidores con el mismo prefijo no se pueden distinguir: habilitar uno habilitaría el otro.
    let mut servidores: Vec<ServidorMcp> = leidos.iter().filter(|s| leidos.iter().filter(|x| x.prefijo == s.prefijo).count() == 1).cloned().collect();
    let de_init = repartir(&servidores, &textos(init.get("tools")));
    for s in &mut servidores {
        if let Some(xs) = de_init.get(&s.prefijo) {
            s.herramientas = Some(xs.clone());
        } else if s.estado == EstadoMcp::Conectado {
            s.herramientas = Some(Vec::new());
        }
    }
    let result = msgs.iter().find(|m| m.get("type") == Some(&json!("result")));
    let so = result.and_then(|r| r.get("structured_output")).and_then(Value::as_object);
    if let Some(so) = so {
        if servidores.iter().any(|s| s.herramientas.is_none()) {
            let nombres: Vec<String> = textos(so.get("herramientas")).into_iter().take(REVISAR_MAX).collect();
            let de_claude = repartir(&servidores, &nombres);
            for s in servidores.iter_mut().filter(|s| s.herramientas.is_none()) {
                if let Some(xs) = de_claude.get(&s.prefijo).filter(|xs| !xs.is_empty()) {
                    s.herramientas = Some(xs.clone());
                }
            }
        }
    }
    Some(servidores)
}

pub fn revisar_cuenta(stdout: &str, ahora: f64) -> Res<CuentaRevisada> {
    let servidores = servidores_de_salida(stdout).ok_or_else(|| ErrorTickets::otro("No entendí la respuesta de Claude."))?;
    Ok(CuentaRevisada { revisada_en: Num(ahora), servidores, error: None })
}

/// Con `stream-json` el init llega antes de que el modelo arranque: si ningún servidor quedó pending, ya está todo lo que
/// hace falta y no vale la pena esperar el turno del modelo.
pub fn revisar_temprano(linea: &str, ahora: f64) -> Option<CuentaRevisada> {
    let raw = parsear(trim_js(linea))?;
    let o = raw.as_object()?;
    if o.get("type") != Some(&json!("system")) || o.get("subtype") != Some(&json!("init")) {
        return None;
    }
    let servidores = servidores_de_salida(linea)?;
    if servidores.iter().any(|s| s.estado == EstadoMcp::Pendiente) {
        return None;
    }
    Some(CuentaRevisada { revisada_en: Num(ahora), servidores, error: None })
}

fn nucleo(prefijo: &str) -> String {
    let sin_ini = prefijo.strip_prefix("mcp__").unwrap_or(prefijo);
    sin_ini.strip_suffix("__").unwrap_or(sin_ini).to_lowercase()
}

pub fn palabras(def: &ConectorMcp) -> Vec<String> {
    let nucleo = nucleo(&def.herramientas.prefijo);
    let nucleo = nucleo.strip_prefix("claude_ai_").unwrap_or(&nucleo).to_string();
    let mut xs: Vec<String> = def.id().split('-').map(str::to_string).collect();
    xs.extend(def.nombre().to_lowercase().split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit())).map(str::to_string));
    xs.extend(nucleo.split('_').map(str::to_string));
    let mut out: Vec<String> = Vec::new();
    for x in xs {
        if len16(&x) >= 3 && !PALABRAS_FUERA.contains(&x.as_str()) && !out.contains(&x) {
            out.push(x);
        }
    }
    out
}

fn tiene_lista(def: &ConectorMcp, s: &ServidorMcp) -> bool {
    match &s.herramientas {
        None => true,
        Some(hs) => def.herramientas.lista.iter().all(|t| hs.contains(t)),
    }
}

fn comparte_nombre(ps: &[String], s: &ServidorMcp) -> bool {
    let n = nucleo(&s.prefijo);
    ps.iter().any(|p| n.contains(p.as_str()))
}

/// Los servidores de la cuenta que pueden ser el de este conector, con el exacto primero.
pub fn candidatos<'a>(def: &ConectorMcp, servidores: &'a [ServidorMcp]) -> Vec<&'a ServidorMcp> {
    let exacto = servidores.iter().find(|s| s.prefijo == def.herramientas.prefijo);
    let ps = palabras(def);
    let otros = servidores.iter().filter(|s| exacto.map_or(true, |e| !std::ptr::eq(*s, e)) && comparte_nombre(&ps, s) && tiene_lista(def, s));
    exacto.into_iter().chain(otros).collect()
}

/// Servidores con otro nombre que tienen todas las herramientas de la lista. Con una lista de una sola herramienta el
/// parecido puede ser casualidad, así que no cuentan.
pub fn por_herramientas<'a>(def: &ConectorMcp, servidores: &'a [ServidorMcp]) -> Vec<&'a ServidorMcp> {
    let lista = &def.herramientas.lista;
    if lista.len() < 2 {
        return Vec::new();
    }
    let ps = palabras(def);
    servidores
        .iter()
        .filter(|s| s.prefijo != def.herramientas.prefijo && s.herramientas.as_ref().is_some_and(|hs| !comparte_nombre(&ps, s) && lista.iter().all(|t| hs.contains(t))))
        .collect()
}

/// Lo que se puede elegir para el conector en una cuenta: los del mismo nombre y los que tienen sus herramientas.
pub fn elegibles<'a>(def: &ConectorMcp, servidores: &'a [ServidorMcp]) -> Vec<&'a ServidorMcp> {
    let mut v = candidatos(def, servidores);
    v.extend(por_herramientas(def, servidores));
    v
}

fn faltantes(def: &ConectorMcp, s: &ServidorMcp) -> Vec<String> {
    let mut f: Vec<String> = def.herramientas.lista.iter().filter(|t| !s.herramientas.as_ref().is_some_and(|hs| hs.contains(t))).cloned().collect();
    f.sort();
    f.truncate(FALTAN_MAX);
    f
}

fn parecido(def: &ConectorMcp, servidores: &[ServidorMcp]) -> Option<(String, Vec<String>)> {
    let ps = palabras(def);
    let mut mejor: Option<(String, Vec<String>, usize)> = None;
    for s in servidores {
        let Some(hs) = &s.herramientas else { continue };
        if !comparte_nombre(&ps, s) {
            continue;
        }
        let n = def.herramientas.lista.iter().filter(|t| !hs.contains(t)).count();
        if n > 0 && n < def.herramientas.lista.len() && mejor.as_ref().map_or(true, |m| n < m.2) {
            mejor = Some((s.nombre.clone(), faltantes(def, s), n));
        }
    }
    mejor.map(|(n, f, _)| (n, f))
}

fn tiene(def: &ConectorMcp, s: &ServidorMcp) -> Disponibilidad {
    Disponibilidad::Tiene {
        nombre: s.nombre.clone(),
        prefijo: s.prefijo.clone(),
        estado: s.estado,
        adaptado: s.prefijo != def.herramientas.prefijo,
        verificado: s.herramientas.is_some() && tiene_lista(def, s),
    }
}

fn opcion(s: &ServidorMcp) -> OpcionServidor {
    OpcionServidor { nombre: s.nombre.clone(), prefijo: s.prefijo.clone(), estado: s.estado }
}

pub fn disponibilidad(def: &ConectorMcp, cuenta: Option<&CuentaRevisada>, elegido: Option<&str>) -> Disponibilidad {
    let Some(cuenta) = cuenta else { return Disponibilidad::SinRevisar };
    let cs = candidatos(def, &cuenta.servidores);
    let ph = por_herramientas(def, &cuenta.servidores);
    if let Some(e) = elegido.filter(|e| !e.is_empty()) {
        if let Some(s) = cs.iter().chain(ph.iter()).find(|s| s.prefijo == e) {
            return tiene(def, s);
        }
    }
    let exacto = cs.iter().copied().find(|s| s.prefijo == def.herramientas.prefijo);
    if let Some(e) = exacto {
        if usable(&tiene(def, e)) {
            return tiene(def, e);
        }
    }
    let otros: Vec<&ServidorMcp> = cs.iter().copied().filter(|s| exacto.map_or(true, |e| !std::ptr::eq(*s, e))).collect();
    let anda = |s: &ServidorMcp| s.herramientas.is_some() && usable(&tiene(def, s));
    // El exacto pide autorización o falló pero hay otro con el mismo sistema andando: se usa ese.
    let andando: Vec<&ServidorMcp> = otros.iter().copied().filter(|s| anda(s)).collect();
    if andando.len() == 1 {
        return tiene(def, andando[0]);
    }
    if let Some(e) = exacto {
        let alternativas: Vec<&ServidorMcp> = andando.iter().copied().chain(ph.iter().copied().filter(|s| anda(s))).collect();
        return if alternativas.is_empty() { tiene(def, e) } else { Disponibilidad::Elegir { opciones: std::iter::once(e).chain(alternativas).map(opcion).collect() } };
    }
    let verificados: Vec<&ServidorMcp> = otros.iter().copied().filter(|s| s.herramientas.is_some()).collect();
    if verificados.len() == 1 {
        return tiene(def, verificados[0]);
    }
    if otros.len() == 1 {
        return tiene(def, otros[0]);
    }
    if !otros.is_empty() {
        return Disponibilidad::Elegir { opciones: otros.iter().map(|s| opcion(s)).collect() };
    }
    // Nunca se adapta solo a un servidor de otro nombre: cambiaría a quién se le permiten las herramientas.
    if !ph.is_empty() {
        return Disponibilidad::Elegir { opciones: ph.iter().map(|s| opcion(s)).collect() };
    }
    Disponibilidad::Falta { parecido: parecido(def, &cuenta.servidores) }
}

/// Una copia que llama a las mismas herramientas cortas con el prefijo del servidor de la cuenta.
pub fn con_prefijo(def: &ConectorMcp, prefijo: &str) -> Res<ConectorMcp> {
    if !re(PREFIJO_RE).is_match(prefijo) || len16(prefijo) > 64 {
        return Err(ErrorTickets::otro("El prefijo tiene que tener la forma mcp__nombre__."));
    }
    let mut copia = def.clone();
    copia.herramientas.prefijo = prefijo.to_string();
    Ok(copia)
}

/// El conector para leer el detalle o escribir en un ticket de la lista: tiene que ir al mismo servidor con el que se leyó
/// la lista. Si la cuenta pasó a resolver otro (o no se sabe con cuál se leyó), se pide actualizar.
pub fn servidor_de_la_lista<'a>(leido_con: Option<&str>, actual: &'a ConectorMcp) -> Res<&'a ConectorMcp> {
    if leido_con == Some(actual.herramientas.prefijo.as_str()) {
        return Ok(actual);
    }
    let n = actual.nombre();
    Err(ErrorTickets::otro(format!("El servidor de {n} de la cuenta cambió desde que se leyó la lista. Actualizá {n} antes de seguir.")))
}

pub fn servidor_pendiente(mensaje: &str, costo_usd: Option<f64>) -> ErrorTickets {
    ErrorTickets::ServidorPendiente { mensaje: mensaje.to_string(), costo_usd }
}

pub fn usable(d: &Disponibilidad) -> bool {
    matches!(d, Disponibilidad::Tiene { estado, .. } if *estado != EstadoMcp::NecesitaAuth && *estado != EstadoMcp::Fallo)
}

/// Con lo que se sabe de la cuenta, la consulta ni se intenta: no tiene el servidor, hay que elegir uno o está caído o sin
/// sesión.
pub fn bloquea_consulta(d: &Disponibilidad) -> bool {
    match d {
        Disponibilidad::Falta { .. } | Disponibilidad::Elegir { .. } => true,
        Disponibilidad::Tiene { estado, .. } => *estado == EstadoMcp::NecesitaAuth || *estado == EstadoMcp::Fallo,
        Disponibilidad::SinRevisar => false,
    }
}

/// Lo que bloquea la consulta salió de una revisión vieja: la persona pudo autenticar el servidor con /mcp, arreglarlo o
/// sumarlo después. Sin volver a mirar, «Actualizar» repite el mismo aviso hasta que toque «Volver a revisar» a mano.
pub fn conviene_revisar(d: &Disponibilidad, revisada_en: Option<f64>, ahora: f64) -> bool {
    if !bloquea_consulta(d) || matches!(d, Disponibilidad::Elegir { .. }) {
        return false;
    }
    revisada_en.map_or(true, |r| ahora - r >= REVISION_VIGENTE_MS)
}

/// Por qué la sesión que acaba de correr no pudo leer el conector, o None si lo tenía conectado con sus herramientas.
/// Sirve para que una lista vacía no pase por «no hay tickets».
pub fn problema_en_sesion(def: &ConectorMcp, prefijo_usado: &str, sesion: Option<&[ServidorMcp]>) -> Option<Disponibilidad> {
    let sesion = sesion?;
    let Some(s) = sesion.iter().find(|x| x.prefijo == prefijo_usado) else { return Some(Disponibilidad::Falta { parecido: None }) };
    if s.herramientas.is_some() && !tiene_lista(def, s) {
        return Some(Disponibilidad::Falta { parecido: Some((s.nombre.clone(), faltantes(def, s))) });
    }
    let d = tiene(def, s);
    if s.estado == EstadoMcp::Conectado && matches!(d, Disponibilidad::Tiene { verificado: true, .. }) {
        return None;
    }
    Some(d)
}

pub fn mensaje_cuenta(def: &ConectorMcp, d: &Disponibilidad, cuenta: &str, otras: &[String]) -> Option<String> {
    let n = def.nombre();
    let es_claude_ai = def.herramientas.prefijo.starts_with("mcp__claude_ai_");
    match d {
        Disponibilidad::SinRevisar => None,
        Disponibilidad::Falta { parecido } => {
            let base = match parecido {
                Some((nombre, faltan)) => format!(
                    "La cuenta «{cuenta}» tiene «{nombre}», pero le faltan herramientas que usa {n}: {}. Copiá {n} como conector propio y ajustá sus herramientas, o agregalas al servidor.",
                    faltan.join(", ")
                ),
                None if es_claude_ai => format!("Conectá {n} en claude.ai con la cuenta «{cuenta}» (claude.ai → Configuración → Conectores) y tocá «Volver a revisar»."),
                None => format!(
                    "La cuenta «{cuenta}» no tiene el servidor MCP de {n}. Agregalo en esa cuenta con alcance usuario (claude mcp add --scope user) y tocá «Volver a revisar»: uno de alcance local o de proyecto solo anda dentro de su carpeta y Sloth consulta desde otra."
                ),
            };
            Some(if otras.is_empty() { base } else { format!("{base} Lo tiene: {}.", otras.iter().map(|o| format!("«{o}»")).collect::<Vec<_>>().join(", ")) })
        }
        Disponibilidad::Elegir { opciones } if opciones.len() == 1 => Some(format!(
            "«{}» de la cuenta «{cuenta}» tiene las herramientas de {n} con otro nombre. Si es ese, elegilo en los ajustes de Tickets.",
            opciones[0].nombre
        )),
        Disponibilidad::Elegir { .. } => Some(format!("La cuenta «{cuenta}» tiene más de un servidor que puede ser {n}. Elegí cuál en los ajustes de Tickets.")),
        Disponibilidad::Tiene { nombre, estado, verificado, .. } => {
            let de_claude_ai = nombre.starts_with("claude.ai ");
            match estado {
                EstadoMcp::NecesitaAuth => Some(if de_claude_ai {
                    format!("{n} necesita que lo vuelvas a autorizar en claude.ai con la cuenta «{cuenta}».")
                } else {
                    format!("El servidor «{nombre}» pide iniciar sesión. Abrí una terminal con la cuenta «{cuenta}», corré /mcp, elegí «{nombre}», autenticalo y volvé a actualizar.")
                }),
                EstadoMcp::Fallo => Some(format!(
                    "No se pudo conectar a «{nombre}» (cuenta «{cuenta}»): no arrancó. Tocá «Probar» en los ajustes de Tickets para ver el motivo, o revisalo con /mcp en una terminal de esa cuenta."
                )),
                _ if usable(d) && *verificado && *estado != EstadoMcp::Pendiente => None,
                // Conectado pero sin haberle visto las herramientas: no es que no responda, es que falta revisarlo.
                EstadoMcp::Conectado => Some(format!("«{nombre}» figura conectado en la cuenta «{cuenta}», pero todavía no se revisaron sus herramientas. Tocá «Volver a revisar» y probá de nuevo.")),
                _ => {
                    // Un MCP propio que queda pending suele estar esperando que lo autentiquen o tarda en arrancar.
                    let propio = if de_claude_ai { "" } else { " Si pide autenticarse, abrí una terminal con esa cuenta y corré /mcp. Si tarda en arrancar, volvé a probar." };
                    Some(format!("«{nombre}» no respondió a tiempo en la cuenta «{cuenta}».{propio} Podés probar igual o tocar «Volver a revisar»."))
                }
            }
        }
    }
}

fn sanear_servidor(v: &Value) -> Option<ServidorMcp> {
    let o = v.as_object()?;
    let nombre = nombre_valido(o.get("nombre"))?;
    let prefijo = o.get("prefijo").and_then(Value::as_str).filter(|p| len16(p) <= 64 && re(PREFIJO_RE).is_match(p))?;
    let estado = o.get("estado").and_then(Value::as_str).and_then(EstadoMcp::de_str)?;
    let herramientas = o.get("herramientas").and_then(Value::as_array).map(|xs| {
        let corto_ok = re(CORTO_RE);
        let mut out: Vec<String> = Vec::new();
        for t in xs.iter().filter_map(Value::as_str).filter(|t| corto_ok.is_match(t)) {
            if !out.iter().any(|x| x == t) {
                out.push(t.to_string());
            }
        }
        out.truncate(HERRAMIENTAS_MAX);
        out
    });
    Some(ServidorMcp { nombre: nombre.to_string(), prefijo: prefijo.to_string(), estado, herramientas })
}

/// tickets-cuentas.json `{ version: 1, cuentas }`. None si no tiene esa forma (se respalda y se empieza de cero).
pub fn sanear_cache(raw: &Value) -> Option<Ordenado<CuentaRevisada>> {
    let o = raw.as_object()?;
    if o.get("version").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    let cuentas = o.get("cuentas")?.as_object()?;
    let mut out: Ordenado<CuentaRevisada> = Ordenado::default();
    for (id, c) in cuentas.iter().take(CUENTAS_MAX) {
        if id.is_empty() || len16(id) > 64 || id == "__proto__" {
            continue;
        }
        let Some(c) = c.as_object() else { continue };
        let (Some(revisada_en), Some(servidores)) = (c.get("revisadaEn").and_then(numero), c.get("servidores").and_then(Value::as_array)) else { continue };
        let servidores: Vec<ServidorMcp> = servidores.iter().take(SERVIDORES_MAX).filter_map(sanear_servidor).collect();
        let error = c.get("error").and_then(Value::as_str).filter(|e| !e.is_empty()).map(|e| cortar16(e, ERROR_MAX).to_string());
        out.insert(id.clone(), CuentaRevisada { revisada_en: Num(revisada_en), servidores, error });
    }
    Some(out)
}

pub fn cache_a_valor(c: &Ordenado<CuentaRevisada>) -> Value {
    json!({ "version": 1, "cuentas": serde_json::to_value(c).unwrap_or(Value::Null) })
}

pub fn num_ms(n: f64) -> Value {
    num_valor(n)
}
