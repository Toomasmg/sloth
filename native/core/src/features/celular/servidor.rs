//! El servidor del Wi-Fi: HTTP/1.1 a mano sobre `std::net`, con un hilo por conexión. Equivale a `celular-servidor.ts`.
//! Las rutas de datos van con cuerpos sellados con la clave del QR o la de un celu; sin clave válida, 401 y nada más.
//!
//! No hay WebSocket (la página consulta con POST y deja abierto el pedido de «mirar» hasta 25 s), así que no hace falta
//! `tungstenite` ni `tiny_http`: lo único que el protocolo necesita es leer una cabecera, un cuerpo de hasta 8 KB y
//! escribir una respuesta con `Content-Length`. Un hilo por conexión es lo que ya hace Node para este volumen (un celu
//! usa unas pocas conexiones, con tope por IP) y evita traer un runtime asíncrono al núcleo.
use super::actividad::Quien;
use super::conexiones::Conexiones;
use super::limite::Limite;
use super::pagina::{manifiesto, PAGINA_CSS, PAGINA_HTML, PAGINA_JS};
use super::sello::{abrir_pedido, derivar_claves, fecha_valida, sellar_respuesta_nueva, Claves, Repetidos};
use super::terminal_core::{leer_pedido_terminal, PedidoTerminal, RespuestaTerminal};
use super::tipos::EstadoCelular;
use super::{ahora_ms, cortar_utf16};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Deny,
}

/// Por qué no se pudo abrir la terminal: apagada o sin permiso (403), no existe (404), demasiadas esperas (429).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErrorTerminal {
    pub status: u16,
    pub error: String,
}

/// Lo que la PC le da a cualquier fuente: el estado y cómo responder un permiso.
pub trait ProveedorDeEstado: Send + Sync {
    /// `quien` llega solo por el Wi-Fi: la IP y el user-agent del pedido, ya con la clave verificada.
    fn estado(&self, quien: Option<&Quien>) -> EstadoCelular;
    /// Con un mensaje para el celu si no se pudo (venció, ya se respondió).
    fn decidir(&self, id: &str, decision: Decision, quien: Option<&Quien>) -> Result<(), String>;
    /// Con `quien`, lo que deja el nivel de ese celu además del interruptor.
    fn puede_aprobar(&self, quien: Option<&Quien>) -> bool;
    /// La clave del QR: con ella solo se puede pedir entrar.
    fn clave(&self) -> String;
    /// Las claves de los celus que la PC dejó entrar, `(id, clave)`. Las rutas de datos solo abren con una de estas.
    fn celus(&self) -> Vec<(String, String)> {
        Vec::new()
    }
    /// Si hay pedidos de entrada. Sin esto, el QR da acceso directo, como en v1.
    fn admite_entrar(&self) -> bool {
        false
    }
    /// Un celu que escaneó el QR pide entrar (o pregunta cómo va su pedido): `(status, cuerpo)`.
    fn entrar(&self, _cuerpo: &Value, _quien: &Quien) -> (u16, Value) {
        (400, json!({ "error": "Pedido inválido." }))
    }
    /// Sin archivo, el de 192 px; si no, uno de `ICONOS`.
    fn icono(&self, archivo: Option<&str>) -> Option<Vec<u8>>;
    /// La terminal de un espacio, vista desde el celu. `cancelada` salta si el celu cortó la conexión con el pedido abierto.
    fn terminal(&self, p: &PedidoTerminal, cancelada: &dyn Fn() -> bool, quien: Option<&Quien>) -> Result<RespuestaTerminal, ErrorTerminal>;
    /// xterm.js y su css, para que la página del celu dibuje la terminal: `(js, css)`.
    fn xterm(&self) -> Option<(String, String)>;
}

const MAX_CUERPO: usize = 8192;
const MAX_CABECERA: usize = 16 * 1024;
/// Un pedido real (cabeceras y hasta 8 KB de cuerpo) llega en milisegundos: quien lo gotea no necesita más.
const PEDIDO_MS: u64 = 10_000;

/// Los íconos que pide el manifiesto: el de 192 y, para instalarla como app (por HTTPS), los de 512.
const ICONOS: [(&str, &str); 3] = [("/icono.png", "icono-192.png"), ("/icono-512.png", "icono-512.png"), ("/icono-maskable.png", "icono-maskable-512.png")];

const SEGURIDAD: [(&str, &str); 3] = [("cache-control", "no-store"), ("x-content-type-options", "nosniff"), ("referrer-policy", "no-referrer")];

const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

struct Respuesta {
    status: u16,
    tipo: Option<&'static str>,
    cuerpo: Vec<u8>,
    extra: Vec<(&'static str, String)>,
}

fn vacia(status: u16) -> Respuesta {
    Respuesta { status, tipo: None, cuerpo: Vec::new(), extra: Vec::new() }
}

fn con_cuerpo(status: u16, tipo: &'static str, cuerpo: Vec<u8>) -> Respuesta {
    Respuesta { status, tipo: Some(tipo), cuerpo, extra: Vec::new() }
}

fn razon(status: u16) -> &'static str {
    match status {
        200 => "OK",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        _ => "Internal Server Error",
    }
}

struct Pedido {
    metodo: String,
    ruta: String,
    cabeceras: HashMap<String, String>,
    cuerpo: Vec<u8>,
    /// El cuerpo no entró en `MAX_CUERPO`: no se leyó.
    demasiado_grande: bool,
}

impl Pedido {
    fn cabecera(&self, nombre: &str) -> Option<&str> {
        self.cabeceras.get(nombre).map(String::as_str)
    }
}

pub struct OpcionesWifi {
    pub host: String,
    pub puerto: u16,
    pub proveedor: Arc<dyn ProveedorDeEstado>,
    /// Conexiones simultáneas por cliente (16: un celu usa unas pocas, y tras recargar quedan las viejas hasta que vencen).
    pub max_conexiones_por_ip: Option<usize>,
    /// Cuánto puede estar una conexión sin dar señales de vida antes de cortarla (sin un pedido completo no hay motivo para sostenerla).
    pub ocioso_ms: Option<u64>,
    /// Compartido entre los servidores de la misma PC (Wi-Fi, Tailscale, 127.0.0.1): un sobre visto en uno no vale en otro.
    pub repetidos: Option<Arc<Repetidos>>,
    /// Cómo se muestra en la PC quien llega por este servidor, en vez de su IP (por `tailscale serve` todos llegan desde 127.0.0.1).
    pub etiqueta: Option<String>,
    pub log: Option<Arc<dyn Fn(&str) + Send + Sync>>,
    /// Pedidos de terminal por cliente (200 en 5 s). Los tests ensanchan la ventana para no depender de la velocidad de la máquina.
    pub limite: Option<Limite>,
}

impl OpcionesWifi {
    pub fn nuevas(host: &str, puerto: u16, proveedor: Arc<dyn ProveedorDeEstado>) -> Self {
        OpcionesWifi { host: host.into(), puerto, proveedor, max_conexiones_por_ip: None, ocioso_ms: None, repetidos: None, etiqueta: None, log: None, limite: None }
    }
}

struct Compartido {
    proveedor: Arc<dyn ProveedorDeEstado>,
    repetidos: Arc<Repetidos>,
    limite: Limite,
    conexiones: Conexiones,
    etiqueta: Option<String>,
    ocioso: Duration,
    log: Option<Arc<dyn Fn(&str) + Send + Sync>>,
    // Derivar una clave cuesta dos HMAC: se guarda por clave y se tira cuando deja de estar.
    derivadas: Mutex<HashMap<String, Option<Claves>>>,
    parar: AtomicBool,
    activos: AtomicUsize,
    abiertas: Mutex<HashMap<u64, TcpStream>>,
    siguiente: AtomicU64,
}

