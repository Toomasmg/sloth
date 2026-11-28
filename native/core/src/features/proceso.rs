//! Correr git y gh sin shell (lista de argumentos), ocultos en Windows y con timeout. Equivale a lo que usan
//! prs.ts y team-github.ts de `git-run.ts` y de su propio `exec`. Lo que decide qué correr queda en los módulos puros:
//! acá solo está el `Ejecutor` que se inyecta y su implementación real.
use regex::Regex;
use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Salida {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    /// El programa no existe en el PATH.
    pub falta: bool,
    pub vencio: bool,
}

impl Salida {
    pub fn ok(stdout: &str) -> Self {
        Salida { stdout: stdout.into(), ..Salida::default() }
    }

    pub fn error(code: i32, stderr: &str) -> Self {
        Salida { code, stderr: stderr.into(), ..Salida::default() }
    }
}

pub trait Ejecutor: Send + Sync {
    fn ejecutar(&self, cmd: &str, args: &[String], cwd: Option<&Path>, timeout: Duration) -> Salida;
}

const MAX_SALIDA: usize = 8 * 1024 * 1024;

/// Variables que se suman al entorno para que ni git ni gh pregunten nada.
pub fn entorno_sin_preguntas() -> BTreeMap<String, String> {
    let mut e = git_safe_env();
    for (k, v) in [("GIT_TERMINAL_PROMPT", "0"), ("GCM_INTERACTIVE", "never"), ("GH_PROMPT_DISABLED", "1"), ("GH_NO_UPDATE_NOTIFIER", "1"), ("NO_COLOR", "1")] {
        e.insert(k.into(), v.into());
    }
    e
}

/// Un repo ajeno puede traer `core.fsmonitor = <comando>` en su .git/config y git lo ejecuta en cualquier status; con
/// `log.showSignature` y un commit firmado correría el gpg.program del repo. La config por entorno pisa al .git/config.
pub fn git_safe_env() -> BTreeMap<String, String> {
    config_env(&[("core.fsmonitor", "false"), ("log.showSignature", "false")])
}

pub fn config_env(pares: &[(&str, &str)]) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    env.insert("GIT_CONFIG_COUNT".to_string(), pares.len().to_string());
    for (i, (k, v)) in pares.iter().enumerate() {
        env.insert(format!("GIT_CONFIG_KEY_{i}"), (*k).to_string());
        env.insert(format!("GIT_CONFIG_VALUE_{i}"), (*v).to_string());
    }
    env
}

pub struct Real;

fn leer_hilo<R: Read + Send + 'static>(mut r: R) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 8192];
        loop {
            match r.read(&mut tmp) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if buf.len() < MAX_SALIDA {
                        let resto = MAX_SALIDA - buf.len();
                        buf.extend_from_slice(&tmp[..n.min(resto)]);
                    }
                }
            }
        }
        buf
    })
}

impl Ejecutor for Real {
    fn ejecutar(&self, cmd: &str, args: &[String], cwd: Option<&Path>, timeout: Duration) -> Salida {
        let mut c = Command::new(cmd);
        c.args(args).envs(entorno_sin_preguntas()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(d) = cwd {
            c.current_dir(d);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW: sin consola que parpadee.
            c.creation_flags(0x0800_0000);
        }
        let mut hijo = match c.spawn() {
            Ok(h) => h,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Salida { code: -1, falta: true, ..Salida::default() },
            Err(e) => return Salida { code: -1, stderr: e.to_string(), ..Salida::default() },
        };
        let out = hijo.stdout.take().map(leer_hilo);
        let err = hijo.stderr.take().map(leer_hilo);
        let limite = Instant::now() + timeout;
        let mut vencio = false;
        let estado = loop {
            match hijo.try_wait() {
                Ok(Some(s)) => break Some(s),
                Ok(None) if Instant::now() >= limite => {
                    vencio = true;
                    let _ = hijo.kill();
                    break hijo.wait().ok();
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(15)),
                Err(_) => break None,
            }
        };
        let texto = |h: Option<std::thread::JoinHandle<Vec<u8>>>| h.and_then(|h| h.join().ok()).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
        Salida { code: estado.and_then(|s| s.code()).unwrap_or(-1), stdout: texto(out), stderr: texto(err), falta: false, vencio }
    }
}

fn re_prefijo() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)^(fatal|error|hint|remote):\s*").unwrap())
}

fn re(texto: &'static str, cache: &'static OnceLock<Regex>) -> &'static Regex {
    cache.get_or_init(|| Regex::new(texto).unwrap())
}

