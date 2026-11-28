//! Router híbrido de `ipc_invoke`: un canal con handler en Rust se atiende acá y el resto se reenvía al proceso de apoyo.
//! Así una función pasa a Rust sin tocar a las demás (ver docs/migracion-rust.md).
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

pub type Futuro<T> = Pin<Box<dyn Future<Output = T> + Send>>;
pub type Respuesta = Result<Value, String>;

/// A dónde van los canales que Rust no atiende. Es el proceso de apoyo; en los tests, uno simulado.
pub trait Reenvio: Send + Sync + 'static {
    fn invocar(&self, canal: String, args: Vec<Value>) -> Futuro<Respuesta>;
    fn enviar(&self, canal: String, args: Vec<Value>);
}

type Handler = Arc<dyn Fn(Vec<Value>) -> Respuesta + Send + Sync>;
type Oyente = Arc<dyn Fn(Vec<Value>) + Send + Sync>;

/// Canales internos entre Rust y el proceso de apoyo: la interfaz no los puede invocar aunque el apoyo los atienda.
pub const PREFIJO_INTERNO: &str = "nucleo:";

pub struct Router {
    handlers: HashMap<String, Handler>,
    oyentes: HashMap<String, Oyente>,
    reenvio: Arc<dyn Reenvio>,
}

impl Router {
    pub fn nuevo(reenvio: Arc<dyn Reenvio>) -> Router {
        Router { handlers: HashMap::new(), oyentes: HashMap::new(), reenvio }
    }

    /// Un canal tiene un solo dueño: registrarlo dos veces es un error de armado, no algo que se resuelva en silencio.
    pub fn registrar(&mut self, canal: &str, f: impl Fn(Vec<Value>) -> Respuesta + Send + Sync + 'static) {
        let anterior = self.handlers.insert(canal.to_string(), Arc::new(f));
        assert!(anterior.is_none(), "el canal {canal} ya tiene handler en Rust");
    }

    /// Un canal de `ipc_send` (sin respuesta) que atiende Rust, como `pty:write`.
    pub fn registrar_envio(&mut self, canal: &str, f: impl Fn(Vec<Value>) + Send + Sync + 'static) {
        let anterior = self.oyentes.insert(canal.to_string(), Arc::new(f));
        assert!(anterior.is_none(), "el envío {canal} ya tiene oyente en Rust");
    }

    pub fn atiende(&self, canal: &str) -> bool {
        self.handlers.contains_key(canal)
    }

    pub fn canales(&self) -> Vec<String> {
        let mut c: Vec<String> = self.handlers.keys().cloned().collect();
        c.sort();
        c
    }

    pub fn invocar(&self, canal: String, args: Vec<Value>) -> Futuro<Respuesta> {
        if canal.starts_with(PREFIJO_INTERNO) {
            return Box::pin(async move { Err(format!("Sin handler para {canal}")) });
        }
        let Some(h) = self.handlers.get(&canal).cloned() else { return self.reenvio.invocar(canal, args) };
        // Los handlers hacen E/S (git, archivos): van fuera del hilo que atiende los comandos de la ventana.
        Box::pin(async move {
            tokio::task::spawn_blocking(move || h(args))
                .await
                .unwrap_or_else(|_| Err(format!("Falló un proceso interno al atender {canal}.")))
        })
    }

