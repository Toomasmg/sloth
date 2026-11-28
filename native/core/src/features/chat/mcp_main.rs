//! Lado main del MCP del chat: el canal local (solo con el interruptor prendido), los tokens por cuenta y el registro con
//! el CLI de Claude Code (`claude mcp add/remove`), con `sloth-hook chat-mcp` como comando del servidor. Equivale a
//! chat-mcp.ts. Los canales viven en la función «chat» (`feat:chat:mcp*`).
//!
//! El registro de una cuenta es escribir su `.claude.json` por el CLI: con otro agente no se toca nada, y nunca mientras
//! la cuenta tenga terminales abiertas (se aplica al cerrarlas). El token solo vive en el registro de esa cuenta; acá se
//! guarda su sha256, y se guarda recién con el registro hecho: hasta ahí ningún token de esa cuenta vale.
use super::datos::ChatDatos;
use super::mcp_atencion::{Atencion, AtencionDeps, MsgLeido};
use super::mcp_core::{con_grant, debe_registrar, hash_token, modo_riesgoso, parsear_config, sin_grant, validar_cuentas, ConvCandidata, McpConfig, MCP_LIMITS};
use super::mcp_pipe::{borrar_info, escribir_info, iniciar_canal, linea_de_respuesta, ruta_del_canal, ServidorCanal};
use super::mcp_registro::{args_alta_helper, args_baja, leer_registro, planificar, Accion, Registro};
use super::tipos::*;
use super::{mensaje_corto, Res};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

const CLI_MS: u64 = 30_000;
const REINTENTO_MS: u64 = 1500;

/// Qué se sabe del agente de una cuenta.
#[derive(Debug, Clone)]
pub enum ProveedorMcp {
    /// Un agente que esta versión de Sloth no conoce.
    Desconocido { aviso: String, nombre: String },
    /// Un agente que existe pero todavía no tiene chat con MCP.
    SinMcp { nombre: String },
    /// `exe` es el CLI resuelto (puede faltar); `env` es el entorno de la cuenta (su carpeta de config).
    Soporta { exe: Option<String>, env: Vec<(String, String)> },
}

#[derive(Debug, Clone)]
pub struct CuentaMcp {
    pub id: String,
    pub label: String,
    pub config_dir: PathBuf,
    pub proveedor: ProveedorMcp,
}

#[derive(Debug, Clone)]
pub struct EspacioMcp {
    pub nombre: String,
    pub cuenta: String,
    pub cwd: PathBuf,
}

/// Lo que el MCP necesita del resto de la app.
pub trait EntornoMcp: Send + Sync {
    fn emitir(&self, canal: &str, payload: Value);
    fn log(&self, msg: &str);
    fn cuentas(&self) -> Vec<CuentaMcp>;
    /// Ruta absoluta de `sloth-hook(.exe)`: es el comando que Claude Code arranca como servidor MCP.
    fn helper_exe(&self) -> Option<String>;
    /// Ya se sabe qué terminales sobrevivieron en el daemon (al arrancar todavía no).
    fn terminales_conocidas(&self) -> bool;
    /// Hay backend de terminales y la cuenta no tiene ninguna abierta: recién ahí se puede tocar su `.claude.json`.
    fn cuenta_libre(&self, id: &str) -> bool;
    /// Corre el CLI de la cuenta. Un fallo es el texto que se le muestra a la persona.
    fn correr(&self, exe: &str, args: &[String], env: &[(String, String)]) -> Res<()>;
    fn espacio(&self, id: &str) -> Option<EspacioMcp>;
    fn ventana_con_foco(&self) -> bool;
    fn notificar(&self, titulo: &str, cuerpo: &str);
    fn ahora_ms(&self) -> i64;
    fn nuevo_id(&self) -> String;
}

