//! La `Plataforma` del núcleo (sloth_core::app_state) sobre Tauri: lo único que no puede hacer Rust puro.
use crate::entorno::{DialogoArchivo, PlataformaCompartida};
use serde_json::{json, Value};
use sloth_core::app_state::{es_enlace_externo, OpcionesDeVentana, Plataforma};
use sloth_core::window_state_core::Rect;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// Canal por el que la UI recibe todo lo que antes era `webContents.send` (lo reparte tauri-bridge.ts).
pub const EVENTO_UI: &str = "sloth://event";

/// La carpeta de datos es la misma que usaba la versión Electron (`%APPDATA%\Sloth`); `SLOTH_USER_DATA` la cambia en pruebas.
pub fn carpeta_de_datos(appdata: Option<PathBuf>, override_pruebas: Option<String>) -> PathBuf {
    match override_pruebas.filter(|s| !s.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => appdata.unwrap_or_default().join("Sloth"),
    }
}

pub struct PlataformaTauri {
    app: AppHandle,
    zoom: Mutex<f64>,
}

impl PlataformaTauri {
    pub fn nueva(app: AppHandle) -> PlataformaTauri {
        PlataformaTauri { app, zoom: Mutex::new(0.0) }
    }

    fn ventana(&self) -> Option<tauri::WebviewWindow> {
        self.app.get_webview_window("main")
    }
}

impl Plataforma for PlataformaTauri {
    fn nombre_app(&self) -> String {
        "Sloth".into()
    }

    fn version(&self) -> String {
        self.app.package_info().version.to_string()
    }

    fn empaquetada(&self) -> bool {
        !cfg!(debug_assertions)
    }

    fn carpeta_de_datos(&self) -> PathBuf {
        carpeta_de_datos(self.app.path().data_dir().ok(), std::env::var("SLOTH_USER_DATA").ok())
    }

    // tauri-plugin-single-instance ya corta la segunda copia antes de que haya ventana.
    fn pedir_instancia_unica(&self) -> bool {
        true
    }

    fn salir(&self, codigo: i32) {
        self.app.exit(codigo);
    }

    fn reiniciar(&self) {
        self.app.restart();
    }

    fn enviar_a_la_ventana(&self, canal: &str, args: &[Value]) {
        let _ = self.app.emit(EVENTO_UI, json!({ "channel": canal, "args": args }));
    }

    fn ventana_existe(&self) -> bool {
        self.ventana().is_some()
    }

    fn crear_ventana(&self, o: &OpcionesDeVentana) {
        // La ventana la crea tauri.conf.json; acá solo se le aplica lo que decide el núcleo.
        let Some(w) = self.ventana() else { return };
        let _ = w.set_min_size(Some(LogicalSize::new(o.ancho_minimo, o.alto_minimo)));
        let _ = w.set_size(LogicalSize::new(o.ancho, o.alto));
        if let (Some(x), Some(y)) = (o.x, o.y) {
            let _ = w.set_position(LogicalPosition::new(x, y));
        }
        let _ = w.set_title(o.titulo);
        if o.mostrar_al_crear {
            let _ = w.show();
        }
    }

    fn mostrar_ventana(&self, maximizada: bool, bounds: Option<&Rect>) {
        let Some(w) = self.ventana() else { return };
        if let Some(b) = bounds {
            let _ = w.set_position(LogicalPosition::new(b.x, b.y));
            let _ = w.set_size(LogicalSize::new(b.width, b.height));
        }
        if maximizada {
            let _ = w.maximize();
        }
        let _ = w.show();
    }

    fn enfocar_ventana(&self) {
        let Some(w) = self.ventana() else { return };
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }

