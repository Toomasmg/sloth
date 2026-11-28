//! Lo que cada agente (Claude Code, Codex, Copilot) pide al sistema de archivos y al entorno: login, carpeta de la cuenta,
//! variables a quitar y argv. Equivale a src/main/proveedor-claude.ts, proveedor-codex.ts, proveedor-copilot.ts y proveedor-tipos.ts.
//! Los avisos del logger global del original se devuelven como valores: quien llama decide cómo mostrarlos.
use crate::proveedores::ProveedorId;
use crate::shell_args::{claude_with_prompt, prompt_line};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub const ARCHIVO_META_CLAUDE: &str = ".claude.json";
/// Sin esto Codex puede guardar el login en el almacén del sistema y dos cuentas se pisarían entre sí.
pub const CLAVE_ALMACEN: &str = "cli_auth_credentials_store";
pub const CONFIG_INICIAL: &str = "cli_auth_credentials_store = \"file\"\n";
/// config.json de Copilot es chico; uno enorme o un link a otra cosa no se lee.
pub const MAX_BYTES_CONFIG_COPILOT: u64 = 1024 * 1024;

/// Valores fijos y conservadores. `--no-daemon`: el daemon compartido de Codex podría atender a dos cuentas con un solo CODEX_HOME.
const SEGURO_CODEX: [&str; 5] = ["-s", "workspace-write", "-a", "on-request", "--no-daemon"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Aviso {
    pub origen: &'static str,
    pub texto: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EstadoLogin {
    pub logged_in: bool,
    pub email: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResultadoLogin {
    pub estado: EstadoLogin,
    pub aviso: Option<Aviso>,
}

pub fn env_config_dir(id: ProveedorId) -> &'static str {
    match id {
        ProveedorId::Claude => "CLAUDE_CONFIG_DIR",
        ProveedorId::Codex => "CODEX_HOME",
        ProveedorId::Copilot => "COPILOT_HOME",
    }
}

/// Carpeta de la cuenta dentro de accounts/<id>/.
pub fn subcarpeta_cuenta(id: ProveedorId) -> &'static str {
    id.como_texto()
}

/// Archivo del que se lee el email público del login.
pub fn archivo_meta(id: ProveedorId) -> &'static str {
    match id {
        ProveedorId::Claude => ARCHIVO_META_CLAUDE,
        ProveedorId::Codex => "config.toml",
        ProveedorId::Copilot => "config.json",
    }
}

/// Relativa al configDir.
pub fn carpeta_historial(id: ProveedorId) -> &'static str {
    match id {
        ProveedorId::Claude => "projects",
        ProveedorId::Codex => "sessions",
        ProveedorId::Copilot => "session-state",
    }
}

pub fn como_instalar(id: ProveedorId) -> &'static str {
    match id {
        ProveedorId::Claude => "https://docs.claude.com/en/docs/claude-code/setup",
        ProveedorId::Codex => "npm install -g @openai/codex",
        ProveedorId::Copilot => "npm install -g @github/copilot (necesita Node 22) o winget install GitHub.Copilot",
    }
}

/// `clave_mayus` viene en mayúsculas, como la deja el armado del entorno.
pub fn quitar_del_entorno(id: ProveedorId, clave_mayus: &str) -> bool {
    let k = clave_mayus;
    match id {
        ProveedorId::Claude => k == "CLAUDECODE" || k.starts_with("CLAUDE_CODE_") || k == "CLAUDE_CONFIG_DIR" || k == "ANTHROPIC_API_KEY" || k == "ANTHROPIC_AUTH_TOKEN",
        ProveedorId::Codex => ["OPENAI_", "CODEX_", "ANTHROPIC_", "CLAUDE"].iter().any(|p| k.starts_with(p)) || k == "AZURE_OPENAI_API_KEY" || k == "MISTRAL_API_KEY",
        // Copilot guarda su login en el almacén del sistema: ningún token se hereda. Las variables de GitHub se sacan
        // para que la terminal no use otra identidad que la del login del sistema.
        ProveedorId::Copilot => {
            ["COPILOT_", "ANTHROPIC_", "CLAUDE", "OPENAI_", "CODEX_"].iter().any(|p| k.starts_with(p))
                || ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].contains(&k)
        }
    }
}

pub fn env_cuenta(id: ProveedorId, config_dir: &str) -> Vec<(String, String)> {
    let mut env = vec![(env_config_dir(id).to_string(), config_dir.to_string())];
    if id == ProveedorId::Copilot {
        env.push(("COPILOT_AUTO_UPDATE".into(), "false".into()));
    }
    env
}

