//! «Probar conexión»: chequeos de solo lectura con la clave pública (servidor, GitHub, tablas, funciones y versión del
//! esquema). Equivale a chat-validar.ts. La red entra por `Pedidor`: quien lo implementa pone los topes de tiempo
//! (8 s por pedido, 20 s en total), no sigue redirecciones y corta el cuerpo a 64 KB.
use super::auth::{github_en_settings, GITHUB_DESHABILITADO};
use super::config::{chequear_anon_key, normalizar_url_supabase};
use super::texto::{es_host_supabase, host_de_url};
use super::tipos::{ChatCheck, EstadoCheck};
use serde_json::{json, Value};
use url::Url;

pub const CHAT_SCHEMA_ESPERADA: i64 = 9;

pub const TABLAS_ESPERADAS: [&str; 10] = [
    "profiles",
    "teams",
    "team_members",
    "team_invite_codes",
    "team_invites",
    "dm_threads",
    "messages",
    "message_reactions",
    "chat_typing_last",
    "chat_rate",
];

pub struct FuncionSinAnon {
    pub nombre: &'static str,
    pub args: &'static [&'static str],
    pub migracion: &'static str,
}

/// Funciones que anon no puede ejecutar (por eso 42501 = existe). Los args llevan los nombres reales: con otros,
/// PostgREST da PGRST202 aunque exista.
pub const FUNCIONES_SIN_ANON: [FuncionSinAnon; 5] = [
    FuncionSinAnon { nombre: "remove_member", args: &["p_team", "p_user"], migracion: "0007" },
    FuncionSinAnon { nombre: "regenerate_invite_code", args: &["p_team"], migracion: "0007" },
    FuncionSinAnon { nombre: "chat_rate_hit", args: &["p_kind", "p_max", "p_secs"], migracion: "0008" },
    FuncionSinAnon { nombre: "dm_cleared_at", args: &["p_thread"], migracion: "0008" },
    FuncionSinAnon { nombre: "dm_writable", args: &["p_thread"], migracion: "0008" },
];

const ACCION_SQL: &str = "Pegá supabase/setup.sql en el SQL Editor de Supabase (es seguro repetirlo) y esperá un minuto a que Supabase refresque.";
const ACCION_URL: &str = "Revisá la URL y la clave en Configuración → Equipo y chat (Project Settings → API en Supabase).";

#[derive(Debug, Clone, PartialEq)]
pub enum Respuesta {
    Red,
    Timeout,
    /// `cuerpo` es `None` si no era JSON, vino cortado o pasó el tope.
    Http { status: u16, cuerpo: Option<Value> },
}

pub trait Pedidor {
    /// GET sin `post`; POST con JSON si lo hay. Solo manda `apikey` y `accept`.
    fn pedir(&self, ruta: &str, post: Option<&Value>) -> Respuesta;
}

/// El `code` de un error de PostgREST, solo si tiene forma de código (`[A-Z0-9]{5,8}`).
pub fn codigo_seguro(cuerpo: Option<&Value>) -> Option<&str> {
    let code = cuerpo?.as_object()?.get("code")?.as_str()?;
    ((5..=8).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())).then_some(code)
}

fn ok_2xx(r: &Respuesta) -> bool {
    matches!(r, Respuesta::Http { status, .. } if (200..300).contains(status))
}

fn negada(r: &Respuesta) -> bool {
    match r {
        Respuesta::Http { status, cuerpo } => *status == 401 || *status == 403 || codigo_seguro(cuerpo.as_ref()) == Some("42501"),
        _ => false,
    }
}

fn no_existe(r: &Respuesta, codigo: &str) -> bool {
    match r {
        Respuesta::Http { status, cuerpo } => *status == 404 || codigo_seguro(cuerpo.as_ref()) == Some(codigo),
        _ => false,
    }
}

fn lista(nombres: &[String]) -> String {
    nombres.join(", ")
}

fn check(id: &str, estado: EstadoCheck, titulo: &str, detalle: impl Into<String>, accion: Option<&str>) -> ChatCheck {
    ChatCheck { id: id.into(), estado, titulo: titulo.into(), detalle: detalle.into(), accion: accion.map(String::from) }
}

