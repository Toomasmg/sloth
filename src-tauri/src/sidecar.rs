//! Proceso de apoyo: el main de Sloth corriendo en Node sin Electron. Se habla por stdin/stdout con
//! líneas JSON (el protocolo está en src/sidecar/rpc.ts).
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

type Pendientes = Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>;

pub struct Sidecar {
    stdin: Mutex<ChildStdin>,
    pendientes: Pendientes,
    siguiente: AtomicU64,
    hijo: Mutex<Child>,
}

impl Sidecar {
    pub fn escribir(&self, msg: &Value) {
        if let Ok(mut s) = self.stdin.lock() {
            let _ = writeln!(s, "{msg}");
            let _ = s.flush();
        }
    }

    pub async fn invocar(&self, canal: String, args: Vec<Value>) -> Result<Value, String> {
        let id = self.siguiente.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pendientes.lock().map_err(|e| e.to_string())?.insert(id, tx);
        self.escribir(&json!({ "k": "invoke", "id": id, "channel": canal, "args": args }));
        rx.await.map_err(|_| "el proceso de apoyo se cerró".to_string())?
    }

    pub fn enviar(&self, canal: String, args: Vec<Value>) {
        self.escribir(&json!({ "k": "send", "channel": canal, "args": args }));
    }

    pub fn evento_nativo(&self, nombre: &str, args: Value) {
        self.escribir(&json!({ "k": "native-event", "name": nombre, "args": args }));
    }

    pub fn cerrar(&self) {
        if let Ok(mut h) = self.hijo.lock() {
            let _ = h.kill();
        }
    }
}

fn raiz_del_proyecto() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().map(PathBuf::from).unwrap_or_default()
}

/// Lanza `node out/sidecar/sloth-sidecar.cjs`. `nativo` atiende los pedidos de la parte nativa.
pub fn lanzar(app: AppHandle, nativo: fn(&AppHandle, &str, Vec<Value>) -> Result<Value, String>) -> Result<Arc<Sidecar>, String> {
    let raiz = std::env::var("SLOTH_APP_PATH").map(PathBuf::from).unwrap_or_else(|_| raiz_del_proyecto());
    let script = raiz.join("out").join("sidecar").join("sloth-sidecar.cjs");
    if !script.exists() {
        return Err(format!("falta {} (corré npm run build:sidecar)", script.display()));
    }
    let mut cmd = Command::new("node");
    cmd.arg(&script)
        .current_dir(&raiz)
        .env("SLOTH_APP_PATH", &raiz)
        .env("SLOTH_VERSION", env!("CARGO_PKG_VERSION"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut hijo = cmd.spawn().map_err(|e| format!("no se pudo lanzar node: {e}"))?;
    let stdin = hijo.stdin.take().ok_or("sin stdin")?;
    let stdout = hijo.stdout.take().ok_or("sin stdout")?;
    let sc = Arc::new(Sidecar { stdin: Mutex::new(stdin), pendientes: Mutex::new(HashMap::new()), siguiente: AtomicU64::new(1), hijo: Mutex::new(hijo) });

    let lector = sc.clone();
    std::thread::spawn(move || {
        for linea in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(m) = serde_json::from_str::<Value>(&linea) else { continue };
            match m.get("k").and_then(Value::as_str) {
                Some("result") => {
                    let Some(id) = m.get("id").and_then(Value::as_u64) else { continue };
                    let tx = lector.pendientes.lock().ok().and_then(|mut p| p.remove(&id));
                    if let Some(tx) = tx {
                        let r = if m.get("ok") == Some(&Value::Bool(true)) {
                            Ok(m.get("result").cloned().unwrap_or(Value::Null))
                        } else {
                            Err(m.get("error").and_then(Value::as_str).unwrap_or("error").to_string())
                        };
                        let _ = tx.send(r);
                    }
                }
                Some("event") => {
                    let _ = app.emit("sloth://event", json!({ "channel": m["channel"], "args": m["args"] }));
                }
                Some("native") => {
                    let (id, op) = (m["id"].clone(), m["op"].as_str().unwrap_or("").to_string());
                    let args = m["args"].as_array().cloned().unwrap_or_default();
                    let (sc, app) = (lector.clone(), app.clone());
                    std::thread::spawn(move || {
                        let r = nativo(&app, &op, args);
                        let msg = match r {
                            Ok(v) => json!({ "k": "native-result", "id": id, "ok": true, "result": v }),
                            Err(e) => json!({ "k": "native-result", "id": id, "ok": false, "error": e }),
                        };
                        sc.escribir(&msg);
                    });
                }
                _ => {}
            }
        }
    });
    Ok(sc)
}
