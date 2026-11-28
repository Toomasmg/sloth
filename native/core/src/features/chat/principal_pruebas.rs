//! Pruebas de `principal` con un Supabase falso (HTTP en memoria) y un entorno que anota lo que se emite.
use super::*;
use crate::features::chat::datos::Canales;
use crate::features::chat::http::pruebas::{json_resp, HttpFalso};
use crate::features::chat::http::Respuesta;
use crate::features::chat::realtime::{Canal, EventoRealtime};
use crate::features::chat::sesion::pruebas::{carpeta, AlmacenFalso};
use crate::features::team_config::leer_team_config;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::mpsc::channel;
use std::sync::Condvar;

const URL: &str = "https://abcdefgh1.supabase.co";
const KEY: &str = "sb_publishable_abcdefgh12345";
const ME: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EQ: &str = "11111111-1111-4111-8111-111111111111";
const CODIGO: &str = "0123456789abcdef";

#[derive(Default)]
struct EntornoFalso {
    emitidos: Mutex<Vec<(String, Value)>>,
    cv: Condvar,
    avisos: Mutex<Vec<String>>,
    abiertas: Mutex<Vec<String>>,
    repos: Mutex<Vec<String>>,
    equipos: Mutex<Vec<(String, Lectura)>>,
    portapapeles: Mutex<String>,
    dir: PathBuf,
    sin_navegador: bool,
}

impl EntornoFalso {
    fn nuevo(n: &str) -> Arc<Self> {
        Arc::new(EntornoFalso { dir: carpeta(n), ..Default::default() })
    }

    /// Espera a que lo emitido cumpla la condición; si nunca pasa, el test falla en vez de colgarse.
    fn esperar(&self, f: impl Fn(&[(String, Value)]) -> bool) {
        let mut g = self.emitidos.lock().unwrap();
        while !f(&g) {
            let (n, r) = self.cv.wait_timeout(g, std::time::Duration::from_secs(30)).unwrap();
            g = n;
            assert!(!r.timed_out(), "no llegó lo esperado: {:?}", *g);
        }
    }

    fn con_sesion(&self) {
        self.esperar(|e| e.iter().rev().find(|(c, _)| c == "snapshot").is_some_and(|(_, v)| v["auth"]["status"] == "signedIn"));
    }
}

impl EntornoPrincipal for EntornoFalso {
    fn emitir(&self, canal: &str, payload: Value) {
        self.emitidos.lock().unwrap().push((canal.into(), payload));
        self.cv.notify_all();
    }
    fn log(&self, _: &str) {}
    fn avisar(&self, t: &str) {
        self.avisos.lock().unwrap().push(t.into());
    }
    fn carpeta_features(&self) -> PathBuf {
        self.dir.clone()
    }
    fn repos_de_espacios(&self) -> Vec<String> {
        self.repos.lock().unwrap().clone()
    }
    fn leer_equipo(&self, repo: &str) -> Lectura {
        self.equipos.lock().unwrap().iter().find(|(r, _)| r == repo).map(|(_, l)| l.clone()).unwrap_or(Lectura::Ninguna)
    }
    fn abrir_externo(&self, u: &str) -> Res<()> {
        if self.sin_navegador {
            return Err("no hay navegador".into());
        }
        self.abiertas.lock().unwrap().push(u.into());
        Ok(())
    }
    fn portapapeles(&self) -> String {
        self.portapapeles.lock().unwrap().clone()
    }
    fn version_app(&self) -> String {
        "0.0.0".into()
    }
    fn ahora_ms(&self) -> i64 {
        1_700_000_000_000
    }
    fn ventana_con_foco(&self) -> bool {
        false
    }
    fn ajustes(&self) -> AjustesAviso {
        AjustesAviso { notificar_equipo: false, no_molestar: false }
    }
    fn notificar(&self, _: &str, _: &str, _: &ChatConvRef) {}
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
        let (tx, rx) = channel::<EventoRealtime>();
        std::mem::forget(tx);
        (Arc::new(CanalesMudos) as Arc<dyn Canales>, rx)
    })
}

