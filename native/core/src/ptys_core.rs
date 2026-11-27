//! Lo que se le manda al daemon para abrir una terminal, sin tocar el sistema: qué shell corre, con qué argumentos y qué
//! entorno. Equivale a src/main/ptys.ts y src/main/env-limpio.ts; las sesiones en sí viven en el daemon.
use crate::daemon_protocolo::SpawnSpec;
use crate::shell_args::{shell_launch, FamiliaShell};
use std::collections::BTreeMap;

pub const GIT_BASH_PATHS: [&str; 1] = ["C:\\Program Files\\Git\\bin\\bash.exe"];

#[derive(Debug, Clone, Default)]
pub struct PtySpec {
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    /// argv de Claude que la shell corre al abrirse (p. ej. ["claude", "--continue"]). Sin valor = solo la shell.
    pub claude: Option<Vec<String>>,
    /// Ruta absoluta de claude.exe, si se encontró: así la shell no busca `claude` en la carpeta del repo.
    pub claude_exe: Option<String>,
}

/// Qué hay instalado: lo averigua quien llama (ver `detectar_shells`), así la elección se prueba sin tocar el disco.
#[derive(Debug, Clone, Default)]
pub struct ShellsDisponibles {
    pub pwsh: bool,
    pub git_bash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellElegida {
    pub file: String,
    pub familia: FamiliaShell,
}

/// Ejecutable de la shell elegida en Configuración › Terminal. Si no está instalada (pwsh o Git Bash), cae a PowerShell:
/// primero PowerShell 7 si existe, si no Windows PowerShell.
pub fn resolver_shell(eleccion: &str, disponibles: &ShellsDisponibles) -> ShellElegida {
    let propia = |file: &str, familia| ShellElegida { file: file.to_string(), familia };
    match eleccion {
        "Windows PowerShell" => return propia("powershell.exe", FamiliaShell::Ps),
        "Símbolo del sistema" => return propia("cmd.exe", FamiliaShell::Cmd),
        "Git Bash" => {
            if let Some(bash) = &disponibles.git_bash {
                return propia(bash, FamiliaShell::Posix);
            }
        }
        _ => {}
    }
    if disponibles.pwsh {
        propia("pwsh.exe", FamiliaShell::Ps)
    } else {
        propia("powershell.exe", FamiliaShell::Ps)
    }
}

/// Mira el sistema una vez: `where pwsh` y las rutas conocidas de Git Bash.
pub fn detectar_shells() -> ShellsDisponibles {
    let mut donde = std::process::Command::new("where");
    donde.arg("pwsh").stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        donde.creation_flags(0x0800_0000);
    }
    let pwsh = donde.status().map(|s| s.success()).unwrap_or(false);
    let git_bash = GIT_BASH_PATHS.iter().find(|p| std::path::Path::new(p).exists()).map(|p| p.to_string());
    ShellsDisponibles { pwsh, git_bash }
}

/// Entorno limpio para cada terminal: se quitan las variables que harían que el agente use otra cuenta (API keys) o crea
/// que corre anidado dentro de otra sesión suya, y las propias de Sloth. Conserva el orden de origen. `quitar_del_agente`
/// recibe el nombre en mayúsculas.
pub fn entorno_limpio<I>(origen: I, quitar_del_agente: &dyn Fn(&str) -> bool) -> Vec<(String, String)>
where
    I: IntoIterator<Item = (String, String)>,
{
    let mut env: Vec<(String, String)> = Vec::new();
    for (k, v) in origen {
        let key = k.to_uppercase();
        if quitar_del_agente(&key) || key.starts_with("ELECTRON_") || key.starts_with("ANTIREA_") || key.starts_with("SLOTH_") {
            continue;
        }
        env.push((k, v));
    }
    match env.iter_mut().find(|(k, _)| k == "TERM_PROGRAM") {
        Some(par) => par.1 = "Sloth".to_string(),
        None => env.push(("TERM_PROGRAM".to_string(), "Sloth".to_string())),
    }
    env
}

/// Entorno con el que se lanza el daemon: el de la app sin lo que pertenece a Electron o a Sloth.
pub fn entorno_del_daemon<I>(origen: I) -> Vec<(String, String)>
where
    I: IntoIterator<Item = (String, String)>,
{
    origen
        .into_iter()
        .filter(|(k, _)| {
            let k = k.to_uppercase();
            !(k.starts_with("ELECTRON_") || k == "NODE_OPTIONS" || k.starts_with("SLOTH_") || k.starts_with("ANTIREA_"))
        })
        .collect()
}

