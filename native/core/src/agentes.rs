//! Qué agentes hay para elegir al crear una cuenta (`accounts:agentes`) y si hay PowerShell 7 para Copilot. Equivale a
//! src/main/agentes.ts. Los procesos corren con el `ProcesoRun` común: sin shell, ocultos y con plazo.
use crate::agente_exe::{candidatos_pwsh, hay_powershell_7, version_ok, AVISO_POWERSHELL_7, VERSION_MINIMA_CODEX, VERSION_MINIMA_COPILOT};
use crate::features::tickets::claude_run::{Mirada, Peticion, ProcesoRun, SalidaRun};
use crate::features::tickets::lanzamiento::lanzamiento_de;
use crate::proveedores::{ProveedorId, PROVEEDORES_IDS};
use crate::proveedores_fs::{como_instalar, quitar_del_entorno};
use crate::ptys_core::entorno_limpio;
use serde::Serialize;
use std::collections::BTreeMap;
use std::time::Duration;

const PLAZO_VERSION: Duration = Duration::from_secs(5);
const PLAZO_PWSH: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgenteDisponible {
    pub id: &'static str,
    pub nombre: &'static str,
    /// Si se encontró su ejecutable.
    pub instalado: bool,
    pub como_instalar: &'static str,
    /// Por qué está instalado pero no se puede usar (p. ej. falta PowerShell 7).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aviso: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Falso si la versión instalada es más vieja que la mínima con la que Sloth probó el agente.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_ok: Option<bool>,
}

/// Lo que hace falta del sistema. `entorno` es el de Sloth; `motivo_tope` dice si ya no se puede sumar otra cuenta de ese
/// agente (el tope entre perfiles lo sabe quien llama).
pub struct SistemaAgentes<'a> {
    pub proceso: &'a dyn ProcesoRun,
    pub entorno: &'a [(String, String)],
    pub windows: bool,
    pub resolver: &'a (dyn Fn(ProveedorId) -> Option<String> + Sync),
    pub existe: &'a (dyn Fn(&str) -> bool + Sync),
    pub motivo_tope: &'a (dyn Fn(ProveedorId) -> Option<String> + Sync),
}

// En Windows el nombre de una variable no distingue mayúsculas (`Path` y `PATH` son la misma).
fn variable_windows<'a>(entorno: &'a [(String, String)], clave: &str) -> Option<&'a str> {
    entorno.iter().find(|(k, _)| k.eq_ignore_ascii_case(clave)).map(|(_, v)| v.as_str())
}

fn correr(proceso: &dyn ProcesoRun, file: String, args: Vec<String>, verbatim: bool, env: &[(String, String)], timeout: Duration) -> Option<String> {
    let env: BTreeMap<String, String> = env.iter().cloned().collect();
    let p = Peticion { exe: file, args, prompt: String::new(), cwd: std::env::temp_dir(), env, timeout, verbatim, arbol: false, stdin_abierto: false };
    match proceso.correr(&p, None, &mut |_| Mirada::Seguir) {
        SalidaRun::Termino { code: Some(0), stdout, .. } => Some(stdout),
        _ => None,
    }
}

/// `<exe> --version`. Un .cmd de npm corre por cmd.exe con argumentos fijos; una ruta que cmd leería como sintaxis no se corre.
pub fn salida_de_version(proceso: &dyn ProcesoRun, exe: &str, env: &[(String, String)], windows: bool) -> Option<String> {
    let l = lanzamiento_de(exe, &["--version".to_string()], windows).ok()?;
    correr(proceso, l.file, l.args, l.verbatim, env, PLAZO_VERSION)
}

