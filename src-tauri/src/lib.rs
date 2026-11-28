mod entorno;
mod handlers;
mod handlers_estado;
mod nativo;
pub mod nucleo;
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

/// El proceso de apoyo visto desde el núcleo. Se conecta después de crear el núcleo: el apoyo arranca con el perfil y
/// la copia del estado que el núcleo ya decidió.
#[derive(Default)]
struct ApoyoDelNucleo(std::sync::OnceLock<Arc<Sidecar>>);

impl nucleo::Apoyo for ApoyoDelNucleo {
    fn evento(&self, nombre: &str, args: Value) {
        if let Some(s) = self.0.get() {
            s.evento_nativo(nombre, args);
        }
    }

    fn pedir(&self, canal: &str, args: Vec<Value>) -> Result<Value, String> {
        let s = self.0.get().ok_or("el proceso de apoyo no arrancó")?.clone();
        let canal = canal.to_string();
        tauri::async_runtime::block_on(async move {
            tokio::time::timeout(std::time::Duration::from_secs(10), s.invocar(canal, args)).await.map_err(|_| "el proceso de apoyo no respondió".to_string())?
        })
    }
}

/// El daemon de terminales: instalado, copiado a userData/daemon-bin/<versión> (así no queda abierto el de la carpeta
/// de instalación y el instalador puede actualizar con terminales vivas); en desarrollo, el de `out/daemon`.
fn exe_del_daemon(app: &tauri::AppHandle, raiz: &std::path::Path) -> Option<std::path::PathBuf> {
    if let Some(p) = std::env::var_os("SLOTH_DAEMON_EXE") {
        return Some(p.into());
    }
    let nombre = "sloth-daemon.exe";
    let (app_raiz, instalada) = sidecar::raiz_de_la_app(app);
    if !instalada {
        return Some(app_raiz.join("out").join("daemon").join(nombre)).filter(|p| p.exists());
    }
    let origen = app_raiz.join("daemon").join(nombre);
    let version: String = app.package_info().version.to_string().chars().map(|c| if c.is_ascii_alphanumeric() || ".+-".contains(c) { c } else { '_' }).collect();
    let destino = raiz.join("daemon-bin").join(version).join(nombre);
    if std::fs::read(&destino).ok() != std::fs::read(&origen).ok() {
        let _ = std::fs::create_dir_all(destino.parent()?);
        if std::fs::copy(&origen, &destino).is_err() {
            return Some(origen).filter(|p| p.exists());
        }
    }
    Some(destino)
}

/// Los avisos del núcleo (archivos dañados, perfiles) los muestra la función «avisos», que sigue en el apoyo.
fn pasar_avisos(n: &nucleo::Nucleo) {
    let avisos = sloth_core::avisos::Avisos::global().tomar();
    if !avisos.is_empty() {
        n.apoyo.evento("rust.avisos", json!([avisos]));
    }
}

