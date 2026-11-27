//! Envoltorio de la statusline de cada cuenta. Equivale a STATUSLINE_SCRIPT (src/main/statusline-core.ts): Claude Code le
//! pasa un JSON con `rate_limits` (el % real de los límites de 5 h y semanal); se guarda en la carpeta de la cuenta y
//! después se corre la statusline de siempre con la misma entrada, así lo que se ve abajo de Claude no cambia.
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

pub const LIMITES_ARCHIVO: &str = "sloth-limites.json";

/// `{fiveHour, sevenDay, at}` si la entrada trae límites; None si no hay ninguno.
pub fn limites_de(crudo: &str, ahora_ms: u128) -> Option<Value> {
    let entrada: Value = serde_json::from_str(crudo).ok()?;
    let r = entrada.get("rate_limits").filter(|r| r.is_object())?;
    let pick = |k: &str| -> Value {
        match r.get(k) {
            Some(w) if w.get("used_percentage").is_some_and(Value::is_number) => {
                json!({ "pct": w["used_percentage"], "resetsAt": w.get("resets_at").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null) })
            }
            _ => Value::Null,
        }
    };
    let (cinco, siete) = (pick("five_hour"), pick("seven_day"));
    if cinco.is_null() && siete.is_null() {
        return None;
    }
    Some(json!({ "fiveHour": cinco, "sevenDay": siete, "at": ahora_ms as u64 }))
}

fn guardar(dir: &Path, v: &Value) -> std::io::Result<()> {
    let archivo = dir.join(LIMITES_ARCHIVO);
    let tmp = dir.join(format!("{LIMITES_ARCHIVO}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, v.to_string())?;
    std::fs::rename(&tmp, archivo)
}

/// El comando original viene en base64url, sin comillas ni signos que Git Bash o PowerShell interpreten.
pub fn decodificar_comando(arg: &str) -> String {
    URL_SAFE_NO_PAD.decode(arg.trim_end_matches('=')).ok().and_then(|b| String::from_utf8(b).ok()).unwrap_or_default()
}

pub struct Shell {
    pub programa: String,
    pub args: Vec<String>,
}

/// Con Git Bash (MSYSTEM y EXEPATH) se corre en su bash y no en el de WSL de System32; sin MSYSTEM en Windows el shell
/// de Claude fue PowerShell.
pub fn shell_para(cmd: &str, msystem: bool, exepath: Option<&str>, shell: Option<&str>, windows: bool, existe: &dyn Fn(&Path) -> bool) -> Shell {
    if msystem || !windows {
        let bash = match exepath {
            Some(e) if existe(&Path::new(e).join("bash.exe")) => Path::new(e).join("bash.exe").display().to_string(),
            _ => shell.map(str::to_owned).unwrap_or_else(|| if windows { "bash".into() } else { "/bin/sh".into() }),
        };
        return Shell { programa: bash, args: vec!["-c".into(), cmd.into()] };
    }
    Shell {
        programa: "powershell.exe".into(),
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"].iter().map(|s| s.to_string()).chain([cmd.to_string()]).collect(),
    }
}

pub fn run(original: Option<&str>) {
    let mut crudo = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut crudo);
    let texto = String::from_utf8_lossy(&crudo).into_owned();
    if let (Some(dir), true) = (std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()), std::env::var_os("SLOTH_WS").is_some_and(|v| !v.is_empty())) {
        let ahora = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        if let Some(v) = limites_de(&texto, ahora) {
            let _ = guardar(&PathBuf::from(dir), &v);
        }
    }
    let cmd = decodificar_comando(original.unwrap_or(""));
    if cmd.is_empty() {
        return;
    }
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let sh = shell_para(&cmd, std::env::var_os("MSYSTEM").is_some_and(|v| !v.is_empty()), env("EXEPATH").as_deref(), env("SHELL").as_deref(), cfg!(windows), &|p| p.exists());
    let mut c = Command::new(&sh.programa);
    c.args(&sh.args).stdin(Stdio::piped()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let Ok(mut hijo) = c.spawn() else { return };
    if let Some(mut stdin) = hijo.stdin.take() {
        let _ = stdin.write_all(&crudo);
    }
    let codigo = hijo.wait().ok().and_then(|s| s.code()).unwrap_or(0);
    std::process::exit(codigo);
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENTRADA: &str = "{\"model\":{\"display_name\":\"Opus\"},\"rate_limits\":{\"five_hour\":{\"used_percentage\":72.5,\"resets_at\":1894000000}}}";

    #[test]
    fn guarda_solo_lo_que_tiene() {
        let v = limites_de(ENTRADA, 123).unwrap();
        assert_eq!(v, json!({ "fiveHour": { "pct": 72.5, "resetsAt": 1894000000 }, "sevenDay": null, "at": 123 }));
        assert!(limites_de("{\"rate_limits\":{}}", 1).is_none());
        assert!(limites_de("{\"rate_limits\":{\"five_hour\":{\"used_percentage\":\"x\"}}}", 1).is_none());
        assert!(limites_de("{\"model\":1}", 1).is_none());
        assert!(limites_de("no es json", 1).is_none());
        let sin_reset = limites_de("{\"rate_limits\":{\"seven_day\":{\"used_percentage\":3}}}", 1).unwrap();
        assert_eq!(sin_reset["sevenDay"], json!({ "pct": 3, "resetsAt": null }));
    }

    #[test]
    fn decodifica_el_comando_original() {
        let c = "bash ~/.claude/statusline-command.sh";
        assert_eq!(decodificar_comando(&URL_SAFE_NO_PAD.encode(c)), c);
        assert_eq!(decodificar_comando(&format!("{}==", URL_SAFE_NO_PAD.encode(c))), c);
        assert_eq!(decodificar_comando(""), "");
        assert_eq!(decodificar_comando("%%%"), "");
    }

    #[test]
    fn elige_el_shell_como_el_script_de_node() {
        let existe = |p: &Path| p.ends_with("bash.exe");
        let git = shell_para("x", true, Some("C:\\Git\\bin"), None, true, &existe);
        assert!(git.programa.ends_with("bash.exe") && git.programa.contains("Git"));
        assert_eq!(git.args, ["-c", "x"]);
        let sin_exe = shell_para("x", true, Some("C:\\Git\\bin"), Some("/usr/bin/zsh"), true, &|_| false);
        assert_eq!(sin_exe.programa, "/usr/bin/zsh");
        assert_eq!(shell_para("x", true, None, None, true, &existe).programa, "bash");
        assert_eq!(shell_para("x", false, None, None, false, &existe).programa, "/bin/sh");
        let ps = shell_para("Write-Output hola", false, None, None, true, &existe);
        assert_eq!(ps.programa, "powershell.exe");
        assert_eq!(ps.args.last().unwrap(), "Write-Output hola");
        assert!(ps.args.contains(&"Bypass".to_string()));
    }
}
