//! Bandeja del sistema en Rust (`feat:tray:*`): ícono con tooltip y menú según los agentes, el punto ámbar de la barra de
//! tareas, el titileo de la ventana, qué hace la X («Ocultar en la bandeja», el aviso con terminales abiertas o cerrar) y
//! `features/tray.json`. La lógica y los textos están en `sloth_core::features::tray`; los agentes, los permisos, las
//! terminales y los ajustes se piden a su dueño por el router, así anda con cualquier dueño del estado. Sin timers: se
//! recalcula al cambiar un agente o un permiso, al cerrarse una terminal y al enfocar.
use super::{arg, comun, AlHook};
use crate::entorno::Entorno;
use crate::router::Router;
use serde_json::{json, Value};
use sloth_core::avisos::Avisos;
use sloth_core::features::tray::{
    decidir_cierre, dialogo_de_apagado, dialogo_de_cierre, eleccion_de_cierre, resumir, validar_pedido, Accion, ArchivoBandeja, Cierre, Dialogo, Eleccion,
    ItemMenu, RespuestaDialogo, Resumen,
};
use std::cell::OnceCell;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, UserAttentionType, Wry};

pub const NOMBRE: &str = "tray";

/// Eventos hacia la UI que cambian lo que muestra la bandeja.
const EVENTOS_QUE_REFRESCAN: [&str; 4] = ["agent:status", "permission:new", "permission:resolved", "pty:exit"];
/// Los eventos llegan en ráfagas (un hook mueve varios agentes): se juntan antes de pedir el estado.
const JUNTAR: Duration = Duration::from_millis(80);

/// Lo que la bandeja necesita del escritorio. En la app es Tauri más Windows; en las pruebas, uno simulado.
pub trait Escritorio: Send + Sync {
    fn hay_bandeja(&self) -> bool;
    fn pintar_bandeja(&self, tooltip: &str, menu: &[ItemMenu]);
    /// El punto ámbar de la barra de tareas con su descripción, o ninguno.
    fn punto(&self, descripcion: Option<&str>);
    fn mostrar(&self);
    fn ocultar(&self);
    fn titilar(&self, si: bool);
    fn preguntar(&self, d: &Dialogo) -> RespuestaDialogo;
    /// Sale por el camino de siempre: el dueño de las terminales decide si las cierra («Terminales vivas»).
    fn salir(&self);
}

#[derive(Default)]
struct Pintado {
    resumen: Resumen,
    firma: Option<String>,
}

pub struct Bandeja {
    entorno: Arc<Entorno>,
    escritorio: Arc<dyn Escritorio>,
    archivo: Mutex<Option<ArchivoBandeja<'static>>>,
    pintado: Mutex<Pintado>,
    refrescar: Mutex<Option<Sender<()>>>,
    preguntando: AtomicBool,
}

fn avisar_pendientes() {
    for aviso in Avisos::global().tomar() {
        sloth_core::logger_global::aviso(NOMBRE, &aviso);
    }
}

impl Bandeja {
    pub fn nueva(entorno: Arc<Entorno>, escritorio: Arc<dyn Escritorio>) -> Arc<Bandeja> {
        let b = Arc::new(Bandeja {
            entorno,
            escritorio,
            archivo: Mutex::new(None),
            pintado: Mutex::new(Pintado::default()),
            refrescar: Mutex::new(None),
            preguntando: AtomicBool::new(false),
        });
        let (tx, rx) = mpsc::channel();
        *b.refrescar.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
        let debil = Arc::downgrade(&b);
        std::thread::spawn(move || refrescos(debil, rx));
        b
    }

