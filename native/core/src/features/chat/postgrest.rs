//! PostgREST de Supabase sin supabase-js: arma la consulta, la manda por `Http` y devuelve `{data, error}` como el cliente
//! de JavaScript. Un corte de red NO tira: vuelve como error sin código, y quien llama decide con `comprobar`.
use super::http::{Http, Pedido};
use super::{cortar_utf16, Res};
use serde_json::Value;
use std::sync::Arc;

/// Quien da el token con el que se firman los pedidos. Sin token se usa la anon key (sin sesión).
pub trait Credencial: Send + Sync {
    fn token(&self) -> Option<String>;
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ErrorPg {
    pub code: Option<String>,
    pub message: Option<String>,
}

impl ErrorPg {
    pub fn codigo(&self) -> &str {
        self.code.as_deref().unwrap_or("")
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResPg {
    pub data: Value,
    pub error: Option<ErrorPg>,
}

impl ResPg {
    pub fn filas(&self) -> &[Value] {
        self.data.as_array().map(Vec::as_slice).unwrap_or(&[])
    }

    pub fn primera(&self) -> Option<&Value> {
        self.filas().first()
    }
}

/// `check` del TypeScript: de un error de PostgREST solo pasa el texto de los RAISE de nuestras funciones (P0001).
pub fn comprobar(res: &ResPg, respaldo: &str) -> Res<()> {
    let Some(e) = &res.error else { return Ok(()) };
    match (&e.code, &e.message) {
        (Some(c), Some(m)) if c == "P0001" && !m.is_empty() => Err(cortar_utf16(m, 300)),
        _ => Err(respaldo.to_string()),
    }
}

/// Códigos de «no existe la columna o la tabla»: dicen que falta una migración.
pub fn falta_esquema(code: &str) -> bool {
    matches!(code, "42703" | "42P01" | "PGRST204" | "PGRST205")
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Verbo {
    Select,
    Insert,
    Update,
    Delete,
}

/// Consulta a una tabla. Se arma encadenando y se corre con `Supabase::ejecutar`.
pub struct Consulta {
    tabla: String,
    verbo: Verbo,
    params: Vec<(String, String)>,
    cuerpo: Option<Value>,
    devolver: bool,
}

/// Valor de un `in.(...)`: entre comillas si trae algo que PostgREST toma como separador.
fn valor_de_lista(v: &str) -> String {
    if v.chars().any(|c| matches!(c, ',' | '(' | ')' | '"' | '\\' | ' ')) {
        format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        v.to_string()
    }
}

impl Consulta {
    fn nueva(tabla: &str, verbo: Verbo, cuerpo: Option<Value>) -> Self {
        Consulta { tabla: tabla.to_string(), verbo, params: Vec::new(), cuerpo, devolver: verbo == Verbo::Select }
    }

    pub fn select(tabla: &str, columnas: &str) -> Self {
        Self::nueva(tabla, Verbo::Select, None).columnas(columnas)
    }

    pub fn insert(tabla: &str, fila: Value) -> Self {
        Self::nueva(tabla, Verbo::Insert, Some(fila))
    }

    pub fn update(tabla: &str, cambios: Value) -> Self {
        Self::nueva(tabla, Verbo::Update, Some(cambios))
    }

    pub fn delete(tabla: &str) -> Self {
        Self::nueva(tabla, Verbo::Delete, None)
    }

    /// `.select(cols)` después de insert, update o delete: pide las filas afectadas.
    pub fn columnas(mut self, cols: &str) -> Self {
        self.devolver = true;
        let limpias: String = cols.chars().filter(|c| !c.is_whitespace()).collect();
        self.params.retain(|(k, _)| k != "select");
        self.params.push(("select".into(), limpias));
        self
    }

    pub fn eq(self, col: &str, v: &str) -> Self {
        self.filtro(col, format!("eq.{v}"))
    }

    pub fn lt(self, col: &str, v: &str) -> Self {
        self.filtro(col, format!("lt.{v}"))
    }

    pub fn ilike(self, col: &str, patron: &str) -> Self {
        self.filtro(col, format!("ilike.{patron}"))
    }

    pub fn es_nulo(self, col: &str) -> Self {
        self.filtro(col, "is.null".into())
    }

    pub fn en(self, col: &str, valores: &[String]) -> Self {
        let lista: Vec<String> = valores.iter().map(|v| valor_de_lista(v)).collect();
        self.filtro(col, format!("in.({})", lista.join(",")))
    }

    pub fn orden_desc(mut self, col: &str) -> Self {
        self.params.push(("order".into(), format!("{col}.desc")));
        self
    }

    pub fn limite(mut self, n: u32) -> Self {
        self.params.push(("limit".into(), n.to_string()));
        self
    }

    fn filtro(mut self, col: &str, v: String) -> Self {
        self.params.push((col.to_string(), v));
        self
    }
}

pub struct Supabase {
    http: Arc<dyn Http>,
    url: String,
    anon_key: String,
    credencial: Arc<dyn Credencial>,
    cliente: String,
}

impl Supabase {
    /// `url` sin barra final (ya viene normalizada por `normalizar_url_supabase`). `cliente` va en `X-Client-Info`.
    pub fn nuevo(http: Arc<dyn Http>, url: &str, anon_key: &str, credencial: Arc<dyn Credencial>, cliente: &str) -> Self {
        Supabase { http, url: url.trim_end_matches('/').to_string(), anon_key: anon_key.to_string(), credencial, cliente: cliente.to_string() }
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn anon_key(&self) -> &str {
        &self.anon_key
    }

    pub fn http(&self) -> &Arc<dyn Http> {
        &self.http
    }

    /// Cabeceras de todo pedido autenticado: `apikey` y `Authorization` con el token de la sesión o la anon key.
    pub fn cabeceras(&self) -> Vec<(String, String)> {
        let token = self.credencial.token().unwrap_or_else(|| self.anon_key.clone());
        vec![("apikey".into(), self.anon_key.clone()), ("Authorization".into(), format!("Bearer {token}")), ("X-Client-Info".into(), self.cliente.clone())]
    }

    fn mandar(&self, mut p: Pedido, cuerpo: Option<&Value>) -> ResPg {
        for (k, v) in self.cabeceras() {
            p = p.con_cabecera(&k, &v);
        }
        if let Some(c) = cuerpo {
            p = p.con_cabecera("Content-Type", "application/json").con_cuerpo(c.to_string().into_bytes());
        }
        let r = match self.http.pedir(&p) {
            Ok(r) => r,
            Err(e) => return ResPg { data: Value::Null, error: Some(ErrorPg { code: None, message: Some(e.to_string()) }) },
        };
        let json = r.json();
        if r.ok() {
            return ResPg { data: json.unwrap_or(Value::Null), error: None };
        }
        let campo = |k: &str| json.as_ref().and_then(|j| j.get(k)).and_then(Value::as_str).map(String::from);
        ResPg { data: Value::Null, error: Some(ErrorPg { code: campo("code"), message: campo("message").or_else(|| Some(format!("HTTP {}", r.estado))) }) }
    }

    fn url_de(&self, ruta: &str, params: &[(String, String)]) -> String {
        let mut u = url::Url::parse(&format!("{}{ruta}", self.url)).unwrap_or_else(|_| url::Url::parse("http://invalido.local/").expect("url fija"));
        if !params.is_empty() {
            u.query_pairs_mut().extend_pairs(params.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        }
        u.to_string()
    }

    pub fn ejecutar(&self, c: &Consulta) -> ResPg {
        let (metodo, prefer) = match c.verbo {
            Verbo::Select => ("GET", None),
            Verbo::Insert => ("POST", Some(if c.devolver { "return=representation" } else { "return=minimal" })),
            Verbo::Update => ("PATCH", Some(if c.devolver { "return=representation" } else { "return=minimal" })),
            Verbo::Delete => ("DELETE", Some(if c.devolver { "return=representation" } else { "return=minimal" })),
        };
        let mut p = Pedido::nuevo(metodo, &self.url_de(&format!("/rest/v1/{}", c.tabla), &c.params));
        if let Some(pr) = prefer {
            p = p.con_cabecera("Prefer", pr);
        }
        self.mandar(p, c.cuerpo.as_ref())
    }

    pub fn rpc(&self, nombre: &str, args: &Value) -> ResPg {
        let p = Pedido::nuevo("POST", &self.url_de(&format!("/rest/v1/rpc/{nombre}"), &[]));
        self.mandar(p, Some(args))
    }
}

#[cfg(test)]
pub mod pruebas {
    use super::*;
    use crate::features::chat::http::pruebas::{json_resp, HttpFalso};
    use crate::features::chat::http::{HttpUreq, Respuesta};
    use serde_json::json;

    pub struct SinToken;
    impl Credencial for SinToken {
        fn token(&self) -> Option<String> {
            None
        }
    }

    pub struct ConToken(pub &'static str);
    impl Credencial for ConToken {
        fn token(&self) -> Option<String> {
            Some(self.0.to_string())
        }
    }

    pub fn cliente_falso(http: Arc<dyn Http>) -> Supabase {
        Supabase::nuevo(http, "https://x.supabase.co", "anon", Arc::new(ConToken("jwt")), "sloth/test")
    }

    #[test]
    fn el_select_arma_la_url_con_filtros_orden_y_limite() {
        let http = HttpFalso::nuevo(|_| json_resp(200, json!([{"id": "a"}])));
        let sb = cliente_falso(http.clone());
        let r = sb.ejecutar(&Consulta::select("messages", "id, body").eq("team_id", "t1").lt("created_at", "2024-01-01T00:00:00+00:00").orden_desc("created_at").limite(50));
        assert_eq!(r.primera().unwrap()["id"], "a");
        let p = http.pedidos.lock().unwrap()[0].clone();
        assert_eq!(p.metodo, "GET");
        assert!(p.url.starts_with("https://x.supabase.co/rest/v1/messages?select=id%2Cbody&team_id=eq.t1&created_at=lt."), "{}", p.url);
        assert!(p.url.ends_with("&order=created_at.desc&limit=50"), "{}", p.url);
        let cab = |k: &str| p.cabeceras.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        assert_eq!(cab("apikey").as_deref(), Some("anon"));
        assert_eq!(cab("Authorization").as_deref(), Some("Bearer jwt"));
    }

    #[test]
    fn sin_sesion_se_firma_con_la_anon_key() {
        let http = HttpFalso::nuevo(|_| json_resp(200, json!([])));
        let sb = Supabase::nuevo(http.clone(), "https://x.supabase.co/", "anon", Arc::new(SinToken), "c");
        sb.ejecutar(&Consulta::select("t", "id"));
        let p = http.pedidos.lock().unwrap()[0].clone();
        assert!(p.cabeceras.contains(&("Authorization".to_string(), "Bearer anon".to_string())));
        assert!(p.url.starts_with("https://x.supabase.co/rest/v1/t?"));
    }

    #[test]
    fn el_in_va_entre_parentesis_y_cita_lo_que_lo_rompe() {
        let http = HttpFalso::nuevo(|_| json_resp(200, json!([])));
        let sb = cliente_falso(http.clone());
        sb.ejecutar(&Consulta::select("profiles", "id").en("id", &["a".into(), "b,c".into()]));
        let u = url::Url::parse(&http.pedidos.lock().unwrap()[0].url).unwrap();
        let (_, v) = u.query_pairs().find(|(k, _)| k == "id").unwrap();
        assert_eq!(v, "in.(a,\"b,c\")");
    }

    #[test]
    fn insert_pide_la_fila_solo_si_hay_select() {
        let http = HttpFalso::nuevo(|_| json_resp(201, json!([{"id": "n"}])));
        let sb = cliente_falso(http.clone());
        sb.ejecutar(&Consulta::insert("messages", json!({"body": "hola"})));
        sb.ejecutar(&Consulta::insert("messages", json!({"body": "hola"})).columnas("id"));
        let ps = http.pedidos.lock().unwrap().clone();
        let prefer = |i: usize| ps[i].cabeceras.iter().find(|(k, _)| k == "Prefer").map(|(_, v)| v.clone());
        assert_eq!(prefer(0).as_deref(), Some("return=minimal"));
        assert_eq!(prefer(1).as_deref(), Some("return=representation"));
        assert_eq!(ps[1].metodo, "POST");
        assert_eq!(serde_json::from_slice::<Value>(ps[1].cuerpo.as_ref().unwrap()).unwrap(), json!({"body": "hola"}));
    }

    #[test]
    fn update_delete_y_rpc_usan_su_verbo() {
        let http = HttpFalso::nuevo(|_| json_resp(200, json!("uuid-1")));
        let sb = cliente_falso(http.clone());
        sb.ejecutar(&Consulta::update("teams", json!({"name": "n"})).eq("id", "t").columnas("id"));
        sb.ejecutar(&Consulta::delete("team_invites").eq("id", "i").columnas("id"));
        let r = sb.rpc("create_team", &json!({"p_name": "x"}));
        assert_eq!(r.data, json!("uuid-1"));
        let metodos: Vec<String> = http.pedidos.lock().unwrap().iter().map(|p| p.metodo.to_string()).collect();
        assert_eq!(metodos, ["PATCH", "DELETE", "POST"]);
        assert!(http.pedidos.lock().unwrap()[2].url.ends_with("/rest/v1/rpc/create_team"));
    }

    #[test]
    fn el_error_de_postgrest_trae_codigo_y_mensaje() {
        let http = HttpFalso::nuevo(|_| json_resp(400, json!({"code": "P0001", "message": "No podés."})));
        let r = cliente_falso(http).rpc("x", &json!({}));
        assert_eq!(r.error, Some(ErrorPg { code: Some("P0001".into()), message: Some("No podés.".into()) }));
        assert_eq!(comprobar(&r, "respaldo"), Err("No podés.".to_string()));
    }

    #[test]
    fn solo_pasan_los_raise_de_nuestras_funciones() {
        let r = |code: &str| ResPg { data: Value::Null, error: Some(ErrorPg { code: Some(code.into()), message: Some("detalle interno".into()) }) };
        assert_eq!(comprobar(&r("42501"), "No se pudo."), Err("No se pudo.".to_string()));
        assert_eq!(comprobar(&ResPg { data: Value::Null, error: None }, "x"), Ok(()));
        let largo = ResPg { data: Value::Null, error: Some(ErrorPg { code: Some("P0001".into()), message: Some("x".repeat(400)) }) };
        assert_eq!(comprobar(&largo, "r").unwrap_err().len(), 300);
    }

    #[test]
    fn un_corte_de_red_es_error_sin_codigo() {
        let http = HttpFalso::nuevo(|_| Err(crate::features::chat::http::ErrorRed::Conexion("sin red".into())));
        let r = cliente_falso(http).ejecutar(&Consulta::select("t", "id"));
        assert_eq!(r.error.as_ref().unwrap().code, None);
        assert!(!falta_esquema(r.error.unwrap().codigo()));
        assert!(falta_esquema("42703") && falta_esquema("PGRST205") && !falta_esquema("42501"));
    }

    #[test]
    fn un_error_sin_cuerpo_json_dice_el_estado() {
        let http = HttpFalso::nuevo(|_| Ok(Respuesta { estado: 502, cuerpo: b"<html>".to_vec() }));
        let r = cliente_falso(http).rpc("x", &json!({}));
        assert_eq!(r.error.unwrap().message.as_deref(), Some("HTTP 502"));
    }

    #[test]
    fn contra_un_servidor_real_local_de_punta_a_punta() {
        use crate::features::chat::http::pruebas::ServidorFalso;
        let s = ServidorFalso::nuevo(|p| if p.ruta.starts_with("/rest/v1/profiles") { (200, br#"[{"id":"u","login":"ana"}]"#.to_vec()) } else { (404, b"{}".to_vec()) });
        let sb = Supabase::nuevo(Arc::new(HttpUreq), &s.base, "anon", Arc::new(ConToken("jwt")), "c");
        let r = sb.ejecutar(&Consulta::select("profiles", "id, login").eq("id", "u"));
        assert_eq!(r.primera().unwrap()["login"], "ana");
        assert_eq!(s.ultimo().cabecera("authorization"), Some("Bearer jwt"));
    }
}
