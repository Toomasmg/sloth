//! Sesiones PTY con su buffer, pedidos de permiso y últimos eventos de hooks.
//! Equivale a TerminalCore de src/daemon/core.ts; el servidor de hooks vive en http.rs.
use crate::buffer::{Buffer, Chunk};
use crate::log::Log;
use crate::utf8::Utf8Stream;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, oneshot, watch};

/// Ventana de agrupado de salida hacia los clientes.
pub const FLUSH_MS: u64 = 16;
pub const PERMISSION_TIMEOUT_MS: u64 = 120_000;
pub const HOOK_EVENTS: [&str; 6] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "Notification", "Stop", "SessionEnd"];
/// Tras la salida del proceso se espera esto a que la lectura termine de vaciar la salida.
const DRAIN_MS: u64 = 1500;

pub struct CloseLimits {
    pub per_pty: Duration,
    pub total: Duration,
}

/// Main espera 5 s el apagado (pedido, cierre y que se vaya el pipe): las terminales tienen menos.
pub const SHUTDOWN_LIMITS: CloseLimits = CloseLimits { per_pty: Duration::from_millis(1500), total: Duration::from_millis(3500) };

pub enum Event {
    Data { id: String, chunks: Vec<Chunk> },
    Exit { id: String, code: i64 },
    Hook(Value),
    Permission(Value),
    PermissionResolved(String),
    SessionsChanged,
}

pub enum Perm {
    BadRequest,
    /// No hay UI que pueda contestar: Claude pregunta en la terminal.
    Null,
    Wait(String, oneshot::Receiver<Option<Value>>),
}

type Master = Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>;

struct Session {
    gen: u64,
    /// None cuando el proceso ya salió: así el hilo escritor termina.
    writer: Option<std_mpsc::Sender<Vec<u8>>>,
    master: Master,
    killer: Box<dyn ChildKiller + Send + Sync>,
    buf: Buffer,
    running: bool,
    exit_code: Option<i64>,
    out: Vec<Chunk>,
    exited: watch::Receiver<bool>,
}

struct Waiting {
    req: Value,
    tx: oneshot::Sender<Option<Value>>,
}

#[derive(Default)]
struct Inner {
    sessions: HashMap<String, Session>,
    waiting: HashMap<String, Waiting>,
    last_hooks: HashMap<String, Value>,
    closing: bool,
    flush_scheduled: bool,
    next_gen: u64,
}

pub struct Core {
    inner: Mutex<Inner>,
    tx: mpsc::UnboundedSender<Event>,
    /// Clientes autenticados: sin ninguno la salida solo se guarda en el buffer.
    pub authed: Arc<AtomicUsize>,
    pub hook_token: String,
    hook_url: Mutex<String>,
    log: Arc<Log>,
    handle: tokio::runtime::Handle,
}

fn ahora_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn chunks_json(c: &[Chunk]) -> Value {
    Value::Array(c.iter().map(|c| json!({ "seq": c.seq, "data": c.data })).collect())
}

fn uuid() -> String {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).expect("sin fuente de azar del sistema");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex::encode(b);
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/// Arma el evento de un POST /hook; None si no es un evento que conozcamos.
pub fn evento_de_hook(body: &Value, at: u64) -> Option<Value> {
    let o = body.as_object()?;
    let ws = o.get("ws")?.as_str()?;
    let event = o.get("event")?.as_str().filter(|e| HOOK_EVENTS.contains(e))?;
    let mut ev = Map::new();
    ev.insert("ws".into(), ws.into());
    ev.insert("event".into(), event.into());
    for k in ["tool", "message", "notificationType"] {
        if let Some(s) = o.get(k).and_then(Value::as_str) {
            ev.insert(k.into(), s.into());
        }
    }
    for k in ["enSegundoPlano", "avisoDeTarea"] {
        if o.get(k) == Some(&Value::Bool(true)) {
            ev.insert(k.into(), true.into());
        }
    }
    ev.insert("at".into(), at.into());
    Some(Value::Object(ev))
}

