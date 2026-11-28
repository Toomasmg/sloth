//! Estado del sistema que el main consulta de forma síncrona (tema, pantallas, batería, inicio con Windows):
//! se empuja al proceso de apoyo al arrancar y cada vez que cambia.
use crate::Apoyo;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager, Theme};
use tauri_plugin_autostart::ManagerExt;

pub fn es_oscuro(t: Theme) -> bool {
    t == Theme::Dark
}

fn pantallas(app: &AppHandle) -> Value {
    let monitores = app.available_monitors().unwrap_or_default();
    Value::Array(
        monitores
            .iter()
            .map(|m| {
                let f = m.scale_factor();
                // Todo en DIP, como `screen.getAllDisplays()` de Electron.
                let rect = |x: i32, y: i32, w: u32, h: u32| {
                    json!({ "x": (x as f64 / f).round(), "y": (y as f64 / f).round(), "width": (w as f64 / f).round(), "height": (h as f64 / f).round() })
                };
                let (p, t) = (m.position(), m.size());
                let a = m.work_area();
                json!({
                    "scaleFactor": f,
                    "bounds": rect(p.x, p.y, t.width, t.height),
                    "workArea": rect(a.position.x, a.position.y, a.size.width, a.size.height)
                })
            })
            .collect(),
    )
}

#[cfg(windows)]
fn con_corriente() -> Option<bool> {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut s = SYSTEM_POWER_STATUS { ACLineStatus: 255, BatteryFlag: 0, BatteryLifePercent: 0, SystemStatusFlag: 0, BatteryLifeTime: 0, BatteryFullLifeTime: 0 };
    // SAFETY: `s` es un SYSTEM_POWER_STATUS válido y vive durante la llamada.
    let ok = unsafe { GetSystemPowerStatus(&mut s) };
    (ok != 0 && s.ACLineStatus != 255).then_some(s.ACLineStatus == 1)
}

#[cfg(not(windows))]
fn con_corriente() -> Option<bool> {
    None
}

/// Lo que el main necesita saber apenas arranca, y el aviso cuando la batería o el tema cambian.
pub fn empujar_estado(app: &AppHandle) {
    let Some(a) = app.try_state::<Apoyo>() else { return };
    let apoyo = a.0.clone();
    apoyo.evento_nativo("screen:displays", json!([pantallas(app)]));
    if let Some(w) = app.get_webview_window("main") {
        if let Ok(t) = w.theme() {
            apoyo.evento_nativo("theme", json!([es_oscuro(t)]));
        }
    }
    let inicio = app.autolaunch().is_enabled().unwrap_or(false);
    apoyo.evento_nativo("login-item", json!([inicio]));
    std::thread::spawn(move || {
        let mut anterior: Option<bool> = None;
        loop {
            let ahora = con_corriente();
            if ahora != anterior {
                if let Some(c) = ahora {
                    apoyo.evento_nativo("power:battery", json!([!c]));
                    if anterior.is_some() {
                        apoyo.evento_nativo("power", json!([if c { "on-ac" } else { "on-battery" }]));
                    }
                }
                anterior = ahora;
            }
            std::thread::sleep(Duration::from_secs(15));
        }
    });
}
