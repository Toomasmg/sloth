//! Pipe con nombre, clientes autenticados, apagado y arranque. Equivale a src/daemon/index.ts.
use crate::auth::{es_hex64, misma_prueba, nuevo_nonce, prueba_cliente, prueba_daemon};
use crate::core::{Core, Event, SHUTDOWN_LIMITS};
use crate::log::Log;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::{mpsc, Notify};
use tokio::time::Instant;

const IDLE_SHUTDOWN: Duration = Duration::from_secs(30);
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
const PRE_AUTH_LINE_LIMIT: usize = 64 * 1024;
const LINE_LIMIT: usize = 32 * 1024 * 1024;
/// Un cliente que no lee (colgado) no puede hacernos crecer la memoria sin límite.
const MAX_CLIENT_BACKLOG: usize = 16 * 1024 * 1024;

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    let i = args.iter().position(|a| a == &format!("--{name}"))?;
    args.get(i + 1).cloned()
}

struct ClientHandle {
    tx: mpsc::UnboundedSender<String>,
    authed: AtomicBool,
    backlog: AtomicUsize,
    cerrar: Notify,
}

struct Shared {
    core: Arc<Core>,
    log: Arc<Log>,
    clients: Mutex<HashMap<u64, Arc<ClientHandle>>>,
    clave: String,
    version: String,
    cambio: Notify,
    apagando: AtomicBool,
}

impl Shared {
    fn enviar(&self, c: &ClientHandle, linea: String) {
        c.backlog.fetch_add(linea.len(), Ordering::Relaxed);
        if c.tx.send(linea).is_err() {
            return;
        }
        if c.backlog.load(Ordering::Relaxed) > MAX_CLIENT_BACKLOG {
            self.log.write("cliente no lee: se corta la conexión");
            c.cerrar.notify_one();
        }
    }

    fn difundir(&self, msg: &Value) {
        let linea = format!("{msg}\n");
        let clientes: Vec<Arc<ClientHandle>> = self.clients.lock().unwrap_or_else(|e| e.into_inner()).values().cloned().collect();
        for c in clientes.iter().filter(|c| c.authed.load(Ordering::Relaxed)) {
            self.enviar(c, linea.clone());
        }
    }

    fn ocioso(&self) -> bool {
        self.clients.lock().unwrap_or_else(|e| e.into_inner()).is_empty() && self.core.running_count() == 0
    }

    async fn apagar(&self, motivo: &str) {
        if self.apagando.swap(true, Ordering::SeqCst) {
            return;
        }
        self.log.write(&format!("shutdown: {motivo}"));
        // Primero las terminales, de a una: así conpty también alcanza a cerrar los procesos hijos.
        self.core.close_all(SHUTDOWN_LIMITS).await;
        self.core.resolve_all_permissions();
        tokio::time::sleep(Duration::from_millis(100)).await;
        std::process::exit(0);
    }
}

fn valor_a_texto(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => "undefined".into(),
        Some(otro) => otro.to_string(),
    }
}

fn respuesta(rid: &Value, r: Result<Value, String>) -> Value {
    match r {
        Ok(result) => json!({ "t": "reply", "rid": rid, "ok": true, "result": result }),
        Err(error) => json!({ "t": "reply", "rid": rid, "ok": false, "error": error }),
    }
}

struct Estado {
    nonce: Option<String>,
    nonce_daemon: Option<String>,
}