/// Lo que corre la terminal de login de la cuenta.
pub fn argv_login(id: ProveedorId) -> Vec<String> {
    let a: &[&str] = match id {
        ProveedorId::Claude => &["claude"],
        ProveedorId::Codex => &["codex", "login"],
        ProveedorId::Copilot => &["copilot", "login", "--device-code"],
    };
    a.iter().map(|s| s.to_string()).collect()
}

/// Un prompt vacío cuenta como ausente. Codex y Copilot no tienen `continuar`: Codex porque `resume --last` filtra por carpeta y
/// no está confirmado que acepte -s/-a/--no-daemon después del subcomando; Copilot abre siempre una sesión nueva.
pub fn argv_interactivo(id: ProveedorId, continuar: bool, prompt: Option<&str>) -> Vec<String> {
    let prompt = prompt.filter(|p| !p.is_empty());
    match id {
        ProveedorId::Claude => match prompt {
            Some(p) => claude_with_prompt(p),
            None if continuar => vec!["claude".into(), "--continue".into()],
            None => vec!["claude".into()],
        },
        ProveedorId::Codex => {
            let mut a: Vec<String> = std::iter::once("codex").chain(SEGURO_CODEX).map(str::to_owned).collect();
            if let Some(p) = prompt {
                a.push("--".into());
                a.push(prompt_line(p));
            }
            a
        }
        ProveedorId::Copilot => match prompt {
            Some(p) => vec!["copilot".into(), "--".into(), prompt_line(p)],
            None => vec!["copilot".into()],
        },
    }
}

fn quitar_bom(s: &str) -> &str {
    s.strip_prefix('\u{feff}').unwrap_or(s)
}

fn leer_json(ruta: &Path) -> Option<serde_json::Value> {
    let bytes = fs::read(ruta).ok()?;
    serde_json::from_str(quitar_bom(&String::from_utf8_lossy(&bytes))).ok()
}

fn texto_no_vacio(v: Option<&serde_json::Value>) -> Option<&str> {
    v.and_then(|v| v.as_str()).filter(|s| !s.is_empty())
}

/// Solo `.claude.json` (datos públicos de la cuenta: email). Sloth nunca abre `.credentials.json`: el login lo maneja Claude Code.
fn estado_login_claude(config_dir: &Path) -> EstadoLogin {
    let meta = leer_json(&config_dir.join(ARCHIVO_META_CLAUDE));
    let cuenta = meta.as_ref().and_then(|m| m.get("oauthAccount"));
    let email = texto_no_vacio(cuenta.and_then(|c| c.get("emailAddress")));
    let uuid = texto_no_vacio(cuenta.and_then(|c| c.get("accountUuid")));
    EstadoLogin { logged_in: email.is_some() || uuid.is_some(), email: email.map(str::to_owned) }
}

/// Solo la existencia del archivo: sus credenciales no se abren.
fn estado_login_codex(config_dir: &Path) -> EstadoLogin {
    EstadoLogin { logged_in: config_dir.join("auth.json").exists(), email: None }
}

/// Solo mira si hay algún usuario en `loggedInUsers`; nada más del archivo sale de acá. `lastLoggedInUser` no cuenta: si Copilot
/// lo conserva tras `/logout` la cuenta figuraría conectada. Los campos no están confirmados con una cuenta real.
pub fn login_de_config_copilot(json: &serde_json::Value) -> bool {
    json.get("loggedInUsers").and_then(|l| l.as_array()).is_some_and(|l| !l.is_empty())
}

fn estado_login_copilot(config_dir: &Path) -> ResultadoLogin {
    let archivo = config_dir.join("config.json");
    let leer = || -> Result<bool, (Option<ErrorKind>, String, bool)> {
        let meta = fs::symlink_metadata(&archivo).map_err(|e| (Some(e.kind()), e.to_string(), false))?;
        if !meta.is_file() || meta.len() > MAX_BYTES_CONFIG_COPILOT {
            return Err((None, "no es un archivo regular o es demasiado grande".into(), false));
        }
        let bytes = fs::read(&archivo).map_err(|e| (Some(e.kind()), e.to_string(), false))?;
        let json = serde_json::from_str(quitar_bom(&String::from_utf8_lossy(&bytes))).map_err(|e| (None, e.to_string(), true))?;
        Ok(login_de_config_copilot(&json))
    };
    match leer() {
        Ok(logged_in) => ResultadoLogin { estado: EstadoLogin { logged_in, email: None }, aviso: None },
        // Sin archivo o a medio escribir es «sin sesión»; un error de permisos o de disco se avisa para no confundirlo con eso.
        Err((kind, msg, es_json)) => {
            let silencioso = es_json || kind == Some(ErrorKind::NotFound);
            let aviso = (!silencioso).then(|| Aviso { origen: "copilot", texto: format!("no pude leer el login de Copilot en {}: {msg}", config_dir.display()) });
            ResultadoLogin { estado: EstadoLogin::default(), aviso }
        }
    }
}