impl Compartido {
    /// Primero las de los celus (con su id); la del QR, al final y sin id.
    fn llaves(&self) -> Vec<(Option<String>, Claves)> {
        let mut previas = self.derivadas.lock().unwrap_or_else(|e| e.into_inner());
        let mut nuevas: HashMap<String, Option<Claves>> = HashMap::new();
        let mut out = Vec::new();
        let derivar = |clave: &str, nuevas: &mut HashMap<String, Option<Claves>>| -> Option<Claves> {
            let c = match previas.get(clave) {
                Some(c) => c.clone(),
                None => derivar_claves(clave),
            };
            nuevas.insert(clave.to_string(), c.clone());
            c
        };
        for (id, clave) in self.proveedor.celus() {
            if let Some(k) = derivar(&clave, &mut nuevas) {
                out.push((Some(id), k));
            }
        }
        if let Some(k) = derivar(&self.proveedor.clave(), &mut nuevas) {
            out.push((None, k));
        }
        *previas = nuevas;
        out
    }

    fn registrar(&self, texto: &str) {
        if let Some(l) = &self.log {
            l(texto);
        }
    }
}

fn etag_de(cuerpo: &[u8]) -> String {
    format!("\"{}\"", &URL_SAFE_NO_PAD.encode(Sha256::digest(cuerpo))[..22])
}

// Los archivos de la página no cambian mientras corre la app: el celu los revalida con ETag y no los baja de nuevo en cada carga.
fn estatico(p: &Pedido, tipo: &'static str, cuerpo: Vec<u8>) -> Respuesta {
    let etag = etag_de(&cuerpo);
    let extra = vec![("cache-control", "no-cache".to_string()), ("etag", etag.clone())];
    if p.cabecera("if-none-match") == Some(etag.as_str()) {
        return Respuesta { status: 304, tipo: None, cuerpo: Vec::new(), extra };
    }
    Respuesta { status: 200, tipo: Some(tipo), cuerpo, extra }
}

fn sellado(claves: &Claves, iv: &[u8], status: u16, data: &Value) -> Respuesta {
    con_cuerpo(status, "text/plain; charset=utf-8", sellar_respuesta_nueva(claves, iv, &data.to_string()).into_bytes())
}

fn atender(c: &Compartido, p: &Pedido, ip_remota: &str, cancelada: &dyn Fn() -> bool) -> Option<Respuesta> {
    let es_get = p.metodo == "GET" || p.metodo == "HEAD";
    let ruta = p.ruta.as_str();

    if matches!(ruta, "/api/estado" | "/api/permiso" | "/api/terminal" | "/api/emparejar") {
        // 401 a los GET para que una página vieja ya abierta (con x-sloth-token) pida volver a escanear en vez de quedar en «sin conexión».
        if es_get {
            return Some(vacia(401));
        }
        if p.metodo != "POST" {
            return Some(Respuesta { extra: vec![("allow", "POST".into())], ..vacia(405) });
        }
        if p.demasiado_grande {
            return Some(vacia(413));
        }
        let texto = String::from_utf8_lossy(&p.cuerpo);
        let mut abierto = None;
        for (celu, claves) in c.llaves() {
            if let Some(ab) = abrir_pedido(&claves, ruta, &texto) {
                abierto = Some((celu, claves, ab));
                break;
            }
        }
        let Some((celu, claves, ab)) = abierto else { return Some(vacia(401)) };
        let con_qr = celu.is_none() && c.proveedor.admite_entrar();
        let sobre: Value = serde_json::from_str(&ab.json).unwrap_or(Value::Null);
        let iv = ab.iv;
        let sellar = |status: u16, data: Value| Some(sellado(&claves, &iv, status, &data));
        // El MAC ya pasó: la clave es buena. La hora corrida y el reenvío se contestan sellados (no 401) para que el celu no se desempareje.
        if !sobre.is_object() && !sobre.is_array() {
            return Some(vacia(401));
        }
        let ahora = ahora_ms();
        if !fecha_valida(sobre.get("t"), ahora) {
            return sellar(409, json!({ "error": "reloj" }));
        }
        if c.repetidos.visto_antes(&iv, ahora) {
            return sellar(409, json!({ "error": "repetido" }));
        }
        // Con clave de celu, el cupo es de ese celu: por `tailscale serve` todos comparten 127.0.0.1 y uno no le gasta el cupo a otro.
        let cupo = celu.as_ref().map_or_else(|| ip_remota.to_string(), |id| format!("celu:{id}"));
        let ua = cortar_utf16(p.cabecera("user-agent").unwrap_or(""), 400);
        let quien = Quien { ip: c.etiqueta.clone().unwrap_or_else(|| ip_remota.to_string()), ua, celu: celu.clone() };
        let cuerpo = sobre.get("b").unwrap_or(&Value::Null);

        if ruta == "/api/emparejar" {
            // Ya tiene acceso: la página usa esa clave tal cual (un enlace guardado con la clave del celu, no la del QR).
            if !con_qr {
                return sellar(200, json!({ "ya": true }));
            }
            if !c.limite.permitir(&cupo, ahora_ms()) {
                return Some(vacia(429));
            }
            let (status, data) = c.proveedor.entrar(cuerpo, &quien);
            return sellar(status, data);
        }
        // La clave del QR sola no deja ver ni hacer nada: primero hay que pedir entrar y que la PC diga que sí.
        if con_qr {
            return Some(vacia(401));
        }

        if ruta == "/api/estado" {
            return sellar(200, serde_json::to_value(c.proveedor.estado(Some(&quien))).expect("el estado se serializa"));
        }
        if ruta == "/api/terminal" {
            // Después del MAC y del anti-replay: quien no tiene la clave no le gasta el cupo al celu de verdad.
            if !c.limite.permitir(&cupo, ahora_ms()) {
                return Some(vacia(429));
            }
            let Some(pedido) = leer_pedido_terminal(cuerpo) else { return sellar(400, json!({ "error": "Pedido inválido." })) };
            let r = c.proveedor.terminal(&pedido, cancelada, Some(&quien));
            if cancelada() {
                return None;
            }
            return match r {
                Ok(r) => sellar(200, serde_json::to_value(r).expect("la respuesta se serializa")),
                Err(e) => sellar(e.status, json!({ "error": e.error })),
            };
        }
        if !c.proveedor.puede_aprobar(Some(&quien)) {
            return sellar(403, json!({ "error": "Aprobar desde el celu está apagado en Sloth." }));
        }
        let id = cuerpo.get("id").and_then(Value::as_str).filter(|i| i.encode_utf16().count() <= 100);
        let decision = match cuerpo.get("decision").and_then(Value::as_str) {
            Some("allow") => Some(Decision::Allow),
            Some("deny") => Some(Decision::Deny),
            _ => None,
        };
        let (Some(id), Some(decision), true) = (id, decision, cuerpo.is_object()) else { return sellar(400, json!({ "error": "Pedido inválido." })) };
        return match c.proveedor.decidir(id, decision, Some(&quien)) {
            Ok(()) => sellar(200, json!({ "ok": true })),
            Err(e) => sellar(409, json!({ "error": e })),
        };
    }

    if !es_get {
        return Some(Respuesta { extra: vec![("allow", "GET".into())], ..vacia(405) });
    }
    Some(match ruta {
        "/" => Respuesta { extra: vec![("content-security-policy", CSP.into())], ..con_cuerpo(200, "text/html; charset=utf-8", PAGINA_HTML.as_bytes().to_vec()) },
        "/app.css" => estatico(p, "text/css; charset=utf-8", PAGINA_CSS.as_bytes().to_vec()),
        "/app.js" => estatico(p, "text/javascript; charset=utf-8", PAGINA_JS.as_bytes().to_vec()),
        "/xterm.js" | "/xterm.css" => match c.proveedor.xterm() {
            None => vacia(404),
            Some((js, _)) if ruta == "/xterm.js" => estatico(p, "text/javascript; charset=utf-8", js.into_bytes()),
            Some((_, css)) => estatico(p, "text/css; charset=utf-8", css.into_bytes()),
        },
        "/manifest.webmanifest" => con_cuerpo(200, "application/manifest+json; charset=utf-8", manifiesto().into_bytes()),
        _ => match ICONOS.iter().find(|(r, _)| *r == ruta) {
            Some((_, archivo)) => c.proveedor.icono(Some(archivo)).map_or_else(|| vacia(404), |png| estatico(p, "image/png", png)),
            None => vacia(404),
        },
    })
}

enum Lectura {
    Pedido(Pedido),
    /// El cliente cerró o no mandó nada a tiempo.
    Cerrado,
    /// Cabecera imposible: se contesta y se corta.
    Invalido(u16),
}

