//! Cliente del daemon de terminales. Equivale a la parte `DaemonBackend` de src/main/daemon-client.ts: saludo mutuo con
//! prueba de clave, estado de las sesiones, pedidos con respuesta, reconexión y retiro del daemon del protocolo 1.
//! Todo es sin I/O propia: `Handshake` y `Estado` son máquinas de estado puras, y lo que toca el pipe va genérico sobre
//! `Read + Write` o sobre el trait `Conector`, así se prueba con un daemon simulado. Lanzar el proceso del daemon y los
//! archivos de userData (clave, copia de binarios) quedan para la cáscara.
use crate::daemon_protocolo::{
    codificar, codificar_hello_legado, es_clave, es_nonce, legacy_pipe_name_for, misma_prueba, nuevo_nonce, prueba_cliente, prueba_daemon, ClientMessage, DaemonMessage, HelloOk, HookEventPayload,
    LectorLineas, PendingPermission, PtyStartResult, SessionInfo, SpawnSpec,
};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::io::{self, Read, Write};

pub const CONNECT_TIMEOUT_MS: u64 = 5_000;
pub const HELLO_TIMEOUT_MS: u64 = 3_000;
pub const LEGACY_HELLO_TIMEOUT_MS: u64 = 5_000;
pub const REQUEST_TIMEOUT_MS: u64 = 15_000;
const ESPERA_ENTRE_INTENTOS_MS: u64 = 150;

// ---------- Errores ----------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorConexion {
    /// No hay nadie en el pipe (ENOENT / ECONNREFUSED): se puede lanzar el daemon.
    Ausente(String),
    /// Contestó alguien que no conoce la clave.
    Impostor,
    /// El daemon cortó antes de terminar el saludo (¿clave distinta?).
    Rechazada,
    SinSaludo,
    Otro(String),
}

impl std::fmt::Display for ErrorConexion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ErrorConexion::Ausente(m) | ErrorConexion::Otro(m) => f.write_str(m),
            ErrorConexion::Impostor => f.write_str("El pipe del daemon lo tiene otro proceso que no es Sloth."),
            ErrorConexion::Rechazada => f.write_str("El daemon rechazó la conexión (¿clave distinta?)."),
            ErrorConexion::SinSaludo => f.write_str("El daemon no respondió el saludo."),
        }
    }
}

impl From<io::Error> for ErrorConexion {
    fn from(e: io::Error) -> Self {
        match e.kind() {
            io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused => ErrorConexion::Ausente(e.to_string()),
            _ => ErrorConexion::Otro(e.to_string()),
        }
    }
}

// ---------- Saludo mutuo ----------

#[derive(Debug, PartialEq)]
pub enum PasoSaludo {
    Nada,
    Enviar(String),
    Listo(Box<HelloOk>),
}

/// El daemon prueba primero que conoce la clave. Hasta verificarlo no se manda nada que dependa de ella, así otro proceso
/// que ocupe el pipe no se lleva ni la prueba ni lo que se tipea.
pub struct Handshake {
    clave: String,
    client_version: String,
    nonce_cliente: String,
    nonce_daemon: Option<String>,
    listo: bool,
}

impl Handshake {
    pub fn nuevo(clave: &str, client_version: &str) -> Self {
        Self::con_nonce(clave, client_version, nuevo_nonce())
    }

    pub fn con_nonce(clave: &str, client_version: &str, nonce_cliente: String) -> Self {
        Handshake { clave: clave.to_string(), client_version: client_version.to_string(), nonce_cliente, nonce_daemon: None, listo: false }
    }

    pub fn iniciar(&self) -> String {
        codificar(&ClientMessage::Challenge { nonce: self.nonce_cliente.clone() })
    }

    pub fn recibir(&mut self, m: DaemonMessage) -> Result<PasoSaludo, ErrorConexion> {
        if self.listo {
            return Ok(PasoSaludo::Nada);
        }
        match (&self.nonce_daemon, m) {
            (None, DaemonMessage::ChallengeOk { nonce, proof }) => {
                if !es_nonce(&nonce) || !misma_prueba(&proof, &prueba_daemon(&self.clave, &self.nonce_cliente, &nonce)) {
                    return Err(ErrorConexion::Impostor);
                }
                let hello = ClientMessage::Hello { proof: prueba_cliente(&self.clave, &self.nonce_cliente, &nonce), client_version: self.client_version.clone() };
                self.nonce_daemon = Some(nonce);
                Ok(PasoSaludo::Enviar(codificar(&hello)))
            }
            (Some(_), DaemonMessage::HelloOk(h)) => {
                self.listo = true;
                Ok(PasoSaludo::Listo(Box::new(h)))
            }
            _ => Ok(PasoSaludo::Nada),
        }
    }
}

/// Conexión ya saludada. Los mensajes que llegaron pegados al `hello-ok` quedan en `pendientes` hasta que se los pida.
pub struct Conexion<T> {
    pub io: T,
    pub hello: HelloOk,
    pub pendientes: Vec<DaemonMessage>,
    lector: LectorLineas,
}

impl<T: Read> Conexion<T> {
    /// Los próximos mensajes del daemon, bloqueando hasta que haya. `None` = el daemon cerró.
    pub fn siguiente(&mut self) -> io::Result<Option<Vec<DaemonMessage>>> {
        if !self.pendientes.is_empty() {
            return Ok(Some(std::mem::take(&mut self.pendientes)));
        }
        let mut tmp = vec![0u8; 64 * 1024];
        loop {
            let n = self.io.read(&mut tmp)?;
            if n == 0 {
                return Ok(None);
            }
            let ms = self.lector.alimentar(&tmp[..n]).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "línea demasiado larga"))?;
            if !ms.is_empty() {
                return Ok(Some(ms));
            }
        }
    }
}

/// Saludo sobre cualquier transporte. No tiene plazo propio: quien llama lo corta (ver `HELLO_TIMEOUT_MS`).
pub fn saludar<T: Read + Write>(mut io: T, clave: &str, client_version: &str) -> Result<Conexion<T>, ErrorConexion> {
    let mut h = Handshake::nuevo(clave, client_version);
    io.write_all(h.iniciar().as_bytes())?;
    let mut lector = LectorLineas::nuevo();
    let mut tmp = vec![0u8; 64 * 1024];
    let mut hello: Option<HelloOk> = None;
    let mut pendientes = Vec::new();
    loop {
        let n = match io.read(&mut tmp) {
            Ok(0) => return Err(ErrorConexion::Rechazada),
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(ErrorConexion::Rechazada),
        };
        let mensajes = lector.alimentar(&tmp[..n]).map_err(|_| ErrorConexion::Rechazada)?;
        for m in mensajes {
            if hello.is_some() {
                pendientes.push(m);
                continue;
            }
            match h.recibir(m)? {
                PasoSaludo::Nada => {}
                PasoSaludo::Enviar(l) => io.write_all(l.as_bytes())?,
                PasoSaludo::Listo(ok) => hello = Some(*ok),
            }
        }
        if let Some(hello) = hello {
            return Ok(Conexion { io, hello, pendientes, lector });
        }
    }
}

