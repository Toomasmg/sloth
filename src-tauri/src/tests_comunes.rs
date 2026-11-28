//! Piezas simuladas para probar handlers y router sin ventana ni proceso de apoyo.
use crate::entorno::{DialogoArchivo, Entorno, PlataformaCompartida};
use crate::router::{Futuro, Reenvio, Respuesta};
use serde_json::Value;
use sloth_core::app_state::{OpcionesDeVentana, Plataforma};
use sloth_core::window_state_core::Rect;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub type Evento = (String, Vec<Value>);

#[derive(Default)]
pub struct PlataformaSimulada {
    pub eventos: Mutex<Vec<Evento>>,
    pub abiertos: Mutex<Vec<String>>,
    pub version: Mutex<Option<String>>,
    pub datos: Mutex<PathBuf>,
    pub guardar_en: Mutex<Option<PathBuf>>,
    pub elegido: Mutex<Option<PathBuf>>,
    pub papelera: Mutex<Vec<PathBuf>>,
}

impl PlataformaSimulada {
    pub fn fijar_version(&self, v: &str) {
        *self.version.lock().unwrap() = Some(v.to_string());
    }
}

impl Plataforma for PlataformaSimulada {
    fn nombre_app(&self) -> String {
        "Sloth".into()
    }
    fn version(&self) -> String {
        self.version.lock().unwrap().clone().unwrap_or_else(|| "0.0.0".into())
    }
    fn empaquetada(&self) -> bool {
        false
    }
    fn carpeta_de_datos(&self) -> PathBuf {
        self.datos.lock().unwrap().clone()
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

impl PlataformaCompartida for PlataformaSimulada {
    fn guardar_como(&self, _: &DialogoArchivo) -> Option<PathBuf> {
        self.guardar_en.lock().unwrap().clone()
    }
    fn elegir_archivo(&self, _: &DialogoArchivo) -> Option<PathBuf> {
        self.elegido.lock().unwrap().clone()
    }
    /// Sin Papelera en las pruebas: se anota y se borra.
    fn a_la_papelera(&self, ruta: &Path) -> Result<(), String> {
        self.papelera.lock().unwrap().push(ruta.to_path_buf());
        if ruta.is_dir() { fs::remove_dir_all(ruta) } else { fs::remove_file(ruta) }.map_err(|e| e.to_string())
    }
    fn carpeta_documentos(&self) -> PathBuf {
        self.carpeta_de_datos()
    }
    fn carpeta_whisper(&self) -> PathBuf {
        self.carpeta_de_datos().join("motor")
    }
    fn abrir_uri(&self, uri: &str) -> Result<(), String> {
        self.abiertos.lock().unwrap().push(uri.to_string());
        Ok(())
    }
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
        *plataforma.datos.lock().unwrap() = carpeta.clone();
        EntornoDePrueba { entorno: Entorno::nuevo(plataforma.clone()), plataforma, carpeta }
    }

    pub fn fijar_estado(&self, estado: &Value) {
        fs::write(self.carpeta.join("perfil").join("sloth-state.json"), serde_json::to_string_pretty(estado).unwrap()).unwrap();
    }

    /// Lo que contesta el proceso de apoyo a los canales que la función le pide por el router (p. ej. `workspaces:add`).
    pub fn fijar_apoyo(&self, f: impl Fn(&str, &[Value]) -> Respuesta + Send + Sync + 'static) {
        let f = Arc::new(f);
        self.entorno.fijar_pedidos(Arc::new(move |canal: String, args: Vec<Value>| {
            let r = f(&canal, &args);
            Box::pin(async move { r }) as Futuro<Respuesta>
        }));
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
