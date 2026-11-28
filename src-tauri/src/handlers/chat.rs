//! Canales `feat:chat:*` en Rust: config y login (`principal`), datos y Realtime (`datos`) y el lado main del MCP
//! (`mcp_main`), todo de `sloth_core::features::chat`. Acá están los entornos de esas piezas sobre la cáscara: cuentas y
//! espacios leídos del estado sin escribirlo, terminales pedidas al dueño por el router, ajustes de solo lectura, avisos
//! del sistema y la sesión que «celular» (todavía en el proceso de apoyo) reusa para su canal remoto.
use super::comun::{ahora_ms, nuevo_uuid, texto};
use super::{a_json, arg, AlHook};
use crate::entorno::Entorno;
use crate::router::{Respuesta, Router};
use serde_json::{json, Value};
use sloth_core::cuentas::AVISO_PROVEEDOR_DESCONOCIDO;
use sloth_core::features::chat::datos::{AjustesAviso, Fabrica};
use sloth_core::features::chat::http::{Http, HttpUreq, Pedido};
use sloth_core::features::chat::mcp_main::{correr_claude, CuentaMcp, EntornoMcp, EspacioMcp, McpMain, ProveedorMcp};
use sloth_core::features::chat::principal::{EntornoPrincipal, Principal};
use sloth_core::features::chat::sesion::{AlmacenSecreto, Sesion};
use sloth_core::features::chat::tipos::ChatConvRef;
use sloth_core::proveedores::{nombre_proveedor, proveedor_id_de, ProveedorId};
use sloth_core::proveedores_fs::{env_cuenta, resolver_exe_claude};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

pub const NOMBRE: &str = "chat";

const CLI_MS: u64 = 30_000;
const CERRAR_OTRAS_MS: u64 = 8_000;
const ESPERA_TERMINALES: Duration = Duration::from_secs(20);
const MAX_ARRANQUE: Duration = Duration::from_secs(60);

/// Lo que se puede cambiar en las pruebas: la red, el socket de Realtime, el cifrado y los puertos del login.
pub struct Opciones {
    pub http: Arc<dyn Http>,
    pub fabrica: Option<Fabrica>,
    pub almacen: Option<Arc<dyn AlmacenSecreto>>,
    pub puertos: Option<Vec<u16>>,
    /// Dónde está `claude.exe`; `None` lo busca en el PATH como Claude Code.
    pub exe_claude: Option<ExeClaude>,
}

pub type ExeClaude = Arc<dyn Fn() -> Option<String> + Send + Sync>;

impl Default for Opciones {
    fn default() -> Self {
        Opciones { http: Arc::new(HttpUreq), fabrica: None, almacen: None, puertos: None, exe_claude: None }
    }
}

/// `safeStorage` de Electron: en Windows, el mismo `Local State` de la carpeta de datos; en el resto, sin cifrado (la
/// sesión dura lo que la app, igual que Electron sin cifrado disponible).
fn almacen_del_sistema(raiz: &std::path::Path) -> Arc<dyn AlmacenSecreto> {
    #[cfg(windows)]
    {
        use sloth_core::features::chat::safestorage::{DpapiWindows, SafeStorage};
        Arc::new(SafeStorage::nuevo(raiz.join("Local State"), DpapiWindows))
    }
    #[cfg(not(windows))]
    {
        let _ = raiz;
        Arc::new(SinCifrado)
    }
}

#[cfg(not(windows))]
struct SinCifrado;

#[cfg(not(windows))]
impl AlmacenSecreto for SinCifrado {
    fn disponible(&self) -> bool {
        false
    }
    fn cifrar(&self, _: &str) -> Result<Vec<u8>, String> {
        Err("sin cifrado".into())
    }
    fn descifrar(&self, _: &[u8]) -> Result<String, String> {
        Err("sin cifrado".into())
    }
}

/// El entorno de `principal` y de `datos`.
struct EntornoChat {
    entorno: Arc<Entorno>,
    carpeta_features: PathBuf,
    principal: OnceLock<Weak<Principal>>,
    /// Última sesión avisada al proceso de apoyo, para no repetir el aviso en cada snapshot.
    sesion_avisada: Mutex<Option<String>>,
}

