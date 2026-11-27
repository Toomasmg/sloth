//! Hooks y statusline que Sloth instala en el settings.json de cada cuenta. Equivale a src/main/hooks.ts y a
//! `envolverStatusline` de src/main/statusline-core.ts. El servidor que recibe los hooks vive en el daemon.
use crate::respaldo::{respaldar_antes_de_reemplazar, respaldar_una_vez};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::Path;

/// Marca que identifica nuestros hooks dentro del settings.json de cada cuenta.
pub const HOOK_MARKER: &str = "sloth-hook";
/// Marcador de versiones anteriores (AntiRea): sus entradas también se limpian al instalar.
pub const LEGACY_HOOK_MARKERS: [&str; 1] = ["antirea-hook"];
pub const STATUSLINE_MARKER: &str = "sloth-statusline";
pub const HOOK_EVENTS: [&str; 6] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "Notification", "Stop", "SessionEnd"];
/// PermissionRequest espera la respuesta de la interfaz, por eso lleva timeout propio.
const PERMISSION_HOOK_TIMEOUT_S: u32 = 130;

pub use crate::agent_machine::EstadoAgente;

/// Qué estado le corresponde al agente según el evento, y el detalle que lo acompaña. None si el evento no se conoce.
pub fn estado_para_evento(evento: &str, tool: Option<&str>, message: Option<&str>) -> Option<(EstadoAgente, Option<String>)> {
    Some(match evento {
        "SessionStart" => (EstadoAgente::Idle, None),
        "UserPromptSubmit" => (EstadoAgente::Working, None),
        "PreToolUse" => (EstadoAgente::Working, tool.map(str::to_owned)),
        "Notification" => (EstadoAgente::Waiting, message.map(str::to_owned)),
        "Stop" => (EstadoAgente::Done, None),
        // Claude se cerró pero la shell del espacio sigue abierta.
        "SessionEnd" => (EstadoAgente::Idle, Some("Claude cerrado".into())),
        _ => return None,
    })
}

/// Cómo se escribe cada hook: con el ejecutable en Rust (`helper`: ruta sin espacios y con barras) o, sin él, con Node.
pub struct Lanzador<'a> {
    pub helper: Option<&'a str>,
    /// Ruta (con barras) del script `sloth-hook.cjs`, para cuando no hay ejecutable.
    pub script_hook: &'a str,
    /// Ruta del script `sloth-statusline.cjs`.
    pub script_statusline: &'a str,
    /// Con Node en el PATH el envoltorio de la statusline puede correr; sin él y sin ejecutable no se toca.
    pub hay_node: bool,
}

fn es_statusline(v: &Value) -> bool {
    v.get("type").and_then(Value::as_str) == Some("command") && v.get("command").is_some_and(Value::is_string)
}

fn sin_espacios(t: &str) -> bool {
    !t.is_empty() && !t.chars().any(char::is_whitespace)
}

/// `node "<...sloth-statusline.cjs>"[ <b64>]` o `<...sloth-hook...> statusline[ <b64>]`. Devuelve el original en base64url.
fn parse_envuelta(cmd: &str) -> Option<Option<String>> {
    let opcional = |resto: &str| -> Option<Option<String>> {
        if resto.is_empty() {
            Some(None)
        } else {
            resto.strip_prefix(' ').filter(|r| sin_espacios(r)).map(|r| Some(r.to_string()))
        }
    };
    if let Some(r) = cmd.strip_prefix("node \"") {
        let fin = r.find('"')?;
        if r[..fin].ends_with("sloth-statusline.cjs") {
            return opcional(&r[fin + 1..]);
        }
    }
    let (primero, resto) = cmd.split_once(' ')?;
    if !sin_espacios(primero) || !primero.contains("sloth-hook") {
        return None;
    }
    opcional(resto.strip_prefix("statusline")?)
}