/// Devuelve false si hay que cortar la conexión.
async fn manejar(sh: &Arc<Shared>, c: &Arc<ClientHandle>, est: &mut Estado, msg: Value) -> bool {
    let tipo = msg.get("t").and_then(Value::as_str).unwrap_or("");
    if !c.authed.load(Ordering::Relaxed) {
        if tipo == "challenge" && est.nonce.is_none() {
            if let Some(n) = msg.get("nonce").and_then(Value::as_str).filter(|n| es_hex64(n, true)) {
                let nd = nuevo_nonce();
                let proof = prueba_daemon(&sh.clave, n, &nd);
                est.nonce = Some(n.to_string());
                est.nonce_daemon = Some(nd.clone());
                sh.enviar(c, format!("{}\n", json!({ "t": "challenge-ok", "nonce": nd, "proof": proof })));
                return true;
            }
        }
        let valido = match (tipo, &est.nonce, &est.nonce_daemon, msg.get("proof").and_then(Value::as_str)) {
            ("hello", Some(nc), Some(nd), Some(proof)) => misma_prueba(proof, &prueba_cliente(&sh.clave, nc, nd)),
            _ => false,
        };
        if !valido {
            sh.log.write("saludo rechazado");
            return false;
        }
        c.authed.store(true, Ordering::Relaxed);
        sh.core.authed.fetch_add(1, Ordering::Relaxed);
        let cuantos = sh.core.authed.load(Ordering::Relaxed);
        sh.log.write(&format!("cliente conectado (versión {}); clientes={cuantos}", valor_a_texto(msg.get("clientVersion"))));
        let hello = json!({
            "t": "hello-ok",
            "version": sh.version,
            "pid": std::process::id(),
            "hookUrl": sh.core.hook_url(),
            "hookToken": sh.core.hook_token,
            "sessions": sh.core.list(),
            "lastHookEvents": sh.core.last_hook_events(),
            "permissions": sh.core.pending_permissions(),
            "protocol": 2
        });
        sh.enviar(c, format!("{hello}\n"));
        return true;
    }
    let rid = msg.get("rid").cloned().unwrap_or(Value::Null);
    let id = valor_a_texto(msg.get("id"));
    match tipo {
        "start" => {
            let spec = msg.get("spawn").cloned().unwrap_or(Value::Null);
            let core = sh.core.clone();
            let r = tokio::task::spawn_blocking(move || core.start(&id, &spec)).await.unwrap_or_else(|e| Err(e.to_string()));
            sh.enviar(c, format!("{}\n", respuesta(&rid, r)));
        }
        "write" => {
            if let Some(d) = msg.get("data").and_then(Value::as_str) {
                sh.core.write(&id, d);
            }
        }
        "resize" => {
            let n = |k: &str| msg.get(k).and_then(Value::as_f64).unwrap_or(0.0);
            sh.core.resize(&id, n("cols"), n("rows"));
        }
        "kill" => {
            sh.core.kill(&id);
            sh.enviar(c, format!("{}\n", respuesta(&rid, Ok(Value::Null))));
        }
        "list" => sh.enviar(c, format!("{}\n", respuesta(&rid, Ok(sh.core.list())))),
        "permission-answer" => {
            let decision = msg.get("decision").cloned().unwrap_or(Value::Null);
            sh.core.answer_permission(&valor_a_texto(msg.get("reqId")), &decision);
        }
        "shutdown" => {
            sh.enviar(c, format!("{}\n", respuesta(&rid, Ok(Value::Null))));
            let sh = sh.clone();
            tokio::spawn(async move { sh.apagar("pedido por un cliente").await });
        }
        _ => {}
    }
    true
}

async fn cliente(sh: Arc<Shared>, id: u64, pipe: NamedPipeServer) {
    let (mut lector, mut escritor) = tokio::io::split(pipe);
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let c = Arc::new(ClientHandle { tx, authed: AtomicBool::new(false), backlog: AtomicUsize::new(0), cerrar: Notify::new() });
    sh.clients.lock().unwrap_or_else(|e| e.into_inner()).insert(id, c.clone());
    sh.cambio.notify_one();

    let c2 = c.clone();
    let escritura = tokio::spawn(async move {
        while let Some(linea) = rx.recv().await {
            let n = linea.len();
            if escritor.write_all(linea.as_bytes()).await.is_err() {
                break;
            }
            c2.backlog.fetch_sub(n, Ordering::Relaxed);
        }
    });

    let limite_saludo = Instant::now() + HELLO_TIMEOUT;
    let mut est = Estado { nonce: None, nonce_daemon: None };
    let mut buf: Vec<u8> = Vec::new();
    let mut tmp = vec![0u8; 64 * 1024];
    'conexion: loop {
        let autenticado = c.authed.load(Ordering::Relaxed);
        let n = tokio::select! {
            _ = c.cerrar.notified() => break,
            r = async {
                if autenticado {
                    lector.read(&mut tmp).await
                } else {
                    match tokio::time::timeout_at(limite_saludo, lector.read(&mut tmp)).await {
                        Ok(r) => r,
                        Err(_) => Err(std::io::ErrorKind::TimedOut.into()),
                    }
                }
            } => match r { Ok(0) | Err(_) => break, Ok(n) => n },
        };
        buf.extend_from_slice(&tmp[..n]);
        while let Some(i) = buf.iter().position(|b| *b == b'\n') {
            let linea: Vec<u8> = buf.drain(..=i).collect();
            let linea = &linea[..linea.len() - 1];
            if linea.is_empty() {
                continue;
            }
            match serde_json::from_slice::<Value>(linea) {
                Ok(msg) if msg.is_object() => {
                    if !manejar(&sh, &c, &mut est, msg).await {
                        break 'conexion;
                    }
                }
                Ok(_) => {}
                Err(_) => {
                    if !c.authed.load(Ordering::Relaxed) {
                        break 'conexion;
                    }
                }
            }
        }
        if buf.len() > if c.authed.load(Ordering::Relaxed) { LINE_LIMIT } else { PRE_AUTH_LINE_LIMIT } {
            break;
        }
    }

    escritura.abort();
    let estaba = c.authed.swap(false, Ordering::Relaxed);
    sh.clients.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    if estaba {
        let quedan = sh.core.authed.fetch_sub(1, Ordering::Relaxed) - 1;
        sh.log.write(&format!("cliente desconectado; clientes={quedan}"));
        if quedan == 0 {
            sh.core.resolve_all_permissions();
        }
    }
    sh.cambio.notify_one();
}