fn sin_datos() -> Vec<ChatCheck> {
    let d = "Primero arreglá la conexión.";
    vec![
        check("github", EstadoCheck::SinDatos, "Login con GitHub", d, None),
        check("tablas", EstadoCheck::SinDatos, "Tablas del chat", d, None),
        check("funciones", EstadoCheck::SinDatos, "Funciones del chat", d, None),
        check("version", EstadoCheck::SinDatos, "Versión del esquema", d, None),
    ]
}

fn chequeo_host(host: &str) -> ChatCheck {
    if es_host_supabase(host) {
        return check("host", EstadoCheck::Ok, "Servidor", format!("Proyecto de Supabase ({host})."), None);
    }
    check(
        "host",
        EstadoCheck::Aviso,
        "Servidor",
        format!("Host propio: {host}. Sloth le manda la clave pública a ese servidor: confirmá que es el tuyo."),
        Some("Si no es tu servidor, cambiá la URL en Configuración → Equipo y chat."),
    )
}

fn chequeo_alcance(r: &Respuesta) -> ChatCheck {
    let t = "Conexión";
    let pausado = "Si el proyecto es del plan gratuito, puede estar pausado: reanudalo desde el panel de Supabase.";
    match r {
        Respuesta::Red => check("alcance", EstadoCheck::Fallo, t, "Sin conexión: no se pudo llegar al servidor.", Some(&format!("Revisá tu internet y la URL. {pausado}"))),
        Respuesta::Timeout => check("alcance", EstadoCheck::Fallo, t, "Supabase no respondió a tiempo.", Some(&format!("Revisá tu internet. {pausado}"))),
        Respuesta::Http { status, .. } if *status == 401 || *status == 403 => {
            check("alcance", EstadoCheck::Fallo, t, "Supabase rechazó la clave.", Some("Copiá la clave publishable (o anon) de Project Settings → API y pegala de nuevo."))
        }
        Respuesta::Http { status: 404, .. } => check("alcance", EstadoCheck::Fallo, t, "Esa dirección no responde como un proyecto de Supabase.", Some(ACCION_URL)),
        Respuesta::Http { status, .. } if !ok_2xx(r) => {
            check("alcance", EstadoCheck::Fallo, t, format!("Supabase respondió con un error (código {status})."), Some("Probá de nuevo en un rato."))
        }
        _ => check("alcance", EstadoCheck::Ok, t, "Supabase responde y acepta la clave.", None),
    }
}

fn chequeo_github(r: &Respuesta) -> ChatCheck {
    let t = "Login con GitHub";
    let habilitado = match r {
        Respuesta::Http { cuerpo: Some(c), .. } if ok_2xx(r) => github_en_settings(c),
        _ => None,
    };
    match habilitado {
        Some(true) => check("github", EstadoCheck::Ok, t, "GitHub está habilitado como proveedor de login.", None),
        Some(false) => check("github", EstadoCheck::Fallo, t, GITHUB_DESHABILITADO, None),
        None => check("github", EstadoCheck::SinDatos, t, "No se pudo comprobar si GitHub está habilitado.", Some("Probá de nuevo en un rato.")),
    }
}

fn chequeo_tablas(rs: &[Respuesta]) -> ChatCheck {
    let t = "Tablas del chat";
    let (mut faltan, mut legibles, mut inciertas) = (Vec::new(), Vec::new(), Vec::new());
    for (r, nombre) in rs.iter().zip(TABLAS_ESPERADAS) {
        if ok_2xx(r) {
            legibles.push(nombre.to_string());
        } else if no_existe(r, "PGRST205") {
            faltan.push(nombre.to_string());
        } else if !negada(r) {
            inciertas.push(nombre.to_string());
        }
    }
    if !faltan.is_empty() {
        return check("tablas", EstadoCheck::Fallo, t, format!("Faltan: {}.", lista(&faltan)), Some(ACCION_SQL));
    }
    if !legibles.is_empty() {
        return check(
            "tablas",
            EstadoCheck::Aviso,
            t,
            format!("La clave pública puede leer: {}. No debería poder.", lista(&legibles)),
            Some("Revisá la migración 0002 (supabase/setup.sql la incluye) y volvé a pegarla en el SQL Editor."),
        );
    }
    if !inciertas.is_empty() {
        return check("tablas", EstadoCheck::SinDatos, t, format!("No se pudo comprobar: {}.", lista(&inciertas)), Some("Probá de nuevo en un rato."));
    }
    check("tablas", EstadoCheck::Ok, t, format!("Están las {} tablas y la clave pública no las lee.", TABLAS_ESPERADAS.len()), None)
}

