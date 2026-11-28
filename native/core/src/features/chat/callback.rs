//! Login con GitHub por Supabase Auth (PKCE) y el servidor loopback del callback. Equivale a chat-auth.ts.
//!  - Escucha SOLO en 127.0.0.1, en el primer puerto libre de la lista; solo atiende GET <ruta>, lo demás es 404.
//!  - Termina cuando un callback con `code` se canjea bien, al cancelar, al vencer el plazo o tras demasiados canjes
//!    fallidos. Los canjes van de a uno, en el orden en que llegan: un `code` falso no le saca el verifier al bueno.
//!  - Cualquier web puede pegarle a este puerto, así que solo termina el login un canje que funciona.
//!  - La respuesta es HTML mínimo con CSP `default-src 'none'`.
use super::auth::{codigo_valido, pagina, respuesta_de_callback, resultado_de_login, ResultadoCallback, ResultadoLogin, Tono, CABECERAS, GITHUB_DESHABILITADO, HOST, LOGIN_TIMEOUT_MS, MAX_CANJES, MAX_EN_COLA};
use super::gotrue::Auth;
use super::Res;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const MAX_PEDIDO: usize = 8 * 1024;
const LECTURA_MS: u64 = 3000;

pub struct OpcionesCallback {
    pub puertos: Vec<u16>,
    pub ruta: String,
    pub timeout_ms: u64,
    pub canjear: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    pub canje_fallido: Option<Arc<dyn Fn() + Send + Sync>>,
    /// Lo pone el servidor al terminar sin éxito: un canje que termina después ya no deja sesión.
    pub cerrado: Arc<AtomicBool>,
}

struct Estado {
    terminado: AtomicBool,
    puerto: u16,
    ruta: String,
    ultimo_error: Mutex<Option<String>>,
    canjes: AtomicU32,
    en_cola: AtomicUsize,
    salida: Sender<ResultadoCallback>,
    despertar: Sender<()>,
    cerrado: Arc<AtomicBool>,
}

impl Estado {
    fn terminar(&self, o: ResultadoCallback) {
        if self.terminado.swap(true, Ordering::SeqCst) {
            return;
        }
        if o != ResultadoCallback::Ok {
            self.cerrado.store(true, Ordering::SeqCst);
        }
        let _ = self.salida.send(o);
        let _ = self.despertar.send(());
        // El accept está bloqueado: una conexión propia lo suelta y el hilo ve `terminado`.
        let _ = TcpStream::connect((HOST, self.puerto));
    }
}

pub struct ServidorCallback {
    pub puerto: u16,
    pub redirect_to: String,
    estado: Arc<Estado>,
    resultado: Mutex<Receiver<ResultadoCallback>>,
}

impl ServidorCallback {
    pub fn cancelar(&self) {
        self.estado.terminar(ResultadoCallback::Cancelado);
    }

    /// Bloquea hasta que el login termina; después el servidor ya se cerró.
    pub fn esperar(&self) -> ResultadoCallback {
        self.resultado.lock().unwrap_or_else(|e| e.into_inner()).recv().unwrap_or(ResultadoCallback::Cancelado)
    }

    #[cfg(test)]
    pub(crate) fn vencer_el_plazo(&self) {
        let ultimo = self.estado.ultimo_error.lock().unwrap().clone();
        self.estado.terminar(ResultadoCallback::VencioElTiempo { ultimo_error: ultimo });
    }
}

fn texto_de_estado(e: u16) -> &'static str {
    match e {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        429 => "Too Many Requests",
        _ => "Error",
    }
}

fn responder(mut s: TcpStream, estado: u16, titulo: &str, texto: &str, tono: Tono) {
    let cuerpo = pagina(titulo, texto, tono);
    let mut r = format!("HTTP/1.1 {estado} {}\r\n", texto_de_estado(estado));
    for (k, v) in CABECERAS {
        r.push_str(&format!("{k}: {v}\r\n"));
    }
    r.push_str(&format!("Content-Length: {}\r\n\r\n{cuerpo}", cuerpo.len()));
    let _ = s.write_all(r.as_bytes());
    let _ = s.flush();
    let _ = s.shutdown(Shutdown::Both);
}