/// Envuelve la statusline de la cuenta. Sin statusline, solo captura y no imprime nada. Si hay algo que no es una
/// statusline de comando, no se toca. Con `helper` una que había envuelto la versión con Node se vuelve a envolver con el
/// ejecutable, conservando la original.
pub fn envolver_statusline(actual: Option<&Value>, script: &str, helper: Option<&str>) -> Value {
    let capturar = match helper {
        Some(h) => format!("{h} statusline"),
        None => format!("node \"{}\"", script.replace('\\', "/")),
    };
    let Some(actual) = actual.filter(|a| !a.is_null()) else { return json!({ "type": "command", "command": capturar }) };
    if !es_statusline(actual) {
        return actual.clone();
    }
    let cmd = actual["command"].as_str().unwrap_or_default();
    if let Some(original) = parse_envuelta(cmd) {
        if helper.is_none() || cmd.starts_with(&capturar) {
            return actual.clone();
        }
        let mut nuevo = actual.clone();
        nuevo["command"] = Value::String(match original {
            Some(b64) => format!("{capturar} {b64}"),
            None => capturar,
        });
        return nuevo;
    }
    if cmd.contains(STATUSLINE_MARKER) {
        return actual.clone();
    }
    // base64url: sin comillas, espacios ni signos que Git Bash o PowerShell interpreten.
    let mut nuevo = actual.clone();
    nuevo["command"] = Value::String(format!("{capturar} {}", URL_SAFE_NO_PAD.encode(cmd.as_bytes())));
    nuevo
}

#[derive(Debug, Default)]
pub struct ResultadoInstalar {
    /// false si no se tocó nada (el settings.json que había no se entiende).
    pub instalado: bool,
    pub avisos: Vec<String>,
}

fn es_nuestro(comando: Option<&str>) -> bool {
    comando.is_some_and(|c| std::iter::once(HOOK_MARKER).chain(LEGACY_HOOK_MARKERS).any(|m| c.contains(m)))
}

