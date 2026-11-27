//! Dónde está el ejecutable de Codex o de Copilot y si su versión alcanza. Equivale a src/main/codex-exe.ts y copilot-exe.ts.

pub const VERSION_MINIMA_CODEX: (u64, u64, u64) = (0, 164, 0);
pub const VERSION_MINIMA_COPILOT: (u64, u64, u64) = (1, 0, 100);

fn es_absoluta(ruta: &str, win: bool) -> bool {
    if !win {
        return ruta.starts_with('/');
    }
    let b = ruta.as_bytes();
    let unidad = b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/');
    unidad || ruta.starts_with("\\\\") || ruta.starts_with("//")
}

fn unir(dir: &str, nombre: &str, win: bool) -> String {
    let sep = if win { '\\' } else { '/' };
    let base = dir.trim_end_matches(|c| c == '/' || c == '\\');
    if base.is_empty() { format!("{sep}{nombre}") } else { format!("{base}{sep}{nombre}") }
}

/// Las carpetas absolutas del PATH: las relativas se ignoran porque se resolverían contra el cwd de Sloth.
pub fn carpetas_del_path(path: &str, win: bool) -> Vec<String> {
    path.split(if win { ';' } else { ':' }).filter(|d| !d.is_empty() && es_absoluta(d, win)).map(str::to_owned).collect()
}

/// Ejecutable de `programa` en el PATH. En Windows npm deja `<programa>.cmd` y un shim sin extensión (un script de sh que
/// cmd no corre): solo cuentan `.exe` y `.cmd`, con el .exe primero dentro de cada carpeta.
pub fn resolver_exe(programa: &str, path: &str, existe: &dyn Fn(&str) -> bool, win: bool) -> Option<String> {
    let nombres = if win { vec![format!("{programa}.exe"), format!("{programa}.cmd")] } else { vec![programa.to_string()] };
    carpetas_del_path(path, win).iter().flat_map(|d| nombres.iter().map(move |n| unir(d, n, win))).find(|c| existe(c))
}

fn leer_version(salida: &str) -> Option<(u64, u64, u64)> {
    let b = salida.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_digit() {
            let mut partes = Vec::new();
            let mut j = i;
            loop {
                let ini = j;
                while j < b.len() && b[j].is_ascii_digit() {
                    j += 1;
                }
                partes.push(salida[ini..j].parse::<u64>().ok()?);
                if partes.len() == 3 || j + 1 >= b.len() || b[j] != b'.' || !b[j + 1].is_ascii_digit() {
                    break;
                }
                j += 1;
            }
            if partes.len() == 3 {
                return Some((partes[0], partes[1], partes[2]));
            }
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    None
}

/// Lee la salida de `<agente> --version`. Sin versión reconocible: ok falso.
pub fn version_ok(salida: &str, minima: (u64, u64, u64)) -> (Option<String>, bool) {
    match leer_version(salida) {
        None => (None, false),
        Some(v) => (Some(format!("{}.{}.{}", v.0, v.1, v.2)), v >= minima),
    }
}

pub const AVISO_POWERSHELL_7: &str = "Copilot necesita PowerShell 7 en Windows: instalalo con «winget install Microsoft.PowerShell».";

fn es_alias_de_tienda(dir: &str) -> bool {
    let d = dir.trim_end_matches(|c| c == '/' || c == '\\').to_lowercase().replace('/', "\\");
    d.ends_with("\\microsoft\\windowsapps")
}

/// Posibles `pwsh.exe`, sin repetir (sin importar mayúsculas). El de Microsoft Store es un alias de ejecución: `existe` da
/// falso aunque ande, así que esa carpeta se prueba corriendo.
pub fn candidatos_pwsh(program_w6432: Option<&str>, program_files: Option<&str>, path: &str, local_app_data: Option<&str>, existe: &dyn Fn(&str) -> bool) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let programas: Vec<&str> = [program_w6432, program_files, Some("C:\\Program Files")].into_iter().flatten().filter(|d| !d.is_empty() && es_absoluta(d, true)).collect();
    for d in programas {
        for v in ["7", "7-preview"] {
            let c = unir(&unir(&unir(d, "PowerShell", true), v, true), "pwsh.exe", true);
            if existe(&c) {
                out.push(c);
            }
        }
    }
    for d in carpetas_del_path(path, true) {
        let c = unir(&d, "pwsh.exe", true);
        if existe(&c) || es_alias_de_tienda(&d) {
            out.push(c);
        }
    }
    if let Some(l) = local_app_data.filter(|l| es_absoluta(l, true)) {
        out.push(unir(&unir(&unir(l, "Microsoft", true), "WindowsApps", true), "pwsh.exe", true));
    }
    let mut vistos: Vec<String> = Vec::new();
    out.retain(|c| {
        let k = c.to_lowercase();
        let nuevo = !vistos.contains(&k);
        vistos.push(k);
        nuevo
    });
    out
}

