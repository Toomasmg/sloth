//! Lo nativo que el main pide por el puente (`native` en src/sidecar/rpc.ts): shell, portapapeles,
//! diálogos, ventana y notificaciones. Lo que no está acá responde error y el main lo toma como "no disponible".
use base64::Engine;
use serde_json::{json, Value};
use tauri::image::Image;
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, UserAttentionType};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

fn texto(args: &[Value], i: usize) -> Result<String, String> {
    args.get(i).and_then(Value::as_str).map(str::to_owned).ok_or_else(|| format!("falta el argumento {i}"))
}

fn ventana(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window("main").ok_or_else(|| "no hay ventana".to_string())
}

fn cadena<'a>(o: &'a Value, k: &str) -> Option<&'a str> {
    o.get(k).and_then(Value::as_str)
}

fn filtros(o: &Value) -> Vec<(String, Vec<String>)> {
    o.get("filters")
        .and_then(Value::as_array)
        .map(|fs| {
            fs.iter()
                .map(|f| {
                    let exts = f
                        .get("extensions")
                        .and_then(Value::as_array)
                        .map(|e| e.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
                        .unwrap_or_default();
                    (cadena(f, "name").unwrap_or("").to_string(), exts)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn dialogo_abrir(app: &AppHandle, o: &Value) -> Result<Value, String> {
    let props: Vec<&str> =
        o.get("properties").and_then(Value::as_array).map(|p| p.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let mut d = app.dialog().file();
    if let Some(t) = cadena(o, "title") {
        d = d.set_title(t);
    }
    if let Some(p) = cadena(o, "defaultPath") {
        d = d.set_directory(p);
    }
    for (nombre, exts) in filtros(o) {
        let e: Vec<&str> = exts.iter().map(String::as_str).collect();
        d = d.add_filter(nombre, &e);
    }
    let elegidos: Vec<_> = if props.contains(&"openDirectory") {
        d.blocking_pick_folder().into_iter().collect()
    } else if props.contains(&"multiSelections") {
        d.blocking_pick_files().unwrap_or_default()
    } else {
        d.blocking_pick_file().into_iter().collect()
    };
    let rutas: Vec<String> = elegidos.into_iter().filter_map(|f| f.into_path().ok()).map(|p| p.to_string_lossy().into_owned()).collect();
    Ok(json!({ "canceled": rutas.is_empty(), "filePaths": rutas }))
}

fn dialogo_guardar(app: &AppHandle, o: &Value) -> Result<Value, String> {
    let mut d = app.dialog().file();
    if let Some(t) = cadena(o, "title") {
        d = d.set_title(t);
    }
    if let Some(p) = cadena(o, "defaultPath") {
        let ruta = std::path::Path::new(p);
        if let Some(dir) = ruta.parent().filter(|d| !d.as_os_str().is_empty()) {
            d = d.set_directory(dir);
        }
        if let Some(n) = ruta.file_name() {
            d = d.set_file_name(n.to_string_lossy());
        }
    }
    for (nombre, exts) in filtros(o) {
        let e: Vec<&str> = exts.iter().map(String::as_str).collect();
        d = d.add_filter(nombre, &e);
    }
    let ruta = d.blocking_save_file().and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().into_owned());
    Ok(json!({ "canceled": ruta.is_none(), "filePath": ruta }))
}

fn dialogo_mensaje(app: &AppHandle, o: &Value) -> Result<Value, String> {
    let botones: Vec<String> =
        o.get("buttons").and_then(Value::as_array).map(|b| b.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default();
    let mut d = app.dialog().message(cadena(o, "message").or(cadena(o, "detail")).unwrap_or("")).title(cadena(o, "title").unwrap_or("Sloth"));
    if botones.len() >= 2 {
        d = d.buttons(MessageDialogButtons::OkCancelCustom(botones[0].clone(), botones[1].clone()));
    }
    // Tauri solo distingue aceptar de cancelar: aceptar es el primer botón (índice 0) y cancelar el segundo.
    let acepto = d.blocking_show();
    Ok(json!({ "response": if acepto { 0 } else { botones.len().saturating_sub(1).min(1) }, "checkboxChecked": false }))
}

type Elemento = Box<dyn IsMenuItem<tauri::Wry>>;

fn elementos_de_menu(app: &AppHandle, items: &[Value]) -> Result<Vec<Elemento>, String> {
    let mut out: Vec<Elemento> = Vec::new();
    for it in items {
        let activo = it.get("enabled").and_then(Value::as_bool).unwrap_or(true);
        let etiqueta = cadena(it, "label").unwrap_or("");
        if it.get("separator") == Some(&Value::Bool(true)) {
            out.push(Box::new(PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?));
        } else if let Some(hijos) = it.get("items").and_then(Value::as_array) {
            let hijos = elementos_de_menu(app, hijos)?;
            let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = hijos.iter().map(|h| h.as_ref()).collect();
            out.push(Box::new(Submenu::with_items(app, etiqueta, activo, &refs).map_err(|e| e.to_string())?));
        } else {
            let id = it.get("id").and_then(Value::as_u64).unwrap_or(0).to_string();
            out.push(Box::new(MenuItem::with_id(app, id, etiqueta, activo, None::<&str>).map_err(|e| e.to_string())?));
        }
    }
    Ok(out)
}

fn bandeja(app: &AppHandle, o: &Value) -> Result<Value, String> {
    let items = o.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
    let elementos = elementos_de_menu(app, &items)?;
    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = elementos.iter().map(|e| e.as_ref()).collect();
    let menu = Menu::with_items(app, &refs).map_err(|e| e.to_string())?;
    let icono = cadena(o, "icon")
        .filter(|i| !i.is_empty())
        .and_then(|i| base64::engine::general_purpose::STANDARD.decode(i).ok())
        .and_then(|png| Image::from_bytes(&png).ok());
    let tip = cadena(o, "tooltip").unwrap_or("Sloth");
    if let Some(t) = app.tray_by_id("sloth") {
        t.set_menu(Some(menu)).map_err(|e| e.to_string())?;
        t.set_tooltip(Some(tip)).map_err(|e| e.to_string())?;
        if let Some(i) = icono {
            t.set_icon(Some(i)).map_err(|e| e.to_string())?;
        }
        return Ok(Value::Null);
    }
    let mut b = TrayIconBuilder::with_id("sloth")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(tip)
        .on_menu_event(|app, e| {
            if let (Some(a), Ok(n)) = (app.try_state::<crate::Apoyo>(), e.id().as_ref().parse::<u64>()) {
                a.0.evento_nativo("tray", json!(["menu", n]));
            }
        })
        .on_tray_icon_event(|t, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                if let Some(a) = t.app_handle().try_state::<crate::Apoyo>() {
                    a.0.evento_nativo("tray", json!(["activate"]));
                }
            }
        });
    if let Some(i) = icono.or_else(|| app.default_window_icon().cloned()) {
        b = b.icon(i);
    }
    b.build(app).map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

pub fn atender(app: &AppHandle, op: &str, args: Vec<Value>) -> Result<Value, String> {
    let nulo = Ok(Value::Null);
    match op {
        "shell.openExternal" => {
            let url = texto(&args, 0)?;
            // Solo web y correo: un esquema raro no sale de la app hacia el sistema.
            if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:")) {
                return Err("esquema no permitido".into());
            }
            app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())?;
            nulo
        }
        "shell.openPath" => {
            app.opener().open_path(texto(&args, 0)?, None::<&str>).map_err(|e| e.to_string())?;
            nulo
        }
        "shell.showItemInFolder" => {
            app.opener().reveal_item_in_dir(texto(&args, 0)?).map_err(|e| e.to_string())?;
            nulo
        }
        "clipboard.readText" => Ok(Value::String(app.clipboard().read_text().unwrap_or_default())),
        "clipboard.writeText" => {
            app.clipboard().write_text(texto(&args, 0)?).map_err(|e| e.to_string())?;
            nulo
        }
        "dialog.open" => dialogo_abrir(app, args.first().unwrap_or(&Value::Null)),
        "dialog.save" => dialogo_guardar(app, args.first().unwrap_or(&Value::Null)),
        "dialog.message" => dialogo_mensaje(app, args.first().unwrap_or(&Value::Null)),
        "dialog.error" => {
            app.dialog().message(texto(&args, 1)?).title(texto(&args, 0)?).blocking_show();
            nulo
        }
        "notification.show" => {
            let d = args.get(1).cloned().unwrap_or(Value::Null);
            app.notification()
                .builder()
                .title(cadena(&d, "title").unwrap_or("Sloth"))
                .body(cadena(&d, "body").unwrap_or(""))
                .show()
                .map_err(|e| e.to_string())?;
            nulo
        }
        "window.show" => ventana(app)?.show().map_err(|e| e.to_string()).map(|_| Value::Null),
        "window.hide" => ventana(app)?.hide().map_err(|e| e.to_string()).map(|_| Value::Null),
        "window.focus" => ventana(app)?.set_focus().map_err(|e| e.to_string()).map(|_| Value::Null),
        "window.restore" => {
            let w = ventana(app)?;
            let _ = w.unminimize();
            let _ = w.unmaximize();
            nulo
        }
        "window.maximize" => ventana(app)?.maximize().map_err(|e| e.to_string()).map(|_| Value::Null),
        "window.close" => ventana(app)?.close().map_err(|e| e.to_string()).map(|_| Value::Null),
        "window.flash" => {
            let pide = args.first().and_then(Value::as_bool).unwrap_or(false);
            ventana(app)?
                .request_user_attention(if pide { Some(UserAttentionType::Informational) } else { None })
                .map_err(|e| e.to_string())
                .map(|_| Value::Null)
        }
        "window.setBounds" => {
            let w = ventana(app)?;
            let b = args.first().cloned().unwrap_or(Value::Null);
            let n = |k: &str| b.get(k).and_then(Value::as_i64).unwrap_or(0);
            // Los rectángulos del main son lógicos (DIP), como los de Electron.
            let _ = w.set_position(LogicalPosition::new(n("x") as f64, n("y") as f64));
            let _ = w.set_size(LogicalSize::new(n("width") as f64, n("height") as f64));
            nulo
        }
        "window.setZoom" => {
            // Electron usa niveles (1.2^n); el webview toma el factor.
            let nivel = args.first().and_then(Value::as_f64).unwrap_or(0.0);
            ventana(app)?.set_zoom(1.2f64.powf(nivel)).map_err(|e| e.to_string()).map(|_| Value::Null)
        }
        "tray.set" => bandeja(app, args.first().unwrap_or(&Value::Null)),
        "tray.destroy" => {
            app.remove_tray_by_id("sloth");
            nulo
        }
        "app.quit" => {
            app.exit(0);
            nulo
        }
        "app.exit" => {
            app.exit(args.first().and_then(Value::as_i64).unwrap_or(0) as i32);
            nulo
        }
        "app.relaunch" => app.restart(),
        otro => Err(format!("operación nativa no disponible todavía: {otro}")),
    }
}
