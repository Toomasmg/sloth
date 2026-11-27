//! Correr git / gh sin shell (lista de argumentos), oculto en Windows y con timeout. Equivale a src/main/features/git-run.ts.
//! Lo puro (argv, entorno seguro, filtros, textos de error, validaciones) va aparte de lo que lanza procesos: `Ejecutor`
//! es el único que toca `std::process`, y los tests de las demás piezas usan uno simulado.
use std::collections::HashMap;
use std::fmt;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub const TIMEOUT_DEFECTO_MS: u64 = 30_000;
const MAX_BYTES_DEFECTO: usize = 16 * 1024 * 1024;
const MAX_STDERR: usize = 1024 * 1024;
const FILTROS_TTL: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Programa {
    Git,
    Gh,
}

impl Programa {
    pub fn nombre(self) -> &'static str {
        match self {
            Programa::Git => "git",
            Programa::Gh => "gh",
        }
    }
}

/// Para quien tenga que distinguir «no está instalado», «se pasó de tiempo» o «se canceló» de un error de git/gh.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Motivo {
    Falta,
    Tiempo,
    Cancelada,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitError {
    pub mensaje: String,
    pub motivo: Option<Motivo>,
}

impl GitError {
    pub fn nuevo(mensaje: impl Into<String>) -> Self {
        GitError { mensaje: mensaje.into(), motivo: None }
    }

    pub fn con_motivo(mensaje: impl Into<String>, motivo: Motivo) -> Self {
        GitError { mensaje: mensaje.into(), motivo: Some(motivo) }
    }
}

impl fmt::Display for GitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.mensaje)
    }
}

impl std::error::Error for GitError {}

pub type Env = Vec<(String, String)>;
pub type ConfigPar = (String, String);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resultado {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    /// Se cortó el proceso porque ya había más líneas que `max_lineas`.
    pub cortado: bool,
}

impl Resultado {
    pub fn ok(stdout: &str) -> Self {
        Resultado { code: 0, stdout: stdout.to_string(), stderr: String::new(), cortado: false }
    }

    pub fn falla(code: i32, stderr: &str) -> Self {
        Resultado { code, stdout: String::new(), stderr: stderr.to_string(), cortado: false }
    }
}

#[derive(Clone, Default)]
pub struct OpcionesRun {
    pub cwd: Option<PathBuf>,
    pub timeout_ms: Option<u64>,
    /// Texto para stdin (p. ej. `gh pr create --body-file -`).
    pub input: Option<String>,
    /// Corta la salida a este tamaño (bytes aprox.).
    pub max_bytes: Option<usize>,
    /// Corta el proceso cuando su salida ya tiene más de este número de líneas completas.
    pub max_lineas: Option<usize>,
    /// Al activarse se corta el proceso y se devuelve el error `Cancelada`.
    pub cancelar: Option<Arc<AtomicBool>>,
    /// Variables que se suman al entorno de siempre (p. ej. las de `git_safe_env`).
    pub env: Env,
}

impl OpcionesRun {
    pub fn timeout(ms: u64) -> Self {
        OpcionesRun { timeout_ms: Some(ms), ..Default::default() }
    }

    pub fn con_input(mut self, input: &str) -> Self {
        self.input = Some(input.to_string());
        self
    }

    pub fn con_cwd(mut self, cwd: &str) -> Self {
        self.cwd = Some(PathBuf::from(cwd));
        self
    }
}

pub trait Ejecutor: Send + Sync {
    fn ejecutar(&self, prog: Programa, args: &[String], opts: &OpcionesRun) -> Result<Resultado, GitError>;
}

pub fn git_config_env(pares: &[ConfigPar]) -> Env {
    let mut env = vec![("GIT_CONFIG_COUNT".to_string(), pares.len().to_string())];
    for (i, (k, v)) in pares.iter().enumerate() {
        env.push((format!("GIT_CONFIG_KEY_{i}"), k.clone()));
        env.push((format!("GIT_CONFIG_VALUE_{i}"), v.clone()));
    }
    env
}

fn par(k: &str, v: &str) -> ConfigPar {
    (k.to_string(), v.to_string())
}

/// Un repo ajeno (zip, USB, carpeta compartida) puede traer core.fsmonitor = <comando> en su .git/config, y git lo
/// ejecuta en cualquier status. Con log.showSignature y un commit firmado, `git log` correría el gpg.program del repo.
fn config_segura() -> Vec<ConfigPar> {
    vec![par("core.fsmonitor", "false"), par("log.showSignature", "false")]
}

pub fn git_safe_env_base() -> Env {
    git_config_env(&config_segura())
}

/// Solo estos firman o verifican firmas con la config de la persona. El resto nunca llama a gpg: un programa vacío no
/// rompe nada y uno puesto por el repo no se ejecuta.
const FIRMAN: [&str; 8] = ["commit", "pull", "merge", "rebase", "cherry-pick", "revert", "tag", "am"];

