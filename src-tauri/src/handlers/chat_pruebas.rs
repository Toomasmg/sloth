//! Pruebas de los canales `feat:chat:*` sobre el router, con un Supabase falso, Realtime mudo y el proceso de apoyo
//! simulado (terminales, avisos y la sesión para «celular»).
use super::*;
use crate::tests_comunes::{EntornoDePrueba, ReenvioNulo};
use sloth_core::features::chat::config::huella_de_key;
use sloth_core::features::chat::datos::Canales;
use sloth_core::features::chat::gotrue::clave_de_almacenamiento;
use sloth_core::features::chat::http::{ErrorRed, Respuesta as RespuestaHttp};
use sloth_core::features::chat::realtime::{Canal, EventoRealtime};
use std::fs;
use std::time::Instant;

const URL: &str = "https://abcdefgh1.supabase.co";
const KEY: &str = "sb_publishable_abcdefgh12345";
const ME: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EQ: &str = "11111111-1111-4111-8111-111111111111";

type Manejador = Box<dyn Fn(&Pedido) -> Result<RespuestaHttp, ErrorRed> + Send + Sync>;

struct HttpFalso {
    f: Manejador,
    pedidos: Mutex<Vec<Pedido>>,
}

impl Http for HttpFalso {
    fn pedir(&self, p: &Pedido) -> Result<RespuestaHttp, ErrorRed> {
        self.pedidos.lock().unwrap().push(p.clone());
        (self.f)(p)
    }
}

fn resp(estado: u16, v: Value) -> Result<RespuestaHttp, ErrorRed> {
    Ok(RespuestaHttp { estado, cuerpo: v.to_string().into_bytes() })
}

/// GoTrue y PostgREST de mentira, como los de las pruebas del núcleo.
fn supabase_falso(p: &Pedido) -> Result<RespuestaHttp, ErrorRed> {
    let u = &p.url;
    if u.contains("/auth/v1/logout") {
        return Ok(RespuestaHttp { estado: 204, cuerpo: vec![] });
    }
    if u.contains("/auth/v1/user") {
        return resp(200, json!({ "id": ME }));
    }
    if u.contains("/auth/v1/health") {
        return resp(200, json!({}));
    }
    if u.contains("/rest/v1/profiles") {
        return resp(200, json!([{ "id": ME, "login": "yo", "name": "Yo" }]));
    }
    if u.contains("/rest/v1/team_members") && u.contains("user_id=eq.") {
        return resp(200, json!([{ "team_id": EQ, "role": "member" }]));
    }
    if u.contains("/rest/v1/teams") && u.contains("id=in.") {
        return resp(200, json!([{ "id": EQ, "name": "Equipo A", "description": "", "photo_path": null }]));
    }
    resp(200, json!([]))
}

struct AlmacenFalso;
impl AlmacenSecreto for AlmacenFalso {
    fn disponible(&self) -> bool {
        true
    }
    fn cifrar(&self, plano: &str) -> Result<Vec<u8>, String> {
        Ok(plano.bytes().map(|b| b ^ 0x5a).collect())
    }
    fn descifrar(&self, c: &[u8]) -> Result<String, String> {
        String::from_utf8(c.iter().map(|b| b ^ 0x5a).collect()).map_err(|_| "basura".to_string())
    }
}

struct CanalesMudos;
impl Canales for CanalesMudos {
    fn unir(&self, _: Canal) {}
    fn salir(&self, _: &str) {}
    fn renovar_token(&self) {}
    fn cerrar(&self) {}
}

fn fabrica_muda() -> Fabrica {
    Arc::new(|_| {
        let (tx, rx) = std::sync::mpsc::channel::<EventoRealtime>();
        std::mem::forget(tx);
        (Arc::new(CanalesMudos) as Arc<dyn Canales>, rx)
    })
}

type Anotados = Arc<Mutex<Vec<(String, Value)>>>;