impl EntornoChat {
    fn sesion_para_apoyo(&self) -> Value {
        let s = self.principal.get().and_then(Weak::upgrade).and_then(|p| p.sesion_chat());
        s.map(|s| json!({ "supabaseUrl": s.supabase_url, "anonKey": s.anon_key, "userId": s.user_id })).unwrap_or(Value::Null)
    }

    /// «celular» arma su canal remoto con esta sesión: se le avisa cuando cambia (nunca con tokens; los pide aparte).
    fn avisar_sesion(&self) {
        let v = self.sesion_para_apoyo();
        let clave = v.to_string();
        {
            let mut g = self.sesion_avisada.lock().unwrap_or_else(|e| e.into_inner());
            if g.as_deref() == Some(clave.as_str()) {
                return;
            }
            *g = Some(clave);
        }
        self.entorno.al_apoyo("chat:sesion", json!([v]));
    }
}

impl EntornoPrincipal for EntornoChat {
    fn emitir(&self, canal: &str, payload: Value) {
        self.entorno.emitir(NOMBRE, canal, &[payload]);
        if canal == "snapshot" {
            self.avisar_sesion();
        }
    }
    fn log(&self, msg: &str) {
        sloth_core::logger_global::info(NOMBRE, msg);
    }
    fn avisar(&self, texto: &str) {
        sloth_core::logger_global::aviso(NOMBRE, texto);
        // Los avisos a la persona todavía los muestra la función «avisos» del proceso de apoyo.
        self.entorno.al_apoyo("aviso", json!([texto]));
    }
    fn carpeta_features(&self) -> PathBuf {
        self.carpeta_features.clone()
    }
    fn repos_de_espacios(&self) -> Vec<String> {
        self.entorno.lista_del_estado("workspaces").iter().filter_map(|w| texto(w, "repoPath")).collect()
    }
    fn abrir_externo(&self, url: &str) -> Result<(), String> {
        self.entorno.plataforma.abrir_enlace_externo(url)
    }
    fn portapapeles(&self) -> String {
        texto(&self.entorno.plataforma.leer_portapapeles(), "text").unwrap_or_default()
    }
    fn version_app(&self) -> String {
        self.entorno.plataforma.version()
    }
    fn ahora_ms(&self) -> i64 {
        ahora_ms() as i64
    }
    fn ventana_con_foco(&self) -> bool {
        self.entorno.con_foco()
    }
    /// `settings.json` de solo lectura: lo escribe la función «settings», que tiene otro dueño.
    fn ajustes(&self) -> AjustesAviso {
        let crudo = std::fs::read_to_string(self.carpeta_features.join("settings.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(t.trim_start_matches('\u{feff}')).ok())
            .unwrap_or(Value::Null);
        let s = Value::Object(sloth_core::settings_model::normalizar(&crudo));
        AjustesAviso { notificar_equipo: s.pointer("/notify/team").and_then(Value::as_bool).unwrap_or(true), no_molestar: s["noMolestar"].as_bool().unwrap_or(false) }
    }
    // Sin acción al hacer clic: el aviso de Tauri en Windows no avisa el clic (en Electron abría la conversación).
    fn notificar(&self, titulo: &str, cuerpo: &str, _conv: &ChatConvRef) {
        if self.entorno.plataforma.ventana_existe() {
            self.entorno.notificar(titulo, cuerpo);
        }
    }
}

/// El entorno del MCP: cuentas y espacios del estado (solo lectura) y las terminales, que son de otro dueño.
struct EntornoMcpChat {
    entorno: Arc<Entorno>,
    claude: Mutex<Option<String>>,
    exe_fijo: Option<ExeClaude>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Terminales {
    conocidas: bool,
    ocupada: bool,
}

impl EntornoMcpChat {
    fn exe_claude(&self) -> Option<String> {
        if let Some(f) = &self.exe_fijo {
            return f();
        }
        let mut g = self.claude.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(c) = g.as_ref().filter(|c| std::path::Path::new(c).exists()) {
            return Some(c.clone());
        }
        let path = std::env::var("PATH").unwrap_or_default();
        let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
        let c = resolver_exe_claude(&path, &home, &|f| std::path::Path::new(f).exists(), &|f| std::fs::read_to_string(f).ok(), cfg!(windows));
        g.clone_from(&c);
        c
    }

    /// Las terminales son de quien tenga el backend (hoy el proceso de apoyo): se le pregunta por el router. Al arrancar
    /// puede no estar listo todavía; se espera un rato, como el `await ctx.backend()` del TypeScript.
    fn terminales(&self, cuenta: Option<&str>) -> Terminales {
        let args = cuenta.map(|c| vec![json!(c)]).unwrap_or_default();
        let inicio = std::time::Instant::now();
        loop {
            match self.entorno.pedir("pty:cuentaOcupada", args.clone(), ESPERA_TERMINALES) {
                Ok(v) => return Terminales { conocidas: v["conocidas"] == json!(true), ocupada: v["ocupada"] != json!(false) },
                Err(e) if e.contains("arrancando") && inicio.elapsed() < MAX_ARRANQUE => std::thread::sleep(Duration::from_millis(500)),
                Err(e) => {
                    sloth_core::logger_global::aviso(NOMBRE, &format!("chat-mcp: no se supo qué terminales hay abiertas: {e}"));
                    return Terminales { conocidas: false, ocupada: true };
                }
            }
        }
    }
}

/// Una cuenta del estado (o la que llega en `cuentaBorrada`) como la ve el MCP.
fn cuenta_mcp(a: &Value, exe: impl FnOnce() -> Option<String>) -> Option<CuentaMcp> {
    let id = texto(a, "id").filter(|i| !i.is_empty() && i.len() <= 64)?;
    let config_dir = texto(a, "configDir").filter(|d| !d.is_empty())?;
    let proveedor = match proveedor_id_de(a) {
        None => ProveedorMcp::Desconocido { aviso: AVISO_PROVEEDOR_DESCONOCIDO.into(), nombre: nombre_proveedor(a).into() },
        Some(p) if !p.capacidades().chat_mcp => ProveedorMcp::SinMcp { nombre: p.nombre().into() },
        Some(p) => ProveedorMcp::Soporta { exe: if p == ProveedorId::Claude { exe() } else { None }, env: env_cuenta(p, &config_dir) },
    };
    Some(CuentaMcp { id, label: texto(a, "label").unwrap_or_default(), config_dir: PathBuf::from(config_dir), proveedor })
}

impl EntornoMcp for EntornoMcpChat {
    fn emitir(&self, canal: &str, payload: Value) {
        self.entorno.emitir(NOMBRE, canal, &[payload]);
    }
    fn log(&self, msg: &str) {
        sloth_core::logger_global::info(NOMBRE, msg);
    }
    fn cuentas(&self) -> Vec<CuentaMcp> {
        self.entorno.lista_del_estado("accounts").iter().filter_map(|a| cuenta_mcp(a, || self.exe_claude())).collect()
    }
    fn helper_exe(&self) -> Option<String> {
        let exe = self.entorno.raiz().join("bin").join(if cfg!(windows) { "sloth-hook.exe" } else { "sloth-hook" });
        exe.exists().then(|| exe.to_string_lossy().into_owned())
    }
    fn terminales_conocidas(&self) -> bool {
        self.terminales(None).conocidas
    }
    fn cuenta_libre(&self, id: &str) -> bool {
        let t = self.terminales(Some(id));
        t.conocidas && !t.ocupada
    }
    fn correr(&self, exe: &str, args: &[String], env: &[(String, String)]) -> Result<(), String> {
        correr_claude(exe, args, env, CLI_MS)
    }
    fn espacio(&self, id: &str) -> Option<EspacioMcp> {
        let w = self.entorno.lista_del_estado("workspaces").into_iter().find(|w| w.get("id").and_then(Value::as_str) == Some(id))?;
        Some(EspacioMcp { nombre: texto(&w, "name").unwrap_or_default(), cuenta: texto(&w, "accountId").unwrap_or_default(), cwd: PathBuf::from(texto(&w, "cwd").unwrap_or_default()) })
    }
    fn ventana_con_foco(&self) -> bool {
        self.entorno.con_foco()
    }
    fn notificar(&self, titulo: &str, cuerpo: &str) {
        if self.entorno.plataforma.ventana_existe() {
            self.entorno.notificar(titulo, cuerpo);
        }
    }
    fn ahora_ms(&self) -> i64 {
        ahora_ms() as i64
    }
    fn nuevo_id(&self) -> String {
        nuevo_uuid()
    }
}

struct Piezas {
    principal: Arc<Principal>,
    mcp: McpMain,
    mcp_env: Arc<EntornoMcpChat>,
}

pub struct Chat {
    entorno: Arc<Entorno>,
    opciones: Opciones,
    piezas: Mutex<Option<Arc<Piezas>>>,
    cerrado: std::sync::atomic::AtomicBool,
}

impl Chat {
    /// Se arma con la carpeta del perfil, que avisa el proceso de apoyo al arrancar; hasta ahí, «todavía está arrancando».
    fn piezas(&self) -> Result<Arc<Piezas>, String> {
        let mut g = self.piezas.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(p) = g.as_ref() {
            return Ok(p.clone());
        }
        if self.cerrado.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Sloth se está cerrando.".into());
        }
        let features = self.entorno.carpeta_features()?;
        std::fs::create_dir_all(&features).map_err(|e| format!("No se pudo preparar la carpeta del chat: {e}"))?;
        let raiz = self.entorno.raiz();
        let almacen = self.opciones.almacen.clone().unwrap_or_else(|| almacen_del_sistema(&raiz));
        let sesion = Arc::new(Sesion::abrir(&features.join("chat-session.bin"), almacen, |m| sloth_core::logger_global::info(NOMBRE, m)));
        let env = Arc::new(EntornoChat { entorno: self.entorno.clone(), carpeta_features: features.clone(), principal: OnceLock::new(), sesion_avisada: Mutex::new(None) });
        let principal = Principal::nuevo(env.clone(), self.opciones.http.clone(), sesion, self.opciones.fabrica.clone());
        if let Some(p) = &self.opciones.puertos {
            principal.usar_puertos(p.clone());
        }
        let _ = env.principal.set(Arc::downgrade(&principal));
        env.avisar_sesion();
        let mcp_env = Arc::new(EntornoMcpChat { entorno: self.entorno.clone(), claude: Mutex::new(None), exe_fijo: self.opciones.exe_claude.clone() });
        let mcp = McpMain::nuevo(mcp_env.clone(), principal.datos().clone(), raiz, features);
        let p = Arc::new(Piezas { principal, mcp, mcp_env });
        *g = Some(p.clone());
        Ok(p)
    }

    fn ya_armado(&self) -> Option<Arc<Piezas>> {
        self.piezas.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Lo que hace el registro del TypeScript al arrancar: resolver la config (y recuperar la sesión), abrir los datos con la
    /// ventana y dejar el MCP de cada cuenta como corresponde.
    fn arrancar(&self) -> Result<(), String> {
        let p = self.piezas()?;
        p.principal.ventana_abierta(self.entorno.plataforma.ventana_existe());
        for a in p.mcp_env.cuentas() {
            p.mcp.cuenta_preparada(a);
        }
        Ok(())
    }

    fn sesion_para_apoyo(&self) -> Respuesta {
        let p = self.piezas()?;
        let s = p.principal.sesion_chat();
        Ok(s.map(|s| json!({ "supabaseUrl": s.supabase_url, "anonKey": s.anon_key, "userId": s.user_id })).unwrap_or(Value::Null))
    }

    fn token(&self) -> Respuesta {
        let p = self.piezas()?;
        Ok(p.principal.sesion_chat().and_then(|s| s.auth.token_de_acceso()).map(Value::String).unwrap_or(Value::Null))
    }

    /// `auth.signOut({ scope: 'others' })` de supabase-js: cierra las sesiones de los otros dispositivos, no la de Sloth.
    fn cerrar_otras(&self) -> Respuesta {
        let p = self.piezas()?;
        let s = p.principal.sesion_chat().ok_or("Sin sesión en el chat.")?;
        let token = s.auth.token_de_acceso().ok_or("Sin sesión en el chat.")?;
        let pedido = Pedido::nuevo("POST", &format!("{}/auth/v1/logout?scope=others", s.supabase_url))
            .con_cabecera("apikey", &s.anon_key)
            .con_cabecera("authorization", &format!("Bearer {token}"))
            .con_timeout(CERRAR_OTRAS_MS);
        let r = self.opciones.http.pedir(&pedido).map_err(|e| e.to_string())?;
        if r.ok() {
            return Ok(Value::Null);
        }
        let detalle = r.json().and_then(|v| texto(&v, "msg").or_else(|| texto(&v, "message")).or_else(|| texto(&v, "error_description")));
        Err(detalle.map(|d| d.chars().take(200).collect()).unwrap_or_else(|| format!("Supabase respondió con un error (código {}).", r.estado)))
    }
}

impl AlHook for Chat {
    fn al_hook(&self, _evento: &str, _ws: Option<&str>) {}

    fn al_enfocar(&self) {
        let Some(p) = self.ya_armado() else { return };
        // Refresca las listas por la red: fuera del hilo de la ventana.
        std::thread::spawn(move || p.principal.ventana_enfocada());
    }

    fn al_evento(&self, evento: &str, datos: &Value) {
        let Some(p) = (match evento {
            "cuentaPreparada" | "cuentaBorrada" | "terminalCerrada" => self.piezas().map_err(|e| sloth_core::logger_global::aviso(NOMBRE, &format!("chat-mcp: {evento} sin atender: {e}"))).ok(),
            _ => None,
        }) else {
            return;
        };
        match evento {
            "terminalCerrada" => p.mcp.terminal_cerrada(),
            _ => {
                let Some(a) = cuenta_mcp(datos, || p.mcp_env.exe_claude()) else {
                    return sloth_core::logger_global::aviso(NOMBRE, &format!("chat-mcp: {evento} con una cuenta inválida"));
                };
                if evento == "cuentaPreparada" {
                    p.mcp.cuenta_preparada(a)
                } else {
                    p.mcp.cuenta_borrada(a)
                }
            }
        }
    }

    fn nativo(&self, op: &str, args: &[Value]) -> Option<Respuesta> {
        if op != "rust.chat" {
            return None;
        }
        Some(match arg(args, 0).as_str() {
            Some("sesion") => self.sesion_para_apoyo(),
            Some("token") => self.token(),
            Some("cerrarOtras") => self.cerrar_otras(),
            _ => Err("Pedido inválido.".into()),
        })
    }

    fn al_salir(&self) {
        self.cerrado.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(p) = self.ya_armado() {
            p.principal.cerrar();
            p.mcp.cerrar();
        }
    }
}

/// Al arrancar, como el registro de chat.ts: espera a que el proceso de apoyo avise el perfil y arma todo.
fn arrancar_cuando_haya_perfil(c: Arc<Chat>) {
    std::thread::spawn(move || {
        // Seguido: el primer snapshot tiene que salir antes de que la UI empiece a mostrar el chat.
        for _ in 0..2400 {
            if c.entorno.perfil().is_ok() {
                if let Err(e) = c.arrancar() {
                    sloth_core::logger_global::aviso(NOMBRE, &format!("no se pudo arrancar el chat: {e}"));
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    });
}

pub fn armar(entorno: Arc<Entorno>, opciones: Opciones) -> Arc<Chat> {
    Arc::new(Chat { entorno, opciones, piezas: Mutex::new(None), cerrado: std::sync::atomic::AtomicBool::new(false) })
}

pub fn registrar(router: &mut Router, entorno: Arc<Entorno>) -> Arc<dyn AlHook> {
    let c = armar(entorno, Opciones::default());
    registrar_canales(router, &c);
    arrancar_cuando_haya_perfil(c.clone());
    c
}

fn nulo(r: Result<(), String>) -> Respuesta {
    r.map(|_| Value::Null)
}

fn registrar_canales(router: &mut Router, c: &Arc<Chat>) {
    macro_rules! canal {
        ($op:literal, |$p:ident, $a:ident| $cuerpo:expr) => {{
            let chat = c.clone();
            router.registrar(concat!("feat:chat:", $op), move |$a: Vec<Value>| {
                let _ = &$a;
                let $p = chat.piezas()?;
                $cuerpo
            });
        }};
    }
    // chat.ts: config, login e invitaciones.
    canal!("state", |p, a| Ok(p.principal.estado()));
    canal!("getConfig", |p, a| Ok(p.principal.obtener_config()));
    canal!("setConfig", |p, a| p.principal.guardar_config(arg(&a, 0)));
    canal!("acceptTeamConfig", |p, a| p.principal.aceptar_config_del_equipo(arg(&a, 0)));
    canal!("test", |p, a| Ok(p.principal.probar_conexion()));
    canal!("validate", |p, a| Ok(p.principal.validar()));
    canal!("previewInvite", |p, a| p.principal.ver_invitacion(arg(&a, 0)));
    canal!("joinInvite", |p, a| p.principal.entrar_con_invitacion(arg(&a, 0), arg(&a, 1)));
    canal!("clipboardInvite", |p, a| Ok(p.principal.portapapeles_con_invitacion().map(Value::String).unwrap_or(Value::Null)));
    canal!("inviteText", |p, a| p.principal.texto_de_invitacion(arg(&a, 0), arg(&a, 1)).map(Value::String));
    canal!("signIn", |p, a| nulo(p.principal.iniciar_sesion()));
    canal!("cancelSignIn", |p, a| {
        p.principal.cancelar_inicio();
        Ok(Value::Null)
    });
    canal!("signOut", |p, a| {
        p.principal.cerrar_sesion();
        Ok(Value::Null)
    });
    // chat-data.ts: equipos, directos y mensajes.
    canal!("setView", |p, a| nulo(p.principal.datos().poner_vista(arg(&a, 0))));
    canal!("messages", |p, a| p.principal.datos().mensajes(arg(&a, 0), a.get(1), a.get(2)));
    canal!("send", |p, a| p.principal.datos().enviar(arg(&a, 0), arg(&a, 1), arg(&a, 2), a.get(3)));
    canal!("edit", |p, a| p.principal.datos().editar(arg(&a, 0), arg(&a, 1), arg(&a, 2)));
    canal!("remove", |p, a| p.principal.datos().borrar(arg(&a, 0), arg(&a, 1)));
    canal!("react", |p, a| nulo(p.principal.datos().reaccionar(arg(&a, 0), arg(&a, 1), arg(&a, 2), arg(&a, 3))));
    canal!("search", |p, a| p.principal.datos().buscar(arg(&a, 0), arg(&a, 1)));
    canal!("typing", |p, a| nulo(p.principal.datos().escribiendo(arg(&a, 0))));
    canal!("clear", |p, a| nulo(p.principal.datos().vaciar(arg(&a, 0), arg(&a, 1))));
    canal!("setRetention", |p, a| a_json(p.principal.datos().poner_retencion(arg(&a, 0), arg(&a, 1))));
    canal!("markRead", |p, a| nulo(p.principal.datos().marcar_leido(arg(&a, 0))));
    canal!("createTeam", |p, a| a_json(p.principal.datos().crear_equipo(arg(&a, 0))));
    canal!("updateTeam", |p, a| a_json(p.principal.datos().actualizar_equipo(arg(&a, 0), arg(&a, 1))));
    canal!("members", |p, a| p.principal.datos().miembros(arg(&a, 0)));
    canal!("inviteByLogin", |p, a| p.principal.datos().invitar_por_login(arg(&a, 0), arg(&a, 1)));
    canal!("regenerateCode", |p, a| p.principal.datos().regenerar_codigo(arg(&a, 0)).map(Value::String));
    canal!("joinByCode", |p, a| a_json(p.principal.datos().entrar_por_codigo(arg(&a, 0))));
    canal!("acceptInvite", |p, a| a_json(p.principal.datos().aceptar_invitacion(arg(&a, 0))));
    canal!("declineInvite", |p, a| nulo(p.principal.datos().rechazar_invitacion(arg(&a, 0))));
    canal!("leaveTeam", |p, a| nulo(p.principal.datos().salir_del_equipo(arg(&a, 0))));
    canal!("removeMember", |p, a| a_json(p.principal.datos().sacar_miembro(arg(&a, 0), arg(&a, 1))));
    canal!("openDm", |p, a| a_json(p.principal.datos().abrir_directo(arg(&a, 0))));
    // chat-mcp.ts: el MCP del chat para Claude.
    canal!("mcpConfig", |p, a| Ok(p.mcp.config()));
    canal!("mcpSetEnabled", |p, a| p.mcp.poner_activado(arg(&a, 0)));
    canal!("mcpSetAccounts", |p, a| p.mcp.poner_cuentas(arg(&a, 0)));
    canal!("mcpRevoke", |p, a| p.mcp.revocar(arg(&a, 0), arg(&a, 1)));
    canal!("mcpRevokeAll", |p, a| p.mcp.revocar_todo());
    canal!("mcpPending", |p, a| Ok(p.mcp.pendientes()));
    canal!("mcpAnswer", |p, a| nulo(p.mcp.responder(arg(&a, 0), arg(&a, 1))));
}

#[cfg(test)]
#[path = "chat_pruebas.rs"]
mod tests;