    fn con_archivo<T>(&self, f: impl FnOnce(&mut ArchivoBandeja<'static>) -> Result<T, String>) -> Result<T, String> {
        let mut g = self.archivo.lock().unwrap_or_else(|e| e.into_inner());
        if g.is_none() {
            *g = Some(ArchivoBandeja::abrir(&self.entorno.carpeta_features()?.join("tray.json"), Avisos::global()));
        }
        let r = f(g.as_mut().expect("recién abierto"));
        drop(g);
        avisar_pendientes();
        r
    }

    pub fn ajustes(&self) -> Result<Value, String> {
        self.con_archivo(|a| Ok(a.a_json()))
    }

    pub fn fijar(&self, pedido: &Value) -> Result<Value, String> {
        let si = validar_pedido(pedido)?;
        self.con_archivo(|a| {
            a.guardar(si)?;
            Ok(a.a_json())
        })
    }

    fn pedir_refresco(&self) {
        if let Some(tx) = self.refrescar.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            let _ = tx.send(());
        }
    }

    /// Recalcula quién trabaja y quién te necesita; solo toca la bandeja y el punto si algo cambió.
    pub fn refrescar(&self) {
        let estado = comun::estado_del_dueno(&self.entorno);
        if estado.is_null() {
            return;
        }
        let pendientes = self.entorno.pedir("permission:pending", vec![], Duration::from_secs(5)).unwrap_or(Value::Null);
        let r = resumir(&estado, &pendientes);
        let mut p = self.pintado.lock().unwrap_or_else(|e| e.into_inner());
        if r.hay_nuevos(&p.resumen) && !self.entorno.con_foco() {
            self.escritorio.titilar(true);
        }
        let firma = r.firma();
        if p.firma.as_deref() != Some(firma.as_str()) {
            self.escritorio.pintar_bandeja(&r.tooltip(), &r.menu());
            self.escritorio.punto(r.descripcion_del_punto().as_deref());
            p.firma = Some(firma);
        }
        p.resumen = r;
    }

    pub fn mostrar(&self) {
        self.escritorio.mostrar();
        self.entorno.al_apoyo("window", json!(["visible", true]));
        // Con la ventana oculta Windows quita el botón de la barra de tareas y su punto: se vuelve a pintar.
        self.pintado.lock().unwrap_or_else(|e| e.into_inner()).firma = None;
        self.pedir_refresco();
    }

    fn ocultar(&self) {
        self.escritorio.ocultar();
        self.entorno.al_apoyo("window", json!(["visible", false]));
    }

    pub fn al_menu(self: &Arc<Self>, accion: Accion) {
        match accion {
            Accion::Mostrar => self.mostrar(),
            Accion::AbrirPendiente => {
                self.mostrar();
                let primero = self.pintado.lock().unwrap_or_else(|e| e.into_inner()).resumen.necesitan.first().cloned();
                if let Some(id) = primero {
                    comun::ui(&self.entorno, json!({ "type": "open-pane", "id": id }));
                }
            }
            Accion::ApagarYSalir => {
                let b = self.clone();
                std::thread::spawn(move || b.apagar_y_salir());
            }
            Accion::Salir => self.escritorio.salir(),
        }
    }

    fn apagar_y_salir(&self) {
        let info = self.entorno.pedir("daemon:info", vec![], Duration::from_secs(5)).unwrap_or(Value::Null);
        let corriendo = info.get("sessions").and_then(Value::as_u64).unwrap_or(0) as usize;
        if self.escritorio.preguntar(&dialogo_de_apagado(corriendo)).boton != 0 {
            return;
        }
        if let Err(e) = self.entorno.pedir("daemon:shutdown", vec![], Duration::from_secs(5)) {
            sloth_core::logger_global::aviso(NOMBRE, &format!("no se pudo apagar el daemon: {e}"));
        }
        self.escritorio.salir();
    }

    /// La X de la ventana (o Alt+F4). Se decide en un hilo aparte porque puede abrir un diálogo modal.
    pub fn al_pedir_cierre(self: &Arc<Self>) {
        if self.preguntando.swap(true, Ordering::SeqCst) {
            return;
        }
        let b = self.clone();
        std::thread::spawn(move || {
            b.decidir_cierre();
            b.preguntando.store(false, Ordering::SeqCst);
        });
    }

