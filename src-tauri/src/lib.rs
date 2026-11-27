mod nativo;
mod sidecar;

use serde_json::Value;
use sidecar::Sidecar;
use std::sync::Arc;
use tauri::{Manager, State};

struct Apoyo(Arc<Sidecar>);

#[tauri::command]
async fn ipc_invoke(apoyo: State<'_, Apoyo>, channel: String, args: Vec<Value>) -> Result<Value, String> {
    apoyo.0.invocar(channel, args).await
}

#[tauri::command]
fn ipc_send(apoyo: State<'_, Apoyo>, channel: String, args: Vec<Value>) {
    apoyo.0.enviar(channel, args);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![ipc_invoke, ipc_send])
        .setup(|app| {
            let apoyo = sidecar::lanzar(app.handle().clone(), nativo::atender).map_err(|e| format!("Sloth no pudo arrancar: {e}"))?;
            app.manage(Apoyo(apoyo));
            Ok(())
        })
        .on_window_event(|ventana, evento| {
            if let tauri::WindowEvent::Destroyed = evento {
                if let Some(a) = ventana.app_handle().try_state::<Apoyo>() {
                    a.0.cerrar();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("no se pudo iniciar Sloth");
}
