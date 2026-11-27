//! POST mínimo a 127.0.0.1 (el servidor de hooks del daemon). Sin dependencias: una conexión, `connection: close`.
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

/// «http://host:puerto/ruta» → (host:puerto, ruta). None si no es http.
pub fn partes(url: &str) -> Option<(String, String)> {
    let resto = url.strip_prefix("http://")?;
    let (host, ruta) = match resto.find('/') {
        Some(i) => (&resto[..i], &resto[i..]),
        None => (resto, "/"),
    };
    (!host.is_empty()).then(|| (host.to_string(), ruta.to_string()))
}

/// El origen («http://host:puerto») de una URL, para armar la ruta de /permission.
pub fn origen(url: &str) -> Option<String> {
    partes(url).map(|(h, _)| format!("http://{h}"))
}

/// El nombre de host sin puerto: «127.0.0.1», «localhost» o «[::1]».
pub fn nombre_de_host(host: &str) -> &str {
    if host.starts_with('[') {
        return host.find(']').map(|i| &host[..=i]).unwrap_or(host);
    }
    host.split(':').next().unwrap_or(host)
}

fn decodificar_chunked(mut b: &[u8]) -> Vec<u8> {
    let mut salida = Vec::new();
    loop {
        let Some(fin) = b.windows(2).position(|w| w == b"\r\n") else { break };
        let n = usize::from_str_radix(String::from_utf8_lossy(&b[..fin]).split(';').next().unwrap_or("").trim(), 16).unwrap_or(0);
        b = &b[fin + 2..];
        if n == 0 || b.len() < n {
            if n > 0 {
                salida.extend_from_slice(b);
            }
            break;
        }
        salida.extend_from_slice(&b[..n]);
        b = b.get(n + 2..).unwrap_or(&[]);
    }
    salida
}

/// Devuelve (código, cuerpo). Falla si no conecta o si pasa el tiempo total.
pub fn post(url: &str, token: &str, cuerpo: &str, limite: Duration) -> Result<(u16, String), String> {
    let (host, ruta) = partes(url).ok_or("URL inválida")?;
    let inicio = Instant::now();
    let restante = || limite.checked_sub(inicio.elapsed()).filter(|d| !d.is_zero()).ok_or_else(|| "tiempo agotado".to_string());
    let dir = host.to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("sin dirección")?;
    let mut s = TcpStream::connect_timeout(&dir, restante()?).map_err(|e| e.to_string())?;
    s.set_write_timeout(Some(restante()?)).map_err(|e| e.to_string())?;
    let pedido = format!(
        "POST {ruta} HTTP/1.1\r\nHost: {host}\r\ncontent-type: application/json\r\nx-sloth-token: {token}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{cuerpo}",
        cuerpo.len()
    );
    s.write_all(pedido.as_bytes()).map_err(|e| e.to_string())?;
    let mut crudo = Vec::new();
    let mut trozo = [0u8; 8192];
    loop {
        s.set_read_timeout(Some(restante()?)).map_err(|e| e.to_string())?;
        match s.read(&mut trozo) {
            Ok(0) => break,
            Ok(n) => {
                crudo.extend_from_slice(&trozo[..n]);
                if crudo.len() > 4 * 1024 * 1024 {
                    break;
                }
            }
            Err(e) if crudo.is_empty() => return Err(e.to_string()),
            Err(_) => break,
        }
    }
    let corte = crudo.windows(4).position(|w| w == b"\r\n\r\n").ok_or("respuesta incompleta")?;
    let cabeceras = String::from_utf8_lossy(&crudo[..corte]).to_string();
    let codigo: u16 = cabeceras.split_whitespace().nth(1).and_then(|c| c.parse().ok()).ok_or("sin código")?;
    let cuerpo_crudo = &crudo[corte + 4..];
    let cuerpo = if cabeceras.to_ascii_lowercase().contains("transfer-encoding: chunked") { decodificar_chunked(cuerpo_crudo) } else { cuerpo_crudo.to_vec() };
    Ok((codigo, String::from_utf8_lossy(&cuerpo).into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn partes_y_origen() {
        assert_eq!(partes("http://127.0.0.1:5000/hook"), Some(("127.0.0.1:5000".into(), "/hook".into())));
        assert_eq!(origen("http://127.0.0.1:5000/hook").as_deref(), Some("http://127.0.0.1:5000"));
        assert_eq!(partes("https://x/y"), None);
        assert_eq!(partes("http:///x"), None);
        assert_eq!(partes("http://localhost"), Some(("localhost".into(), "/".into())));
    }

    #[test]
    fn nombres_de_host() {
        assert_eq!(nombre_de_host("127.0.0.1:80"), "127.0.0.1");
        assert_eq!(nombre_de_host("localhost:1"), "localhost");
        assert_eq!(nombre_de_host("[::1]:9"), "[::1]");
    }

    fn servidor(respuesta: &'static str) -> (String, thread::JoinHandle<String>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/permission", l.local_addr().unwrap());
        let h = thread::spawn(move || {
            let (mut c, _) = l.accept().unwrap();
            let mut buf = vec![0u8; 65536];
            let mut total = 0;
            loop {
                let n = c.read(&mut buf[total..]).unwrap();
                total += n;
                let t = String::from_utf8_lossy(&buf[..total]).to_string();
                if let Some(i) = t.find("\r\n\r\n") {
                    let largo: usize = t.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap())).unwrap_or(0);
                    if total >= i + 4 + largo {
                        break;
                    }
                }
            }
            c.write_all(respuesta.as_bytes()).unwrap();
            String::from_utf8_lossy(&buf[..total]).into_owned()
        });
        (url, h)
    }

    #[test]
    fn post_manda_token_y_cuerpo_y_lee_la_respuesta() {
        let (url, h) = servidor("HTTP/1.1 200 OK\r\ncontent-length: 17\r\nconnection: close\r\n\r\n{\"decision\":null}");
        let (codigo, cuerpo) = post(&url, "tok", "{\"a\":1}", Duration::from_secs(5)).unwrap();
        assert_eq!((codigo, cuerpo.as_str()), (200, "{\"decision\":null}"));
        let pedido = h.join().unwrap();
        assert!(pedido.starts_with("POST /permission HTTP/1.1\r\n"));
        assert!(pedido.contains("x-sloth-token: tok\r\n") && pedido.ends_with("{\"a\":1}"));
    }

    #[test]
    fn lee_204_sin_cuerpo_y_respuestas_chunked() {
        let (url, h) = servidor("HTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n");
        assert_eq!(post(&url, "t", "{}", Duration::from_secs(5)).unwrap(), (204, String::new()));
        h.join().unwrap();
        let (url, h) = servidor("HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhola \r\n3\r\nmun\r\n0\r\n\r\n");
        assert_eq!(post(&url, "t", "{}", Duration::from_secs(5)).unwrap().1, "hola mun");
        h.join().unwrap();
    }

    #[test]
    fn sin_servidor_falla_rapido() {
        let t = Instant::now();
        assert!(post("http://127.0.0.1:1/hook", "t", "{}", Duration::from_secs(2)).is_err());
        assert!(t.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn el_tiempo_total_corta_a_un_servidor_que_no_responde() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/hook", l.local_addr().unwrap());
        let t = Instant::now();
        assert!(post(&url, "t", "{}", Duration::from_millis(400)).is_err());
        assert!(t.elapsed() < Duration::from_secs(2));
        drop(l);
    }
}