fn buscar(hay: &[u8], aguja: &[u8]) -> Option<usize> {
    hay.windows(aguja.len()).position(|w| w == aguja)
}

fn leer_pedido(s: &mut TcpStream, pendiente: &mut Vec<u8>, ocioso: Duration) -> Lectura {
    let mut inicio: Option<Instant> = (!pendiente.is_empty()).then(Instant::now);
    let fin_cabecera = loop {
        if let Some(i) = buscar(pendiente, b"\r\n\r\n") {
            break i;
        }
        if pendiente.len() > MAX_CABECERA {
            return Lectura::Invalido(431);
        }
        let espera = match inicio {
            None => ocioso,
            Some(t) => match Duration::from_millis(PEDIDO_MS).checked_sub(t.elapsed()) {
                Some(r) if !r.is_zero() => r.min(ocioso),
                _ => return Lectura::Cerrado,
            },
        };
        if s.set_read_timeout(Some(espera)).is_err() {
            return Lectura::Cerrado;
        }
        let mut buf = [0u8; 4096];
        match s.read(&mut buf) {
            Ok(0) | Err(_) => return Lectura::Cerrado,
            Ok(n) => {
                inicio.get_or_insert_with(Instant::now);
                pendiente.extend_from_slice(&buf[..n]);
            }
        }
    };
    let cabecera = String::from_utf8_lossy(&pendiente[..fin_cabecera]).into_owned();
    pendiente.drain(..fin_cabecera + 4);
    let mut lineas = cabecera.split("\r\n");
    let mut primera = lineas.next().unwrap_or("").split(' ');
    let (Some(metodo), Some(objetivo), Some(version)) = (primera.next(), primera.next(), primera.next()) else { return Lectura::Invalido(400) };
    if !version.starts_with("HTTP/1.") {
        return Lectura::Invalido(400);
    }
    let mut cabeceras = HashMap::new();
    for l in lineas {
        let Some((k, v)) = l.split_once(':') else { return Lectura::Invalido(400) };
        cabeceras.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
    }
    cabeceras.insert(":version".into(), version.to_string());
    if cabeceras.contains_key("transfer-encoding") {
        return Lectura::Invalido(400);
    }
    let largo = match cabeceras.get("content-length") {
        None => 0,
        Some(v) => match v.parse::<usize>() {
            Ok(n) => n,
            Err(_) => return Lectura::Invalido(400),
        },
    };
    let demasiado_grande = largo > MAX_CUERPO;
    let mut cuerpo = Vec::new();
    if !demasiado_grande {
        while pendiente.len() < largo {
            let Some(restante) = Duration::from_millis(PEDIDO_MS).checked_sub(inicio.map_or(Duration::ZERO, |t| t.elapsed())).filter(|r| !r.is_zero()) else { return Lectura::Cerrado };
            if s.set_read_timeout(Some(restante)).is_err() {
                return Lectura::Cerrado;
            }
            let mut buf = [0u8; 4096];
            match s.read(&mut buf) {
                Ok(0) | Err(_) => return Lectura::Cerrado,
                Ok(n) => pendiente.extend_from_slice(&buf[..n]),
            }
        }
        cuerpo = pendiente.drain(..largo).collect();
    }
    let ruta = objetivo.split('?').next().unwrap_or("/").to_string();
    Lectura::Pedido(Pedido { metodo: metodo.to_string(), ruta: if ruta.is_empty() { "/".into() } else { ruta }, cabeceras, cuerpo, demasiado_grande })
}

fn escribir_respuesta(s: &mut TcpStream, r: &Respuesta, solo_cabecera: bool, seguir: bool) -> std::io::Result<()> {
    let mut cab = format!("HTTP/1.1 {} {}\r\n", r.status, razon(r.status));
    for (k, v) in SEGURIDAD.iter().filter(|(k, _)| !r.extra.iter().any(|(e, _)| e == k)) {
        cab.push_str(&format!("{k}: {v}\r\n"));
    }
    for (k, v) in &r.extra {
        cab.push_str(&format!("{k}: {v}\r\n"));
    }
    if let Some(t) = r.tipo {
        cab.push_str(&format!("content-type: {t}\r\n"));
    }
    if r.status != 304 {
        cab.push_str(&format!("content-length: {}\r\n", r.cuerpo.len()));
    }
    cab.push_str(if seguir { "connection: keep-alive\r\n\r\n" } else { "connection: close\r\n\r\n" });
    s.write_all(cab.as_bytes())?;
    if !solo_cabecera && r.status != 304 {
        s.write_all(&r.cuerpo)?;
    }
    s.flush()
}

/// Si el celu cortó la conexión: mira sin sacar nada del socket.
fn cortada(sonda: &TcpStream) -> bool {
    if sonda.set_nonblocking(true).is_err() {
        return true;
    }
    let mut un_byte = [0u8; 1];
    let r = match sonda.peek(&mut un_byte) {
        Ok(0) => true,
        Ok(_) => false,
        Err(e) => e.kind() != ErrorKind::WouldBlock,
    };
    let _ = sonda.set_nonblocking(false);
    r
}

fn atender_conexion(c: &Arc<Compartido>, mut s: TcpStream, ip: &str) {
    let Ok(sonda) = s.try_clone() else { return };
    let mut pendiente = Vec::new();
    loop {
        if c.parar.load(Ordering::SeqCst) {
            return;
        }
        let p = match leer_pedido(&mut s, &mut pendiente, c.ocioso) {
            Lectura::Pedido(p) => p,
            Lectura::Cerrado => return,
            Lectura::Invalido(status) => {
                let _ = escribir_respuesta(&mut s, &vacia(status), false, false);
                return;
            }
        };
        let version_1_1 = p.cabecera(":version") == Some("HTTP/1.1");
        let conexion = p.cabecera("connection").map(str::to_ascii_lowercase);
        let mut seguir = if version_1_1 { conexion.as_deref() != Some("close") } else { conexion.as_deref() == Some("keep-alive") };
        seguir &= !p.demasiado_grande;
        let cancelada = || c.parar.load(Ordering::SeqCst) || cortada(&sonda);
        let respuesta = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| atender(c, &p, ip, &cancelada))) {
            Ok(r) => r,
            Err(_) => {
                c.registrar("celular: error atendiendo una ruta");
                Some(vacia(500))
            }
        };
        let Some(r) = respuesta else { return };
        let escrito = escribir_respuesta(&mut s, &r, p.metodo == "HEAD", seguir);
        if p.demasiado_grande {
            descartar_resto(&mut s);
        }
        if escrito.is_err() || !seguir {
            return;
        }
    }
}

/// Con un cuerpo que no se leyó, cerrar de golpe manda un RST y el celu pierde el 413: se cierra la escritura y se
/// tira lo que siga llegando un rato (acotado) antes de soltar el socket.
fn descartar_resto(s: &mut TcpStream) {
    let _ = s.shutdown(Shutdown::Write);
    let _ = s.set_read_timeout(Some(Duration::from_millis(500)));
    let mut buf = [0u8; 4096];
    let mut total = 0;
    while total < 256 * 1024 {
        match s.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => total += n,
        }
    }
}

struct Corriendo {
    puerto: u16,
    compartido: Arc<Compartido>,
    aceptador: JoinHandle<()>,
}

/// El servidor del Wi-Fi. Las rutas de datos van con cuerpos sellados con la clave del QR; sin clave válida, 401 y nada más.
pub struct FuenteWifi {
    host: String,
    puerto: u16,
    compartido: Arc<Compartido>,
    corriendo: Mutex<Option<Corriendo>>,
}