    fn decidir_cierre(&self) {
        let ajustes = comun::ajustes(&self.entorno).unwrap_or(Value::Null);
        let falso = |k: &str| ajustes.get(k) == Some(&Value::Bool(false));
        let hay_bandeja = self.escritorio.hay_bandeja();
        let a_la_bandeja = self.con_archivo(|a| Ok(a.a_la_bandeja())).unwrap_or(false);
        let estado = OnceCell::new();
        let estado = || estado.get_or_init(|| comun::estado_del_dueno(&self.entorno));
        let corriendo = OnceCell::new();
        let corriendo = || *corriendo.get_or_init(|| self.terminales_corriendo(estado()));
        match decidir_cierre(a_la_bandeja, hay_bandeja, !falso("confirmQuit"), corriendo) {
            Cierre::Ocultar => self.ocultar(),
            Cierre::Cerrar => self.escritorio.salir(),
            Cierre::Preguntar => {
                let ocupados = resumir(estado(), &Value::Null).trabajando;
                let respuesta = self.escritorio.preguntar(&dialogo_de_cierre(corriendo(), ocupados, !falso("keepTerminalsAlive"), hay_bandeja));
                let eleccion = eleccion_de_cierre(respuesta, hay_bandeja);
                // «No volver a preguntar» recuerda la elección: cerrar directo, o ir siempre a la bandeja.
                if respuesta.casilla {
                    self.recordar(eleccion);
                }
                match eleccion {
                    Eleccion::Cerrar => self.escritorio.salir(),
                    Eleccion::Bandeja => self.ocultar(),
                    Eleccion::Cancelar => {}
                }
            }
        }
    }

    fn recordar(&self, eleccion: Eleccion) {
        let r = match eleccion {
            Eleccion::Bandeja => self.con_archivo(|a| a.guardar(true)),
            Eleccion::Cerrar => self.entorno.pedir("feat:settings:set", vec![json!({ "confirmQuit": false })], Duration::from_secs(5)).map(|_| ()),
            Eleccion::Cancelar => Ok(()),
        };
        if let Err(e) = r {
            sloth_core::logger_global::aviso(NOMBRE, &format!("no se pudo guardar «Preguntar antes de cerrar»: {e}"));
        }
    }

    /// Terminales vivas de los espacios del perfil (las de otros perfiles en el daemon no cuentan).
    fn terminales_corriendo(&self, estado: &Value) -> usize {
        let ids = estado.get("workspaces").and_then(Value::as_array).into_iter().flatten().filter_map(|w| w.get("id").and_then(Value::as_str));
        ids.filter(|id| comun::terminal_viva(&self.entorno, id).unwrap_or(false)).count()
    }
}

fn refrescos(bandeja: Weak<Bandeja>, rx: Receiver<()>) {
    while rx.recv().is_ok() {
        std::thread::sleep(JUNTAR);
        while rx.try_recv().is_ok() {}
        let Some(b) = bandeja.upgrade() else { return };
        b.refrescar();
    }
}

impl AlHook for Bandeja {
    fn al_hook(&self, _: &str, _: Option<&str>) {
        self.pedir_refresco();
    }

    fn al_enfocar(&self) {
        self.escritorio.titilar(false);
        self.pedir_refresco();
    }

    fn al_evento(&self, evento: &str, _: &Value) {
        if evento == "terminalCerrada" {
            self.pedir_refresco();
        }
    }

    fn al_evento_ui(&self, canal: &str) {
        if EVENTOS_QUE_REFRESCAN.contains(&canal) {
            self.pedir_refresco();
        }
    }

    fn al_perfil(&self) {
        *self.archivo.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.pedir_refresco();
    }

    fn al_salir(&self) {
        self.refrescar.lock().unwrap_or_else(|e| e.into_inner()).take();
    }
}

pub fn registrar(router: &mut Router, bandeja: &Arc<Bandeja>) {
    let b = bandeja.clone();
    router.registrar("feat:tray:get", move |_| b.ajustes());
    let b = bandeja.clone();
    router.registrar("feat:tray:set", move |a| b.fijar(arg(&a, 0)));
}