fn chequeo_funciones(rs: &[Respuesta]) -> ChatCheck {
    let t = "Funciones del chat";
    let (mut faltan, mut abiertas, mut inciertas) = (Vec::new(), Vec::new(), Vec::new());
    for (r, f) in rs.iter().zip(FUNCIONES_SIN_ANON.iter()) {
        if ok_2xx(r) {
            abiertas.push(f.nombre.to_string());
        } else if no_existe(r, "PGRST202") {
            faltan.push(format!("{} (migración {})", f.nombre, f.migracion));
        } else if !negada(r) {
            inciertas.push(f.nombre.to_string());
        }
    }
    if !faltan.is_empty() {
        return check("funciones", EstadoCheck::Fallo, t, format!("Faltan: {}.", lista(&faltan)), Some(ACCION_SQL));
    }
    if !abiertas.is_empty() {
        return check(
            "funciones",
            EstadoCheck::Aviso,
            t,
            format!("Seguridad: la clave pública pudo ejecutar {}. No debería poder.", lista(&abiertas)),
            Some("Volvé a pegar supabase/setup.sql en el SQL Editor para restaurar los permisos."),
        );
    }
    if !inciertas.is_empty() {
        return check("funciones", EstadoCheck::SinDatos, t, format!("No se pudo comprobar: {}.", lista(&inciertas)), Some("Probá de nuevo en un rato."));
    }
    check("funciones", EstadoCheck::Ok, t, format!("Están las {} funciones protegidas y la clave pública no las ejecuta.", FUNCIONES_SIN_ANON.len()), None)
}

fn chequeo_version(r: &Respuesta) -> ChatCheck {
    let t = "Versión del esquema";
    let esperada = CHAT_SCHEMA_ESPERADA;
    if let Respuesta::Http { cuerpo, .. } = r {
        if ok_2xx(r) {
            let n = cuerpo.as_ref().and_then(Value::as_f64).filter(|n| n.fract() == 0.0 && *n >= 0.0 && *n < 10_000.0).map(|n| n as i64);
            if let Some(n) = n {
                if n == esperada {
                    return check("version", EstadoCheck::Ok, t, format!("Esquema al día (versión {esperada})."), None);
                }
                if n < esperada {
                    return check("version", EstadoCheck::Fallo, t, format!("Tu esquema es el {n} y esta versión de Sloth espera el {esperada}."), Some(ACCION_SQL));
                }
                return check(
                    "version",
                    EstadoCheck::Aviso,
                    t,
                    format!("Tu esquema es el {n}, más nuevo que el {esperada} que conoce esta versión de Sloth."),
                    Some("Actualizá Sloth."),
                );
            }
        } else if no_existe(r, "PGRST202") {
            return check(
                "version",
                EstadoCheck::Aviso,
                t,
                "No encontré chat_schema_version(): falta la migración 0009. Si las tablas y las funciones dieron bien, el resto del chat anda igual.",
                Some("Aplicá la migración 0009 (o pegá supabase/setup.sql de nuevo) y esperá un minuto."),
            );
        }
    }
    check("version", EstadoCheck::SinDatos, t, "No se pudo leer la versión del esquema.", Some("Probá de nuevo en un rato."))
}

