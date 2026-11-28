//! Preparar una cuenta antes de abrir su agente (carpeta, hooks y setup compartido) y armar lo que corre cada
//! terminal. Equivale a `prepareAccount`, `specFor` y `claudeCommand` de src/main/index.ts.
use super::Nucleo;
use serde_json::{json, Value};
use sloth_core::cuentas::{aviso_de_setup, exigir_cuenta, exigir_proveedor};
use sloth_core::hook_env::{entorno_de_terminal, Capacidades as CapHook, DatosHook};
use sloth_core::hooks::{instalar_en, Lanzador};
use sloth_core::initial_prompt::problema_del_primer_mensaje;
use sloth_core::proveedores::{proveedor_id_de, ProveedorId};
use sloth_core::proveedores_fs::{argv_interactivo, argv_login, como_instalar, env_cuenta, estado_login, hay_conversacion_previa, preparar_carpeta, quitar_del_entorno, resolver_exe_claude};
use sloth_core::ptys_core::{entorno_limpio, PtySpec};
use sloth_core::setup::{base_settings_para, dejar_de_compartir, sincronizar_setup_compartido, CuentaSetup, SetupSyncReport};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

pub struct Cuentas {
    raiz: PathBuf,
    /// (ejecutable, ruta para escribir en un comando de shell).
    helper: OnceLock<Option<(PathBuf, String)>>,
    hay_node: OnceLock<bool>,
    avisados: Mutex<HashSet<String>>,
    exes: Mutex<HashMap<&'static str, Option<String>>>,
    /// Espacio → (cuenta, sesión): la próxima terminal de ese espacio con esa cuenta retoma esa conversación una vez.
    retomar: Mutex<HashMap<String, (String, String)>>,
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default())
}