// ---------- Estado del backend ----------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InfoBackend {
    pub pid: Option<u32>,
    pub version: Option<String>,
}

/// Lo que el cliente le avisa al resto de la app. Mismos eventos que el EventEmitter de Node.
#[derive(Debug, Clone, PartialEq)]
pub enum Evento {
    Data { id: String, chunks: Vec<crate::daemon_protocolo::PtyChunk> },
    Exit { id: String, code: i64 },
    Hook(HookEventPayload),
    Permission(PendingPermission),
    PermissionResolved(String),
    Disconnect,
    Reconnect(InfoBackend),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Respuesta {
    pub rid: u64,
    pub resultado: Result<Value, String>,
}

#[derive(Debug, Default, PartialEq)]
pub struct Salida {
    pub eventos: Vec<Evento>,
    pub respuesta: Option<Respuesta>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorPedido {
    SinConexion,
}

impl std::fmt::Display for ErrorPedido {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Sin conexión con el daemon.")
    }
}

pub const ERR_SIN_RESPUESTA: &str = "El daemon no respondió.";
pub const ERR_CONEXION_CORTADA: &str = "Se cortó la conexión con el daemon.";
pub const ERR_LIBERADO: &str = "Backend liberado.";

#[derive(Debug, Default)]
pub struct Estado {
    rid: u64,
    /// rid -> cuándo vence (ms).
    reqs: HashMap<u64, u64>,
    corriendo: BTreeMap<String, bool>,
    permisos: Vec<PendingPermission>,
    hooks: BTreeMap<String, HookEventPayload>,
    hello: Option<HelloOk>,
    conectado: bool,
    liberado: bool,
    reconectando: bool,
}

impl Estado {
    pub fn nuevo() -> Self {
        Self::default()
    }

    pub fn hook_url(&self) -> &str {
        self.hello.as_ref().map_or("", |h| h.hook_url.as_str())
    }

    pub fn hook_token(&self) -> &str {
        self.hello.as_ref().map_or("", |h| h.hook_token.as_str())
    }

    pub fn info(&self) -> InfoBackend {
        InfoBackend { pid: self.hello.as_ref().map(|h| h.pid), version: self.hello.as_ref().map(|h| h.version.clone()) }
    }

    pub fn conectado(&self) -> bool {
        self.conectado
    }

    /// Toma el saludo de una conexión nueva (la primera o una reconexión). Avisa de lo que se perdió mientras estuvo caído:
    /// permisos que ya no están y sesiones que creíamos vivas y el daemon, relanzado, ya no tiene.
    pub fn conectar(&mut self, hello: HelloOk) -> Vec<Evento> {
        let antes: Vec<String> = self.corriendo.iter().filter(|(_, r)| **r).map(|(id, _)| id.clone()).collect();
        let permisos_viejos: Vec<String> = self.permisos.iter().map(|p| p.id.clone()).collect();
        self.corriendo = hello.sessions.iter().map(|s| (s.id.clone(), s.running)).collect();
        self.hooks = hello.last_hook_events.clone();
        self.permisos = hello.permissions.clone();
        self.hello = Some(hello);
        self.conectado = true;
        let mut eventos = Vec::new();
        for id in permisos_viejos {
            if !self.permisos.iter().any(|p| p.id == id) {
                eventos.push(Evento::PermissionResolved(id));
            }
        }
        for id in antes {
            if !self.corriendo.get(&id).copied().unwrap_or(false) {
                eventos.push(Evento::Exit { id, code: -1 });
            }
        }
        eventos
    }

    pub fn al_mensaje(&mut self, m: DaemonMessage) -> Salida {
        let mut s = Salida::default();
        match m {
            DaemonMessage::Reply { rid, ok, result, error } => {
                if self.reqs.remove(&rid).is_some() {
                    s.respuesta = Some(Respuesta { rid, resultado: if ok { Ok(result.unwrap_or(Value::Null)) } else { Err(error.unwrap_or_else(|| "Error del daemon".to_string())) } });
                }
            }
            DaemonMessage::Data { id, chunks } => s.eventos.push(Evento::Data { id, chunks }),
            DaemonMessage::Exit { id, code } => {
                if let Some(r) = self.corriendo.get_mut(&id) {
                    *r = false;
                }
                s.eventos.push(Evento::Exit { id, code });
            }
            DaemonMessage::Hook { event } => {
                self.hooks.insert(event.ws.clone(), event.clone());
                s.eventos.push(Evento::Hook(event));
            }
            DaemonMessage::Permission { req } => {
                match self.permisos.iter_mut().find(|p| p.id == req.id) {
                    Some(p) => *p = req.clone(),
                    None => self.permisos.push(req.clone()),
                }
                s.eventos.push(Evento::Permission(req));
            }
            DaemonMessage::PermissionResolved { id } => {
                self.permisos.retain(|p| p.id != id);
                s.eventos.push(Evento::PermissionResolved(id));
            }
            DaemonMessage::ChallengeOk { .. } | DaemonMessage::HelloOk(_) => {}
        }
        s
    }

    /// Pedidos que vencieron sin respuesta: se dan de baja y quien llama les contesta `ERR_SIN_RESPUESTA`.
    pub fn vencidos(&mut self, ahora_ms: u64) -> Vec<u64> {
        let mut v: Vec<u64> = self.reqs.iter().filter(|(_, vence)| ahora_ms >= **vence).map(|(rid, _)| *rid).collect();
        v.sort_unstable();
        for rid in &v {
            self.reqs.remove(rid);
        }
        v
    }

    fn fallar_todos(&mut self) -> Vec<u64> {
        let mut v: Vec<u64> = self.reqs.keys().copied().collect();
        v.sort_unstable();
        self.reqs.clear();
        v
    }

    /// Se cortó la conexión. Devuelve los pedidos en vuelo (a todos hay que contestarles `ERR_CONEXION_CORTADA`) y si
    /// corresponde reconectar (no si ya se liberó el backend).
    pub fn al_cerrar(&mut self) -> (Vec<u64>, bool) {
        self.conectado = false;
        (self.fallar_todos(), !self.liberado)
    }

    /// Una sola reconexión a la vez.
    pub fn iniciar_reconexion(&mut self) -> bool {
        if self.reconectando || self.liberado {
            return false;
        }
        self.reconectando = true;
        true
    }

    pub fn terminar_reconexion(&mut self) {
        self.reconectando = false;
    }

    /// Suelta la conexión; el daemon y sus terminales siguen vivos.
    pub fn liberar(&mut self) -> Vec<u64> {
        self.liberado = true;
        self.conectado = false;
        self.fallar_todos()
    }

