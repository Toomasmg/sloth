//! Leer y guardar el estado de la ventana en `window-state.json`. Equivale a lo que no es de Electron en
//! src/main/window-state.ts; los monitores, los eventos de la ventana y el debounce los pone quien lo llama.
use crate::window_state_core::{elegir_bounds, leer_estado, Rect};
use serde_json::{json, Value};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

pub const DEBOUNCE_MS: u64 = 500;
pub const ARCHIVO: &str = "window-state.json";

#[derive(Debug, Default, PartialEq)]
pub struct EstadoCargado {
    pub bounds: Option<Rect>,
    pub maximized: bool,
}

pub fn ruta_estado(raiz_datos: &Path) -> PathBuf {
    raiz_datos.join(ARCHIVO)
}

/// Sin tirar nunca: si el archivo no está, está roto o el rectángulo ya no se ve en ningún monitor, vuelve vacío y la
/// ventana arranca con el tamaño por defecto. El `Err` es solo para que quien llama lo anote en el log.
pub fn cargar_estado(archivo: &Path, areas_de_trabajo: &[Rect]) -> Result<EstadoCargado, String> {
    let bytes = match fs::read(archivo) {
        Ok(b) => b,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(EstadoCargado::default()),
        Err(e) => return Err(format!("no se pudo leer el estado guardado: {e}")),
    };
    let guardado = leer_estado(&String::from_utf8_lossy(&bytes));
    let Some(bounds) = elegir_bounds(guardado.bounds, areas_de_trabajo) else { return Ok(EstadoCargado::default()) };
    Ok(EstadoCargado { bounds: Some(bounds), maximized: guardado.maximized == Some(true) })
}

/// JSON.stringify de un número entero no lleva `.0`: el archivo queda igual que el que escribía la versión de Electron.
fn numero(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

pub fn texto_de_estado(normales: Rect, maximizada: bool) -> String {
    json!({
        "bounds": { "x": numero(normales.x), "y": numero(normales.y), "width": numero(normales.width), "height": numero(normales.height) },
        "maximized": maximizada
    })
    .to_string()
}

/// `normales` son los bounds de la ventana sin maximizar. tmp + rename: un corte a la mitad no deja el JSON roto.
pub fn guardar_estado(archivo: &Path, normales: Rect, maximizada: bool) -> std::io::Result<()> {
    let mut tmp = archivo.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let r = fs::write(&tmp, texto_de_estado(normales, maximizada)).and_then(|()| fs::rename(&tmp, archivo));
    if r.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    r
}

#[cfg(test)]
mod tests;