const ID_BANDEJA: &str = "sloth";

/// En las pruebas e2e los diálogos no se muestran: contestan lo que fijó la prueba y quedan anotados para que los lea.
#[derive(Default)]
struct DialogosE2e {
    respuesta: Option<RespuestaDialogo>,
    vistos: Vec<Value>,
}

/// La bandeja sobre la API de Tauri, la ventana principal y lo de Windows que Tauri no trae (`ventanas_win`).
pub struct EscritorioTauri {
    app: AppHandle,
    e2e: Option<Mutex<DialogosE2e>>,
}

fn armar_menu(app: &AppHandle, items: &[ItemMenu]) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    for it in items {
        match it {
            ItemMenu::Accion(a, etiqueta) => menu.append(&MenuItem::with_id(app, a.id(), etiqueta, true, None::<&str>)?)?,
            ItemMenu::Separador => menu.append(&PredefinedMenuItem::separator(app)?)?,
        }
    }
    Ok(menu)
}

fn crear_bandeja(app: &AppHandle) -> tauri::Result<()> {
    let inicial = Resumen::default();
    let mut b = TrayIconBuilder::with_id(ID_BANDEJA)
        .menu(&armar_menu(app, &inicial.menu())?)
        .show_menu_on_left_click(false)
        .tooltip(inicial.tooltip())
        .on_menu_event(|app, e| {
            if let (Some(b), Some(a)) = (app.try_state::<Arc<Bandeja>>(), Accion::desde_id(e.id().as_ref())) {
                b.inner().al_menu(a);
            }
        })
        .on_tray_icon_event(|t, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                if let Some(b) = t.app_handle().try_state::<Arc<Bandeja>>() {
                    b.mostrar();
                }
            }
        });
    if let Some(icono) = app.default_window_icon().cloned() {
        b = b.icon(icono);
    }
    b.build(app).map(|_| ())
}

impl EscritorioTauri {
    fn ventana(&self) -> Option<tauri::WebviewWindow> {
        self.app.get_webview_window("main")
    }

    fn hwnd(&self) -> Option<isize> {
        self.ventana()?.hwnd().ok().map(|h| h.0 as isize)
    }

    fn preguntar_sin_ventanas_win(&self, d: &Dialogo) -> RespuestaDialogo {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
        let (primero, ultimo) = (d.botones[0].clone(), d.botones[d.cancelar].clone());
        let acepto = self.app.dialog().message(&d.detalle).title(&d.titulo).buttons(MessageDialogButtons::OkCancelCustom(primero, ultimo)).blocking_show();
        RespuestaDialogo { boton: if acepto { 0 } else { d.cancelar }, casilla: false }
    }
}

impl Escritorio for EscritorioTauri {
    fn hay_bandeja(&self) -> bool {
        self.app.tray_by_id(ID_BANDEJA).is_some()
    }

    fn pintar_bandeja(&self, tooltip: &str, menu: &[ItemMenu]) {
        let Some(t) = self.app.tray_by_id(ID_BANDEJA) else { return };
        let r = armar_menu(&self.app, menu).and_then(|m| t.set_menu(Some(m))).and_then(|_| t.set_tooltip(Some(tooltip)));
        if let Err(e) = r {
            sloth_core::logger_global::aviso(NOMBRE, &format!("no se pudo actualizar la bandeja: {e}"));
        }
    }

    fn punto(&self, descripcion: Option<&str>) {
        let Some(hwnd) = self.hwnd() else { return };
        let descripcion = descripcion.map(String::from);
        let _ = self.app.run_on_main_thread(move || {
            if let Err(e) = crate::ventanas_win::poner_punto(hwnd as *mut c_void, descripcion.as_deref()) {
                sloth_core::logger_global::aviso(NOMBRE, &e);
            }
        });
    }

    fn mostrar(&self) {
        let Some(w) = self.ventana() else { return };
        let _ = w.show();
        if w.is_minimized().unwrap_or(false) {
            let _ = w.unminimize();
        }
        let _ = w.set_focus();
    }