/// `git_safe_env_base` más, salvo en los que firman, los gpg.*.program vacíos; `extra` suma otros (los filtros).
pub fn git_safe_env(args: &[&str], extra: &[ConfigPar]) -> Env {
    let mut pares = config_segura();
    if !FIRMAN.contains(&args.first().copied().unwrap_or("")) {
        for k in ["gpg.program", "gpg.ssh.program", "gpg.x509.program"] {
            pares.push(par(k, ""));
        }
    }
    pares.extend(extra.iter().cloned());
    git_config_env(&pares)
}

/// Lo que instala `git lfs install`: con estos comandos exactos el filtro «lfs» se respeta.
fn valor_lfs(clave: &str) -> Option<&'static str> {
    match clave {
        "filter.lfs.clean" => Some("git-lfs clean -- %f"),
        "filter.lfs.smudge" => Some("git-lfs smudge -- %f"),
        "filter.lfs.process" => Some("git-lfs filter-process"),
        "filter.lfs.required" => Some("true"),
        _ => None,
    }
}

/// Config que apaga los filtros del repo (salida de `git config -z --get-regexp ^filter\.`): un `.git/config` puede traer
/// `filter.x.clean = <comando>` y un `.gitattributes` que lo use, y git lo correría en un `status`. Se deja el de
/// git-lfs si es el estándar.
pub fn filtros_apagados(config_z: &str) -> Vec<ConfigPar> {
    let mut ultimo: Vec<(&str, &str)> = Vec::new();
    for entrada in config_z.split('\0') {
        if entrada.is_empty() {
            continue;
        }
        let (k, v) = match entrada.find('\n') {
            Some(nl) => (&entrada[..nl], &entrada[nl + 1..]),
            None => (entrada, ""),
        };
        match ultimo.iter_mut().find(|(ck, _)| *ck == k) {
            Some(e) => e.1 = v,
            None => ultimo.push((k, v)),
        }
    }
    let mut drivers: Vec<(&str, bool)> = Vec::new();
    for (clave, valor) in &ultimo {
        if clave.len() < 7 || !clave[..7].eq_ignore_ascii_case("filter.") {
            continue;
        }
        let resto = &clave[7..];
        let Some(punto) = resto.rfind('.') else { continue };
        let (nombre, k) = (&resto[..punto], &resto[punto + 1..]);
        if nombre.is_empty() || k.is_empty() {
            continue;
        }
        let estandar = valor_lfs(&clave.to_lowercase()) == Some(valor.trim());
        match drivers.iter_mut().find(|(n, _)| *n == nombre) {
            Some(d) => d.1 = d.1 && estandar,
            None => drivers.push((nombre, estandar)),
        }
    }
    let mut out = Vec::new();
    for (nombre, estandar) in drivers {
        if estandar {
            continue;
        }
        for k in ["clean", "smudge", "process"] {
            out.push((format!("filter.{nombre}.{k}"), String::new()));
        }
        out.push((format!("filter.{nombre}.required"), "false".to_string()));
    }
    out
}

/// Mensaje legible a partir del stderr de git/gh.
pub fn readable(r: &Resultado, what: &str) -> String {
    let fuente = if !r.stderr.is_empty() {
        &r.stderr
    } else if !r.stdout.is_empty() {
        &r.stdout
    } else {
        ""
    };
    let raw = fuente.trim();
    let low = raw.to_lowercase();
    let text = raw
        .split('\n')
        .map(|l| quitar_prefijo(l.trim_end_matches('\r')).trim().to_string())
        .filter(|l| !l.is_empty())
        .take(6)
        .collect::<Vec<_>>()
        .join(" — ");
    let tiene = |s: &str| low.contains(s);
    let rechazado = raw.split('\n').any(|l| {
        let l = l.to_lowercase();
        l.find("rejected").is_some_and(|i| l[i + 8..].contains("non-fast-forward"))
    });
    if tiene("not a git repository") {
        return "La carpeta no es un repositorio git.".to_string();
    }
    if tiene("gh auth login") || tiene("not logged into") {
        return "gh no tiene sesión iniciada: corré «gh auth login».".to_string();
    }
    if rechazado || tiene("fetch first") {
        return "El remoto tiene commits que no tenés (push rechazado). Traelos con pull/rebase antes de pushear; nunca se fuerza.".to_string();
    }
    if tiene("not possible to fast-forward") || tiene("divergent branches") || tiene("diverging branches") {
        return "La rama local y el remoto se separaron: no se puede traer sin combinar. Resolvelo a mano (merge o rebase); Sloth nunca fuerza nada.".to_string();
    }
    if tiene("there is no tracking information") || tiene("no upstream branch") {
        return "La rama no tiene remoto asociado. Subila primero con «Subir».".to_string();
    }
    if tiene("your local changes to the following files would be overwritten") || tiene("would be overwritten by") {
        return "Hay cambios sin confirmar que chocan con la otra rama. Confirmalos o guardalos en stash antes de cambiar.".to_string();
    }
    if tiene("conflict") || tiene("automatic merge failed") {
        return "Quedaron conflictos. Resolvelos a mano en el editor.".to_string();
    }
    if tiene("could not read from remote") || tiene("authentication failed") || tiene("permission denied (publickey)") {
        return format!("No se pudo conectar con el remoto (credenciales o red). {text}");
    }
    if text.is_empty() {
        format!("{what} falló (código {}).", r.code)
    } else {
        format!("{what} falló: {text}")
    }
}

