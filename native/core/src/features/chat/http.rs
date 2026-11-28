//! HTTP del chat. Todo el contacto con Supabase (PostgREST, GoTrue, Storage) pasa por el trait `Http`: en producción lo
//! atiende `HttpUreq` y en las pruebas un servidor local falso (`pruebas::ServidorFalso`) o un cierre.
//!
//! `ureq` (con rustls) es el cliente más liviano que habla HTTPS sin runtime asíncrono: no arrastra tokio ni hyper, y el
//! núcleo ya trabaja con hilos. Los redirects van apagados (`redirect: 'error'` del TypeScript): la `apikey` no puede
//! viajar a otro host.
use std::io::Read;
use std::time::Duration;

/// Tope de lo que se lee de una respuesta: las fotos del chat pesan hasta 512 KB y las listas son chicas.
const MAX_CUERPO: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pedido {
    pub metodo: &'static str,
    pub url: String,
    pub cabeceras: Vec<(String, String)>,
    pub cuerpo: Option<Vec<u8>>,
    pub timeout_ms: u64,
}

impl Pedido {
    pub fn nuevo(metodo: &'static str, url: &str) -> Self {
        Pedido { metodo, url: url.to_string(), cabeceras: Vec::new(), cuerpo: None, timeout_ms: 30_000 }
    }

    pub fn con_cabecera(mut self, k: &str, v: &str) -> Self {
        self.cabeceras.push((k.to_string(), v.to_string()));
        self
    }

    pub fn con_cuerpo(mut self, cuerpo: Vec<u8>) -> Self {
        self.cuerpo = Some(cuerpo);
        self
    }

    pub fn con_timeout(mut self, ms: u64) -> Self {
        self.timeout_ms = ms;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Respuesta {
    pub estado: u16,
    pub cuerpo: Vec<u8>,
}

impl Respuesta {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.estado)
    }

    pub fn json(&self) -> Option<serde_json::Value> {
        serde_json::from_slice(&self.cuerpo).ok()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorRed {
    Timeout,
    Conexion(String),
}

impl std::fmt::Display for ErrorRed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ErrorRed::Timeout => f.write_str("tiempo agotado"),
            ErrorRed::Conexion(m) => f.write_str(m),
        }
    }
}

pub trait Http: Send + Sync {
    fn pedir(&self, p: &Pedido) -> Result<Respuesta, ErrorRed>;
}

pub struct HttpUreq;

fn es_timeout(e: &std::io::Error) -> bool {
    matches!(e.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock)
}

impl Http for HttpUreq {
    fn pedir(&self, p: &Pedido) -> Result<Respuesta, ErrorRed> {
        let agente = ureq::AgentBuilder::new().redirects(0).timeout(Duration::from_millis(p.timeout_ms)).build();
        let mut req = agente.request(p.metodo, &p.url);
        for (k, v) in &p.cabeceras {
            req = req.set(k, v);
        }
        let res = match &p.cuerpo {
            Some(b) => req.send_bytes(b),
            None => req.call(),
        };
        let resp = match res {
            Ok(r) => r,
            Err(ureq::Error::Status(_, r)) => r,
            Err(ureq::Error::Transport(t)) => {
                let tiempo = t.kind() == ureq::ErrorKind::Io && std::error::Error::source(&t).and_then(|s| s.downcast_ref::<std::io::Error>()).is_some_and(es_timeout);
                return Err(if tiempo { ErrorRed::Timeout } else { ErrorRed::Conexion(t.to_string()) });
            }
        };
        let estado = resp.status();
        let mut cuerpo = Vec::new();
        resp.into_reader().take(MAX_CUERPO).read_to_end(&mut cuerpo).map_err(|e| if es_timeout(&e) { ErrorRed::Timeout } else { ErrorRed::Conexion(e.to_string()) })?;
        Ok(Respuesta { estado, cuerpo })
    }
}

