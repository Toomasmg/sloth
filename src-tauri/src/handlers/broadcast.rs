//! Canales `feat:broadcast:*` en Rust, como src/main/features/broadcast.ts. El envío lo hace la interfaz (`pty:write` y
//! la cola de los espacios que trabajan); acá solo se guardan los «Últimos envíos» en `features/broadcast.json` para
//! repetirlos después de reiniciar Sloth. La validación está en `sloth_core::features::broadcast`.
use super::arg;
use crate::entorno::Entorno;
use crate::router::Router;
use serde_json::Value;
use sloth_core::avisos::Avisos;
use sloth_core::features::broadcast::{leer_lista, lista_a_json, sumar, Envio};
use sloth_core::persistencia::{escribir_json_atomico, leer_json, OpcionesLectura};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub const NOMBRE: &str = "broadcast";

pub struct Broadcast {
    entorno: Arc<Entorno>,
    /// Los envíos del perfil que se leyó: con otro perfil se vuelve a leer su archivo.
    leidos: Mutex<Option<(PathBuf, Vec<Envio>)>>,
}

impl Broadcast {
    fn archivo(&self) -> Result<PathBuf, String> {
        Ok(self.entorno.carpeta_features()?.join("broadcast.json"))
    }

    fn con_envios<T>(&self, f: impl FnOnce(&PathBuf, &mut Vec<Envio>) -> Result<T, String>) -> Result<T, String> {
        let archivo = self.archivo()?;
        let mut g = self.leidos.lock().unwrap_or_else(|e| e.into_inner());
        if g.as_ref().is_none_or(|(p, _)| *p != archivo) {
            let validar = |v: &Value| leer_lista(v);
            let por_defecto = Vec::new;
            let envios = leer_json(&archivo, &OpcionesLectura::nuevas(&validar, &por_defecto), Avisos::global()).valor;
            *g = Some((archivo, envios));
        }
        let (p, envios) = g.as_mut().expect("recién leído");
        f(p, envios)
    }

    fn lista(&self) -> Result<Value, String> {
        self.con_envios(|_, e| Ok(lista_a_json(e)))
    }

    fn sumar(&self, raw: &Value) -> Result<Value, String> {
        self.con_envios(|archivo, envios| {
            let nuevos = sumar(envios, raw)?;
            escribir_json_atomico(archivo, &lista_a_json(&nuevos)).map_err(|e| e.to_string())?;
            *envios = nuevos;
            Ok(lista_a_json(envios))
        })
    }
}

pub fn registrar(router: &mut Router, entorno: Arc<Entorno>) {
    let b = Arc::new(Broadcast { entorno, leidos: Mutex::default() });
    let l = b.clone();
    router.registrar("feat:broadcast:list", move |_| l.lista());
    router.registrar("feat:broadcast:add", move |a| b.sumar(arg(&a, 0)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_comunes::{EntornoDePrueba, ReenvioNulo};
    use serde_json::json;

    fn armar(nombre: &str) -> (EntornoDePrueba, Router) {
        let t = EntornoDePrueba::nuevo(nombre);
        let mut router = Router::nuevo(Arc::new(ReenvioNulo));
        registrar(&mut router, t.entorno.clone());
        (t, router)
    }

    fn invocar(r: &Router, canal: &str, args: Vec<Value>) -> Result<Value, String> {
        tauri::async_runtime::block_on(r.invocar(canal.into(), args))
    }

    fn envio(id: &str) -> Value {
        json!({ "id": id, "time": 5, "text": " hola ", "ids": ["w1"], "names": ["Uno"] })
    }

    #[test]
    fn los_envios_se_guardan_primero_el_ultimo_y_sobreviven_a_reiniciar() {
        let (t, r) = armar("broadcast");
        assert_eq!(invocar(&r, "feat:broadcast:list", vec![]).unwrap(), json!([]));
        for i in 0..8 {
            invocar(&r, "feat:broadcast:add", vec![envio(&format!("e{i}"))]).unwrap();
        }
        let l = invocar(&r, "feat:broadcast:add", vec![envio("e3")]).unwrap();
        let ids: Vec<&str> = l.as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["e3", "e7", "e6", "e5", "e4", "e2"], "el repetido sube y quedan 6");
        assert_eq!(l[0]["text"], "hola");

        let mut otro = Router::nuevo(Arc::new(ReenvioNulo));
        registrar(&mut otro, t.entorno.clone());
        assert_eq!(invocar(&otro, "feat:broadcast:list", vec![]).unwrap(), l, "se lee del archivo");
    }

    #[test]
    fn un_envio_invalido_no_se_guarda() {
        let (_t, r) = armar("broadcast-invalido");
        for raw in [json!(null), json!({ "id": "x", "time": 1, "text": "   " }), json!({ "id": 3, "time": 1, "text": "a" }), json!({ "id": "x", "text": "a" })] {
            assert_eq!(invocar(&r, "feat:broadcast:add", vec![raw.clone()]).unwrap_err(), "Envío inválido.", "{raw}");
        }
        assert_eq!(invocar(&r, "feat:broadcast:list", vec![]).unwrap(), json!([]));
    }

    #[test]
    fn otro_perfil_lee_su_propio_archivo() {
        let (t, r) = armar("broadcast-perfiles");
        invocar(&r, "feat:broadcast:add", vec![envio("a")]).unwrap();
        let otro = t.carpeta.join("otro-perfil");
        std::fs::create_dir_all(&otro).unwrap();
        t.entorno.fijar_perfil(otro);
        assert_eq!(invocar(&r, "feat:broadcast:list", vec![]).unwrap(), json!([]));
    }
}
