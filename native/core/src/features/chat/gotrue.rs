//! GoTrue (Supabase Auth) sin supabase-js: login con GitHub por PKCE, canje del `code`, sesión y renovación del token.
//! La sesión vive en `Sesion` con las claves de supabase-js (`sb-<proyecto>-auth-token` y `…-code-verifier`), así que
//! una sesión guardada por la versión Electron se sigue leyendo. Los tokens nunca salen de acá hacia la UI.
use super::http::{ErrorRed, Http, Pedido};
use super::postgrest::Credencial;
use super::sesion::Sesion;
use super::Res;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

/// Se renueva con este margen antes de que venza, como auth-js.
const MARGEN_S: i64 = 90;
const TIMEOUT_MS: u64 = 15_000;

type Aviso = Box<dyn Fn() + Send + Sync>;

pub struct Auth {
    http: Arc<dyn Http>,
    url: String,
    anon_key: String,
    sesion: Arc<Sesion>,
    clave: String,
    ahora_s: Box<dyn Fn() -> i64 + Send + Sync>,
    al_cerrarse: Mutex<Option<Aviso>>,
}

/// `sb-<primera etiqueta del host>-auth-token`, la clave que usa supabase-js.
pub fn clave_de_almacenamiento(url: &str) -> String {
    let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
    format!("sb-{}-auth-token", host.split('.').next().unwrap_or(""))
}

/// `base64url(sha256(verifier))` sin relleno: el `code_challenge` S256.
pub fn desafio_pkce(verificador: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verificador.as_bytes()))
}

fn verificador_nuevo() -> Res<String> {
    let mut b = [0u8; 32];
    getrandom::getrandom(&mut b).map_err(|e| e.to_string())?;
    Ok(hex::encode(b))
}

impl Auth {
    pub fn nuevo(http: Arc<dyn Http>, url: &str, anon_key: &str, sesion: Arc<Sesion>, ahora_s: impl Fn() -> i64 + Send + Sync + 'static) -> Self {
        let url = url.trim_end_matches('/').to_string();
        let clave = clave_de_almacenamiento(&url);
        Auth { http, url, anon_key: anon_key.to_string(), sesion, clave, ahora_s: Box::new(ahora_s), al_cerrarse: Mutex::new(None) }
    }

    /// Se llama cuando el servidor rechaza para siempre la renovación (equivale a `SIGNED_OUT`).
    pub fn al_cerrarse(&self, f: impl Fn() + Send + Sync + 'static) {
        *self.al_cerrarse.lock().unwrap() = Some(Box::new(f));
    }

    fn clave_verificador(&self) -> String {
        format!("{}-code-verifier", self.clave)
    }

    fn pedido(&self, metodo: &'static str, ruta: &str, token: Option<&str>, cuerpo: Option<&Value>) -> Pedido {
        let mut p = Pedido::nuevo(metodo, &format!("{}{ruta}", self.url)).con_cabecera("apikey", &self.anon_key).con_timeout(TIMEOUT_MS);
        p = p.con_cabecera("Authorization", &format!("Bearer {}", token.unwrap_or(&self.anon_key)));
        if let Some(c) = cuerpo {
            p = p.con_cabecera("Content-Type", "application/json").con_cuerpo(c.to_string().into_bytes());
        }
        p
    }

    /// URL de login de GitHub con PKCE; guarda el verifier. No toca la red (supabase-js tampoco con `skipBrowserRedirect`).
    pub fn url_de_login_github(&self, redirect_to: &str) -> Res<String> {
        let verificador = verificador_nuevo()?;
        self.sesion.set_item(&self.clave_verificador(), &verificador);
        let mut u = url::Url::parse(&format!("{}/auth/v1/authorize", self.url)).map_err(|_| "No se pudo iniciar el login con GitHub.".to_string())?;
        u.query_pairs_mut()
            .append_pair("provider", "github")
            .append_pair("redirect_to", redirect_to)
            .append_pair("scopes", "read:user")
            .append_pair("code_challenge", &desafio_pkce(&verificador))
            .append_pair("code_challenge_method", "s256");
        Ok(u.to_string())
    }

    /// Canjea el `code` del callback por una sesión. El verifier se borra siempre, salga bien o mal (como auth-js).
    pub fn canjear_codigo(&self, code: &str) -> bool {
        let guardado = self.sesion.get_item(&self.clave_verificador());
        self.sesion.remove_item(&self.clave_verificador());
        let Some(verificador) = guardado.as_deref().and_then(|g| g.split('/').next()).filter(|v| !v.is_empty()) else { return false };
        let cuerpo = json!({"auth_code": code, "code_verifier": verificador});
        let Ok(r) = self.http.pedir(&self.pedido("POST", "/auth/v1/token?grant_type=pkce", None, Some(&cuerpo))) else { return false };
        match r.json().filter(|_| r.ok()) {
            Some(s) => self.guardar_sesion(&s),
            None => false,
        }
    }

