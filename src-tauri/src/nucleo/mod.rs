//! El dueño del estado de Sloth en la cáscara de Tauri: cuentas, espacios y paneles (`sloth-state.json`), la
//! Configuración (`features/settings.json`), las terminales (el daemon) y el estado de cada agente. Equivale al cuerpo
//! de src/main/index.ts. El proceso de apoyo ve una copia de solo lectura que se le empuja con cada cambio y pide sus
//! escrituras por el puente (`rust.*`); ver docs/migracion-rust.md.
pub mod ajustes;
pub mod arranque;
pub mod cuentas;
pub mod terminales;

use crate::entorno::PlataformaCompartida;
use crate::handlers::AlHook;
use arranque::{ahora_ms, Arranque};
use serde_json::{json, Map, Value};
use sloth_core::agent_machine::{EntradaAgente, EstadoAgente};
use sloth_core::app_state::{armar_estado, estado_de_hook, espera_hasta_dar_por_terminado, Agentes, EstadoDeAgente};
use sloth_core::avisos::Avisos;
use sloth_core::daemon_cliente::Evento;
use sloth_core::daemon_protocolo::{HookEventPayload, PendingPermission};
use sloth_core::hooks::estado_para_evento;
use sloth_core::perfiles_core::{decidir_cierre_terminales, es_terminal_propia, terminales_ajenas, CierreTerminales, Sesion};
use sloth_core::segundo_plano::{self as fondo, EventoFondo, Fondo};
use sloth_core::settings_model::resolver_oscuro;
use sloth_core::store::Store;
use sloth_core::versionado::Objeto;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, RwLock, Weak};
use terminales::{ConfDaemon, Terminales};

/// Lo que Rust le dice y le pide al proceso de apoyo mientras convivan. En los tests, uno simulado.
pub trait Apoyo: Send + Sync {
    /// Evento nativo (`native-event`): la copia del estado, los eventos de las terminales, los avisos.
    fn evento(&self, nombre: &str, args: Value);
    /// Pedido a un canal interno del apoyo (`nucleo:*`), esperando la respuesta.
    fn pedir(&self, canal: &str, args: Vec<Value>) -> Result<Value, String>;
}

pub fn texto_de_estado(s: &str) -> Option<EstadoAgente> {
    Some(match s {
        "idle" => EstadoAgente::Idle,
        "working" => EstadoAgente::Working,
        "waiting" => EstadoAgente::Waiting,
        "done" => EstadoAgente::Done,
        "exited" => EstadoAgente::Exited,
        "sleeping" => EstadoAgente::Sleeping,
        _ => return None,
    })
}

pub fn es_login(id: &str) -> bool {
    id.starts_with("login:")
}

fn bloquear<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub struct Nucleo {
    pub plataforma: Arc<dyn PlataformaCompartida>,
    pub arranque: Arranque,
    pub apoyo: Arc<dyn Apoyo>,
    store: Mutex<Store>,
    ajustes: Mutex<ajustes::Ajustes>,
    agentes: Mutex<Agentes>,
    fondos: Mutex<HashMap<String, Fondo>>,
    /// Primer mensaje que no se pudo pasar como argumento: se pega en el primer SessionStart del espacio.
    pegados: Mutex<HashMap<String, (String, u64)>>,
    /// El tamaño que le dio la PC a cada terminal (el celu la muestra igual y después se la devuelve).
    pub tam_pc: Mutex<HashMap<String, (u32, u32)>>,
    /// Terminales vivas del daemon que son de otro perfil: no se muestran ni se tocan.
    ajenas: Mutex<HashSet<String>>,
    terminales: Arc<Terminales>,
    rehidratado: AtomicBool,
    al_hook: RwLock<Vec<Arc<dyn AlHook>>>,
    pub cambiando_perfil: AtomicBool,
    sistema_oscuro: AtomicBool,
    oscuro_previo: Mutex<Option<bool>>,
    pub cuentas: cuentas::Cuentas,
    /// Pruebas (`SLOTH_INPROCESS=1`): las terminales no sobreviven a la app, como las de proceso de Electron.
    pub terminales_efimeras: bool,
    /// Las funciones del apoyo terminaron de registrarse (algunas fijan estado al arrancar, como los espacios dormidos).
    apoyo_listo: (Mutex<bool>, Condvar),
    yo: Weak<Nucleo>,
}