fn sin_ventana(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

/// Ruta con barras y sin espacios (nombre corto 8.3 si hace falta), o None si no hay forma de escribirla sin comillas:
/// PowerShell no ejecuta una ruta entre comillas seguida de argumentos.
pub fn ruta_para_shell(ruta: &str) -> Option<String> {
    let mut r = ruta.to_string();
    if r.chars().any(char::is_whitespace) {
        let salida = sin_ventana(std::process::Command::new("cmd.exe").args(["/d", "/s", "/c", &format!("for %I in (\"{ruta}\") do @echo %~sI")])).output().ok()?;
        r = String::from_utf8_lossy(&salida.stdout).trim().to_string();
    }
    let r = r.replace('\\', "/");
    (!r.is_empty() && !r.chars().any(|c| c.is_whitespace() || "\"'`$&|;<>()^%!".contains(c))).then_some(r)
}

pub fn texto_de_reporte(r: &SetupSyncReport) -> Value {
    json!({ "linked": r.linked, "copied": r.copied, "mcpServers": r.mcp_servers, "skipped": r.skipped })
}

impl Cuentas {
    pub fn nuevas(raiz: &Path) -> Cuentas {
        Cuentas { raiz: raiz.to_path_buf(), helper: OnceLock::new(), hay_node: OnceLock::new(), avisados: Mutex::default(), exes: Mutex::default(), retomar: Mutex::default() }
    }

    /// `sloth-hook.exe` copiado a userData/bin (no se corre desde la instalación, que el instalador tiene que poder
    /// reemplazar). None si no está compilado: los hooks siguen con los scripts de Node.
    fn helper(&self) -> Option<(PathBuf, String)> {
        self.helper
            .get_or_init(|| {
                let app = std::env::var("SLOTH_APP_PATH").map(PathBuf::from).unwrap_or_default();
                let origen = [std::env::var("SLOTH_HELPER").ok().map(PathBuf::from), std::env::var("SLOTH_RESOURCES").ok().map(|r| Path::new(&r).join("daemon").join("sloth-hook.exe")), Some(app.join("out").join("daemon").join("sloth-hook.exe"))]
                    .into_iter()
                    .flatten()
                    .find(|p| p.exists())?;
                let bin = self.raiz.join("bin");
                let destino = bin.join("sloth-hook.exe");
                std::fs::create_dir_all(&bin).ok()?;
                if std::fs::read(&destino).ok() != std::fs::read(&origen).ok() {
                    let tmp = bin.join(format!("sloth-hook.exe.{}.tmp", std::process::id()));
                    std::fs::copy(&origen, &tmp).ok()?;
                    // Un hook corriendo tiene el archivo abierto: se sigue con el anterior y se reintenta al próximo arranque.
                    if std::fs::rename(&tmp, &destino).is_err() {
                        let _ = std::fs::remove_file(&tmp);
                        if !destino.exists() {
                            return None;
                        }
                    }
                }
                ruta_para_shell(&destino.to_string_lossy()).map(|c| (destino, c))
            })
            .clone()
    }

    fn hay_node(&self) -> bool {
        *self.hay_node.get_or_init(|| sin_ventana(std::process::Command::new("where.exe").arg("node")).output().map(|o| o.status.success()).unwrap_or(false))
    }

    fn instalar_hooks(&self, config_dir: &Path, base: Option<&Value>) {
        let helper = self.helper().map(|h| h.1);
        let barras = |n: &str| self.raiz.join(n).to_string_lossy().replace('\\', "/");
        let (hook, statusline) = (barras("sloth-hook.cjs"), barras("sloth-statusline.cjs"));
        let l = Lanzador { helper: helper.as_deref(), script_hook: &hook, script_statusline: &statusline, hay_node: self.hay_node() };
        match instalar_en(config_dir, base, &l) {
            Ok(r) => r.avisos.iter().for_each(|a| sloth_core::logger_global::aviso("hooks", a)),
            Err(e) => sloth_core::logger_global::error("hooks", e),
        }
    }

    fn base_de(acc: &Value) -> Option<Value> {
        let dir = PathBuf::from(acc["configDir"].as_str().unwrap_or_default());
        base_settings_para(&CuentaSetup { config_dir: &dir, share_setup: acc["shareSetup"].as_bool() }, &home()).map(Value::Object)
    }

    /// Deja la cuenta lista antes de abrir su agente. Una cuenta de un agente que esta versión no conoce no se toca.
    pub fn preparar(&self, n: &Nucleo, acc: &Value) {
        let Some(id) = proveedor_id_de(acc) else { return };
        let dir = PathBuf::from(acc["configDir"].as_str().unwrap_or_default());
        match preparar_carpeta(id, &dir) {
            Ok(avisos) => avisos.iter().for_each(|a| sloth_core::logger_global::aviso(a.origen, &a.texto)),
            Err(e) => sloth_core::logger_global::error("cuentas", e),
        }
        if id == ProveedorId::Codex && id.capacidades().aviso_turno {
            self.ajustar_notify(acc);
        }
        // Hooks y setup compartido son de Claude Code.
        if id.capacidades().hooks {
            self.instalar_hooks(&dir, Cuentas::base_de(acc).as_ref());
            let reporte = sincronizar_setup_compartido(&CuentaSetup { config_dir: &dir, share_setup: acc["shareSetup"].as_bool() }, &home(), !n.cuenta_ocupada(acc["id"].as_str().unwrap_or_default()));
            let posicion = n.store().accounts().iter().position(|a| a["id"] == acc["id"]).unwrap_or(0);
            let mut avisados = self.avisados.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(t) = aviso_de_setup(&mut avisados, acc["id"].as_str().unwrap_or_default(), posicion, &reporte.skipped) {
                sloth_core::logger_global::aviso("setup", &t);
            }
        }
        n.apoyo.evento("rust.cuentaPreparada", json!([acc]));
        n.avisar_funciones("cuentaPreparada", acc);
    }

    /// `accounts:setShareSetup` ya guardado: aplica el cambio en la carpeta de la cuenta.
    pub fn aplicar_compartir(&self, n: &Nucleo, acc: &Value) -> Value {
        let dir = PathBuf::from(acc["configDir"].as_str().unwrap_or_default());
        if acc["shareSetup"] != Value::Bool(true) {
            if let Err(e) = dejar_de_compartir(&CuentaSetup { config_dir: &dir, share_setup: Some(false) }, &home()) {
                sloth_core::logger_global::error("setup", e);
            }
            self.instalar_hooks(&dir, Some(&json!({})));
            return Value::Null;
        }
        self.instalar_hooks(&dir, Cuentas::base_de(acc).as_ref());
        texto_de_reporte(&sincronizar_setup_compartido(&CuentaSetup { config_dir: &dir, share_setup: Some(true) }, &home(), !n.cuenta_ocupada(acc["id"].as_str().unwrap_or_default())))
    }

    /// Deja el `notify` de Sloth en la cuenta de Codex si su aviso de «terminó» está activado, y lo saca si no. Lo corre
    /// `sloth-hook.exe`. Devuelve el motivo si no quedó como se pidió (también queda en el log, una vez).
    pub fn ajustar_notify(&self, acc: &Value) -> Option<String> {
        let helper = self.helper();
        let programa = helper.as_ref().map(|(exe, _)| (exe.to_string_lossy().into_owned(), "notify"));
        let motivo = sloth_core::codex_notify::ajustar_notify(acc, programa.as_ref().map(|(e, s)| (e.as_str(), *s)), &sloth_core::codex_notify::FsReal);
        if let Some(m) = &motivo {
            sloth_core::codex_notify::avisar_notify(m);
        }
        motivo
    }

    /// El ejecutable del agente, si se encuentra.
    pub fn exe_de(&self, id: ProveedorId) -> Option<String> {
        self.exe(id).ok().flatten()
    }

    fn exe(&self, id: ProveedorId) -> Result<Option<String>, String> {
        let mut cache = self.exes.lock().unwrap_or_else(|e| e.into_inner());
        let exe = cache
            .entry(id.como_texto())
            .or_insert_with(|| {
                let path = std::env::var("PATH").unwrap_or_default();
                let existe = |p: &str| Path::new(p).exists();
                match id {
                    ProveedorId::Claude => resolver_exe_claude(&path, &home().to_string_lossy(), &existe, &|p| std::fs::read_to_string(p).ok(), cfg!(windows)),
                    otro => sloth_core::agente_exe::resolver_exe(otro.como_texto(), &path, &existe, cfg!(windows)),
                }
            })
            .clone();
        // Con Claude, un exe que no se encuentra sigue como siempre (la shell lo busca). Con otro agente es un error claro.
        if exe.is_none() && id != ProveedorId::Claude {
            cache.remove(id.como_texto());
            return Err(format!("No encontré {} en el PATH. Instalalo con: {}", id.nombre(), como_instalar(id)));
        }
        Ok(exe)
    }

    fn env_de(acc: &Value, id: ProveedorId) -> BTreeMap<String, String> {
        let mut e: BTreeMap<String, String> = entorno_limpio(std::env::vars(), &|k| quitar_del_entorno(id, k)).into_iter().collect();
        e.extend(env_cuenta(id, acc["configDir"].as_str().unwrap_or_default()));
        e.insert("SLOTH_ACCOUNT".into(), acc["label"].as_str().unwrap_or_default().into());
        e
    }

    fn exigir(n: &Nucleo, cuenta: &str) -> Result<Value, String> {
        let c = n.cuenta(cuenta);
        exigir_cuenta(c.as_ref(), &|d| Path::new(d).exists()).cloned()
    }

    pub fn retomar_una_vez(&self, ws: &str, cuenta: &str, sesion: &str) {
        self.retomar.lock().unwrap_or_else(|e| e.into_inner()).insert(ws.into(), (cuenta.into(), sesion.into()));
    }

    /// La sesión a retomar si se pidió para ese espacio y esa cuenta; se gasta al usarla.
    fn tomar_retomar(&self, ws: &str, cuenta: &str) -> Option<String> {
        let mut r = self.retomar.lock().unwrap_or_else(|e| e.into_inner());
        if r.get(ws).is_some_and(|(c, _)| c == cuenta) { r.remove(ws).map(|(_, s)| s) } else { None }
    }

    /// argv del agente para la terminal del espacio. Los reemplazos de las funciones del apoyo (retomar tras mover de
    /// cuenta) escriben comandos de `claude`: con otro agente no corren.
    fn comando(&self, n: &Nucleo, ws: &Value, acc: &Value, id: ProveedorId) -> Option<Vec<String>> {
        if id.capacidades().override_claude {
            if let Some(sesion) = self.tomar_retomar(ws["id"].as_str().unwrap_or_default(), acc["id"].as_str().unwrap_or_default()) {
                return Some(vec!["claude".into(), "--resume".into(), sesion]);
            }
            match n.apoyo.pedir("nucleo:comando", vec![ws.clone(), acc.clone()]) {
                Ok(Value::String(c)) if !c.trim().is_empty() => return Some(c.split_whitespace().map(str::to_owned).collect()),
                Ok(_) => {}
                Err(e) => sloth_core::logger_global::error("override", e),
            }
        }
        if ws["autoStartClaude"] != Value::Bool(true) {
            return None;
        }
        let prompt = ws["initialPrompt"].as_str().filter(|p| !p.is_empty());
        // Un «!» inicial Claude Code lo correría como comando de la terminal: ese prompt no se manda.
        if let Some(p) = prompt.filter(|p| ws["initialPromptUsed"] != Value::Bool(true) && problema_del_primer_mensaje(p).is_none()) {
            return Some(argv_interactivo(id, false, Some(p)));
        }
        let dir = Path::new(acc["configDir"].as_str().unwrap_or_default());
        let continuar = ws["resume"] != Value::Bool(false) && hay_conversacion_previa(id, dir, ws["cwd"].as_str().unwrap_or_default());
        Some(argv_interactivo(id, continuar, None))
    }

    pub fn spec(&self, n: &Nucleo, panel: &str) -> Result<PtySpec, String> {
        if let Some(cuenta) = panel.strip_prefix("login:") {
            let acc = Cuentas::exigir(n, cuenta)?;
            let id = exigir_proveedor(&acc)?;
            self.preparar(n, &acc);
            let exe = self.exe(id)?;
            // Primer arranque con esta carpeta: Claude pide tema y login; Codex corre `codex login` solo si todavía no hay sesión.
            let logueada = estado_login(id, Path::new(acc["configDir"].as_str().unwrap_or_default())).estado.logged_in;
            let claude = if logueada { argv_interactivo(id, false, None) } else { argv_login(id) };
            return Ok(PtySpec { cwd: home().to_string_lossy().into_owned(), env: Cuentas::env_de(&acc, id), claude: Some(claude), claude_exe: exe });
        }
        let ws = n.espacio(panel).ok_or("Ese espacio ya no existe.")?;
        let acc = Cuentas::exigir(n, ws["accountId"].as_str().unwrap_or_default())?;
        let id = exigir_proveedor(&acc)?;
        let cwd = ws["cwd"].as_str().unwrap_or_default().to_string();
        if !Path::new(&cwd).exists() {
            return Err(format!("No existe la carpeta {cwd}"));
        }
        self.preparar(n, &acc);
        let cap = id.capacidades();
        let t = n.backend()?;
        let env = entorno_de_terminal(&Cuentas::env_de(&acc, id), &CapHook { hooks: cap.hooks, aviso_turno: cap.aviso_turno }, acc["avisoDeTurno"] == Value::Bool(true), panel, || {
            let (url, token) = t.hook();
            DatosHook { url, token: sloth_core::daemon_protocolo::hook_token_de(&token, panel) }
        });
        let claude = self.comando(n, &ws, &acc, id);
        let claude_exe = if claude.is_some() { self.exe(id)? } else { None };
        Ok(PtySpec { cwd, env, claude, claude_exe })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retomar_una_vez_vale_solo_para_esa_cuenta_y_se_gasta() {
        let c = Cuentas::nuevas(Path::new("raiz"));
        c.retomar_una_vez("w1", "a1", "s1");
        assert_eq!(c.tomar_retomar("w1", "otra"), None);
        assert_eq!(c.tomar_retomar("w1", "a1").as_deref(), Some("s1"));
        assert_eq!(c.tomar_retomar("w1", "a1"), None);
    }

    #[test]
    fn una_ruta_sin_espacios_queda_con_barras() {
        assert_eq!(ruta_para_shell(r"C:\Sloth\bin\sloth-hook.exe").as_deref(), Some("C:/Sloth/bin/sloth-hook.exe"));
        assert_eq!(ruta_para_shell(r"C:\a&b\x.exe"), None);
    }

    #[test]
    fn el_reporte_del_setup_sale_con_los_nombres_de_la_interfaz() {
        let r = SetupSyncReport { linked: vec!["skills".into()], copied: vec![], mcp_servers: vec!["m".into()], skipped: vec![] };
        assert_eq!(texto_de_reporte(&r), json!({ "linked": ["skills"], "copied": [], "mcpServers": ["m"], "skipped": [] }));
    }
}