    fn zoom_actual(&self) -> f64 {
        *self.zoom.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn fijar_zoom(&self, nivel: f64) {
        *self.zoom.lock().unwrap_or_else(|e| e.into_inner()) = nivel;
        if let Some(w) = self.ventana() {
            // Electron habla en niveles (1.2^n); el webview toma el factor.
            let _ = w.set_zoom(1.2f64.powf(nivel));
        }
    }

    fn abrir_enlace_externo(&self, url: &str) -> Result<(), String> {
        if !es_enlace_externo(url) {
            return Err("Solo se abren links http o https.".into());
        }
        self.app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
    }

    fn abrir_ruta(&self, ruta: &str) -> Result<(), String> {
        self.app.opener().open_path(ruta, None::<&str>).map_err(|e| e.to_string())
    }

    fn elegir_carpeta(&self) -> Option<String> {
        let ruta = self.app.dialog().file().blocking_pick_folder()?;
        ruta.into_path().ok().map(|p| p.to_string_lossy().into_owned())
    }

    fn mostrar_error(&self, titulo: &str, texto: &str) {
        self.app.dialog().message(texto).title(titulo).blocking_show();
    }

    fn leer_portapapeles(&self) -> Value {
        let texto = self.app.clipboard().read_text().unwrap_or_default();
        // Archivos copiados en el Explorador (CF_HDROP): el plugin no los lee.
        let archivos: Vec<String> = clipboard_win::get_clipboard(clipboard_win::formats::FileList).unwrap_or_default();
        json!({ "text": texto, "files": archivos })
    }

    fn escribir_portapapeles(&self, texto: &str) {
        let _ = self.app.clipboard().write_text(texto);
    }
}

impl PlataformaCompartida for PlataformaTauri {
    fn guardar_como(&self, d: &DialogoArchivo) -> Option<PathBuf> {
        let mut f = self.app.dialog().file().set_title(d.titulo).add_filter(d.filtro.0, d.filtro.1);
        if let Some(r) = &d.ruta_sugerida {
            if let Some(dir) = r.parent() {
                f = f.set_directory(dir);
            }
            if let Some(nombre) = r.file_name() {
                f = f.set_file_name(nombre.to_string_lossy());
            }
        }
        if let Some(w) = self.ventana() {
            f = f.set_parent(&w);
        }
        f.blocking_save_file()?.into_path().ok()
    }

    fn elegir_archivo(&self, d: &DialogoArchivo) -> Option<PathBuf> {
        let mut f = self.app.dialog().file().set_title(d.titulo).add_filter(d.filtro.0, d.filtro.1);
        if let Some(dir) = &d.ruta_sugerida {
            f = f.set_directory(dir);
        }
        if let Some(w) = self.ventana() {
            f = f.set_parent(&w);
        }
        f.blocking_pick_file()?.into_path().ok()
    }

    fn a_la_papelera(&self, ruta: &Path) -> Result<(), String> {
        trash::delete(ruta).map_err(|e| e.to_string())
    }

    fn mostrar_en_carpeta(&self, ruta: &Path) -> Result<(), String> {
        self.app.opener().reveal_item_in_dir(ruta).map_err(|e| e.to_string())
    }

    fn carpeta_documentos(&self) -> PathBuf {
        self.app.path().document_dir().unwrap_or_else(|_| self.carpeta_de_datos())
    }

    fn carpeta_whisper(&self) -> PathBuf {
        match crate::sidecar::raiz_de_la_app(&self.app) {
            (r, true) => r.join("whisper"),
            (r, false) => r.join("vendor").join("whisper"),
        }
    }

    fn abrir_uri(&self, uri: &str) -> Result<(), String> {
        self.app.opener().open_url(uri, None::<&str>).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn los_datos_van_a_la_misma_carpeta_que_electron() {
        let roaming = PathBuf::from(r"C:\Users\x\AppData\Roaming");
        assert_eq!(carpeta_de_datos(Some(roaming.clone()), None), roaming.join("Sloth"));
        assert_eq!(carpeta_de_datos(Some(roaming), Some(String::new())), PathBuf::from(r"C:\Users\x\AppData\Roaming").join("Sloth"));
    }

    #[test]
    fn sloth_user_data_manda_en_las_pruebas() {
        let roaming = PathBuf::from(r"C:\Users\x\AppData\Roaming");
        assert_eq!(carpeta_de_datos(Some(roaming), Some(r"D:\prueba".into())), PathBuf::from(r"D:\prueba"));
    }
}