/// Primera línea del pedido: (método, destino). Lee hasta el fin de las cabeceras o el tope.
fn leer_pedido(s: &mut TcpStream) -> Option<(String, String)> {
    let _ = s.set_read_timeout(Some(Duration::from_millis(LECTURA_MS)));
    let mut buf = Vec::new();
    let mut trozo = [0u8; 1024];
    while buf.len() < MAX_PEDIDO && !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        match s.read(&mut trozo) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&trozo[..n]),
        }
    }
    let texto = String::from_utf8_lossy(&buf);
    let mut partes = texto.lines().next()?.split_whitespace();
    Some((partes.next()?.to_string(), partes.next()?.to_string()))
}

enum Trabajo {
    Canje(String, TcpStream),
}

fn atender(mut s: TcpStream, e: &Estado, cola: &Sender<Trabajo>) {
    let no_activa = |s: TcpStream| responder(s, 404, "No encontrado", "Esta dirección ya no está activa.", Tono::Malo);
    if e.terminado.load(Ordering::SeqCst) {
        return no_activa(s);
    }
    let Some((metodo, destino)) = leer_pedido(&mut s) else { return responder(s, 400, "Solicitud inválida", "Probá iniciar sesión de nuevo desde Sloth.", Tono::Malo) };
    let Ok(url) = url::Url::parse(&format!("http://{HOST}{destino}")) else { return responder(s, 400, "Solicitud inválida", "Probá iniciar sesión de nuevo desde Sloth.", Tono::Malo) };
    if metodo != "GET" || url.path() != e.ruta {
        return responder(s, 404, "No encontrado", "Esta dirección no existe.", Tono::Malo);
    }
    let param = |k: &str| url.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned());
    let code = param("code").filter(|c| !c.is_empty());
    let err = param("error_description").or_else(|| param("error")).filter(|c| !c.is_empty());
    if let Some(c) = code.filter(|c| codigo_valido(c)) {
        if e.en_cola.fetch_add(1, Ordering::SeqCst) >= MAX_EN_COLA {
            e.en_cola.fetch_sub(1, Ordering::SeqCst);
            return responder(s, 429, "Demasiados intentos", "Esperá un momento y probá de nuevo desde Sloth.", Tono::Malo);
        }
        let _ = cola.send(Trabajo::Canje(c, s));
        return;
    }
    if let Some(msg) = err {
        *e.ultimo_error.lock().unwrap() = Some("GitHub o Supabase devolvieron un error al iniciar sesión.".into());
        let (estado, t, x, tono) = respuesta_de_callback(None, Some(&msg), false);
        return responder(s, estado, &t, &x, tono);
    }
    let (estado, t, x, tono) = respuesta_de_callback(None, None, false);
    responder(s, estado, &t, &x, tono)
}

fn hilo_de_canjes(e: Arc<Estado>, rx: Receiver<Trabajo>, o: Arc<OpcionesCallback>) {
    for Trabajo::Canje(code, s) in rx {
        e.en_cola.fetch_sub(1, Ordering::SeqCst);
        if e.terminado.load(Ordering::SeqCst) {
            responder(s, 404, "No encontrado", "Esta dirección ya no está activa.", Tono::Malo);
            continue;
        }
        let n = e.canjes.fetch_add(1, Ordering::SeqCst) + 1;
        let ok = (o.canjear)(&code);
        let (estado, t, x, tono) = respuesta_de_callback(Some(ok), None, true);
        responder(s, estado, &t, &x, tono);
        if ok {
            e.terminar(ResultadoCallback::Ok);
            continue;
        }
        *e.ultimo_error.lock().unwrap() = Some("No se pudo completar el login. Probá de nuevo.".into());
        if n >= MAX_CANJES {
            e.terminar(ResultadoCallback::Demasiados);
        } else if let Some(f) = &o.canje_fallido {
            f();
        }
    }
}