    /// Antes de pedir el apagado: ya no se reconecta cuando se corte el pipe.
    pub fn marcar_apagado(&mut self) {
        self.liberado = true;
    }

    pub fn tras_apagar(&mut self) {
        self.corriendo.clear();
    }

    fn pedir(&mut self, ahora_ms: u64, armar: impl FnOnce(u64) -> ClientMessage) -> Result<(u64, String), ErrorPedido> {
        if !self.conectado {
            return Err(ErrorPedido::SinConexion);
        }
        self.rid += 1;
        let rid = self.rid;
        self.reqs.insert(rid, ahora_ms + REQUEST_TIMEOUT_MS);
        Ok((rid, codificar(&armar(rid))))
    }

    fn mandar(&self, m: &ClientMessage) -> Option<String> {
        self.conectado.then(|| codificar(m))
    }

    pub fn pedir_start(&mut self, ahora_ms: u64, id: &str, spawn: SpawnSpec) -> Result<(u64, String), ErrorPedido> {
        self.pedir(ahora_ms, |rid| ClientMessage::Start { rid, id: id.to_string(), spawn })
    }

    /// Al contestar `start`: anota si quedó corriendo.
    pub fn start_listo(&mut self, id: &str, r: &PtyStartResult) {
        self.corriendo.insert(id.to_string(), r.running);
    }

    pub fn pedir_kill(&mut self, ahora_ms: u64, id: &str) -> Result<(u64, String), ErrorPedido> {
        self.corriendo.remove(id);
        self.hooks.remove(id);
        self.pedir(ahora_ms, |rid| ClientMessage::Kill { rid, id: id.to_string() })
    }

    pub fn pedir_list(&mut self, ahora_ms: u64) -> Result<(u64, String), ErrorPedido> {
        self.pedir(ahora_ms, |rid| ClientMessage::List { rid })
    }

    /// Al contestar `list`: la lista del daemon reemplaza lo que creíamos.
    pub fn list_listo(&mut self, l: &[SessionInfo]) {
        self.corriendo = l.iter().map(|s| (s.id.clone(), s.running)).collect();
    }

    pub fn pedir_shutdown(&mut self, ahora_ms: u64) -> Result<(u64, String), ErrorPedido> {
        self.pedir(ahora_ms, |rid| ClientMessage::Shutdown { rid })
    }

    pub fn escribir(&self, id: &str, data: &str) -> Option<String> {
        self.mandar(&ClientMessage::Write { id: id.to_string(), data: data.to_string() })
    }

    pub fn redimensionar(&self, id: &str, cols: u32, rows: u32) -> Option<String> {
        self.mandar(&ClientMessage::Resize { id: id.to_string(), cols, rows })
    }

    pub fn responder_permiso(&self, req_id: &str, decision: Value) -> Option<String> {
        self.mandar(&ClientMessage::PermissionAnswer { req_id: req_id.to_string(), decision })
    }

    pub fn esta_corriendo(&self, id: &str) -> bool {
        self.corriendo.get(id).copied().unwrap_or(false)
    }

    pub fn permisos_pendientes(&self) -> Vec<PendingPermission> {
        self.permisos.clone()
    }

    pub fn ultimos_hooks(&self) -> BTreeMap<String, HookEventPayload> {
        self.hooks.clone()
    }
}

// ---------- Versión del daemon ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecisionVersion {
    Usar,
    /// Distinta versión pero con terminales vivas: no se las mata, se sigue usando.
    SeguirConVivas,
    Reiniciar,
}

pub fn decidir_version(version_daemon: &str, version_app: &str, sesiones: &[SessionInfo]) -> DecisionVersion {
    if version_daemon == version_app {
        DecisionVersion::Usar
    } else if sesiones.iter().any(|s| s.running) {
        DecisionVersion::SeguirConVivas
    } else {
        DecisionVersion::Reiniciar
    }
}

// ---------- Conectar o lanzar, y reconectar ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lanzado {
    Rust,
    Node,
}

/// Lo que el cliente necesita del mundo real. La cáscara lo implementa con el pipe y `spawn`; los tests, con un simulado.
pub trait Conector {
    type Conn;
    /// Un intento de conectar y saludar.
    fn intentar(&mut self) -> Result<(Self::Conn, HelloOk), ErrorConexion>;
    /// Lanza el daemon (suelto del proceso). Con `solo_node` ignora el de Rust.
    fn lanzar(&mut self, solo_node: bool) -> Result<Lanzado, String>;
    fn dormir(&mut self, ms: u64);
    fn ahora_ms(&mut self) -> u64;
}

enum Espera<C> {
    Listo(C, HelloOk),
    Agotado(String),
    Fatal(ErrorConexion),
}

fn esperar<K: Conector>(k: &mut K) -> Espera<K::Conn> {
    let limite = k.ahora_ms() + CONNECT_TIMEOUT_MS;
    let mut ultimo = String::from("?");
    while k.ahora_ms() < limite {
        k.dormir(ESPERA_ENTRE_INTENTOS_MS);
        match k.intentar() {
            Ok((c, h)) => return Espera::Listo(c, h),
            Err(ErrorConexion::Ausente(m)) => ultimo = m,
            Err(e) => return Espera::Fatal(e),
        }
    }
    Espera::Agotado(format!("El daemon no levantó en {} s ({ultimo}).", CONNECT_TIMEOUT_MS / 1000))
}

/// Conecta y saluda; si no hay daemon (y se permite) lo lanza y reintenta hasta ~5 s. Si el .exe de Rust no arranca
/// (antivirus, falta de permisos) se prueba con el de Node: no podemos dejar al usuario sin terminales persistentes.
pub fn conectar_o_lanzar<K: Conector>(k: &mut K, permitir_lanzar: bool) -> Result<(K::Conn, HelloOk), ErrorConexion> {
    match k.intentar() {
        Ok(r) => return Ok(r),
        Err(e @ ErrorConexion::Ausente(_)) => {
            if !permitir_lanzar {
                return Err(e);
            }
        }
        Err(e) => return Err(e),
    }
    let usado = k.lanzar(false).map_err(ErrorConexion::Otro)?;
    let primero = match esperar(k) {
        Espera::Listo(c, h) => return Ok((c, h)),
        Espera::Fatal(e) => return Err(e),
        Espera::Agotado(m) => m,
    };
    if usado != Lanzado::Rust {
        return Err(ErrorConexion::Otro(primero));
    }
    k.lanzar(true).map_err(ErrorConexion::Otro)?;
    match esperar(k) {
        Espera::Listo(c, h) => Ok((c, h)),
        Espera::Fatal(e) => Err(e),
        Espera::Agotado(m) => Err(ErrorConexion::Otro(m)),
    }
}