#[cfg(test)]
pub mod pruebas {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};

    #[derive(Debug, Clone)]
    pub struct Recibido {
        pub metodo: String,
        pub ruta: String,
        pub cabeceras: Vec<(String, String)>,
        pub cuerpo: Vec<u8>,
    }

    impl Recibido {
        pub fn cabecera(&self, k: &str) -> Option<&str> {
            self.cabeceras.iter().find(|(n, _)| n.eq_ignore_ascii_case(k)).map(|(_, v)| v.as_str())
        }

        pub fn json(&self) -> serde_json::Value {
            serde_json::from_slice(&self.cuerpo).unwrap_or(serde_json::Value::Null)
        }
    }

    pub type Manejador = dyn Fn(&Recibido) -> (u16, Vec<u8>) + Send + Sync;

    /// Servidor HTTP/1.1 mínimo en 127.0.0.1 (un hilo, una respuesta por conexión) que anota cada pedido.
    pub struct ServidorFalso {
        pub base: String,
        pub pedidos: Arc<Mutex<Vec<Recibido>>>,
    }

    impl ServidorFalso {
        pub fn nuevo(manejador: impl Fn(&Recibido) -> (u16, Vec<u8>) + Send + Sync + 'static) -> Self {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://127.0.0.1:{}", l.local_addr().unwrap().port());
            let pedidos: Arc<Mutex<Vec<Recibido>>> = Arc::default();
            let anotados = pedidos.clone();
            let manejador: Arc<Manejador> = Arc::new(manejador);
            std::thread::spawn(move || {
                for s in l.incoming().flatten() {
                    let anotados = anotados.clone();
                    let manejador = manejador.clone();
                    std::thread::spawn(move || atender(s, &anotados, &*manejador));
                }
            });
            ServidorFalso { base, pedidos }
        }

        pub fn json(valor: serde_json::Value) -> Self {
            Self::nuevo(move |_| (200, valor.to_string().into_bytes()))
        }

        pub fn cantidad(&self) -> usize {
            self.pedidos.lock().unwrap().len()
        }

        pub fn ultimo(&self) -> Recibido {
            self.pedidos.lock().unwrap().last().cloned().expect("ningún pedido")
        }
    }

    fn atender(s: TcpStream, anotados: &Mutex<Vec<Recibido>>, manejador: &Manejador) {
        let Ok(escritura) = s.try_clone() else { return };
        let mut r = BufReader::new(s);
        let mut linea = String::new();
        if r.read_line(&mut linea).unwrap_or(0) == 0 {
            return;
        }
        let mut partes = linea.split_whitespace();
        let (metodo, ruta) = (partes.next().unwrap_or("").to_string(), partes.next().unwrap_or("").to_string());
        let mut cabeceras = Vec::new();
        let mut largo = 0usize;
        loop {
            let mut h = String::new();
            if r.read_line(&mut h).unwrap_or(0) == 0 || h.trim().is_empty() {
                break;
            }
            if let Some((k, v)) = h.trim().split_once(':') {
                if k.eq_ignore_ascii_case("content-length") {
                    largo = v.trim().parse().unwrap_or(0);
                }
                cabeceras.push((k.trim().to_string(), v.trim().to_string()));
            }
        }
        let mut cuerpo = vec![0u8; largo];
        if r.read_exact(&mut cuerpo).is_err() {
            return;
        }
        let rec = Recibido { metodo, ruta, cabeceras, cuerpo };
        anotados.lock().unwrap().push(rec.clone());
        let (estado, datos) = manejador(&rec);
        let mut w = escritura;
        let _ = write!(w, "HTTP/1.1 {estado} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", datos.len());
        let _ = w.write_all(&datos);
        let _ = w.flush();
    }

    /// `Http` de pruebas que no sale a la red: responde con un cierre y anota cada pedido.
    pub struct HttpFalso {
        pub pedidos: Mutex<Vec<Pedido>>,
        responder: Box<dyn Fn(&Pedido) -> Result<Respuesta, ErrorRed> + Send + Sync>,
    }

    impl HttpFalso {
        pub fn nuevo(f: impl Fn(&Pedido) -> Result<Respuesta, ErrorRed> + Send + Sync + 'static) -> Arc<Self> {
            Arc::new(HttpFalso { pedidos: Mutex::new(Vec::new()), responder: Box::new(f) })
        }

        pub fn urls(&self) -> Vec<String> {
            self.pedidos.lock().unwrap().iter().map(|p| format!("{} {}", p.metodo, p.url)).collect()
        }
    }

    impl Http for HttpFalso {
        fn pedir(&self, p: &Pedido) -> Result<Respuesta, ErrorRed> {
            self.pedidos.lock().unwrap().push(p.clone());
            (self.responder)(p)
        }
    }

    pub fn json_resp(estado: u16, v: serde_json::Value) -> Result<Respuesta, ErrorRed> {
        Ok(Respuesta { estado, cuerpo: v.to_string().into_bytes() })
    }

    #[test]
    fn ureq_llega_al_servidor_falso_con_cabeceras_y_cuerpo() {
        let s = ServidorFalso::json(serde_json::json!({"ok": true}));
        let r = HttpUreq.pedir(&Pedido::nuevo("POST", &format!("{}/x?a=1", s.base)).con_cabecera("apikey", "k").con_cuerpo(b"{\"a\":1}".to_vec())).unwrap();
        assert_eq!(r.estado, 200);
        assert_eq!(r.json().unwrap()["ok"], true);
        let p = s.ultimo();
        assert_eq!((p.metodo.as_str(), p.ruta.as_str()), ("POST", "/x?a=1"));
        assert_eq!(p.cabecera("apikey"), Some("k"));
        assert_eq!(p.json()["a"], 1);
    }

    #[test]
    fn un_estado_de_error_no_es_un_error_de_red() {
        let s = ServidorFalso::nuevo(|_| (401, b"{}".to_vec()));
        let r = HttpUreq.pedir(&Pedido::nuevo("GET", &format!("{}/", s.base))).unwrap();
        assert_eq!(r.estado, 401);
        assert!(!r.ok());
    }

    #[test]
    fn un_redirect_no_se_sigue() {
        let s = ServidorFalso::nuevo(|_| (302, Vec::new()));
        let r = HttpUreq.pedir(&Pedido::nuevo("GET", &format!("{}/", s.base))).unwrap();
        assert_eq!(r.estado, 302);
        assert_eq!(s.cantidad(), 1);
    }

    #[test]
    fn sin_nadie_escuchando_es_error_de_conexion() {
        let puerto = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let e = HttpUreq.pedir(&Pedido::nuevo("GET", &format!("http://127.0.0.1:{puerto}/")).con_timeout(2000)).unwrap_err();
        assert!(matches!(e, ErrorRed::Conexion(_)), "{e:?}");
    }
}