/// Levanta el servidor en el primer puerto libre (puerto 0 = cualquiera, para pruebas).
pub fn iniciar_servidor(o: OpcionesCallback) -> Res<ServidorCallback> {
    let mut escucha = None;
    for p in &o.puertos {
        match TcpListener::bind((HOST, *p)) {
            Ok(l) => {
                escucha = Some(l);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse || e.kind() == std::io::ErrorKind::PermissionDenied => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    let Some(l) = escucha else {
        let lista: Vec<String> = o.puertos.iter().map(u16::to_string).collect();
        return Err(format!("Los puertos {} están ocupados. Cerrá lo que los use y probá de nuevo.", lista.join(", ")));
    };
    let puerto = l.local_addr().map_err(|e| e.to_string())?.port();
    let (salida, resultado) = channel();
    let (despertar, dormido) = channel::<()>();
    let estado = Arc::new(Estado {
        terminado: AtomicBool::new(false),
        puerto,
        ruta: o.ruta.clone(),
        ultimo_error: Mutex::new(None),
        canjes: AtomicU32::new(0),
        en_cola: AtomicUsize::new(0),
        salida,
        despertar,
        cerrado: o.cerrado.clone(),
    });
    let redirect_to = format!("http://{HOST}:{puerto}{}", o.ruta);
    let plazo = Duration::from_millis(if o.timeout_ms == 0 { LOGIN_TIMEOUT_MS as u64 } else { o.timeout_ms });
    let o = Arc::new(o);

    let (cola, trabajos) = channel();
    let (e2, o2) = (estado.clone(), o.clone());
    std::thread::spawn(move || hilo_de_canjes(e2, trabajos, o2));

    let e3 = estado.clone();
    std::thread::spawn(move || {
        if dormido.recv_timeout(plazo).is_err() {
            let ultimo = e3.ultimo_error.lock().unwrap().clone();
            e3.terminar(ResultadoCallback::VencioElTiempo { ultimo_error: ultimo });
        }
    });

    let e4 = estado.clone();
    std::thread::spawn(move || {
        for s in l.incoming().flatten() {
            if e4.terminado.load(Ordering::SeqCst) {
                break;
            }
            let (e5, c) = (e4.clone(), cola.clone());
            std::thread::spawn(move || atender(s, &e5, &c));
        }
    });

    Ok(ServidorCallback { puerto, redirect_to, estado, resultado: Mutex::new(resultado) })
}

pub struct DepsLogin {
    pub auth: Arc<Auth>,
    /// Host de la configuración: el navegador solo se abre para ese host.
    pub host: String,
    pub puertos: Vec<u16>,
    pub ruta: String,
    pub abrir_externo: Box<dyn Fn(&str) -> Res<()> + Send + Sync>,
    pub preservar_verificador: Option<Arc<dyn Fn() -> Box<dyn FnOnce() + Send> + Send + Sync>>,
    pub canje_fallido: Option<Arc<dyn Fn() + Send + Sync>>,
    /// `GET /auth/v1/settings`: `None` si no se pudo saber (no frena el login).
    pub github_habilitado: Option<Box<dyn Fn() -> Option<bool> + Send + Sync>>,
    pub timeout_ms: u64,
}

pub struct LoginGithub {
    servidor: ServidorCallback,
}

impl LoginGithub {
    pub fn cancelar(&self) {
        self.servidor.cancelar();
    }

    pub fn esperar(&self) -> ResultadoLogin {
        resultado_de_login(&self.servidor.esperar())
    }

    #[cfg(test)]
    pub(crate) fn servidor(&self) -> &ServidorCallback {
        &self.servidor
    }
}

/// Inicia el login: levanta el callback, arma la URL (PKCE), la abre en el navegador y espera. Al recibir el `code` lo
/// canjea por sesión.
pub fn iniciar_login_github(d: DepsLogin) -> Res<LoginGithub> {
    // Sin esto, el navegador muestra el JSON crudo de Supabase («provider is not enabled»).
    if d.github_habilitado.as_ref().and_then(|f| f()) == Some(false) {
        return Err(GITHUB_DESHABILITADO.into());
    }
    let cerrado = Arc::new(AtomicBool::new(false));
    let (auth, preservar, flag) = (d.auth.clone(), d.preservar_verificador.clone(), cerrado.clone());
    let canjear = move |code: &str| {
        let restaurar = preservar.as_ref().map(|p| p());
        let ok = auth.canjear_codigo(code);
        if !ok {
            if let Some(r) = restaurar {
                r();
            }
        }
        // Un canje que termina después de cancelar o de vencer el plazo no deja una sesión que la UI no muestra.
        if ok && flag.load(Ordering::SeqCst) {
            auth.cerrar_sesion_local();
            return false;
        }
        ok
    };
    let servidor = iniciar_servidor(OpcionesCallback { puertos: d.puertos, ruta: d.ruta, timeout_ms: d.timeout_ms, canjear: Arc::new(canjear), canje_fallido: d.canje_fallido, cerrado })?;
    let abrir = || -> Res<()> {
        let url = d.auth.url_de_login_github(&servidor.redirect_to).map_err(|_| "No se pudo iniciar el login con GitHub.".to_string())?;
        let u = url::Url::parse(&url).map_err(|_| "No se pudo iniciar el login con GitHub.".to_string())?;
        if u.scheme() != "https" || u.host_str() != Some(d.host.as_str()) {
            return Err("El login devolvió una dirección inesperada.".into());
        }
        (d.abrir_externo)(u.as_str())
    };
    if let Err(e) = abrir() {
        servidor.cancelar();
        return Err(e);
    }
    Ok(LoginGithub { servidor })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::chat::http::pruebas::{json_resp, HttpFalso};
    use crate::features::chat::sesion::pruebas::{carpeta, AlmacenFalso};
    use crate::features::chat::sesion::Sesion;
    use serde_json::json;

    fn pegar(puerto: u16, query: &str) -> u16 {
        let mut s = TcpStream::connect((HOST, puerto)).unwrap();
        write!(s, "GET /auth/callback{query} HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        let mut r = String::new();
        s.read_to_string(&mut r).unwrap();
        r.split_whitespace().nth(1).unwrap().parse().unwrap()
    }

    fn opciones(canjear: impl Fn(&str) -> bool + Send + Sync + 'static) -> OpcionesCallback {
        OpcionesCallback { puertos: vec![0], ruta: "/auth/callback".into(), timeout_ms: 600_000, canjear: Arc::new(canjear), canje_fallido: None, cerrado: Arc::default() }
    }

    #[test]
    fn un_error_o_un_canje_que_falla_no_cortan_el_login_uno_que_funciona_si() {
        let canjes = Arc::new(Mutex::new(Vec::<String>::new()));
        let c = canjes.clone();
        let srv = iniciar_servidor(opciones(move |code| {
            c.lock().unwrap().push(code.to_string());
            code == "bueno"
        }))
        .unwrap();
        assert_eq!(pegar(srv.puerto, "?error=x"), 400);
        assert_eq!(pegar(srv.puerto, "?code=falso"), 400);
        assert_eq!(pegar(srv.puerto, "?code=bueno"), 200);
        assert_eq!(srv.esperar(), ResultadoCallback::Ok);
        assert_eq!(*canjes.lock().unwrap(), ["falso", "bueno"]);
    }

    #[test]
    fn un_callback_sin_codigo_o_con_codigo_raro_no_termina_y_otra_ruta_es_404() {
        let srv = iniciar_servidor(opciones(|_| unreachable!("no hay code válido"))).unwrap();
        assert_eq!(pegar(srv.puerto, ""), 400);
        assert_eq!(pegar(srv.puerto, "?code=a%20b"), 400);
        let mut s = TcpStream::connect((HOST, srv.puerto)).unwrap();
        write!(s, "GET /otra HTTP/1.1\r\n\r\n").unwrap();
        let mut r = String::new();
        s.read_to_string(&mut r).unwrap();
        assert!(r.starts_with("HTTP/1.1 404"), "{r}");
        let mut p = TcpStream::connect((HOST, srv.puerto)).unwrap();
        write!(p, "POST /auth/callback?code=x HTTP/1.1\r\n\r\n").unwrap();
        let mut r2 = String::new();
        p.read_to_string(&mut r2).unwrap();
        assert!(r2.starts_with("HTTP/1.1 404"), "{r2}");
        srv.cancelar();
    }

    #[test]
    fn las_respuestas_llevan_csp_sin_cache_y_cierran_la_conexion() {
        let srv = iniciar_servidor(opciones(|_| false)).unwrap();
        let mut s = TcpStream::connect((HOST, srv.puerto)).unwrap();
        write!(s, "GET /auth/callback?code=falso HTTP/1.1\r\n\r\n").unwrap();
        let mut r = String::new();
        s.read_to_string(&mut r).unwrap();
        for h in ["content-security-policy: default-src 'none'", "cache-control: no-store", "connection: close", "x-content-type-options: nosniff"] {
            assert!(r.to_lowercase().contains(h), "{h}\n{r}");
        }
        assert!(r.contains("No se pudo completar"));
        srv.cancelar();
    }

    #[test]
    fn al_vencer_el_plazo_informa_el_ultimo_error() {
        let srv = iniciar_servidor(opciones(|_| false)).unwrap();
        pegar(srv.puerto, "?code=falso");
        srv.vencer_el_plazo();
        match srv.esperar() {
            ResultadoCallback::VencioElTiempo { ultimo_error } => assert!(ultimo_error.unwrap().contains("No se pudo completar")),
            o => panic!("{o:?}"),
        }
    }

    #[test]
    fn cancelar_resuelve_cancelado_y_cierra_el_puerto() {
        let srv = iniciar_servidor(opciones(|_| true)).unwrap();
        let puerto = srv.puerto;
        srv.cancelar();
        assert_eq!(srv.esperar(), ResultadoCallback::Cancelado);
        assert!(srv.estado.cerrado.load(Ordering::SeqCst));
        assert_ne!(puerto, 0);
    }

    #[test]
    fn tras_demasiados_canjes_fallidos_termina_el_login() {
        let srv = iniciar_servidor(opciones(|_| false)).unwrap();
        for _ in 0..MAX_CANJES {
            pegar(srv.puerto, "?code=falso");
        }
        assert_eq!(srv.esperar(), ResultadoCallback::Demasiados);
    }

    #[test]
    fn todos_los_puertos_ocupados_es_un_error_claro() {
        let ocupado = TcpListener::bind((HOST, 0)).unwrap();
        let p = ocupado.local_addr().unwrap().port();
        let mut o = opciones(|_| true);
        o.puertos = vec![p];
        let e = iniciar_servidor(o).err().unwrap();
        assert_eq!(e, format!("Los puertos {p} están ocupados. Cerrá lo que los use y probá de nuevo."));
    }

    #[test]
    fn el_primer_puerto_ocupado_pasa_al_siguiente() {
        let ocupado = TcpListener::bind((HOST, 0)).unwrap();
        let p = ocupado.local_addr().unwrap().port();
        let mut o = opciones(|_| true);
        o.puertos = vec![p, 0];
        let srv = iniciar_servidor(o).unwrap();
        assert_ne!(srv.puerto, p);
        srv.cancelar();
    }

    #[test]
    fn el_canje_fallido_avisa_pero_el_ultimo_no_si_ya_termino() {
        let avisos = Arc::new(AtomicUsize::new(0));
        let a = avisos.clone();
        let mut o = opciones(|_| false);
        o.canje_fallido = Some(Arc::new(move || {
            a.fetch_add(1, Ordering::SeqCst);
        }));
        let srv = iniciar_servidor(o).unwrap();
        pegar(srv.puerto, "?code=falso");
        assert_eq!(avisos.load(Ordering::SeqCst), 1);
        srv.cancelar();
    }

    // ----- login con GoTrue de mentira -----

    fn auth_con(http: Arc<HttpFalso>) -> (Arc<Auth>, Arc<Sesion>) {
        let ses = Arc::new(Sesion::abrir(&carpeta("cb").join("s.bin"), Arc::new(AlmacenFalso(true)), |_| {}));
        (Arc::new(Auth::nuevo(http, "https://x.supabase.co", "anon", ses.clone(), || 1000)), ses)
    }

    /// GoTrue falso: acepta el canje solo si el `code` es «bueno» y borra nada (el borrado del verifier es de `Auth`).
    fn http_gotrue() -> Arc<HttpFalso> {
        HttpFalso::nuevo(|p| {
            if p.url.contains("grant_type=pkce") {
                let b: serde_json::Value = serde_json::from_slice(p.cuerpo.as_ref().unwrap()).unwrap();
                return if b["auth_code"] == "bueno" { json_resp(200, json!({"access_token": "a", "refresh_token": "r", "expires_in": 3600})) } else { json_resp(400, json!({})) };
            }
            json_resp(200, json!({}))
        })
    }

    fn deps(auth: Arc<Auth>, ses: &Arc<Sesion>, abrir: impl Fn(&str) -> Res<()> + Send + Sync + 'static) -> DepsLogin {
        let s = ses.clone();
        DepsLogin {
            auth,
            host: "x.supabase.co".into(),
            puertos: vec![0],
            ruta: "/auth/callback".into(),
            abrir_externo: Box::new(abrir),
            preservar_verificador: Some(Arc::new(move || s.preservar_verificador())),
            canje_fallido: None,
            github_habilitado: None,
            timeout_ms: 600_000,
        }
    }

    #[test]
    fn con_github_deshabilitado_no_abre_el_navegador_y_explica_que_activar() {
        let (auth, ses) = auth_con(HttpFalso::nuevo(|_| unreachable!()));
        let abrio = Arc::new(AtomicBool::new(false));
        let a = abrio.clone();
        let mut d = deps(auth, &ses, move |_| {
            a.store(true, Ordering::SeqCst);
            Ok(())
        });
        d.github_habilitado = Some(Box::new(|| Some(false)));
        assert_eq!(iniciar_login_github(d).err().unwrap(), GITHUB_DESHABILITADO);
        assert!(!abrio.load(Ordering::SeqCst));
        assert_eq!(ses.tamano(), 0, "ni siquiera guardó un verifier");
    }

    #[test]
    fn el_navegador_solo_se_abre_para_el_host_de_la_config() {
        let (auth, ses) = auth_con(http_gotrue());
        let mut d = deps(auth, &ses, |_| panic!("no tendría que abrir"));
        d.host = "otro.host".into();
        assert_eq!(iniciar_login_github(d).err().unwrap(), "El login devolvió una dirección inesperada.");
    }

    #[test]
    fn un_code_falso_que_llega_antes_no_le_quita_el_verifier_al_bueno() {
        let (auth, ses) = auth_con(http_gotrue());
        let fallidos = Arc::new(AtomicUsize::new(0));
        let f = fallidos.clone();
        let abierta = Arc::new(Mutex::new(String::new()));
        let ab = abierta.clone();
        let mut d = deps(auth.clone(), &ses, move |u| {
            *ab.lock().unwrap() = u.to_string();
            Ok(())
        });
        d.canje_fallido = Some(Arc::new(move || {
            f.fetch_add(1, Ordering::SeqCst);
        }));
        let l = iniciar_login_github(d).unwrap();
        assert!(abierta.lock().unwrap().starts_with("https://x.supabase.co/auth/v1/authorize?provider=github"));
        let puerto = l.servidor().puerto;
        assert_eq!(pegar(puerto, "?code=falso"), 400);
        assert_eq!(fallidos.load(Ordering::SeqCst), 1);
        assert_eq!(pegar(puerto, "?code=bueno"), 200);
        assert_eq!(l.esperar(), ResultadoLogin::Ok);
        assert_eq!(auth.token_de_acceso().as_deref(), Some("a"));
    }

    #[test]
    fn un_canje_que_termina_despues_de_cancelar_cierra_esa_sesion() {
        let (empezo_tx, empezo_rx) = std::sync::mpsc::channel::<()>();
        let (suelta_tx, suelta_rx) = std::sync::mpsc::channel::<()>();
        let (empezo_tx, suelta_rx) = (Mutex::new(empezo_tx), Mutex::new(suelta_rx));
        let http = HttpFalso::nuevo(move |p| {
            if p.url.contains("grant_type=pkce") {
                empezo_tx.lock().unwrap().send(()).unwrap();
                suelta_rx.lock().unwrap().recv().unwrap();
                return json_resp(200, json!({"access_token": "a", "refresh_token": "r", "expires_in": 3600}));
            }
            json_resp(200, json!({}))
        });
        let (auth, ses) = auth_con(http.clone());
        let l = iniciar_login_github(deps(auth.clone(), &ses, |_| Ok(()))).unwrap();
        let puerto = l.servidor().puerto;
        let pegado = std::thread::spawn(move || pegar(puerto, "?code=bueno"));
        empezo_rx.recv().unwrap();
        l.cancelar();
        assert_eq!(l.esperar(), ResultadoLogin::Cancelado);
        suelta_tx.send(()).unwrap();
        assert_eq!(pegado.join().unwrap(), 400);
        assert_eq!(auth.token_de_acceso(), None);
        assert!(http.urls().iter().any(|u| u.ends_with("/auth/v1/logout?scope=local")));
    }

    #[test]
    fn si_no_se_pudo_abrir_el_navegador_se_cierra_el_servidor_y_se_propaga() {
        let (auth, ses) = auth_con(http_gotrue());
        let e = iniciar_login_github(deps(auth, &ses, |_| Err("no hay navegador".into()))).err().unwrap();
        assert_eq!(e, "no hay navegador");
    }
}