/// Reconexión tras un corte. Devuelve la conexión nueva (si hubo) y los eventos para la app: `Reconnect` si se logró,
/// `Disconnect` si no. Los mensajes del daemon relanzado no se pierden: el estado se rehidrata con su `hello-ok`.
pub fn reconectar<K: Conector>(estado: &mut Estado, k: &mut K, log: &mut dyn FnMut(&str)) -> (Option<K::Conn>, Vec<Evento>) {
    if !estado.iniciar_reconexion() {
        return (None, Vec::new());
    }
    log("[daemon] conexión cortada, reintentando");
    let r = conectar_o_lanzar(k, true);
    let salida = match r {
        Ok((conn, hello)) => {
            if estado.liberado {
                (None, Vec::new())
            } else {
                let pid = hello.pid;
                let mut eventos = estado.conectar(hello);
                log(&format!("[daemon] reconectado (pid {pid})"));
                eventos.push(Evento::Reconnect(estado.info()));
                (Some(conn), eventos)
            }
        }
        Err(e) => {
            log(&format!("[daemon] no se pudo reconectar: {e}"));
            (None, vec![Evento::Disconnect])
        }
    };
    estado.terminar_reconexion();
    salida
}

// ---------- Daemon del protocolo 1 ----------

/// Un daemon del protocolo 1 no se sigue usando aunque tenga terminales vivas: ese saludo no autentica al daemon. Acá se le
/// manda el token viejo y, cuando contesta, el pedido de apagado. Sin plazo propio (ver `LEGACY_HELLO_TIMEOUT_MS`).
pub fn apagar_daemon_v1<T: Read + Write>(mut io: T, token: &str) -> Result<(), String> {
    io.write_all(codificar_hello_legado(token, "retiro").as_bytes()).map_err(|e| e.to_string())?;
    let mut lector = LectorLineas::nuevo();
    let mut tmp = vec![0u8; 16 * 1024];
    loop {
        let n = io.read(&mut tmp).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("cortó la conexión".into());
        }
        let ms = lector.alimentar(&tmp[..n]).map_err(|_| "línea demasiado larga".to_string())?;
        if ms.iter().any(|m| matches!(m, DaemonMessage::HelloOk(_))) {
            io.write_all(codificar(&ClientMessage::Shutdown { rid: 1 }).as_bytes()).map_err(|e| e.to_string())?;
            return Ok(());
        }
    }
}

// ---------- Pipe real ----------

#[cfg(windows)]
pub type Pipe = std::fs::File;

#[cfg(windows)]
pub fn conectar_pipe(nombre: &str) -> io::Result<Pipe> {
    std::fs::OpenOptions::new().read(true).write(true).open(nombre)
}

#[cfg(not(windows))]
pub enum Pipe {}

#[cfg(not(windows))]
pub fn conectar_pipe(_nombre: &str) -> io::Result<Pipe> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "el daemon de terminales solo funciona en Windows"))
}

/// Un intento contra el pipe real, con el plazo de saludo de `HELLO_TIMEOUT_MS`. El saludo bloquea leyendo en un hilo aparte:
/// si el daemon no contesta a tiempo, el hilo queda colgado hasta que el pipe se cierre del otro lado.
#[cfg(windows)]
pub fn intentar_pipe(nombre: &str, clave: &str, client_version: &str) -> Result<(Pipe, HelloOk, Vec<DaemonMessage>), ErrorConexion> {
    let pipe = conectar_pipe(nombre)?;
    let lectura = pipe.try_clone()?;
    let (clave, version) = (clave.to_string(), client_version.to_string());
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(saludar(Duplex { lectura, escritura: pipe }, &clave, &version).map(|c| (c.io, c.hello, c.pendientes)));
    });
    match rx.recv_timeout(std::time::Duration::from_millis(HELLO_TIMEOUT_MS)) {
        Ok(Ok((d, hello, pendientes))) => Ok((d.escritura, hello, pendientes)),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(ErrorConexion::SinSaludo),
    }
}

#[cfg(windows)]
struct Duplex {
    lectura: std::fs::File,
    escritura: std::fs::File,
}

#[cfg(windows)]
impl Read for Duplex {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.lectura.read(buf)
    }
}

#[cfg(windows)]
impl Write for Duplex {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.escritura.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.escritura.flush()
    }
}

