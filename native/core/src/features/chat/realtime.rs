//! Chat (datos): la ÚNICA conexión Realtime de Sloth, hablando el protocolo Phoenix (vsn 1.0.0) de Supabase Realtime sin
//! supabase-js, con `tungstenite` (rustls). Equivale a chat-realtime.ts más la parte de realtime-js que usaba:
//!  - «sloth-inbox» escucha los INSERT y UPDATE de `messages` (la RLS se aplica por suscriptor).
//!  - un canal PRIVADO de Broadcast por conversación (mismo socket) entrega antes; «sloth-inbox» queda de respaldo.
//!  - la reconexión y el reintento de los joins los hace este módulo; no hay más hilos que el del socket.
//! Lo que llega se entrega por un `Receiver`: quien lo recibe valida cada payload (es dato no confiable).
//! Un solo hilo es dueño del socket: lee con un timeout corto y en cada vuelta atiende comandos, heartbeats y joins.
use super::Res;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::TcpStream;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EstadoCanal {
    Subscribed,
    ChannelError,
    TimedOut,
    Closed,
}

impl EstadoCanal {
    pub fn como_str(self) -> &'static str {
        match self {
            EstadoCanal::Subscribed => "SUBSCRIBED",
            EstadoCanal::ChannelError => "CHANNEL_ERROR",
            EstadoCanal::TimedOut => "TIMED_OUT",
            EstadoCanal::Closed => "CLOSED",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum EventoRealtime {
    Estado { canal: String, estado: EstadoCanal },
    /// `tipo` es `INSERT` o `UPDATE`; `fila` es el registro nuevo, sin validar.
    Cambio { canal: String, tipo: String, fila: Value },
    Broadcast { canal: String, evento: String, payload: Value },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CambioPg {
    pub evento: &'static str,
    pub tabla: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Canal {
    pub nombre: String,
    pub privado: bool,
    pub cambios: Vec<CambioPg>,
}

impl Canal {
    /// «sloth-inbox»: INSERT y UPDATE de `messages`.
    pub fn inbox() -> Self {
        Canal { nombre: "sloth-inbox".into(), privado: false, cambios: vec![CambioPg { evento: "INSERT", tabla: "messages" }, CambioPg { evento: "UPDATE", tabla: "messages" }] }
    }

    /// Canal privado de Broadcast de un tópico (`team:<id>`, `thread:<id>`).
    pub fn privado(topico: &str) -> Self {
        Canal { nombre: topico.into(), privado: true, cambios: Vec::new() }
    }

    fn topico_ws(&self) -> String {
        format!("realtime:{}", self.nombre)
    }
}

// ---------- el protocolo, sin red ----------

/// `https://x.supabase.co` → `wss://x.supabase.co/realtime/v1/websocket?apikey=…&vsn=1.0.0`.
pub fn url_websocket(base: &str, anon_key: &str) -> Res<String> {
    let mut u = url::Url::parse(base).map_err(|_| "URL de Supabase inválida.".to_string())?;
    let esquema = match u.scheme() {
        "https" => "wss",
        "http" => "ws",
        _ => return Err("URL de Supabase inválida.".into()),
    };
    u.set_scheme(esquema).map_err(|_| "URL de Supabase inválida.".to_string())?;
    u.set_path("/realtime/v1/websocket");
    u.query_pairs_mut().clear().append_pair("apikey", anon_key).append_pair("vsn", "1.0.0");
    Ok(u.to_string())
}

fn trama(topico: &str, evento: &str, payload: Value, r: u64, join_ref: Option<u64>) -> Value {
    let mut v = json!({"topic": topico, "event": evento, "payload": payload, "ref": r.to_string()});
    if let Some(j) = join_ref {
        v["join_ref"] = json!(j.to_string());
    }
    v
}

pub fn trama_join(c: &Canal, token: Option<&str>, r: u64) -> Value {
    let cambios: Vec<Value> = c.cambios.iter().map(|x| json!({"event": x.evento, "schema": "public", "table": x.tabla})).collect();
    let mut payload = json!({"config": {"broadcast": {"ack": false, "self": false}, "presence": {"key": ""}, "postgres_changes": cambios, "private": c.privado}});
    if let Some(t) = token {
        payload["access_token"] = json!(t);
    }
    trama(&c.topico_ws(), "phx_join", payload, r, Some(r))
}

pub fn trama_salida(c: &Canal, r: u64) -> Value {
    trama(&c.topico_ws(), "phx_leave", json!({}), r, None)
}

pub fn trama_latido(r: u64) -> Value {
    trama("phoenix", "heartbeat", json!({}), r, None)
}

pub fn trama_token(c: &Canal, token: &str, r: u64) -> Value {
    trama(&c.topico_ws(), "access_token", json!({"access_token": token}), r, None)
}

#[derive(Debug, Clone, PartialEq)]
pub enum Interpretada {
    Respuesta { topico: String, r: Option<String>, ok: bool },
    Cambio { topico: String, tipo: String, fila: Value },
    Broadcast { topico: String, evento: String, payload: Value },
    CanalCaido { topico: String, cerrado: bool },
    Nada,
}

/// Lo que dice una trama del servidor. Cualquier cosa con otra forma es `Nada`.
pub fn interpretar(t: &Value) -> Interpretada {
    let (Some(topico), Some(evento)) = (t.get("topic").and_then(Value::as_str), t.get("event").and_then(Value::as_str)) else { return Interpretada::Nada };
    let topico = topico.to_string();
    let payload = t.get("payload").cloned().unwrap_or(Value::Null);
    match evento {
        "phx_reply" => Interpretada::Respuesta { topico, r: t.get("ref").and_then(Value::as_str).map(String::from), ok: payload.get("status").and_then(Value::as_str) == Some("ok") },
        "postgres_changes" => {
            let data = payload.get("data");
            let tipo = data.and_then(|d| d.get("type")).and_then(Value::as_str);
            match (tipo, data.and_then(|d| d.get("record"))) {
                (Some(tipo @ ("INSERT" | "UPDATE")), Some(fila)) => Interpretada::Cambio { topico, tipo: tipo.into(), fila: fila.clone() },
                _ => Interpretada::Nada,
            }
        }
        "broadcast" => match payload.get("event").and_then(Value::as_str) {
            Some(e) => Interpretada::Broadcast { topico, evento: e.into(), payload: payload.get("payload").cloned().unwrap_or(Value::Null) },
            None => Interpretada::Nada,
        },
        "phx_error" => Interpretada::CanalCaido { topico, cerrado: false },
        "phx_close" => Interpretada::CanalCaido { topico, cerrado: true },
        _ => Interpretada::Nada,
    }
}

// ---------- la conexión ----------

#[derive(Debug, Clone)]
pub struct ConfigRealtime {
    pub url: String,
    pub heartbeat_ms: u64,
    pub join_timeout_ms: u64,
    pub rejoin_ms: u64,
    /// Esperas entre reconexiones; la última se repite. Vacío = no reconecta (pruebas).
    pub reintentos_ms: Vec<u64>,
    /// Cada cuánto el hilo mira los comandos mientras espera datos.
    pub vuelta_ms: u64,
}

impl ConfigRealtime {
    pub fn nueva(url: String) -> Self {
        ConfigRealtime { url, heartbeat_ms: 25_000, join_timeout_ms: 10_000, rejoin_ms: 2_000, reintentos_ms: vec![1_000, 2_000, 5_000, 10_000], vuelta_ms: 200 }
    }
}

enum Cmd {
    Unir(Canal),
    Salir(String),
    Token,
    Cerrar,
}

pub struct Realtime {
    cmd: Sender<Cmd>,
}

impl Realtime {
    /// Abre el hilo del socket. `token` se pide en cada join (así un reconectado usa el JWT renovado). Devuelve los eventos.
    pub fn conectar(cfg: ConfigRealtime, token: Arc<dyn Fn() -> Option<String> + Send + Sync>) -> (Realtime, Receiver<EventoRealtime>) {
        let (cmd, rx_cmd) = channel();
        let (tx_ev, rx_ev) = channel();
        std::thread::spawn(move || Bucle::nuevo(cfg, token, rx_cmd, tx_ev).correr());
        (Realtime { cmd }, rx_ev)
    }

    pub fn unir(&self, c: Canal) {
        let _ = self.cmd.send(Cmd::Unir(c));
    }

    pub fn salir(&self, nombre: &str) {
        let _ = self.cmd.send(Cmd::Salir(nombre.to_string()));
    }

    /// Manda el JWT renovado a cada canal ya unido.
    pub fn renovar_token(&self) {
        let _ = self.cmd.send(Cmd::Token);
    }

    /// `removeAllChannels`: sale de todos los canales y cierra el socket.
    pub fn cerrar(&self) {
        let _ = self.cmd.send(Cmd::Cerrar);
    }
}

type Ws = WebSocket<MaybeTlsStream<TcpStream>>;

struct Unido {
    canal: Canal,
    /// `ref` del join en curso; `None` si ya respondió.
    pendiente: Option<(u64, Instant)>,
    /// Cuándo reintentar el join tras un error del canal.
    reunir: Option<Instant>,
}

struct Bucle {
    cfg: ConfigRealtime,
    token: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    cmd: Receiver<Cmd>,
    ev: Sender<EventoRealtime>,
    canales: HashMap<String, Unido>,
    ref_n: u64,
}

enum Salida {
    Cerrado,
    Caido,
}

impl Bucle {
    fn nuevo(cfg: ConfigRealtime, token: Arc<dyn Fn() -> Option<String> + Send + Sync>, cmd: Receiver<Cmd>, ev: Sender<EventoRealtime>) -> Self {
        Bucle { cfg, token, cmd, ev, canales: HashMap::new(), ref_n: 0 }
    }

    fn siguiente(&mut self) -> u64 {
        self.ref_n += 1;
        self.ref_n
    }

    fn estado(&self, canal: &str, estado: EstadoCanal) {
        let _ = self.ev.send(EventoRealtime::Estado { canal: canal.to_string(), estado });
    }

    fn correr(mut self) {
        let mut intento = 0usize;
        loop {
            match self.sesion() {
                Salida::Cerrado => return,
                Salida::Caido => {
                    for n in self.canales.keys().cloned().collect::<Vec<_>>() {
                        self.estado(&n, EstadoCanal::Closed);
                    }
                    if self.cfg.reintentos_ms.is_empty() {
                        return;
                    }
                    let espera = self.cfg.reintentos_ms[intento.min(self.cfg.reintentos_ms.len() - 1)];
                    intento += 1;
                    // Mientras espera sigue atendiendo comandos: un cerrar no puede quedar esperando el reintento.
                    if self.dormir(espera) {
                        return;
                    }
                }
            }
        }
    }

    /// `true` si en la espera llegó un cierre.
    fn dormir(&mut self, ms: u64) -> bool {
        let hasta = Instant::now() + Duration::from_millis(ms);
        loop {
            let resto = hasta.saturating_duration_since(Instant::now());
            if resto.is_zero() {
                return false;
            }
            match self.cmd.recv_timeout(resto) {
                Ok(Cmd::Cerrar) | Err(RecvTimeoutError::Disconnected) => return true,
                Ok(Cmd::Unir(c)) => {
                    self.canales.insert(c.nombre.clone(), Unido { canal: c, pendiente: None, reunir: None });
                }
                Ok(Cmd::Salir(n)) => {
                    self.canales.remove(&n);
                }
                Ok(Cmd::Token) => {}
                Err(RecvTimeoutError::Timeout) => return false,
            }
        }
    }

    fn mandar(&self, ws: &mut Ws, t: &Value) -> bool {
        ws.send(Message::text(t.to_string())).is_ok()
    }

    fn unir_canal(&mut self, ws: &mut Ws, nombre: &str) -> bool {
        let r = self.siguiente();
        let token = (self.token)();
        let timeout = Duration::from_millis(self.cfg.join_timeout_ms);
        let Some(u) = self.canales.get_mut(nombre) else { return true };
        u.pendiente = Some((r, Instant::now() + timeout));
        u.reunir = None;
        let t = trama_join(&u.canal, token.as_deref(), r);
        self.mandar(ws, &t)
    }

    fn sesion(&mut self) -> Salida {
        let Ok((mut ws, _)) = tungstenite::connect(self.cfg.url.as_str()) else { return Salida::Caido };
        let vuelta = Duration::from_millis(self.cfg.vuelta_ms.max(1));
        match ws.get_mut() {
            MaybeTlsStream::Plain(s) => s.set_read_timeout(Some(vuelta)).ok(),
            MaybeTlsStream::Rustls(t) => t.get_ref().set_read_timeout(Some(vuelta)).ok(),
            _ => None,
        };
        // Reconexión: todos los canales conocidos se vuelven a unir con el token de ahora.
        for n in self.canales.keys().cloned().collect::<Vec<_>>() {
            if !self.unir_canal(&mut ws, &n) {
                return Salida::Caido;
            }
        }
        let latido = Duration::from_millis(self.cfg.heartbeat_ms);
        let mut ultimo_latido = Instant::now();
        loop {
            loop {
                match self.cmd.try_recv() {
                    Ok(Cmd::Unir(c)) => {
                        let n = c.nombre.clone();
                        self.canales.insert(n.clone(), Unido { canal: c, pendiente: None, reunir: None });
                        if !self.unir_canal(&mut ws, &n) {
                            return Salida::Caido;
                        }
                    }
                    Ok(Cmd::Salir(n)) => {
                        if let Some(u) = self.canales.remove(&n) {
                            let r = self.siguiente();
                            self.mandar(&mut ws, &trama_salida(&u.canal, r));
                        }
                    }
                    Ok(Cmd::Token) => {
                        if let Some(t) = (self.token)() {
                            let canales: Vec<Canal> = self.canales.values().map(|u| u.canal.clone()).collect();
                            for c in canales {
                                let r = self.siguiente();
                                self.mandar(&mut ws, &trama_token(&c, &t, r));
                            }
                        }
                    }
                    Ok(Cmd::Cerrar) | Err(TryRecvError::Disconnected) => {
                        let canales: Vec<Canal> = self.canales.drain().map(|(_, u)| u.canal).collect();
                        for c in canales {
                            let r = self.siguiente();
                            self.mandar(&mut ws, &trama_salida(&c, r));
                        }
                        let _ = ws.close(None);
                        let _ = ws.flush();
                        return Salida::Cerrado;
                    }
                    Err(TryRecvError::Empty) => break,
                }
            }
            if ultimo_latido.elapsed() >= latido {
                ultimo_latido = Instant::now();
                let r = self.siguiente();
                if !self.mandar(&mut ws, &trama_latido(r)) {
                    return Salida::Caido;
                }
            }
            let ahora = Instant::now();
            let vencidos: Vec<String> = self.canales.iter().filter(|(_, u)| u.pendiente.is_some_and(|(_, hasta)| ahora >= hasta)).map(|(n, _)| n.clone()).collect();
            for n in vencidos {
                self.estado(&n, EstadoCanal::TimedOut);
                if !self.unir_canal(&mut ws, &n) {
                    return Salida::Caido;
                }
            }
            let a_reunir: Vec<String> = self.canales.iter().filter(|(_, u)| u.reunir.is_some_and(|c| ahora >= c)).map(|(n, _)| n.clone()).collect();
            for n in a_reunir {
                if !self.unir_canal(&mut ws, &n) {
                    return Salida::Caido;
                }
            }
            match ws.read() {
                Ok(Message::Text(t)) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&t) {
                        self.atender(&v);
                    }
                }
                Ok(Message::Ping(p)) => {
                    let _ = ws.send(Message::Pong(p));
                }
                Ok(Message::Close(_)) => return Salida::Caido,
                Ok(_) => {}
                Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                Err(_) => return Salida::Caido,
            }
        }
    }

    fn nombre_de(&self, topico: &str) -> Option<String> {
        let n = topico.strip_prefix("realtime:")?;
        self.canales.contains_key(n).then(|| n.to_string())
    }

    fn atender(&mut self, trama: &Value) {
        match interpretar(trama) {
            Interpretada::Respuesta { topico, r, ok } => {
                let Some(n) = self.nombre_de(&topico) else { return };
                let Some(u) = self.canales.get_mut(&n) else { return };
                // Solo responde al join en curso: la respuesta de un `phx_leave` o de un token no cambia el estado.
                let Some((rj, _)) = u.pendiente else { return };
                if r.as_deref() != Some(rj.to_string().as_str()) {
                    return;
                }
                u.pendiente = None;
                if ok {
                    self.estado(&n, EstadoCanal::Subscribed);
                } else {
                    // Un rechazo (p. ej. la RLS de un canal privado) no se reintenta solo: quien escucha decide.
                    self.estado(&n, EstadoCanal::ChannelError);
                }
            }
            Interpretada::Cambio { topico, tipo, fila } => {
                if let Some(canal) = self.nombre_de(&topico) {
                    let _ = self.ev.send(EventoRealtime::Cambio { canal, tipo, fila });
                }
            }
            Interpretada::Broadcast { topico, evento, payload } => {
                if let Some(canal) = self.nombre_de(&topico) {
                    let _ = self.ev.send(EventoRealtime::Broadcast { canal, evento, payload });
                }
            }
            Interpretada::CanalCaido { topico, cerrado } => {
                let Some(n) = self.nombre_de(&topico) else { return };
                let rejoin = Instant::now() + Duration::from_millis(self.cfg.rejoin_ms);
                if let Some(u) = self.canales.get_mut(&n) {
                    u.pendiente = None;
                    if !cerrado {
                        u.reunir = Some(rejoin);
                    }
                }
                self.estado(&n, if cerrado { EstadoCanal::Closed } else { EstadoCanal::ChannelError });
            }
            Interpretada::Nada => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn la_url_del_websocket_sale_de_la_de_supabase() {
        assert_eq!(url_websocket("https://x.supabase.co", "k").unwrap(), "wss://x.supabase.co/realtime/v1/websocket?apikey=k&vsn=1.0.0");
        assert_eq!(url_websocket("http://127.0.0.1:9", "a b").unwrap(), "ws://127.0.0.1:9/realtime/v1/websocket?apikey=a+b&vsn=1.0.0");
        assert!(url_websocket("ftp://x", "k").is_err());
    }

    #[test]
    fn el_join_del_inbox_pide_insert_y_update_de_messages_con_el_token() {
        let t = trama_join(&Canal::inbox(), Some("jwt"), 3);
        assert_eq!((t["topic"].as_str(), t["event"].as_str(), t["ref"].as_str(), t["join_ref"].as_str()), (Some("realtime:sloth-inbox"), Some("phx_join"), Some("3"), Some("3")));
        assert_eq!(t["payload"]["access_token"], "jwt");
        assert_eq!(t["payload"]["config"]["private"], false);
        assert_eq!(t["payload"]["config"]["postgres_changes"], json!([{"event": "INSERT", "schema": "public", "table": "messages"}, {"event": "UPDATE", "schema": "public", "table": "messages"}]));
        assert_eq!(t["payload"]["config"]["broadcast"], json!({"ack": false, "self": false}));
    }

    #[test]
    fn el_canal_de_una_conversacion_es_privado_y_sin_cambios_de_base() {
        let t = trama_join(&Canal::privado("team:abc"), None, 1);
        assert_eq!(t["topic"], "realtime:team:abc");
        assert_eq!(t["payload"]["config"]["private"], true);
        assert_eq!(t["payload"]["config"]["postgres_changes"], json!([]));
        assert!(t["payload"].get("access_token").is_none());
    }

    #[test]
    fn latido_salida_y_token_tienen_la_forma_de_phoenix() {
        assert_eq!(trama_latido(7), json!({"topic": "phoenix", "event": "heartbeat", "payload": {}, "ref": "7"}));
        let c = Canal::privado("thread:z");
        assert_eq!(trama_salida(&c, 8)["event"], "phx_leave");
        let t = trama_token(&c, "nuevo", 9);
        assert_eq!((t["event"].as_str(), t["payload"]["access_token"].as_str()), (Some("access_token"), Some("nuevo")));
    }

    #[test]
    fn interpreta_respuestas_cambios_broadcast_y_caidas() {
        assert_eq!(interpretar(&json!({"topic": "realtime:a", "event": "phx_reply", "ref": "2", "payload": {"status": "ok", "response": {}}})), Interpretada::Respuesta { topico: "realtime:a".into(), r: Some("2".into()), ok: true });
        assert!(matches!(interpretar(&json!({"topic": "realtime:a", "event": "phx_reply", "ref": "2", "payload": {"status": "error"}})), Interpretada::Respuesta { ok: false, .. }));
        let c = interpretar(&json!({"topic": "realtime:sloth-inbox", "event": "postgres_changes", "payload": {"ids": [1], "data": {"type": "INSERT", "table": "messages", "record": {"id": "m1"}}}}));
        assert_eq!(c, Interpretada::Cambio { topico: "realtime:sloth-inbox".into(), tipo: "INSERT".into(), fila: json!({"id": "m1"}) });
        let b = interpretar(&json!({"topic": "realtime:team:x", "event": "broadcast", "payload": {"type": "broadcast", "event": "message", "payload": {"a": 1}}}));
        assert_eq!(b, Interpretada::Broadcast { topico: "realtime:team:x".into(), evento: "message".into(), payload: json!({"a": 1}) });
        assert_eq!(interpretar(&json!({"topic": "realtime:x", "event": "phx_error", "payload": {}})), Interpretada::CanalCaido { topico: "realtime:x".into(), cerrado: false });
        assert_eq!(interpretar(&json!({"topic": "realtime:x", "event": "phx_close", "payload": {}})), Interpretada::CanalCaido { topico: "realtime:x".into(), cerrado: true });
    }

    #[test]
    fn lo_que_no_tiene_la_forma_esperada_se_ignora() {
        for malo in [json!(null), json!({"event": "x"}), json!({"topic": "t", "event": "postgres_changes", "payload": {"data": {"type": "DELETE", "record": {}}}}), json!({"topic": "t", "event": "postgres_changes", "payload": {}}), json!({"topic": "t", "event": "broadcast", "payload": {"event": 5}}), json!({"topic": "t", "event": "otro"})] {
            assert_eq!(interpretar(&malo), Interpretada::Nada, "{malo}");
        }
    }

    // ----- contra un servidor WebSocket local -----

    fn servidor() -> (String, std::thread::JoinHandle<tungstenite::WebSocket<TcpStream>>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("ws://127.0.0.1:{}/realtime/v1/websocket?apikey=k&vsn=1.0.0", l.local_addr().unwrap().port());
        (url, std::thread::spawn(move || tungstenite::accept(l.accept().unwrap().0).unwrap()))
    }

    fn cfg(url: String) -> ConfigRealtime {
        ConfigRealtime { url, heartbeat_ms: 600_000, join_timeout_ms: 600_000, rejoin_ms: 600_000, reintentos_ms: Vec::new(), vuelta_ms: 20 }
    }

    fn leer(ws: &mut tungstenite::WebSocket<TcpStream>) -> Value {
        loop {
            if let Message::Text(t) = ws.read().unwrap() {
                return serde_json::from_str(&t).unwrap();
            }
        }
    }

    fn enviar(ws: &mut tungstenite::WebSocket<TcpStream>, v: Value) {
        ws.send(Message::text(v.to_string())).unwrap();
    }

    #[test]
    fn une_el_inbox_con_el_token_y_entrega_estado_cambios_y_broadcast() {
        let (url, srv) = servidor();
        let (rt, rx) = Realtime::conectar(cfg(url), Arc::new(|| Some("jwt-1".to_string())));
        rt.unir(Canal::inbox());
        let mut ws = srv.join().unwrap();
        let join = leer(&mut ws);
        assert_eq!((join["event"].as_str(), join["payload"]["access_token"].as_str()), (Some("phx_join"), Some("jwt-1")));
        enviar(&mut ws, json!({"topic": "realtime:sloth-inbox", "event": "phx_reply", "ref": join["ref"], "payload": {"status": "ok", "response": {}}}));
        assert_eq!(rx.recv().unwrap(), EventoRealtime::Estado { canal: "sloth-inbox".into(), estado: EstadoCanal::Subscribed });
        enviar(&mut ws, json!({"topic": "realtime:sloth-inbox", "event": "postgres_changes", "payload": {"data": {"type": "UPDATE", "record": {"id": "m2"}}}}));
        assert_eq!(rx.recv().unwrap(), EventoRealtime::Cambio { canal: "sloth-inbox".into(), tipo: "UPDATE".into(), fila: json!({"id": "m2"}) });
        rt.unir(Canal::privado("team:t1"));
        let join2 = leer(&mut ws);
        assert_eq!((join2["topic"].as_str(), join2["payload"]["config"]["private"].as_bool()), (Some("realtime:team:t1"), Some(true)));
        enviar(&mut ws, json!({"topic": "realtime:team:t1", "event": "broadcast", "payload": {"event": "message", "payload": {"id": "m3"}}}));
        assert_eq!(rx.recv().unwrap(), EventoRealtime::Broadcast { canal: "team:t1".into(), evento: "message".into(), payload: json!({"id": "m3"}) });
        rt.cerrar();
        let a = leer(&mut ws);
        assert!(["phx_leave"].contains(&a["event"].as_str().unwrap()));
    }

    #[test]
    fn un_join_rechazado_es_channel_error_y_una_respuesta_ajena_no_cambia_nada() {
        let (url, srv) = servidor();
        let (rt, rx) = Realtime::conectar(cfg(url), Arc::new(|| None));
        rt.unir(Canal::privado("thread:z"));
        let mut ws = srv.join().unwrap();
        let join = leer(&mut ws);
        enviar(&mut ws, json!({"topic": "realtime:thread:z", "event": "phx_reply", "ref": "999", "payload": {"status": "ok"}}));
        enviar(&mut ws, json!({"topic": "realtime:otro", "event": "broadcast", "payload": {"event": "message", "payload": {}}}));
        enviar(&mut ws, json!({"topic": "realtime:thread:z", "event": "phx_reply", "ref": join["ref"], "payload": {"status": "error", "response": {"reason": "denied"}}}));
        assert_eq!(rx.recv().unwrap(), EventoRealtime::Estado { canal: "thread:z".into(), estado: EstadoCanal::ChannelError });
        rt.cerrar();
    }

    #[test]
    fn salir_manda_phx_leave_y_renovar_token_manda_el_nuevo() {
        let (url, srv) = servidor();
        let (rt, _rx) = Realtime::conectar(cfg(url), Arc::new(|| Some("jwt-2".to_string())));
        rt.unir(Canal::privado("team:a"));
        let mut ws = srv.join().unwrap();
        leer(&mut ws);
        rt.renovar_token();
        let t = leer(&mut ws);
        assert_eq!((t["event"].as_str(), t["payload"]["access_token"].as_str()), (Some("access_token"), Some("jwt-2")));
        rt.salir("team:a");
        let s = leer(&mut ws);
        assert_eq!((s["event"].as_str(), s["topic"].as_str()), (Some("phx_leave"), Some("realtime:team:a")));
        rt.cerrar();
    }

    #[test]
    fn si_el_servidor_corta_los_canales_quedan_cerrados() {
        let (url, srv) = servidor();
        let (rt, rx) = Realtime::conectar(cfg(url), Arc::new(|| None));
        rt.unir(Canal::inbox());
        let mut ws = srv.join().unwrap();
        leer(&mut ws);
        let _ = ws.close(None);
        let _ = ws.flush();
        assert_eq!(rx.recv().unwrap(), EventoRealtime::Estado { canal: "sloth-inbox".into(), estado: EstadoCanal::Closed });
        drop(rt);
    }

    #[test]
    fn un_phx_error_del_canal_avisa_channel_error() {
        let (url, srv) = servidor();
        let (rt, rx) = Realtime::conectar(cfg(url), Arc::new(|| None));
        rt.unir(Canal::inbox());
        let mut ws = srv.join().unwrap();
        leer(&mut ws);
        enviar(&mut ws, json!({"topic": "realtime:sloth-inbox", "event": "phx_error", "payload": {}}));
        assert_eq!(rx.recv().unwrap(), EventoRealtime::Estado { canal: "sloth-inbox".into(), estado: EstadoCanal::ChannelError });
        rt.cerrar();
    }
}