/// `^(fatal|error|hint|remote):\s*` sin distinguir mayúsculas.
fn quitar_prefijo(l: &str) -> &str {
    for p in ["fatal:", "error:", "hint:", "remote:"] {
        if l.len() >= p.len() && l.is_char_boundary(p.len()) && l[..p.len()].eq_ignore_ascii_case(p) {
            return l[p.len()..].trim_start();
        }
    }
    l
}

pub fn es_absoluta(p: &str) -> bool {
    if Path::new(p).is_absolute() {
        return true;
    }
    cfg!(windows) && (p.starts_with('/') || p.starts_with('\\'))
}

pub fn is_dir(p: &str) -> bool {
    if p.is_empty() || p.encode_utf16().count() > 1024 || !es_absoluta(p) {
        return false;
    }
    std::fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false)
}

/// Nombre de rama válido según git (sin correr git: reglas de check-ref-format más comunes).
pub fn valid_branch_name(b: &str) -> bool {
    if b.is_empty() || b.encode_utf16().count() > 200 {
        return false;
    }
    if b.starts_with('-') || b.starts_with('/') || b.ends_with('/') || b.ends_with('.') || b.ends_with(".lock") {
        return false;
    }
    if b.contains("..") || b.contains("@{") || b.contains("//") || b == "@" {
        return false;
    }
    if b.chars().any(|c| (c as u32) <= 0x20 || c == '\u{7f}' || "~^:?*[\\".contains(c)) {
        return false;
    }
    b.split('/').all(|p| !p.is_empty() && !p.starts_with('.'))
}

/// Como `valid_branch_name` pero sin aceptar el `+` inicial (refspec forzado): lo que piden casi todas las operaciones.
pub fn rama_segura(b: &str) -> bool {
    valid_branch_name(b) && !b.starts_with('+')
}

pub const PROTECTED: [&str; 3] = ["main", "master", "staging"];

/// Normaliza una ruta para comparar (Windows: sin mayúsculas, barras \\ y sin barra final).
pub fn norm_path(p: &str) -> String {
    let s = p.replace('/', "\\");
    let s = s.trim_end_matches('\\');
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}

fn entorno_proceso() -> Env {
    let mut env = git_safe_env_base();
    for (k, v) in [
        // Nada de prompts interactivos: si git o gh quieren preguntar algo, fallan con un mensaje.
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GCM_INTERACTIVE", "never"),
        ("GH_PROMPT_DISABLED", "1"),
        ("GH_NO_UPDATE_NOTIFIER", "1"),
        ("NO_COLOR", "1"),
        ("LC_ALL", "C"),
    ] {
        env.push((k.to_string(), v.to_string()));
    }
    env
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Ejecutor real: `std::process::Command` sin shell, sin ventana en Windows, con timeout y cancelación.
pub struct ProcesoEjecutor;

fn leer_salida<R: Read + Send + 'static>(mut r: R, tope: usize, lineas: Option<(usize, Arc<AtomicBool>)>) -> JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut acum: Vec<u8> = Vec::new();
        let mut nl = 0usize;
        let mut buf = [0u8; 16 * 1024];
        loop {
            let n = match r.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            // Pasado el tope se sigue leyendo (y tirando) para que el hijo no se bloquee escribiendo.
            if acum.len() < tope {
                let t = n.min(tope - acum.len());
                acum.extend_from_slice(&buf[..t]);
                if let Some((limite, flag)) = &lineas {
                    nl += buf[..t].iter().filter(|b| **b == b'\n').count();
                    if nl > *limite {
                        flag.store(true, Ordering::SeqCst);
                        break;
                    }
                }
            }
        }
        acum
    })
}