struct Prueba {
    t: EntornoDePrueba,
    router: Router,
    chat: Arc<Chat>,
    http: Arc<HttpFalso>,
    al_apoyo: Anotados,
    avisos_sistema: Anotados,
    terminales: Arc<Mutex<Value>>,
}

impl Prueba {
    fn features(&self) -> PathBuf {
        self.t.carpeta.join("perfil").join("features")
    }

    async fn pedir(&self, op: &str, args: Vec<Value>) -> Respuesta {
        self.router.invocar(format!("feat:chat:{op}"), args).await
    }

    /// Espera a que algo que pasa en otro hilo (restaurar la sesión, registrar el MCP) se vea; si nunca pasa, falla.
    async fn esperar(&self, que: &str, f: impl Fn(&Prueba) -> bool) {
        let inicio = Instant::now();
        while !f(self) {
            assert!(inicio.elapsed() < Duration::from_secs(30), "no pasó: {que}\neventos: {:?}", self.t.eventos());
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }

    fn ultimo_evento(&self, canal: &str) -> Option<Value> {
        self.t.eventos().into_iter().rev().find(|(c, _)| c == canal).and_then(|(_, a)| a.into_iter().next())
    }

    fn estado_mcp(&self, cuenta: &str) -> Option<Value> {
        let v = self.ultimo_evento("feat:chat:mcpConfig")?;
        v["accounts"].as_array()?.iter().find(|a| a["accountId"] == cuenta).cloned()
    }
}

fn armar_prueba(nombre: &str, exe: Option<&str>) -> Prueba {
    let t = EntornoDePrueba::nuevo(nombre);
    let http = Arc::new(HttpFalso { f: Box::new(supabase_falso), pedidos: Mutex::new(vec![]) });
    let al_apoyo: Anotados = Arc::default();
    let anotar = al_apoyo.clone();
    t.entorno.fijar_eventos_al_apoyo(Arc::new(move |n, a| anotar.lock().unwrap().push((n.to_string(), a))));
    let avisos_sistema: Anotados = Arc::default();
    let anotar = avisos_sistema.clone();
    t.entorno.fijar_notificador(Arc::new(move |titulo, cuerpo| anotar.lock().unwrap().push((titulo.to_string(), json!(cuerpo)))));
    let terminales = Arc::new(Mutex::new(json!({ "conocidas": true, "ocupada": true })));
    let resp_terminales = terminales.clone();
    t.fijar_apoyo(move |canal, _| if canal == "pty:cuentaOcupada" { Ok(resp_terminales.lock().unwrap().clone()) } else { Err(format!("Sin handler para {canal}")) });
    if let Ok(h) = tokio::runtime::Handle::try_current() {
        t.entorno.fijar_runtime(h);
    }
    let exe = exe.map(String::from);
    let opciones = Opciones {
        http: http.clone(),
        fabrica: Some(fabrica_muda()),
        almacen: Some(Arc::new(AlmacenFalso)),
        puertos: Some(vec![0]),
        exe_claude: Some(Arc::new(move || exe.clone())),
    };
    let chat = armar(t.entorno.clone(), opciones);
    let mut router = Router::nuevo(Arc::new(ReenvioNulo));
    registrar_canales(&mut router, &chat);
    Prueba { t, router, chat, http, al_apoyo, avisos_sistema, terminales }
}

fn guardar_config(p: &Prueba) {
    fs::create_dir_all(p.features()).unwrap();
    fs::write(p.features().join("chat.json"), json!({ "config": { "supabaseUrl": URL, "anonKey": KEY } }).to_string()).unwrap();
}

/// Una sesión guardada como la deja el login con GitHub (cifrada con el almacén de la prueba).
fn guardar_sesion(p: &Prueba) {
    fs::create_dir_all(p.features()).unwrap();
    let s = Sesion::abrir(&p.features().join("chat-session.bin"), Arc::new(AlmacenFalso), |_| {});
    s.set_item("sloth:owner", &format!("{URL}|{}", huella_de_key(KEY)));
    let vence = ahora_ms() / 1000 + 3600;
    s.set_item(&clave_de_almacenamiento(URL), &json!({ "access_token": "jwt", "refresh_token": "r", "expires_in": 3600, "expires_at": vence, "token_type": "bearer" }).to_string());
}

#[tokio::test(flavor = "multi_thread")]
async fn sin_perfil_los_canales_esperan_al_arranque() {
    let t = EntornoDePrueba::sin_perfil("chat-sin-perfil");
    let chat = armar(t.entorno.clone(), Opciones { http: Arc::new(HttpFalso { f: Box::new(supabase_falso), pedidos: Mutex::new(vec![]) }), ..Opciones::default() });
    let mut router = Router::nuevo(Arc::new(ReenvioNulo));
    registrar_canales(&mut router, &chat);
    assert_eq!(router.invocar("feat:chat:state".into(), vec![]).await, Err("Sloth todavía está arrancando.".to_string()));
    assert_eq!(router.invocar("feat:chat:mcpConfig".into(), vec![]).await, Err("Sloth todavía está arrancando.".to_string()));
}

#[tokio::test(flavor = "multi_thread")]
async fn estan_todos_los_canales_del_typescript() {
    let p = armar_prueba("chat-canales", None);
    let ops = [
        "state", "getConfig", "setConfig", "acceptTeamConfig", "test", "validate", "previewInvite", "joinInvite", "clipboardInvite", "inviteText", "signIn", "cancelSignIn", "signOut",
        "setView", "messages", "send", "edit", "remove", "react", "search", "typing", "clear", "setRetention", "markRead", "createTeam", "updateTeam", "members", "inviteByLogin",
        "regenerateCode", "joinByCode", "acceptInvite", "declineInvite", "leaveTeam", "removeMember", "openDm", "mcpConfig", "mcpSetEnabled", "mcpSetAccounts", "mcpRevoke",
        "mcpRevokeAll", "mcpPending", "mcpAnswer",
    ];
    let esperados: Vec<String> = ops.iter().map(|o| format!("feat:chat:{o}")).collect();
    let mut esperados_ord = esperados.clone();
    esperados_ord.sort();
    assert_eq!(p.router.canales(), esperados_ord);
}

#[tokio::test(flavor = "multi_thread")]
async fn sin_config_queda_sin_configurar_y_la_config_se_guarda_en_el_perfil() {
    let p = armar_prueba("chat-config", None);
    let v = p.pedir("state", vec![]).await.unwrap();
    assert_eq!(v["auth"]["status"], json!("unconfigured"));
    assert_eq!(v["connection"], json!("off"));
    let e = p.pedir("setConfig", vec![json!({ "supabaseUrl": URL, "anonKey": "sb_secret_abcdefgh12345" })]).await.unwrap_err();
    assert!(e.contains("secret"), "{e}");
    assert!(!p.features().join("chat.json").exists(), "una config rechazada no se guarda");
    let vista = p.pedir("setConfig", vec![json!({ "supabaseUrl": URL, "anonKey": KEY })]).await.unwrap();
    assert_eq!(vista["active"]["source"], json!("settings"));
    assert_eq!(vista["active"]["supabaseUrl"], json!(URL));
    let guardado: Value = serde_json::from_str(&fs::read_to_string(p.features().join("chat.json")).unwrap()).unwrap();
    assert_eq!(guardado["config"]["anonKey"], json!(KEY));
    assert_eq!(p.ultimo_evento("feat:chat:snapshot").unwrap()["auth"]["status"], json!("signedOut"));
    let prueba = p.pedir("test", vec![]).await.unwrap();
    assert_eq!(prueba["ok"], json!(false));
    assert_eq!(prueba["message"], json!("Conexión correcta con abcdefgh1.supabase.co, pero falta la sesión de GitHub. Conectala para usar el chat."));
    let health = p.http.pedidos.lock().unwrap().iter().find(|x| x.url.ends_with("/auth/v1/health")).cloned().unwrap();
    assert!(health.cabeceras.iter().any(|(k, v)| k == "apikey" && v == KEY));
}

#[tokio::test(flavor = "multi_thread")]
async fn una_invitacion_pide_confirmar_el_servidor_y_se_valida_lo_que_llega() {
    let p = armar_prueba("chat-invitacion", None);
    let token = |v: Value| {
        use base64::Engine;
        format!("sloth-invitacion:v1.{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string()))
    };
    let inv = token(json!({ "url": "https://equipo-prueba.supabase.co", "key": KEY, "code": "0123456789abcdef", "team": "Núcleo" }));
    let vista = p.pedir("previewInvite", vec![json!(format!("Sumate:\n\n{inv}"))]).await.unwrap();
    assert_eq!(vista["host"], json!("equipo-prueba.supabase.co"));
    assert_eq!(vista["decision"], json!("confirmNew"));
    assert_eq!(vista["teamName"], json!("Núcleo"));
    let e = p.pedir("joinInvite", vec![json!(inv), json!("cualquier cosa")]).await.unwrap_err();
    assert_eq!(e, "Confirmá que querés conectarte a equipo-prueba.supabase.co antes de seguir.");
    assert!(!p.features().join("chat.json").exists(), "sin confirmar no se cambia la config");
    assert!(p.pedir("previewInvite", vec![json!(42)]).await.is_err());
    assert_eq!(p.pedir("clipboardInvite", vec![]).await, Ok(Value::Null));
}

#[tokio::test(flavor = "multi_thread")]
async fn con_sesion_guardada_entra_carga_los_equipos_y_avisa_la_sesion_a_celular() {
    let p = armar_prueba("chat-sesion", None);
    guardar_config(&p);
    guardar_sesion(&p);
    p.chat.arrancar().unwrap();
    p.esperar("sesión iniciada", |p| p.ultimo_evento("feat:chat:snapshot").is_some_and(|s| s["auth"]["status"] == "signedIn")).await;
    p.esperar("equipos cargados", |p| p.ultimo_evento("feat:chat:snapshot").is_some_and(|s| s["teams"][0]["name"] == "Equipo A")).await;
    let sesiones: Vec<Value> = p.al_apoyo.lock().unwrap().iter().filter(|(n, _)| n == "chat:sesion").map(|(_, a)| a[0].clone()).collect();
    assert_eq!(sesiones.last().unwrap(), &json!({ "supabaseUrl": URL, "anonKey": KEY, "userId": ME }));
    assert!(!sesiones.iter().any(|s| s.to_string().contains("jwt")), "a celular nunca le llega un token por evento");
    assert_eq!(p.chat.nativo("rust.chat", &[json!("token")]), Some(Ok(json!("jwt"))));
    assert_eq!(p.chat.nativo("rust.chat", &[json!("sesion")]), Some(Ok(json!({ "supabaseUrl": URL, "anonKey": KEY, "userId": ME }))));
    assert_eq!(p.chat.nativo("rust.chat", &[json!("cerrarOtras")]), Some(Ok(Value::Null)));
    let logout = p.http.pedidos.lock().unwrap().iter().find(|x| x.url.contains("/auth/v1/logout")).cloned().unwrap();
    assert_eq!(logout.url, format!("{URL}/auth/v1/logout?scope=others"));
    assert!(logout.cabeceras.iter().any(|(k, v)| k == "authorization" && v == "Bearer jwt"));
    assert!(p.chat.nativo("rust.chat", &[json!("otra")]).unwrap().is_err());
    assert!(p.chat.nativo("rust.otra", &[]).is_none());
    assert_eq!(p.pedir("inviteText", vec![json!(EQ), Value::Null]).await, Err("Solo el owner o un admin puede invitar.".to_string()));
    assert_eq!(p.pedir("messages", vec![json!({ "kind": "team", "id": "no" })]).await.unwrap_err(), "Conversación inválida.");
    p.pedir("signOut", vec![]).await.unwrap();
    assert_eq!(p.ultimo_evento("feat:chat:snapshot").unwrap()["auth"]["status"], json!("signedOut"));
    assert_eq!(p.al_apoyo.lock().unwrap().iter().rev().find(|(n, _)| n == "chat:sesion").unwrap().1, json!([null]));
    assert_eq!(p.chat.nativo("rust.chat", &[json!("token")]), Some(Ok(Value::Null)));
}

#[tokio::test(flavor = "multi_thread")]
async fn una_config_guardada_invalida_se_avisa_a_la_persona() {
    let p = armar_prueba("chat-aviso", None);
    fs::create_dir_all(p.features()).unwrap();
    fs::write(p.features().join("chat.json"), json!({ "config": { "supabaseUrl": "http://x", "anonKey": "" } }).to_string()).unwrap();
    p.pedir("state", vec![]).await.unwrap();
    let avisos: Vec<Value> = p.al_apoyo.lock().unwrap().iter().filter(|(n, _)| n == "aviso").map(|(_, a)| a[0].clone()).collect();
    assert_eq!(avisos.len(), 1, "{avisos:?}");
    assert!(avisos[0].as_str().unwrap().starts_with("La configuración guardada del chat no es válida"));
}

#[tokio::test(flavor = "multi_thread")]
async fn los_ajustes_de_avisos_se_leen_sin_escribirlos() {
    let p = armar_prueba("chat-ajustes", None);
    let env = EntornoChat { entorno: p.t.entorno.clone(), carpeta_features: p.features(), principal: OnceLock::new(), sesion_avisada: Mutex::new(None) };
    assert_eq!(env.ajustes(), AjustesAviso { notificar_equipo: true, no_molestar: false });
    fs::create_dir_all(p.features()).unwrap();
    let texto = json!({ "noMolestar": true, "notify": { "team": false } }).to_string();
    fs::write(p.features().join("settings.json"), &texto).unwrap();
    assert_eq!(env.ajustes(), AjustesAviso { notificar_equipo: false, no_molestar: true });
    assert_eq!(fs::read_to_string(p.features().join("settings.json")).unwrap(), texto);
    env.notificar("yo · Equipo A", "hola", &ChatConvRef::equipo(EQ));
    assert_eq!(*p.avisos_sistema.lock().unwrap(), vec![("yo · Equipo A".to_string(), json!("hola"))]);
}

#[tokio::test(flavor = "multi_thread")]
async fn el_mcp_valida_lo_que_llega_y_no_ofrece_cuentas_sin_mcp() {
    let p = armar_prueba("chat-mcp-validar", None);
    let dir = p.t.carpeta.join("cuentas");
    p.t.fijar_estado(&json!({ "version": 1, "accounts": [
        { "id": "a1", "label": "Trabajo", "configDir": dir.join("a1").to_string_lossy() },
        { "id": "c1", "label": "Otra", "configDir": dir.join("c1").to_string_lossy(), "proveedor": "codex" }
    ], "workspaces": [] }));
    let v = p.pedir("mcpConfig", vec![]).await.unwrap();
    assert_eq!(v["enabled"], json!(false));
    assert_eq!(v["accounts"].as_array().unwrap().len(), 2);
    assert_eq!(p.pedir("mcpSetEnabled", vec![json!("sí")]).await, Err("Valor inválido.".to_string()));
    assert_eq!(p.pedir("mcpSetAccounts", vec![json!(["c1"])]).await, Err("La cuenta «Otra» es de Codex: el chat con MCP todavía no está disponible.".to_string()));
    assert_eq!(p.pedir("mcpRevoke", vec![json!(5), json!("team:x")]).await, Err("Cuenta inválida.".to_string()));
    assert_eq!(p.pedir("mcpRevoke", vec![json!("a1"), json!("nada")]).await, Err("Conversación inválida.".to_string()));
    assert_eq!(p.pedir("mcpAnswer", vec![json!(""), json!("once")]).await, Err("Pedido inválido.".to_string()));
    assert_eq!(p.pedir("mcpAnswer", vec![json!("x"), json!("quizás")]).await, Err("Respuesta inválida.".to_string()));
    assert_eq!(p.pedir("mcpPending", vec![]).await, Ok(json!([])));
}

#[cfg(windows)]
fn preguntar_al_canal(canal: &str, linea: &str) -> Value {
    use std::io::{Read, Write};
    let mut s = fs::OpenOptions::new().read(true).write(true).open(canal).unwrap();
    s.write_all(format!("{linea}\n").as_bytes()).unwrap();
    let mut r = String::new();
    s.read_to_string(&mut r).unwrap();
    serde_json::from_str(r.trim()).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn el_mcp_abre_el_canal_local_y_registra_solo_con_la_cuenta_libre() {
    let p = armar_prueba("chat-mcp-registro", Some("C:/no-existe/claude.exe"));
    let cuenta = p.t.carpeta.join("cuentas").join("a1");
    fs::create_dir_all(&cuenta).unwrap();
    let a1 = json!({ "id": "a1", "label": "Trabajo", "configDir": cuenta.to_string_lossy() });
    p.t.fijar_estado(&json!({ "version": 1, "accounts": [a1.clone()], "workspaces": [] }));

    p.pedir("mcpSetEnabled", vec![json!(true)]).await.unwrap();
    let info = p.t.carpeta.join("chat-mcp.json");
    let canal = serde_json::from_str::<Value>(&fs::read_to_string(&info).unwrap()).unwrap()["pipe"].as_str().unwrap().to_string();
    let cfg: Value = serde_json::from_str(&fs::read_to_string(p.features().join("chat-mcp.json")).unwrap()).unwrap();
    assert_eq!(cfg["enabled"], json!(true));
    #[cfg(windows)]
    {
        let r = preguntar_al_canal(&canal, "esto no es json");
        assert_eq!(r["ok"], json!(false), "{r}");
    }
    let _ = &canal;

    p.pedir("mcpSetAccounts", vec![json!(["a1"])]).await.unwrap();
    p.esperar("falta sloth-hook", |p| p.estado_mcp("a1").is_some_and(|a| a["state"] == "error" && a["detail"].as_str().unwrap_or("").contains("sloth-hook"))).await;

    fs::create_dir_all(p.t.carpeta.join("bin")).unwrap();
    fs::write(p.t.carpeta.join("bin").join("sloth-hook.exe"), b"").unwrap();
    p.chat.al_evento("cuentaPreparada", &a1);
    p.esperar("pendiente por terminales abiertas", |p| p.estado_mcp("a1").is_some_and(|a| a["state"] == "pendiente" && a["detail"] == "Se aplica cuando cierres las terminales de esta cuenta.")).await;

    *p.terminales.lock().unwrap() = json!({ "conocidas": true, "ocupada": false });
    p.chat.al_evento("terminalCerrada", &Value::Null);
    p.esperar("intentó correr el CLI", |p| p.estado_mcp("a1").is_some_and(|a| a["state"] == "error" && a["detail"].as_str().unwrap_or("").starts_with("Claude Code no pudo cambiar su config"))).await;
    assert!(!cuenta.join(".claude.json").exists(), "sin CLI no se toca la config de la cuenta");

    p.chat.al_evento("cuentaPreparada", &json!({ "id": 7 }));
    p.pedir("mcpSetEnabled", vec![json!(false)]).await.unwrap();
    assert!(!info.exists(), "apagado no queda el canal anunciado");
    p.pedir("mcpSetEnabled", vec![json!(true)]).await.unwrap();
    assert!(info.exists());
    p.chat.al_salir();
    assert!(!info.exists(), "al salir se borra el anuncio del canal");
    assert_eq!(p.chat.piezas().map(|_| ()).err(), None, "lo ya armado sigue respondiendo hasta que cierre la app");
}