impl Nucleo {
    pub fn nuevo(plataforma: Arc<dyn PlataformaCompartida>, arranque: Arranque, apoyo: Arc<dyn Apoyo>, conf: ConfDaemon) -> Arc<Nucleo> {
        let avisos = Avisos::global();
        let store = Store::cargar(&arranque.perfil.join("sloth-state.json"), &antirea_vieja(&arranque.raiz), &arranque.raiz.to_string_lossy(), avisos);
        let ajustes = ajustes::Ajustes::cargar(&arranque.perfil.join("features").join("settings.json"), avisos);
        Arc::new_cyclic(|yo: &Weak<Nucleo>| {
            let debil = yo.clone();
            let terminales = Terminales::nuevas(
                conf,
                Arc::new(move |ev| {
                    if let Some(n) = debil.upgrade() {
                        n.al_evento(ev);
                    }
                }),
            );
            Nucleo {
                cuentas: cuentas::Cuentas::nuevas(&arranque.raiz),
                plataforma,
                arranque,
                apoyo,
                store: Mutex::new(store),
                ajustes: Mutex::new(ajustes),
                agentes: Mutex::default(),
                fondos: Mutex::default(),
                pegados: Mutex::default(),
                tam_pc: Mutex::default(),
                ajenas: Mutex::default(),
                terminales,
                rehidratado: AtomicBool::new(false),
                al_hook: RwLock::default(),
                cambiando_perfil: AtomicBool::new(false),
                sistema_oscuro: AtomicBool::new(true),
                oscuro_previo: Mutex::new(None),
                terminales_efimeras: std::env::var("SLOTH_INPROCESS").as_deref() == Ok("1"),
                apoyo_listo: (Mutex::new(false), Condvar::new()),
                yo: yo.clone(),
            }
        })
    }

    pub fn sumar_al_hook(&self, h: Vec<Arc<dyn AlHook>>) {
        self.al_hook.write().unwrap_or_else(|e| e.into_inner()).extend(h);
    }

    /// Las funciones de Rust se enteran de lo que pasa con cuentas y terminales (el chat registra su MCP en cada cuenta).
    pub fn avisar_funciones(&self, evento: &str, datos: &Value) {
        for h in self.al_hook.read().unwrap_or_else(|e| e.into_inner()).iter() {
            h.al_evento(evento, datos);
        }
    }

    /// Un pedido `rust.<función>` del proceso de apoyo para una función de Rust.
    pub fn nativo_de_funciones(&self, op: &str, args: &[Value]) -> Result<Value, String> {
        let hooks = self.al_hook.read().unwrap_or_else(|e| e.into_inner()).clone();
        hooks.iter().find_map(|h| h.nativo(op, args)).unwrap_or_else(|| Err(format!("operación desconocida: {op}")))
    }

    /// El perfil ya está cargado (Rust lo decide antes de registrar las funciones): las que mandan su estado a la UI
    /// al tenerlo (tickets) lo hacen ahora, en otro hilo para no demorar el arranque.
    pub fn avisar_perfil_listo(&self) {
        let hooks = self.al_hook.read().unwrap_or_else(|e| e.into_inner()).clone();
        std::thread::spawn(move || hooks.iter().for_each(|h| h.al_perfil()));
    }

    /// La ventana principal tomó el foco: las funciones de Rust que lo esperan (prs) se enteran.
    pub fn al_enfocar(&self) {
        for h in self.al_hook.read().unwrap_or_else(|e| e.into_inner()).iter() {
            h.al_enfocar();
        }
    }

    pub fn ui(&self, canal: &str, args: &[Value]) {
        self.plataforma.enviar_a_la_ventana(canal, args);
    }

    // ---- store ----