/// Copilot en Windows exige PowerShell 6+; fuera de Windows no lo usa. Se corre sin perfil (no ejecuta nada del usuario) y
/// el de la Store, que es un alias, se prueba ejecutándolo.
pub fn powershell7_disponible(proceso: &dyn ProcesoRun, entorno: &[(String, String)], windows: bool, existe: &dyn Fn(&str) -> bool) -> bool {
    if !windows {
        return true;
    }
    let v = |k: &str| variable_windows(entorno, k);
    let candidatos = candidatos_pwsh(v("ProgramW6432"), v("ProgramFiles"), v("PATH").unwrap_or_default(), v("LOCALAPPDATA"), existe);
    let args: Vec<String> = ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", "$PSVersionTable.PSVersion.Major"].iter().map(|s| s.to_string()).collect();
    hay_powershell_7(&candidatos, &mut |exe| correr(proceso, exe.to_string(), args.clone(), false, entorno, PLAZO_PWSH))
}

/// La versión de Copilot corre con el entorno de una terminal suya (sin tokens de GitHub) y sin autoactualización: detectar
/// no cambia el binario.
pub fn entorno_de_version_copilot(entorno: &[(String, String)]) -> Vec<(String, String)> {
    let mut env = entorno_limpio(entorno.iter().cloned(), &|k| quitar_del_entorno(ProveedorId::Copilot, k));
    env.push(("COPILOT_AUTO_UPDATE".into(), "false".into()));
    env
}

/// Arma lo que se muestra de un agente con lo que se averiguó. `salida` es lo que imprimió `--version` (None si no corrió).
pub fn armar_agente(id: ProveedorId, exe: Option<&str>, salida: Option<&str>, aviso: Option<String>) -> AgenteDisponible {
    let mut a = AgenteDisponible { id: id.como_texto(), nombre: id.nombre(), instalado: exe.is_some(), como_instalar: como_instalar(id), aviso: None, version: None, version_ok: None };
    if exe.is_none() {
        return a;
    }
    a.aviso = aviso;
    let minima = match id {
        ProveedorId::Claude => return a,
        ProveedorId::Codex => VERSION_MINIMA_CODEX,
        ProveedorId::Copilot => VERSION_MINIMA_COPILOT,
    };
    if let Some(s) = salida {
        let (version, ok) = version_ok(s, minima);
        a.version = version;
        a.version_ok = Some(ok);
    }
    a
}

fn detectar(s: &SistemaAgentes, id: ProveedorId) -> AgenteDisponible {
    let Some(exe) = (s.resolver)(id) else { return armar_agente(id, None, None, None) };
    match id {
        ProveedorId::Claude => armar_agente(id, Some(&exe), None, None),
        ProveedorId::Codex => {
            let salida = salida_de_version(s.proceso, &exe, s.entorno, s.windows);
            armar_agente(id, Some(&exe), salida.as_deref(), None)
        }
        ProveedorId::Copilot => {
            let env = entorno_de_version_copilot(s.entorno);
            let (hay_pwsh, salida) = std::thread::scope(|t| {
                let pwsh = t.spawn(|| powershell7_disponible(s.proceso, s.entorno, s.windows, s.existe));
                let salida = salida_de_version(s.proceso, &exe, &env, s.windows);
                (pwsh.join().unwrap_or(false), salida)
            });
            let aviso = if hay_pwsh { (s.motivo_tope)(id) } else { Some(AVISO_POWERSHELL_7.to_string()) };
            armar_agente(id, Some(&exe), salida.as_deref(), aviso)
        }
    }
}