impl Core {
    pub fn new(tx: mpsc::UnboundedSender<Event>, log: Arc<Log>, handle: tokio::runtime::Handle) -> Arc<Self> {
        let mut t = [0u8; 24];
        getrandom::getrandom(&mut t).expect("sin fuente de azar del sistema");
        Arc::new(Core {
            inner: Mutex::new(Inner::default()),
            tx,
            authed: Arc::new(AtomicUsize::new(0)),
            hook_token: hex::encode(t),
            hook_url: Mutex::new(String::new()),
            log,
            handle,
        })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn emit(&self, e: Event) {
        let _ = self.tx.send(e);
    }

    fn streaming(&self) -> bool {
        self.authed.load(Ordering::Relaxed) > 0
    }

    pub fn set_hook_url(&self, url: String) {
        *self.hook_url.lock().unwrap_or_else(|e| e.into_inner()) = url;
    }

    pub fn hook_url(&self) -> String {
        self.hook_url.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn running_count(&self) -> usize {
        self.lock().sessions.values().filter(|s| s.running).count()
    }

    pub fn list(&self) -> Value {
        let g = self.lock();
        Value::Array(
            g.sessions
                .iter()
                .map(|(id, s)| {
                    if s.running {
                        json!({ "id": id, "running": true })
                    } else {
                        json!({ "id": id, "running": false, "exitCode": s.exit_code })
                    }
                })
                .collect(),
        )
    }

    fn snapshot(s: &Session) -> Value {
        json!({ "chunks": chunks_json(&s.buf.snapshot()), "upTo": s.buf.seq, "running": s.running })
    }

    /// Si la sesión corre devuelve su buffer sin respawnear; si terminó o no existe, la arranca.
    pub fn start(self: &Arc<Self>, id: &str, spec: &Value) -> Result<Value, String> {
        let mut g = self.lock();
        if g.closing {
            return Err("Sloth se está cerrando.".into());
        }
        if let Some(prev) = g.sessions.get(id) {
            if prev.running {
                return Ok(Self::snapshot(prev));
            }
        }
        let file = spec.get("file").and_then(Value::as_str).filter(|f| !f.is_empty()).ok_or("spawn.file inválido")?;
        let cols = spec.get("cols").and_then(Value::as_f64).unwrap_or(0.0).max(20.0) as u16;
        let rows = spec.get("rows").and_then(Value::as_f64).unwrap_or(0.0).max(5.0) as u16;
        let mut cmd = CommandBuilder::new(file);
        if let Some(args) = spec.get("args").and_then(Value::as_array) {
            for a in args {
                cmd.arg(a.as_str().map(str::to_owned).unwrap_or_else(|| a.to_string()));
            }
        }
        if let Some(cwd) = spec.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()) {
            // portable-pty cae en silencio al directorio del usuario si no existe: acá es un error, como en node-pty.
            if !std::path::Path::new(cwd).is_dir() {
                return Err(format!("El directorio de trabajo no existe: {cwd}"));
            }
            cmd.cwd(cwd);
        }
        cmd.env_clear();
        let mut hay_term = false;
        if let Some(env) = spec.get("env").and_then(Value::as_object) {
            for (k, v) in env {
                if let Some(v) = v.as_str() {
                    hay_term |= k.eq_ignore_ascii_case("TERM");
                    cmd.env(k, v);
                }
            }
        }
        if !hay_term {
            cmd.env("TERM", "xterm-256color");
        }
        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let killer = child.clone_killer();
        let pid = child.process_id().unwrap_or(0);
        let master: Master = Arc::new(Mutex::new(Some(pair.master)));
        let gen = g.next_gen;
        g.next_gen += 1;
        let (wtx, wrx) = std_mpsc::channel::<Vec<u8>>();
        let (exit_tx, exit_rx) = watch::channel(false);
        let (done_tx, done_rx) = std_mpsc::channel::<()>();

        std::thread::spawn(move || {
            while let Ok(bytes) = wrx.recv() {
                if writer.write_all(&bytes).and_then(|_| writer.flush()).is_err() {
                    break;
                }
            }
        });

        let (core, sid, wtx_lector) = (self.clone(), id.to_string(), wtx.clone());
        std::thread::spawn(move || {
            // ConPTY (de portable-pty) arranca pidiendo la posición del cursor y no sigue hasta recibirla.
            // La contestamos acá, una vez, y la consulta no entra al buffer: si no, cada vez que un cliente
            // reponga el buffer, xterm la contestaría de nuevo dentro del programa que corre.
            let mut cursor_pendiente = true;
            let mut dec = Utf8Stream::default();
            let mut b = [0u8; 16 * 1024];
            loop {
                match reader.read(&mut b) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut s = dec.push(&b[..n]);
                        if cursor_pendiente {
                            if let Some(i) = s.find("[6n") {
                                s.replace_range(i..i + 4, "");
                                cursor_pendiente = false;
                                let _ = wtx_lector.send(b"[1;1R".to_vec());
                            }
                        }
                        if !s.is_empty() {
                            core.on_data(&sid, gen, s);
                        }
                    }
                }
            }
            let resto = dec.terminar();
            if !resto.is_empty() {
                core.on_data(&sid, gen, resto);
            }
            let _ = done_tx.send(());
        });