/// `true` si el pipe ya no existe (nadie lo escucha) dentro del plazo.
pub fn esperar_pipe_cerrado(nombre: &str, ms: u64) -> bool {
    let limite = std::time::Instant::now() + std::time::Duration::from_millis(ms);
    while std::time::Instant::now() < limite {
        if conectar_pipe(nombre).is_err() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    false
}

/// Apaga el daemon del protocolo 1 si quedó uno, usando el token viejo de `daemon-token`. Si no se pudo, el token queda para
/// reintentar en el próximo arranque: sin él nadie podría apagarlo, y con terminales vivas no se apaga solo.
#[cfg(windows)]
pub fn retirar_daemon_v1(user_data_dir: &str, log: &mut dyn FnMut(&str)) {
    let archivo = std::path::Path::new(user_data_dir).join("daemon-token");
    let Ok(contenido) = std::fs::read_to_string(&archivo) else { return };
    let token = contenido.trim();
    if es_clave(token) {
        let pipe = legacy_pipe_name_for(user_data_dir);
        match conectar_pipe(&pipe) {
            Ok(p) => {
                if let Err(e) = apagar_daemon_v1(p, token) {
                    log(&format!("[daemon] no se pudo apagar el daemon del protocolo 1 (se reintenta en el próximo arranque): {e}"));
                    return;
                }
                let apagado = esperar_pipe_cerrado(&pipe, 3000);
                log(if apagado { "[daemon] se apagó el daemon del protocolo 1" } else { "[daemon] se le pidió al daemon del protocolo 1 que se apague; todavía no cerró" });
            }
            Err(e) if matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused) => {}
            Err(e) => {
                log(&format!("[daemon] no se pudo apagar el daemon del protocolo 1 (se reintenta en el próximo arranque): {e}"));
                return;
            }
        }
    }
    if let Err(e) = std::fs::remove_file(&archivo) {
        if e.kind() != io::ErrorKind::NotFound {
            log(&format!("[daemon] no se pudo borrar daemon-token: {e}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon_protocolo::PtyChunk;
    use serde_json::json;
    use std::collections::VecDeque;

    const CLAVE: &str = "abababababababababababababababababababababababababababababababab";
    const OTRA: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";

    fn hello(sesiones: Vec<SessionInfo>) -> HelloOk {
        HelloOk {
            version: "0.8.0".into(),
            pid: 77,
            hook_url: "http://127.0.0.1:1/hook".into(),
            hook_token: "tok".into(),
            sessions: sesiones,
            last_hook_events: BTreeMap::new(),
            permissions: vec![],
            protocol: Some(2),
        }
    }

    fn sesion(id: &str, running: bool) -> SessionInfo {
        SessionInfo { id: id.into(), running, exit_code: None }
    }

    fn permiso(id: &str) -> PendingPermission {
        PendingPermission { id: id.into(), ws: "w".into(), tool: "Bash".into(), input: json!({}), suggestions: None, at: 1, expires_at: 2 }
    }

    fn evento_hook(ws: &str, evento: &str) -> HookEventPayload {
        HookEventPayload { ws: ws.into(), event: evento.into(), tool: None, message: None, notification_type: None, en_segundo_plano: None, aviso_de_tarea: None, en_fondo: None, at: Some(1) }
    }

    // ---- daemon simulado: habla el protocolo igual que native/daemon ----

    struct DaemonFalso {
        clave: String,
        entrada: Vec<u8>,
        salida: VecDeque<u8>,
        lector: LectorLineas,
        nonce_daemon: String,
        nonce_cliente: Option<String>,
        impostor: bool,
        extra_tras_hello: Vec<String>,
        cortar_tras_challenge: bool,
        trozo: usize,
    }

    impl DaemonFalso {
        fn nuevo(clave: &str) -> Self {
            DaemonFalso {
                clave: clave.into(),
                entrada: vec![],
                salida: VecDeque::new(),
                lector: LectorLineas::nuevo(),
                nonce_daemon: "2".repeat(64),
                nonce_cliente: None,
                impostor: false,
                extra_tras_hello: vec![],
                cortar_tras_challenge: false,
                trozo: 7,
            }
        }
        fn responder(&mut self, linea: &str) {
            self.salida.extend(linea.bytes());
            self.salida.push_back(b'\n');
        }
    }

    impl Write for DaemonFalso {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.entrada.extend_from_slice(buf);
            let cruda: Vec<Value> = {
                let mut l = Vec::new();
                for linea in buf.split(|b| *b == b'\n').filter(|l| !l.is_empty()) {
                    l.push(serde_json::from_slice::<Value>(linea).unwrap());
                }
                l
            };
            for v in cruda {
                match v["t"].as_str() {
                    Some("challenge") => {
                        if self.cortar_tras_challenge {
                            continue;
                        }
                        let nc = v["nonce"].as_str().unwrap().to_string();
                        let clave = if self.impostor { OTRA } else { &self.clave };
                        let proof = prueba_daemon(clave, &nc, &self.nonce_daemon);
                        let l = json!({ "t": "challenge-ok", "nonce": self.nonce_daemon, "proof": proof }).to_string();
                        self.nonce_cliente = Some(nc);
                        self.responder(&l);
                    }
                    Some("hello") => {
                        let nc = self.nonce_cliente.clone().unwrap();
                        assert_eq!(v["proof"].as_str().unwrap(), prueba_cliente(&self.clave, &nc, &self.nonce_daemon));
                        assert_eq!(v["clientVersion"], "0.8.0");
                        let ok = serde_json::to_string(&DaemonMessage::HelloOk(hello(vec![sesion("a", true)]))).unwrap();
                        self.responder(&ok);
                        for e in self.extra_tras_hello.clone() {
                            self.responder(&e);
                        }
                    }
                    _ => {}
                }
            }
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Read for DaemonFalso {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let _ = &self.lector;
            let n = buf.len().min(self.trozo).min(self.salida.len());
            for b in buf.iter_mut().take(n) {
                *b = self.salida.pop_front().unwrap();
            }
            Ok(n)
        }
    }

    #[test]
    fn saludo_completo_con_el_daemon_simulado() {
        let c = saludar(DaemonFalso::nuevo(CLAVE), CLAVE, "0.8.0").unwrap();
        assert_eq!((c.hello.version.as_str(), c.hello.pid), ("0.8.0", 77));
        assert_eq!(c.hello.sessions, vec![sesion("a", true)]);
    }

    #[test]
    fn saludo_sin_prueba_valida_del_daemon_es_impostor_y_no_manda_el_hello() {
        let mut d = DaemonFalso::nuevo(CLAVE);
        d.impostor = true;
        let Err(e) = saludar(d, CLAVE, "0.8.0") else { panic!("debía fallar") };
        assert_eq!(e, ErrorConexion::Impostor);
    }

    #[test]
    fn el_hello_no_sale_hasta_verificar_al_daemon() {
        let mut h = Handshake::con_nonce(CLAVE, "0.8.0", "1".repeat(64));
        assert_eq!(h.iniciar(), format!("{{\"t\":\"challenge\",\"nonce\":\"{}\"}}\n", "1".repeat(64)));
        assert_eq!(h.recibir(DaemonMessage::HelloOk(hello(vec![]))).unwrap(), PasoSaludo::Nada);
        let mala = DaemonMessage::ChallengeOk { nonce: "2".repeat(64), proof: "0".repeat(64) };
        assert_eq!(h.recibir(mala), Err(ErrorConexion::Impostor));
    }

    #[test]
    fn nonce_del_daemon_con_formato_invalido_es_impostor() {
        let mut h = Handshake::con_nonce(CLAVE, "v", "1".repeat(64));
        let nonce = "ZZ".to_string();
        let proof = prueba_daemon(CLAVE, &"1".repeat(64), &nonce);
        assert_eq!(h.recibir(DaemonMessage::ChallengeOk { nonce, proof }), Err(ErrorConexion::Impostor));
    }

    #[test]
    fn handshake_con_la_prueba_real_de_node() {
        let mut h = Handshake::con_nonce(CLAVE, "0.8.0", "1".repeat(64));
        let ok = DaemonMessage::ChallengeOk { nonce: "2".repeat(64), proof: "707e30442dd66eb0e8f7fb9d036ebe5d0cde1a0d399c8b9735b7bc97ef61817f".into() };
        let PasoSaludo::Enviar(l) = h.recibir(ok).unwrap() else { panic!("debía mandar el hello") };
        assert_eq!(l, "{\"t\":\"hello\",\"proof\":\"85182ffa6e79a2905d0cbbeefe3e79bf46bc37f67c8fdaab5e7038607e9b5e9d\",\"clientVersion\":\"0.8.0\"}\n");
    }

    #[test]
    fn mensajes_pegados_al_hello_ok_quedan_pendientes() {
        let mut d = DaemonFalso::nuevo(CLAVE);
        d.extra_tras_hello = vec![r#"{"t":"exit","id":"a","code":0}"#.into()];
        d.trozo = 4096;
        let c = saludar(d, CLAVE, "0.8.0").unwrap();
        assert_eq!(c.pendientes, vec![DaemonMessage::Exit { id: "a".into(), code: 0 }]);
    }

    #[test]
    fn si_el_daemon_corta_en_el_saludo_se_informa_el_rechazo() {
        let mut d = DaemonFalso::nuevo(CLAVE);
        d.cortar_tras_challenge = true;
        let Err(e) = saludar(d, CLAVE, "0.8.0") else { panic!("debía fallar") };
        assert_eq!(e, ErrorConexion::Rechazada);
        assert_eq!(e.to_string(), "El daemon rechazó la conexión (¿clave distinta?).");
    }

    #[test]
    fn siguiente_entrega_pendientes_y_luego_lee_del_transporte() {
        let mut d = DaemonFalso::nuevo(CLAVE);
        d.extra_tras_hello = vec![r#"{"t":"exit","id":"a","code":0}"#.into()];
        let mut c = saludar(d, CLAVE, "0.8.0").unwrap();
        assert_eq!(c.siguiente().unwrap(), Some(vec![DaemonMessage::Exit { id: "a".into(), code: 0 }]));
        c.io.responder(r#"{"t":"data","id":"a","chunks":[{"seq":1,"data":"hola"}]}"#);
        assert_eq!(c.siguiente().unwrap(), Some(vec![DaemonMessage::Data { id: "a".into(), chunks: vec![PtyChunk { seq: 1, data: "hola".into() }] }]));
        assert_eq!(c.siguiente().unwrap(), None);
    }

    // ---- estado ----

    fn estado_conectado(sesiones: Vec<SessionInfo>) -> Estado {
        let mut e = Estado::nuevo();
        e.conectar(hello(sesiones));
        e
    }

    #[test]
    fn conectar_toma_el_saludo() {
        let e = estado_conectado(vec![sesion("a", true), sesion("b", false)]);
        assert!(e.conectado());
        assert_eq!((e.hook_url(), e.hook_token()), ("http://127.0.0.1:1/hook", "tok"));
        assert_eq!(e.info(), InfoBackend { pid: Some(77), version: Some("0.8.0".into()) });
        assert!(e.esta_corriendo("a"));
        assert!(!e.esta_corriendo("b"));
        assert!(!e.esta_corriendo("zzz"));
    }

    #[test]
    fn sin_conexion_los_pedidos_fallan_y_lo_demas_se_descarta() {
        let mut e = Estado::nuevo();
        assert_eq!(e.pedir_list(0), Err(ErrorPedido::SinConexion));
        assert_eq!(ErrorPedido::SinConexion.to_string(), "Sin conexión con el daemon.");
        assert_eq!(e.escribir("a", "x"), None);
        assert_eq!(e.redimensionar("a", 1, 1), None);
        assert_eq!(e.responder_permiso("r", Value::Null), None);
        assert!(e.reqs.is_empty());
    }

    #[test]
    fn los_rid_son_correlativos_y_la_respuesta_se_corresponde() {
        let mut e = estado_conectado(vec![]);
        let (r1, l1) = e.pedir_list(0).unwrap();
        let (r2, _) = e.pedir_shutdown(0).unwrap();
        assert_eq!((r1, r2), (1, 2));
        assert_eq!(l1, "{\"t\":\"list\",\"rid\":1}\n");
        let s = e.al_mensaje(DaemonMessage::Reply { rid: 2, ok: true, result: None, error: None });
        assert_eq!(s.respuesta, Some(Respuesta { rid: 2, resultado: Ok(Value::Null) }));
        let s = e.al_mensaje(DaemonMessage::Reply { rid: 1, ok: false, result: None, error: None });
        assert_eq!(s.respuesta, Some(Respuesta { rid: 1, resultado: Err("Error del daemon".into()) }));
    }

    #[test]
    fn respuesta_de_un_pedido_desconocido_o_ya_contestado_se_ignora() {
        let mut e = estado_conectado(vec![]);
        let (rid, _) = e.pedir_list(0).unwrap();
        assert_eq!(e.al_mensaje(DaemonMessage::Reply { rid: 99, ok: true, result: None, error: None }), Salida::default());
        assert!(e.al_mensaje(DaemonMessage::Reply { rid, ok: true, result: Some(json!([])), error: None }).respuesta.is_some());
        assert_eq!(e.al_mensaje(DaemonMessage::Reply { rid, ok: true, result: None, error: None }), Salida::default());
    }

    #[test]
    fn pedidos_vencen_a_los_15_segundos() {
        let mut e = estado_conectado(vec![]);
        let (a, _) = e.pedir_list(1_000).unwrap();
        let (b, _) = e.pedir_list(10_000).unwrap();
        assert!(e.vencidos(15_999).is_empty());
        assert_eq!(e.vencidos(16_000), vec![a]);
        assert_eq!(e.vencidos(25_000), vec![b]);
        assert!(e.al_mensaje(DaemonMessage::Reply { rid: a, ok: true, result: None, error: None }).respuesta.is_none());
    }

    #[test]
    fn start_y_list_actualizan_lo_que_corre() {
        let mut e = estado_conectado(vec![]);
        let spawn = SpawnSpec { file: "pwsh.exe".into(), args: vec![], cwd: "C:\\".into(), env: BTreeMap::new(), cols: 80, rows: 24 };
        let (rid, linea) = e.pedir_start(0, "p1", spawn).unwrap();
        assert!(linea.starts_with(&format!("{{\"t\":\"start\",\"rid\":{rid},\"id\":\"p1\"")));
        e.start_listo("p1", &PtyStartResult { chunks: vec![], up_to: 0, running: true });
        assert!(e.esta_corriendo("p1"));
        e.list_listo(&[sesion("p2", true)]);
        assert!(!e.esta_corriendo("p1"));
        assert!(e.esta_corriendo("p2"));
    }

    #[test]
    fn exit_marca_la_sesion_como_terminada_y_avisa() {
        let mut e = estado_conectado(vec![sesion("a", true)]);
        let s = e.al_mensaje(DaemonMessage::Exit { id: "a".into(), code: 3 });
        assert_eq!(s.eventos, vec![Evento::Exit { id: "a".into(), code: 3 }]);
        assert!(!e.esta_corriendo("a"));
        let s = e.al_mensaje(DaemonMessage::Exit { id: "otra".into(), code: 0 });
        assert_eq!(s.eventos.len(), 1);
        assert!(!e.esta_corriendo("otra"));
    }

    #[test]
    fn kill_olvida_la_sesion_y_su_ultimo_hook() {
        let mut e = estado_conectado(vec![sesion("a", true)]);
        e.al_mensaje(DaemonMessage::Hook { event: evento_hook("a", "Stop") });
        assert!(e.ultimos_hooks().contains_key("a"));
        let (_, linea) = e.pedir_kill(0, "a").unwrap();
        assert_eq!(linea.trim_end(), "{\"t\":\"kill\",\"rid\":1,\"id\":\"a\"}");
        assert!(!e.esta_corriendo("a"));
        assert!(e.ultimos_hooks().is_empty());
    }

    #[test]
    fn hooks_guardan_el_ultimo_por_espacio() {
        let mut e = estado_conectado(vec![]);
        e.al_mensaje(DaemonMessage::Hook { event: evento_hook("w", "PreToolUse") });
        let s = e.al_mensaje(DaemonMessage::Hook { event: evento_hook("w", "Stop") });
        assert_eq!(s.eventos, vec![Evento::Hook(evento_hook("w", "Stop"))]);
        assert_eq!(e.ultimos_hooks()["w"].event, "Stop");
    }

    #[test]
    fn permisos_se_agregan_se_reemplazan_y_se_resuelven() {
        let mut e = estado_conectado(vec![]);
        e.al_mensaje(DaemonMessage::Permission { req: permiso("a") });
        e.al_mensaje(DaemonMessage::Permission { req: permiso("b") });
        let mut a2 = permiso("a");
        a2.tool = "Edit".into();
        e.al_mensaje(DaemonMessage::Permission { req: a2 });
        let p = e.permisos_pendientes();
        assert_eq!(p.iter().map(|p| (p.id.as_str(), p.tool.as_str())).collect::<Vec<_>>(), vec![("a", "Edit"), ("b", "Bash")]);
        let s = e.al_mensaje(DaemonMessage::PermissionResolved { id: "a".into() });
        assert_eq!(s.eventos, vec![Evento::PermissionResolved("a".into())]);
        assert_eq!(e.permisos_pendientes().len(), 1);
    }

    #[test]
    fn responder_permiso_manda_la_decision() {
        let e = estado_conectado(vec![]);
        let l = e.responder_permiso("r1", json!({ "behavior": "deny" })).unwrap();
        assert_eq!(l, "{\"t\":\"permission-answer\",\"reqId\":\"r1\",\"decision\":{\"behavior\":\"deny\"}}\n");
    }

    #[test]
    fn data_se_reenvia_tal_cual() {
        let mut e = estado_conectado(vec![]);
        let chunks = vec![PtyChunk { seq: 4, data: "x".into() }];
        let s = e.al_mensaje(DaemonMessage::Data { id: "a".into(), chunks: chunks.clone() });
        assert_eq!(s.eventos, vec![Evento::Data { id: "a".into(), chunks }]);
    }

    #[test]
    fn reconectar_avisa_sesiones_perdidas_y_permisos_resueltos() {
        let mut e = Estado::nuevo();
        let mut h = hello(vec![sesion("viva", true), sesion("perdida", true), sesion("muerta", false)]);
        h.permissions = vec![permiso("p1"), permiso("p2")];
        e.conectar(h);
        let mut h2 = hello(vec![sesion("viva", true)]);
        h2.permissions = vec![permiso("p2")];
        let ev = e.conectar(h2);
        assert_eq!(ev, vec![Evento::PermissionResolved("p1".into()), Evento::Exit { id: "perdida".into(), code: -1 }]);
        assert!(e.esta_corriendo("viva"));
    }

    #[test]
    fn al_cerrar_falla_lo_pendiente_y_pide_reconectar_salvo_que_se_haya_liberado() {
        let mut e = estado_conectado(vec![]);
        e.pedir_list(0).unwrap();
        e.pedir_list(0).unwrap();
        assert_eq!(e.al_cerrar(), (vec![1, 2], true));
        assert!(!e.conectado());
        let mut e = estado_conectado(vec![]);
        e.pedir_list(0).unwrap();
        assert_eq!(e.liberar(), vec![1]);
        assert_eq!(e.al_cerrar(), (vec![], false));
        assert!(!e.iniciar_reconexion());
    }

    #[test]
    fn solo_una_reconexion_a_la_vez() {
        let mut e = estado_conectado(vec![]);
        assert!(e.iniciar_reconexion());
        assert!(!e.iniciar_reconexion());
        e.terminar_reconexion();
        assert!(e.iniciar_reconexion());
    }

    #[test]
    fn marcar_apagado_evita_reconectar_y_tras_apagar_olvida_las_sesiones() {
        let mut e = estado_conectado(vec![sesion("a", true)]);
        e.marcar_apagado();
        assert_eq!(e.al_cerrar().1, false);
        e.tras_apagar();
        assert!(!e.esta_corriendo("a"));
    }

    #[test]
    fn version_distinta() {
        let viva = [sesion("a", true)];
        let muerta = [sesion("a", false)];
        assert_eq!(decidir_version("0.8.0", "0.8.0", &viva), DecisionVersion::Usar);
        assert_eq!(decidir_version("0.7.0", "0.8.0", &viva), DecisionVersion::SeguirConVivas);
        assert_eq!(decidir_version("0.7.0", "0.8.0", &muerta), DecisionVersion::Reiniciar);
        assert_eq!(decidir_version("0.7.0", "0.8.0", &[]), DecisionVersion::Reiniciar);
    }

    // ---- conectar o lanzar ----

    struct Falso {
        intentos: VecDeque<Result<(), ErrorConexion>>,
        lanzados: Vec<bool>,
        usado: Lanzado,
        lanzar_falla: bool,
        reloj: u64,
        intentos_hechos: usize,
        dormido: u64,
    }

    impl Falso {
        fn nuevo(intentos: Vec<Result<(), ErrorConexion>>) -> Self {
            Falso { intentos: intentos.into(), lanzados: vec![], usado: Lanzado::Rust, lanzar_falla: false, reloj: 0, intentos_hechos: 0, dormido: 0 }
        }
    }

    impl Conector for Falso {
        type Conn = u32;
        fn intentar(&mut self) -> Result<(u32, HelloOk), ErrorConexion> {
            self.intentos_hechos += 1;
            let r = self.intentos.pop_front().unwrap_or_else(|| Err(ErrorConexion::Ausente("no existe".into())));
            r.map(|_| (self.intentos_hechos as u32, hello(vec![])))
        }
        fn lanzar(&mut self, solo_node: bool) -> Result<Lanzado, String> {
            self.lanzados.push(solo_node);
            if self.lanzar_falla {
                return Err("no se encontró node".into());
            }
            Ok(if solo_node { Lanzado::Node } else { self.usado })
        }
        fn dormir(&mut self, ms: u64) {
            self.dormido += ms;
            self.reloj += ms;
        }
        fn ahora_ms(&mut self) -> u64 {
            self.reloj
        }
    }

    fn ausente() -> Result<(), ErrorConexion> {
        Err(ErrorConexion::Ausente("no existe".into()))
    }

    #[test]
    fn si_ya_hay_daemon_no_se_lanza_nada() {
        let mut k = Falso::nuevo(vec![Ok(())]);
        assert!(conectar_o_lanzar(&mut k, true).is_ok());
        assert!(k.lanzados.is_empty());
    }

    #[test]
    fn sin_daemon_y_sin_permiso_de_lanzar_falla() {
        let mut k = Falso::nuevo(vec![ausente()]);
        assert!(matches!(conectar_o_lanzar(&mut k, false), Err(ErrorConexion::Ausente(_))));
        assert!(k.lanzados.is_empty());
    }

    #[test]
    fn otro_error_al_primer_intento_no_lanza() {
        let mut k = Falso::nuevo(vec![Err(ErrorConexion::Impostor)]);
        assert_eq!(conectar_o_lanzar(&mut k, true).err(), Some(ErrorConexion::Impostor));
        assert!(k.lanzados.is_empty());
    }

    #[test]
    fn sin_daemon_lo_lanza_y_reintenta_cada_150_ms() {
        let mut k = Falso::nuevo(vec![ausente(), ausente(), ausente(), Ok(())]);
        assert!(conectar_o_lanzar(&mut k, true).is_ok());
        assert_eq!(k.lanzados, vec![false]);
        assert_eq!(k.dormido, 450);
    }

    #[test]
    fn si_el_exe_de_rust_no_levanta_prueba_con_node() {
        let mut intentos: Vec<Result<(), ErrorConexion>> = (0..40).map(|_| ausente()).collect();
        intentos.push(Ok(()));
        let mut k = Falso::nuevo(intentos);
        assert!(conectar_o_lanzar(&mut k, true).is_ok());
        assert_eq!(k.lanzados, vec![false, true]);
    }

    #[test]
    fn si_node_tampoco_levanta_informa_el_plazo() {
        let mut k = Falso::nuevo(vec![]);
        k.usado = Lanzado::Node;
        let Err(e) = conectar_o_lanzar(&mut k, true) else { panic!("debía fallar") };
        assert_eq!(e.to_string(), "El daemon no levantó en 5 s (no existe).");
        assert_eq!(k.lanzados, vec![false]);
    }

    #[test]
    fn si_levanta_pero_con_otro_error_no_se_cae_a_node() {
        let mut intentos = vec![ausente(), ausente()];
        intentos.push(Err(ErrorConexion::Impostor));
        let mut k = Falso::nuevo(intentos);
        assert_eq!(conectar_o_lanzar(&mut k, true).err(), Some(ErrorConexion::Impostor));
        assert_eq!(k.lanzados, vec![false]);
    }

    #[test]
    fn si_no_se_puede_lanzar_es_error() {
        let mut k = Falso::nuevo(vec![ausente()]);
        k.lanzar_falla = true;
        assert_eq!(conectar_o_lanzar(&mut k, true).err(), Some(ErrorConexion::Otro("no se encontró node".into())));
    }

    #[test]
    fn reconectar_rehidrata_y_avisa() {
        let mut e = estado_conectado(vec![sesion("a", true)]);
        e.al_cerrar();
        let mut k = Falso::nuevo(vec![Ok(())]);
        let mut logs: Vec<String> = vec![];
        let (conn, ev) = reconectar(&mut e, &mut k, &mut |m| logs.push(m.to_string()));
        assert!(conn.is_some());
        assert_eq!(ev, vec![Evento::Exit { id: "a".into(), code: -1 }, Evento::Reconnect(InfoBackend { pid: Some(77), version: Some("0.8.0".into()) })]);
        assert!(e.conectado());
        assert_eq!(logs, vec!["[daemon] conexión cortada, reintentando", "[daemon] reconectado (pid 77)"]);
        assert!(e.iniciar_reconexion());
    }

    #[test]
    fn reconectar_que_falla_avisa_disconnect() {
        let mut e = estado_conectado(vec![]);
        e.al_cerrar();
        let mut k = Falso::nuevo(vec![Err(ErrorConexion::Impostor)]);
        let mut logs: Vec<String> = vec![];
        let (conn, ev) = reconectar(&mut e, &mut k, &mut |m| logs.push(m.to_string()));
        assert!(conn.is_none());
        assert_eq!(ev, vec![Evento::Disconnect]);
        assert_eq!(logs[1], "[daemon] no se pudo reconectar: El pipe del daemon lo tiene otro proceso que no es Sloth.");
        assert!(e.iniciar_reconexion());
    }

    #[test]
    fn reconectar_liberado_no_hace_nada() {
        let mut e = estado_conectado(vec![]);
        e.liberar();
        let mut k = Falso::nuevo(vec![Ok(())]);
        let (conn, ev) = reconectar(&mut e, &mut k, &mut |_| {});
        assert!(conn.is_none() && ev.is_empty());
        assert_eq!(k.intentos_hechos, 0);
    }

    // ---- protocolo 1 ----

    #[test]
    fn apagar_v1_manda_hello_con_token_y_luego_shutdown() {
        struct V1 {
            entrada: Vec<u8>,
            salida: VecDeque<u8>,
        }
        impl Write for V1 {
            fn write(&mut self, b: &[u8]) -> io::Result<usize> {
                self.entrada.extend_from_slice(b);
                if self.entrada.ends_with(b"\"retiro\"}\n") {
                    self.salida.extend(br#"{"t":"hello-ok","version":"0.6.0","pid":1,"hookUrl":"u","hookToken":"t","sessions":[],"lastHookEvents":{},"permissions":[]}"#.iter().chain(b"\n"));
                }
                Ok(b.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        impl Read for V1 {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                let n = buf.len().min(self.salida.len());
                for b in buf.iter_mut().take(n) {
                    *b = self.salida.pop_front().unwrap();
                }
                Ok(n)
            }
        }
        let mut v1 = V1 { entrada: vec![], salida: VecDeque::new() };
        apagar_daemon_v1(&mut v1, "tk").unwrap();
        let texto = String::from_utf8(v1.entrada).unwrap();
        assert_eq!(texto, "{\"t\":\"hello\",\"token\":\"tk\",\"clientVersion\":\"retiro\"}\n{\"t\":\"shutdown\",\"rid\":1}\n");
    }

    #[test]
    fn apagar_v1_informa_si_el_daemon_corta() {
        struct Corta;
        impl Write for Corta {
            fn write(&mut self, b: &[u8]) -> io::Result<usize> {
                Ok(b.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        impl Read for Corta {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Ok(0)
            }
        }
        assert_eq!(apagar_daemon_v1(Corta, "tk"), Err("cortó la conexión".to_string()));
    }

    #[test]
    fn errores_de_io_se_clasifican_como_en_node() {
        assert!(matches!(ErrorConexion::from(io::Error::from(io::ErrorKind::NotFound)), ErrorConexion::Ausente(_)));
        assert!(matches!(ErrorConexion::from(io::Error::from(io::ErrorKind::ConnectionRefused)), ErrorConexion::Ausente(_)));
        assert!(matches!(ErrorConexion::from(io::Error::from(io::ErrorKind::PermissionDenied)), ErrorConexion::Otro(_)));
    }

    #[test]
    fn la_clave_se_valida_antes_de_usarla_para_apagar_el_viejo() {
        assert!(es_clave(CLAVE));
        assert!(!es_clave("corta"));
    }
}