/// Copilot en Windows exige PowerShell 6+: el `powershell.exe` 5.1 del sistema no cuenta. `mayor` corre el ejecutable y
/// devuelve lo que imprime la versión mayor (None si no arrancó).
pub fn hay_powershell_7(candidatos: &[String], mayor: &mut dyn FnMut(&str) -> Option<String>) -> bool {
    candidatos.iter().any(|c| mayor(c).is_some_and(|s| s.trim().parse::<u64>().is_ok_and(|n| n >= 6) && s.trim().bytes().all(|b| b.is_ascii_digit())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolver_exe_prefiere_exe_y_luego_cmd_dentro_de_cada_carpeta_y_ignora_relativas() {
        let hay = |p: &str| ["C:\\b\\codex.cmd", "C:\\a\\codex.exe", "C:\\a\\codex.cmd"].contains(&p);
        assert_eq!(resolver_exe("codex", "rel;C:\\a;C:\\b", &hay, true).as_deref(), Some("C:\\a\\codex.exe"));
        assert_eq!(resolver_exe("codex", "C:\\b", &hay, true).as_deref(), Some("C:\\b\\codex.cmd"));
        assert_eq!(resolver_exe("codex", "relativa\\x;;", &|_| true, true), None);
        assert_eq!(resolver_exe("codex", "/usr/bin:bin:/opt", &|p| p == "/opt/codex", false).as_deref(), Some("/opt/codex"));
        assert_eq!(resolver_exe("codex", "C:\\a\\", &|p| p == "C:\\a\\codex.exe", true).as_deref(), Some("C:\\a\\codex.exe"));
        assert_eq!(resolver_exe("copilot", "C:\\a", &|p| p == "C:\\a\\copilot", true), None);
    }

    #[test]
    fn version_ok_compara_con_el_minimo() {
        assert_eq!(version_ok("codex-cli 0.164.0", VERSION_MINIMA_CODEX), (Some("0.164.0".into()), true));
        assert_eq!(version_ok("codex-cli 0.163.9", VERSION_MINIMA_CODEX), (Some("0.163.9".into()), false));
        assert_eq!(version_ok("codex-cli 1.0.0", VERSION_MINIMA_CODEX), (Some("1.0.0".into()), true));
        assert_eq!(version_ok("GitHub Copilot CLI 1.0.99", VERSION_MINIMA_COPILOT), (Some("1.0.99".into()), false));
        assert_eq!(version_ok("1.0.100\n", VERSION_MINIMA_COPILOT), (Some("1.0.100".into()), true));
        assert_eq!(version_ok("sin versión 12.5", VERSION_MINIMA_COPILOT), (None, false));
        assert_eq!(version_ok("", VERSION_MINIMA_COPILOT), (None, false));
        assert_eq!(version_ok("v2 build 3.4.5", VERSION_MINIMA_COPILOT), (Some("3.4.5".into()), true));
    }

    #[test]
    fn candidatos_pwsh_sin_repetir_y_con_el_alias_de_la_tienda() {
        let hay = |p: &str| p == "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
        let c = candidatos_pwsh(Some("C:\\Program Files"), Some("c:\\program files"), "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps;rel", Some("C:\\Users\\x\\AppData\\Local"), &hay);
        assert_eq!(c, ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe"]);
    }

    #[test]
    fn hay_powershell_7_pide_version_6_o_mas() {
        let c = ["a".to_string(), "b".to_string(), "c".to_string()];
        let mut r = |p: &str| match p { "a" => None, "b" => Some("5\n".into()), _ => Some(" 7 ".into()) };
        assert!(hay_powershell_7(&c, &mut r));
        let mut solo5 = |_: &str| Some("5".to_string());
        assert!(!hay_powershell_7(&c, &mut solo5));
        let mut basura = |_: &str| Some("7.4 x".to_string());
        assert!(!hay_powershell_7(&c, &mut basura));
    }
}
