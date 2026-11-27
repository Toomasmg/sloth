//! Setup compartido: enlaza o copia tu `~/.claude` dentro de la carpeta de cada cuenta. Equivale a src/main/setup.ts.
use crate::enlace::{crear_enlace_carpeta, es_enlace_a, es_enlace_roto, quitar_enlace};
use crate::persistencia::escribir_json_atomico;
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

/// Carpetas que se comparten con un junction: lo que cambies en ~/.claude se ve al instante en todas las cuentas.
pub const CARPETAS_COMPARTIDAS: [&str; 6] = ["skills", "agents", "commands", "hooks", "plugins", "output-styles"];
/// Archivos que se copian en cada sincronización.
pub const ARCHIVOS_COPIADOS: [&str; 3] = ["CLAUDE.md", "statusline-command.sh", "statusline.py"];

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SetupSyncReport {
    pub linked: Vec<String>,
    pub copied: Vec<String>,
    pub mcp_servers: Vec<String>,
    pub skipped: Vec<String>,
}

pub struct CuentaSetup<'a> {
    pub config_dir: &'a Path,
    /// `None` cuenta como compartir: solo un `false` explícito lo apaga.
    pub share_setup: Option<bool>,
}

impl CuentaSetup<'_> {
    fn comparte(&self) -> bool {
        self.share_setup != Some(false)
    }
}

/// Tu setup de siempre.
pub fn dir_claude_usuario(home: &Path) -> PathBuf {
    home.join(".claude")
}

fn json_claude_usuario(home: &Path) -> PathBuf {
    home.join(".claude.json")
}

fn leer_objeto_json(ruta: &Path) -> Option<Map<String, Value>> {
    let texto = String::from_utf8(fs::read(ruta).ok()?).ok()?;
    match serde_json::from_str::<Value>(texto.strip_prefix('\u{feff}').unwrap_or(&texto)).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

/// settings.json base para la cuenta: el tuyo si comparte setup; si no, el propio de la cuenta.
pub fn base_settings_para(cuenta: &CuentaSetup, home: &Path) -> Option<Map<String, Value>> {
    if !cuenta.comparte() {
        return None;
    }
    Some(leer_objeto_json(&dir_claude_usuario(home).join("settings.json")).unwrap_or_default())
}

fn sincronizar_carpetas(origen: &Path, destino: &Path, reporte: &mut SetupSyncReport) {
    for nombre in CARPETAS_COMPARTIDAS {
        let desde = origen.join(nombre);
        let hasta = destino.join(nombre);
        if !desde.exists() {
            continue;
        }
        if es_enlace_a(&hasta, &desde) {
            reporte.linked.push(nombre.into());
            continue;
        }
        if hasta.exists() || es_enlace_roto(&hasta) {
            reporte.skipped.push(format!("{nombre} (la cuenta ya tiene la suya)"));
            continue;
        }
        match crear_enlace_carpeta(&desde, &hasta) {
            Ok(()) => reporte.linked.push(nombre.into()),
            Err(e) => reporte.skipped.push(format!("{nombre} ({e})")),
        }
    }
}

fn copiar_archivos(origen: &Path, destino: &Path, reporte: &mut SetupSyncReport) {
    for nombre in ARCHIVOS_COPIADOS {
        let desde = origen.join(nombre);
        if !desde.exists() {
            continue;
        }
        match fs::copy(&desde, destino.join(nombre)) {
            Ok(_) => reporte.copied.push(nombre.into()),
            Err(e) => reporte.skipped.push(format!("{nombre} ({e})")),
        }
    }
}

/// Los MCP de usuario viven en ~/.claude.json: se agregan a la cuenta los que le falten, sin pisar los suyos.
fn sincronizar_mcp(usuario: &Map<String, Value>, config_dir: &Path, reporte: &mut SetupSyncReport) {
    let archivo = config_dir.join(".claude.json");
    let Some(mut cuenta) = (if archivo.exists() { leer_objeto_json(&archivo) } else { Some(Map::new()) }) else {
        reporte.skipped.push("MCP (.claude.json de la cuenta ilegible)".into());
        return;
    };
    let actuales = match cuenta.get("mcpServers") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(m)) => m.clone(),
        // Algo que no es un objeto: se prefiere no tocarlo a pisar lo que la cuenta tenga ahí.
        Some(_) => {
            reporte.skipped.push("MCP (.claude.json de la cuenta ilegible)".into());
            return;
        }
    };
    let faltan: Vec<(String, Value)> = usuario.iter().filter(|(k, _)| !actuales.contains_key(*k)).map(|(k, v)| (k.clone(), v.clone())).collect();
    let hay_nuevos = !faltan.is_empty();
    let mut todos = actuales;
    todos.extend(faltan);
    let nombres: Vec<String> = todos.keys().cloned().collect();
    if hay_nuevos {
        cuenta.insert("mcpServers".into(), Value::Object(todos));
        match escribir_json_atomico(&archivo, &Value::Object(cuenta)) {
            Ok(true) => {}
            Ok(false) => {
                reporte.skipped.push("MCP (.claude.json de la cuenta es de solo lectura)".into());
                return;
            }
            Err(e) => {
                reporte.skipped.push(format!("MCP ({e})"));
                return;
            }
        }
    }
    reporte.mcp_servers = nombres;
}

/// Enlaza o copia tu setup dentro de la carpeta de la cuenta. No toca el login ni nada que la cuenta ya tenga como
/// carpeta propia. `permitir_escritura_mcp` debe ser false si Claude está corriendo con esta cuenta: él también escribe ese archivo.
pub fn sincronizar_setup_compartido(cuenta: &CuentaSetup, home: &Path, permitir_escritura_mcp: bool) -> SetupSyncReport {
    let mut reporte = SetupSyncReport::default();
    let origen = dir_claude_usuario(home);
    if !cuenta.comparte() || !origen.exists() || !cuenta.config_dir.exists() {
        return reporte;
    }
    sincronizar_carpetas(&origen, cuenta.config_dir, &mut reporte);
    copiar_archivos(&origen, cuenta.config_dir, &mut reporte);
    let Some(Value::Object(mcp_usuario)) = leer_objeto_json(&json_claude_usuario(home)).and_then(|mut m| m.remove("mcpServers")) else {
        return reporte;
    };
    if permitir_escritura_mcp {
        sincronizar_mcp(&mcp_usuario, cuenta.config_dir, &mut reporte);
    } else {
        reporte.skipped.push("MCP (Claude está abierto con esta cuenta; se sincroniza al próximo arranque)".into());
    }
    reporte
}

/// Deshace lo que comparte Sloth: quita los junctions hacia ~/.claude. Los MCP agregados quedan.
pub fn dejar_de_compartir(cuenta: &CuentaSetup, home: &Path) -> std::io::Result<()> {
    let origen = dir_claude_usuario(home);
    for nombre in CARPETAS_COMPARTIDAS {
        let enlace = cuenta.config_dir.join(nombre);
        if es_enlace_a(&enlace, &origen.join(nombre)) {
            quitar_enlace(&enlace)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
