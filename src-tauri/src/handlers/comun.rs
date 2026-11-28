//! Lo que repiten las funciones del router: hora, rutas, cuentas y espacios del estado (solo lectura) y los pedidos al
//! dueño de las terminales y de los ajustes.
use crate::entorno::Entorno;
use serde_json::Value;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub fn ahora_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn texto(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(String::from)
}

/// Como `isDir` de git-run.ts: ruta absoluta, razonable y que exista como carpeta.
pub fn es_dir(p: &str) -> bool {
    !p.is_empty() && p.chars().count() <= 1024 && Path::new(p).is_absolute() && Path::new(p).is_dir()
}

/// UUID v4 como `randomUUID()` de Node.
pub fn nuevo_uuid() -> String {
    let h = sloth_core::daemon_protocolo::nuevo_nonce();
    format!("{}-{}-4{}-{:x}{}-{}", &h[0..8], &h[8..12], &h[13..16], (u8::from_str_radix(&h[16..17], 16).unwrap_or(0) & 0x3) | 0x8, &h[17..20], &h[20..32])
}

/// Último tramo de una ruta (`basename`), sin tocar el disco.
pub fn nombre_base(p: &str) -> String {
    p.split(['\\', '/']).rfind(|s| !s.is_empty()).unwrap_or_default().to_string()
}

/// Desfase de la hora local respecto de UTC en ese instante, en minutos (con horario de verano si aplica).
#[cfg(windows)]
pub fn desfase_local_min(ms: u64) -> i32 {
    use windows_sys::Win32::Foundation::{FILETIME, SYSTEMTIME};
    use windows_sys::Win32::System::Time::{FileTimeToSystemTime, SystemTimeToFileTime, SystemTimeToTzSpecificLocalTime};
    let ticks = (ms + 11_644_473_600_000) * 10_000;
    let ft = FILETIME { dwLowDateTime: ticks as u32, dwHighDateTime: (ticks >> 32) as u32 };
    // SAFETY: estructuras locales inicializadas en cero que las funciones llenan; sin punteros que sobrevivan.
    unsafe {
        let mut utc: SYSTEMTIME = std::mem::zeroed();
        let mut local: SYSTEMTIME = std::mem::zeroed();
        let mut ft_local: FILETIME = std::mem::zeroed();
        if FileTimeToSystemTime(&ft, &mut utc) == 0 || SystemTimeToTzSpecificLocalTime(std::ptr::null(), &utc, &mut local) == 0 || SystemTimeToFileTime(&local, &mut ft_local) == 0 {
            return 0;
        }
        let t_local = ((ft_local.dwHighDateTime as u64) << 32) | ft_local.dwLowDateTime as u64;
        ((t_local as i64 - ticks as i64) / 600_000_000) as i32
    }
}

#[cfg(not(windows))]
pub fn desfase_local_min(_: u64) -> i32 {
    0
}

/// `toLocaleDateString('sv-SE')`: `AAAA-MM-DD` en la hora local.
pub fn fecha_local(ms: u64) -> String {
    sloth_core::features::templates::hoy(ms as f64, desfase_local_min(ms))
}

pub fn cuentas(e: &Entorno) -> Vec<Value> {
    e.lista_del_estado("accounts")
}

pub fn cuenta(e: &Entorno, id: &str) -> Option<Value> {
    cuentas(e).into_iter().find(|a| a.get("id").and_then(Value::as_str) == Some(id))
}

pub fn espacios(e: &Entorno) -> Vec<Value> {
    e.lista_del_estado("workspaces")
}

/// Un ajuste de la Configuración, pedido a su dueño (Node o Rust): así se ve con sus valores por defecto y migraciones.
pub fn ajuste(e: &Entorno, clave: &str) -> Option<Value> {
    ajustes(e)?.get(clave).cloned()
}

/// Toda la Configuración ya saneada, como la ve la UI.
pub fn ajustes(e: &Entorno) -> Option<Value> {
    e.pedir("feat:settings:get", vec![], Duration::from_secs(5)).ok()?.get("settings").cloned()
}

/// Estado del dueño del store (con los agentes y el modo solo lectura), o `null` si no responde.
pub fn estado_del_dueno(e: &Entorno) -> Value {
    e.pedir("state:get", vec![], Duration::from_secs(20)).unwrap_or(Value::Null)
}

/// Como `exigirEscritura` del store, con el mismo texto: sin poder guardar no se empieza algo que lo cambie.
pub fn exigir_escritura(e: &Entorno) -> Result<(), String> {
    let Some(motivo) = estado_del_dueno(e).get("soloLectura").filter(|s| !s.is_null()).cloned() else { return Ok(()) };
    let consejo = if motivo.get("causa").and_then(Value::as_str) == Some("version-futura") {
        "Actualizá Sloth: esta versión es más vieja que tus datos."
    } else {
        "Reiniciá Sloth cuando sloth-state.json se pueda leer."
    };
    Err(format!("No se va a guardar: {}. {consejo}", texto(&motivo, "motivo").unwrap_or_default()))
}

/// La terminal de ese espacio está viva (el dueño de las terminales lo sabe; acá no se habla con el daemon).
pub fn terminal_viva(e: &Entorno, id: &str) -> Result<bool, String> {
    e.pedir("pty:running", vec![Value::from(id)], Duration::from_secs(10))
        .map(|v| v.as_bool().unwrap_or(false))
        .map_err(|_| "Todavía no puedo revisar las terminales abiertas. Probá de nuevo en un momento.".to_string())
}

/// Como `restartTerminal` del contexto de Node: se cierra la terminal y la UI vuelve a abrir el panel.
pub fn reiniciar_terminal(e: &Entorno, id: &str) -> Result<(), String> {
    e.pedir("pty:kill", vec![Value::from(id)], Duration::from_secs(15))?;
    ui(e, serde_json::json!({ "type": "restart-pane", "id": id }));
    Ok(())
}

pub fn ui(e: &Entorno, cmd: Value) {
    e.plataforma.enviar_a_la_ventana("ui:command", &[cmd]);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_nombre_base_ignora_barras_finales_y_mezcla_de_separadores() {
        assert_eq!(nombre_base(r"C:\repos\sloth\"), "sloth");
        assert_eq!(nombre_base("C:/a/b"), "b");
        assert_eq!(nombre_base(""), "");
    }

    #[test]
    fn el_uuid_es_v4() {
        let u = nuevo_uuid();
        assert!(sloth_core::history_core::es_uuid(&u), "{u}");
        assert_eq!(&u[14..15], "4");
        assert!("89ab".contains(&u[19..20]), "{u}");
    }

    #[test]
    fn la_fecha_local_sale_en_formato_sueco() {
        let f = fecha_local(1_764_245_000_000);
        assert_eq!(f.len(), 10);
        assert_eq!(&f[4..5], "-");
    }
}
