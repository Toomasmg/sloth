mod entorno;
mod handlers;
mod nativo;
mod permisos;
mod plataforma;
mod puente;
pub mod router;
pub mod sidecar;
mod sistema;
#[cfg(test)]
mod tests_comunes;

use serde_json::Value;
use router::{Futuro, Reenvio, Respuesta, Router};
use sidecar::Sidecar;
use std::sync::Arc;
use serde_json::json;
use tauri::{Manager, State, Window, WindowEvent};

pub struct Apoyo(pub Arc<Sidecar>);

/// El proceso de apoyo como destino de los canales que Rust no atiende.
struct ReenvioApoyo(Arc<Sidecar>);

impl Reenvio for ReenvioApoyo {
    fn invocar(&self, canal: String, args: Vec<Value>) -> Futuro<Respuesta> {
        let apoyo = self.0.clone();
        Box::pin(async move { apoyo.invocar(canal, args).await })
    }

    fn enviar(&self, canal: String, args: Vec<Value>) {
        self.0.enviar(canal, args);
    }
}

#[tauri::command]
async fn ipc_invoke(router: State<'_, Router>, channel: String, args: Vec<Value>) -> Result<Value, String> {
    let respuesta = router.invocar(channel, args);
    respuesta.await
}

#[tauri::command]
fn ipc_send(router: State<'_, Router>, channel: String, args: Vec<Value>) {
    router.enviar(channel, args);
}

/// Rectángulo lógico (DIP) de la ventana, como lo da `getBounds()` en Electron.
fn limites(v: &Window) -> Option<Value> {
    let f = v.scale_factor().ok()?;
    let p = v.outer_position().ok()?.to_logical::<f64>(f);
    let t = v.outer_size().ok()?.to_logical::<f64>(f);
    Some(json!({ "x": p.x.round(), "y": p.y.round(), "width": t.width.round(), "height": t.height.round() }))
}

fn avisar_ventana(v: &Window, evento: &WindowEvent) {
    if let (WindowEvent::Focused(f), Some(e)) = (evento, v.app_handle().try_state::<Arc<entorno::Entorno>>()) {
        e.fijar_foco(*f);
    }
    if let (WindowEvent::Focused(true), Some(h)) = (evento, v.app_handle().try_state::<puente::Hooks>()) {
        for f in &h.0 {
            f.al_enfocar();
        }
    }
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
            let entorno = entorno::Entorno::nuevo(Arc::new(plataforma::PlataformaTauri::nueva(app.handle().clone())));
            app.manage(entorno.clone());
            entorno.fijar_runtime(tauri::async_runtime::handle().inner().clone());
            let app_n = app.handle().clone();
            entorno.fijar_notificador(Arc::new(move |titulo, cuerpo| {
                use tauri_plugin_notification::NotificationExt;
                if let Err(e) = app_n.notification().builder().title(titulo).body(cuerpo).show() {
                    sloth_core::logger_global::aviso("notificaciones", &format!("no se pudo mostrar el aviso del sistema: {e}"));
                }
            }));
            let apoyo = sidecar::lanzar(app.handle().clone(), nativo::atender).map_err(|e| format!("Sloth no pudo arrancar: {e}"))?;
            let apoyo_e = apoyo.clone();
            entorno.fijar_eventos_al_apoyo(Arc::new(move |nombre, args| apoyo_e.evento_nativo(nombre, args)));
            let mut router = Router::nuevo(Arc::new(ReenvioApoyo(apoyo.clone())));
            let hooks = handlers::registrar_todo(&mut router, &entorno);
            app.manage(router);
            // Los handlers piden por el router lo que todavía tiene otro dueño (p. ej. `workspaces:add`).
            let app_h = app.handle().clone();
            entorno.fijar_pedidos(Arc::new(move |canal, args| {
                let futuro = app_h.try_state::<Router>().map(|r| r.invocar(canal, args));
                Box::pin(async move {
                    match futuro {
                        Some(f) => f.await,
                        None => Err("Sloth todavía está arrancando.".into()),
                    }
                })
            }));
            app.manage(puente::Hooks(hooks));
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
                if let Some(h) = app.try_state::<puente::Hooks>() {
                    for f in &h.0 {
                        f.al_salir();
                    }
                }
                if let Some(a) = app.try_state::<Apoyo>() {
                    a.0.cerrar();
                }
            }
        });
}