/// Agrega (o actualiza) nuestros hooks en el settings.json de la cuenta, sin tocar los hooks que el usuario ya tenga.
/// Con `base` (el settings.json del usuario, cuando comparte su setup) arma el de la cuenta a partir de él.
pub fn instalar_en(config_dir: &Path, base: Option<&Value>, lanzador: &Lanzador) -> std::io::Result<ResultadoInstalar> {
    fs::create_dir_all(config_dir)?;
    let file = config_dir.join("settings.json");
    let mut res = ResultadoInstalar::default();
    let mut settings: Map<String, Value> = if let Some(b) = base {
        // Copia: no se muta el settings.json del usuario en memoria.
        b.as_object().cloned().unwrap_or_default()
    } else if file.exists() {
        let crudo = fs::read(&file)?;
        let texto = String::from_utf8_lossy(&crudo);
        match serde_json::from_str::<Value>(texto.strip_prefix('\u{feff}').unwrap_or(&texto)) {
            Ok(Value::Object(o)) => o,
            _ => {
                // No pisamos un settings.json que no entendemos.
                res.avisos.push(format!("settings.json inválido en {}; no se instalan hooks", config_dir.display()));
                return Ok(res);
            }
        }
    } else {
        Map::new()
    };
    let mut hooks: Map<String, Value> = settings.get("hooks").and_then(Value::as_object).cloned().unwrap_or_default();
    for evento in HOOK_EVENTS.iter().copied().chain(["PermissionRequest"]) {
        let otros: Vec<Value> = hooks
            .get(evento)
            .and_then(Value::as_array)
            .map(|l| l.iter().filter(|e| !e.get("hooks").and_then(Value::as_array).is_some_and(|hs| hs.iter().any(|h| es_nuestro(h.get("command").and_then(Value::as_str))))).cloned().collect())
            .unwrap_or_default();
        let comando = match lanzador.helper {
            Some(h) => format!("{h} {evento}"),
            None => format!("node \"{}\" {evento}", lanzador.script_hook),
        };
        let mut hook = Map::new();
        hook.insert("type".into(), json!("command"));
        hook.insert("command".into(), Value::String(comando));
        if evento == "PermissionRequest" {
            hook.insert("timeout".into(), json!(PERMISSION_HOOK_TIMEOUT_S));
        }
        let mut nuestro = Map::new();
        nuestro.insert("hooks".into(), Value::Array(vec![Value::Object(hook)]));
        if evento == "PreToolUse" || evento == "PermissionRequest" {
            nuestro.insert("matcher".into(), json!(""));
        }
        let mut lista = otros;
        lista.push(Value::Object(nuestro));
        hooks.insert(evento.into(), Value::Array(lista));
    }
    settings.insert("hooks".into(), Value::Object(hooks));
    // El % real de los límites solo llega en la entrada de la statusline: se envuelve para leerlo (función «celular»).
    if lanzador.helper.is_some() || lanzador.hay_node {
        let envuelta = envolver_statusline(settings.get("statusLine"), lanzador.script_statusline, lanzador.helper);
        settings.insert("statusLine".into(), envuelta);
    }
    let texto = serde_json::to_string_pretty(&Value::Object(settings)).map_err(std::io::Error::other)?;
    // Un respaldo que no se pudo hacer no frena la terminal: queda como aviso.
    let respaldos = respaldar_una_vez(&file).and_then(|_| if base.is_some() { respaldar_antes_de_reemplazar(&file, &texto).map(|_| ()) } else { Ok(()) });
    if let Err(e) = respaldos {
        res.avisos.push(format!("no se pudo respaldar {}: {e}", file.display()));
    }
    let tmp = config_dir.join("settings.json.tmp");
    fs::write(&tmp, texto)?;
    fs::rename(&tmp, &file)?;
    res.instalado = true;
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    const SCRIPT: &str = "C:\\Users\\yo\\AppData\\Roaming\\Sloth\\sloth-statusline.cjs";
    const HELPER: &str = "C:/Users/yo/AppData/Roaming/Sloth/bin/sloth-hook.exe";

    fn dir() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!("sloth-hooks-rs-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn con_helper() -> Lanzador<'static> {
        Lanzador { helper: Some(HELPER), script_hook: "C:/x/sloth-hook.cjs", script_statusline: SCRIPT, hay_node: true }
    }
    fn con_node() -> Lanzador<'static> {
        Lanzador { helper: None, script_hook: "C:/x/sloth-hook.cjs", script_statusline: SCRIPT, hay_node: true }
    }
    fn leer(d: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(d.join("settings.json")).unwrap()).unwrap()
    }

    #[test]
    fn el_estado_de_cada_evento() {
        use EstadoAgente::*;
        assert_eq!(estado_para_evento("SessionStart", None, None), Some((Idle, None)));
        assert_eq!(estado_para_evento("UserPromptSubmit", Some("x"), None), Some((Working, None)));
        assert_eq!(estado_para_evento("PreToolUse", Some("Bash"), None), Some((Working, Some("Bash".into()))));
        assert_eq!(estado_para_evento("Notification", None, Some("necesito permiso")), Some((Waiting, Some("necesito permiso".into()))));
        assert_eq!(estado_para_evento("Stop", None, None), Some((Done, None)));
        assert_eq!(estado_para_evento("SessionEnd", None, None), Some((Idle, Some("Claude cerrado".into()))));
        assert_eq!(estado_para_evento("Otro", None, None), None);
        assert_eq!(Waiting.como_texto(), "waiting");
    }

    #[test]
    fn instala_los_siete_hooks_con_el_ejecutable_y_con_matcher_donde_corresponde() {
        let d = dir();
        let r = instalar_en(&d, None, &con_helper()).unwrap();
        assert!(r.instalado && r.avisos.is_empty());
        let s = leer(&d);
        for e in HOOK_EVENTS {
            assert_eq!(s["hooks"][e][0]["hooks"][0]["command"], json!(format!("{HELPER} {e}")), "{e}");
        }
        assert_eq!(s["hooks"]["PreToolUse"][0]["matcher"], json!(""));
        assert!(s["hooks"]["Stop"][0].get("matcher").is_none());
        assert_eq!(s["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"], json!(130));
        assert_eq!(s["hooks"]["PermissionRequest"][0]["matcher"], json!(""));
        assert_eq!(s["statusLine"], json!({ "type": "command", "command": format!("{HELPER} statusline") }));
    }

    #[test]
    fn sin_ejecutable_usa_node_y_sin_node_no_toca_la_statusline() {
        let d = dir();
        instalar_en(&d, None, &con_node()).unwrap();
        let s = leer(&d);
        assert_eq!(s["hooks"]["Stop"][0]["hooks"][0]["command"], json!("node \"C:/x/sloth-hook.cjs\" Stop"));
        assert_eq!(s["statusLine"]["command"], json!("node \"C:/Users/yo/AppData/Roaming/Sloth/sloth-statusline.cjs\""));
        let d2 = dir();
        instalar_en(&d2, None, &Lanzador { hay_node: false, ..con_node() }).unwrap();
        assert!(leer(&d2).get("statusLine").is_none());
    }

    #[test]
    fn conserva_los_hooks_del_usuario_y_es_idempotente() {
        let d = dir();
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("settings.json"), json!({ "model": "opus", "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "mi-hook-propio" }] }] } }).to_string()).unwrap();
        instalar_en(&d, None, &con_helper()).unwrap();
        let una = leer(&d);
        assert_eq!(una["model"], json!("opus"));
        assert_eq!(una["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(una["hooks"]["Stop"][0]["hooks"][0]["command"], json!("mi-hook-propio"));
        instalar_en(&d, None, &con_helper()).unwrap();
        assert_eq!(leer(&d), una, "instalar dos veces deja lo mismo");
    }

    #[test]
    fn reemplaza_los_hooks_de_node_y_los_de_antirea_por_los_nuevos() {
        let d = dir();
        fs::create_dir_all(&d).unwrap();
        let viejo = json!({ "hooks": { "Stop": [
            { "hooks": [{ "type": "command", "command": "node \"C:/x/sloth-hook.cjs\" Stop" }] },
            { "hooks": [{ "type": "command", "command": "node \"C:/x/antirea-hook.cjs\" Stop" }] },
            { "hooks": [{ "type": "command", "command": "otro" }] }
        ] } });
        fs::write(d.join("settings.json"), viejo.to_string()).unwrap();
        instalar_en(&d, None, &con_helper()).unwrap();
        let comandos: Vec<String> = leer(&d)["hooks"]["Stop"].as_array().unwrap().iter().map(|e| e["hooks"][0]["command"].as_str().unwrap().to_string()).collect();
        assert_eq!(comandos, ["otro".to_string(), format!("{HELPER} Stop")]);
    }

    #[test]
    fn un_settings_json_que_no_se_entiende_no_se_pisa() {
        let d = dir();
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("settings.json"), "{ roto").unwrap();
        let r = instalar_en(&d, None, &con_helper()).unwrap();
        assert!(!r.instalado && r.avisos[0].contains("settings.json inválido"));
        assert_eq!(fs::read_to_string(d.join("settings.json")).unwrap(), "{ roto");
        fs::write(d.join("settings.json"), "[1]").unwrap();
        assert!(!instalar_en(&d, None, &con_helper()).unwrap().instalado);
    }

    #[test]
    fn con_base_parte_del_settings_del_usuario_sin_mutarlo_y_respalda() {
        let d = dir();
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("settings.json"), "{\"editado\":\"a mano\"}").unwrap();
        let base = json!({ "model": "sonnet", "statusLine": { "type": "command", "command": "mi-linea", "padding": 0 } });
        let copia = base.clone();
        instalar_en(&d, Some(&base), &con_helper()).unwrap();
        assert_eq!(base, copia);
        let s = leer(&d);
        assert_eq!(s["model"], json!("sonnet"));
        assert_eq!(s["statusLine"]["padding"], json!(0));
        assert!(s["statusLine"]["command"].as_str().unwrap().starts_with(&format!("{HELPER} statusline ")));
        assert_eq!(fs::read_to_string(d.join("settings.json.sloth-bak")).unwrap(), "{\"editado\":\"a mano\"}");
        assert_eq!(fs::read_to_string(d.join("settings.json.sloth-prev")).unwrap(), "{\"editado\":\"a mano\"}");
    }

    #[test]
    fn statusline_con_el_ejecutable_sin_statusline_solo_captura() {
        assert_eq!(envolver_statusline(None, SCRIPT, Some(HELPER)), json!({ "type": "command", "command": format!("{HELPER} statusline") }));
        assert_eq!(envolver_statusline(Some(&Value::Null), SCRIPT, Some(HELPER))["command"], json!(format!("{HELPER} statusline")));
    }

    #[test]
    fn envuelve_la_del_usuario_con_el_original_en_base64url_y_no_dos_veces() {
        let r = envolver_statusline(Some(&json!({ "type": "command", "command": "bash ~/.claude/statusline-command.sh", "padding": 0 })), SCRIPT, Some(HELPER));
        assert_eq!(r["padding"], json!(0));
        let partes: Vec<&str> = r["command"].as_str().unwrap().split(' ').collect();
        assert_eq!(&partes[..2], [HELPER, "statusline"]);
        assert_eq!(String::from_utf8(URL_SAFE_NO_PAD.decode(partes[2]).unwrap()).unwrap(), "bash ~/.claude/statusline-command.sh");
        assert_eq!(partes.len(), 3);
        assert_eq!(envolver_statusline(Some(&r), SCRIPT, Some(HELPER)), r);
    }

    #[test]
    fn una_statusline_envuelta_con_node_pasa_al_ejecutable_sin_perder_la_original() {
        let con_node = envolver_statusline(Some(&json!({ "type": "command", "command": "mi-linea", "padding": 2 })), SCRIPT, None);
        assert!(con_node["command"].as_str().unwrap().starts_with("node "));
        // Sin ejecutable se deja igual.
        assert_eq!(envolver_statusline(Some(&con_node), SCRIPT, None), con_node);
        let migrada = envolver_statusline(Some(&con_node), SCRIPT, Some(HELPER));
        assert_eq!(migrada["padding"], json!(2));
        let partes: Vec<&str> = migrada["command"].as_str().unwrap().split(' ').collect();
        assert_eq!(&partes[..2], [HELPER, "statusline"]);
        assert_eq!(String::from_utf8(URL_SAFE_NO_PAD.decode(partes[2]).unwrap()).unwrap(), "mi-linea");
        // Solo captura: también se pasa.
        let solo = envolver_statusline(None, SCRIPT, None);
        assert_eq!(envolver_statusline(Some(&solo), SCRIPT, Some(HELPER)), json!({ "type": "command", "command": format!("{HELPER} statusline") }));
    }

    #[test]
    fn lo_que_no_es_una_statusline_de_comando_no_se_toca() {
        let rara = json!({ "type": "otra", "valor": 1 });
        assert_eq!(envolver_statusline(Some(&rara), SCRIPT, Some(HELPER)), rara);
        let sin_comando = json!({ "type": "command" });
        assert_eq!(envolver_statusline(Some(&sin_comando), SCRIPT, None), sin_comando);
    }

    #[test]
    fn una_que_ya_menciona_el_marcador_se_deja_igual() {
        let propia = json!({ "type": "command", "command": "python mi-sloth-statusline-custom.py" });
        assert_eq!(envolver_statusline(Some(&propia), SCRIPT, None), propia);
    }
}