    fn ocultar(&self) {
        if let Some(w) = self.ventana() {
            let _ = w.hide();
        }
    }

    fn titilar(&self, si: bool) {
        if let Some(w) = self.ventana() {
            let _ = w.request_user_attention(si.then_some(UserAttentionType::Informational));
        }
    }

    fn preguntar(&self, d: &Dialogo) -> RespuestaDialogo {
        if let Some(e2e) = &self.e2e {
            let mut g = e2e.lock().unwrap_or_else(|e| e.into_inner());
            g.vistos.push(d.a_json());
            return g.respuesta.unwrap_or(RespuestaDialogo { boton: d.cancelar, casilla: false });
        }
        match self.hwnd().and_then(|h| crate::ventanas_win::dialogo(h as *mut c_void, d)) {
            Some(r) => r,
            None => self.preguntar_sin_ventanas_win(d),
        }
    }

    fn salir(&self) {
        salir_de_la_app(&self.app);
    }
}

/// El proceso de apoyo cierra la ventana como en Electron: guarda su estado, decide qué hacer con las terminales y sale
/// (y Tauri llega a `RunEvent::Exit`). Sin proceso de apoyo, se sale directo.
pub fn salir_de_la_app(app: &AppHandle) {
    match app.try_state::<crate::Apoyo>() {
        Some(a) => a.0.evento_nativo("window", json!(["close"])),
        None => app.exit(0),
    }
}