/// Mensaje legible a partir del stderr de git/gh.
pub fn legible(r: &Salida, que: &str) -> String {
    static A: OnceLock<Regex> = OnceLock::new();
    static B: OnceLock<Regex> = OnceLock::new();
    static C: OnceLock<Regex> = OnceLock::new();
    static D: OnceLock<Regex> = OnceLock::new();
    static E: OnceLock<Regex> = OnceLock::new();
    static F: OnceLock<Regex> = OnceLock::new();
    static G: OnceLock<Regex> = OnceLock::new();
    static H: OnceLock<Regex> = OnceLock::new();
    let crudo = if !r.stderr.is_empty() { &r.stderr } else { &r.stdout };
    let crudo = crudo.trim();
    let lineas: Vec<String> =
        crudo.split('\n').map(|l| l.trim_end_matches('\r')).map(|l| re_prefijo().replace(l, "").trim().to_string()).filter(|l| !l.is_empty()).collect();
    let texto = lineas.iter().take(6).cloned().collect::<Vec<_>>().join(" — ");
    if re(r"(?i)not a git repository", &A).is_match(crudo) {
        return "La carpeta no es un repositorio git.".into();
    }
    if re(r"(?i)gh auth login|not logged into", &B).is_match(crudo) {
        return "gh no tiene sesión iniciada: corré «gh auth login».".into();
    }
    if re(r"(?i)rejected.*non-fast-forward|fetch first", &C).is_match(crudo) {
        return "El remoto tiene commits que no tenés (push rechazado). Traelos con pull/rebase antes de pushear; nunca se fuerza.".into();
    }
    if re(r"(?i)Not possible to fast-forward|divergent branches|Diverging branches", &D).is_match(crudo) {
        return "La rama local y el remoto se separaron: no se puede traer sin combinar. Resolvelo a mano (merge o rebase); Sloth nunca fuerza nada.".into();
    }
    if re(r"(?i)There is no tracking information|no upstream branch", &E).is_match(crudo) {
        return "La rama no tiene remoto asociado. Subila primero con «Subir».".into();
    }
    if re(r"(?i)Your local changes to the following files would be overwritten|would be overwritten by", &F).is_match(crudo) {
        return "Hay cambios sin confirmar que chocan con la otra rama. Confirmalos o guardalos en stash antes de cambiar.".into();
    }
    if re(r"(?i)CONFLICT|Automatic merge failed", &G).is_match(crudo) {
        return "Quedaron conflictos. Resolvelos a mano en el editor.".into();
    }
    if re(r"(?i)Could not read from remote|Authentication failed|Permission denied \(publickey\)", &H).is_match(crudo) {
        return format!("No se pudo conectar con el remoto (credenciales o red). {texto}");
    }
    let detalle = if texto.is_empty() { format!(" (código {}).", r.code) } else { format!(": {texto}") };
    format!("{que} falló{detalle}")
}

/// Nombre de rama válido según git (sin correr git: las reglas de check-ref-format más comunes).
pub fn nombre_de_rama_valido(b: &str) -> bool {
    if b.is_empty() || b.chars().count() > 200 {
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

/// Normaliza una ruta para comparar: barras `\`, sin barra final y, en Windows, sin mayúsculas.
pub fn normalizar_ruta(p: &str) -> String {
    let s = p.replace('/', "\\");
    let s = s.trim_end_matches('\\').to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_entorno_seguro_apaga_fsmonitor_y_firmas() {
        let e = git_safe_env();
        assert_eq!(e["GIT_CONFIG_COUNT"], "2");
        assert_eq!((e["GIT_CONFIG_KEY_0"].as_str(), e["GIT_CONFIG_VALUE_0"].as_str()), ("core.fsmonitor", "false"));
        assert_eq!((e["GIT_CONFIG_KEY_1"].as_str(), e["GIT_CONFIG_VALUE_1"].as_str()), ("log.showSignature", "false"));
        let s = entorno_sin_preguntas();
        assert_eq!(s["GIT_TERMINAL_PROMPT"], "0");
        assert_eq!(s["GH_PROMPT_DISABLED"], "1");
    }

    #[test]
    fn un_programa_que_no_existe_se_marca_como_faltante() {
        let r = Real.ejecutar("sloth-programa-que-no-existe-xyz", &[], None, Duration::from_secs(2));
        assert!(r.falta);
        assert_eq!(r.code, -1);
    }

    #[test]
    fn legible_reconoce_los_casos_conocidos() {
        let r = |s: &str| Salida::error(1, s);
        assert_eq!(legible(&r("fatal: not a git repository"), "git status"), "La carpeta no es un repositorio git.");
        assert!(legible(&r("To login run: gh auth login"), "gh").contains("gh auth login"));
        assert!(legible(&r("! [rejected] a -> a (non-fast-forward)"), "git push").contains("push rechazado"));
        assert!(legible(&r("CONFLICT (content): x"), "git merge").contains("conflictos"));
        assert!(legible(&r("fatal: Authentication failed for x"), "git fetch").starts_with("No se pudo conectar con el remoto"));
    }

    #[test]
    fn legible_arma_el_mensaje_generico_sin_prefijos_y_con_tope_de_lineas() {
        assert_eq!(legible(&Salida::error(2, "error: uno\nhint: dos\n\nremote: tres"), "git fetch"), "git fetch falló: uno — dos — tres");
        assert_eq!(legible(&Salida::error(3, ""), "gh pr merge"), "gh pr merge falló (código 3).");
        let muchas = (1..=9).map(|i| format!("l{i}")).collect::<Vec<_>>().join("\n");
        assert_eq!(legible(&Salida::error(1, &muchas), "x"), "x falló: l1 — l2 — l3 — l4 — l5 — l6");
        assert_eq!(legible(&Salida { stdout: "solo stdout".into(), code: 1, ..Salida::default() }, "x"), "x falló: solo stdout");
    }

    #[test]
    fn nombres_de_rama() {
        for b in ["fix/algo", "pr-7", "a.b", "feat/x_y"] {
            assert!(nombre_de_rama_valido(b), "{b}");
        }
        for b in ["", "-x", "/x", "x/", "x.", "x.lock", "a..b", "a@{b", "a//b", "@", "a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a/.b", ".a"] {
            assert!(!nombre_de_rama_valido(b), "{b:?}");
        }
        assert!(!nombre_de_rama_valido(&"a".repeat(201)));
    }

    #[test]
    fn normalizar_ruta_unifica_barras_y_saca_la_final() {
        let a = normalizar_ruta("C:/Repos/App/");
        let b = normalizar_ruta("C:\\Repos\\App");
        assert_eq!(a, b);
        assert!(!a.ends_with('\\'));
    }
}
