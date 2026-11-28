//! Lo puro de «celular»: elegir la IP, validar lo que llega por IPC y por el archivo, leer los límites, armar el JSON de
//! `/api/estado` y los avisos de ntfy. Equivale a `celular-core.ts`. La clasificación de permisos (`permissions-core.ts`)
//! todavía no está en Rust: entra por `ClasificadorPermisos`.
use super::sello::derivar_claves;
use super::tipos::{CuentaCelular, EstadoCelular, EstadoSesion, PedidoCelular, SesionCelular, UsoDelDia, VentanaLimite};
use super::{cortar_utf16, largo_utf16};
use crate::usage::UsoCuenta;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::LazyLock;

/// Lo que importa de una interfaz de red (la forma de `os.networkInterfaces()`); `v4` es `family` 'IPv4' o 4.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InterfazRed {
    pub address: String,
    pub v4: bool,
    pub internal: bool,
}

/// Las interfaces por nombre, en el orden en que las dio el sistema.
pub type Redes = [(String, Vec<InterfazRed>)];

static VIRTUAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)vethernet|virtualbox|vmware|hyper-v|wsl|docker|loopback|tailscale|zerotier|hamachi|vpn|bluetooth").expect("regex fija"));
static WIFI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)wi-?fi|wlan|wireless|inal[aá]mbrica").expect("regex fija"));

/// Los dos primeros bytes de una IPv4 como los lee `split('.').map(Number)`: lo que no es número no es ninguno.
fn dos_primeros(ip: &str) -> (Option<u32>, Option<u32>) {
    let mut partes = ip.split('.').map(|p| p.trim().parse::<u32>().ok());
    (partes.next().flatten(), partes.next().flatten())
}

fn es_privada(ip: &str) -> bool {
    match dos_primeros(ip) {
        (Some(10), _) => true,
        (Some(192), Some(168)) => true,
        (Some(172), Some(b)) => (16..=31).contains(&b),
        _ => false,
    }
}

/// La IP de la PC en la red de casa: IPv4 privada, de una interfaz que no sea virtual. Prefiere la del Wi-Fi; si no hay,
/// la primera cableada. None si no hay red.
pub fn elegir_ip(redes: &Redes) -> Option<String> {
    let mut candidatas: Vec<(&str, &str)> = Vec::new();
    for (nombre, lista) in redes {
        if VIRTUAL.is_match(nombre) {
            continue;
        }
        for r in lista {
            if r.v4 && !r.internal && es_privada(&r.address) {
                candidatas.push((nombre, &r.address));
            }
        }
    }
    candidatas.iter().find(|(n, _)| WIFI.is_match(n)).or(candidatas.first()).map(|(_, ip)| (*ip).to_string())
}

/// La IP de Tailscale de la PC (100.64.0.0/10), o None si Tailscale no está conectado. Solo de la interfaz de Tailscale:
/// ese rango también lo usan los datos móviles y algunos hoteles (CGNAT), y abrir ahí sería abrirle la página a esa red.
pub fn ip_tailscale(redes: &Redes) -> Option<String> {
    for (nombre, lista) in redes {
        if !nombre.to_lowercase().contains("tailscale") {
            continue;
        }
        for r in lista {
            if let (true, false, (Some(100), Some(b))) = (r.v4, r.internal, dos_primeros(&r.address)) {
                if (64..=127).contains(&b) {
                    return Some(r.address.clone());
                }
            }
        }
    }
    None
}

static HTTPS_TS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^https://((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net)/?$").expect("regex fija"));

/// `String.prototype.trim` de JavaScript: los blancos de Unicode más el BOM.
pub(crate) fn recortar_js(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// La dirección que da `tailscale serve` (https://<pc>.<tailnet>.ts.net), sin barra final; None si no es una de esas.
pub fn https_tailscale(v: &Value) -> Option<String> {
    let t = v.as_str().filter(|t| largo_utf16(t) <= 200)?;
    HTTPS_TS.captures(recortar_js(t)).map(|m| format!("https://{}", m[1].to_lowercase()))
}

/// La clave del QR: 32 bytes en base64url canónico (43 caracteres).
pub fn clave_valida(v: &str) -> bool {
    derivar_claves(v).is_some()
}

pub fn clave_valida_json(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).is_some_and(clave_valida)
}

/// Un puerto de 1024 a 65535; con decimales o como texto no vale.
pub fn puerto_valido(p: Option<&Value>) -> Option<u16> {
    let n = p?.as_f64()?;
    (n.fract() == 0.0 && (1024.0..=65535.0).contains(&n)).then_some(n as u16)
}

pub const TEMA_MIN: usize = 20;
pub const NTFY_POR_DEFECTO: &str = "https://ntfy.sh/";