/// `execFile` del CLI: sin ventana, con tope de tiempo y de salida; el error es la primera línea de stderr.
pub fn correr_claude(exe: &str, args: &[String], env: &[(String, String)], timeout_ms: u64) -> Res<()> {
    let mut c = Command::new(exe);
    c.args(args).envs(env.iter().map(|(k, v)| (k, v))).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let mut hijo = c.spawn().map_err(|e| format!("Claude Code no pudo cambiar su config: {}", mensaje_corto(&e.to_string())))?;
    let mut err = hijo.stderr.take();
    // stderr se lee aparte: si el CLI escribe mucho, un pipe lleno lo dejaría colgado.
    let lector = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(e) = err.as_mut() {
            let _ = e.take(256 * 1024).read_to_end(&mut buf);
        }
        buf
    });
    let inicio = std::time::Instant::now();
    let estado = loop {
        match hijo.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if inicio.elapsed() > Duration::from_millis(timeout_ms) => {
                let _ = hijo.kill();
                let _ = hijo.wait();
                return Err("Claude Code no pudo cambiar su config: tardó demasiado.".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(format!("Claude Code no pudo cambiar su config: {}", mensaje_corto(&e.to_string()))),
        }
    };
    let stderr = String::from_utf8_lossy(&lector.join().unwrap_or_default()).into_owned();
    if estado.success() {
        return Ok(());
    }
    let detalle: String = stderr.trim().lines().next().unwrap_or("").chars().take(200).collect();
    Err(format!("Claude Code no pudo cambiar su config: {detalle}"))
}

fn bloquear<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn leer_json_suave(f: &std::path::Path) -> Value {
    std::fs::read_to_string(f).ok().and_then(|t| serde_json::from_str(t.trim_start_matches('\u{feff}')).ok()).unwrap_or_else(|| json!({}))
}

struct Interno {
    env: Arc<dyn EntornoMcp>,
    datos: Arc<ChatDatos>,
    cfg: Mutex<McpConfig>,
    regs: Mutex<HashMap<String, ChatMcpAccountReg>>,
    /// Los cambios de una misma cuenta van de a uno.
    colas: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    archivo_cfg: PathBuf,
    archivo_info: PathBuf,
    carpeta_datos: PathBuf,
    servidor: Mutex<Option<ServidorCanal>>,
    reintento: AtomicBool,
}

pub struct McpMain {
    i: Arc<Interno>,
    atencion: Arc<Atencion<Interno>>,
}

impl Interno {
    fn existentes(&self) -> Vec<String> {
        self.env.cuentas().into_iter().map(|c| c.id).collect()
    }

    fn vista(&self) -> ChatMcpView {
        let cuentas = self.env.cuentas();
        let ids: Vec<&str> = cuentas.iter().map(|c| c.id.as_str()).collect();
        let cfg = bloquear(&self.cfg).clone();
        let regs = bloquear(&self.regs);
        ChatMcpView {
            enabled: cfg.enabled,
            cuentas: cfg.cuentas.iter().filter(|c| ids.contains(&c.as_str())).cloned().collect(),
            grants: cfg.grants.iter().filter(|g| ids.contains(&g.account_id.as_str())).cloned().collect(),
            limits: ChatMcpLimits { enviar_por_minuto: MCP_LIMITS.enviar_por_minuto, leer_por_minuto: MCP_LIMITS.leer_por_minuto, max_texto: MCP_LIMITS.max_texto, max_leer: MCP_LIMITS.max_leer },
            accounts: cuentas.iter().map(|a| regs.get(&a.id).cloned().unwrap_or_else(|| ChatMcpAccountReg { account_id: a.id.clone(), label: a.label.clone(), state: EstadoRegistro::Revisando, detail: None })).collect(),
            via_column: self.datos.columna_via(),
        }
    }

    fn emitir_config(&self) {
        self.env.emitir("mcpConfig", json!(self.vista()));
    }

    fn guardar(&self) -> Res<()> {
        let datos = bloquear(&self.cfg).a_json();
        crate::persistencia::escribir_json_atomico(&self.archivo_cfg, &datos).map(|_| ()).map_err(|e| e.to_string())
    }

    fn guardar_o_loguear(&self) {
        if let Err(e) = self.guardar() {
            self.env.log(&format!("chat-mcp: no se pudo guardar la config: {e}"));
        }
    }

    /// El token deja de valer en el acto; sacarlo de la config de la cuenta puede esperar.
    fn invalidar_token(&self, cuenta: &str) -> bool {
        let mut c = bloquear(&self.cfg);
        let antes = c.tokens.len();
        c.tokens.retain(|(id, _)| id != cuenta);
        c.tokens.len() != antes
    }

    fn registro_actual(&self, a: &CuentaMcp) -> Option<Registro> {
        let f = a.config_dir.join(".claude.json");
        if !f.exists() {
            return Some(Registro::Ausente);
        }
        let t = std::fs::read_to_string(&f).ok()?;
        let v: Value = serde_json::from_str(t.trim_start_matches('\u{feff}')).ok()?;
        Some(leer_registro(&v))
    }