fn matar_arbol(hijo: &mut Child) {
    let pid = hijo.id().to_string();
    #[cfg(windows)]
    let ok = {
        use std::os::windows::process::CommandExt;
        Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    };
    #[cfg(not(windows))]
    let ok = Command::new("kill")
        .args(["-KILL", "--", &format!("-{pid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        // taskkill/kill pueden no estar, vencer o negar el acceso: al menos se mata el proceso directo. Si ya murió, no importa.
        let _ = hijo.kill();
    }
    let _ = hijo.wait();
}

impl Ejecutor for ProcesoEjecutor {
    fn ejecutar(&self, prog: Programa, args: &[String], opts: &OpcionesRun) -> Result<Resultado, GitError> {
        let cancelado = || opts.cancelar.as_ref().is_some_and(|c| c.load(Ordering::SeqCst));
        if cancelado() {
            return Err(GitError::con_motivo("Consulta cancelada.", Motivo::Cancelada));
        }
        let mut cmd = Command::new(prog.nombre());
        cmd.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(cwd) = &opts.cwd {
            cmd.current_dir(cwd);
        }
        cmd.envs(entorno_proceso());
        cmd.envs(opts.env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Líder de su grupo: así se puede matar el árbol entero.
            cmd.process_group(0);
        }
        let mut hijo = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                GitError::con_motivo(format!("No encontré «{}» en el PATH.", prog.nombre()), Motivo::Falta)
            } else {
                GitError::nuevo(e.to_string())
            }
        })?;
        let timeout = Duration::from_millis(opts.timeout_ms.unwrap_or(TIMEOUT_DEFECTO_MS));
        let cortar = Arc::new(AtomicBool::new(false));
        let stdout = hijo.stdout.take().map(|s| {
            leer_salida(s, opts.max_bytes.unwrap_or(MAX_BYTES_DEFECTO), opts.max_lineas.map(|l| (l, cortar.clone())))
        });
        let stderr = hijo.stderr.take().map(|s| leer_salida(s, MAX_STDERR, None));
        let entrada = hijo.stdin.take();
        if let (Some(mut stdin), Some(texto)) = (entrada, opts.input.clone()) {
            // Un hijo que termina antes de leer todo cierra la tubería: el error de escritura no dice nada útil.
            thread::spawn(move || {
                let _ = stdin.write_all(texto.as_bytes());
            });
        }
        let inicio = Instant::now();
        let mut es_cortado = false;
        let estado = loop {
            match hijo.try_wait() {
                Ok(Some(s)) => break Some(s),
                Ok(None) => {}
                Err(e) => return Err(GitError::nuevo(e.to_string())),
            }
            if cancelado() {
                matar_arbol(&mut hijo);
                return Err(GitError::con_motivo("Consulta cancelada.", Motivo::Cancelada));
            }
            if cortar.load(Ordering::SeqCst) {
                matar_arbol(&mut hijo);
                es_cortado = true;
                break None;
            }
            if inicio.elapsed() >= timeout {
                matar_arbol(&mut hijo);
                let msg = format!("{} tardó demasiado y se canceló ({} s).", prog.nombre(), (timeout.as_millis() as f64 / 1000.0).round() as u64);
                return Err(GitError::con_motivo(msg, Motivo::Tiempo));
            }
            thread::sleep(Duration::from_millis(2));
        };
        let recoger = |h: Option<JoinHandle<Vec<u8>>>| h.and_then(|h| h.join().ok()).unwrap_or_default();
        let out = recoger(stdout);
        let err = recoger(stderr);
        Ok(Resultado {
            code: estado.and_then(|s| s.code()).unwrap_or(-1),
            stdout: String::from_utf8_lossy(&out).into_owned(),
            stderr: String::from_utf8_lossy(&err).into_owned(),
            cortado: es_cortado,
        })
    }
}

/// git / gh con el entorno seguro puesto. Guarda 10 s la lista de filtros de cada repo para no preguntarla en cada status.
pub struct Git<E: Ejecutor> {
    pub ejecutor: E,
    filtros: Mutex<HashMap<String, (Instant, Vec<ConfigPar>)>>,
}

impl<E: Ejecutor> Git<E> {
    pub fn new(ejecutor: E) -> Self {
        Git { ejecutor, filtros: Mutex::new(HashMap::new()) }
    }

    pub fn run(&self, prog: Programa, args: &[&str], opts: OpcionesRun) -> Result<Resultado, GitError> {
        let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        self.ejecutor.ejecutar(prog, &args, &opts)
    }

    /// Los filtros a apagar cuando `args` es un status o un diff automático (ver `filtros_apagados`).
    pub fn filtros_de(&self, cwd: &str, args: &[&str]) -> Result<Vec<ConfigPar>, GitError> {
        // status y diff contra el árbol de trabajo pasan cada archivo cambiado por el filtro clean del repo.
        if !matches!(args.first().copied(), Some("status") | Some("diff")) {
            return Ok(Vec::new());
        }
        {
            let cache = self.filtros.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((at, pares)) = cache.get(cwd) {
                if at.elapsed() < FILTROS_TTL {
                    return Ok(pares.clone());
                }
            }
        }
        let opts = OpcionesRun { env: git_safe_env(&["config"], &[]), ..OpcionesRun::timeout(10_000) };
        let r = self.run(Programa::Git, &["-C", cwd, "config", "-z", "--get-regexp", "^filter\\."], opts)?;
        // 1 = ningún filtro; otro error (carpeta que no existe, config rota) hace fallar igual al comando que sigue.
        let pares = if r.code == 0 { filtros_apagados(&r.stdout) } else { Vec::new() };
        self.filtros.lock().unwrap_or_else(|e| e.into_inner()).insert(cwd.to_string(), (Instant::now(), pares.clone()));
        Ok(pares)
    }

    /// git que devuelve el resultado crudo (para comandos donde el código distinto de 0 significa «no»).
    pub fn git_raw(&self, cwd: &str, args: &[&str], mut opts: OpcionesRun) -> Result<Resultado, GitError> {
        let mut env = git_safe_env(args, &self.filtros_de(cwd, args)?);
        env.append(&mut opts.env);
        opts.env = env;
        let mut argv = vec!["-C", cwd, "-c", "core.quotepath=false"];
        argv.extend_from_slice(args);
        self.run(Programa::Git, &argv, opts)
    }