pub fn validar_chat(supabase_url: &str, anon_key: &str, red: &dyn Pedidor) -> Vec<ChatCheck> {
    let base = match normalizar_url_supabase(&Value::from(supabase_url)) {
        Ok(b) => b,
        Err(e) => return vec![check("host", EstadoCheck::Fallo, "Servidor", e, Some(ACCION_URL))],
    };
    if let Err(e) = chequear_anon_key(&Value::from(anon_key)) {
        return vec![check(
            "clave",
            EstadoCheck::Fallo,
            "Clave pública",
            e,
            Some("Usá la clave publishable (o anon) de Project Settings → API. No se hicieron pedidos al servidor."),
        )];
    }
    let host = Url::parse(&base).ok().and_then(|u| host_de_url(&u)).unwrap_or_default();
    let host = chequeo_host(&host);
    let alcance = chequeo_alcance(&red.pedir("/auth/v1/health", None));
    if alcance.estado != EstadoCheck::Ok {
        let mut v = vec![host, alcance];
        v.extend(sin_datos());
        return v;
    }
    let github = chequeo_github(&red.pedir("/auth/v1/settings", None));
    let tablas: Vec<Respuesta> = TABLAS_ESPERADAS.iter().map(|t| red.pedir(&format!("/rest/v1/{t}?select=*&limit=0"), None)).collect();
    let funciones: Vec<Respuesta> = FUNCIONES_SIN_ANON
        .iter()
        .map(|f| {
            let args: serde_json::Map<String, Value> = f.args.iter().map(|a| (a.to_string(), Value::Null)).collect();
            red.pedir(&format!("/rest/v1/rpc/{}", f.nombre), Some(&Value::Object(args)))
        })
        .collect();
    let version = chequeo_version(&red.pedir("/rest/v1/rpc/chat_schema_version", Some(&json!({}))));
    vec![host, alcance, github, chequeo_tablas(&tablas), chequeo_funciones(&funciones), version]
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use std::cell::RefCell;
    use std::collections::HashMap;

    const URL_OK: &str = "https://abcdefghijkl.supabase.co";

    fn b64(v: Value) -> String {
        URL_SAFE_NO_PAD.encode(v.to_string())
    }
    fn clave() -> String {
        format!("{}.{}.firma_de_prueba", b64(json!({"alg": "HS256"})), b64(json!({"role": "anon"})))
    }
    fn servicio() -> String {
        format!("{}.{}.firma_de_prueba", b64(json!({"alg": "HS256"})), b64(json!({"role": "service_role"})))
    }
    fn http(status: u16, cuerpo: Value) -> Respuesta {
        Respuesta::Http { status, cuerpo: Some(cuerpo) }
    }

    struct Servidor {
        rutas: HashMap<String, Respuesta>,
        pedidos: RefCell<Vec<(String, Option<Value>)>>,
    }

    fn servidor(rutas: Vec<(&str, Respuesta)>) -> Servidor {
        Servidor { rutas: rutas.into_iter().map(|(k, v)| (k.to_string(), v)).collect(), pedidos: RefCell::default() }
    }

    impl Pedidor for Servidor {
        fn pedir(&self, ruta: &str, post: Option<&Value>) -> Respuesta {
            self.pedidos.borrow_mut().push((ruta.to_string(), post.cloned()));
            let path = ruta.split('?').next().unwrap_or(ruta);
            if let Some(r) = self.rutas.get(path).or_else(|| self.rutas.get(ruta)) {
                return r.clone();
            }
            match path {
                "/auth/v1/health" => http(200, json!({"status": "ok"})),
                "/auth/v1/settings" => http(200, json!({"external": {"github": true}})),
                "/rest/v1/rpc/chat_schema_version" => http(200, json!(CHAT_SCHEMA_ESPERADA)),
                p if p.starts_with("/rest/v1/rpc/") => http(401, json!({"code": "42501", "message": "permission denied for function"})),
                p if p.starts_with("/rest/v1/") && post.is_none() => http(401, json!({"code": "42501", "message": "permission denied for table"})),
                _ => http(404, json!({})),
            }
        }
    }

    fn correr(s: &Servidor) -> Vec<ChatCheck> {
        validar_chat(URL_OK, &clave(), s)
    }
    fn por<'a>(cs: &'a [ChatCheck], id: &str) -> &'a ChatCheck {
        cs.iter().find(|c| c.id == id).unwrap_or_else(|| panic!("falta {id}"))
    }

    #[test]
    fn todo_bien_todos_los_chequeos_en_ok() {
        let cs = correr(&servidor(vec![]));
        let v: Vec<(&str, EstadoCheck)> = cs.iter().map(|c| (c.id.as_str(), c.estado)).collect();
        assert_eq!(
            v,
            [("host", EstadoCheck::Ok), ("alcance", EstadoCheck::Ok), ("github", EstadoCheck::Ok), ("tablas", EstadoCheck::Ok), ("funciones", EstadoCheck::Ok), ("version", EstadoCheck::Ok)]
        );
    }

    #[test]
    fn falta_message_reactions_tablas_falla_y_la_nombra() {
        let cs = correr(&servidor(vec![("/rest/v1/message_reactions", http(404, json!({"code": "PGRST205"})))]));
        assert_eq!(por(&cs, "tablas").estado, EstadoCheck::Fallo);
        assert!(por(&cs, "tablas").detalle.contains("message_reactions"));
        assert!(por(&cs, "tablas").accion.as_deref().unwrap().contains("setup.sql"));
        assert_eq!(por(&cs, "funciones").estado, EstadoCheck::Ok);
    }

    #[test]
    fn falta_remove_member_funciones_falla_con_la_migracion_0007() {
        let cs = correr(&servidor(vec![("/rest/v1/rpc/remove_member", http(404, json!({"code": "PGRST202"})))]));
        assert_eq!(por(&cs, "funciones").estado, EstadoCheck::Fallo);
        assert!(por(&cs, "funciones").detalle.contains("remove_member (migración 0007)"));
    }

    #[test]
    fn sin_chat_schema_version_aviso_que_pide_la_0009_y_lo_demas_sigue_ok() {
        let cs = correr(&servidor(vec![("/rest/v1/rpc/chat_schema_version", http(404, json!({"code": "PGRST202"})))]));
        assert_eq!(por(&cs, "version").estado, EstadoCheck::Aviso);
        assert!(por(&cs, "version").detalle.contains("migración 0009"));
        for id in ["host", "alcance", "github", "tablas", "funciones"] {
            assert_eq!(por(&cs, id).estado, EstadoCheck::Ok, "{id}");
        }
    }

    #[test]
    fn version_vieja_es_fallo_y_mas_nueva_es_aviso() {
        let vieja = correr(&servidor(vec![("/rest/v1/rpc/chat_schema_version", http(200, json!(7)))]));
        assert_eq!(por(&vieja, "version").estado, EstadoCheck::Fallo);
        assert_eq!(por(&vieja, "version").detalle, "Tu esquema es el 7 y esta versión de Sloth espera el 9.");
        let nueva = correr(&servidor(vec![("/rest/v1/rpc/chat_schema_version", http(200, json!(12)))]));
        assert_eq!(por(&nueva, "version").estado, EstadoCheck::Aviso);
        assert!(por(&nueva, "version").accion.as_deref().unwrap().contains("Actualizá Sloth"));
    }

    #[test]
    fn version_que_no_es_un_entero_razonable_queda_sin_datos() {
        for cuerpo in [json!(1.5), json!(-1), json!(99999), json!("nueve"), json!(null), json!({"v": 9})] {
            let cs = correr(&servidor(vec![("/rest/v1/rpc/chat_schema_version", http(200, cuerpo.clone()))]));
            assert_eq!(por(&cs, "version").estado, EstadoCheck::SinDatos, "{cuerpo}");
        }
    }

    #[test]
    fn health_401_fallo_de_clave_el_resto_sin_datos_y_no_hay_mas_pedidos() {
        let s = servidor(vec![("/auth/v1/health", http(401, json!({"message": "Invalid API key"})))]);
        let cs = correr(&s);
        assert_eq!(por(&cs, "alcance").estado, EstadoCheck::Fallo);
        assert!(por(&cs, "alcance").detalle.contains("rechazó la clave"));
        for id in ["github", "tablas", "funciones", "version"] {
            assert_eq!(por(&cs, id).estado, EstadoCheck::SinDatos, "{id}");
        }
        assert_eq!(s.pedidos.borrow().len(), 1);
    }

    #[test]
    fn servidor_caido_404_y_500_en_health_fallo_sin_lanzar() {
        let caido = correr(&servidor(vec![("/auth/v1/health", Respuesta::Red)]));
        assert!(por(&caido, "alcance").detalle.contains("Sin conexión"));
        let no_es = correr(&servidor(vec![("/auth/v1/health", Respuesta::Http { status: 404, cuerpo: None })]));
        assert!(por(&no_es, "alcance").detalle.contains("no responde como un proyecto de Supabase"));
        let roto = correr(&servidor(vec![("/auth/v1/health", Respuesta::Http { status: 503, cuerpo: None })]));
        assert_eq!(por(&roto, "alcance").estado, EstadoCheck::Fallo);
        assert!(por(&roto, "alcance").detalle.contains("código 503"));
    }

    #[test]
    fn timeout_ni_en_health_ni_en_los_sondeos_lanza() {
        let en_health = correr(&servidor(vec![("/auth/v1/health", Respuesta::Timeout)]));
        assert_eq!(por(&en_health, "alcance").estado, EstadoCheck::Fallo);
        assert!(por(&en_health, "alcance").detalle.contains("no respondió a tiempo"));
        let t = Respuesta::Timeout;
        let en_sondeo = correr(&servidor(vec![
            ("/rest/v1/messages", t.clone()),
            ("/rest/v1/rpc/dm_writable", t.clone()),
            ("/rest/v1/rpc/chat_schema_version", t.clone()),
            ("/auth/v1/settings", t),
        ]));
        assert_eq!(por(&en_sondeo, "alcance").estado, EstadoCheck::Ok);
        for id in ["tablas", "funciones", "version", "github"] {
            assert_eq!(por(&en_sondeo, id).estado, EstadoCheck::SinDatos, "{id}");
        }
    }

    #[test]
    fn html_en_vez_de_json_no_rompe_y_queda_sin_datos() {
        let html = || Respuesta::Http { status: 200, cuerpo: None };
        let cs = correr(&servidor(vec![("/auth/v1/settings", html()), ("/rest/v1/rpc/chat_schema_version", html()), ("/rest/v1/profiles", html())]));
        assert_eq!(por(&cs, "github").estado, EstadoCheck::SinDatos);
        assert_eq!(por(&cs, "version").estado, EstadoCheck::SinDatos);
        assert_eq!(por(&cs, "tablas").estado, EstadoCheck::Aviso);
    }

    #[test]
    fn github_deshabilitado_fallo_con_que_activar() {
        let cs = correr(&servidor(vec![("/auth/v1/settings", http(200, json!({"external": {"github": false}})))]));
        assert_eq!(por(&cs, "github").estado, EstadoCheck::Fallo);
        assert!(por(&cs, "github").detalle.contains("Authentication → Sign In / Providers → GitHub"));
    }

    #[test]
    fn clave_service_role_o_secret_se_niega_y_no_hace_ningun_pedido() {
        for key in [servicio(), "sb_secret_abcdefgh12345".to_string()] {
            let s = servidor(vec![]);
            let cs = validar_chat(URL_OK, &key, &s);
            assert_eq!(cs.len(), 1);
            assert_eq!((cs[0].id.as_str(), cs[0].estado), ("clave", EstadoCheck::Fallo));
            assert!(cs[0].detalle.contains("service_role"));
            assert!(s.pedidos.borrow().is_empty());
            assert!(!serde_json::to_string(&cs).unwrap().contains(&key));
        }
    }

    #[test]
    fn url_invalida_fallo_sin_pedidos() {
        let s = servidor(vec![]);
        let cs = validar_chat("http://abcdefghijkl.supabase.co", &clave(), &s);
        assert_eq!(cs[0].estado, EstadoCheck::Fallo);
        assert!(s.pedidos.borrow().is_empty());
    }

    #[test]
    fn host_propio_aviso_con_el_host() {
        let s = servidor(vec![]);
        let cs = validar_chat("https://proyecto.ejemplo.com", &clave(), &s);
        assert_eq!(por(&cs, "host").estado, EstadoCheck::Aviso);
        assert!(por(&cs, "host").detalle.contains("Host propio: proyecto.ejemplo.com"));
        assert_eq!(por(&cs, "alcance").estado, EstadoCheck::Ok);
    }

    #[test]
    fn un_200_en_una_funcion_sin_execute_para_anon_es_aviso_de_seguridad() {
        let cs = correr(&servidor(vec![("/rest/v1/rpc/chat_rate_hit", http(200, json!(true)))]));
        assert_eq!(por(&cs, "funciones").estado, EstadoCheck::Aviso);
        assert!(por(&cs, "funciones").detalle.contains("chat_rate_hit"));
    }

    #[test]
    fn un_200_en_una_tabla_es_aviso() {
        let cs = correr(&servidor(vec![("/rest/v1/messages", http(200, json!([])))]));
        assert_eq!(por(&cs, "tablas").estado, EstadoCheck::Aviso);
        assert!(por(&cs, "tablas").detalle.contains("messages"));
    }

    #[test]
    fn cuerpo_hostil_del_servidor_nada_de_eso_llega_a_la_salida() {
        let hostil = json!({"message": "<img onerror=x>".repeat(1000), "code": "x".repeat(5000), "hint": "linea1\nlinea2\r\n<script>alert(1)</script>", "details": "Bearer abc.def.ghi"});
        let cs = correr(&servidor(vec![
            ("/rest/v1/teams", http(500, hostil.clone())),
            ("/rest/v1/rpc/dm_writable", http(500, hostil.clone())),
            ("/rest/v1/rpc/chat_schema_version", http(500, hostil.clone())),
            ("/auth/v1/settings", http(500, hostil)),
        ]));
        let salida = serde_json::to_string(&cs).unwrap();
        for frag in ["onerror", "xxxxx", "linea1", "script", "Bearer"] {
            assert!(!salida.contains(frag), "{frag}");
        }
        assert!(salida.len() < 4000);
        assert_eq!(por(&cs, "tablas").estado, EstadoCheck::SinDatos);
    }

    #[test]
    fn codigo_seguro_solo_deja_pasar_codigos_con_forma_de_codigo() {
        assert_eq!(codigo_seguro(Some(&json!({"code": "PGRST205"}))), Some("PGRST205"));
        assert_eq!(codigo_seguro(Some(&json!({"code": "42501"}))), Some("42501"));
        for code in [json!("x".repeat(5000)), json!("pgrst205"), json!("ABC"), json!("ABCDEFGHI"), json!("PG RST"), json!("<b>ABCDE"), json!("AB\nCDE"), json!(42501), json!(null)] {
            assert_eq!(codigo_seguro(Some(&json!({"code": code.clone()}))), None, "{code}");
        }
        for v in [json!(null), json!("PGRST205"), json!(5), json!([])] {
            assert_eq!(codigo_seguro(Some(&v)), None);
        }
    }

    #[test]
    fn seguridad_solo_get_y_post_a_funciones_conocidas_con_parametros_en_null_y_sin_la_clave_en_el_resultado() {
        let s = servidor(vec![]);
        let cs = correr(&s);
        let permitidas: Vec<&str> = FUNCIONES_SIN_ANON.iter().map(|f| f.nombre).chain(["chat_schema_version"]).collect();
        assert_eq!(s.pedidos.borrow().len(), 1 + 1 + TABLAS_ESPERADAS.len() + FUNCIONES_SIN_ANON.len() + 1);
        for (ruta, post) in s.pedidos.borrow().iter() {
            match post {
                Some(cuerpo) => {
                    let f = ruta.trim_start_matches("/rest/v1/rpc/");
                    assert!(permitidas.contains(&f), "{f}");
                    assert!(cuerpo.as_object().unwrap().values().all(Value::is_null));
                }
                None if ruta.starts_with("/rest/v1/") => assert!(ruta.ends_with("?select=*&limit=0"), "{ruta}"),
                None => {}
            }
        }
        let salida = serde_json::to_string(&cs).unwrap();
        assert!(!salida.contains(&clave()) && !salida.contains("firma_de_prueba"));
    }

    #[test]
    fn las_funciones_sondeadas_usan_los_nombres_de_parametro_reales_de_las_migraciones() {
        let ruta = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../supabase/setup.sql");
        let Ok(sql) = std::fs::read_to_string(&ruta) else { return };
        for f in FUNCIONES_SIN_ANON.iter() {
            let patron = regex::Regex::new(&format!(r"function public\.{}\(([^)]*)\)", f.nombre)).unwrap();
            let firmas: Vec<&str> = patron.captures_iter(&sql).map(|c| c.get(1).unwrap().as_str()).collect();
            assert!(!firmas.is_empty(), "{}", f.nombre);
            assert!(firmas.iter().any(|d| f.args.iter().all(|n| d.contains(n)) && d.split(',').count() == f.args.len()), "{}: {firmas:?}", f.nombre);
        }
        for t in TABLAS_ESPERADAS {
            assert!(regex::Regex::new(&format!(r"create table if not exists public\.{t}\b")).unwrap().is_match(&sql), "{t}");
        }
    }
}