fn arrancar(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use sloth_core::app_state::{texto_perfiles_bloqueados, Plataforma, TITULO_PERFILES_BLOQUEADOS};
    let plataforma = Arc::new(plataforma::PlataformaTauri::nueva(app.handle().clone()));
    let entorno = entorno::Entorno::nuevo(plataforma.clone());
    app.manage(entorno.clone());
    entorno.fijar_runtime(tauri::async_runtime::handle().inner().clone());
    let app_n = app.handle().clone();
    entorno.fijar_notificador(Arc::new(move |titulo, cuerpo| {
        use tauri_plugin_notification::NotificationExt;
        if let Err(e) = app_n.notification().builder().title(titulo).body(cuerpo).show() {
            sloth_core::logger_global::aviso("notificaciones", &format!("no se pudo mostrar el aviso del sistema: {e}"));
        }
    }));
    let raiz = plataforma.carpeta_de_datos();
    nucleo::arranque::iniciar_logger(&raiz);
    let (marca, crash_previo) = nucleo::arranque::MarcaDeSesion::iniciar(&raiz);
    sloth_core::logger_global::info("main", &sloth_core::app_state::linea_de_arranque(&app.package_info().version.to_string(), crash_previo));
    let prueba = std::env::var("SLOTH_USER_DATA").is_ok_and(|v| !v.is_empty());
    let antirea = if prueba { None } else { app.path().data_dir().ok().map(|d| d.join("AntiRea")) };
    let arranque = nucleo::arranque::arrancar(&raiz, antirea.as_deref(), sloth_core::avisos::Avisos::global());
    if let Some(motivo) = &arranque.bloqueado {
        marca.cerrar();
        // Con perfiles que no se pueden usar no hay un lugar seguro donde trabajar: se avisa y no se toca nada.
        plataforma.mostrar_error(TITULO_PERFILES_BLOQUEADOS, &texto_perfiles_bloqueados(motivo));
        std::process::exit(1);
    }
    entorno.fijar_perfil(arranque.perfil.clone());
    let para_apoyo = arranque.para_el_apoyo().to_string();
    let conf = nucleo::terminales::ConfDaemon { raiz: raiz.clone(), version: app.package_info().version.to_string(), exe: exe_del_daemon(app.handle(), &raiz) };
    let puente_apoyo = Arc::new(ApoyoDelNucleo::default());
    let nucleo = nucleo::Nucleo::nuevo(plataforma.clone(), arranque, puente_apoyo.clone(), conf);
    nucleo.fijar_sesion(marca, crash_previo);
    let n = nucleo.clone();
    entorno.fijar_fuente_del_estado(move || n.store().instantanea());
    if plataforma.empaquetada() {
        use tauri_plugin_autostart::ManagerExt;
        // Lo que diga Windows manda: si se apagó desde el Administrador de tareas, se refleja.
        if let Ok(activo) = app.autolaunch().is_enabled() {
            nucleo.fijar_ajuste_sin_guardar("openAtLogin", Value::Bool(activo));
        }
    }
    if let Some(w) = app.get_webview_window("main") {
        if let Ok(t) = w.theme() {
            nucleo.al_cambiar_tema_del_sistema(sistema::es_oscuro(t));
        }
    }
    app.manage(nucleo.clone());

    let extra = [("SLOTH_PERFIL_RUST", para_apoyo)];
    let apoyo = sidecar::lanzar(app.handle().clone(), nativo::atender, &extra).map_err(|e| format!("Sloth no pudo arrancar: {e}"))?;
    let _ = puente_apoyo.0.set(apoyo.clone());
    let apoyo_e = apoyo.clone();
    entorno.fijar_eventos_al_apoyo(Arc::new(move |nombre, args| apoyo_e.evento_nativo(nombre, args)));
    nucleo.copia_inicial();
    pasar_avisos(&nucleo);
    let n = nucleo.clone();
    sloth_core::avisos::Avisos::global().al_avisar(move || pasar_avisos(&n));

    let mut router = Router::nuevo(Arc::new(ReenvioApoyo(apoyo.clone())));
    let hooks = handlers::registrar_todo(&mut router, &entorno);
    nucleo.sumar_al_hook(hooks);
    nucleo.avisar_perfil_listo();
    let app_imagen = app.handle().clone();
    handlers_estado::registrar(&mut router, &nucleo, Arc::new(move || nativo::imagen_del_portapapeles(&app_imagen)));
    handlers::diagnostico::registrar(&mut router, &nucleo, tauri::webview_version().unwrap_or_default());
    handlers::sleep::registrar(&mut router, &nucleo);
    nucleo.arrancar_dormir();
    app.manage(router);
    // Los handlers piden por el router lo que atiende otro (p. ej. `workspaces:add`, que es del núcleo).
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
    app.manage(Apoyo(apoyo));

    // En otro hilo, sin esperar a la ventana: así la primera terminal que pide la interfaz ya encuentra el daemon
    // conectado y las shells detectadas. Después, el setup de cada cuenta.
    let n = nucleo.clone();
    std::thread::spawn(move || {
        if let Err(e) = n.backend() {
            sloth_core::logger_global::aviso("terminales", &e);
        }
        handlers_estado::precalentar();
        let cuentas = n.store().accounts().to_vec();
        for c in cuentas {
            n.cuentas.preparar(&n, &c);
        }
    });
    Ok(())
}

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
    if let (WindowEvent::Focused(true), Some(n)) = (evento, v.app_handle().try_state::<Arc<nucleo::Nucleo>>()) {
        n.al_enfocar();
    }
    let Some(a) = v.app_handle().try_state::<Apoyo>() else { return };
    let apoyo = &a.0;
    match evento {
        WindowEvent::ThemeChanged(t) => {
            apoyo.evento_nativo("theme", json!([sistema::es_oscuro(*t)]));
            if let Some(n) = v.app_handle().try_state::<Arc<nucleo::Nucleo>>() {
                n.al_cambiar_tema_del_sistema(sistema::es_oscuro(*t));
            }
        }
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
            arrancar(app)?;
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
                if let Some(n) = app.try_state::<Arc<nucleo::Nucleo>>() {
                    n.al_salir();
                }
                if let Some(a) = app.try_state::<Apoyo>() {
                    a.0.cerrar();
                }
            }
        });
}