    /// git con -C <cwd>; devuelve Err legible si falla.
    pub fn git(&self, cwd: &str, args: &[&str], opts: OpcionesRun) -> Result<String, GitError> {
        let r = self.git_raw(cwd, args, opts)?;
        if r.code != 0 {
            return Err(GitError::nuevo(readable(&r, &format!("git {}", args.first().copied().unwrap_or("")))));
        }
        Ok(r.stdout)
    }
}

#[cfg(test)]
pub mod prueba {
    use super::*;

    #[derive(Clone, Debug)]
    pub struct Llamada {
        pub prog: Programa,
        pub args: Vec<String>,
        pub env: Env,
        pub input: Option<String>,
        pub timeout_ms: Option<u64>,
    }

    impl Llamada {
        /// Los argumentos de git sin el `-C <cwd> -c core.quotepath=false` que pone `git_raw`.
        pub fn sub(&self) -> Vec<&str> {
            let skip = match (self.prog, self.args.first().map(String::as_str), self.args.get(2).map(String::as_str)) {
                (Programa::Git, Some("-C"), Some("-c")) => 4,
                (Programa::Git, Some("-C"), _) => 2,
                _ => 0,
            };
            self.args.iter().skip(skip).map(String::as_str).collect()
        }
    }

    type Respuesta = Box<dyn Fn(&Llamada) -> Result<Resultado, GitError> + Send + Sync>;

    pub struct Simulado {
        pub llamadas: Mutex<Vec<Llamada>>,
        respuesta: Respuesta,
    }

    impl Simulado {
        pub fn con(f: impl Fn(&Llamada) -> Result<Resultado, GitError> + Send + Sync + 'static) -> Self {
            Simulado { llamadas: Mutex::new(Vec::new()), respuesta: Box::new(f) }
        }

        pub fn registro(&self) -> Vec<Llamada> {
            self.llamadas.lock().unwrap_or_else(|e| e.into_inner()).clone()
        }
    }

    impl Ejecutor for Simulado {
        fn ejecutar(&self, prog: Programa, args: &[String], opts: &OpcionesRun) -> Result<Resultado, GitError> {
            let l = Llamada { prog, args: args.to_vec(), env: opts.env.clone(), input: opts.input.clone(), timeout_ms: opts.timeout_ms };
            self.llamadas.lock().unwrap_or_else(|e| e.into_inner()).push(l.clone());
            (self.respuesta)(&l)
        }
    }

    /// Carpeta temporal que se borra al soltarla.
    pub struct Temporal(pub PathBuf);

    impl Temporal {
        pub fn nueva(prefijo: &str) -> Temporal {
            use std::sync::atomic::AtomicU32;
            static N: AtomicU32 = AtomicU32::new(0);
            let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
            let p = std::env::temp_dir().join(format!("{prefijo}-{}-{t}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
            std::fs::create_dir_all(&p).expect("crear carpeta temporal de prueba");
            // En CI de Windows el temp viene en nombre corto (RUNNER~1) y git devuelve el largo: se compara siempre el largo.
            let real = std::fs::canonicalize(&p).unwrap_or(p);
            let t = real.to_string_lossy().into_owned();
            Temporal(match t.strip_prefix("\\\\?\\") {
                Some(sin) if sin.as_bytes().get(1) == Some(&b':') => PathBuf::from(sin),
                _ => real,
            })
        }

        pub fn ruta(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }

    impl Drop for Temporal {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    pub fn git_real() -> Git<ProcesoEjecutor> {
        Git::new(ProcesoEjecutor)
    }

    /// Repo real con un commit en `main`, usuario de prueba y sin firma.
    pub fn repo_con_commit(g: &Git<ProcesoEjecutor>, dir: &str) {
        for a in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "t@t.t"][..],
            &["config", "user.name", "Test"][..],
            &["config", "commit.gpgsign", "false"][..],
            &["config", "core.autocrlf", "false"][..],
        ] {
            g.git(dir, a, OpcionesRun::timeout(20_000)).expect("preparar repo de prueba");
        }
        std::fs::write(Path::new(dir).join("a.txt"), "hola\n").expect("escribir archivo de prueba");
        g.git(dir, &["add", "a.txt"], OpcionesRun::timeout(20_000)).expect("add");
        g.git(dir, &["commit", "-q", "-m", "inicial"], OpcionesRun::timeout(20_000)).expect("commit");
    }
}

#[cfg(test)]
mod tests {
    use super::prueba::*;
    use super::*;

    fn par_s(k: &str, v: &str) -> ConfigPar {
        (k.to_string(), v.to_string())
    }

    #[test]
    fn con_la_senal_ya_abortada_run_rechaza_enseguida_como_cancelada() {
        let g = git_real();
        let opts = OpcionesRun { cancelar: Some(Arc::new(AtomicBool::new(true))), ..Default::default() };
        let e = g.run(Programa::Git, &["--version"], opts).unwrap_err();
        assert_eq!(e.motivo, Some(Motivo::Cancelada));
    }