/// GoTrue y PostgREST de mentira: el canje de `code` solo sirve con «bueno».
fn supabase_falso(p: &Pedido) -> Result<Respuesta, ErrorRed> {
    let u = &p.url;
    if u.contains("grant_type=pkce") {
        let b: Value = serde_json::from_slice(p.cuerpo.as_ref().unwrap()).unwrap();
        return if b["auth_code"] == "bueno" { json_resp(200, json!({"access_token": "jwt", "refresh_token": "r", "expires_in": 3600})) } else { json_resp(400, json!({})) };
    }
    if u.contains("/auth/v1/user") {
        return json_resp(200, json!({"id": ME}));
    }
    if u.contains("/auth/v1/settings") {
        return json_resp(200, json!({"external": {"github": true}}));
    }
    if u.contains("/auth/v1/health") {
        return json_resp(200, json!({}));
    }
    if u.contains("/rest/v1/profiles") {
        return json_resp(200, json!([{"id": ME, "login": "yo", "name": "Yo"}]));
    }
    if u.contains("/rest/v1/team_members") && u.contains("user_id=eq.") {
        return json_resp(200, json!([{"team_id": EQ, "role": "member"}]));
    }
    if u.contains("/rest/v1/teams") && u.contains("id=in.") {
        return json_resp(200, json!([{"id": EQ, "name": "Equipo A", "description": "", "photo_path": null}]));
    }
    if u.contains("/rpc/join_team_by_code") {
        return json_resp(200, json!(EQ));
    }
    json_resp(200, json!([]))
}

fn armar_con(env: Arc<EntornoFalso>, http: Arc<HttpFalso>) -> (Arc<Principal>, Arc<EntornoFalso>) {
    let sesion = Arc::new(Sesion::abrir(&env.dir.join("chat-session.bin"), Arc::new(AlmacenFalso(true)), |_| {}));
    let p = Principal::nuevo(env.clone(), http, sesion, Some(fabrica_muda()));
    p.usar_puertos(vec![0]);
    (p, env)
}

fn armar(n: &str, http: Arc<HttpFalso>) -> (Arc<Principal>, Arc<EntornoFalso>) {
    armar_con(EntornoFalso::nuevo(n), http)
}

fn configurado(n: &str) -> (Arc<Principal>, Arc<EntornoFalso>, Arc<HttpFalso>) {
    let http = HttpFalso::nuevo(supabase_falso);
    let (p, env) = armar(n, http.clone());
    p.guardar_config(&json!({"supabaseUrl": URL, "anonKey": KEY})).unwrap();
    (p, env, http)
}

fn pegar_callback(redirect: &str, code: &str) -> u16 {
    let u = url::Url::parse(redirect).unwrap();
    let mut s = TcpStream::connect((u.host_str().unwrap(), u.port().unwrap())).unwrap();
    write!(s, "GET {}?code={code} HTTP/1.1\r\n\r\n", u.path()).unwrap();
    let mut r = String::new();
    s.read_to_string(&mut r).unwrap();
    r.split_whitespace().nth(1).unwrap().parse().unwrap()
}

fn redirect_de(env: &EntornoFalso) -> String {
    let u = url::Url::parse(env.abiertas.lock().unwrap().last().unwrap()).unwrap();
    u.query_pairs().find(|(k, _)| k == "redirect_to").unwrap().1.into_owned()
}

fn invitacion(url: &str, code: &str) -> Value {
    json!(armar_invitacion(&ChatServerConfig { supabase_url: url.into(), anon_key: KEY.into() }, code, Some("Equipo A")).unwrap())
}