impl FuenteWifi {
    pub fn nombre(&self) -> &'static str {
        "wifi"
    }

    pub fn nueva(o: OpcionesWifi) -> Self {
        let compartido = Arc::new(Compartido {
            proveedor: o.proveedor,
            repetidos: o.repetidos.unwrap_or_default(),
            limite: o.limite.unwrap_or_default(),
            conexiones: o.max_conexiones_por_ip.map_or_else(Conexiones::default, Conexiones::nuevas),
            etiqueta: o.etiqueta,
            ocioso: Duration::from_millis(o.ocioso_ms.unwrap_or(40_000)),
            log: o.log,
            derivadas: Mutex::new(HashMap::new()),
            parar: AtomicBool::new(false),
            activos: AtomicUsize::new(0),
            abiertas: Mutex::new(HashMap::new()),
            siguiente: AtomicU64::new(0),
        });
        FuenteWifi { host: o.host, puerto: o.puerto, compartido, corriendo: Mutex::new(None) }
    }

    /// El puerto en el que escucha (el real, si se pidió el 0).
    pub fn puerto(&self) -> u16 {
        self.corriendo.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map_or(self.puerto, |c| c.puerto)
    }

    pub fn iniciar(&self) -> std::io::Result<()> {
        let mut estado = self.corriendo.lock().unwrap_or_else(|e| e.into_inner());
        if estado.is_some() {
            return Ok(());
        }
        let listener = TcpListener::bind((self.host.as_str(), self.puerto))?;
        listener.set_nonblocking(true)?;
        let puerto = listener.local_addr().map(|a: SocketAddr| a.port())?;
        let c = self.compartido.clone();
        c.parar.store(false, Ordering::SeqCst);
        let compartido = c.clone();
        let aceptador = thread::spawn(move || {
            while !c.parar.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((s, _)) => {
                        let ip = s.peer_addr().map_or_else(|_| "?".to_string(), |a| a.ip().to_string());
                        if !c.conexiones.abrir(&ip) {
                            let _ = s.shutdown(Shutdown::Both);
                            continue;
                        }
                        let _ = s.set_nonblocking(false);
                        let _ = s.set_nodelay(true);
                        let id = c.siguiente.fetch_add(1, Ordering::SeqCst);
                        if let Ok(copia) = s.try_clone() {
                            c.abiertas.lock().unwrap_or_else(|e| e.into_inner()).insert(id, copia);
                        }
                        c.activos.fetch_add(1, Ordering::SeqCst);
                        let c2 = c.clone();
                        thread::spawn(move || {
                            atender_conexion(&c2, s, &ip);
                            c2.abiertas.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                            c2.conexiones.cerrar(&ip);
                            c2.activos.fetch_sub(1, Ordering::SeqCst);
                        });
                    }
                    Err(e) if e.kind() == ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(5)),
                    Err(_) => thread::sleep(Duration::from_millis(50)),
                }
            }
        });
        *estado = Some(Corriendo { puerto, compartido, aceptador });
        Ok(())
    }

    /// Corta las conexiones (también las que esperan salida de una terminal) y espera a que los hilos terminen.
    pub fn detener(&self) {
        let Some(corriendo) = self.corriendo.lock().unwrap_or_else(|e| e.into_inner()).take() else { return };
        let c = corriendo.compartido;
        c.parar.store(true, Ordering::SeqCst);
        let _ = corriendo.aceptador.join();
        for s in c.abiertas.lock().unwrap_or_else(|e| e.into_inner()).values() {
            let _ = s.shutdown(Shutdown::Both);
        }
        let limite = Instant::now() + Duration::from_secs(3);
        while c.activos.load(Ordering::SeqCst) > 0 && Instant::now() < limite {
            thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for FuenteWifi {
    fn drop(&mut self) {
        self.detener();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::celular::pruebas::clave_de;
    use crate::features::celular::sello::{abrir_respuesta, iv_aleatorio, sellar_pedido};
    use crate::features::celular::tipos::EstadoCelular;
    use std::sync::atomic::AtomicBool;

    type FnTerminal = Box<dyn Fn(&PedidoTerminal, &dyn Fn() -> bool) -> Result<RespuestaTerminal, ErrorTerminal> + Send + Sync>;

    struct Falso {
        clave: String,
        celus: Mutex<Vec<(String, String)>>,
        admite_entrar: bool,
        vistos: Mutex<Vec<String>>,
        puede_aprobar: Box<dyn Fn(Option<&Quien>) -> bool + Send + Sync>,
        decidir: Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>,
        terminal: FnTerminal,
        xterm: Option<(String, String)>,
        icono: Option<Vec<u8>>,
        icono_512: Option<Vec<u8>>,
    }

    fn estado() -> EstadoCelular {
        EstadoCelular { ahora: 1, aprobar: false, terminal: false, terminal_en_wifi: None, cuentas: vec![], sesiones: vec![], pedidos: vec![] }
    }

    fn sin_salida() -> RespuestaTerminal {
        RespuestaTerminal { reinicio: false, datos: String::new(), hasta: 0, mas: false, viva: true, cols: 80, rows: 24, ajustado: false }
    }

    fn apagada() -> ErrorTerminal {
        ErrorTerminal { status: 403, error: "La terminal desde el celu está apagada en Sloth.".into() }
    }

    impl Falso {
        fn nuevo() -> Self {
            Falso {
                clave: clave_de(7),
                celus: Mutex::new(vec![]),
                admite_entrar: false,
                vistos: Mutex::new(vec![]),
                puede_aprobar: Box::new(|_| false),
                decidir: Box::new(|_| Ok(())),
                terminal: Box::new(|_, _| Err(apagada())),
                xterm: None,
                icono: None,
                icono_512: None,
            }
        }
    }

    impl ProveedorDeEstado for Falso {
        fn estado(&self, quien: Option<&Quien>) -> EstadoCelular {
            self.vistos.lock().unwrap().push(format!("estado {}", quien.map_or("-".to_string(), |q| format!("{}|{}|{}", q.ip, q.ua, q.celu.clone().unwrap_or_default()))));
            estado()
        }
        fn decidir(&self, id: &str, decision: Decision, quien: Option<&Quien>) -> Result<(), String> {
            self.vistos.lock().unwrap().push(format!("decidir {id}:{decision:?}:{}", quien.and_then(|q| q.celu.clone()).unwrap_or_default()));
            (self.decidir)(id)
        }
        fn puede_aprobar(&self, quien: Option<&Quien>) -> bool {
            (self.puede_aprobar)(quien)
        }
        fn clave(&self) -> String {
            self.clave.clone()
        }
        fn celus(&self) -> Vec<(String, String)> {
            self.celus.lock().unwrap().clone()
        }
        fn admite_entrar(&self) -> bool {
            self.admite_entrar
        }
        fn entrar(&self, cuerpo: &Value, quien: &Quien) -> (u16, Value) {
            self.vistos.lock().unwrap().push(format!("entrar {cuerpo} {:?}", quien.celu));
            (200, json!({ "codigo": "0042", "estado": "esperando" }))
        }
        fn icono(&self, archivo: Option<&str>) -> Option<Vec<u8>> {
            if archivo == Some("icono-512.png") {
                self.icono_512.clone()
            } else {
                self.icono.clone()
            }
        }
        fn terminal(&self, p: &PedidoTerminal, cancelada: &dyn Fn() -> bool, _: Option<&Quien>) -> Result<RespuestaTerminal, ErrorTerminal> {
            (self.terminal)(p, cancelada)
        }
        fn xterm(&self) -> Option<(String, String)> {
            self.xterm.clone()
        }
    }

    struct Resp {
        status: u16,
        cabeceras: Vec<(String, String)>,
        cuerpo: Vec<u8>,
    }

    impl Resp {
        fn cab(&self, n: &str) -> Option<&str> {
            self.cabeceras.iter().find(|(k, _)| k == n).map(|(_, v)| v.as_str())
        }
        fn texto(&self) -> String {
            String::from_utf8_lossy(&self.cuerpo).into_owned()
        }
    }

    fn leer_respuesta(s: &mut TcpStream) -> Resp {
        let mut todo = Vec::new();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let _ = s.read_to_end(&mut todo);
        let corte = buscar(&todo, b"\r\n\r\n").expect("una respuesta con cabecera");
        let cab = String::from_utf8_lossy(&todo[..corte]).into_owned();
        let mut lineas = cab.split("\r\n");
        let status = lineas.next().unwrap().split(' ').nth(1).unwrap().parse().unwrap();
        let cabeceras = lineas.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())).collect();
        Resp { status, cabeceras, cuerpo: todo[corte + 4..].to_vec() }
    }

    fn pedir(puerto: u16, metodo: &str, ruta: &str, cabeceras: &[(&str, &str)], cuerpo: &[u8]) -> Resp {
        let mut s = TcpStream::connect(("127.0.0.1", puerto)).unwrap();
        let mut p = format!("{metodo} {ruta} HTTP/1.1\r\nhost: x\r\nconnection: close\r\ncontent-length: {}\r\n", cuerpo.len());
        for (k, v) in cabeceras {
            p.push_str(&format!("{k}: {v}\r\n"));
        }
        p.push_str("\r\n");
        s.write_all(p.as_bytes()).unwrap();
        s.write_all(cuerpo).unwrap();
        leer_respuesta(&mut s)
    }

    fn con_servidor(proveedor: Falso, f: impl FnOnce(u16, &Arc<Falso>)) {
        con_servidor_con(proveedor, |_| {}, f)
    }

    fn con_servidor_con(proveedor: Falso, ajustar: impl FnOnce(&mut OpcionesWifi), f: impl FnOnce(u16, &Arc<Falso>)) {
        let p = Arc::new(proveedor);
        let mut o = OpcionesWifi::nuevas("127.0.0.1", 0, p.clone());
        // Cientos de pedidos seguidos desde la misma IP: el tope de 16 se prueba aparte, y el cierre de cada hilo no es instantáneo.
        o.max_conexiones_por_ip = Some(1000);
        o.limite = Some(Limite::nuevo(200, 600_000, 256));
        ajustar(&mut o);
        let fuente = FuenteWifi::nueva(o);
        fuente.iniciar().unwrap();
        f(fuente.puerto(), &p);
        fuente.detener();
    }

    struct Sellado {
        status: u16,
        cuerpo: Option<Value>,
        texto: String,
    }

    #[derive(Default)]
    struct Opciones<'a> {
        t: Option<i64>,
        ruta_sellada: Option<&'a str>,
        con: Option<String>,
    }

    fn sobre_de(claves: &Claves, ruta: &str, t: i64, obj: &Value, iv: &[u8]) -> String {
        sellar_pedido(claves, ruta, &json!({ "t": t, "b": obj }).to_string(), iv).unwrap()
    }

    /// Manda un pedido sellado como lo hace la página y abre la respuesta; la hora y la ruta sellada se pueden falsear.
    fn post_sellado(puerto: u16, ruta: &str, obj: Value, o: Opciones) -> Sellado {
        let iv = iv_aleatorio();
        let claves = derivar_claves(&o.con.unwrap_or_else(|| clave_de(7))).unwrap();
        let sobre = sobre_de(&claves, o.ruta_sellada.unwrap_or(ruta), o.t.unwrap_or_else(ahora_ms), &obj, &iv);
        let r = pedir(puerto, "POST", ruta, &[("content-type", "text/plain")], sobre.as_bytes());
        let texto = r.texto();
        let plano = if r.status == 401 || texto.is_empty() { None } else { abrir_respuesta(&claves, &iv, &texto) };
        Sellado { status: r.status, cuerpo: plano.map(|p| serde_json::from_str(&p).unwrap()), texto }
    }

    fn claves_qr() -> Claves {
        derivar_claves(&clave_de(7)).unwrap()
    }

    #[test]
    fn sin_cuerpo_con_el_mac_roto_o_con_otra_ruta_401_sin_cuerpo() {
        con_servidor(Falso::nuevo(), |p, _| {
            let sin = pedir(p, "POST", "/api/estado", &[], b"");
            assert_eq!((sin.status, sin.texto().as_str()), (401, ""));
            let sobre = sobre_de(&claves_qr(), "/api/estado", ahora_ms(), &json!({}), &iv_aleatorio());
            let roto = format!("{}{}", &sobre[..sobre.len() - 2], if sobre.ends_with("AA") { "BB" } else { "AA" });
            let r = pedir(p, "POST", "/api/estado", &[], roto.as_bytes());
            assert_eq!((r.status, r.texto().as_str()), (401, ""));
            let otra = post_sellado(p, "/api/permiso", json!({ "id": "p", "decision": "allow" }), Opciones { ruta_sellada: Some("/api/estado"), ..Default::default() });
            assert_eq!((otra.status, otra.texto.as_str()), (401, ""));
        });
    }

    #[test]
    fn la_pc_sabe_quien_pidio_ip_y_navegador_solo_cuando_la_clave_es_buena() {
        let mut f = Falso::nuevo();
        f.puede_aprobar = Box::new(|_| true);
        con_servidor(f, |p, prov| {
            let ua = "Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile";
            let sobre = sobre_de(&claves_qr(), "/api/estado", ahora_ms(), &json!({}), &iv_aleatorio());
            pedir(p, "POST", "/api/estado", &[("user-agent", ua)], sobre.as_bytes());
            pedir(p, "POST", "/api/estado", &[("user-agent", ua)], b"roto");
            post_sellado(p, "/api/permiso", json!({ "id": "p1", "decision": "deny" }), Opciones::default());
            let vistos = prov.vistos.lock().unwrap().clone();
            assert_eq!(vistos.len(), 2, "el pedido con la clave mala no llega a la PC: {vistos:?}");
            assert_eq!(vistos[0], format!("estado 127.0.0.1|{ua}|"));
            assert_eq!(vistos[1], "decidir p1:Deny:");
        });
    }

    #[test]
    fn con_el_sobre_bien_sellado_devuelve_el_estado_sellado_sin_cache() {
        con_servidor(Falso::nuevo(), |p, _| {
            let iv = iv_aleatorio();
            let sobre = sobre_de(&claves_qr(), "/api/estado", ahora_ms(), &json!({}), &iv);
            let r = pedir(p, "POST", "/api/estado", &[], sobre.as_bytes());
            assert_eq!(r.status, 200);
            assert_eq!(r.cab("cache-control"), Some("no-store"));
            assert_eq!(r.cab("x-content-type-options"), Some("nosniff"));
            let texto = r.texto();
            assert!(!texto.contains("cuentas"));
            let abierto: Value = serde_json::from_str(&abrir_respuesta(&claves_qr(), &iv, &texto).unwrap()).unwrap();
            assert_eq!(abierto, serde_json::to_value(estado()).unwrap());
        });
    }

    #[test]
    fn la_respuesta_de_un_pedido_no_abre_con_el_iv_de_otro() {
        con_servidor(Falso::nuevo(), |p, _| {
            let sobre = sobre_de(&claves_qr(), "/api/estado", ahora_ms(), &json!({}), &iv_aleatorio());
            let r = pedir(p, "POST", "/api/estado", &[], sobre.as_bytes());
            assert_eq!(abrir_respuesta(&claves_qr(), &iv_aleatorio(), &r.texto()), None);
        });
    }

    #[test]
    fn el_mismo_sobre_dos_veces_la_segunda_es_un_409_sellado_repetido_no_un_401() {
        con_servidor(Falso::nuevo(), |p, _| {
            let sobre = sobre_de(&claves_qr(), "/api/estado", ahora_ms(), &json!({}), &iv_aleatorio());
            assert_eq!(pedir(p, "POST", "/api/estado", &[], sobre.as_bytes()).status, 200);
            let otra = pedir(p, "POST", "/api/estado", &[], sobre.as_bytes());
            assert_eq!(otra.status, 409);
            assert!(!otra.texto().is_empty());
        });
    }

    #[test]
    fn un_pedido_con_la_hora_a_10_minutos_de_la_pc_409_sellado_reloj_no_401() {
        con_servidor(Falso::nuevo(), |p, _| {
            for t in [ahora_ms() - 10 * 60_000, ahora_ms() + 10 * 60_000] {
                let r = post_sellado(p, "/api/estado", json!({}), Opciones { t: Some(t), ..Default::default() });
                assert_eq!(r.status, 409);
                assert_eq!(r.cuerpo, Some(json!({ "error": "reloj" })));
            }
        });
    }

    #[test]
    fn get_a_las_rutas_de_datos_401_el_viejo_x_sloth_token_con_la_clave_no_sirve() {
        con_servidor(Falso::nuevo(), |p, _| {
            let g = pedir(p, "GET", "/api/estado", &[], b"");
            assert_eq!((g.status, g.texto().as_str()), (401, ""));
            let put = pedir(p, "PUT", "/api/estado", &[], b"");
            assert_eq!((put.status, put.cab("allow")), (405, Some("POST")));
            let viejo = pedir(p, "POST", "/api/estado", &[("x-sloth-token", &clave_de(7))], b"{}");
            assert_eq!((viejo.status, viejo.texto().as_str()), (401, ""));
        });
    }

    #[test]
    fn aprobar_desde_el_celu_apagado_403_sellado_y_no_decide_nada() {
        con_servidor(Falso::nuevo(), |p, prov| {
            let r = post_sellado(p, "/api/permiso", json!({ "id": "p1", "decision": "allow" }), Opciones::default());
            assert_eq!(r.status, 403);
            assert_eq!(r.cuerpo, Some(json!({ "error": "Aprobar desde el celu está apagado en Sloth." })));
            assert!(prov.vistos.lock().unwrap().is_empty());
        });
    }

    #[test]
    fn aprobar_prendido_valida_el_pedido_y_pasa_la_decision() {
        let mut f = Falso::nuevo();
        f.puede_aprobar = Box::new(|_| true);
        con_servidor(f, |p, prov| {
            let ok = |obj: Value| post_sellado(p, "/api/permiso", obj, Opciones::default()).status;
            assert_eq!(ok(json!({ "id": "p1", "decision": "allow" })), 200);
            assert_eq!(ok(json!({ "id": "p2", "decision": "allowAlways" })), 400);
            assert_eq!(ok(json!({ "id": "p".repeat(200), "decision": "deny" })), 400);
            assert_eq!(ok(json!("suelto")), 400);
            assert_eq!(prov.vistos.lock().unwrap().clone(), ["decidir p1:Allow:"]);
        });
    }

    #[test]
    fn si_el_pedido_ya_no_esta_el_celu_recibe_el_motivo_sellado() {
        let mut f = Falso::nuevo();
        f.puede_aprobar = Box::new(|_| true);
        f.decidir = Box::new(|_| Err("Ese permiso ya no está pendiente.".into()));
        con_servidor(f, |p, _| {
            let r = post_sellado(p, "/api/permiso", json!({ "id": "p1", "decision": "deny" }), Opciones::default());
            assert_eq!(r.status, 409);
            assert_eq!(r.cuerpo, Some(json!({ "error": "Ese permiso ya no está pendiente." })));
        });
    }

    #[test]
    fn los_archivos_de_la_pagina_se_revalidan_con_etag_si_el_celu_ya_los_tiene_304_sin_cuerpo() {
        let mut f = Falso::nuevo();
        f.icono = Some(b"png".to_vec());
        con_servidor(f, |p, _| {
            for ruta in ["/app.js", "/app.css", "/icono.png"] {
                let r = pedir(p, "GET", ruta, &[], b"");
                assert_eq!(r.status, 200);
                assert_eq!(r.cab("cache-control"), Some("no-cache"));
                let etag = r.cab("etag").unwrap().to_string();
                assert!(etag.starts_with('"') && etag.ends_with('"') && etag.len() == 24, "{etag}");
                let otra = pedir(p, "GET", ruta, &[("if-none-match", &etag)], b"");
                assert_eq!((otra.status, otra.texto().as_str()), (304, ""), "{ruta}");
                assert_eq!(pedir(p, "GET", ruta, &[("if-none-match", "\"viejo\"")], b"").status, 200);
            }
        });
    }

    #[test]
    fn el_etag_es_el_mismo_que_calculaba_el_typescript() {
        // sha256("png") en base64url, 22 caracteres.
        assert_eq!(etag_de(b"png"), format!("\"{}\"", &URL_SAFE_NO_PAD.encode(Sha256::digest(b"png"))[..22]));
        assert_eq!(etag_de(b"png").len(), 24);
    }

    #[test]
    fn la_pagina_se_sirve_sin_clave_con_csp_y_sin_referer_lo_desconocido_es_404() {
        con_servidor(Falso::nuevo(), |p, _| {
            let r = pedir(p, "GET", "/", &[], b"");
            assert_eq!(r.status, 200);
            assert!(r.cab("content-security-policy").unwrap().contains("script-src 'self'"));
            assert_eq!(r.cab("referrer-policy"), Some("no-referrer"));
            let html = r.texto();
            assert!(!html.contains(&clave_de(7)));
            // Sin hosts de afuera: sin internet (o con un portal cautivo) la página no queda en blanco esperándolos.
            assert!(!html.contains("href=\"http") && !html.contains("src=\"http"));
            assert!(!r.cab("content-security-policy").unwrap().contains("http:") && !r.cab("content-security-policy").unwrap().contains("https:"));
            assert_eq!(r.cab("cache-control"), Some("no-store"));
            assert_eq!(r.texto().as_bytes(), PAGINA_HTML.as_bytes());
            let js = pedir(p, "GET", "/app.js", &[], b"");
            assert_eq!(js.status, 200);
            assert!(js.texto().contains("slothSello"));
            assert_eq!(pedir(p, "GET", "/icono.png", &[], b"").status, 404);
            assert_eq!(pedir(p, "GET", "/.env", &[], b"").status, 404);
            assert_eq!(pedir(p, "POST", "/", &[], b"").cab("allow"), Some("GET"));
            let head = pedir(p, "HEAD", "/", &[], b"");
            assert_eq!((head.status, head.cuerpo.len()), (200, 0));
        });
    }

    #[test]
    fn terminal_sin_sello_no_hay_nada_con_el_pedido_mal_armado_400_apagada_403_sellado() {
        let pedidos = Arc::new(Mutex::new(Vec::<PedidoTerminal>::new()));
        let mut f = Falso::nuevo();
        let reg = pedidos.clone();
        f.terminal = Box::new(move |p, _| {
            reg.lock().unwrap().push(p.clone());
            Err(apagada())
        });
        con_servidor(f, |p, _| {
            let sin = pedir(p, "POST", "/api/terminal", &[], b"");
            assert_eq!((sin.status, sin.texto().as_str()), (401, ""));
            let t = |obj: Value| post_sellado(p, "/api/terminal", obj, Opciones::default());
            assert_eq!(t(json!({ "id": "ws", "desde": 0, "escribir": "x".repeat(5000) })).status, 400);
            assert_eq!(t(json!({ "id": "login:a", "desde": 0 })).status, 400);
            let r = t(json!({ "id": "ws-1", "desde": -1, "escribir": "ls\r" }));
            assert_eq!(r.status, 403);
            assert_eq!(r.cuerpo, Some(json!({ "error": "La terminal desde el celu está apagada en Sloth." })));
            let vistos = pedidos.lock().unwrap().clone();
            assert_eq!(vistos, vec![PedidoTerminal { escribir: Some("ls\r".into()), ..PedidoTerminal::mirar("ws-1", -1) }]);
        });
    }

    #[test]
    fn terminal_prendida_la_salida_vuelve_sellada_nada_en_claro_en_la_red() {
        let mut f = Falso::nuevo();
        f.terminal = Box::new(|_, _| Ok(RespuestaTerminal { reinicio: true, datos: "secreto-de-la-terminal".into(), hasta: 3, ..sin_salida() }));
        con_servidor(f, |p, _| {
            let r = post_sellado(p, "/api/terminal", json!({ "id": "ws-1", "desde": -1 }), Opciones::default());
            assert_eq!(r.status, 200);
            assert!(!r.texto.contains("secreto"));
            assert_eq!(r.cuerpo.unwrap()["datos"], "secreto-de-la-terminal");
        });
    }

    #[test]
    fn xterm_se_sirve_solo_si_esta_sin_el_404() {
        con_servidor(Falso::nuevo(), |p, _| assert_eq!(pedir(p, "GET", "/xterm.js", &[], b"").status, 404));
        let mut f = Falso::nuevo();
        f.xterm = Some(("var x".into(), ".x{}".into()));
        con_servidor(f, |p, _| {
            let js = pedir(p, "GET", "/xterm.js", &[], b"");
            assert_eq!(js.status, 200);
            assert!(js.cab("content-type").unwrap().contains("javascript"));
            assert_eq!(pedir(p, "GET", "/xterm.css", &[], b"").texto(), ".x{}");
        });
    }

    #[test]
    fn terminal_lleva_los_campos_nuevos_al_proveedor_y_rechaza_las_mezclas_que_no_valen_sin_llegar_a_el() {
        let pedidos = Arc::new(Mutex::new(Vec::<PedidoTerminal>::new()));
        let mut f = Falso::nuevo();
        let reg = pedidos.clone();
        f.terminal = Box::new(move |p, _| {
            reg.lock().unwrap().push(p.clone());
            Ok(sin_salida())
        });
        con_servidor(f, |p, _| {
            let t = |obj: Value| post_sellado(p, "/api/terminal", obj, Opciones::default()).status;
            assert_eq!(t(json!({ "id": "ws", "desde": 4, "espera": 20000, "sesion": "sesion-abc" })), 200);
            assert_eq!(t(json!({ "id": "ws", "desde": 4, "soloEscribir": true, "escribir": "a", "sesion": "sesion-abc", "n": 3 })), 200);
            assert_eq!(t(json!({ "id": "ws", "desde": 4, "espera": 20000, "escribir": "a" })), 400);
            assert_eq!(t(json!({ "id": "ws", "desde": 4, "espera": 99999 })), 400);
            assert_eq!(t(json!({ "id": "ws", "desde": 4, "soloEscribir": true })), 400);
            let vistos = pedidos.lock().unwrap().clone();
            assert_eq!(vistos.len(), 2);
            assert_eq!((vistos[0].espera, vistos[0].sesion.as_deref()), (Some(20000), Some("sesion-abc")));
            assert!(vistos[1].solo_escribir && vistos[1].n == Some(3) && vistos[1].escribir.as_deref() == Some("a"));
        });
    }

    #[test]
    fn terminal_pasados_200_pedidos_en_5_s_429_sin_cuerpo_los_que_no_pasan_el_mac_no_gastan_el_cupo() {
        let llegaron = Arc::new(AtomicUsize::new(0));
        let mut f = Falso::nuevo();
        let n = llegaron.clone();
        f.terminal = Box::new(move |_, _| {
            n.fetch_add(1, Ordering::SeqCst);
            Ok(sin_salida())
        });
        con_servidor(f, |p, _| {
            for i in 0..300 {
                assert_eq!(pedir(p, "POST", "/api/terminal", &[], format!("basura{i}").as_bytes()).status, 401);
            }
            for i in 0..200 {
                assert_eq!(post_sellado(p, "/api/terminal", json!({ "id": "ws", "desde": 0 }), Opciones::default()).status, 200, "pedido {i}");
            }
            let sobre = sobre_de(&claves_qr(), "/api/terminal", ahora_ms(), &json!({ "id": "ws", "desde": 0 }), &iv_aleatorio());
            let r = pedir(p, "POST", "/api/terminal", &[], sobre.as_bytes());
            assert_eq!((r.status, r.texto().as_str()), (429, ""));
            assert_eq!(llegaron.load(Ordering::SeqCst), 200);
            assert_eq!(post_sellado(p, "/api/estado", json!({}), Opciones::default()).status, 200, "el límite es solo de la terminal");
        });
    }

    #[test]
    fn terminal_un_429_del_proveedor_demasiadas_esperas_vuelve_sellado() {
        let mut f = Falso::nuevo();
        f.terminal = Box::new(|_, _| Err(ErrorTerminal { status: 429, error: "La PC tiene demasiadas terminales abiertas desde el celu.".into() }));
        con_servidor(f, |p, _| {
            let r = post_sellado(p, "/api/terminal", json!({ "id": "ws", "desde": 1, "espera": 1000 }), Opciones::default());
            assert_eq!(r.status, 429);
            assert_eq!(r.cuerpo, Some(json!({ "error": "La PC tiene demasiadas terminales abiertas desde el celu." })));
        });
    }

    fn colgado() -> (FnTerminal, Arc<AtomicBool>, Arc<AtomicBool>) {
        let llego = Arc::new(AtomicBool::new(false));
        let cancelado = Arc::new(AtomicBool::new(false));
        let (l, c) = (llego.clone(), cancelado.clone());
        let t: FnTerminal = Box::new(move |_, cancelada| {
            l.store(true, Ordering::SeqCst);
            let tope = Instant::now() + Duration::from_secs(20);
            while !cancelada() && Instant::now() < tope {
                thread::sleep(Duration::from_millis(5));
            }
            c.store(cancelada(), Ordering::SeqCst);
            Ok(sin_salida())
        });
        (t, llego, cancelado)
    }

    fn esperar(cond: impl Fn() -> bool) {
        let tope = Instant::now() + Duration::from_secs(10);
        while !cond() && Instant::now() < tope {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(cond(), "la condición no se dio a tiempo");
    }

    #[test]
    fn terminal_si_el_celu_corta_la_conexion_con_el_pedido_abierto_el_proveedor_se_entera_y_no_queda_nada_colgado() {
        let (t, llego, cancelado) = colgado();
        let mut f = Falso::nuevo();
        f.terminal = t;
        con_servidor(f, |p, _| {
            let sobre = sobre_de(&claves_qr(), "/api/terminal", ahora_ms(), &json!({ "id": "ws", "desde": 3, "espera": 20000 }), &iv_aleatorio());
            let mut s = TcpStream::connect(("127.0.0.1", p)).unwrap();
            let pedido = format!("POST /api/terminal HTTP/1.1\r\nhost: x\r\ncontent-length: {}\r\n\r\n{sobre}", sobre.len());
            s.write_all(pedido.as_bytes()).unwrap();
            esperar(|| llego.load(Ordering::SeqCst));
            assert!(!cancelado.load(Ordering::SeqCst));
            drop(s);
            esperar(|| cancelado.load(Ordering::SeqCst));
            assert_eq!(post_sellado(p, "/api/estado", json!({}), Opciones::default()).status, 200, "el servidor sigue atendiendo");
        });
    }

    #[test]
    fn terminal_detener_con_un_pedido_abierto_corta_la_conexion_suelta_la_espera_y_no_se_cuelga() {
        let (t, llego, cancelado) = colgado();
        let mut f = Falso::nuevo();
        f.terminal = t;
        let p = Arc::new(f);
        let fuente = FuenteWifi::nueva(OpcionesWifi::nuevas("127.0.0.1", 0, p));
        fuente.iniciar().unwrap();
        let puerto = fuente.puerto();
        let cliente = thread::spawn(move || {
            let sobre = sobre_de(&claves_qr(), "/api/terminal", ahora_ms(), &json!({ "id": "ws", "desde": 3, "espera": 20000 }), &iv_aleatorio());
            let mut s = TcpStream::connect(("127.0.0.1", puerto)).unwrap();
            s.write_all(format!("POST /api/terminal HTTP/1.1\r\nhost: x\r\ncontent-length: {}\r\n\r\n{sobre}", sobre.len()).as_bytes()).unwrap();
            let mut todo = Vec::new();
            s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
            let _ = s.read_to_end(&mut todo);
            todo
        });
        esperar(|| llego.load(Ordering::SeqCst));
        let t0 = Instant::now();
        fuente.detener();
        assert!(t0.elapsed() < Duration::from_secs(3), "detener se colgó");
        assert!(cancelado.load(Ordering::SeqCst));
        assert!(cliente.join().unwrap().is_empty(), "el celu no recibe respuesta, se corta");
    }

    #[test]
    fn conexiones_un_equipo_que_llena_su_cupo_con_sockets_ociosos_no_pasa_del_tope_y_al_cerrarse_una_vuelve_el_lugar() {
        con_servidor_con(Falso::nuevo(), |o| o.max_conexiones_por_ip = Some(3), |p, _| {
            let mut malos: Vec<TcpStream> = (0..3).map(|_| TcpStream::connect(("127.0.0.1", p)).unwrap()).collect();
            // El servidor cuenta al aceptar: se espera a que los tres estén contados antes de abrir el cuarto.
            thread::sleep(Duration::from_millis(200));
            let mut de_mas = TcpStream::connect(("127.0.0.1", p)).unwrap();
            de_mas.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut b = [0u8; 1];
            assert!(matches!(de_mas.read(&mut b), Ok(0) | Err(_)), "el cuarto del mismo equipo se corta");
            malos[0].write_all(b"GET /manifest.webmanifest HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n").unwrap();
            assert_eq!(leer_respuesta(&mut malos[0]).status, 200, "los primeros siguen");
            esperar(|| {
                let mut nuevo = TcpStream::connect(("127.0.0.1", p)).unwrap();
                nuevo.write_all(b"GET /manifest.webmanifest HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n").unwrap();
                let mut todo = Vec::new();
                nuevo.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let _ = nuevo.read_to_end(&mut todo);
                todo.starts_with(b"HTTP/1.1 200")
            });
        });
    }

    #[test]
    fn conexiones_una_que_no_manda_nada_se_corta_sola() {
        con_servidor_con(Falso::nuevo(), |o| o.ocioso_ms = Some(150), |p, _| {
            let mut callado = TcpStream::connect(("127.0.0.1", p)).unwrap();
            callado.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut b = [0u8; 1];
            assert!(matches!(callado.read(&mut b), Ok(0) | Err(_)));
            assert_eq!(post_sellado(p, "/api/estado", json!({}), Opciones::default()).status, 200);
        });
    }

    #[test]
    fn un_cuerpo_de_mas_de_8_kb_es_413_y_una_cabecera_rota_400() {
        con_servidor(Falso::nuevo(), |p, _| {
            let r = pedir(p, "POST", "/api/estado", &[], &vec![b'x'; 9000]);
            assert_eq!(r.status, 413);
            let mut s = TcpStream::connect(("127.0.0.1", p)).unwrap();
            s.write_all(b"basura\r\n\r\n").unwrap();
            assert_eq!(leer_respuesta(&mut s).status, 400);
        });
    }

    #[test]
    fn emparejar_con_la_clave_del_qr_solo_se_pide_entrar_los_datos_abren_con_la_clave_de_un_celu_que_la_pc_dejo_entrar() {
        let celu = clave_de(9);
        let mut f = Falso::nuevo();
        f.admite_entrar = true;
        f.puede_aprobar = Box::new(|q| q.and_then(|q| q.celu.as_deref()) == Some("c1"));
        con_servidor(f, |p, prov| {
            let con = |c: &str| Opciones { con: Some(c.to_string()), ..Default::default() };
            assert_eq!(post_sellado(p, "/api/estado", json!({}), Opciones::default()).status, 401, "el QR solo no deja ver nada");
            assert_eq!(post_sellado(p, "/api/terminal", json!({ "id": "w", "desde": -1 }), Opciones::default()).status, 401);
            let pide = post_sellado(p, "/api/emparejar", json!({ "clave": celu }), Opciones::default());
            assert_eq!(pide.status, 200);
            assert_eq!(pide.cuerpo, Some(json!({ "codigo": "0042", "estado": "esperando" })));
            assert_eq!(post_sellado(p, "/api/estado", json!({}), con(&celu)).status, 401, "sin el sí de la PC, la clave del celu no sirve");
            prov.celus.lock().unwrap().push(("c1".into(), celu.clone()));
            assert_eq!(post_sellado(p, "/api/estado", json!({}), con(&celu)).status, 200);
            let ya = post_sellado(p, "/api/emparejar", json!({ "clave": celu }), con(&celu));
            assert_eq!((ya.status, ya.cuerpo), (200, Some(json!({ "ya": true }))), "con la clave del celu, emparejar dice que ya está");
            assert_eq!(post_sellado(p, "/api/permiso", json!({ "id": "p", "decision": "allow" }), con(&celu)).status, 200, "puede_aprobar recibe quién es");
            prov.celus.lock().unwrap().clear();
            assert_eq!(post_sellado(p, "/api/estado", json!({}), con(&celu)).status, 401, "sacado de la lista, queda afuera en el acto");
            let vistos = prov.vistos.lock().unwrap().clone();
            assert_eq!(vistos, [format!("entrar {} None", json!({ "clave": celu })), "estado 127.0.0.1||c1".to_string(), "decidir p:Allow:c1".to_string()]);
        });
    }

    #[test]
    fn por_la_misma_ip_como_por_tailscale_serve_cada_celu_tiene_su_cupo_y_la_pc_lo_ve_con_la_etiqueta() {
        let (a, b) = (clave_de(10), clave_de(11));
        let mut f = Falso::nuevo();
        f.admite_entrar = true;
        f.terminal = Box::new(|_, _| Ok(sin_salida()));
        *f.celus.lock().unwrap() = vec![("a".into(), a.clone()), ("b".into(), b.clone())];
        con_servidor_con(f, |o| o.etiqueta = Some("Tailscale (HTTPS)".into()), |p, prov| {
            let con = |c: &str| Opciones { con: Some(c.to_string()), ..Default::default() };
            for _ in 0..200 {
                assert_eq!(post_sellado(p, "/api/terminal", json!({ "id": "ws", "desde": 0 }), con(&a)).status, 200);
            }
            assert_eq!(post_sellado(p, "/api/terminal", json!({ "id": "ws", "desde": 0 }), con(&a)).status, 429);
            assert_eq!(post_sellado(p, "/api/terminal", json!({ "id": "ws", "desde": 0 }), con(&b)).status, 200, "el otro celu no paga lo que gastó el primero");
            post_sellado(p, "/api/estado", json!({}), con(&b));
            assert_eq!(prov.vistos.lock().unwrap().clone(), ["estado Tailscale (HTTPS)||b"]);
        });
    }

    #[test]
    fn emparejar_sin_proveedor_de_entradas_como_en_v1_la_clave_del_qr_da_acceso_y_emparejar_contesta_que_ya_esta() {
        con_servidor(Falso::nuevo(), |p, _| {
            assert_eq!(post_sellado(p, "/api/estado", json!({}), Opciones::default()).status, 200);
            let ya = post_sellado(p, "/api/emparejar", json!({ "clave": clave_de(7) }), Opciones::default());
            assert_eq!((ya.status, ya.cuerpo), (200, Some(json!({ "ya": true }))));
        });
    }

    #[test]
    fn los_iconos_de_512_se_sirven_si_estan_el_manifiesto_los_pide() {
        let mut f = Falso::nuevo();
        f.icono_512 = Some(b"png-512".to_vec());
        con_servidor(f, |p, _| {
            let r = pedir(p, "GET", "/icono-512.png", &[], b"");
            assert_eq!(r.status, 200);
            assert_eq!(r.cab("content-type"), Some("image/png"));
            assert_eq!(r.cuerpo, b"png-512");
            assert_eq!(pedir(p, "GET", "/icono-maskable.png", &[], b"").status, 404);
            assert_eq!(pedir(p, "GET", "/__proto__", &[], b"").status, 404);
            let m: Value = serde_json::from_str(&pedir(p, "GET", "/manifest.webmanifest", &[], b"").texto()).unwrap();
            let iconos: Vec<String> = m["icons"].as_array().unwrap().iter().map(|i| format!("{} {} {}", i["src"].as_str().unwrap(), i["sizes"].as_str().unwrap(), i["purpose"].as_str().unwrap())).collect();
            assert_eq!(iconos, ["/icono.png 192x192 any", "/icono-512.png 512x512 any", "/icono-maskable.png 512x512 maskable"]);
        });
    }

    #[test]
    fn dos_servidores_de_la_misma_pc_comparten_la_memoria_de_sobres_uno_copiado_de_un_lado_no_vale_del_otro() {
        let repetidos = Arc::new(Repetidos::default());
        let prov: Arc<dyn ProveedorDeEstado> = Arc::new(Falso::nuevo());
        let mk = || {
            let mut o = OpcionesWifi::nuevas("127.0.0.1", 0, prov.clone());
            o.repetidos = Some(repetidos.clone());
            let f = FuenteWifi::nueva(o);
            f.iniciar().unwrap();
            f
        };
        let (a, b) = (mk(), mk());
        let sobre = sobre_de(&claves_qr(), "/api/estado", ahora_ms(), &json!({}), &iv_aleatorio());
        assert_eq!(pedir(a.puerto(), "POST", "/api/estado", &[], sobre.as_bytes()).status, 200);
        assert_eq!(pedir(b.puerto(), "POST", "/api/estado", &[], sobre.as_bytes()).status, 409);
    }

    #[test]
    fn detener_y_volver_a_iniciar_libera_el_puerto() {
        let f = FuenteWifi::nueva(OpcionesWifi::nuevas("127.0.0.1", 0, Arc::new(Falso::nuevo())));
        f.iniciar().unwrap();
        let p = f.puerto();
        assert_eq!(pedir(p, "GET", "/manifest.webmanifest", &[], b"").status, 200);
        f.detener();
        assert!(TcpStream::connect(("127.0.0.1", p)).is_err());
        f.detener();
    }
}