    pub fn enviar(&self, canal: String, args: Vec<Value>) {
        if canal.starts_with(PREFIJO_INTERNO) {
            return;
        }
        match self.oyentes.get(&canal).cloned() {
            // En orden y sin esperar: lo que se escribe en una terminal no puede llegar desordenado.
            Some(f) => f(args),
            None => self.reenvio.enviar(canal, args),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    #[derive(Default)]
    struct ApoyoSimulado {
        invocados: Mutex<Vec<(String, Vec<Value>)>>,
        enviados: Mutex<Vec<(String, Vec<Value>)>>,
    }

    impl Reenvio for ApoyoSimulado {
        fn invocar(&self, canal: String, args: Vec<Value>) -> Futuro<Respuesta> {
            self.invocados.lock().unwrap().push((canal.clone(), args));
            Box::pin(async move {
                if canal == "falla" {
                    Err("Sin handler para falla".to_string())
                } else {
                    Ok(json!({ "desde": "apoyo", "canal": canal }))
                }
            })
        }
        fn enviar(&self, canal: String, args: Vec<Value>) {
            self.enviados.lock().unwrap().push((canal, args));
        }
    }

    fn armar() -> (Router, Arc<ApoyoSimulado>) {
        let apoyo = Arc::new(ApoyoSimulado::default());
        (Router::nuevo(apoyo.clone()), apoyo)
    }

    #[tokio::test]
    async fn un_canal_con_handler_de_rust_no_llega_al_apoyo() {
        let (mut r, apoyo) = armar();
        r.registrar("feat:x:suma", |a| Ok(json!(a[0].as_i64().unwrap() + a[1].as_i64().unwrap())));
        assert_eq!(r.invocar("feat:x:suma".into(), vec![json!(2), json!(3)]).await, Ok(json!(5)));
        assert!(apoyo.invocados.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn un_canal_sin_handler_se_reenvia_tal_cual() {
        let (mut r, apoyo) = armar();
        r.registrar("feat:x:suma", |_| Ok(Value::Null));
        let args = vec![json!("a"), json!({ "k": 1 })];
        let v = r.invocar("state:get".into(), args.clone()).await.unwrap();
        assert_eq!(v, json!({ "desde": "apoyo", "canal": "state:get" }));
        assert_eq!(*apoyo.invocados.lock().unwrap(), vec![("state:get".to_string(), args)]);
    }

    #[tokio::test]
    async fn el_error_del_apoyo_vuelve_igual() {
        let (r, _) = armar();
        assert_eq!(r.invocar("falla".into(), vec![]).await, Err("Sin handler para falla".to_string()));
    }

    #[tokio::test]
    async fn el_error_de_un_handler_de_rust_vuelve_con_su_mensaje() {
        let (mut r, apoyo) = armar();
        r.registrar("feat:x:mal", |_| Err("Espacio inválido.".into()));
        assert_eq!(r.invocar("feat:x:mal".into(), vec![]).await, Err("Espacio inválido.".to_string()));
        assert!(apoyo.invocados.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn un_handler_que_entra_en_panico_devuelve_error_y_el_router_sigue_andando() {
        let (mut r, _) = armar();
        r.registrar("feat:x:panico", |_| panic!("boom"));
        r.registrar("feat:x:ok", |_| Ok(json!(1)));
        let e = r.invocar("feat:x:panico".into(), vec![]).await.unwrap_err();
        assert!(e.contains("feat:x:panico"), "{e}");
        assert_eq!(r.invocar("feat:x:ok".into(), vec![]).await, Ok(json!(1)));
    }

    #[tokio::test]
    async fn el_envio_sin_oyente_en_rust_va_al_apoyo() {
        let (mut r, apoyo) = armar();
        r.registrar("pty:write", |_| Ok(Value::Null));
        r.enviar("pty:write".into(), vec![json!("id"), json!("ls")]);
        assert_eq!(apoyo.enviados.lock().unwrap().len(), 1);
    }

    #[test]
    fn el_envio_con_oyente_en_rust_no_llega_al_apoyo_y_respeta_el_orden() {
        let (mut r, apoyo) = armar();
        let vistos = Arc::new(Mutex::new(Vec::new()));
        let v = vistos.clone();
        r.registrar_envio("pty:write", move |a| v.lock().unwrap().push(a[1].clone()));
        for t in ["a", "b", "c"] {
            r.enviar("pty:write".into(), vec![json!("id"), json!(t)]);
        }
        assert_eq!(*vistos.lock().unwrap(), vec![json!("a"), json!("b"), json!("c")]);
        assert!(apoyo.enviados.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn la_interfaz_no_alcanza_los_canales_internos_del_apoyo() {
        let (r, apoyo) = armar();
        let e = r.invocar("nucleo:comando".into(), vec![]).await.unwrap_err();
        assert!(e.contains("nucleo:comando"));
        r.enviar("nucleo:x".into(), vec![]);
        assert!(apoyo.invocados.lock().unwrap().is_empty() && apoyo.enviados.lock().unwrap().is_empty());
    }

    #[test]
    #[should_panic(expected = "ya tiene handler")]
    fn registrar_dos_veces_el_mismo_canal_es_un_error_de_armado() {
        let (mut r, _) = armar();
        r.registrar("feat:x:a", |_| Ok(Value::Null));
        r.registrar("feat:x:a", |_| Ok(Value::Null));
    }

    #[test]
    fn los_canales_salen_ordenados() {
        let (mut r, _) = armar();
        r.registrar("feat:b:z", |_| Ok(Value::Null));
        r.registrar("feat:a:y", |_| Ok(Value::Null));
        assert_eq!(r.canales(), ["feat:a:y", "feat:b:z"]);
        assert!(r.atiende("feat:a:y") && !r.atiende("feat:a:otro"));
    }
}