fn entrar(p: &Arc<Principal>, env: &EntornoFalso) {
    p.iniciar_sesion().unwrap();
    assert_eq!(pegar_callback(&redirect_de(env), "bueno"), 200);
    env.con_sesion();
}

// ----- config -----

#[test]
fn sin_config_el_estado_es_unconfigured_y_guardar_la_deja_firmada_y_persistida() {
    let (p, env) = armar("pr-1", HttpFalso::nuevo(supabase_falso));
    assert_eq!(p.estado()["auth"]["status"], "unconfigured");
    let v = p.guardar_config(&json!({"supabaseUrl": format!("{URL}/"), "anonKey": KEY})).unwrap();
    assert_eq!(v["active"]["supabaseUrl"], URL);
    assert_eq!(v["active"]["source"], "settings");
    assert_eq!(v["active"]["keyPreview"], vista_previa_de_key(KEY));
    assert_eq!(p.estado()["auth"]["status"], "signedOut");
    let guardado: Value = serde_json::from_str(&std::fs::read_to_string(env.dir.join("chat.json")).unwrap()).unwrap();
    assert_eq!(guardado["config"], json!({"supabaseUrl": URL, "anonKey": KEY}));
    assert_eq!(p.guardar_config(&Value::Null).unwrap(), json!({}));
    assert_eq!(p.estado()["auth"]["status"], "unconfigured");
    let sin: Value = serde_json::from_str(&std::fs::read_to_string(env.dir.join("chat.json")).unwrap()).unwrap();
    assert!(sin.get("config").is_none());
}

#[test]
fn una_config_invalida_se_rechaza_sin_tocar_lo_guardado() {
    let (p, _) = armar("pr-2", HttpFalso::nuevo(supabase_falso));
    assert!(p.guardar_config(&json!({"supabaseUrl": "http://x.com", "anonKey": KEY})).is_err());
    assert!(p.guardar_config(&json!({"supabaseUrl": URL, "anonKey": "corta"})).is_err());
    assert_eq!(p.obtener_config(), json!({}));
}

#[test]
fn la_config_guardada_vuelve_al_reabrir() {
    let (p, env, http) = configurado("pr-3");
    drop(p);
    let (otra, _) = armar_con(env, http);
    assert_eq!(otra.obtener_config()["active"]["supabaseUrl"], URL);
}

