mod nativo;
mod permisos;
pub mod sidecar;
mod sistema;

use serde_json::Value;
use sidecar::Sidecar;
use std::sync::Arc;
use serde_json::json;
use tauri::{Manager, State, Window, WindowEvent};

pub struct Apoyo(pub Arc<Sidecar>);

#[tauri::command]
async fn ipc_invoke(apoyo: State<'_, Apoyo>, channel: String, args: Vec<Value>) -> Result<Value, String> {
    apoyo.0.invocar(channel, args).await
}

#[tauri::command]
fn ipc_send(apoyo: State<'_, Apoyo>, channel: String, args: Vec<Value>) {
    apoyo.0.enviar(channel, args);
}

/// Rectángulo lógico (DIP) de la ventana, como lo da `getBounds()` en Electron.
fn limites(v: &Window) -> Option<Value> {
    let f = v.scale_factor().ok()?;
    let p = v.outer_position().ok()?.to_logical::<f64>(f);
    let t = v.outer_size().ok()?.to_logical::<f64>(f);
    Some(json!({ "x": p.x.round(), "y": p.y.round(), "width": t.width.round(), "height": t.height.round() }))
}

fn avisar_ventana(v: &Window, evento: &WindowEvent) {
    let Some(a) = v.app_handle().try_state::<Apoyo>() else { return };
    let apoyo = &a.0;
    match evento {
        WindowEvent::ThemeChanged(t) => apoyo.evento_nativo("theme", json!([sistema::es_oscuro(*t)])),
        WindowEvent::Focused(f) => apoyo.evento_nativo("window", json!(["focused", f])),
        WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
            // Primero el estado y después el rectángulo: así el del tamaño normal no toma el de maximizada.
            apoyo.evento_nativo("window", json!(["maximized", v.is_maximized().unwrap_or(false)]));
            apoyo.evento_nativo("window", json!(["minimized", v.is_minimized().unwrap_or(false)]));
            if let Some(b) = limites(v) {
                apoyo.evento_nativo("window", json!(["bounds", b]));
            }
        }
        WindowEvent::CloseRequested { api, .. } => {
            // El cierre lo decide el main (confirma, manda a la bandeja o guarda estado y cierra las terminales).
            api.prevent_close();
            apoyo.evento_nativo("window", json!(["close"]));
        }
        _ => {}
    }
}

/// El tamaño de arranque (1500x920) puede ser mayor que la pantalla: se achica al área de trabajo y se centra.
/// Si el main tiene un tamaño guardado, lo aplica después con `setBounds`.
fn ajustar_a_pantalla(app: &tauri::AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    let (Ok(Some(m)), Ok(actual)) = (w.current_monitor(), w.outer_size()) else { return };
    let area = m.work_area().size;
    if actual.width > area.width || actual.height > area.height {
        let _ = w.set_size(tauri::PhysicalSize::new(actual.width.min(area.width), actual.height.min(area.height)));
        let _ = w.center();
    }
}

pub fn run() {
    tauri::Builder::default()
        // Primero: una segunda instancia solo trae la primera al frente y se va.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            if let Some(a) = app.try_state::<Apoyo>() {
                a.0.evento_nativo("app", json!(["second-instance"]));
            }
        }))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![ipc_invoke, ipc_send])
        .setup(|app| {
            let apoyo = sidecar::lanzar(app.handle().clone(), nativo::atender).map_err(|e| format!("Sloth no pudo arrancar: {e}"))?;
            app.manage(Apoyo(apoyo));
            ajustar_a_pantalla(app.handle());
            sistema::empujar_estado(app.handle());
            permisos::conceder_microfono(app.handle());
            Ok(())
        })
        .on_window_event(|ventana, evento| avisar_ventana(ventana, evento))
        .build(tauri::generate_context!())
        .expect("no se pudo iniciar Sloth")
        .run(|app, evento| {
            if let tauri::RunEvent::Exit = evento {
                if let Some(a) = app.try_state::<Apoyo>() {
                    a.0.cerrar();
                }
            }
        });
}