async fn vigilar_ocio(sh: Arc<Shared>) {
    loop {
        sh.cambio.notified().await;
        while sh.ocioso() {
            tokio::select! {
                _ = tokio::time::sleep(IDLE_SHUTDOWN) => {
                    if sh.ocioso() {
                        sh.apagar("inactivo").await;
                    }
                }
                _ = sh.cambio.notified() => {}
            }
        }
    }
}

async fn repartir_eventos(sh: Arc<Shared>, mut rx: mpsc::UnboundedReceiver<Event>) {
    while let Some(e) = rx.recv().await {
        match e {
            Event::Data { id, chunks } => {
                let cs: Vec<Value> = chunks.iter().map(|c| json!({ "seq": c.seq, "data": c.data })).collect();
                sh.difundir(&json!({ "t": "data", "id": id, "chunks": cs }));
            }
            Event::Exit { id, code } => sh.difundir(&json!({ "t": "exit", "id": id, "code": code })),
            Event::Hook(event) => sh.difundir(&json!({ "t": "hook", "event": event })),
            Event::Permission(req) => sh.difundir(&json!({ "t": "permission", "req": req })),
            Event::PermissionResolved(id) => sh.difundir(&json!({ "t": "permission-resolved", "id": id })),
            Event::SessionsChanged => sh.cambio.notify_one(),
        }
    }
}

fn fallar(log: &Log, msg: &str) -> ! {
    log.write(&format!("FATAL {msg}"));
    std::process::exit(1)
}

pub fn run() {
    let user_data = arg("user-data").map(PathBuf::from);
    let log = Arc::new(Log::new(user_data.as_ref().map(|u| u.join("daemon.log"))));
    let hook_log = log.clone();
    std::panic::set_hook(Box::new(move |i| hook_log.write(&format!("panic {i}"))));

    let (Some(user_data), Some(pipe)) = (user_data, arg("pipe")) else { fallar(&log, "faltan --user-data o --pipe") };
    let clave = std::fs::read_to_string(user_data.join("daemon-key")).map(|k| k.trim().to_string());
    let clave = match clave {
        Ok(k) if es_hex64(&k, false) => k,
        Ok(_) => fallar(&log, "daemon-key inválida"),
        Err(_) => fallar(&log, "no se pudo leer daemon-key"),
    };
    let version = arg("app-version").unwrap_or_else(|| "dev".into());

    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap_or_else(|e| fallar(&log, &format!("runtime: {e}")));
    rt.block_on(async move {
        let (tx, rx) = mpsc::unbounded_channel();
        let core = Core::new(tx, log.clone(), tokio::runtime::Handle::current());
        match crate::http::serve(core.clone()).await {
            Ok(port) => core.set_hook_url(format!("http://127.0.0.1:{port}/hook")),
            Err(e) => fallar(&log, &format!("servidor de hooks: {e}")),
        }
        let sh = Arc::new(Shared {
            core,
            log: log.clone(),
            clients: Mutex::new(HashMap::new()),
            clave,
            version: version.clone(),
            cambio: Notify::new(),
            apagando: AtomicBool::new(false),
        });
        // Otro daemon ya escucha en este pipe (arranque simultáneo): nos vamos sin tocar nada.
        let mut servidor = match ServerOptions::new().first_pipe_instance(true).reject_remote_clients(true).create(&pipe) {
            Ok(s) => s,
            Err(e) => {
                log.write(&format!("error del pipe: {e}"));
                let ocupado = matches!(e.kind(), std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::AlreadyExists);
                std::process::exit(if ocupado { 0 } else { 1 })
            }
        };
        tokio::spawn(repartir_eventos(sh.clone(), rx));
        tokio::spawn(vigilar_ocio(sh.clone()));
        log.write(&format!("Sloth daemon {version} (rust) escuchando"));
        sh.cambio.notify_one();
        let siguiente = Arc::new(AtomicU64::new(0));
        loop {
            if let Err(e) = servidor.connect().await {
                log.write(&format!("error del pipe: {e}"));
                std::process::exit(1);
            }
            let conectado = servidor;
            servidor = match ServerOptions::new().reject_remote_clients(true).create(&pipe) {
                Ok(s) => s,
                Err(e) => fallar(&log, &format!("no se pudo abrir otra instancia del pipe: {e}")),
            };
            tokio::spawn(cliente(sh.clone(), siguiente.fetch_add(1, Ordering::Relaxed), conectado));
        }
    });
}