    fn guardar_sesion(&self, resp: &Value) -> bool {
        let (Some(a), Some(r)) = (resp.get("access_token").and_then(Value::as_str), resp.get("refresh_token").and_then(Value::as_str)) else { return false };
        let dura = resp.get("expires_in").and_then(Value::as_i64).unwrap_or(3600);
        let mut s = json!({"access_token": a, "refresh_token": r, "expires_in": dura, "expires_at": (self.ahora_s)() + dura, "token_type": resp.get("token_type").and_then(Value::as_str).unwrap_or("bearer")});
        if let Some(u) = resp.get("user") {
            s["user"] = u.clone();
        }
        self.sesion.set_item(&self.clave, &s.to_string());
        true
    }

    fn sesion_guardada(&self) -> Option<Value> {
        let v: Value = serde_json::from_str(&self.sesion.get_item(&self.clave)?).ok()?;
        v.get("access_token")?.as_str()?;
        Some(v)
    }

    /// Sesión vigente: renueva si está por vencer. Si el servidor rechaza el refresh token, la sesión se borra y se avisa;
    /// si no hubo red, se queda con la que había y se reintenta en el próximo uso.
    pub fn sesion_actual(&self) -> Option<Value> {
        let s = self.sesion_guardada()?;
        let vence = s.get("expires_at").and_then(Value::as_i64).unwrap_or(0);
        if vence - (self.ahora_s)() > MARGEN_S {
            return Some(s);
        }
        let Some(rt) = s.get("refresh_token").and_then(Value::as_str) else { return Some(s) };
        match self.http.pedir(&self.pedido("POST", "/auth/v1/token?grant_type=refresh_token", None, Some(&json!({"refresh_token": rt})))) {
            Ok(r) if r.ok() => match r.json() {
                Some(n) if self.guardar_sesion(&n) => self.sesion_guardada(),
                _ => Some(s),
            },
            Ok(r) if (400..500).contains(&r.estado) && r.estado != 429 => {
                self.sesion.remove_item(&self.clave);
                if let Some(f) = self.al_cerrarse.lock().unwrap().as_ref() {
                    f();
                }
                None
            }
            Ok(_) | Err(ErrorRed::Timeout) | Err(ErrorRed::Conexion(_)) => Some(s),
        }
    }

    pub fn token_de_acceso(&self) -> Option<String> {
        self.sesion_actual()?.get("access_token")?.as_str().map(String::from)
    }

    /// `auth.getUser()`: el usuario según el servidor. Error si el token no sirve o no hay red.
    pub fn usuario(&self) -> Res<Value> {
        let token = self.token_de_acceso().ok_or("No se pudo verificar tu sesión. Iniciá sesión de nuevo.")?;
        let r = self.http.pedir(&self.pedido("GET", "/auth/v1/user", Some(&token), None)).map_err(|_| "No se pudo verificar tu sesión. Iniciá sesión de nuevo.".to_string())?;
        r.json().filter(|u| r.ok() && u.get("id").and_then(Value::as_str).is_some()).ok_or_else(|| "No se pudo verificar tu sesión. Iniciá sesión de nuevo.".to_string())
    }

    /// `signOut({ scope: 'local' })`: avisa al servidor si puede (un fallo no importa) y olvida la sesión.
    pub fn cerrar_sesion_local(&self) {
        if let Some(t) = self.sesion_guardada().and_then(|s| s.get("access_token").and_then(Value::as_str).map(String::from)) {
            let _ = self.http.pedir(&self.pedido("POST", "/auth/v1/logout?scope=local", Some(&t), None));
        }
        self.sesion.remove_item(&self.clave);
    }

    /// `GET /auth/v1/settings`: si GitHub está habilitado (`None` si no se pudo saber).
    pub fn github_habilitado(&self, timeout_ms: u64) -> Option<bool> {
        let r = self.http.pedir(&self.pedido("GET", "/auth/v1/settings", None, None).con_timeout(timeout_ms)).ok()?;
        super::auth::github_en_settings(&r.json().filter(|_| r.ok())?)
    }
}