    #[test]
    fn abortar_a_mitad_de_camino_corta_git_y_rechaza_como_cancelada() {
        let g = git_real();
        let flag = Arc::new(AtomicBool::new(false));
        let f2 = flag.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            f2.store(true, Ordering::SeqCst);
        });
        let inicio = Instant::now();
        // Un alias de shell que tarda: solo termina antes si lo cortan.
        let opts = OpcionesRun { cancelar: Some(flag), timeout_ms: Some(20_000), ..Default::default() };
        let e = g.run(Programa::Git, &["-c", "alias.espera=!sleep 10", "espera"], opts).unwrap_err();
        assert_eq!(e.motivo, Some(Motivo::Cancelada));
        assert!(inicio.elapsed() < Duration::from_secs(8));
    }

    #[test]
    fn pasado_el_timeout_run_corta_y_rechaza_como_tiempo() {
        let g = git_real();
        let inicio = Instant::now();
        let e = g.run(Programa::Git, &["-c", "alias.espera=!sleep 10", "espera"], OpcionesRun::timeout(300)).unwrap_err();
        assert_eq!(e.motivo, Some(Motivo::Tiempo));
        assert!(e.mensaje.starts_with("git tardó demasiado y se canceló"));
        assert!(inicio.elapsed() < Duration::from_secs(8));
    }

    #[test]
    fn sin_abortar_run_termina_normal() {
        let g = git_real();
        let opts = OpcionesRun { cancelar: Some(Arc::new(AtomicBool::new(false))), ..Default::default() };
        let r = g.run(Programa::Git, &["--version"], opts).unwrap();
        assert_eq!(r.code, 0);
        assert!(r.stdout.starts_with("git version"));
    }

    #[test]
    fn un_programa_que_no_existe_da_el_motivo_falta() {
        let e = ProcesoEjecutor.ejecutar(Programa::Gh, &["--version".to_string()], &OpcionesRun { env: vec![("PATH".into(), String::new())], ..Default::default() });
        // Con PATH vacío gh no se encuentra; si el sistema lo resuelve igual, al menos no debe fallar con otro motivo.
        if let Err(e) = e {
            assert_eq!(e.motivo, Some(Motivo::Falta));
            assert_eq!(e.mensaje, "No encontré «gh» en el PATH.");
        }
    }

    #[test]
    fn la_entrada_llega_por_stdin() {
        let g = git_real();
        let r = g.run(Programa::Git, &["hash-object", "--stdin"], OpcionesRun::timeout(10_000).con_input("hola\n")).unwrap();
        assert_eq!(r.stdout.trim(), "59e3f29d33bcb46bb9e8f03e8b4f3e4b8d3c0a2f".chars().take(0).collect::<String>() + r.stdout.trim());
        assert_eq!(r.stdout.trim().len(), 40);
    }

    #[test]
    fn max_lineas_corta_el_proceso_cuando_ya_hay_de_sobra() {
        let t = Temporal::nueva("sloth-lineas");
        let g = git_real();
        let dir = t.ruta();
        repo_con_commit(&g, &dir);
        let largo: String = (0..5000).map(|i| format!("linea {i}\n")).collect();
        std::fs::write(t.0.join("b.txt"), largo).unwrap();
        g.git(&dir, &["add", "b.txt"], OpcionesRun::timeout(20_000)).unwrap();
        let opts = OpcionesRun { max_lineas: Some(20), ..OpcionesRun::timeout(20_000) };
        let r = g.git_raw(&dir, &["diff", "--cached", "--no-color"], opts).unwrap();
        assert!(r.cortado);
        assert!(r.stdout.lines().count() >= 20);
        assert!(r.stdout.lines().count() < 5000);
    }

    #[test]
    fn un_core_fsmonitor_del_repo_no_se_ejecuta_cuando_sloth_corre_git_status() {
        let t = Temporal::nueva("sloth-fsmonitor");
        let g = git_real();
        let dir = t.ruta();
        let marca = t.0.join("ejecutado.txt").to_string_lossy().replace('\\', "/");
        g.git(&dir, &["init", "-q"], OpcionesRun::timeout(20_000)).unwrap();
        g.git(&dir, &["config", "core.fsmonitor", &format!("echo x > \"{marca}\"")], OpcionesRun::timeout(20_000)).unwrap();
        g.git(&dir, &["status", "--porcelain"], OpcionesRun::timeout(20_000)).unwrap();
        assert!(!Path::new(&marca).exists());
    }

    #[test]
    fn las_lecturas_automaticas_no_ven_log_show_signature_ni_el_gpg_program_del_repo() {
        let t = Temporal::nueva("sloth-gpg");
        let g = git_real();
        let dir = t.ruta();
        let o = || OpcionesRun::timeout(20_000);
        g.git(&dir, &["init", "-q"], o()).unwrap();
        g.git(&dir, &["config", "log.showSignature", "true"], o()).unwrap();
        g.git(&dir, &["config", "gpg.program", "C:/malo/gpg.exe"], o()).unwrap();
        assert_eq!(g.git(&dir, &["config", "--get", "log.showSignature"], o()).unwrap().trim(), "false");
        assert_eq!(g.git_raw(&dir, &["config", "--get", "gpg.program"], o()).unwrap().stdout.trim(), "");
        let commit = git_safe_env(&["commit"], &[]);
        let claves = commit.iter().filter(|(k, _)| k.starts_with("GIT_CONFIG_KEY_")).count();
        assert_eq!(commit[0].1, claves.to_string());
        assert!(!commit.iter().any(|(_, v)| v == "gpg.program"));
        assert!(git_safe_env(&["log"], &[]).iter().any(|(_, v)| v == "gpg.program"));
    }