    fn poner(&self, a: &CuentaMcp, estado: EstadoRegistro, detalle: Option<&str>) {
        bloquear(&self.regs).insert(a.id.clone(), ChatMcpAccountReg { account_id: a.id.clone(), label: a.label.clone(), state: estado, detail: detalle.map(String::from) });
    }

    /// Deja la cuenta como corresponde a la config: registrada, sin registro o sin tocar. Nunca tira: lo que falla queda en
    /// el estado de la cuenta.
    fn sincronizar(&self, a: &CuentaMcp, baja: bool) {
        if let Err(e) = self.sincronizar_o_error(a, baja) {
            self.poner(a, EstadoRegistro::Error, Some(&mensaje_corto(&e)));
        }
    }

    fn sincronizar_o_error(&self, a: &CuentaMcp, baja: bool) -> Res<()> {
        let (exe, env) = match &a.proveedor {
            ProveedorMcp::Desconocido { aviso, .. } => return Ok(self.poner(a, EstadoRegistro::Error, Some(aviso))),
            ProveedorMcp::SinMcp { nombre } => return Ok(self.poner(a, EstadoRegistro::NoSoportado, Some(&format!("Esta cuenta es de {nombre}: el chat con MCP todavía no está disponible.")))),
            ProveedorMcp::Soporta { exe, env } => (exe.clone(), env.clone()),
        };
        let quiere = {
            let c = bloquear(&self.cfg);
            !baja && debe_registrar(c.enabled, &c.cuentas, &a.id, &self.existentes())
        };
        if !quiere && self.invalidar_token(&a.id) {
            self.guardar()?;
        }
        if !a.config_dir.exists() {
            return Ok(self.poner(a, EstadoRegistro::Error, Some("Falta la carpeta de la cuenta.")));
        }
        let Some(actual) = self.registro_actual(a) else { return Ok(self.poner(a, EstadoRegistro::Error, Some("No se pudo leer el .claude.json de la cuenta; no se tocó."))) };
        let helper = self.env.helper_exe();
        let hash_guardado = bloquear(&self.cfg).hash_de(&a.id).map(String::from);
        let accion = planificar(quiere, &actual, helper.as_deref().unwrap_or(""), hash_guardado.as_deref(), hash_token);
        match accion {
            Accion::Nada => return Ok(self.poner(a, EstadoRegistro::Ok, None)),
            Accion::Conflicto => return Ok(self.poner(a, EstadoRegistro::Conflicto, Some("Ya hay un MCP «sloth» que no puso Sloth; no se tocó."))),
            _ => {}
        }
        let Some(exe) = exe else { return Ok(self.poner(a, EstadoRegistro::SinCli, Some("No encontré Claude Code (claude.exe) en el PATH; no se tocó nada."))) };
        if quiere && helper.is_none() {
            return Ok(self.poner(a, EstadoRegistro::Error, Some("No encontré sloth-hook junto a Sloth: Claude no puede arrancar el MCP.")));
        }
        // Al arrancar, las terminales que sobrevivieron en el daemon todavía no se conocen: se espera a que las reporten.
        if !self.env.terminales_conocidas() {
            return Ok(self.poner(a, EstadoRegistro::Pendiente, Some("Todavía no se sabe si hay terminales abiertas con esta cuenta. Se reintenta solo.")));
        }
        if !self.env.cuenta_libre(&a.id) {
            return Ok(self.poner(a, EstadoRegistro::Pendiente, Some("Se aplica cuando cierres las terminales de esta cuenta.")));
        }
        if accion != Accion::Baja && self.invalidar_token(&a.id) {
            self.guardar()?;
        }
        if matches!(accion, Accion::Baja | Accion::Reemplazo) {
            self.env.correr(&exe, &args_baja(), &env)?;
        }
        if accion == Accion::Baja {
            return Ok(self.poner(a, EstadoRegistro::Ok, None));
        }
        let mut b = [0u8; 32];
        getrandom::getrandom(&mut b).map_err(|e| e.to_string())?;
        let token = hex::encode(b);
        self.env.correr(&exe, &args_alta_helper(helper.as_deref().unwrap_or(""), &token)?, &env)?;
        // El hash se guarda recién con el registro hecho: hasta ahí, ningún token de esta cuenta vale.
        {
            let mut c = bloquear(&self.cfg);
            c.tokens.retain(|(id, _)| id != &a.id);
            c.tokens.push((a.id.clone(), hash_token(&token)));
        }
        self.guardar()?;
        self.poner(a, EstadoRegistro::Ok, None);
        Ok(())
    }

