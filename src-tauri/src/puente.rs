//! Lo que el proceso de apoyo le avisa a Rust sobre las funciones que Rust atiende (`rust.*` en el puente nativo).
use crate::entorno::Entorno;
use crate::handlers::AlHook;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

pub struct Hooks(pub Vec<Arc<dyn AlHook>>);

pub fn atender(app: &AppHandle, op: &str, args: &[Value]) -> Result<Value, String> {
    match op {
        "rust.perfil" => {
            let entorno = app.try_state::<Arc<Entorno>>().ok_or("el entorno de Rust no está listo")?;
            let carpeta = fijar_perfil(&entorno, args.first())?;
            if let Some(h) = app.try_state::<Hooks>() {
                let hooks = h.0.clone();
                std::thread::spawn(move || hooks.iter().for_each(|f| f.al_perfil()));
            }
            Ok(Value::String(carpeta.to_string_lossy().into_owned()))
        }
        "rust.hook" => {
            let evento = args.first().and_then(Value::as_str).ok_or("falta el evento")?;
            let ws = args.get(1).and_then(Value::as_str);
            if let Some(h) = app.try_state::<Hooks>() {
                for f in &h.0 {
                    f.al_hook(evento, ws);
                }
            }
            Ok(Value::Null)
        }
        "rust.evento" => {
            let evento = args.first().and_then(Value::as_str).ok_or("falta el evento")?;
            let datos = args.get(1).unwrap_or(&Value::Null);
            if let Some(h) = app.try_state::<Hooks>() {
                for f in &h.0 {
                    f.al_evento(evento, datos);
                }
            }
            Ok(Value::Null)
        }
        _ => {
            let h = app.try_state::<Hooks>().ok_or("las funciones de Rust no están listas")?;
            h.0.iter().find_map(|f| f.nativo(op, args)).unwrap_or_else(|| Err(format!("operación desconocida: {op}")))
        }
    }
}

/// Cada evento hacia la UI pasa por acá: así una función de Rust se entera de lo que cambia en otro dueño (la bandeja,
/// de los agentes y permisos) sin que ese dueño la conozca.
pub fn al_evento_ui(app: &AppHandle, canal: &str) {
    if let Some(h) = app.try_state::<Hooks>() {
        for f in &h.0 {
            f.al_evento_ui(canal);
        }
    }
}

/// La carpeta del perfil tiene que ser una ruta absoluta que existe: de ahí cuelgan el estado y los archivos de cada función.
pub fn fijar_perfil(entorno: &Entorno, ruta: Option<&Value>) -> Result<PathBuf, String> {
    let ruta = PathBuf::from(ruta.and_then(Value::as_str).ok_or("falta la carpeta del perfil")?);
    if !ruta.is_absolute() || !ruta.is_dir() {
        return Err("la carpeta del perfil no es válida".into());
    }
    entorno.fijar_perfil(ruta.clone());
    Ok(ruta)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_comunes::EntornoDePrueba;
    use serde_json::json;

    #[test]
    fn el_perfil_avisado_tiene_que_ser_una_carpeta_absoluta_que_existe() {
        let t = EntornoDePrueba::sin_perfil("puente");
        assert!(t.entorno.perfil().is_err());
        assert!(fijar_perfil(&t.entorno, Some(&json!("relativa"))).is_err());
        assert!(fijar_perfil(&t.entorno, Some(&json!(t.carpeta.join("no-existe").to_string_lossy()))).is_err());
        assert!(fijar_perfil(&t.entorno, Some(&json!(7))).is_err());
        assert!(fijar_perfil(&t.entorno, None).is_err());
        assert!(t.entorno.perfil().is_err());
        let ok = t.carpeta.join("perfil");
        fijar_perfil(&t.entorno, Some(&json!(ok.to_string_lossy()))).unwrap();
        assert_eq!(t.entorno.perfil().unwrap(), ok);
    }
}
