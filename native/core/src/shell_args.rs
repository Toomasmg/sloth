//! Cómo se le pasa a cada shell el comando inicial de Claude (o de Codex y Copilot). Equivale a src/main/shell-args.ts.
//! Es lo que decide qué texto llega a la línea de la shell: el primer mensaje nunca va escrito ahí.
use crate::initial_prompt::podria_ser_subcomando;
use base64::Engine;
use std::collections::BTreeMap;

/// Familia de sintaxis de la shell: cambia cómo se pasa el comando inicial.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FamiliaShell {
    Ps,
    Cmd,
    Posix,
}

pub const PROMPT_VAR: &str = "SLOTH_PROMPT";
pub const PASTE_START: &str = "\u{1b}[200~";
pub const PASTE_END: &str = "\u{1b}[201~";
const CMD_NO_CWD: &str = "NoDefaultCurrentDirectoryInExePath";

/// Argumentos que no necesitan comillas en ninguna de las shells.
fn simple(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "_-./:=\\".contains(c))
}

/// PowerShell cierra un string de comilla simple también con las tipográficas (‘ ’ ‚ ‛): se duplican todas.
pub fn ps_arg(s: &str) -> String {
    if simple(s) {
        return s.to_string();
    }
    let dentro: String = s.chars().flat_map(|c| if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201a}' | '\u{201b}') { vec![c, c] } else { vec![c] }).collect();
    format!("'{dentro}'")
}

/// En bash la barra invertida sin comillas es un escape: una ruta de Windows va siempre entre comillas.
pub fn posix_arg(s: &str) -> String {
    if simple(s) && !s.contains('\\') {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// cmd no tiene escape confiable: se quitan las comillas y los caracteres especiales del prompt.
pub fn cmd_arg(s: &str) -> String {
    if simple(s) {
        s.to_string()
    } else {
        format!("\"{}\"", s.chars().filter(|c| !"\"&|<>^%!()".contains(*c)).collect::<String>())
    }
}

fn es_control(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}')
}

/// El primer mensaje en una sola línea y sin caracteres de control (un ESC cortaría el pegado).
pub fn prompt_line(s: &str) -> String {
    let mut salida = String::new();
    let mut en_control = false;
    for c in s.chars() {
        if es_control(c) {
            if !en_control {
                salida.push(' ');
            }
            en_control = true;
        } else {
            salida.push(c);
            en_control = false;
        }
    }
    salida
}

/// argv de Claude con un prompt inicial. El prompt va después de «--» para que uno que empiece con guion no se lea como opción.
pub fn claude_with_prompt(prompt: &str) -> Vec<String> {
    vec!["claude".into(), "--".into(), prompt_line(prompt)]
}

/// Argumentos de la shell: solo la shell, o la shell corriendo el comando de Claude y quedándose abierta.
pub fn shell_args(familia: FamiliaShell, claude: Option<&[String]>) -> Vec<String> {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    let Some(claude) = claude.filter(|c| !c.is_empty()) else {
        return match familia {
            FamiliaShell::Ps => s(&["-NoLogo"]),
            FamiliaShell::Posix => s(&["--login", "-i"]),
            FamiliaShell::Cmd => vec![],
        };
    };
    match familia {
        FamiliaShell::Ps => vec!["-NoLogo".into(), "-NoExit".into(), "-Command".into(), claude.iter().map(|a| ps_arg(a)).collect::<Vec<_>>().join(" ")],
        FamiliaShell::Cmd => vec!["/k".into(), claude.iter().map(|a| cmd_arg(a)).collect::<Vec<_>>().join(" ")],
        FamiliaShell::Posix => vec!["--login".into(), "-i".into(), "-c".into(), format!("{}; exec bash --login -i", claude.iter().map(|a| posix_arg(a)).collect::<Vec<_>>().join(" "))],
    }
}

#[derive(Debug, PartialEq, Default)]
pub struct ShellLaunch {
    pub args: Vec<String>,
    /// Variables que se suman al entorno de la terminal.
    pub env: BTreeMap<String, String>,
    /// Texto que hay que pegar en Claude cuando arranque (cuando no se pudo pasar como argumento).
    pub paste: Option<String>,
}

/// En cmd la ruta de claude.exe va sin comillas: el pty escapa las comillas con \" y cmd no lo entiende.
fn cmd_plain(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "_-.:\\@".contains(c))
}

/// Un .cmd corre por cmd.exe: la ruta no puede traer nada que cmd lea como sintaxis.
fn cmd_shim_seguro(s: &str) -> bool {
    s.len() > 4 && s[s.len() - 4..].eq_ignore_ascii_case(".cmd") && !s[..s.len() - 4].is_empty() && !s.chars().any(|c| "%&^!\"<>|\r\n".contains(c))
}

/// Contenido de un argumento entre comillas según las reglas de CommandLineToArgvW.
pub fn windows_arg_body(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut salida = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] == '\\' {
            let mut n = 0;
            while i < c.len() && c[i] == '\\' {
                n += 1;
                i += 1;
            }
            match c.get(i) {
                Some('"') => {
                    salida.push_str(&"\\".repeat(n * 2));
                    salida.push_str("\\\"");
                    i += 1;
                }
                None => salida.push_str(&"\\".repeat(n * 2)),
                _ => salida.push_str(&"\\".repeat(n)),
            }
        } else if c[i] == '"' {
            salida.push_str("\\\"");
            i += 1;
        } else {
            salida.push(c[i]);
            i += 1;
        }
    }
    salida
}

