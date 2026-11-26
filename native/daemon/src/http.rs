//! Servidor HTTP de hooks en 127.0.0.1 (POST /hook y POST /permission), mínimo y sin dependencias:
//! una sola petición por conexión y siempre `connection: close`.
use crate::auth::{es_hex64, hook_token_de, misma_prueba};
use crate::core::{Core, Perm, PERMISSION_TIMEOUT_MS};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::OwnedReadHalf;
use tokio::net::{TcpListener, TcpStream};

const HOOK_BODY_LIMIT: usize = 64 * 1024;
const PERMISSION_BODY_LIMIT: usize = 256 * 1024;
const HEADER_LIMIT: usize = 16 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

pub async fn serve(core: Arc<Core>) -> std::io::Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            };
            let core = core.clone();
            tokio::spawn(async move { conexion(core, stream).await });
        }
    });
    Ok(port)
}

struct Pedido {
    metodo: String,
    ruta: String,
    token: Option<String>,
    largo: usize,
    /// Bytes del cuerpo que llegaron junto con las cabeceras.
    cuerpo: Vec<u8>,
}

fn buscar(h: &[u8], aguja: &[u8]) -> Option<usize> {
    h.windows(aguja.len()).position(|w| w == aguja)
}

fn parsear_cabeceras(crudo: &[u8]) -> Option<Pedido> {
    let texto = std::str::from_utf8(crudo).ok()?;
    let mut lineas = texto.split("\r\n");
    let mut primera = lineas.next()?.split(' ');
    let (metodo, ruta) = (primera.next()?.to_string(), primera.next()?.to_string());
    let (mut token, mut largo) = (None, 0usize);
    for l in lineas {
        let Some((k, v)) = l.split_once(':') else { continue };
        match k.trim().to_ascii_lowercase().as_str() {
            "x-sloth-token" => token = Some(v.trim().to_string()),
            "content-length" => largo = v.trim().parse().ok()?,
            _ => {}
        }
    }
    Some(Pedido { metodo, ruta, token, largo, cuerpo: Vec::new() })
}

async fn responder(w: &mut tokio::net::tcp::OwnedWriteHalf, codigo: u16, json: Option<&str>) {
    let razon = match codigo {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        _ => "Error",
    };
    let cuerpo = json.unwrap_or("");
    let tipo = if json.is_some() { "content-type: application/json\r\n" } else { "" };
    let largo = if codigo == 204 { String::new() } else { format!("content-length: {}\r\n", cuerpo.len()) };
    let r = format!("HTTP/1.1 {codigo} {razon}\r\n{tipo}{largo}connection: close\r\n\r\n{cuerpo}");
    let _ = w.write_all(r.as_bytes()).await;
    let _ = w.shutdown().await;
}

async fn leer_cabeceras(r: &mut OwnedReadHalf) -> Option<Pedido> {
    let mut buf: Vec<u8> = Vec::new();
    let mut tmp = [0u8; 4096];
    loop {
        if let Some(i) = buscar(&buf, b"\r\n\r\n") {
            let mut p = parsear_cabeceras(&buf[..i])?;
            p.cuerpo = buf[i + 4..].to_vec();
            return Some(p);
        }
        if buf.len() > HEADER_LIMIT {
            return None;
        }
        let n = r.read(&mut tmp).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
}

async fn conexion(core: Arc<Core>, stream: TcpStream) {
    let (mut r, mut w) = stream.into_split();
    let Ok(Some(mut p)) = tokio::time::timeout(REQUEST_TIMEOUT, leer_cabeceras(&mut r)).await else {
        responder(&mut w, 400, None).await;
        return;
    };
    if p.metodo != "POST" || (p.ruta != "/hook" && p.ruta != "/permission") {
        responder(&mut w, 404, None).await;
        return;
    }
    let token = match p.token.take() {
        Some(t) if es_hex64(&t, true) => t,
        _ => {
            responder(&mut w, 403, None).await;
            return;
        }
    };
    let es_hook = p.ruta == "/hook";
    let limite = if es_hook { HOOK_BODY_LIMIT } else { PERMISSION_BODY_LIMIT };
    if p.largo > limite {
        responder(&mut w, 413, None).await;
        return;
    }
    let mut cuerpo = std::mem::take(&mut p.cuerpo);
    cuerpo.truncate(p.largo);
    let resto = async {
        let mut tmp = [0u8; 8192];
        while cuerpo.len() < p.largo {
            let n = r.read(&mut tmp).await.unwrap_or(0);
            if n == 0 {
                return false;
            }
            let faltan = p.largo - cuerpo.len();
            cuerpo.extend_from_slice(&tmp[..n.min(faltan)]);
        }
        true
    };
    if !matches!(tokio::time::timeout(REQUEST_TIMEOUT, resto).await, Ok(true)) {
        responder(&mut w, 400, None).await;
        return;
    }
    let Ok(body) = serde_json::from_slice::<Value>(&cuerpo) else {
        responder(&mut w, 400, None).await;
        return;
    };
    let ws = body.get("ws").and_then(Value::as_str).unwrap_or("");
    if ws.is_empty() || !misma_prueba(&token, &hook_token_de(&core.hook_token, ws)) {
        responder(&mut w, 403, None).await;
        return;
    }
    if es_hook {
        responder(&mut w, 204, None).await;
        core.on_hook(&body);
        return;
    }
    match core.on_permission(&body) {
        Perm::BadRequest => responder(&mut w, 400, None).await,
        Perm::Null => responder(&mut w, 200, Some("{\"decision\":null}")).await,
        Perm::Wait(id, mut rx) => {
            // Si el hook muere (Claude lo cortó o el usuario contestó en la terminal), se retira el pedido.
            let cerrado = async {
                let mut tmp = [0u8; 64];
                while r.read(&mut tmp).await.map(|n| n > 0).unwrap_or(false) {}
            };
            let decision = tokio::select! {
                d = &mut rx => d.ok().flatten(),
                _ = tokio::time::sleep(Duration::from_millis(PERMISSION_TIMEOUT_MS)) => {
                    core.resolve_permission(&id, None);
                    None
                }
                _ = cerrado => {
                    core.resolve_permission(&id, None);
                    None
                }
            };
            let salida = serde_json::json!({ "decision": decision }).to_string();
            responder(&mut w, 200, Some(&salida)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cabeceras_basicas() {
        let p = parsear_cabeceras(b"POST /hook HTTP/1.1\r\nHost: x\r\nX-Sloth-Token: abc\r\nContent-Length: 12").unwrap();
        assert_eq!((p.metodo.as_str(), p.ruta.as_str(), p.largo), ("POST", "/hook", 12));
        assert_eq!(p.token.as_deref(), Some("abc"));
    }

    #[test]
    fn largo_invalido_se_rechaza() {
        assert!(parsear_cabeceras(b"POST /hook HTTP/1.1\r\nContent-Length: abc").is_none());
    }
}