/// Tema de ntfy: lo que acepta su URL, sin barras ni espacios. El largo mínimo es lo único que lo protege: cualquiera que lo sepa lee los avisos.
pub fn tema_valido(t: &str) -> bool {
    (TEMA_MIN..=64).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn token_ntfy_valido(t: &str) -> bool {
    (1..=200).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

fn codificar_ruta(ruta: &str) -> String {
    let mut out = String::new();
    for b in ruta.bytes() {
        if b <= 0x20 || b >= 0x7f || matches!(b, b'"' | b'<' | b'>' | b'`' | b'{' | b'}') {
            out.push_str(&format!("%{b:02X}"));
        } else {
            out.push(b as char);
        }
    }
    out
}

fn normalizar_segmentos(ruta: &str) -> String {
    let mut pila: Vec<&str> = Vec::new();
    let segmentos: Vec<&str> = ruta.split('/').skip(1).collect();
    for (i, s) in segmentos.iter().enumerate() {
        let ultimo = i + 1 == segmentos.len();
        match s.to_ascii_lowercase().as_str() {
            "." | "%2e" => {
                if ultimo {
                    pila.push("");
                }
            }
            ".." | ".%2e" | "%2e." | "%2e%2e" => {
                pila.pop();
                if ultimo {
                    pila.push("");
                }
            }
            _ => pila.push(s),
        }
    }
    format!("/{}", pila.join("/"))
}

/// La URL de un servidor de ntfy: solo https, sin usuario, parámetros ni `#`, y con la ruta terminada en una barra. Sin
/// valor (o vacío) es ntfy.sh. Hace a mano lo que hace `new URL()` en el TypeScript para lo que importa acá; los nombres
/// de host con caracteres que no son ASCII se rechazan en vez de pasarlos a punycode.
pub fn servidor_ntfy(u: Option<&Value>) -> Option<String> {
    let texto = match u {
        None => return Some(NTFY_POR_DEFECTO.into()),
        Some(Value::String(s)) if s.is_empty() => return Some(NTFY_POR_DEFECTO.into()),
        Some(Value::String(s)) => s,
        Some(_) => return None,
    };
    let limpio: String = texto.trim_matches(|c: char| c <= ' ').chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let (esquema, resto) = limpio.split_once(':')?;
    if !esquema.eq_ignore_ascii_case("https") {
        return None;
    }
    let resto = resto.replace('\\', "/");
    let resto = resto.strip_prefix("//")?;
    let fin_autoridad = resto.find(['/', '?', '#']).unwrap_or(resto.len());
    let (autoridad, cola) = resto.split_at(fin_autoridad);
    let (info, host_puerto) = match autoridad.rfind('@') {
        Some(i) => (&autoridad[..i], &autoridad[i + 1..]),
        None => ("", autoridad),
    };
    if !info.is_empty() && info != ":" {
        return None;
    }
    let (host, puerto) = match host_puerto.rfind(':') {
        Some(i) if !host_puerto.ends_with(']') => (&host_puerto[..i], &host_puerto[i + 1..]),
        _ => (host_puerto, ""),
    };
    if host.is_empty() || !host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.') {
        return None;
    }
    let puerto = if puerto.is_empty() {
        None
    } else if puerto.bytes().all(|b| b.is_ascii_digit()) {
        let n: u32 = puerto.parse().ok().filter(|n| *n <= 65535)?;
        (n != 443).then_some(n)
    } else {
        return None;
    };
    let sin_hash = cola.split('#').next().unwrap_or("");
    let (ruta, consulta) = match sin_hash.split_once('?') {
        Some((r, q)) => (r, q),
        None => (sin_hash, ""),
    };
    let hash = cola.split_once('#').map_or("", |(_, h)| h);
    if !consulta.is_empty() || !hash.is_empty() {
        return None;
    }
    let ruta = normalizar_segmentos(&codificar_ruta(if ruta.is_empty() { "/" } else { ruta }));
    let ruta = format!("{}/", ruta.trim_end_matches('/'));
    let origen = match puerto {
        Some(p) => format!("https://{}:{p}", host.to_ascii_lowercase()),
        None => format!("https://{}", host.to_ascii_lowercase()),
    };
    Some(format!("{origen}{ruta}"))
}

/// El token es de un servidor: si cambia el servidor y no llega uno nuevo, el guardado no viaja al otro.
/// `token`: None si no vino, `Some(None)` si vino null (borrarlo), `Some(Some(t))` si vino uno.
pub fn token_ntfy_tras(servidor_actual: &str, token_actual: Option<&str>, servidor: &str, token: Option<Option<&str>>) -> Option<String> {
    match token {
        Some(t) => t.map(String::from),
        None if servidor == servidor_actual => token_actual.map(String::from),
        None => None,
    }
}

fn dias_desde_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `Date.parse` para las fechas ISO (`2027-01-15`, `2027-01-15T12:00:00Z`, con milisegundos o con `±HH:MM`). Una hora sin
/// zona se toma como UTC. Los formatos viejos que V8 también entiende («Jan 15 2027») no se leen: dan None.
pub(crate) fn fecha_iso_a_ms(t: &str) -> Option<f64> {
    let b = t.as_bytes();
    let num = |a: usize, z: usize| -> Option<i64> { (z <= b.len() && b[a..z].iter().all(u8::is_ascii_digit)).then(|| t[a..z].parse().ok()).flatten() };
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let (y, m, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let dias_del_mes = [31, if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if !(1..=12).contains(&m) || d < 1 || d > dias_del_mes[(m - 1) as usize] {
        return None;
    }
    let mut ms = dias_desde_civil(y, m, d) * 86_400_000;
    if b.len() == 10 {
        return Some(ms as f64);
    }
    if b[10] != b'T' && b[10] != b' ' {
        return None;
    }
    let (h, mi) = (num(11, 13)?, num(14, 16)?);
    if b.get(13) != Some(&b':') || h > 24 || mi > 59 {
        return None;
    }
    ms += h * 3_600_000 + mi * 60_000;
    let mut i = 16;
    if b.get(i) == Some(&b':') {
        let s = num(i + 1, i + 3)?;
        if s > 59 {
            return None;
        }
        ms += s * 1000;
        i += 3;
        if b.get(i) == Some(&b'.') {
            let f = i + 1;
            let mut z = f;
            while z < b.len() && b[z].is_ascii_digit() {
                z += 1;
            }
            if z == f {
                return None;
            }
            let dig = &t[f..z.min(f + 3)];
            ms += dig.parse::<i64>().ok()? * 10_i64.pow(3 - dig.len() as u32);
            i = z;
        }
    }
    match &t[i..] {
        "" | "Z" | "z" => Some(ms as f64),
        z if z.len() == 6 && (b[i] == b'+' || b[i] == b'-') && b[i + 3] == b':' => {
            let (oh, om) = (num(i + 1, i + 3)?, num(i + 4, i + 6)?);
            let desfase = (oh * 60 + om) * 60_000;
            Some((if b[i] == b'+' { ms - desfase } else { ms + desfase }) as f64)
        }
        _ => None,
    }
}

/// `resets_at` llega como segundos o milisegundos desde 1970, o como fecha ISO.
pub fn a_ms(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => {
            let n = n.as_f64()?;
            (n.is_finite() && n > 0.0).then(|| if n < 1e12 { n * 1000.0 } else { n })
        }
        Value::String(s) => {
            let t = recortar_js(s);
            if !t.is_empty() {
                if let Some(n) = t.parse::<f64>().ok().filter(|n| n.is_finite()) {
                    return a_ms(&json!(n));
                }
            }
            fecha_iso_a_ms(t)
        }
        _ => None,
    }
}

fn ventana(raw: Option<&Value>, ahora: i64) -> Option<VentanaLimite> {
    let o = raw?.as_object()?;
    let pct = o.get("pct")?.as_f64().filter(|p| p.is_finite())?;
    let reinicia_en = o.get("resetsAt").and_then(a_ms);
    // Si ya pasó el reinicio, el porcentaje guardado es de la ventana anterior: mejor «sin datos» que un número viejo.
    if reinicia_en.is_some_and(|r| r <= ahora as f64) {
        return None;
    }
    Some(VentanaLimite { pct: pct.clamp(0.0, 100.0), reinicia_en })
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct LimitesLeidos {
    pub cinco_horas: Option<VentanaLimite>,
    pub semana: Option<VentanaLimite>,
    pub at: Option<i64>,
}

/// Lee lo que dejó el envoltorio de la statusline en la carpeta de la cuenta (sloth-limites.json). Tolerante: lo que no
/// se entiende queda como «sin datos».
pub fn leer_limites(texto: Option<&str>, ahora: i64) -> LimitesLeidos {
    let Some(texto) = texto.filter(|t| !t.is_empty()) else { return LimitesLeidos::default() };
    let sin_bom = texto.strip_prefix('\u{feff}').unwrap_or(texto);
    let Ok(Value::Object(o)) = serde_json::from_str::<Value>(sin_bom) else { return LimitesLeidos::default() };
    LimitesLeidos { cinco_horas: ventana(o.get("fiveHour"), ahora), semana: ventana(o.get("sevenDay"), ahora), at: o.get("at").and_then(Value::as_f64).map(|n| n as i64) }
}

const MAX_TEXTO: usize = 160;

fn corto(s: &str, n: usize) -> String {
    if largo_utf16(s) > n {
        format!("{}…", cortar_utf16(s, n - 1))
    } else {
        s.to_string()
    }
}

/// Lo que se aprueba desde el celu se tiene que ver entero: el corte es solo un tope de tamaño.
pub const MAX_PEDIDO: usize = 4000;

/// Controles (salvo salto y tabulación), bidi y ancho cero: harían que el celu muestre algo distinto de lo que corre.
static INVISIBLES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\x00-\x08\x0B-\x1F\x7F-\x{9F}\p{Cf}\p{Zl}\p{Zp}]").expect("regex fija"));

/// Lo que decide, de un permiso, cómo se le muestra al celu. Equivale a `kindOf`, `labelOf`, `titleOf` y `destructivoDe`
/// de `permissions-core.ts`, que todavía no están en Rust.
pub trait ClasificadorPermisos {
    fn clase(&self, tool: &str) -> String;
    fn etiqueta(&self, clase: &str, tool: &str, input: &Map<String, Value>) -> String;
    fn titulo(&self, clase: &str, tool: &str, input: &Map<String, Value>) -> String;
    fn destructivo(&self, clase: &str, input: &Map<String, Value>) -> Option<String>;
}

#[derive(Debug, Clone, PartialEq)]
pub struct PedidoParaCelu {
    pub texto: String,
    pub titulo: String,
    pub destructivo: Option<String>,
    pub cortado: Option<bool>,
}

/// Qué pide un permiso, como lo ve el celu.
pub fn pedido_para_celu(tool: &str, input: &Map<String, Value>, p: &dyn ClasificadorPermisos) -> PedidoParaCelu {
    let clase = p.clase(tool);
    let entero = INVISIBLES.replace_all(&p.etiqueta(&clase, tool, input), "\u{FFFD}").into_owned();
    // Lo que no entra no se ve entero, y lo que no se vio entero no se aprueba desde el celu.
    PedidoParaCelu { texto: corto(&entero, MAX_PEDIDO), titulo: p.titulo(&clase, tool, input), destructivo: p.destructivo(&clase, input), cortado: (largo_utf16(&entero) > MAX_PEDIDO).then_some(true) }
}

/// Un agente de un espacio (`AgentStatus`): el estado llega como texto, y uno que no se conoce cuenta como `idle`.
#[derive(Debug, Clone, PartialEq)]
pub struct AgenteEstado {
    pub state: String,
    pub detail: Option<String>,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PedidoPendiente {
    pub id: String,
    pub ws: String,
    pub tool: String,
    pub input: Map<String, Value>,
    pub at: i64,
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CuentaEntrada {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EspacioEntrada {
    pub id: String,
    pub name: String,
    pub account_id: String,
}

pub struct Entrada {
    pub ahora: i64,
    pub aprobar: bool,
    pub terminal: bool,
    pub cuentas: Vec<CuentaEntrada>,
    pub espacios: Vec<EspacioEntrada>,
    pub agentes: HashMap<String, AgenteEstado>,
    pub uso: HashMap<String, UsoCuenta>,
    pub limites: HashMap<String, LimitesLeidos>,
    pub pedidos: Vec<PedidoPendiente>,
}

/// Arma el JSON de /api/estado. Solo lo que el celu muestra: nada de carpetas ni rutas.
pub fn armar_estado(e: &Entrada, p: &dyn ClasificadorPermisos) -> EstadoCelular {
    let cuentas = e
        .cuentas
        .iter()
        .map(|c| {
            let l = e.limites.get(&c.id);
            let hoy = e.uso.get(&c.id).map(|u| UsoDelDia { tokens: u.today.input + u.today.output + u.today.cache_write + u.today.cache_read, mensajes: u.today.messages });
            CuentaCelular { id: c.id.clone(), nombre: corto(&c.label, 40), cinco_horas: l.and_then(|l| l.cinco_horas), semana: l.and_then(|l| l.semana), limites_leidos_en: l.and_then(|l| l.at), hoy }
        })
        .collect();
    let con_pedido: std::collections::HashSet<&str> = e.pedidos.iter().map(|p| p.ws.as_str()).collect();
    let mut sesiones: Vec<SesionCelular> = e
        .espacios
        .iter()
        .filter_map(|w| {
            let a = e.agentes.get(&w.id)?;
            // Un pedido de permiso pendiente es «te necesita», aunque el último hook diga otra cosa.
            let estado = if con_pedido.contains(w.id.as_str()) { EstadoSesion::Waiting } else { EstadoSesion::desde_texto(&a.state).unwrap_or(EstadoSesion::Idle) };
            Some(SesionCelular { id: w.id.clone(), nombre: corto(&w.name, 60), cuenta_id: w.account_id.clone(), estado, desde: a.at, detalle: a.detail.as_deref().filter(|d| !d.is_empty()).map(|d| corto(d, MAX_TEXTO)) })
        })
        .collect();
    sesiones.sort_by(|a, b| a.estado.orden().cmp(&b.estado.orden()).then(b.desde.cmp(&a.desde)));
    let nombres: HashMap<&str, &str> = e.espacios.iter().map(|w| (w.id.as_str(), w.name.as_str())).collect();
    let mut vigentes: Vec<&PedidoPendiente> = e.pedidos.iter().filter(|p| nombres.contains_key(p.ws.as_str())).collect();
    vigentes.sort_by_key(|p| p.at);
    let pedidos = vigentes
        .into_iter()
        .map(|pe| {
            let v = pedido_para_celu(&pe.tool, &pe.input, p);
            PedidoCelular { id: pe.id.clone(), sesion_id: pe.ws.clone(), sesion: corto(nombres[pe.ws.as_str()], 60), texto: v.texto, titulo: v.titulo, destructivo: v.destructivo, cortado: v.cortado, desde: pe.at, vence: pe.expires_at }
        })
        .collect();
    EstadoCelular { ahora: e.ahora, aprobar: e.aprobar, terminal: e.terminal, terminal_en_wifi: None, cuentas, sesiones, pedidos }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TipoAviso {
    Termino,
    TeNecesita,
    Permiso,
}

/// Qué pide Claude, sin el comando ni la ruta: ese texto sale a los servidores de ntfy.
pub fn resumen_permiso(clase: &str) -> &'static str {
    match clase {
        "cmd" => "Claude quiere correr un comando.",
        "edit" => "Claude quiere editar archivos.",
        "net" => "Claude quiere acceder a internet.",
        _ => "Claude quiere usar una herramienta.",
    }
}

fn una_linea(s: &str) -> String {
    static SALTOS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\r\n]+").expect("regex fija"));
    SALTOS.replace_all(s, " ").into_owned()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextoAviso {
    pub titulo: String,
    pub cuerpo: String,
}

/// Título y cuerpo del aviso por ntfy. Pasa por los servidores de ntfy: solo el nombre del espacio y qué pasó.
pub fn texto_aviso(tipo: TipoAviso, espacio: &str, detalle: Option<&str>, agente: &str) -> TextoAviso {
    let nombre = corto(&una_linea(espacio), 60);
    match tipo {
        TipoAviso::Termino => TextoAviso { titulo: format!("{nombre} terminó"), cuerpo: format!("{agente} terminó. Revisá los cambios antes de seguir.") },
        TipoAviso::Permiso => TextoAviso { titulo: format!("{nombre} pide permiso"), cuerpo: corto(&una_linea(&detalle.map_or_else(|| format!("{agente} necesita tu permiso."), String::from)), MAX_TEXTO) },
        TipoAviso::TeNecesita => TextoAviso { titulo: format!("{nombre} te necesita"), cuerpo: corto(&una_linea(&detalle.filter(|d| !d.is_empty()).map_or_else(|| format!("{agente} necesita tu atención."), String::from)), MAX_TEXTO) },
    }
}

/// «Sin nombres»: el servidor de ntfy no se entera de cómo se llaman tus espacios ni de qué dijo Claude.
pub fn texto_aviso_privado(tipo: TipoAviso) -> TextoAviso {
    let cuerpo = match tipo {
        TipoAviso::Termino => "Una sesión terminó.",
        TipoAviso::TeNecesita => "Una sesión te necesita.",
        TipoAviso::Permiso => "Una sesión pide permiso.",
    };
    TextoAviso { titulo: "Sloth".into(), cuerpo: cuerpo.into() }
}

/// El JSON que se publica en ntfy. Con `abrir`, tocar el aviso (o «Abrir Sloth») abre la página del celu: la dirección va
/// sin la clave, que el celu ya tiene guardada desde que escaneó el QR.
pub fn cuerpo_ntfy(tema: &str, tipo: TipoAviso, texto: &TextoAviso, abrir: Option<&str>) -> Value {
    let termino = tipo == TipoAviso::Termino;
    let mut o = Map::new();
    o.insert("topic".into(), json!(tema));
    o.insert("title".into(), json!(texto.titulo));
    o.insert("message".into(), json!(texto.cuerpo));
    o.insert("priority".into(), json!(if termino { 3 } else { 4 }));
    o.insert("tags".into(), json!([if termino { "white_check_mark" } else { "warning" }]));
    if let Some(url) = abrir.filter(|u| !u.is_empty()) {
        o.insert("click".into(), json!(url));
        o.insert("actions".into(), json!([{ "action": "view", "label": "Abrir Sloth", "url": url, "clear": true }]));
    }
    Value::Object(o)
}

/// La página remota sin `?` ni `#` y con la barra de la ruta, como la deja `new URL()`.
fn sin_clave(remoto: &str) -> String {
    let base = remoto.split('#').next().unwrap_or("").split('?').next().unwrap_or("");
    let tras_esquema = base.find("://").map_or(0, |i| i + 3);
    if base[tras_esquema..].contains('/') {
        base.to_string()
    } else {
        format!("{base}/")
    }
}

pub struct OrigenesAviso<'a> {
    pub wifi: Option<(&'a str, u16)>,
    pub remoto: Option<&'a str>,
    pub https: Option<&'a str>,
    pub privado: bool,
}

/// A dónde lleva tocar el aviso, sin clave nunca. Primero lo que anda también fuera de casa (la dirección https de
/// Tailscale, la página remota); el Wi-Fi solo sirve en casa. Con avisos privados no va nada que diga cómo se llama la PC
/// ni su IP: solo la página remota, que es pública.
pub fn enlace_aviso(o: &OrigenesAviso) -> Option<String> {
    if let Some(h) = o.https.filter(|h| !h.is_empty()) {
        if !o.privado {
            return Some(format!("{h}/"));
        }
    }
    if let Some(r) = o.remoto.filter(|r| !r.is_empty()) {
        return Some(sin_clave(r));
    }
    match o.wifi {
        Some((ip, puerto)) if !o.privado => Some(format!("http://{ip}:{puerto}/")),
        _ => None,
    }
}

/// Evita mandar el mismo aviso dos veces seguidas (Claude a veces repite el hook). Devuelve true si hay que mandarlo y
/// anota el envío.
pub fn debe_avisar(ultimos: &mut HashMap<String, i64>, clave: &str, ahora: i64, ventana_ms: i64) -> bool {
    if ultimos.get(clave).is_some_and(|antes| ahora - antes < ventana_ms) {
        return false;
    }
    ultimos.insert(clave.to_string(), ahora);
    true
}

pub const VENTANA_AVISOS_MS: i64 = 10_000;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::celular::pruebas::{clave_de, FalsoPermisos};
    use crate::usage::Totales;

    fn v4(address: &str, internal: bool) -> InterfazRed {
        InterfazRed { address: address.into(), v4: true, internal }
    }

    fn redes(r: Vec<(&str, Vec<InterfazRed>)>) -> Vec<(String, Vec<InterfazRed>)> {
        r.into_iter().map(|(n, l)| (n.to_string(), l)).collect()
    }

    #[test]
    fn elegir_ip_prefiere_el_wifi_y_descarta_lo_virtual_lo_interno_y_lo_publico() {
        let r = redes(vec![
            ("vEthernet (WSL)", vec![v4("172.20.0.1", false)]),
            ("Loopback Pseudo-Interface 1", vec![v4("127.0.0.1", true)]),
            ("Ethernet", vec![v4("192.168.0.20", false)]),
            ("Wi-Fi", vec![InterfazRed { address: "fe80::1".into(), v4: false, internal: false }, v4("192.168.0.31", false)]),
        ]);
        assert_eq!(elegir_ip(&r).as_deref(), Some("192.168.0.31"));
        assert_eq!(elegir_ip(&redes(vec![("Ethernet", vec![v4("10.0.0.5", false)]), ("Otra", vec![v4("8.8.8.8", false)])])).as_deref(), Some("10.0.0.5"));
        assert_eq!(elegir_ip(&redes(vec![("Conexión de red inalámbrica", vec![v4("172.16.4.2", false)])])).as_deref(), Some("172.16.4.2"));
        assert_eq!(elegir_ip(&redes(vec![("VirtualBox Host-Only", vec![v4("192.168.56.1", false)])])), None);
        assert_eq!(elegir_ip(&[]), None);
        assert_eq!(elegir_ip(&redes(vec![("Ethernet", vec![v4("172.32.0.1", false)])])), None, "172.32 ya no es privada");
    }

    #[test]
    fn clave_valida_acepta_solo_32_bytes_en_base64url_canonico() {
        assert!(clave_valida(&"A".repeat(43)));
        assert!(!clave_valida(&"A".repeat(42)));
        assert!(!clave_valida(&"A".repeat(44)));
        assert!(!clave_valida(&format!("{}+", "A".repeat(42))));
        assert!(!clave_valida(&format!("{}B", "A".repeat(42))));
        assert!(!clave_valida_json(None));
        assert!(!clave_valida_json(Some(&json!(123))));
        assert!(clave_valida_json(Some(&json!(clave_de(1)))));
    }

    #[test]
    fn puerto_y_tema_se_validan() {
        assert_eq!(puerto_valido(Some(&json!(47321))), Some(47321));
        assert_eq!(puerto_valido(Some(&json!(80))), None);
        assert_eq!(puerto_valido(Some(&json!(70000))), None);
        assert_eq!(puerto_valido(Some(&json!(4732.5))), None);
        assert_eq!(puerto_valido(Some(&json!(47321.0))), Some(47321));
        assert_eq!(puerto_valido(Some(&json!("47321"))), None);
        assert_eq!(puerto_valido(None), None);
        assert!(tema_valido(&format!("sloth-{}", "a".repeat(14))));
        assert!(!tema_valido("con espacio"));
        assert!(!tema_valido("a/b/c/d/e"));
        assert!(!tema_valido("ab"));
    }

    #[test]
    fn tema_valido_19_caracteres_no_20_si_65_no() {
        assert!(!tema_valido(&"a".repeat(19)));
        assert!(tema_valido(&"a".repeat(20)));
        assert!(tema_valido(&"a".repeat(64)));
        assert!(!tema_valido(&"a".repeat(65)));
    }

    #[test]
    fn servidor_ntfy_https_sin_credenciales_query_ni_hash_vacio_es_ntfy_sh() {
        let s = |v: Value| servidor_ntfy(Some(&v));
        assert_eq!(servidor_ntfy(None).as_deref(), Some("https://ntfy.sh/"));
        assert_eq!(s(json!("")).as_deref(), Some("https://ntfy.sh/"));
        assert_eq!(s(json!("https://ntfy.ejemplo.com")).as_deref(), Some("https://ntfy.ejemplo.com/"));
        assert_eq!(s(json!("https://ntfy.ejemplo.com/sub")).as_deref(), Some("https://ntfy.ejemplo.com/sub/"));
        assert_eq!(s(json!("http://ntfy.ejemplo.com/")), None);
        assert_eq!(s(json!("https://user@ntfy.ejemplo.com/")), None);
        assert_eq!(s(json!("https://user:pass@ntfy.ejemplo.com/")), None);
        assert_eq!(s(json!("https://ntfy.ejemplo.com/?x=1")), None);
        assert_eq!(s(json!("https://ntfy.ejemplo.com/#x")), None);
        assert_eq!(s(json!("no es una url")), None);
        assert_eq!(s(json!(5)), None);
    }

    #[test]
    fn servidor_ntfy_normaliza_como_new_url() {
        let s = |t: &str| servidor_ntfy(Some(&json!(t)));
        assert_eq!(s("https://X.COM:443/p").as_deref(), Some("https://x.com/p/"));
        assert_eq!(s("https://x.com:8443").as_deref(), Some("https://x.com:8443/"));
        assert_eq!(s("https://x.com/a//").as_deref(), Some("https://x.com/a/"));
        assert_eq!(s("https://x.com/a/../b").as_deref(), Some("https://x.com/b/"));
        assert_eq!(s("  HTTPS://x.com  ").as_deref(), Some("https://x.com/"));
        assert_eq!(s("https://x.com/a b").as_deref(), Some("https://x.com/a%20b/"));
        assert_eq!(s("https://x.com:99999"), None);
        assert_eq!(s("https://"), None);
    }

    #[test]
    fn servidor_ntfy_coincide_con_new_url_del_typescript() {
        let f: Value = serde_json::from_str(include_str!("fixtures/ts.json")).unwrap();
        for par in f["servidor_ntfy"].as_array().unwrap() {
            let entrada = if par[0].is_null() { None } else { Some(&par[0]) };
            let esperado = par[1].as_str();
            assert_eq!(servidor_ntfy(entrada).as_deref(), esperado, "{}", par[0]);
        }
    }

    #[test]
    fn token_ntfy_valido_se_mira() {
        assert!(token_ntfy_valido("tk_abc.DEF-123"));
        assert!(!token_ntfy_valido(""));
        assert!(!token_ntfy_valido("con espacio"));
        assert!(!token_ntfy_valido("a\nb"));
        assert!(!token_ntfy_valido(&"a".repeat(201)));
    }

    #[test]
    fn a_ms_entiende_segundos_milisegundos_e_iso() {
        assert_eq!(a_ms(&json!(1_800_000_000)), Some(1_800_000_000_000.0));
        assert_eq!(a_ms(&json!(1_800_000_000_000i64)), Some(1_800_000_000_000.0));
        assert_eq!(a_ms(&json!("1800000000")), Some(1_800_000_000_000.0));
        assert_eq!(a_ms(&json!("2027-01-15T12:00:00Z")), Some(1_800_014_400_000.0));
        assert_eq!(a_ms(&json!("mañana")), None);
        assert_eq!(a_ms(&Value::Null), None);
        assert_eq!(a_ms(&json!(0)), None);
        assert_eq!(a_ms(&json!(-5)), None);
    }

    #[test]
    fn a_ms_coincide_con_el_typescript() {
        let f: Value = serde_json::from_str(include_str!("fixtures/ts.json")).unwrap();
        for par in f["a_ms"].as_array().unwrap() {
            assert_eq!(a_ms(&par[0]), par[1].as_f64(), "{}", par[0]);
        }
    }

    #[test]
    fn fecha_iso_con_desfase_y_milisegundos() {
        assert_eq!(fecha_iso_a_ms("2027-01-15T12:00:00.5Z"), Some(1_800_014_400_500.0));
        assert_eq!(fecha_iso_a_ms("2027-01-15T12:00:00-03:00"), Some(1_800_025_200_000.0));
        assert_eq!(fecha_iso_a_ms("2027-02-30"), None);
        assert_eq!(fecha_iso_a_ms("2027-01-15T25:00"), None);
    }

    #[test]
    fn leer_limites_sin_archivo_roto_o_vencido_queda_sin_datos() {
        let ahora = 1_800_000_000_000i64;
        assert_eq!(leer_limites(None, ahora), LimitesLeidos::default());
        assert_eq!(leer_limites(Some("{roto"), ahora), LimitesLeidos::default());
        assert_eq!(leer_limites(Some("[]"), ahora), LimitesLeidos::default());
        let texto = json!({ "fiveHour": { "pct": 72.4, "resetsAt": (ahora + 3_600_000) / 1000 }, "sevenDay": { "pct": 41, "resetsAt": (ahora - 1000) / 1000 }, "at": ahora - 5000 }).to_string();
        let r = leer_limites(Some(&texto), ahora);
        assert_eq!(r.cinco_horas, Some(VentanaLimite { pct: 72.4, reinicia_en: Some((ahora + 3_600_000) as f64) }));
        assert_eq!(r.semana, None);
        assert_eq!(r.at, Some(ahora - 5000));
        assert_eq!(leer_limites(Some(r#"{"fiveHour":{"pct":130}}"#), ahora).cinco_horas.map(|v| v.pct), Some(100.0));
        assert_eq!(leer_limites(Some(r#"{"fiveHour":{"pct":"50"}}"#), ahora).cinco_horas, None);
        assert_eq!(leer_limites(Some("\u{feff}{\"fiveHour\":{\"pct\":5}}"), ahora).cinco_horas.map(|v| v.pct), Some(5.0));
    }

    fn uso(tokens: f64, messages: u64) -> UsoCuenta {
        let t = Totales { input: tokens, output: 0.0, cache_write: 0.0, cache_read: 0.0, messages };
        UsoCuenta { last5h: t, today: t, last7d: t, scanned_at: 0, window_start: None, ventana: None }
    }

    fn entrada() -> Entrada {
        let agente = |state: &str, detail: Option<&str>, at| AgenteEstado { state: state.into(), detail: detail.map(Into::into), at };
        Entrada {
            ahora: 1000,
            aprobar: false,
            terminal: false,
            cuentas: vec![CuentaEntrada { id: "a".into(), label: "Fusion".into() }, CuentaEntrada { id: "b".into(), label: "Personal".into() }],
            espacios: ["w1:web:a", "w2:api:a", "w3:docs:b", "w4:sin terminal:b"].iter().map(|s| s.split(':').collect::<Vec<_>>()).map(|p| EspacioEntrada { id: p[0].into(), name: p[1].into(), account_id: p[2].into() }).collect(),
            agentes: HashMap::from([("w1".to_string(), agente("working", Some("Bash"), 100)), ("w2".to_string(), agente("done", None, 200)), ("w3".to_string(), agente("idle", None, 300))]),
            uso: HashMap::from([("a".to_string(), uso(1500.0, 12))]),
            limites: HashMap::from([("a".to_string(), LimitesLeidos { cinco_horas: Some(VentanaLimite { pct: 50.0, reinicia_en: None }), semana: None, at: Some(900) })]),
            pedidos: vec![PedidoPendiente { id: "p1".into(), ws: "w1".into(), tool: "Bash".into(), input: json!({ "command": "npm test" }).as_object().unwrap().clone(), at: 950, expires_at: 5000 }],
        }
    }

    #[test]
    fn armar_estado_un_pedido_pendiente_pone_al_espacio_en_te_necesita_y_ordena_por_urgencia() {
        let e = armar_estado(&entrada(), &FalsoPermisos);
        let orden: Vec<_> = e.sesiones.iter().map(|s| (s.id.as_str(), s.estado)).collect();
        assert_eq!(orden, [("w1", EstadoSesion::Waiting), ("w2", EstadoSesion::Done), ("w3", EstadoSesion::Idle)]);
        assert_eq!(
            e.pedidos,
            vec![PedidoCelular { id: "p1".into(), sesion_id: "w1".into(), sesion: "web".into(), texto: "npm test".into(), titulo: "Claude quiere ejecutar un comando".into(), destructivo: None, cortado: None, desde: 950, vence: 5000 }]
        );
    }

    #[test]
    fn armar_estado_una_cuenta_sin_datos_de_limites_ni_uso_queda_en_none_nunca_en_0() {
        let e = armar_estado(&entrada(), &FalsoPermisos);
        let b = e.cuentas.iter().find(|c| c.id == "b").unwrap();
        assert_eq!(*b, CuentaCelular { id: "b".into(), nombre: "Personal".into(), cinco_horas: None, semana: None, limites_leidos_en: None, hoy: None });
        assert_eq!(e.cuentas[0].hoy, Some(UsoDelDia { tokens: 1500.0, mensajes: 12 }));
    }

    #[test]
    fn armar_estado_no_expone_carpetas_y_descarta_pedidos_de_espacios_borrados() {
        let mut ent = entrada();
        ent.pedidos.push(PedidoPendiente { id: "p2".into(), ws: "borrado".into(), tool: "Bash".into(), input: Map::new(), at: 1, expires_at: 2 });
        let e = armar_estado(&ent, &FalsoPermisos);
        assert_eq!(e.pedidos.len(), 1);
        assert!(!serde_json::to_string(&e).unwrap().contains("cwd"));
    }

    #[test]
    fn armar_estado_un_estado_raro_cuenta_como_idle_y_los_nombres_largos_se_cortan() {
        let mut ent = entrada();
        ent.pedidos.clear();
        ent.agentes.insert("w3".into(), AgenteEstado { state: "inventado".into(), detail: Some("x".repeat(300)), at: 5 });
        ent.espacios[0].name = "n".repeat(100);
        let e = armar_estado(&ent, &FalsoPermisos);
        let w3 = e.sesiones.iter().find(|s| s.id == "w3").unwrap();
        assert_eq!(w3.estado, EstadoSesion::Idle);
        assert_eq!(largo_utf16(w3.detalle.as_deref().unwrap()), 160);
        assert!(w3.detalle.as_deref().unwrap().ends_with('…'));
        let w1 = e.sesiones.iter().find(|s| s.id == "w1").unwrap();
        assert_eq!(largo_utf16(&w1.nombre), 60);
    }

    #[test]
    fn armar_estado_el_mismo_estado_se_ordena_por_lo_mas_nuevo() {
        let mut ent = entrada();
        ent.pedidos.clear();
        ent.agentes.insert("w1".into(), AgenteEstado { state: "idle".into(), detail: None, at: 50 });
        ent.agentes.insert("w3".into(), AgenteEstado { state: "idle".into(), detail: None, at: 300 });
        let e = armar_estado(&ent, &FalsoPermisos);
        assert_eq!(e.sesiones.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["w2", "w3", "w1"]);
    }

    #[test]
    fn pedido_para_celu_el_comando_entero_marcado_si_es_destructivo_y_sin_caracteres_que_escondan_lo_que_corre() {
        let cmd = |c: &str| json!({ "command": c }).as_object().unwrap().clone();
        let largo = format!("npm run build && {} && git push --force origin main", "x".repeat(600));
        let p = pedido_para_celu("Bash", &cmd(&largo), &FalsoPermisos);
        assert_eq!(p.texto, largo);
        assert_eq!(p.titulo, "Claude quiere ejecutar un comando");
        assert!(p.destructivo.is_some(), "push --force es destructivo");
        assert!(pedido_para_celu("Bash", &cmd("rm -rf node_modules"), &FalsoPermisos).destructivo.is_some());
        assert_eq!(pedido_para_celu("Bash", &cmd("ls -la"), &FalsoPermisos).destructivo, None);
        // Un override bidi da vuelta lo que se lee; el salto de línea de un comando de varias líneas sí queda.
        let bidi = pedido_para_celu("Bash", &cmd("echo hola\u{202E} fdsa && rm\nls\tx"), &FalsoPermisos);
        assert_eq!(bidi.texto, "echo hola\u{FFFD} fdsa && rm\nls\tx");
        let cortado = pedido_para_celu("Bash", &cmd(&"a".repeat(MAX_PEDIDO + 50)), &FalsoPermisos);
        assert_eq!(largo_utf16(&cortado.texto), MAX_PEDIDO);
        assert_eq!(cortado.cortado, Some(true), "lo que no entra se marca: desde el celu solo se puede rechazar");
        assert_eq!(pedido_para_celu("Bash", &cmd(&"a".repeat(MAX_PEDIDO)), &FalsoPermisos).cortado, None);
        let edit = pedido_para_celu("Edit", json!({ "file_path": "src/a.ts" }).as_object().unwrap(), &FalsoPermisos);
        assert_eq!(edit, PedidoParaCelu { texto: "Editar src/a.ts".into(), titulo: "Claude quiere editar un archivo".into(), destructivo: None, cortado: None });
        assert_eq!(pedido_para_celu("WebFetch", json!({ "url": "https://ejemplo.com/x" }).as_object().unwrap(), &FalsoPermisos).texto, "Acceder a ejemplo.com");
    }

    #[test]
    fn pedido_para_celu_cambia_los_controles_por_el_caracter_de_reemplazo() {
        let cmd = json!({ "command": "a\u{0}b\u{7f}c\u{200B}d\u{2028}e\u{85}f\rg" });
        let p = pedido_para_celu("Bash", cmd.as_object().unwrap(), &FalsoPermisos);
        assert_eq!(p.texto, "a\u{FFFD}b\u{FFFD}c\u{FFFD}d\u{FFFD}e\u{FFFD}f\u{FFFD}g");
    }

    #[test]
    fn texto_aviso_no_deja_saltos_de_linea_y_corta_lo_largo() {
        assert_eq!(texto_aviso(TipoAviso::Termino, "web", None, "Claude"), TextoAviso { titulo: "web terminó".into(), cuerpo: "Claude terminó. Revisá los cambios antes de seguir.".into() });
        let p = texto_aviso(TipoAviso::Permiso, "api\nmala", Some(&format!("Bash: {}", "x".repeat(500))), "Claude");
        assert_eq!(p.titulo, "api mala pide permiso");
        assert!(largo_utf16(&p.cuerpo) <= 160);
        assert_eq!(texto_aviso(TipoAviso::TeNecesita, "web", Some(""), "Claude").cuerpo, "Claude necesita tu atención.");
        assert_eq!(texto_aviso(TipoAviso::Termino, "web", None, "Codex"), TextoAviso { titulo: "web terminó".into(), cuerpo: "Codex terminó. Revisá los cambios antes de seguir.".into() });
        assert_eq!(texto_aviso(TipoAviso::TeNecesita, "web", Some(""), "Codex").cuerpo, "Codex necesita tu atención.");
        assert_eq!(texto_aviso(TipoAviso::Permiso, "web", Some(""), "Claude").cuerpo, "", "en permiso solo falta el detalle si es null");
        assert_eq!(texto_aviso(TipoAviso::Permiso, "web", None, "Claude").cuerpo, "Claude necesita tu permiso.");
    }

    #[test]
    fn debe_avisar_no_repite_el_mismo_aviso_dentro_de_la_ventana() {
        let mut m = HashMap::new();
        assert!(debe_avisar(&mut m, "w1:termino", 0, VENTANA_AVISOS_MS));
        assert!(!debe_avisar(&mut m, "w1:termino", 5000, VENTANA_AVISOS_MS));
        assert!(debe_avisar(&mut m, "w2:termino", 5000, VENTANA_AVISOS_MS));
        assert!(debe_avisar(&mut m, "w1:termino", 10_000, VENTANA_AVISOS_MS));
    }

    #[test]
    fn resumen_permiso_no_lleva_el_comando_ni_la_ruta() {
        assert_eq!(resumen_permiso("cmd"), "Claude quiere correr un comando.");
        assert_eq!(resumen_permiso("edit"), "Claude quiere editar archivos.");
        assert_eq!(resumen_permiso("net"), "Claude quiere acceder a internet.");
        assert_eq!(resumen_permiso("otra"), "Claude quiere usar una herramienta.");
    }

    #[test]
    fn token_ntfy_tras_cambiar_de_servidor_sin_token_nuevo_borra_el_guardado() {
        let (srv, tk) = ("https://ntfy.miempresa.com/", Some("tk_a"));
        assert_eq!(token_ntfy_tras(srv, tk, srv, None).as_deref(), Some("tk_a"));
        assert_eq!(token_ntfy_tras(srv, tk, "https://ntfy.sh/", None), None);
        assert_eq!(token_ntfy_tras(srv, tk, "https://ntfy.sh/", Some(Some("tk_b"))).as_deref(), Some("tk_b"));
        assert_eq!(token_ntfy_tras(srv, tk, srv, Some(None)), None);
    }

    #[test]
    fn cuerpo_ntfy_con_enlace_tocar_el_aviso_abre_la_pagina_sin_enlace_aviso_solo() {
        let t = TextoAviso { titulo: "web terminó".into(), cuerpo: "Claude terminó.".into() };
        let con = cuerpo_ntfy("sloth-tema-largo-1234567", TipoAviso::Termino, &t, Some("http://192.168.0.10:47321/"));
        assert_eq!(
            con,
            json!({
                "topic": "sloth-tema-largo-1234567", "title": "web terminó", "message": "Claude terminó.", "priority": 3, "tags": ["white_check_mark"],
                "click": "http://192.168.0.10:47321/", "actions": [{ "action": "view", "label": "Abrir Sloth", "url": "http://192.168.0.10:47321/", "clear": true }]
            })
        );
        assert_eq!(serde_json::to_string(&con).unwrap().find("\"click\"").unwrap() > serde_json::to_string(&con).unwrap().find("\"tags\"").unwrap(), true, "el orden de las claves es el del TypeScript");
        let sin = cuerpo_ntfy("sloth-tema-largo-1234567", TipoAviso::Permiso, &t, None);
        assert_eq!(sin["priority"], 4);
        assert_eq!(sin["tags"], json!(["warning"]));
        assert!(sin.get("click").is_none() && sin.get("actions").is_none());
    }

    #[test]
    fn enlace_aviso_nunca_lleva_la_clave_y_prefiere_lo_que_anda_fuera_de_casa() {
        let wifi = Some(("192.168.0.10", 47321));
        let remoto = Some("https://x.github.io/sloth/celu/");
        let https = Some("https://mi-pc.tail.ts.net");
        let o = |wifi, remoto, https, privado| enlace_aviso(&OrigenesAviso { wifi, remoto, https, privado });
        assert_eq!(o(wifi, None, None, false).as_deref(), Some("http://192.168.0.10:47321/"));
        assert_eq!(o(wifi, remoto, None, false).as_deref(), Some("https://x.github.io/sloth/celu/"), "con la remota prendida, la que anda afuera");
        assert_eq!(o(wifi, remoto, https, false).as_deref(), Some("https://mi-pc.tail.ts.net/"));
        assert_eq!(o(None, Some("https://x.github.io/sloth/celu/#p=secreto?a=1"), None, false).as_deref(), Some("https://x.github.io/sloth/celu/"));
        assert_eq!(o(None, Some("https://x.github.io/sloth/celu/?q=1#p=secreto"), None, false).as_deref(), Some("https://x.github.io/sloth/celu/"));
        assert_eq!(o(None, None, None, false), None);
        assert_eq!(o(wifi, None, https, true), None, "privado: ni la IP de casa ni el nombre de la PC");
        assert_eq!(o(wifi, remoto, https, true).as_deref(), Some("https://x.github.io/sloth/celu/"));
    }

    #[test]
    fn texto_aviso_privado_no_dice_el_espacio_ni_lo_que_dijo_claude() {
        let t = |tipo| texto_aviso_privado(tipo);
        assert_eq!(t(TipoAviso::Termino), TextoAviso { titulo: "Sloth".into(), cuerpo: "Una sesión terminó.".into() });
        assert_eq!(t(TipoAviso::TeNecesita).cuerpo, "Una sesión te necesita.");
        assert_eq!(t(TipoAviso::Permiso).cuerpo, "Una sesión pide permiso.");
    }

    #[test]
    fn ip_tailscale_la_ipv4_del_rango_de_tailscale_no_otra() {
        let r = |l: Vec<(&str, Vec<InterfazRed>)>| ip_tailscale(&redes(l));
        assert_eq!(r(vec![("Wi-Fi", vec![v4("192.168.1.5", false)]), ("Tailscale", vec![v4("100.101.102.103", false)])]).as_deref(), Some("100.101.102.103"));
        assert_eq!(r(vec![("Wi-Fi", vec![v4("100.72.1.2", false)]), ("Tailscale", vec![v4("100.101.102.103", false)])]).as_deref(), Some("100.101.102.103"), "un hotspot con CGNAT no es Tailscale");
        assert_eq!(r(vec![("Wi-Fi", vec![v4("100.72.1.2", false)])]), None);
        assert_eq!(r(vec![("Wi-Fi", vec![v4("192.168.1.5", false)])]), None);
        assert_eq!(r(vec![("Tailscale", vec![v4("100.63.0.1", false), v4("100.128.0.1", false)])]), None, "fuera del rango no es Tailscale");
        assert_eq!(r(vec![("Tailscale", vec![InterfazRed { address: "fd7a:115c:a1e0::1".into(), v4: false, internal: false }])]), None);
    }

    #[test]
    fn https_tailscale_solo_direcciones_https_de_ts_net_normalizadas() {
        assert_eq!(https_tailscale(&json!("https://mi-pc.tailnet-abc.ts.net/")).as_deref(), Some("https://mi-pc.tailnet-abc.ts.net"));
        assert_eq!(https_tailscale(&json!("  HTTPS://Mi-PC.Tail1.TS.NET  ")).as_deref(), Some("https://mi-pc.tail1.ts.net"));
        for malo in [json!("http://mi-pc.tail.ts.net"), json!("https://mi-pc.tail.ts.net.evil.com"), json!("https://evil.com/?x=.ts.net"), json!("https://mi-pc.tail.ts.net/ruta"), json!("https://ts.net"), json!("https://-a.tail.ts.net"), json!(1), json!(null)] {
            assert_eq!(https_tailscale(&malo), None, "{malo}");
        }
    }
}
