//! Piezas simuladas para probar handlers y router sin ventana ni proceso de apoyo.
use crate::entorno::Entorno;
use crate::router::{Futuro, Reenvio, Respuesta};
use serde_json::Value;
use sloth_core::app_state::{OpcionesDeVentana, Plataforma};
use sloth_core::window_state_core::Rect;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub type Evento = (String, Vec<Value>);

#[derive(Default)]
pub struct PlataformaSimulada {
    pub eventos: Mutex<Vec<Evento>>,
    pub abiertos: Mutex<Vec<String>>,
}

impl Plataforma for PlataformaSimulada {
    fn nombre_app(&self) -> String {
        "Sloth".into()
    }
    fn version(&self) -> String {
        "0.0.0".into()
    }
    fn empaquetada(&self) -> bool {
        false
    }
    fn carpeta_de_datos(&self) -> PathBuf {
        PathBuf::new()
    }
    fn pedir_instancia_unica(&self) -> bool {
        true
    }
    fn salir(&self, _: i32) {}
    fn reiniciar(&self) {}
    fn enviar_a_la_ventana(&self, canal: &str, args: &[Value]) {
        self.eventos.lock().unwrap().push((canal.to_string(), args.to_vec()));
    }
    fn ventana_existe(&self) -> bool {
        true
    }
    fn crear_ventana(&self, _: &OpcionesDeVentana) {}
    fn mostrar_ventana(&self, _: bool, _: Option<&Rect>) {}
    fn enfocar_ventana(&self) {}
    fn zoom_actual(&self) -> f64 {
        0.0
    }
    fn fijar_zoom(&self, _: f64) {}
    fn abrir_enlace_externo(&self, url: &str) -> Result<(), String> {
        self.abiertos.lock().unwrap().push(url.to_string());
        Ok(())
    }
    fn abrir_ruta(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn elegir_carpeta(&self) -> Option<String> {
        None
    }
    fn mostrar_error(&self, _: &str, _: &str) {}
    fn leer_portapapeles(&self) -> Value {
        Value::Null
    }
    fn escribir_portapapeles(&self, _: &str) {}
}

pub struct EntornoDePrueba {
    pub entorno: Arc<Entorno>,
    pub plataforma: Arc<PlataformaSimulada>,
    pub carpeta: PathBuf,
}

impl EntornoDePrueba {
    /// Con la carpeta del perfil ya avisada, como queda cuando el proceso de apoyo terminó de arrancar.
    pub fn nuevo(nombre: &str) -> EntornoDePrueba {
        let t = EntornoDePrueba::sin_perfil(nombre);
        t.entorno.fijar_perfil(t.carpeta.join("perfil"));
        t
    }

    pub fn sin_perfil(nombre: &str) -> EntornoDePrueba {
        let carpeta = std::env::temp_dir().join(format!("sloth-router-{nombre}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&carpeta);
        fs::create_dir_all(carpeta.join("perfil")).unwrap();
        let plataforma = Arc::new(PlataformaSimulada::default());
        EntornoDePrueba { entorno: Entorno::nuevo(plataforma.clone()), plataforma, carpeta }
    }

    pub fn fijar_estado(&self, estado: &Value) {
        fs::write(self.carpeta.join("perfil").join("sloth-state.json"), serde_json::to_string_pretty(estado).unwrap()).unwrap();
    }

    pub fn eventos(&self) -> Vec<Evento> {
        self.plataforma.eventos.lock().unwrap().clone()
    }
}

impl Drop for EntornoDePrueba {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.carpeta);
    }
}

pub struct ReenvioNulo;

impl Reenvio for ReenvioNulo {
    fn invocar(&self, canal: String, _: Vec<Value>) -> Futuro<Respuesta> {
        Box::pin(async move { Err(format!("Sin handler para {canal}")) })
    }
    fn enviar(&self, _: String, _: Vec<Value>) {}
}