    pub fn store(&self) -> MutexGuard<'_, Store> {
        bloquear(&self.store)
    }

    pub fn espacio(&self, id: &str) -> Option<Value> {
        self.store().workspace(id).cloned()
    }

    pub fn cuenta(&self, id: &str) -> Option<Value> {
        self.store().account(id).cloned()
    }

    pub fn copia_del_estado(&self) -> Value {
        let s = self.store();
        let solo = s.solo_lectura().as_ref().map(sloth_core::app_state::solo_lectura_json);
        json!({ "estado": s.instantanea(), "soloLectura": solo, "confiable": s.confiable() })
    }

    /// Después de cada cambio del store: el proceso de apoyo trabaja con la copia nueva.
    pub fn empujar_estado(&self) {
        self.apoyo.evento("rust.estado", json!([self.copia_del_estado()]));
    }

    /// Cambia el store y empuja la copia. El cierre recibe el store bloqueado: no tiene que llamar al apoyo adentro.
    pub fn cambiar<R>(&self, f: impl FnOnce(&mut Store) -> Result<R, String>) -> Result<R, String> {
        let r = f(&mut self.store());
        self.empujar_estado();
        r
    }

    // ---- ajustes ----

    pub fn ajustes(&self) -> Objeto {
        bloquear(&self.ajustes).actuales().clone()
    }

    pub fn ajuste_bool(&self, k: &str) -> bool {
        bloquear(&self.ajustes).actuales().get(k).and_then(Value::as_bool).unwrap_or(false)
    }

    pub fn shell_elegida(&self) -> String {
        bloquear(&self.ajustes).actuales().get("terminal").and_then(|t| t.get("shell")).and_then(Value::as_str).unwrap_or("PowerShell 7").to_string()
    }

    pub fn fijar_ajuste_sin_guardar(&self, k: &str, v: Value) {
        bloquear(&self.ajustes).fijar_sin_guardar(k, v);
    }

    pub fn payload_de_ajustes(&self) -> Value {
        let s = self.ajustes();
        let theme = s.get("theme").and_then(Value::as_str).unwrap_or("oscuro").to_string();
        let documentos = std::env::var("USERPROFILE").map(|h| std::path::Path::new(&h).join("Documents").to_string_lossy().into_owned()).unwrap_or_default();
        json!({
            "settings": s,
            "dark": resolver_oscuro(&theme, self.sistema_oscuro.load(Ordering::Relaxed)),
            "loginItemSupported": self.plataforma.empaquetada() && cfg!(windows),
            "documentsDir": documentos,
        })
    }

    pub fn empujar_ajustes(&self) {
        self.apoyo.evento("rust.ajustes", json!([self.ajustes()]));
    }

    /// Guarda la Configuración nueva, avisa a la interfaz (`feat:settings:changed`) y al proceso de apoyo.
    pub fn guardar_ajustes(&self, nuevos: Objeto) -> Value {
        bloquear(&self.ajustes).cambiar(nuevos, Avisos::global());
        let p = self.payload_de_ajustes();
        *bloquear(&self.oscuro_previo) = p["dark"].as_bool();
        self.ui("feat:settings:changed", &[p.clone()]);
        self.empujar_ajustes();
        p
    }

    /// Con «Según Windows» la interfaz sigue al sistema en vivo.
    pub fn al_cambiar_tema_del_sistema(&self, oscuro: bool) {
        self.sistema_oscuro.store(oscuro, Ordering::Relaxed);
        let p = self.payload_de_ajustes();
        let mut previo = bloquear(&self.oscuro_previo);
        if *previo == p["dark"].as_bool() {
            return;
        }
        *previo = p["dark"].as_bool();
        drop(previo);
        self.ui("feat:settings:changed", &[p]);
    }

    // ---- agentes ----

    pub fn agentes_json(&self) -> Value {
        bloquear(&self.agentes).a_json()
    }

    pub fn estado_de_agente(&self, ws: &str) -> Option<EstadoDeAgente> {
        bloquear(&self.agentes).get(ws).cloned()
    }

    fn avisar_agente(&self, ws: &str, e: &EstadoDeAgente) {
        let v = e.a_json();
        self.ui("agent:status", &[json!(ws), v.clone()]);
        self.apoyo.evento("rust.agente", json!([ws, v]));
    }

    pub fn fijar_agente(&self, ws: &str, e: EstadoDeAgente) {
        bloquear(&self.agentes).fijar(ws, e.clone());
        self.avisar_agente(ws, &e);
    }

    pub fn olvidar_agente(&self, ws: &str) {
        bloquear(&self.agentes).quitar(ws);
        self.apoyo.evento("rust.agente", json!([ws, Value::Null]));
    }

    pub fn mover_agente(&self, ws: &str, entrada: EntradaAgente, detalle: Option<String>, at: Option<u64>) -> Option<EstadoDeAgente> {
        let nuevo = bloquear(&self.agentes).mover(ws, entrada, detalle, at, ahora_ms())?;
        self.avisar_agente(ws, &nuevo);
        Some(nuevo)
    }

    pub fn marcar_apoyo_listo(&self) {
        *bloquear(&self.apoyo_listo.0) = true;
        self.apoyo_listo.1.notify_all();
    }

    /// Como en Electron, el estado se entrega con las funciones ya registradas: si no, la interfaz abriría la terminal
    /// de un espacio que una función todavía no marcó como dormido. Con un apoyo caído no se espera para siempre.
    fn esperar_apoyo(&self) {
        let g = bloquear(&self.apoyo_listo.0);
        let _ = self.apoyo_listo.1.wait_timeout_while(g, std::time::Duration::from_secs(15), |listo| !*listo);
    }

    pub fn estado_ui(&self) -> Value {
        self.esperar_apoyo();
        let mut paneles = self.store().open_panes();
        // «Reabrir los espacios» apagado: solo vuelven los paneles cuyas terminales siguen vivas en el daemon.
        if !self.ajuste_bool("reopenSpaces") {
            paneles = match self.backend() {
                Ok(t) => paneles.into_iter().filter(|id| t.esta_corriendo(id)).collect(),
                Err(_) => vec![],
            };
        }
        let agentes = bloquear(&self.agentes);
        let s = self.store();
        armar_estado(s.accounts(), s.workspaces(), &paneles, &agentes, s.solo_lectura().as_ref())
    }

    // ---- terminales ----

    pub fn es_ajena(&self, id: &str) -> bool {
        bloquear(&self.ajenas).contains(id)
    }

    pub fn ajenas(&self) -> Vec<String> {
        bloquear(&self.ajenas).iter().cloned().collect()
    }

    /// El daemon conectado y, la primera vez, el estado rehidratado (agentes que siguieron trabajando con la app cerrada).
    pub fn backend(&self) -> Result<Arc<Terminales>, String> {
        self.terminales.asegurar()?;
        if !self.rehidratado.swap(true, Ordering::SeqCst) {
            self.rehidratar();
        }
        Ok(self.terminales.clone())
    }

    /// Las terminales si ya están conectadas, sin conectar.
    pub fn terminales_si_hay(&self) -> Option<Arc<Terminales>> {
        self.terminales.conectado().then(|| self.terminales.clone())
    }

    fn rehidratar(&self) {
        let sesiones = self.terminales.list().unwrap_or_default();
        let corriendo: HashSet<String> = sesiones.iter().filter(|s| s.running).map(|s| s.id.clone()).collect();
        let propias: Vec<Sesion> = sesiones.iter().map(|s| Sesion { id: s.id.clone(), running: s.running }).collect();
        let ajenas = {
            let st = self.store();
            terminales_ajenas(&propias, &|id| es_terminal_propia(id, &|x| st.workspace(x).is_some(), &|x| st.account(x).is_some()))
        };
        bloquear(&self.ajenas).extend(ajenas.iter().cloned());
        for (ws, ev) in self.terminales.ultimos_hooks() {
            if self.espacio(&ws).is_none() || !corriendo.contains(&ws) {
                continue;
            }
            if let Some((estado, detalle)) = estado_para_evento(&ev.event, ev.tool.as_deref(), ev.message.as_deref()) {
                self.fijar_agente(&ws, EstadoDeAgente { estado, detalle, at: ev.at.unwrap_or_else(ahora_ms) });
            }
        }
        for id in &corriendo {
            if self.espacio(id).is_some() && self.estado_de_agente(id).is_none() {
                self.fijar_agente(id, EstadoDeAgente { estado: EstadoAgente::Idle, detalle: None, at: ahora_ms() });
            }
        }
        for r in self.terminales.permisos() {
            self.al_permiso(r);
        }
        self.apoyo.evento("rust.pty", json!(["sesiones", corriendo.iter().collect::<Vec<_>>(), ajenas]));
    }

    fn al_evento(&self, ev: Evento) {
        match ev {
            Evento::Data { id, chunks } => {
                if self.es_ajena(&id) {
                    return;
                }
                let c = serde_json::to_value(&chunks).unwrap_or(Value::Null);
                self.ui("pty:data", &[json!(id), c.clone()]);
                self.apoyo.evento("rust.pty", json!(["data", id, c]));
            }
            Evento::Exit { id, code } => {
                if bloquear(&self.ajenas).remove(&id) {
                    return;
                }
                self.ui("pty:exit", &[json!(id), json!(code)]);
                self.apoyo.evento("rust.pty", json!(["exit", id, code]));
                self.avisar_funciones("terminalCerrada", &Value::Null);
                // Un espacio dormido sigue «Dormido» (su terminal se cerró a propósito).
                if self.espacio(&id).is_some() {
                    self.mover_agente(&id, EntradaAgente::Exit, None, None);
                }
            }
            Evento::Hook(p) => {
                if !self.es_ajena(&p.ws) {
                    self.al_hook(p);
                }
            }
            Evento::Permission(r) => self.al_permiso(r),
            Evento::PermissionResolved(id) => {
                self.ui("permission:resolved", &[json!(id)]);
                self.apoyo.evento("rust.pty", json!(["permission-resolved", id]));
            }
            Evento::Disconnect => sloth_core::logger_global::aviso("terminales", "desconectado del daemon"),
            Evento::Reconnect(_) => self.apoyo.evento("rust.pty", json!(["info", self.terminales.info()])),
        }
    }

    /// Evento de hook de Claude → estado del espacio. Los avisos de Windows los manda la función «permissions».
    pub fn al_hook(&self, mut p: HookEventPayload) {
        let ahora = ahora_ms();
        let en_fondo = {
            let mut f = bloquear(&self.fondos);
            let e = EventoFondo { ws: &p.ws, evento: &p.event, notification_type: p.notification_type.as_deref(), en_segundo_plano: p.en_segundo_plano == Some(true), aviso_de_tarea: p.aviso_de_tarea == Some(true) };
            fondo::registrar(&mut f, &e, ahora);
            let n = fondo::pendientes(&f, &p.ws, ahora);
            fondo::es_falso_final(&e, n).then_some(n)
        };
        if let Some(n) = en_fondo {
            p.en_fondo = Some(n as u64);
        }
        self.apoyo.evento("rust.pty", json!(["hook", p]));
        for h in self.al_hook.read().unwrap_or_else(|e| e.into_inner()).iter() {
            h.al_hook(&p.event, Some(&p.ws));
        }
        if p.event == "SessionStart" {
            self.pegar_primer_mensaje(&p.ws);
        }
        if self.espacio(&p.ws).is_none() {
            return;
        }
        let n = p.en_fondo.unwrap_or(0) as usize;
        let Some((estado, detalle)) = estado_de_hook(n, estado_para_evento(&p.event, p.tool.as_deref(), p.message.as_deref())) else { return };
        let Some(nuevo) = self.mover_agente(&p.ws, EntradaAgente::Hook(estado), detalle, Some(p.at.unwrap_or(ahora))) else { return };
        if n == 0 {
            return;
        }
        let Some(vence) = fondo::vence_en(&bloquear(&self.fondos), &p.ws, ahora) else { return };
        // Si el aviso del shell nunca llega, no queda «trabajando» para siempre.
        let espera = espera_hasta_dar_por_terminado(vence, ahora);
        let (ws, nucleo) = (p.ws.clone(), self.yo.clone());
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(espera));
            if let Some(n) = nucleo.upgrade() {
                if n.estado_de_agente(&ws).as_ref() == Some(&nuevo) {
                    n.fijar_agente(&ws, EstadoDeAgente { estado: EstadoAgente::Done, detalle: None, at: ahora_ms() });
                }
            }
        });
    }

    /// Pedido de permiso → tarjeta en la UI. Si el espacio no existe, Claude pregunta en la terminal.
    pub fn al_permiso(&self, r: PendingPermission) {
        if self.espacio(&r.ws).is_none() {
            self.terminales.responder_permiso(&r.id, Value::Null);
            return;
        }
        let v = prompt_de_permiso(&r);
        self.ui("permission:new", &[v.clone()]);
        self.apoyo.evento("rust.pty", json!(["permission", r]));
    }

    pub fn permisos_pendientes(&self) -> Vec<Value> {
        let Some(t) = self.terminales_si_hay() else { return vec![] };
        t.permisos().iter().filter(|r| self.espacio(&r.ws).is_some()).map(prompt_de_permiso).collect()
    }

    pub fn anotar_pegado(&self, id: &str, texto: String) {
        bloquear(&self.pegados).insert(id.to_string(), (texto, ahora_ms() + sloth_core::espacios::VIGENCIA_PEGADO_MS));
    }

    fn pegar_primer_mensaje(&self, ws: &str) {
        let Some((texto, hasta)) = bloquear(&self.pegados).remove(ws) else { return };
        // Recién acá se gasta: si Sloth se cerró antes de pegarlo, la próxima terminal lo vuelve a intentar.
        let mut parche = Map::new();
        parche.insert("initialPromptUsed".into(), Value::Bool(true));
        let nombre = self.espacio(ws).and_then(|w| w["name"].as_str().map(str::to_owned));
        if nombre.is_some() {
            let _ = self.cambiar(|s| s.update_workspace(ws, &parche));
        }
        match sloth_core::espacios::decidir_pegado(ahora_ms(), hasta, nombre.as_deref()) {
            sloth_core::espacios::DecisionPegado::Vencido(t) => Avisos::global().avisar(t),
            sloth_core::espacios::DecisionPegado::Pegar => {
                let (ws, t) = (ws.to_string(), self.terminales.clone());
                // Sin Enter: si Claude se cerró en el medio, el texto queda en la línea de la shell sin ejecutarse.
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(sloth_core::espacios::ESPERA_PEGADO_MS));
                    t.write(&ws, &sloth_core::shell_args::paste_payload(&texto));
                });
            }
        }
    }

    pub fn escribir_crudo(&self, id: &str, data: &str) {
        if !self.es_ajena(id) {
            self.terminales.write(id, data);
        }
    }

    /// Lo que la persona escribe en una terminal (desde la UI o desde una función del apoyo).
    pub fn escribir(&self, id: &str, data: &str) {
        if self.es_ajena(id) {
            return;
        }
        self.terminales.write(id, data);
        self.apoyo.evento("rust.pty", json!(["write", id, data]));
        // Un agente sin hooks (Codex) no avisa al empezar otro turno: lo que escribís lo saca de «terminó» a «idle».
        let Some(ws) = self.espacio(id) else { return };
        let con_hooks = ws["accountId"].as_str().and_then(|a| self.cuenta(a)).map(|c| sloth_core::proveedores::capacidades_de(&c).map(|k| k.hooks) != Some(false));
        if let Some(con_hooks) = con_hooks {
            let prev = self.estado_de_agente(id).map(|e| e.estado);
            if sloth_core::agent_machine::salida_de_done_sin_hooks(prev, con_hooks, data) {
                self.mover_agente(id, EntradaAgente::Hook(EstadoAgente::Idle), None, None);
            }
        }
    }

    pub fn redimensionar(&self, id: &str, cols: u32, rows: u32, recordar: bool) {
        if self.es_ajena(id) {
            return;
        }
        if recordar {
            bloquear(&self.tam_pc).insert(id.to_string(), (cols, rows));
            self.apoyo.evento("rust.pty", json!(["tam", id, cols, rows]));
        }
        self.terminales.resize(id, cols, rows);
    }

    pub fn matar(&self, id: &str) -> Result<(), String> {
        let t = self.backend()?;
        if self.es_ajena(id) {
            return Err("Esa terminal es de otro perfil.".into());
        }
        t.kill(id)?;
        if self.espacio(id).is_some() {
            self.mover_agente(id, EntradaAgente::Exit, None, None);
        }
        Ok(())
    }

    pub fn cerrar_terminales_ajenas(&self) -> Result<usize, String> {
        let t = self.backend()?;
        let mut cerradas = 0;
        for id in self.ajenas() {
            match t.kill(&id) {
                Ok(()) => {
                    bloquear(&self.ajenas).remove(&id);
                    cerradas += 1;
                }
                Err(e) => sloth_core::logger_global::error("perfiles", e),
            }
        }
        self.apoyo.evento("rust.pty", json!(["ajenas", self.ajenas()]));
        Ok(cerradas)
    }

    /// De a una: el daemon no cierra bien varias a la vez.
    fn cerrar_terminales_propias(&self, t: &Arc<Terminales>) {
        let ids: Vec<String> = {
            let s = self.store();
            s.workspaces().iter().filter_map(|w| w["id"].as_str().map(str::to_owned)).chain(s.accounts().iter().filter_map(|a| a["id"].as_str().map(|i| format!("login:{i}")))).collect()
        };
        for id in ids {
            if t.esta_corriendo(&id) {
                if let Err(e) = t.kill(&id) {
                    sloth_core::logger_global::error("perfiles", e);
                }
            }
        }
    }

    /// Al salir: con «Terminales vivas» la conexión se suelta y el daemon sigue; apagado, se cierran sus terminales.
    pub fn al_salir(&self) {
        for h in self.al_hook.read().unwrap_or_else(|e| e.into_inner()).iter() {
            h.al_salir();
        }
        let Some(t) = self.terminales_si_hay() else { return };
        if self.terminales_efimeras {
            t.apagar();
            return;
        }
        let conservar = self.ajuste_bool("keepTerminalsAlive") || self.cambiando_perfil.load(Ordering::SeqCst);
        match decidir_cierre_terminales(conservar, false, !self.ajenas().is_empty()) {
            CierreTerminales::Conservar => t.soltar(),
            CierreTerminales::Apagar => t.apagar(),
            _ => {
                self.cerrar_terminales_propias(&t);
                t.soltar();
            }
        }
    }

    pub fn info_daemon(&self) -> Result<Value, String> {
        let t = self.backend()?;
        let sesiones = t.list().unwrap_or_default().iter().filter(|s| s.running).count();
        let mut info = t.info();
        info["sessions"] = json!(sesiones);
        Ok(info)
    }

    pub fn apagar_daemon(&self) -> Result<(), String> {
        let t = self.backend()?;
        let sesiones = t.list().unwrap_or_default();
        t.apagar();
        self.rehidratado.store(false, Ordering::SeqCst);
        for s in sesiones.into_iter().filter(|s| s.running) {
            self.ui("pty:exit", &[json!(s.id), json!(-1)]);
            self.apoyo.evento("rust.pty", json!(["exit", s.id, -1]));
            if self.espacio(&s.id).is_some() {
                self.mover_agente(&s.id, EntradaAgente::Exit, None, None);
            }
        }
        Ok(())
    }

    pub fn responder_permiso(&self, req: &str, decision: Value) {
        self.terminales.responder_permiso(req, decision);
    }

    pub fn cuenta_ocupada(&self, id: &str) -> bool {
        let Some(t) = self.terminales_si_hay() else { return false };
        let s = self.store();
        sloth_core::cuentas::cuenta_ocupada(id, s.workspaces(), &|x| t.esta_corriendo(x))
    }

    /// Todo lo que el proceso de apoyo necesita al arrancar para trabajar sin tocar los archivos (se manda una vez).
    pub fn copia_inicial(&self) {
        self.empujar_ajustes();
        self.apoyo.evento("rust.agentes", json!([self.agentes_json()]));
        self.empujar_estado();
    }
}

fn antirea_vieja(raiz: &std::path::Path) -> String {
    raiz.parent().map(|p| p.join("AntiRea").to_string_lossy().into_owned()).unwrap_or_default()
}

pub fn prompt_de_permiso(r: &PendingPermission) -> Value {
    let mut o = Map::new();
    o.insert("id".into(), json!(r.id));
    o.insert("workspaceId".into(), json!(r.ws));
    o.insert("tool".into(), json!(r.tool));
    o.insert("input".into(), r.input.clone());
    if let Some(s) = &r.suggestions {
        o.insert("suggestions".into(), json!(s));
    }
    o.insert("at".into(), json!(r.at));
    o.insert("expiresAt".into(), json!(r.expires_at));
    Value::Object(o)
}