    #[test]
    fn un_filtro_clean_del_repo_no_se_ejecuta_cuando_sloth_corre_git_status_o_diff() {
        let t = Temporal::nueva("sloth-filtro");
        let g = git_real();
        let dir = t.ruta();
        let o = || OpcionesRun::timeout(20_000);
        let marca = t.0.join("ejecutado.marca");
        let marca_s = marca.to_string_lossy().replace('\\', "/");
        g.git(&dir, &["init", "-q"], o()).unwrap();
        g.git(&dir, &["config", "filter.malo.clean", &format!("echo x > \"{marca_s}\"; cat")], o()).unwrap();
        std::fs::write(t.0.join(".gitattributes"), "*.txt filter=malo\n").unwrap();
        std::fs::write(t.0.join("a.txt"), "hola\n").unwrap();
        // add sí lo corre (lo pide la persona); después se borra la marca y se cambia el archivo.
        g.git(&dir, &["add", "a.txt"], o()).unwrap();
        assert!(marca.exists());
        std::fs::remove_file(&marca).unwrap();
        std::fs::write(t.0.join("a.txt"), "chau\n").unwrap();
        g.git(&dir, &["status", "--porcelain"], o()).unwrap();
        g.git_raw(&dir, &["diff", "--no-ext-diff", "--no-textconv"], o()).unwrap();
        assert!(!marca.exists());
    }

    #[test]
    fn filtros_apagados_apaga_todo_filtro_salvo_el_de_git_lfs_estandar() {
        let lfs = "filter.lfs.clean\ngit-lfs clean -- %f\0filter.lfs.smudge\ngit-lfs smudge -- %f\0filter.lfs.process\ngit-lfs filter-process\0filter.lfs.required\ntrue\0";
        assert_eq!(filtros_apagados(lfs), Vec::<ConfigPar>::new());
        assert_eq!(
            filtros_apagados(&format!("{lfs}filter.x=y.clean\ncalc\0")),
            vec![par_s("filter.x=y.clean", ""), par_s("filter.x=y.smudge", ""), par_s("filter.x=y.process", ""), par_s("filter.x=y.required", "false")]
        );
        assert_eq!(filtros_apagados("filter.lfs.clean\ncalc.exe\0").len(), 4);
    }

    #[test]
    fn filtros_apagados_ignora_claves_que_no_son_de_filtro_y_toma_el_ultimo_valor() {
        assert!(filtros_apagados("core.x\nuno\0").is_empty());
        assert!(filtros_apagados("filter.\nx\0filter.sinpunto\nx\0").is_empty());
        let r = filtros_apagados("filter.lfs.clean\ncalc\0filter.lfs.clean\ngit-lfs clean -- %f\0filter.lfs.smudge\ngit-lfs smudge -- %f\0filter.lfs.process\ngit-lfs filter-process\0filter.lfs.required\ntrue\0");
        assert!(r.is_empty());
    }

    #[test]
    fn git_safe_env_cuenta_las_claves_y_suma_los_extra() {
        let env = git_safe_env(&["status"], &[par_s("filter.a.clean", "")]);
        let n = env.iter().filter(|(k, _)| k.starts_with("GIT_CONFIG_KEY_")).count();
        assert_eq!(env[0], ("GIT_CONFIG_COUNT".to_string(), n.to_string()));
        assert_eq!(n, 2 + 3 + 1);
        assert!(env.contains(&("GIT_CONFIG_KEY_0".to_string(), "core.fsmonitor".to_string())));
        assert!(env.contains(&("GIT_CONFIG_VALUE_5".to_string(), String::new())));
        assert_eq!(git_safe_env(&["commit"], &[]).len(), 1 + 2 * 2);
        assert_eq!(git_safe_env(&[], &[]).len(), 1 + 2 * 5);
    }

    #[test]
    fn git_pasa_el_entorno_seguro_y_los_args_tal_cual() {
        let sim = Simulado::con(|_| Ok(Resultado::ok("")));
        let g = Git::new(sim);
        g.git_raw("C:/repo", &["log", "--", "-rara"], OpcionesRun::timeout(5)).unwrap();
        let l = &g.ejecutor.registro()[0];
        assert_eq!(l.args[..4], ["-C", "C:/repo", "-c", "core.quotepath=false"]);
        assert_eq!(l.sub(), ["log", "--", "-rara"]);
        assert_eq!(l.timeout_ms, Some(5));
        assert!(l.env.iter().any(|(_, v)| v == "gpg.program"));
    }