#[test]
fn una_config_guardada_que_no_sirve_se_ignora_con_copia_y_aviso() {
    let env = EntornoFalso::nuevo("pr-4");
    std::fs::write(env.dir.join("chat.json"), r#"{"config":{"supabaseUrl":"http://malo.com","anonKey":"x"}}"#).unwrap();
    let (p, env) = armar_con(env, HttpFalso::nuevo(supabase_falso));
    assert_eq!(p.estado()["auth"]["status"], "unconfigured");
    let avisos = env.avisos.lock().unwrap().clone();
    assert!(avisos.len() == 1 && avisos[0].contains("no es válida") && avisos[0].contains(".bak-"), "{avisos:?}");
}

#[test]
fn un_servidor_propio_se_avisa_una_sola_vez() {
    let env = EntornoFalso::nuevo("pr-5");
    std::fs::write(env.dir.join("chat.json"), json!({"config": {"supabaseUrl": "https://chat.mi-empresa.com", "anonKey": KEY}}).to_string()).unwrap();
    armar_con(env.clone(), HttpFalso::nuevo(supabase_falso));
    assert_eq!(env.avisos.lock().unwrap().len(), 1);
    assert!(env.avisos.lock().unwrap()[0].contains("chat.mi-empresa.com"));
    armar_con(env.clone(), HttpFalso::nuevo(supabase_falso));
    assert_eq!(env.avisos.lock().unwrap().len(), 1, "la segunda vez ya estaba marcado");
}

// ----- team.json -----

fn lectura_con_chat(url: &str, key: &str) -> Lectura {
    let config = leer_team_config(&json!({"formato": "sloth-team", "versión": 1, "equipo": "Equipo A", "chat": {"supabaseUrl": url, "anonKey": key}}).to_string()).unwrap();
    Lectura::Ok { config, hash: "h".into(), hash_ajustes: None, size: 1, mtime_ms: 0.0 }
}

fn con_oferta(n: &str, url: &str) -> (Arc<Principal>, Arc<EntornoFalso>, String) {
    let (p, env) = armar(n, HttpFalso::nuevo(supabase_falso));
    let repo = env.dir.join("repo").to_string_lossy().into_owned();
    env.repos.lock().unwrap().push(repo.clone());
    env.equipos.lock().unwrap().push((repo.clone(), lectura_con_chat(url, KEY)));
    (p, env, repo)
}

#[test]
fn el_team_json_se_ofrece_y_solo_se_usa_si_la_persona_lo_acepta() {
    let (p, _, repo) = con_oferta("pr-6", URL);
    let v = p.obtener_config();
    assert!(v.get("active").is_none());
    assert_eq!(v["offered"], json!({"supabaseUrl": URL, "repo": repo, "teamName": "Equipo A"}));
    assert_eq!(p.estado()["auth"]["status"], "unconfigured");
    assert!(p.aceptar_config_del_equipo(&json!("otra/carpeta")).is_err());
    let v = p.aceptar_config_del_equipo(&json!(repo)).unwrap();
    assert_eq!((v["active"]["source"].as_str(), v["active"]["repo"].as_str()), (Some("team.json"), Some(repo.as_str())));
    assert!(v.get("offered").is_none());
}

#[test]
fn si_el_team_json_cambia_despues_de_ofrecerse_no_se_acepta() {
    let (p, env, repo) = con_oferta("pr-7", URL);
    p.obtener_config();
    env.equipos.lock().unwrap()[0].1 = lectura_con_chat("https://otroproyecto1.supabase.co", KEY);
    assert_eq!(p.aceptar_config_del_equipo(&json!(repo)).unwrap_err(), "El .sloth/team.json cambió desde que se ofreció. Revisalo y probá de nuevo.");
    assert!(p.obtener_config().get("active").is_none());
}

#[test]
fn la_config_de_ajustes_gana_sobre_el_team_json() {
    let (p, env, _) = configurado("pr-8");
    let repo = env.dir.join("repo").to_string_lossy().into_owned();
    env.repos.lock().unwrap().push(repo.clone());
    env.equipos.lock().unwrap().push((repo, lectura_con_chat("https://otroproyecto1.supabase.co", KEY)));
    let v = p.obtener_config();
    assert_eq!(v["active"]["source"], "settings");
    assert!(v.get("offered").is_none());
}

// ----- login -----

#[test]
fn iniciar_sesion_sin_config_dice_que_hay_que_configurar() {
    let (p, _) = armar("pr-9", HttpFalso::nuevo(supabase_falso));
    assert_eq!(p.iniciar_sesion(), Err(SIN_CONFIG.to_string()));
}

#[test]
fn el_login_completo_abre_el_navegador_canjea_el_code_y_deja_la_sesion() {
    let (p, env, _) = configurado("pr-10");
    p.iniciar_sesion().unwrap();
    let u = env.abiertas.lock().unwrap().last().cloned().unwrap();
    assert!(u.starts_with(&format!("{URL}/auth/v1/authorize?provider=github")), "{u}");
    env.esperar(|e| e.iter().any(|(c, v)| c == "snapshot" && v["auth"]["status"] == "signingIn"));
    assert_eq!(pegar_callback(&redirect_de(&env), "bueno"), 200);
    env.con_sesion();
    let s = p.snapshot();
    assert_eq!((s["auth"]["me"]["login"].as_str(), s["auth"]["me"]["id"].as_str()), (Some("yo"), Some(ME)));
    assert!(p.sesion_chat().is_some_and(|s| s.user_id == ME));
    let t = p.probar_conexion();
    assert_eq!(t["ok"], true);
    assert!(t["message"].as_str().unwrap().contains("sesión de yo"));
    p.cerrar();
}

#[test]
fn un_code_falso_avisa_y_cancelar_deja_la_sesion_cerrada() {
    let (p, env, _) = configurado("pr-11");
    p.iniciar_sesion().unwrap();
    assert_eq!(pegar_callback(&redirect_de(&env), "falso"), 400);
    env.esperar(|e| e.iter().any(|(c, v)| c == "snapshot" && v["auth"]["aviso"].is_string()));
    p.cancelar_inicio();
    assert_eq!(p.snapshot()["auth"]["status"], "signedOut");
}

#[test]
fn si_el_navegador_no_abre_el_error_queda_en_auth() {
    let env = Arc::new(EntornoFalso { dir: carpeta("pr-12"), sin_navegador: true, ..Default::default() });
    let (p, _) = armar_con(env, HttpFalso::nuevo(supabase_falso));
    p.guardar_config(&json!({"supabaseUrl": URL, "anonKey": KEY})).unwrap();
    p.iniciar_sesion().unwrap();
    let a = p.snapshot()["auth"].clone();
    assert_eq!((a["status"].as_str(), a["message"].as_str()), (Some("error"), Some("no hay navegador")));
}

#[test]
fn github_deshabilitado_explica_que_activar() {
    let http = HttpFalso::nuevo(|p| if p.url.contains("/auth/v1/settings") { json_resp(200, json!({"external": {"github": false}})) } else { supabase_falso(p) });
    let (p, env) = armar("pr-13", http);
    p.guardar_config(&json!({"supabaseUrl": URL, "anonKey": KEY})).unwrap();
    p.iniciar_sesion().unwrap();
    assert!(env.abiertas.lock().unwrap().is_empty());
    let a = p.snapshot()["auth"].clone();
    assert!(a["message"].as_str().unwrap().starts_with("El login con GitHub no está habilitado"));
}

#[test]
fn cerrar_sesion_olvida_todo_y_deja_la_sesion_marcada_para_esta_config() {
    let (p, env, _) = configurado("pr-14");
    entrar(&p, &env);
    p.cerrar_sesion();
    assert_eq!(p.snapshot()["auth"]["status"], "signedOut");
    assert!(p.sesion_chat().is_none());
    assert_eq!(p.sesion.get_item("sb-abcdefgh1-auth-token"), None);
    assert!(p.sesion.get_item(OWNER_KEY).is_some());
}

#[test]
fn una_sesion_guardada_se_recupera_sin_abrir_el_navegador() {
    let env = EntornoFalso::nuevo("pr-15");
    std::fs::write(env.dir.join("chat.json"), json!({"config": {"supabaseUrl": URL, "anonKey": KEY}}).to_string()).unwrap();
    let sesion = Arc::new(Sesion::abrir(&env.dir.join("chat-session.bin"), Arc::new(AlmacenFalso(true)), |_| {}));
    sesion.set_item(OWNER_KEY, &format!("{URL}|{}", huella_de_key(KEY)));
    sesion.set_item("sb-abcdefgh1-auth-token", &json!({"access_token": "jwt", "refresh_token": "r", "expires_at": 4_000_000_000i64}).to_string());
    let p = Principal::nuevo(env.clone(), HttpFalso::nuevo(supabase_falso), sesion, Some(fabrica_muda()));
    env.con_sesion();
    assert!(env.abiertas.lock().unwrap().is_empty());
    assert_eq!(p.snapshot()["auth"]["me"]["login"], "yo");
    p.cerrar();
}

#[test]
fn una_sesion_de_otro_proyecto_se_descarta_al_arrancar() {
    let env = EntornoFalso::nuevo("pr-16");
    std::fs::write(env.dir.join("chat.json"), json!({"config": {"supabaseUrl": URL, "anonKey": KEY}}).to_string()).unwrap();
    let sesion = Arc::new(Sesion::abrir(&env.dir.join("chat-session.bin"), Arc::new(AlmacenFalso(true)), |_| {}));
    sesion.set_item(OWNER_KEY, "https://otro.supabase.co|x");
    sesion.set_item("sb-abcdefgh1-auth-token", "{\"access_token\":\"ajeno\",\"refresh_token\":\"r\"}");
    let p = Principal::nuevo(env, HttpFalso::nuevo(supabase_falso), sesion.clone(), Some(fabrica_muda()));
    assert_eq!(sesion.get_item("sb-abcdefgh1-auth-token"), None);
    assert_eq!(p.snapshot()["auth"]["status"], "signedOut");
}

#[test]
fn sin_perfil_de_github_la_sesion_se_cierra() {
    let http = HttpFalso::nuevo(|p| if p.url.contains("/rest/v1/profiles") { json_resp(200, json!([])) } else { supabase_falso(p) });
    let (p, env) = armar("pr-17", http);
    p.guardar_config(&json!({"supabaseUrl": URL, "anonKey": KEY})).unwrap();
    p.iniciar_sesion().unwrap();
    pegar_callback(&redirect_de(&env), "bueno");
    env.esperar(|e| e.iter().rev().find(|(c, _)| c == "snapshot").is_some_and(|(_, v)| v["auth"]["status"] == "error"));
    assert_eq!(p.snapshot()["auth"]["message"], "Entrá con GitHub.");
    assert_eq!(p.sesion.get_item("sb-abcdefgh1-auth-token"), None);
}

// ----- probar conexión y validar -----

#[test]
fn la_prueba_de_conexion_traduce_cada_respuesta() {
    let con = |r: Result<Respuesta, ErrorRed>| {
        let http = HttpFalso::nuevo(move |p| if p.url.contains("/auth/v1/health") { r.clone() } else { supabase_falso(p) });
        let (p, _) = armar("pr-18", http);
        assert_eq!(p.probar_conexion()["message"], "Primero guardá la URL y la clave publicable del proyecto.");
        p.guardar_config(&json!({"supabaseUrl": URL, "anonKey": KEY})).unwrap();
        p.probar_conexion()
    };
    let h = "abcdefgh1.supabase.co";
    assert_eq!(con(json_resp(401, json!({})))["message"], "Supabase rechazó la clave. Revisá que sea la anon / publishable key del proyecto.");
    assert_eq!(con(json_resp(404, json!({})))["message"], format!("{h} no responde como un proyecto de Supabase. Revisá la URL."));
    assert_eq!(con(json_resp(502, json!({})))["message"], "Supabase respondió con un error (código 502). Probá de nuevo en un rato.");
    assert_eq!(con(Err(ErrorRed::Timeout))["message"], "Supabase no respondió en 8 segundos. Revisá la conexión a internet.");
    assert_eq!(con(Err(ErrorRed::Conexion("x".into())))["message"], format!("Sin conexión: no se pudo llegar a {h}. Revisá la red o la URL."));
    let sin_sesion = con(json_resp(200, json!({})));
    assert_eq!(sin_sesion["ok"], false);
    assert_eq!(sin_sesion["message"], format!("Conexión correcta con {h}, pero falta la sesión de GitHub. Conectala para usar el chat."));
}

#[test]
fn la_prueba_manda_la_anon_key_con_tope_de_tiempo() {
    let (p, _, http) = configurado("pr-19");
    p.probar_conexion();
    let ped = http.pedidos.lock().unwrap().iter().find(|x| x.url.contains("/auth/v1/health")).cloned().unwrap();
    assert!(ped.cabeceras.contains(&("apikey".to_string(), KEY.to_string())));
    assert_eq!(ped.timeout_ms, 8000);
}

#[test]
fn validar_sin_config_da_un_fallo_y_con_config_corre_los_chequeos_sin_token_de_sesion() {
    let (p, _) = armar("pr-20", HttpFalso::nuevo(supabase_falso));
    let r = p.validar();
    assert_eq!((r[0]["id"].as_str(), r[0]["estado"].as_str()), (Some("config"), Some("fallo")));
    let (p, _, http) = configurado("pr-21");
    let r = p.validar();
    assert!(r.as_array().unwrap().len() > 1);
    assert!(http.pedidos.lock().unwrap().iter().all(|x| x.cabeceras.iter().all(|(k, _)| !k.eq_ignore_ascii_case("authorization"))));
}

// ----- invitaciones -----

#[test]
fn una_invitacion_a_otro_servidor_pide_confirmar_con_su_host() {
    let (p, _, _) = configurado("pr-22");
    let v = p.ver_invitacion(&invitacion("https://otroproyecto1.supabase.co", CODIGO)).unwrap();
    assert_eq!((v["decision"].as_str(), v["host"].as_str(), v["currentHost"].as_str(), v["teamName"].as_str()), (Some("confirmReplace"), Some("otroproyecto1.supabase.co"), Some("abcdefgh1.supabase.co"), Some("Equipo A")));
    let e = p.entrar_con_invitacion(&invitacion("https://otroproyecto1.supabase.co", CODIGO), &json!("signIn")).unwrap_err();
    assert_eq!(e, "Confirmá que querés conectarte a otroproyecto1.supabase.co antes de seguir.");
    assert_eq!(p.obtener_config()["active"]["supabaseUrl"], URL, "sin confirmar no se pisa la config");
}

#[test]
fn una_invitacion_sin_config_confirmada_la_guarda_arranca_el_login_y_canjea_al_volver() {
    let (p, env) = armar("pr-23", HttpFalso::nuevo(supabase_falso));
    let inv = invitacion(URL, CODIGO);
    assert_eq!(p.ver_invitacion(&inv).unwrap()["decision"], "confirmNew");
    assert_eq!(p.entrar_con_invitacion(&inv, &json!("confirmNew")).unwrap(), json!({"kind": "signingIn"}));
    assert_eq!(p.obtener_config()["active"]["supabaseUrl"], URL);
    pegar_callback(&redirect_de(&env), "bueno");
    env.esperar(|e| e.iter().any(|(c, _)| c == "invite"));
    let ev = env.emitidos.lock().unwrap().iter().find(|(c, _)| c == "invite").cloned().unwrap().1;
    assert_eq!(ev["ok"], true);
    assert_eq!(ev["team"]["id"], EQ);
    p.cerrar();
}

#[test]
fn un_servidor_propio_exige_confirmar_atado_al_host() {
    let (p, _) = armar("pr-24", HttpFalso::nuevo(supabase_falso));
    let inv = invitacion("https://chat.mi-empresa.com", CODIGO);
    assert!(p.entrar_con_invitacion(&inv, &json!("confirmNew")).is_err());
    assert!(p.entrar_con_invitacion(&inv, &json!("confirmNew@chat.mi-empresa.com")).is_ok());
    p.cerrar();
}

#[test]
fn con_sesion_y_la_misma_config_la_invitacion_se_canjea_directo() {
    let (p, env, http) = configurado("pr-25");
    entrar(&p, &env);
    let inv = invitacion(URL, CODIGO);
    assert_eq!(p.ver_invitacion(&inv).unwrap()["decision"], "redeem");
    let r = p.entrar_con_invitacion(&inv, &Value::Null).unwrap();
    assert!(http.urls().iter().any(|u| u.contains("/rpc/join_team_by_code")));
    assert_eq!((r["kind"].as_str(), r["team"]["id"].as_str(), r["team"]["name"].as_str()), (Some("joined"), Some(EQ), Some("Equipo A")));
    assert_eq!(p.texto_de_invitacion(&json!(EQ), &Value::Null), Err("Solo el owner o un admin puede invitar.".to_string()));
    p.cerrar();
}

#[test]
fn un_codigo_que_el_servidor_ya_no_reconoce_se_explica() {
    let http = HttpFalso::nuevo(|p| if p.url.contains("/rpc/join_team_by_code") { json_resp(400, json!({"code": "P0001", "message": "El código no existe o ya lo cambiaron."})) } else { supabase_falso(p) });
    let (p, env) = armar("pr-26", http);
    p.guardar_config(&json!({"supabaseUrl": URL, "anonKey": KEY})).unwrap();
    entrar(&p, &env);
    let e = p.entrar_con_invitacion(&invitacion(URL, CODIGO), &Value::Null).unwrap_err();
    assert!(e.starts_with("El código de esta invitación ya no anda"), "{e}");
    p.cerrar();
}

#[test]
fn cancelar_el_login_con_una_invitacion_pendiente_avisa_que_hay_que_pegarla_otra_vez() {
    let (p, env) = armar("pr-27", HttpFalso::nuevo(supabase_falso));
    p.entrar_con_invitacion(&invitacion(URL, CODIGO), &json!("confirmNew")).unwrap();
    p.cancelar_inicio();
    let ev = env.emitidos.lock().unwrap().iter().find(|(c, _)| c == "invite").cloned().unwrap().1;
    assert_eq!(ev["ok"], false);
    assert!(ev["message"].as_str().unwrap().starts_with("Cancelaste el inicio de sesión."));
}

#[test]
fn cambiar_la_config_con_una_invitacion_pendiente_la_descarta_con_aviso() {
    let (p, env) = armar("pr-28", HttpFalso::nuevo(supabase_falso));
    p.entrar_con_invitacion(&invitacion(URL, CODIGO), &json!("confirmNew")).unwrap();
    p.guardar_config(&Value::Null).unwrap();
    let ev = env.emitidos.lock().unwrap().iter().find(|(c, _)| c == "invite").cloned().unwrap().1;
    assert_eq!(ev["message"], "La configuración del chat cambió mientras iniciabas sesión. Pegá la invitación de nuevo.");
}

#[test]
fn el_texto_de_invitacion_exige_config_y_un_equipo_conocido() {
    let (p, _) = armar("pr-29", HttpFalso::nuevo(supabase_falso));
    assert_eq!(p.texto_de_invitacion(&json!(EQ), &Value::Null), Err("El chat no está configurado.".to_string()));
    let (p, _, _) = configurado("pr-30");
    assert_eq!(p.texto_de_invitacion(&json!(EQ), &Value::Null), Err("No encontré ese equipo.".to_string()));
}

#[test]
fn el_portapapeles_solo_devuelve_lo_que_parece_una_invitacion() {
    let (p, env) = armar("pr-31", HttpFalso::nuevo(supabase_falso));
    *env.portapapeles.lock().unwrap() = "hola".into();
    assert_eq!(p.portapapeles_con_invitacion(), None);
    let inv = invitacion(URL, CODIGO).as_str().unwrap().to_string();
    *env.portapapeles.lock().unwrap() = inv.clone();
    assert_eq!(p.portapapeles_con_invitacion(), Some(inv));
}

#[test]
fn el_guardado_se_escribe_con_los_nombres_del_formato_de_siempre() {
    let g = Guardado { config: Some(ChatServerConfig { supabase_url: URL.into(), anon_key: KEY.into() }), aceptada: Some(Aceptada { repo: "r".into(), supabase_url: URL.into(), key_hash: "h".into() }), avisado_host: Some("x.com".into()) };
    assert_eq!(g.a_json(), json!({"config": {"supabaseUrl": URL, "anonKey": KEY}, "accepted": {"repo": "r", "supabaseUrl": URL, "keyHash": "h"}, "avisadoHost": "x.com"}));
}