/// Arma la bandeja de la app (en el hilo principal, desde `setup`) y registra sus canales.
pub fn registrar_en_tauri(router: &mut Router, entorno: Arc<Entorno>, app: AppHandle) -> Arc<Bandeja> {
    if let Err(e) = crear_bandeja(&app) {
        sloth_core::logger_global::aviso(NOMBRE, &format!("no se pudo crear el ícono de la bandeja: {e}"));
    }
    let e2e = std::env::var_os("SLOTH_E2E").is_some();
    let escritorio = Arc::new(EscritorioTauri { app, e2e: e2e.then(Mutex::default) });
    let bandeja = Bandeja::nueva(entorno, escritorio.clone());
    registrar(router, &bandeja);
    if e2e {
        let e = escritorio.clone();
        router.registrar("e2e:dialogos:responder", move |a| {
            let r = arg(&a, 0);
            let respuesta = RespuestaDialogo {
                boton: r.get("response").and_then(Value::as_u64).unwrap_or(0) as usize,
                casilla: r.get("checkboxChecked").and_then(Value::as_bool).unwrap_or(false),
            };
            let mut g = e.e2e.as_ref().expect("solo en e2e").lock().unwrap_or_else(|x| x.into_inner());
            *g = DialogosE2e { respuesta: Some(respuesta), vistos: vec![] };
            Ok(Value::Null)
        });
        router.registrar("e2e:dialogos:vistos", move |_| Ok(Value::Array(escritorio.e2e.as_ref().expect("solo en e2e").lock().unwrap_or_else(|x| x.into_inner()).vistos.clone())));
    }
    bandeja
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::router::Respuesta;
    use crate::tests_comunes::{EntornoDePrueba, ReenvioNulo};
    use std::fs;

    #[derive(Default)]
    struct EscritorioSimulado {
        sin_bandeja: bool,
        pintadas: Mutex<Vec<(String, Vec<ItemMenu>)>>,
        puntos: Mutex<Vec<Option<String>>>,
        titileos: Mutex<Vec<bool>>,
        acciones: Mutex<Vec<&'static str>>,
        dialogos: Mutex<Vec<Dialogo>>,
        respuesta: Mutex<Option<RespuestaDialogo>>,
    }

    impl EscritorioSimulado {
        fn responder(&self, boton: usize, casilla: bool) {
            *self.respuesta.lock().unwrap() = Some(RespuestaDialogo { boton, casilla });
        }
        fn acciones(&self) -> Vec<&'static str> {
            self.acciones.lock().unwrap().clone()
        }
    }

    impl Escritorio for EscritorioSimulado {
        fn hay_bandeja(&self) -> bool {
            !self.sin_bandeja
        }
        fn pintar_bandeja(&self, tooltip: &str, menu: &[ItemMenu]) {
            self.pintadas.lock().unwrap().push((tooltip.into(), menu.to_vec()));
        }
        fn punto(&self, d: Option<&str>) {
            self.puntos.lock().unwrap().push(d.map(String::from));
        }
        fn mostrar(&self) {
            self.acciones.lock().unwrap().push("mostrar");
        }
        fn ocultar(&self) {
            self.acciones.lock().unwrap().push("ocultar");
        }
        fn titilar(&self, si: bool) {
            self.titileos.lock().unwrap().push(si);
        }
        fn preguntar(&self, d: &Dialogo) -> RespuestaDialogo {
            self.dialogos.lock().unwrap().push(d.clone());
            self.respuesta.lock().unwrap().unwrap_or(RespuestaDialogo { boton: d.cancelar, casilla: false })
        }
        fn salir(&self) {
            self.acciones.lock().unwrap().push("salir");
        }
    }

    struct Prueba {
        t: EntornoDePrueba,
        escritorio: Arc<EscritorioSimulado>,
        bandeja: Arc<Bandeja>,
        pedidos: Arc<Mutex<Vec<(String, Vec<Value>)>>>,
    }

    /// El dueño simulado: `state:get` con los agentes, permisos pendientes, terminales vivas y ajustes.
    fn armar(nombre: &str, escritorio: EscritorioSimulado, estado: Value, vivas: &[&str], ajustes: Value) -> Prueba {
        let t = EntornoDePrueba::nuevo(nombre);
        t.entorno.fijar_runtime(tokio::runtime::Handle::current());
        let pedidos = Arc::new(Mutex::new(Vec::new()));
        let anotados = pedidos.clone();
        let vivas: Vec<String> = vivas.iter().map(|s| s.to_string()).collect();
        let estado = Arc::new(Mutex::new(estado));
        let del_dueno = estado.clone();
        t.fijar_apoyo(move |canal, args| -> Respuesta {
            anotados.lock().unwrap().push((canal.to_string(), args.to_vec()));
            match canal {
                "state:get" => Ok(del_dueno.lock().unwrap().clone()),
                "permission:pending" => Ok(json!([{ "workspaceId": "b" }])),
                "pty:running" => Ok(json!(vivas.iter().any(|v| Some(v.as_str()) == args[0].as_str()))),
                "feat:settings:get" => Ok(json!({ "settings": ajustes })),
                "daemon:info" => Ok(json!({ "sessions": 3 })),
                _ => Ok(Value::Null),
            }
        });
        let escritorio = Arc::new(escritorio);
        let bandeja = Bandeja::nueva(t.entorno.clone(), escritorio.clone());
        Prueba { t, escritorio, bandeja, pedidos }
    }

    fn estado_base() -> Value {
        json!({ "workspaces": [{ "id": "a" }, { "id": "b" }], "agents": { "a": { "state": "working" } } })
    }

    fn pidio(p: &Prueba, canal: &str) -> Vec<Vec<Value>> {
        p.pedidos.lock().unwrap().iter().filter(|(c, _)| c == canal).map(|(_, a)| a.clone()).collect()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn refrescar_pinta_tooltip_menu_y_punto_y_solo_repinta_si_cambia() {
        let p = armar("tray-refrescar", EscritorioSimulado::default(), estado_base(), &[], json!({}));
        p.bandeja.refrescar();
        p.bandeja.refrescar();
        let pintadas = p.escritorio.pintadas.lock().unwrap().clone();
        assert_eq!(pintadas.len(), 1);
        assert_eq!(pintadas[0].0, "Sloth · 1 trabajando · 1 te necesitan");
        assert_eq!(pintadas[0].1[1], ItemMenu::Accion(Accion::AbrirPendiente, "1 espacio te necesita".into()));
        assert_eq!(*p.escritorio.puntos.lock().unwrap(), vec![Some("1 espacios te necesitan".to_string())]);
        // Sin foco y con alguien nuevo que te necesita, la ventana titila.
        assert_eq!(*p.escritorio.titileos.lock().unwrap(), vec![true]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn con_foco_no_titila_y_al_enfocar_deja_de_titilar() {
        let p = armar("tray-foco", EscritorioSimulado::default(), estado_base(), &[], json!({}));
        p.t.entorno.fijar_foco(true);
        p.bandeja.refrescar();
        p.bandeja.al_enfocar();
        assert_eq!(*p.escritorio.titileos.lock().unwrap(), vec![false]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn los_eventos_de_agentes_y_permisos_refrescan_y_los_demas_no() {
        let p = armar("tray-eventos", EscritorioSimulado::default(), estado_base(), &[], json!({}));
        p.bandeja.al_evento_ui("feat:git:status");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(pidio(&p, "state:get").is_empty());
        p.bandeja.al_evento_ui("agent:status");
        p.bandeja.al_evento_ui("permission:new");
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(pidio(&p, "state:get").len(), 1, "los eventos de una ráfaga se juntan");
        assert_eq!(p.escritorio.pintadas.lock().unwrap().len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn el_menu_muestra_abre_el_espacio_que_te_necesita_y_sale() {
        let p = armar("tray-menu", EscritorioSimulado::default(), estado_base(), &[], json!({}));
        p.bandeja.refrescar();
        p.bandeja.al_menu(Accion::AbrirPendiente);
        p.bandeja.al_menu(Accion::Salir);
        assert_eq!(p.escritorio.acciones(), ["mostrar", "salir"]);
        assert!(p.t.eventos().iter().any(|(c, a)| c == "ui:command" && a[0] == json!({ "type": "open-pane", "id": "b" })));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn apagar_y_salir_pregunta_con_las_terminales_del_daemon_y_cancelar_no_apaga() {
        let p = armar("tray-apagar", EscritorioSimulado::default(), estado_base(), &[], json!({}));
        p.bandeja.apagar_y_salir();
        assert!(p.escritorio.dialogos.lock().unwrap()[0].detalle.starts_with("Se van a cerrar 3 terminales"));
        assert!(pidio(&p, "daemon:shutdown").is_empty());
        assert!(p.escritorio.acciones().is_empty());
        p.escritorio.responder(0, false);
        p.bandeja.apagar_y_salir();
        assert_eq!(pidio(&p, "daemon:shutdown").len(), 1);
        assert_eq!(p.escritorio.acciones(), ["salir"]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn la_x_sin_terminales_cierra_sin_preguntar() {
        let p = armar("tray-x-sin", EscritorioSimulado::default(), estado_base(), &[], json!({}));
        p.bandeja.decidir_cierre();
        assert!(p.escritorio.dialogos.lock().unwrap().is_empty());
        assert_eq!(p.escritorio.acciones(), ["salir"]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn la_x_con_terminales_pregunta_y_cancelar_deja_sloth_abierto() {
        let p = armar("tray-x-cancelar", EscritorioSimulado::default(), estado_base(), &["a"], json!({ "keepTerminalsAlive": true }));
        p.bandeja.decidir_cierre();
        let d = p.escritorio.dialogos.lock().unwrap()[0].clone();
        assert_eq!(d.detalle, "Tenés 1 terminal abierta. Claude está trabajando en 1 de ellas. Siguen corriendo en segundo plano y vuelven tal cual al abrir Sloth.");
        assert_eq!(d.botones, ["Cerrar Sloth", "Ocultar en la bandeja", "Cancelar"]);
        assert!(p.escritorio.acciones().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ocultar_en_la_bandeja_con_no_volver_a_preguntar_lo_recuerda() {
        let p = armar("tray-x-bandeja", EscritorioSimulado::default(), estado_base(), &["a", "b"], json!({}));
        p.escritorio.responder(1, true);
        p.bandeja.decidir_cierre();
        assert_eq!(p.escritorio.acciones(), ["ocultar"]);
        assert!(p.t.carpeta.join("perfil").join("features").join("tray.json").exists());
        assert_eq!(p.bandeja.ajustes().unwrap(), json!({ "closeToTray": true }));
        // La próxima X va directo a la bandeja, sin diálogo.
        p.bandeja.decidir_cierre();
        assert_eq!(p.escritorio.dialogos.lock().unwrap().len(), 1);
        assert_eq!(p.escritorio.acciones(), ["ocultar", "ocultar"]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cerrar_con_no_volver_a_preguntar_apaga_el_aviso_en_configuracion() {
        let p = armar("tray-x-cerrar", EscritorioSimulado::default(), estado_base(), &["a"], json!({ "keepTerminalsAlive": false }));
        p.escritorio.responder(0, true);
        p.bandeja.decidir_cierre();
        assert_eq!(p.escritorio.dialogos.lock().unwrap()[0].tipo, sloth_core::features::tray::TipoDialogo::Advertencia);
        assert_eq!(pidio(&p, "feat:settings:set"), vec![vec![json!({ "confirmQuit": false })]]);
        assert_eq!(p.escritorio.acciones(), ["salir"]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn con_preguntar_apagado_cierra_aunque_haya_terminales() {
        let p = armar("tray-x-sin-aviso", EscritorioSimulado::default(), estado_base(), &["a"], json!({ "confirmQuit": false }));
        p.bandeja.decidir_cierre();
        assert!(pidio(&p, "pty:running").is_empty());
        assert_eq!(p.escritorio.acciones(), ["salir"]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn sin_icono_en_la_bandeja_no_se_ofrece_ocultar() {
        let p = armar("tray-x-sin-icono", EscritorioSimulado { sin_bandeja: true, ..Default::default() }, estado_base(), &["a"], json!({}));
        p.bandeja.fijar(&json!({ "closeToTray": true })).unwrap();
        p.escritorio.responder(1, false);
        p.bandeja.decidir_cierre();
        assert_eq!(p.escritorio.dialogos.lock().unwrap()[0].botones, ["Cerrar Sloth", "Cancelar"]);
        assert!(p.escritorio.acciones().is_empty());
    }

    #[tokio::test]
    async fn los_canales_leen_y_guardan_tray_json() {
        let t = EntornoDePrueba::nuevo("tray-canales");
        let bandeja = Bandeja::nueva(t.entorno.clone(), Arc::new(EscritorioSimulado::default()));
        let mut r = Router::nuevo(Arc::new(ReenvioNulo));
        registrar(&mut r, &bandeja);
        assert_eq!(r.invocar("feat:tray:get".into(), vec![]).await, Ok(json!({ "closeToTray": false })));
        assert_eq!(r.invocar("feat:tray:set".into(), vec![json!({ "closeToTray": "si" })]).await, Err("closeToTray tiene que ser true o false.".into()));
        assert_eq!(r.invocar("feat:tray:set".into(), vec![]).await, Err("Configuración inválida.".into()));
        assert_eq!(r.invocar("feat:tray:set".into(), vec![json!({ "closeToTray": true })]).await, Ok(json!({ "closeToTray": true })));
        let f = t.carpeta.join("perfil").join("features").join("tray.json");
        assert_eq!(serde_json::from_str::<Value>(&fs::read_to_string(f).unwrap()).unwrap(), json!({ "version": 1, "closeToTray": true }));
    }

    #[tokio::test]
    async fn sin_perfil_los_canales_esperan_al_arranque() {
        let t = EntornoDePrueba::sin_perfil("tray-sin-perfil");
        let bandeja = Bandeja::nueva(t.entorno.clone(), Arc::new(EscritorioSimulado::default()));
        assert_eq!(bandeja.ajustes(), Err("Sloth todavía está arrancando.".into()));
    }
}