    fn cola_de(&self, id: &str) -> Arc<Mutex<()>> {
        bloquear(&self.colas).entry(id.to_string()).or_default().clone()
    }

    /// Sincroniza una cuenta ahora, detrás de lo que ya estuviera corriendo para ella, y avisa a la UI.
    fn sincronizar_ahora(&self, a: &CuentaMcp, baja: bool) {
        let cola = self.cola_de(&a.id);
        let _turno = bloquear(&cola);
        self.sincronizar(a, baja);
        self.emitir_config();
    }

    fn programar(self: &Arc<Self>, a: CuentaMcp, baja: bool) -> std::thread::JoinHandle<()> {
        let i = self.clone();
        std::thread::spawn(move || i.sincronizar_ahora(&a, baja))
    }

    fn sincronizar_todas(self: &Arc<Self>) -> Vec<std::thread::JoinHandle<()>> {
        self.env.cuentas().into_iter().map(|a| self.programar(a, false)).collect()
    }

    fn arrancar_servidor(self: &Arc<Self>, atencion: &Arc<Atencion<Interno>>) {
        let mut s = bloquear(&self.servidor);
        if s.is_some() {
            return;
        }
        let canal = ruta_del_canal(&self.carpeta_datos);
        let at = atencion.clone();
        let atender = Arc::new(move |linea: &str| linea_de_respuesta(&at.atender_linea(linea)));
        match iniciar_canal(&canal, MCP_LIMITS.max_linea, atender).and_then(|srv| escribir_info(&self.archivo_info, srv.canal()).map(|_| srv)) {
            Ok(srv) => *s = Some(srv),
            Err(e) => self.env.log(&format!("chat-mcp: el canal local falló: {}", mensaje_corto(&e))),
        }
    }

    fn parar_servidor(&self) {
        if let Err(e) = borrar_info(&self.archivo_info) {
            self.env.log(&format!("chat-mcp: no se pudo borrar chat-mcp.json: {e}"));
        }
        if let Some(s) = bloquear(&self.servidor).take() {
            s.detener();
        }
    }
}

impl AtencionDeps for Interno {
    fn config(&self) -> McpConfig {
        bloquear(&self.cfg).clone()
    }

    fn existentes(&self) -> Vec<String> {
        Interno::existentes(self)
    }

    fn conversaciones(&self) -> Res<Vec<ConvCandidata>> {
        self.datos.conversaciones()
    }

    fn leer_ultimos(&self, conv: &ChatConvRef, n: usize) -> Res<Vec<MsgLeido>> {
        let msgs = self.datos.leer_ultimos(conv, n as u32)?;
        Ok(msgs
            .into_iter()
            .map(|m| MsgLeido { author_login: m.author.login, body: m.body, created_at: m.created_at, deleted_at: m.deleted_at, notice: m.notice.is_some(), via_claude: m.via == Some("claude") })
            .collect())
    }

    fn enviar(&self, conv: &ChatConvRef, texto: &str) -> Res<()> {
        self.datos.enviar_via_claude(conv, texto, &self.env.nuevo_id()).map(|_| ())
    }

    fn via_column(&self) -> bool {
        self.datos.columna_via()
    }

    fn espacio(&self, id: &str) -> Option<(String, String)> {
        self.env.espacio(id).map(|e| (e.nombre, e.cuenta))
    }

    fn etiqueta_cuenta(&self, id: &str) -> Option<String> {
        self.env.cuentas().into_iter().find(|c| c.id == id).map(|c| c.label)
    }

    fn guardar_grant(&self, cuenta: &str, conv: &ChatConvRef, nombre: &str) {
        {
            let mut c = bloquear(&self.cfg);
            c.grants = con_grant(&c.grants, cuenta, conv, nombre, self.env.ahora_ms());
        }
        self.guardar_o_loguear();
        self.emitir_config();
    }

    fn modo_riesgoso(&self, cuenta: &str, ws: &str) -> Option<ModoRiesgoso> {
        let acc = self.env.cuentas().into_iter().find(|c| c.id == cuenta)?;
        let mut archivos = vec![acc.config_dir.join("settings.json")];
        if let Some(w) = Some(ws).filter(|w| !w.is_empty()).and_then(|w| self.env.espacio(w)).filter(|w| w.cuenta == cuenta) {
            archivos.push(w.cwd.join(".claude").join("settings.json"));
            archivos.push(w.cwd.join(".claude").join("settings.local.json"));
        }
        let settings: Vec<Value> = archivos.iter().map(|f| leer_json_suave(f)).collect();
        modo_riesgoso(&settings)
    }