/// Un script de PowerShell como -EncodedCommand: nunca se vuelve a parsear como línea de comandos.
pub fn ps_encoded(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Valor de SLOTH_PROMPT para PowerShell: ya entre comillas, así el modo Legacy lo pasa sin tocarlo.
pub fn ps_prompt_value(prompt: &str) -> String {
    format!("\"{}\"", windows_arg_body(prompt))
}

pub fn paste_payload(text: &str) -> String {
    format!("{PASTE_START}{}{PASTE_END}", prompt_line(text))
}

/// Separa el primer mensaje que armó `claude_with_prompt` (el único operando después de «--»).
fn split_prompt(claude: &[String]) -> (Vec<String>, Option<String>) {
    match claude.iter().position(|a| a == "--") {
        Some(i) if i >= 1 && i == claude.len() - 2 => (claude[..i].to_vec(), Some(prompt_line(&claude[i + 1]))),
        _ => (claude.to_vec(), None),
    }
}

/// Lo que se le pasa a la shell para correr Claude y quedarse abierta. El primer mensaje va por SLOTH_PROMPT, que la shell
/// expande como un solo argumento después de `--`. Eso solo es seguro lanzando claude.exe directo: un claude.cmd pasaría
/// otra vez por cmd. En cmd, sin claude.exe o si el mensaje podría tomarse como subcomando, se pega en Claude cuando arranca.
pub fn shell_launch(familia: FamiliaShell, claude: Option<&[String]>, claude_exe: Option<&str>) -> ShellLaunch {
    let Some(claude) = claude.filter(|c| !c.is_empty()) else { return ShellLaunch { args: shell_args(familia, None), ..Default::default() } };
    let (argv0, prompt) = split_prompt(claude);
    let mut exe = claude_exe.filter(|e| e.len() >= 4 && e[e.len() - 4..].eq_ignore_ascii_case(".exe"));
    if familia == FamiliaShell::Cmd && exe.is_some_and(|e| !cmd_plain(e)) {
        exe = None;
    }
    let agente = argv0[0].as_str();
    let es_agente = matches!(agente, "claude" | "codex" | "copilot");
    // En PowerShell, `codex` a secas puede resolver a codex.ps1, que la política de ejecución suele bloquear: con codex.cmd se llama por ruta.
    let shim = claude_exe.filter(|e| familia == FamiliaShell::Ps && matches!(agente, "codex" | "copilot") && cmd_shim_seguro(e));
    let argv: Vec<String> = match (exe, shim) {
        (Some(e), _) if es_agente => std::iter::once(e.to_string()).chain(argv0[1..].iter().cloned()).collect(),
        (_, Some(s)) => std::iter::once(s.to_string()).chain(argv0[1..].iter().cloned()).collect(),
        _ => argv0.clone(),
    };
    // Con Copilot el primer mensaje nunca va por SLOTH_PROMPT ni por argv: que `--` separe operandos no está confirmado.
    let via_env = prompt.as_deref().is_some_and(|p| exe.is_some() && familia != FamiliaShell::Cmd && agente != "copilot" && !podria_ser_subcomando(p, agente));
    let paste = if via_env { None } else { prompt.clone() };
    let mut env = BTreeMap::new();
    match familia {
        FamiliaShell::Ps => {
            let head = format!("& {}", argv.iter().map(|a| ps_arg(a)).collect::<Vec<_>>().join(" "));
            if !via_env {
                return ShellLaunch { args: vec!["-NoLogo".into(), "-NoExit".into(), "-EncodedCommand".into(), ps_encoded(&head)], env, paste };
            }
            // PowerShell 7.3+ en modo Windows vuelve a entrecomillar a su manera; Legacy (el de 5.1) pasa tal cual un valor que
            // ya viene entre comillas. El bloque { } deja la variable solo para esta línea.
            let script = format!("& {{ $PSNativeCommandArgumentPassing = 'Legacy'; $p = $env:{PROMPT_VAR}; Remove-Item Env:{PROMPT_VAR} -ErrorAction Ignore; {head} -- $p }}");
            env.insert(PROMPT_VAR.into(), ps_prompt_value(prompt.as_deref().unwrap_or_default()));
            ShellLaunch { args: vec!["-NoLogo".into(), "-NoExit".into(), "-EncodedCommand".into(), ps_encoded(&script)], env, paste: None }
        }
        FamiliaShell::Cmd => {
            let linea = argv.iter().enumerate().map(|(i, a)| if i == 0 && Some(a.as_str()) == exe { a.clone() } else { cmd_arg(a) }).collect::<Vec<_>>().join(" ");
            if exe.is_some() {
                return ShellLaunch { args: vec!["/k".into(), linea], env, paste };
            }
            // Sin ruta, cmd buscaría `claude` primero en la carpeta del repo. Solo esta línea deja de mirar ahí: en todo el
            // entorno rompería los .bat locales (gradlew, mvnw) que corren los scripts de npm.
            ShellLaunch { args: vec!["/k".into(), format!("set {CMD_NO_CWD}=1& {linea}& set {CMD_NO_CWD}=")], env, paste }
        }
        FamiliaShell::Posix => {
            // MSYS convierte en ruta de Windows todo argumento que parezca una ruta POSIX («/ticket X»).
            let head = format!("MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' {}", argv.iter().map(|a| posix_arg(a)).collect::<Vec<_>>().join(" "));
            if !via_env {
                return ShellLaunch { args: vec!["--login".into(), "-i".into(), "-c".into(), format!("{head}; exec bash --login -i")], env, paste };
            }
            let cmd = format!("p=${PROMPT_VAR}; unset {PROMPT_VAR}; {head} -- \"$p\"; unset p; exec bash --login -i");
            env.insert(PROMPT_VAR.into(), prompt.unwrap_or_default());
            ShellLaunch { args: vec!["--login".into(), "-i".into(), "-c".into(), cmd], env, paste: None }
        }
    }
}

#[cfg(test)]
mod tests;