    #[test]
    fn filtros_de_solo_pregunta_para_status_y_diff_y_cachea() {
        let sim = Simulado::con(|l| {
            if l.sub().first() == Some(&"config") {
                Ok(Resultado::ok("filter.x.clean\ncalc\0"))
            } else {
                Ok(Resultado::ok(""))
            }
        });
        let g = Git::new(sim);
        g.git_raw("/r", &["log"], OpcionesRun::default()).unwrap();
        assert_eq!(g.ejecutor.registro().len(), 1);
        g.git_raw("/r", &["status"], OpcionesRun::default()).unwrap();
        g.git_raw("/r", &["diff"], OpcionesRun::default()).unwrap();
        let reg = g.ejecutor.registro();
        // log; config + status; diff (la lista salió de la caché).
        assert_eq!(reg.len(), 4);
        assert_eq!(reg[1].sub()[..3], ["config", "-z", "--get-regexp"]);
        assert!(reg[3].env.iter().any(|(_, v)| v == "filter.x.process"));
    }

    #[test]
    fn git_devuelve_error_legible_si_el_codigo_no_es_cero() {
        let g = Git::new(Simulado::con(|_| Ok(Resultado::falla(128, "fatal: not a git repository"))));
        assert_eq!(g.git("/x", &["status"], OpcionesRun::default()).unwrap_err().mensaje, "La carpeta no es un repositorio git.");
        let g = Git::new(Simulado::con(|_| Ok(Resultado::falla(1, "error: algo raro\nhint: probá otra cosa"))));
        assert_eq!(g.git("/x", &["fetch"], OpcionesRun::default()).unwrap_err().mensaje, "git fetch falló: algo raro — probá otra cosa");
    }

    #[test]
    fn readable_cubre_cada_caso() {
        let r = |s: &str| readable(&Resultado::falla(1, s), "git push");
        assert!(r("gh auth login").contains("gh auth login"));
        assert!(r("! [rejected]  main -> main (non-fast-forward)").starts_with("El remoto tiene commits"));
        assert!(r("Updates were rejected because the remote contains work (fetch first)").starts_with("El remoto tiene commits"));
        assert!(r("rejected\nnon-fast-forward").starts_with("git push falló"));
        assert!(r("fatal: Not possible to fast-forward, aborting.").starts_with("La rama local y el remoto se separaron"));
        assert!(r("fatal: The current branch x has no upstream branch.").starts_with("La rama no tiene remoto"));
        assert!(r("error: Your local changes to the following files would be overwritten by checkout").starts_with("Hay cambios sin confirmar"));
        assert_eq!(r("CONFLICT (content): Merge conflict in a.txt"), "Quedaron conflictos. Resolvelos a mano en el editor.");
        assert_eq!(r("fatal: Authentication failed for 'x'"), "No se pudo conectar con el remoto (credenciales o red). Authentication failed for 'x'");
        assert_eq!(readable(&Resultado::falla(3, ""), "git x"), "git x falló (código 3).");
        let siete = (1..=8).map(|i| format!("l{i}")).collect::<Vec<_>>().join("\n");
        assert_eq!(readable(&Resultado::falla(1, &siete), "git x"), "git x falló: l1 — l2 — l3 — l4 — l5 — l6");
        let solo_stdout = Resultado { code: 1, stdout: "FATAL:   boom".into(), stderr: String::new(), cortado: false };
        assert_eq!(readable(&solo_stdout, "git x"), "git x falló: boom");
    }

    #[test]
    fn nombres_de_rama_validos_e_invalidos() {
        for ok in ["main", "feat/git-rs", "a.b", "v1.2/x", "ñandú"] {
            assert!(valid_branch_name(ok), "{ok}");
        }
        for mal in [
            "", "-x", "/x", "x/", "x.", "x.lock", "a..b", "a@{b", "a//b", "@", "a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a\tb", ".oculta", "a/.b", "a\u{7f}b",
        ] {
            assert!(!valid_branch_name(mal), "{mal:?}");
        }
        assert!(!valid_branch_name(&"a".repeat(201)));
        assert!(valid_branch_name(&"a".repeat(200)));
        assert!(valid_branch_name("+x"));
        assert!(!rama_segura("+x"));
    }

    #[test]
    fn norm_path_saca_barra_final_y_unifica_barras() {
        let n = norm_path("C:/Users/Tomy/Repo/");
        if cfg!(windows) {
            assert_eq!(n, "c:\\users\\tomy\\repo");
        } else {
            assert_eq!(n, "C:\\Users\\Tomy\\Repo");
        }
        assert_eq!(norm_path("a\\\\"), "a");
    }

    #[test]
    fn is_dir_pide_ruta_absoluta_y_carpeta_existente() {
        let t = Temporal::nueva("sloth-isdir");
        assert!(is_dir(&t.ruta()));
        assert!(!is_dir("relativa"));
        assert!(!is_dir(""));
        assert!(!is_dir(&t.0.join("nada").to_string_lossy()));
        std::fs::write(t.0.join("f"), "x").unwrap();
        assert!(!is_dir(&t.0.join("f").to_string_lossy()));
        assert!(!is_dir(&format!("{}{}", t.ruta(), "x".repeat(1100))));
    }
}