        let (core, sid, m) = (self.clone(), id.to_string(), master.clone());
        std::thread::spawn(move || {
            let code = child.wait().map(|s| i64::from(s.exit_code())).unwrap_or(-1);
            // Cerrar la consola pseudo hace que la lectura vea el final y mata lo que haya quedado adentro.
            // En dos pasos: el candado no puede seguir tomado mientras se cierra la consola pseudo.
            let consola = m.lock().unwrap_or_else(|e| e.into_inner()).take();
            drop(consola);
            let _ = done_rx.recv_timeout(Duration::from_millis(DRAIN_MS));
            let _ = exit_tx.send(true);
            core.on_exit(&sid, gen, code);
        });

        let seq = g.sessions.get(id).map(|p| p.buf.seq).unwrap_or(0);
        let s = Session {
            gen,
            writer: Some(wtx),
            master,
            killer,
            buf: Buffer::new(seq),
            running: true,
            exit_code: None,
            out: Vec::new(),
            exited: exit_rx,
        };
        let snap = Self::snapshot(&s);
        g.sessions.insert(id.to_string(), s);
        drop(g);
        self.log.write(&format!("start {id} pid={pid}"));
        self.emit(Event::SessionsChanged);
        Ok(snap)
    }

    fn on_data(self: &Arc<Self>, id: &str, gen: u64, data: String) {
        let mut g = self.lock();
        let streaming = self.streaming();
        let Some(s) = g.sessions.get_mut(id).filter(|s| s.gen == gen) else { return };
        let chunk = s.buf.push(data);
        if !streaming {
            return;
        }
        s.out.push(chunk);
        if !g.flush_scheduled {
            g.flush_scheduled = true;
            let core = self.clone();
            self.handle.spawn(async move {
                tokio::time::sleep(Duration::from_millis(FLUSH_MS)).await;
                core.flush();
            });
        }
    }

    fn flush_session(&self, id: &str, s: &mut Session) {
        if s.out.is_empty() {
            return;
        }
        let out = std::mem::take(&mut s.out);
        if self.streaming() {
            self.emit(Event::Data { id: id.to_string(), chunks: out });
        }
    }

    fn flush(&self) {
        let mut g = self.lock();
        g.flush_scheduled = false;
        for (id, s) in g.sessions.iter_mut() {
            self.flush_session(id, s);
        }
    }

    fn on_exit(&self, id: &str, gen: u64, code: i64) {
        {
            let mut g = self.lock();
            match g.sessions.get_mut(id) {
                Some(s) if s.gen == gen => {
                    s.running = false;
                    s.exit_code = Some(code);
                    s.writer = None;
                    self.flush_session(id, s);
                    self.emit(Event::Exit { id: id.to_string(), code });
                }
                // Reemplazada por otra sesión: no confundimos al cliente.
                Some(_) => {}
                // Borrada (kill): el cliente igual se entera de que terminó.
                None => self.emit(Event::Exit { id: id.to_string(), code }),
            }
        }
        self.log.write(&format!("exit {id} code={code}"));
        self.emit(Event::SessionsChanged);
    }

    pub fn write(&self, id: &str, data: &str) {
        let g = self.lock();
        if let Some(s) = g.sessions.get(id).filter(|s| s.running && !g.closing) {
            if let Some(w) = &s.writer {
                let _ = w.send(data.as_bytes().to_vec());
            }
        }
    }

    pub fn resize(&self, id: &str, cols: f64, rows: f64) {
        let master = {
            let g = self.lock();
            match g.sessions.get(id) {
                Some(s) if s.running && !g.closing && cols > 0.0 && rows > 0.0 => s.master.clone(),
                _ => return,
            }
        };
        let m = master.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(m) = m.as_ref() {
            let _ = m.resize(PtySize { rows: rows.floor() as u16, cols: cols.floor() as u16, pixel_width: 0, pixel_height: 0 });
        }
    }

    pub fn kill(&self, id: &str) {
        {
            let mut g = self.lock();
            if let Some(mut s) = g.sessions.remove(id) {
                if s.running {
                    let _ = s.killer.kill();
                }
            }
            g.last_hooks.remove(id);
        }
        self.emit(Event::SessionsChanged);
    }

    /// Apagado: cierra todas de a una esperando la salida de cada una, sin volver a matar las que ya salieron.
    pub async fn close_all(&self, lim: CloseLimits) {
        let ids: Vec<String> = {
            let mut g = self.lock();
            g.closing = true;
            g.sessions.keys().cloned().collect()
        };
        let deadline = Instant::now() + lim.total;
        let mut timed_out = 0;
        for id in ids {
            let left = deadline.saturating_duration_since(Instant::now());
            let rx = {
                let mut g = self.lock();
                match g.sessions.get_mut(&id) {
                    Some(s) if s.running => {
                        if left.is_zero() {
                            timed_out += 1;
                            continue;
                        }
                        let _ = s.killer.kill();
                        s.exited.clone()
                    }
                    _ => continue,
                }
            };
            let mut rx = rx;
            let espera = lim.per_pty.min(left);
            let salio = async {
                let _ = rx.wait_for(|v| *v).await;
            };
            if tokio::time::timeout(espera, salio).await.is_err() {
                timed_out += 1;
            }
        }
        if timed_out > 0 {
            self.log.write(&format!("cierre: {timed_out} terminal(es) no avisaron su salida a tiempo"));
        }
        {
            let mut g = self.lock();
            g.sessions.clear();
            g.last_hooks.clear();
        }
        self.emit(Event::SessionsChanged);
    }

    // ---------------- Hooks ----------------

    pub fn last_hook_events(&self) -> Value {
        Value::Object(self.lock().last_hooks.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
    }

    pub fn pending_permissions(&self) -> Value {
        Value::Array(self.lock().waiting.values().map(|w| w.req.clone()).collect())
    }

    pub fn on_hook(&self, body: &Value) {
        let Some(ev) = evento_de_hook(body, ahora_ms()) else { return };
        if let Some(ws) = ev.get("ws").and_then(Value::as_str) {
            self.lock().last_hooks.insert(ws.to_string(), ev.clone());
        }
        self.emit(Event::Hook(ev));
    }

    pub fn on_permission(&self, body: &Value) -> Perm {
        let (Some(ws), Some(tool)) = (
            body.get("ws").and_then(Value::as_str),
            body.get("tool").and_then(Value::as_str),
        ) else {
            return Perm::BadRequest;
        };
        if !self.streaming() {
            return Perm::Null;
        }
        let now = ahora_ms();
        let id = uuid();
        let mut req = Map::new();
        req.insert("id".into(), id.clone().into());
        req.insert("ws".into(), ws.into());
        req.insert("tool".into(), tool.into());
        req.insert("input".into(), body.get("input").filter(|i| i.is_object()).cloned().unwrap_or_else(|| json!({})));
        if let Some(s) = body.get("suggestions").filter(|s| s.is_array()) {
            req.insert("suggestions".into(), s.clone());
        }
        req.insert("at".into(), now.into());
        req.insert("expiresAt".into(), (now + PERMISSION_TIMEOUT_MS).into());
        let req = Value::Object(req);
        let (tx, rx) = oneshot::channel();
        self.lock().waiting.insert(id.clone(), Waiting { req: req.clone(), tx });
        self.log.write(&format!("permission {id} ws={ws} tool={tool}"));
        self.emit(Event::Permission(req));
        Perm::Wait(id, rx)
    }

    /// decision: objeto de Claude Code ({behavior:'allow'|'deny', ...}) o null (que pregunte en la terminal).
    pub fn answer_permission(&self, req_id: &str, decision: &Value) {
        self.resolve_permission(req_id, decision.is_object().then(|| decision.clone()));
    }

    pub fn resolve_permission(&self, id: &str, decision: Option<Value>) {
        let w = self.lock().waiting.remove(id);
        let Some(w) = w else { return };
        let _ = w.tx.send(decision);
        self.emit(Event::PermissionResolved(id.to_string()));
    }

    /// Todos los pendientes se contestan con null (ej. se fueron todos los clientes).
    pub fn resolve_all_permissions(&self) {
        let ids: Vec<String> = self.lock().waiting.keys().cloned().collect();
        for id in ids {
            self.resolve_permission(&id, None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_valido_conserva_solo_lo_conocido() {
        let b = json!({ "ws": "w1", "event": "PreToolUse", "tool": "Bash", "enSegundoPlano": true, "avisoDeTarea": false, "extra": 1, "message": 5 });
        let ev = evento_de_hook(&b, 42).unwrap();
        assert_eq!(ev, json!({ "ws": "w1", "event": "PreToolUse", "tool": "Bash", "enSegundoPlano": true, "at": 42 }));
    }

    #[test]
    fn hook_invalido_se_descarta() {
        assert!(evento_de_hook(&json!({ "ws": "w", "event": "Otro" }), 1).is_none());
        assert!(evento_de_hook(&json!({ "event": "Stop" }), 1).is_none());
        assert!(evento_de_hook(&json!([1]), 1).is_none());
    }

    #[test]
    fn uuid_con_forma() {
        let u = uuid();
        assert_eq!(u.len(), 36);
        assert_eq!(&u[14..15], "4");
    }
}