impl Credencial for Auth {
    fn token(&self) -> Option<String> {
        self.token_de_acceso()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::chat::http::pruebas::{json_resp, HttpFalso};
    use crate::features::chat::sesion::pruebas::{carpeta, AlmacenFalso};
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

    fn sesion(n: &str) -> Arc<Sesion> {
        Arc::new(Sesion::abrir(&carpeta(n).join("s.bin"), Arc::new(AlmacenFalso(true)), |_| {}))
    }

    fn auth(http: Arc<HttpFalso>, ses: Arc<Sesion>, reloj: Arc<AtomicI64>) -> Auth {
        Auth::nuevo(http, "https://abc.supabase.co/", "anon", ses, move || reloj.load(Ordering::SeqCst))
    }

    fn token_ok() -> Result<crate::features::chat::http::Respuesta, ErrorRed> {
        json_resp(200, json!({"access_token": "a2", "refresh_token": "r2", "expires_in": 3600, "user": {"id": "u1"}}))
    }

    #[test]
    fn la_clave_de_almacenamiento_es_la_de_supabase_js() {
        assert_eq!(clave_de_almacenamiento("https://abcdefg.supabase.co"), "sb-abcdefg-auth-token");
        assert_eq!(clave_de_almacenamiento("https://chat.mi-servidor.com"), "sb-chat-auth-token");
    }

    #[test]
    fn el_desafio_pkce_es_el_del_rfc_7636() {
        assert_eq!(desafio_pkce("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn la_url_de_login_lleva_pkce_github_y_el_redirect() {
        let ses = sesion("go-1");
        let a = auth(HttpFalso::nuevo(|_| unreachable!("no usa la red")), ses.clone(), Arc::new(AtomicI64::new(0)));
        let u = url::Url::parse(&a.url_de_login_github("http://127.0.0.1:53682/auth/callback").unwrap()).unwrap();
        assert_eq!((u.scheme(), u.host_str(), u.path()), ("https", Some("abc.supabase.co"), "/auth/v1/authorize"));
        let q: std::collections::HashMap<_, _> = u.query_pairs().into_owned().collect();
        assert_eq!(q["provider"], "github");
        assert_eq!(q["redirect_to"], "http://127.0.0.1:53682/auth/callback");
        assert_eq!(q["scopes"], "read:user");
        assert_eq!(q["code_challenge_method"], "s256");
        let verificador = ses.get_item("sb-abc-auth-token-code-verifier").unwrap();
        assert_eq!(q["code_challenge"], desafio_pkce(&verificador));
    }

    #[test]
    fn canjear_manda_el_code_y_el_verifier_guarda_la_sesion_y_borra_el_verifier() {
        let http = HttpFalso::nuevo(|_| token_ok());
        let ses = sesion("go-2");
        let a = auth(http.clone(), ses.clone(), Arc::new(AtomicI64::new(1000)));
        a.url_de_login_github("http://127.0.0.1:1/x").unwrap();
        let verificador = ses.get_item("sb-abc-auth-token-code-verifier").unwrap();
        assert!(a.canjear_codigo("el-code"));
        let p = http.pedidos.lock().unwrap()[0].clone();
        assert_eq!(p.url, "https://abc.supabase.co/auth/v1/token?grant_type=pkce");
        assert_eq!(serde_json::from_slice::<Value>(p.cuerpo.as_ref().unwrap()).unwrap(), json!({"auth_code": "el-code", "code_verifier": verificador}));
        assert_eq!(ses.get_item("sb-abc-auth-token-code-verifier"), None);
        let g: Value = serde_json::from_str(&ses.get_item("sb-abc-auth-token").unwrap()).unwrap();
        assert_eq!((g["access_token"].as_str(), g["expires_at"].as_i64()), (Some("a2"), Some(4600)));
        assert_eq!(a.token().as_deref(), Some("a2"));
    }

    #[test]
    fn un_canje_rechazado_o_sin_verifier_da_false() {
        let ses = sesion("go-3");
        let a = auth(HttpFalso::nuevo(|_| json_resp(400, json!({"error": "x"}))), ses.clone(), Arc::new(AtomicI64::new(0)));
        assert!(!a.canjear_codigo("c"), "sin verifier ni siquiera llama");
        a.url_de_login_github("http://127.0.0.1:1/x").unwrap();
        assert!(!a.canjear_codigo("c"));
        assert_eq!(ses.get_item("sb-abc-auth-token"), None);
        assert_eq!(ses.get_item("sb-abc-auth-token-code-verifier"), None, "auth-js lo borra aunque falle");
    }

    fn con_sesion_vieja(ses: &Sesion, vence: i64) {
        ses.set_item("sb-abc-auth-token", &json!({"access_token": "a1", "refresh_token": "r1", "expires_at": vence}).to_string());
    }

    #[test]
    fn una_sesion_vigente_no_pide_nada_al_servidor() {
        let ses = sesion("go-4");
        con_sesion_vieja(&ses, 5000);
        let http = HttpFalso::nuevo(|_| unreachable!());
        assert_eq!(auth(http.clone(), ses, Arc::new(AtomicI64::new(1000))).token().as_deref(), Some("a1"));
        assert!(http.pedidos.lock().unwrap().is_empty());
    }

    #[test]
    fn una_sesion_por_vencer_se_renueva_con_el_refresh_token() {
        let ses = sesion("go-5");
        con_sesion_vieja(&ses, 1050);
        let http = HttpFalso::nuevo(|_| token_ok());
        let a = auth(http.clone(), ses.clone(), Arc::new(AtomicI64::new(1000)));
        assert_eq!(a.token().as_deref(), Some("a2"));
        let p = http.pedidos.lock().unwrap()[0].clone();
        assert!(p.url.ends_with("grant_type=refresh_token"));
        assert_eq!(serde_json::from_slice::<Value>(p.cuerpo.as_ref().unwrap()).unwrap(), json!({"refresh_token": "r1"}));
    }

    #[test]
    fn si_el_servidor_rechaza_el_refresh_la_sesion_se_borra_y_se_avisa() {
        let ses = sesion("go-6");
        con_sesion_vieja(&ses, 0);
        let a = auth(HttpFalso::nuevo(|_| json_resp(400, json!({"error": "invalid_grant"}))), ses.clone(), Arc::new(AtomicI64::new(1000)));
        let avisos = Arc::new(AtomicUsize::new(0));
        let c = avisos.clone();
        a.al_cerrarse(move || {
            c.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(a.token(), None);
        assert_eq!(ses.get_item("sb-abc-auth-token"), None);
        assert_eq!(avisos.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn si_no_hay_red_o_hay_un_5xx_se_conserva_la_sesion() {
        for resp in [Err(ErrorRed::Conexion("x".into())), json_resp(503, json!({})), json_resp(429, json!({}))] {
            let ses = sesion("go-7");
            con_sesion_vieja(&ses, 0);
            let a = auth(HttpFalso::nuevo(move |_| resp.clone()), ses.clone(), Arc::new(AtomicI64::new(1000)));
            assert_eq!(a.token().as_deref(), Some("a1"));
            assert!(ses.get_item("sb-abc-auth-token").is_some());
        }
    }

    #[test]
    fn usuario_pide_el_user_con_el_token_y_valida_el_id() {
        let ses = sesion("go-8");
        con_sesion_vieja(&ses, 9999);
        let http = HttpFalso::nuevo(|_| json_resp(200, json!({"id": "u1"})));
        let a = auth(http.clone(), ses.clone(), Arc::new(AtomicI64::new(0)));
        assert_eq!(a.usuario().unwrap()["id"], "u1");
        let p = http.pedidos.lock().unwrap()[0].clone();
        assert!(p.cabeceras.contains(&("Authorization".to_string(), "Bearer a1".to_string())));
        let mala = auth(HttpFalso::nuevo(|_| json_resp(200, json!({"x": 1}))), ses, Arc::new(AtomicI64::new(0)));
        assert!(mala.usuario().is_err());
    }

    #[test]
    fn cerrar_sesion_local_avisa_al_servidor_y_olvida_aunque_falle() {
        let ses = sesion("go-9");
        con_sesion_vieja(&ses, 9999);
        let http = HttpFalso::nuevo(|_| Err(ErrorRed::Conexion("x".into())));
        let a = auth(http.clone(), ses.clone(), Arc::new(AtomicI64::new(0)));
        a.cerrar_sesion_local();
        assert!(http.urls()[0].ends_with("/auth/v1/logout?scope=local"));
        assert_eq!(ses.get_item("sb-abc-auth-token"), None);
    }

    #[test]
    fn github_habilitado_lee_settings_y_no_adivina_si_falla() {
        let a = auth(HttpFalso::nuevo(|_| json_resp(200, json!({"external": {"github": false}}))), sesion("go-10"), Arc::new(AtomicI64::new(0)));
        assert_eq!(a.github_habilitado(1000), Some(false));
        let b = auth(HttpFalso::nuevo(|_| json_resp(500, json!({}))), sesion("go-11"), Arc::new(AtomicI64::new(0)));
        assert_eq!(b.github_habilitado(1000), None);
        let c = auth(HttpFalso::nuevo(|_| Err(ErrorRed::Timeout)), sesion("go-12"), Arc::new(AtomicI64::new(0)));
        assert_eq!(c.github_habilitado(1000), None);
    }
}