    fn pedidos_cambiaron(&self, asks: Vec<ChatMcpAsk>) {
        self.env.emitir("mcpAsks", json!(asks));
    }

    fn avisar(&self, ask: &ChatMcpAsk, donde: &str) {
        if self.env.ventana_con_foco() {
            return;
        }
        let que = if ask.op == ChatMcpOp::Enviar { "mandar un mensaje a" } else { "leer" };
        self.env.notificar("Claude pide permiso", &format!("Para {que} {donde}, desde la cuenta {}.", ask.account));
    }

    fn ahora(&self) -> i64 {
        self.env.ahora_ms()
    }

    fn nuevo_id(&self) -> String {
        self.env.nuevo_id()
    }
}

fn id_corto_valido(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !s.is_empty() && s.encode_utf16().count() <= 64)
}

/// `^(team|dm):<uuid>$` sin distinguir mayúsculas.
fn clave_de_conv_valida(k: &str) -> Option<String> {
    let (kind, id) = k.split_once(':')?;
    let kind = kind.to_lowercase();
    (matches!(kind.as_str(), "team" | "dm") && super::mapa::es_uuid(id, false)).then(|| format!("{kind}:{}", id.to_lowercase()))
}

impl McpMain {
    /// `carpeta_datos` es `userData` (ahí va `chat-mcp.json`, que lee el helper) y `carpeta_features` la de `features`
    /// (ahí va la config). Arranca el canal local si la config lo tiene prendido.
    pub fn nuevo(env: Arc<dyn EntornoMcp>, datos: Arc<ChatDatos>, carpeta_datos: PathBuf, carpeta_features: PathBuf) -> Self {
        let archivo_cfg = carpeta_features.join("chat-mcp.json");
        let archivo_info = carpeta_datos.join("chat-mcp.json");
        if let Err(e) = borrar_info(&archivo_info) {
            env.log(&format!("chat-mcp: no se pudo borrar el chat-mcp.json anterior: {e}"));
        }
        let mut cfg = McpConfig::default();
        if archivo_cfg.exists() {
            match std::fs::read_to_string(&archivo_cfg).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| e.to_string())) {
                Ok(v) => cfg = parsear_config(&v),
                Err(e) => env.log(&format!("chat-mcp: config ilegible, queda apagado: {}", mensaje_corto(&e))),
            }
        }
        let i = Arc::new(Interno {
            env,
            datos,
            cfg: Mutex::new(cfg),
            regs: Mutex::new(HashMap::new()),
            colas: Mutex::new(HashMap::new()),
            archivo_cfg,
            archivo_info,
            carpeta_datos,
            servidor: Mutex::new(None),
            reintento: AtomicBool::new(false),
        });
        let atencion = Arc::new(Atencion::nueva(i.clone()));
        if bloquear(&i.cfg).enabled {
            i.arrancar_servidor(&atencion);
        }
        McpMain { i, atencion }
    }

    pub fn atender_linea(&self, linea: &str) -> String {
        linea_de_respuesta(&self.atencion.atender_linea(linea))
    }

    /// Una cuenta nueva o recién preparada.
    pub fn cuenta_preparada(&self, a: CuentaMcp) {
        self.i.programar(a, false);
    }

    /// Se borra una cuenta: su token, sus permisos y su registro.
    pub fn cuenta_borrada(&self, a: CuentaMcp) {
        self.i.invalidar_token(&a.id);
        {
            let mut c = bloquear(&self.i.cfg);
            c.cuentas.retain(|x| x != &a.id);
            c.grants = sin_grant(&c.grants, &a.id, None);
        }
        self.i.guardar_o_loguear();
        let i = self.i.clone();
        std::thread::spawn(move || {
            i.sincronizar_ahora(&a, true);
            let estado = bloquear(&i.regs).get(&a.id).map(|r| (r.state, r.detail.clone()));
            if let Some((s, d)) = &estado {
                if !matches!(s, EstadoRegistro::Ok | EstadoRegistro::NoSoportado) {
                    i.env.log(&format!("chat-mcp: no se pudo sacar el MCP de la cuenta borrada: {}", d.clone().unwrap_or_default()));
                }
            }
            bloquear(&i.regs).remove(&a.id);
            bloquear(&i.colas).remove(&a.id);
            i.emitir_config();
        });
    }

    /// Se cerró una terminal: lo que quedó «pendiente» por terminales abiertas se reintenta (juntando los avisos).
    pub fn terminal_cerrada(&self) {
        if self.i.reintento.swap(true, Ordering::SeqCst) {
            return;
        }
        let i = self.i.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(REINTENTO_MS));
            i.reintento.store(false, Ordering::SeqCst);
            for a in i.env.cuentas() {
                if bloquear(&i.regs).get(&a.id).is_some_and(|r| r.state == EstadoRegistro::Pendiente) {
                    i.programar(a, false);
                }
            }
        });
    }

    // ---------- canales IPC ----------

    pub fn config(&self) -> Value {
        json!(self.i.vista())
    }

    pub fn poner_activado(&self, on: &Value) -> Res<Value> {
        let Some(on) = on.as_bool() else { return Err("Valor inválido.".into()) };
        let cambio = {
            let mut c = bloquear(&self.i.cfg);
            if on == c.enabled {
                false
            } else {
                c.enabled = on;
                if !on {
                    c.tokens.clear();
                }
                true
            }
        };
        if cambio {
            self.i.guardar()?;
            if on {
                self.i.arrancar_servidor(&self.atencion);
            } else {
                self.atencion.denegar_todos();
                self.i.parar_servidor();
            }
        }
        self.i.sincronizar_todas();
        Ok(json!(self.i.vista()))
    }

    pub fn poner_cuentas(&self, raw: &Value) -> Res<Value> {
        let existentes = self.i.existentes();
        let cuentas = validar_cuentas(raw, &existentes)?;
        let todas = self.i.env.cuentas();
        for id in &cuentas {
            match todas.iter().find(|c| &c.id == id).map(|c| &c.proveedor) {
                Some(ProveedorMcp::Soporta { .. }) | None => {}
                Some(ProveedorMcp::Desconocido { nombre, .. }) | Some(ProveedorMcp::SinMcp { nombre }) => {
                    let label = todas.iter().find(|c| &c.id == id).map(|c| c.label.clone()).unwrap_or_default();
                    return Err(format!("La cuenta «{label}» es de {nombre}: el chat con MCP todavía no está disponible."));
                }
            }
        }
        let sobran: Vec<String> = {
            let mut c = bloquear(&self.i.cfg);
            c.cuentas = cuentas.clone();
            c.tokens.iter().map(|(id, _)| id.clone()).filter(|id| !cuentas.contains(id)).collect()
        };
        for id in sobran {
            self.i.invalidar_token(&id);
        }
        self.i.guardar()?;
        self.i.sincronizar_todas();
        Ok(json!(self.i.vista()))
    }

    pub fn revocar(&self, cuenta: &Value, clave: &Value) -> Res<Value> {
        let Some(cuenta) = id_corto_valido(cuenta) else { return Err("Cuenta inválida.".into()) };
        let Some(k) = clave.as_str().and_then(clave_de_conv_valida) else { return Err("Conversación inválida.".into()) };
        {
            let mut c = bloquear(&self.i.cfg);
            c.grants = sin_grant(&c.grants, cuenta, Some(&k));
        }
        self.i.guardar()?;
        self.i.emitir_config();
        Ok(json!(self.i.vista()))
    }

    pub fn revocar_todo(&self) -> Res<Value> {
        bloquear(&self.i.cfg).grants.clear();
        self.i.guardar()?;
        self.i.emitir_config();
        Ok(json!(self.i.vista()))
    }

    pub fn pendientes(&self) -> Value {
        json!(self.atencion.pendientes())
    }

    pub fn responder(&self, id: &Value, eleccion: &Value) -> Res<()> {
        let Some(id) = id_corto_valido(id) else { return Err("Pedido inválido.".into()) };
        let e = match eleccion.as_str() {
            Some("once") => ChatMcpChoice::Once,
            Some("always") => ChatMcpChoice::Always,
            Some("deny") => ChatMcpChoice::Deny,
            _ => return Err("Respuesta inválida.".into()),
        };
        self.atencion.responder(id, e)
    }

    /// Al salir de la app: deniega lo pendiente y cierra el canal.
    pub fn cerrar(&self) {
        self.atencion.denegar_todos();
        self.i.parar_servidor();
    }

    #[cfg(test)]
    fn interno(&self) -> &Arc<Interno> {
        &self.i
    }
}

#[cfg(test)]
#[path = "mcp_main_pruebas.rs"]
mod tests;