/// Lo que se le manda a `start`. La shell elegida solo afecta terminales nuevas: las vivas no se tocan. `paste` es el texto
/// que hay que pegar en el agente cuando arranque, si no se pudo pasar como argumento.
pub fn a_spawn_spec(spec: &PtySpec, cols: u32, rows: u32, shell: &ShellElegida) -> (SpawnSpec, Option<String>) {
    let launch = shell_launch(shell.familia, spec.claude.as_deref(), spec.claude_exe.as_deref());
    let mut env = spec.env.clone();
    env.extend(launch.env);
    (SpawnSpec { file: shell.file.clone(), args: launch.args, cwd: spec.cwd.clone(), env, cols, rows }, launch.paste)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn par(k: &str, v: &str) -> (String, String) {
        (k.to_string(), v.to_string())
    }

    fn quitar_claude(key: &str) -> bool {
        key == "CLAUDECODE" || key.starts_with("CLAUDE_CODE_") || key == "CLAUDE_CONFIG_DIR" || key == "ANTHROPIC_API_KEY" || key == "ANTHROPIC_AUTH_TOKEN"
    }

    fn origen() -> Vec<(String, String)> {
        vec![
            par("PATH", "C:\\bin"),
            par("Path", "C:\\otro"),
            par("CLAUDECODE", "1"),
            par("claudecode", "1"),
            par("CLAUDE_CODE_ENTRYPOINT", "cli"),
            par("claude_code_x", "x"),
            par("CLAUDE_CONFIG_DIR", "C:\\viejo"),
            par("Claude_Config_Dir", "C:\\viejo2"),
            par("ANTHROPIC_API_KEY", "k"),
            par("anthropic_auth_token", "t"),
            par("ANTHROPIC_BASE_URL", "https://x"),
            par("CLAUDE", "no"),
            par("ELECTRON_RUN_AS_NODE", "1"),
            par("ANTIREA_X", "1"),
            par("SLOTH_USER_DATA", "C:\\d"),
            par("sloth_ws", "w"),
            par("TERM_PROGRAM", "otra"),
            par("VACIA", ""),
        ]
    }

    #[test]
    fn entorno_limpio_con_el_proveedor_claude_da_lo_mismo_que_la_regla_de_antes_con_el_mismo_orden() {
        let ahora = entorno_limpio(origen(), &quitar_claude);
        let antes: Vec<(String, String)> = vec![
            par("PATH", "C:\\bin"),
            par("Path", "C:\\otro"),
            par("ANTHROPIC_BASE_URL", "https://x"),
            par("CLAUDE", "no"),
            par("TERM_PROGRAM", "Sloth"),
            par("VACIA", ""),
        ];
        let mut ordenado = ahora.clone();
        ordenado.sort();
        let mut esperado = antes.clone();
        esperado.sort();
        assert_eq!(ordenado, esperado);
        let claves: Vec<&str> = ahora.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(claves, vec!["PATH", "Path", "ANTHROPIC_BASE_URL", "CLAUDE", "TERM_PROGRAM", "VACIA"]);
    }

    #[test]
    fn entorno_limpio_deja_lo_que_no_es_del_agente_y_siempre_pone_term_program() {
        let e: BTreeMap<String, String> = entorno_limpio(origen(), &quitar_claude).into_iter().collect();
        assert_eq!(e["PATH"], "C:\\bin");
        assert_eq!(e["ANTHROPIC_BASE_URL"], "https://x");
        assert_eq!(e["CLAUDE"], "no");
        assert_eq!(e["VACIA"], "");
        assert_eq!(e["TERM_PROGRAM"], "Sloth");
        for k in ["CLAUDECODE", "claudecode", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CONFIG_DIR", "Claude_Config_Dir", "ANTHROPIC_API_KEY", "ELECTRON_RUN_AS_NODE", "SLOTH_USER_DATA"] {
            assert!(!e.contains_key(k), "{k}");
        }
    }

    #[test]
    fn entorno_limpio_agrega_term_program_si_no_estaba() {
        let e = entorno_limpio(vec![par("PATH", "x")], &|_| false);
        assert_eq!(e, vec![par("PATH", "x"), par("TERM_PROGRAM", "Sloth")]);
    }

    #[test]
    fn entorno_del_daemon_saca_electron_node_options_sloth_y_antirea() {
        let e = entorno_del_daemon(vec![
            par("PATH", "x"),
            par("electron_run_as_node", "1"),
            par("NODE_OPTIONS", "--inspect"),
            par("Node_Options", "y"),
            par("SLOTH_INPROCESS", "1"),
            par("ANTIREA_X", "1"),
            par("ANTHROPIC_API_KEY", "k"),
        ]);
        assert_eq!(e, vec![par("PATH", "x"), par("ANTHROPIC_API_KEY", "k")]);
    }

    fn con_todo() -> ShellsDisponibles {
        ShellsDisponibles { pwsh: true, git_bash: Some("C:\\Program Files\\Git\\bin\\bash.exe".into()) }
    }

    #[test]
    fn resolver_shell_respeta_la_eleccion() {
        let d = con_todo();
        assert_eq!(resolver_shell("Windows PowerShell", &d), ShellElegida { file: "powershell.exe".into(), familia: FamiliaShell::Ps });
        assert_eq!(resolver_shell("Símbolo del sistema", &d), ShellElegida { file: "cmd.exe".into(), familia: FamiliaShell::Cmd });
        assert_eq!(resolver_shell("Git Bash", &d), ShellElegida { file: "C:\\Program Files\\Git\\bin\\bash.exe".into(), familia: FamiliaShell::Posix });
        assert_eq!(resolver_shell("PowerShell 7", &d), ShellElegida { file: "pwsh.exe".into(), familia: FamiliaShell::Ps });
    }

    #[test]
    fn resolver_shell_sin_lo_instalado_cae_a_powershell() {
        let sin_git = ShellsDisponibles { pwsh: true, git_bash: None };
        assert_eq!(resolver_shell("Git Bash", &sin_git).file, "pwsh.exe");
        let nada = ShellsDisponibles::default();
        assert_eq!(resolver_shell("Git Bash", &nada), ShellElegida { file: "powershell.exe".into(), familia: FamiliaShell::Ps });
        assert_eq!(resolver_shell("PowerShell 7", &nada).file, "powershell.exe");
        assert_eq!(resolver_shell("algo raro", &nada).file, "powershell.exe");
    }

    #[test]
    fn spawn_spec_sin_agente_es_solo_la_shell() {
        let shell = resolver_shell("Windows PowerShell", &con_todo());
        let spec = PtySpec { cwd: "C:\\repo".into(), env: BTreeMap::from([("A".to_string(), "1".to_string())]), ..Default::default() };
        let (s, paste) = a_spawn_spec(&spec, 120, 30, &shell);
        assert_eq!((s.file.as_str(), s.cwd.as_str(), s.cols, s.rows), ("powershell.exe", "C:\\repo", 120, 30));
        assert_eq!(s.args, shell_launch(FamiliaShell::Ps, None, None).args);
        assert_eq!(s.env, BTreeMap::from([("A".to_string(), "1".to_string())]));
        assert_eq!(paste, None);
    }

    #[test]
    fn spawn_spec_con_agente_suma_el_entorno_del_lanzamiento_y_el_pegado() {
        let shell = resolver_shell("Símbolo del sistema", &con_todo());
        let claude = vec!["claude".to_string(), "--".to_string(), "hola".to_string()];
        let spec = PtySpec { cwd: "C:\\repo".into(), env: BTreeMap::new(), claude: Some(claude.clone()), claude_exe: None };
        let lanzamiento = shell_launch(FamiliaShell::Cmd, Some(&claude), None);
        let (s, paste) = a_spawn_spec(&spec, 80, 24, &shell);
        assert_eq!(s.args, lanzamiento.args);
        assert_eq!(s.env, lanzamiento.env);
        assert_eq!(paste, lanzamiento.paste);
    }

    #[test]
    fn el_entorno_del_lanzamiento_pisa_al_de_la_terminal() {
        let shell = resolver_shell("PowerShell 7", &con_todo());
        let claude = vec!["claude".to_string(), "--".to_string(), "hola mundo".to_string()];
        let lanzamiento = shell_launch(FamiliaShell::Ps, Some(&claude), Some("C:\\a\\claude.exe"));
        let Some((k, _)) = lanzamiento.env.iter().next() else { panic!("este lanzamiento pasa el mensaje por el entorno") };
        let spec = PtySpec { cwd: "C:\\r".into(), env: BTreeMap::from([(k.clone(), "viejo".to_string())]), claude: Some(claude), claude_exe: Some("C:\\a\\claude.exe".into()) };
        let (s, _) = a_spawn_spec(&spec, 80, 24, &shell);
        assert_eq!(s.env[k], lanzamiento.env[k]);
    }
}