/// Sin abrir credenciales: solo lo que el agente deja a la vista (datos públicos o la existencia de un archivo).
/// El aviso de Copilot se repite en cada llamada: quien llama lo muestra una sola vez por mensaje.
pub fn estado_login(id: ProveedorId, config_dir: &Path) -> ResultadoLogin {
    match id {
        ProveedorId::Claude => ResultadoLogin { estado: estado_login_claude(config_dir), aviso: None },
        ProveedorId::Codex => ResultadoLogin { estado: estado_login_codex(config_dir), aviso: None },
        ProveedorId::Copilot => estado_login_copilot(config_dir),
    }
}

pub(crate) fn sufijo_unico() -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    format!("{}-{nanos:x}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed))
}

/// Crea config.toml solo si no existe; uno existente no se toca (si no fija la clave del almacén, se avisa).
pub fn preparar_carpeta_codex(config_dir: &Path) -> std::io::Result<Vec<Aviso>> {
    fs::create_dir_all(config_dir)?;
    let destino = config_dir.join("config.toml");
    if destino.exists() {
        let aviso = match fs::read(&destino) {
            Ok(b) if !String::from_utf8_lossy(&b).contains(CLAVE_ALMACEN) => {
                Some(format!("el config.toml de una cuenta no fija {CLAVE_ALMACEN}: el login podría no quedar aislado por cuenta."))
            }
            Ok(_) => None,
            Err(e) => Some(format!("no pude leer el config.toml de una cuenta: {e}")),
        };
        return Ok(aviso.map(|texto| Aviso { origen: "codex", texto }).into_iter().collect());
    }
    // tmp único y copia exclusiva: un resto de una corrida anterior no rompe el alta y un config.toml que aparezca en el medio nunca se pisa.
    let tmp = config_dir.join(format!("config.toml.tmp-{}", sufijo_unico()));
    OpenOptions::new().write(true).create_new(true).open(&tmp)?.write_all(CONFIG_INICIAL.as_bytes())?;
    let copiado = copiar_exclusivo(&tmp, &destino);
    let _ = fs::remove_file(&tmp);
    match copiado {
        Err(e) if e.kind() != ErrorKind::AlreadyExists => Err(e),
        _ => Ok(Vec::new()),
    }
}

/// Falla con `AlreadyExists` si `destino` ya está: nunca pisa un archivo del usuario.
pub(crate) fn copiar_exclusivo(origen: &Path, destino: &Path) -> std::io::Result<()> {
    let mut d = OpenOptions::new().write(true).create_new(true).open(destino)?;
    let r = fs::read(origen).and_then(|b| d.write_all(&b));
    if r.is_err() {
        drop(d);
        let _ = fs::remove_file(destino);
    }
    r
}

/// Deja la carpeta de la cuenta lista antes del primer arranque; nunca pisa lo que ya hay.
pub fn preparar_carpeta(id: ProveedorId, config_dir: &Path) -> std::io::Result<Vec<Aviso>> {
    match id {
        ProveedorId::Claude => Ok(Vec::new()),
        ProveedorId::Codex => preparar_carpeta_codex(config_dir),
        ProveedorId::Copilot => fs::create_dir_all(config_dir).map(|()| Vec::new()),
    }
}

/// Como `cwd.replace(/[^A-Za-z0-9]/g, '-')` de JavaScript, que cuenta unidades UTF-16: un carácter fuera del plano básico da dos guiones.
pub fn nombre_carpeta_proyecto(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_string() } else { "-".repeat(c.len_utf16()) }).collect()
}

/// Claude guarda cada conversación en projects/<cwd con separadores como '-'>. Codex y Copilot: siempre falso, sus
/// sesiones no dicen de qué repo son y sin certeza no hay resume.
pub fn hay_conversacion_previa(id: ProveedorId, config_dir: &Path, cwd: &str) -> bool {
    if id != ProveedorId::Claude {
        return false;
    }
    let dir = config_dir.join("projects").join(nombre_carpeta_proyecto(cwd));
    fs::read_dir(dir).is_ok_and(|it| it.flatten().any(|f| f.file_name().to_string_lossy().ends_with(".jsonl")))
}