/// Todos los agentes, en el orden de siempre; los de cada uno se averiguan a la vez.
pub fn detectar_agentes(s: &SistemaAgentes) -> Vec<AgenteDisponible> {
    std::thread::scope(|t| {
        let hilos: Vec<_> = PROVEEDORES_IDS.iter().map(|&id| t.spawn(move || detectar(s, id))).collect();
        hilos.into_iter().zip(PROVEEDORES_IDS).map(|(h, id)| h.join().unwrap_or_else(|_| armar_agente(id, None, None, None))).collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::AtomicBool;
    use std::sync::Mutex;

    struct Falso {
        responder: Box<dyn Fn(&Peticion) -> SalidaRun + Send + Sync>,
        pedidos: Mutex<Vec<(String, Vec<String>, bool, BTreeMap<String, String>)>>,
    }

    impl Falso {
        fn nuevo(f: impl Fn(&Peticion) -> SalidaRun + Send + Sync + 'static) -> Self {
            Falso { responder: Box::new(f), pedidos: Mutex::new(Vec::new()) }
        }
    }

    impl ProcesoRun for Falso {
        fn correr(&self, p: &Peticion, _: Option<&AtomicBool>, _: &mut dyn FnMut(&str) -> Mirada) -> SalidaRun {
            self.pedidos.lock().unwrap().push((p.exe.clone(), p.args.clone(), p.verbatim, p.env.clone()));
            (self.responder)(p)
        }
    }

    fn ok(s: &str) -> SalidaRun {
        SalidaRun::Termino { code: Some(0), stdout: s.into(), stderr: String::new() }
    }

    fn env(pares: &[(&str, &str)]) -> Vec<(String, String)> {
        pares.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn un_agente_sin_ejecutable_aparece_sin_instalar_y_con_como_instalarlo() {
        let a = armar_agente(ProveedorId::Codex, None, Some("codex-cli 0.200.0"), Some("x".into()));
        assert_eq!(serde_json::to_value(&a).unwrap(), json!({ "id": "codex", "nombre": "Codex", "instalado": false, "comoInstalar": "npm install -g @openai/codex" }));
    }

    #[test]
    fn la_version_se_compara_con_la_minima_de_cada_agente_y_claude_no_la_pide() {
        let c = armar_agente(ProveedorId::Codex, Some("codex"), Some("codex-cli 0.163.0"), None);
        assert_eq!((c.version.as_deref(), c.version_ok), (Some("0.163.0"), Some(false)));
        let p = armar_agente(ProveedorId::Copilot, Some("copilot"), Some("1.0.100"), None);
        assert_eq!((p.version.as_deref(), p.version_ok), (Some("1.0.100"), Some(true)));
        let sin = armar_agente(ProveedorId::Codex, Some("codex"), None, None);
        assert_eq!((sin.version, sin.version_ok), (None, None));
        let cl = armar_agente(ProveedorId::Claude, Some("claude"), Some("9.9.9"), None);
        assert_eq!(serde_json::to_value(&cl).unwrap()["instalado"], true);
        assert_eq!(cl.version, None);
    }

    #[test]
    fn un_cmd_corre_por_cmd_exe_con_argumentos_fijos_y_una_ruta_rara_no_corre() {
        let f = Falso::nuevo(|_| ok("codex-cli 0.164.0\n"));
        assert_eq!(salida_de_version(&f, "C:\\npm\\codex.cmd", &[], true).as_deref(), Some("codex-cli 0.164.0\n"));
        assert_eq!(salida_de_version(&f, "C:\\a&b\\codex.cmd", &[], true), None);
        let pedidos = f.pedidos.lock().unwrap();
        assert_eq!(pedidos.len(), 1);
        assert_eq!((pedidos[0].0.as_str(), pedidos[0].2), ("cmd.exe", true));
        assert_eq!(pedidos[0].1, ["/d", "/s", "/c", "\"\"C:\\npm\\codex.cmd\" --version\""]);
    }

    #[test]
    fn una_version_que_sale_con_error_o_vence_es_sin_dato() {
        let f = Falso::nuevo(|_| SalidaRun::Termino { code: Some(1), stdout: "1.2.3".into(), stderr: String::new() });
        assert_eq!(salida_de_version(&f, "/usr/bin/codex", &[], false), None);
        let f = Falso::nuevo(|_| SalidaRun::Plazo);
        assert_eq!(salida_de_version(&f, "/usr/bin/codex", &[], false), None);
    }

    #[test]
    fn powershell_7_fuera_de_windows_siempre_y_en_windows_pide_version_6_o_mas() {
        let nunca = Falso::nuevo(|_| unreachable!());
        assert!(powershell7_disponible(&nunca, &[], false, &|_| false));
        let e = env(&[("ProgramFiles", "C:\\Program Files"), ("Path", "")]);
        let hay = |p: &str| p == "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
        let siete = Falso::nuevo(|_| ok("7\r\n"));
        assert!(powershell7_disponible(&siete, &e, true, &hay));
        let (exe, args, ..) = siete.pedidos.lock().unwrap()[0].clone();
        assert_eq!(exe, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
        assert_eq!(args[0], "-NoProfile");
        let cinco = Falso::nuevo(|_| ok("5"));
        assert!(!powershell7_disponible(&cinco, &e, true, &hay));
    }

    #[test]
    fn la_version_de_copilot_corre_sin_tokens_de_github_y_sin_autoactualizarse() {
        let e = entorno_de_version_copilot(&env(&[("PATH", "x"), ("GH_TOKEN", "t"), ("COPILOT_HOME", "h"), ("SLOTH_X", "s")]));
        let m: BTreeMap<String, String> = e.into_iter().collect();
        assert_eq!(m.get("PATH").map(String::as_str), Some("x"));
        assert_eq!(m.get("COPILOT_AUTO_UPDATE").map(String::as_str), Some("false"));
        assert!(!m.contains_key("GH_TOKEN") && !m.contains_key("COPILOT_HOME") && !m.contains_key("SLOTH_X"));
    }

    #[test]
    fn detectar_arma_los_tres_en_orden_y_copilot_avisa_lo_que_falta() {
        let e = env(&[("PATH", "/bin")]);
        let f = Falso::nuevo(|p| if p.exe.ends_with("codex") { ok("codex-cli 0.170.1") } else { ok("GitHub Copilot CLI 1.0.120") });
        let resolver = |id: ProveedorId| (id != ProveedorId::Claude).then(|| format!("/bin/{}", id.como_texto()));
        let tope = |_: ProveedorId| Some("Ya tenés una cuenta de GitHub Copilot en otro perfil.".to_string());
        let s = SistemaAgentes { proceso: &f, entorno: &e, windows: false, resolver: &resolver, existe: &|_| false, motivo_tope: &tope };
        let a = detectar_agentes(&s);
        assert_eq!(a.iter().map(|x| x.id).collect::<Vec<_>>(), ["claude", "codex", "copilot"]);
        assert!(!a[0].instalado);
        assert_eq!((a[1].version.as_deref(), a[1].version_ok, a[1].aviso.as_deref()), (Some("0.170.1"), Some(true), None));
        assert_eq!((a[2].version.as_deref(), a[2].aviso.as_deref()), (Some("1.0.120"), Some("Ya tenés una cuenta de GitHub Copilot en otro perfil.")));
        let copilot = f.pedidos.lock().unwrap().iter().find(|p| p.0.ends_with("copilot")).cloned().unwrap();
        assert_eq!(copilot.3.get("COPILOT_AUTO_UPDATE").map(String::as_str), Some("false"));
    }

    #[test]
    fn sin_powershell_7_copilot_lleva_ese_aviso_aunque_tenga_version() {
        let e = env(&[("Path", "C:\\bin")]);
        let f = Falso::nuevo(|p| if p.exe.ends_with("pwsh.exe") { SalidaRun::NoAbrio("x".into()) } else { ok("1.0.100") });
        let resolver = |id: ProveedorId| (id == ProveedorId::Copilot).then(|| "C:\\bin\\copilot.exe".to_string());
        let s = SistemaAgentes { proceso: &f, entorno: &e, windows: true, resolver: &resolver, existe: &|_| false, motivo_tope: &|_| None };
        let a = detectar_agentes(&s);
        assert_eq!(a[2].aviso.as_deref(), Some(AVISO_POWERSHELL_7));
        assert_eq!(a[2].version_ok, Some(true));
    }
}