fn unir(dir: &str, nombre: &str, win: bool) -> String {
    let sep = if win { '\\' } else { '/' };
    if dir.ends_with('/') || (win && dir.ends_with('\\')) { format!("{dir}{nombre}") } else { format!("{dir}{sep}{nombre}") }
}

fn carpeta_de(ruta: &str, win: bool) -> &str {
    let corte = if win { ruta.rfind(['\\', '/']) } else { ruta.rfind('/') };
    corte.map_or(".", |i| &ruta[..i])
}

fn minusculas_ascii_contiene(texto: &str, aguja: &str) -> bool {
    texto.to_ascii_lowercase().contains(aguja)
}

/// Lo que va entre `"%dp0%\` y la comilla de cierre, para el primer caso que termina con alguna de las extensiones
/// (la regexp original era `"%dp0%\\([^"]+?\.ext)"` sin distinguir mayúsculas).
fn ruta_dp0(txt: &str, extensiones: &[&str]) -> Option<String> {
    let minus = txt.to_ascii_lowercase();
    let marca = "\"%dp0%\\";
    minus.match_indices(marca).find_map(|(i, _)| {
        let ini = i + marca.len();
        let cuerpo = &txt[ini..ini + minus[ini..].find('"')?];
        let m = &minus[ini..ini + cuerpo.len()];
        extensiones.iter().any(|e| m.len() > e.len() && m.ends_with(e)).then(|| cuerpo.to_string())
    })
}

/// `claude.exe` en el PATH o en ~/.local/bin, o el que apunta el shim `claude.cmd` de npm. A diferencia de Codex y Copilot,
/// acá las carpetas relativas del PATH cuentan. El caché del original queda a cargo de quien llame.
pub fn resolver_exe_claude(path: &str, home: &str, existe: &dyn Fn(&str) -> bool, leer_archivo: &dyn Fn(&str) -> Option<String>, win: bool) -> Option<String> {
    let dirs: Vec<&str> = path.split(if win { ';' } else { ':' }).filter(|d| !d.is_empty()).collect();
    let mut candidatos: Vec<String> = dirs.iter().map(|d| unir(d, "claude.exe", win)).collect();
    candidatos.push(unir(&unir(&unir(home, ".local", win), "bin", win), "claude.exe", win));
    if let Some(c) = candidatos.into_iter().find(|c| existe(c)) {
        return Some(c);
    }
    for d in dirs {
        let shim = unir(d, "claude.cmd", win);
        if !existe(&shim) {
            continue;
        }
        let Some(txt) = leer_archivo(&shim) else { continue };
        let base = carpeta_de(&shim, win);
        if let Some(rel) = ruta_dp0(&txt, &[".exe"]) {
            let exe = unir(base, &rel, win);
            if existe(&exe) {
                return Some(exe);
            }
        }
        if minusculas_ascii_contiene(&txt, "\"%dp0%\\") && ruta_dp0(&txt, &[".js", ".cjs"]).is_some() {
            let exe = ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"].iter().fold(base.to_string(), |a, n| unir(&a, n, win));
            if existe(&exe) {
                return Some(exe);
            }
        }
    }
    None
}

/// Lo del sistema que hace falta para encontrar el ejecutable de un agente.
pub struct EntornoExe<'a> {
    pub path: &'a str,
    pub home: &'a str,
    pub existe: &'a dyn Fn(&str) -> bool,
    pub leer_archivo: &'a dyn Fn(&str) -> Option<String>,
    pub win: bool,
}

/// El ejecutable del agente, o None si no está instalado.
pub fn resolver_exe(id: ProveedorId, e: &EntornoExe) -> Option<String> {
    match id {
        ProveedorId::Claude => resolver_exe_claude(e.path, e.home, e.existe, e.leer_archivo, e.win),
        ProveedorId::Codex | ProveedorId::Copilot => crate::agente_exe::resolver_exe(id.como_texto(), e.path, e.existe, e.win),
    }
}

/// `resolver_exe` con el PATH, el home y el disco de verdad.
pub fn resolver_exe_del_sistema(id: ProveedorId) -> Option<String> {
    let path = std::env::var("PATH").or_else(|_| std::env::var("Path")).unwrap_or_default();
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
    let existe = |f: &str| Path::new(f).exists();
    let leer = |f: &str| fs::read_to_string(f).ok();
    resolver_exe(id, &EntornoExe { path: &path, home: &home, existe: &existe, leer_archivo: &leer, win: cfg!(windows) })
}

#[cfg(test)]
mod tests;
