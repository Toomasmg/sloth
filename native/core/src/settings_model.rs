//! Modelo de la Configuración de Sloth: valores por defecto y validación estricta. Equivale a src/shared/settings-model.ts.
//! Los ajustes son un objeto JSON tal cual (con el orden de claves del archivo): lo que se guarda en disco queda igual que
//! con la versión en TypeScript.
use crate::perfiles_core::es_blanco_js;
use crate::versionado::Objeto;
use serde_json::{json, Value};

pub use crate::cupo::TOPE_MAX;

pub const THEMES: [&str; 4] = ["oscuro", "noche", "claro", "sistema"];
pub const DENSITIES: [&str; 2] = ["compacta", "cómoda"];
pub const TERM_FONTS: [&str; 3] = ["JetBrains Mono", "Cascadia Code", "Consolas"];
pub const CURSORS: [&str; 3] = ["barra", "bloque", "subrayado"];
pub const ACCENTS: [&str; 4] = ["cielo", "hoja", "lila", "ambar"];
pub const SHELLS: [&str; 4] = ["PowerShell 7", "Windows PowerShell", "Git Bash", "Símbolo del sistema"];
pub const EDITORS: [&str; 4] = ["VS Code", "Cursor", "Windsurf", "Bloc de notas"];
pub const SOUND_NAMES: [&str; 3] = ["Gota", "Campana suave", "Clic"];
pub const UPDATE_CHANNELS: [&str; 2] = ["estable", "beta"];
pub const SHORTCUT_IDS: [&str; 16] = [
    "palette", "new", "sidebar", "broadcast", "layout", "settings", "chat", "history", "rename", "help", "focus1", "focus2", "focus3", "focus4", "broadcastNow", "dictado",
];
pub const SLEEP_MINUTES: [f64; 5] = [0.0, 15.0, 30.0, 60.0, 120.0];
pub const SECTIONS: [&str; 8] = ["apariencia", "terminal", "cuentas", "general", "notif", "atajos", "updates", "rendimiento"];

pub const UI_FONT: (f64, f64) = (12.0, 16.0);
pub const TERM_FONT: (f64, f64) = (11.0, 18.0);
pub const LINE_HEIGHT: (f64, f64, f64) = (1.0, 1.4, 0.05);
pub const SCROLLBACK: (f64, f64) = (1000.0, 20000.0);
pub const RAM_MB: (f64, f64) = (2048.0, 1_048_576.0);
pub const NUCLEOS_MAX: f64 = 64.0;
pub const MAX_PLAN: usize = 20;
pub const MAX_ACCOUNT_COLORS: usize = 64;
pub const MAX_SHORTCUTS: usize = 32;
const MAX_PATH: usize = 260;

/// Colores de cuenta elegibles: tonos medios que superan 3:1 sobre el fondo oscuro y sobre el claro.
pub const ACCOUNT_PALETTE: [(&str, &str); 11] = [
    ("#3b82f6", "Azul"),
    ("#6366f1", "Índigo"),
    ("#8b5cf6", "Violeta"),
    ("#d946ef", "Fucsia"),
    ("#e11d74", "Frambuesa"),
    ("#ef4444", "Rojo"),
    ("#ea580c", "Naranja"),
    ("#b07d10", "Mostaza"),
    ("#159a46", "Verde"),
    ("#0d9488", "Turquesa"),
    ("#0891b2", "Cian"),
];

pub fn por_defecto() -> Objeto {
    let v = json!({
        "theme": "oscuro",
        "density": "compacta",
        "uiFontSize": 13,
        "accent": "cielo",
        "terminal": { "fontSize": 12.5, "fontFamily": "JetBrains Mono", "lineHeight": 1, "cursorStyle": "barra", "cursorBlink": true, "shell": "PowerShell 7", "scrollback": 5000 },
        "accountColors": {},
        "accountPlans": {},
        "accountCupos": {},
        "openAtLogin": false,
        "confirmClosePanes": true,
        "reopenSpaces": true,
        "keepTerminalsAlive": true,
        "confirmQuit": true,
        "sleepAfterMin": 0,
        "editor": "VS Code",
        "projectsDir": "",
        "sounds": false,
        "soundName": "Gota",
        "noMolestar": false,
        "notify": { "done": true, "perm": true, "team": true, "soundIn": true, "soundOut": true },
        "updateChannel": "estable",
        "lightMode": false,
        "shortcuts": {},
        "rendimiento": { "enchufada": { "ramMB": 0, "nucleos": 0 }, "bateria": { "ramMB": 0, "nucleos": 0 }, "bateriaDistinta": false }
    });
    match v {
        Value::Object(o) => o,
        _ => unreachable!(),
    }
}

/* ---------- Atajos: formato canónico «Ctrl Alt Shift Tecla» ---------- */

const NAMED_KEYS: [&str; 10] = ["Enter", "Space", "Tab", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown", "Insert"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Combo {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub key: String,
}

fn es_f(raw: &str) -> bool {
    raw.len() >= 2 && raw.len() <= 3 && raw.starts_with(['f', 'F']) && raw[1..].bytes().all(|b| b.is_ascii_digit())
}

fn tecla_canonica(raw: &str) -> String {
    if raw.encode_utf16().count() == 1 {
        return raw.to_uppercase();
    }
    if es_f(raw) {
        return raw.to_uppercase();
    }
    NAMED_KEYS.iter().find(|k| k.eq_ignore_ascii_case(raw)).map(|k| k.to_string()).unwrap_or_else(|| raw.to_string())
}

fn es_funcion_valida(k: &str) -> bool {
    k.strip_prefix('F').and_then(|n| n.parse::<u8>().ok()).is_some_and(|n| (1..=12).contains(&n)) && !k[1..].starts_with('0') && k[1..].bytes().all(|b| b.is_ascii_digit())
}

fn es_tecla_valida(k: &str) -> bool {
    let mut c = k.chars();
    let una = c.next().is_some_and(|x| x.is_ascii_uppercase() || x.is_ascii_digit() || "←→↑↓,.;-=/".contains(x)) && c.next().is_none();
    una || es_funcion_valida(k) || NAMED_KEYS.contains(&k)
}

/// Lee «Ctrl Shift k» o «Ctrl Shift K» → partes. None si no es una combinación válida.
pub fn leer_combo(raw: &str) -> Option<Combo> {
    let tokens: Vec<&str> = raw.split(es_blanco_js).filter(|t| !t.is_empty()).collect();
    // Una tecla de función sola (F2) también es una combinación válida.
    if tokens.len() == 1 && es_funcion_valida(&tecla_canonica(tokens[0])) {
        return Some(Combo { ctrl: false, alt: false, shift: false, key: tecla_canonica(tokens[0]) });
    }
    if tokens.len() < 2 {
        return None;
    }
    let key = tecla_canonica(tokens[tokens.len() - 1]);
    if !es_tecla_valida(&key) {
        return None;
    }
    let mut vistos: Vec<&str> = Vec::new();
    for m in &tokens[..tokens.len() - 1] {
        let canon = ["Ctrl", "Alt", "Shift"].into_iter().find(|x| x.eq_ignore_ascii_case(m))?;
        if vistos.contains(&canon) {
            return None;
        }
        vistos.push(canon);
    }
    if !vistos.contains(&"Ctrl") && !vistos.contains(&"Alt") {
        return None;
    }
    Some(Combo { ctrl: vistos.contains(&"Ctrl"), alt: vistos.contains(&"Alt"), shift: vistos.contains(&"Shift"), key })
}

/// Forma canónica de una combinación válida, o None.
pub fn combo_canonico(raw: &str) -> Option<String> {
    let p = leer_combo(raw)?;
    let partes: Vec<&str> = [p.ctrl.then_some("Ctrl"), p.alt.then_some("Alt"), p.shift.then_some("Shift"), Some(p.key.as_str())].into_iter().flatten().collect();
    Some(partes.join(" "))
}

/* ---------- Validación ---------- */

fn revisar_claves(o: &Objeto, permitidas: &[&str], donde: &str) -> Result<(), String> {
    match o.keys().find(|k| !permitidas.contains(&k.as_str())) {
        Some(k) => Err(format!("Ajuste desconocido: {donde}{k}.")),
        None => Ok(()),
    }
}

fn uno_de(v: &Value, lista: &[&str], etiqueta: &str) -> Result<String, String> {
    match v.as_str() {
        Some(s) if lista.contains(&s) => Ok(s.to_string()),
        _ => Err(format!("{etiqueta} tiene que ser {}.", lista.iter().map(|x| format!("«{x}»")).collect::<Vec<_>>().join(", "))),
    }
}

fn entero_en(v: &Value, min: f64, max: f64, etiqueta: &str) -> Result<Value, String> {
    match v.as_f64() {
        Some(n) if n.fract() == 0.0 && n >= min && n <= max => Ok(Value::from(n as i64)),
        _ => Err(format!("{etiqueta} tiene que ser un entero entre {} y {}.", num(min), num(max))),
    }
}

/// Un número como lo muestra JavaScript en un texto.
fn num(n: f64) -> String {
    if n.fract() == 0.0 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

fn booleano(v: &Value, etiqueta: &str) -> Result<Value, String> {
    v.as_bool().map(Value::Bool).ok_or_else(|| format!("{etiqueta} tiene que ser sí o no."))
}

/// `Math.round` de JavaScript.
fn redondear(n: f64) -> f64 {
    (n + 0.5).floor()
}

fn altura_de_linea(v: &Value) -> Result<Value, String> {
    let n = v.as_f64().filter(|n| n.is_finite()).ok_or("La altura de línea tiene que ser un número.")?;
    let r = redondear(redondear(n / LINE_HEIGHT.2) * LINE_HEIGHT.2 * 100.0) / 100.0;
    if (r - n).abs() > 1e-6 || r < LINE_HEIGHT.0 || r > LINE_HEIGHT.1 {
        return Err(format!("La altura de línea va de {} a {}, en pasos de {}.", num(LINE_HEIGHT.0), num(LINE_HEIGHT.1), num(LINE_HEIGHT.2)));
    }
    Ok(if r.fract() == 0.0 { Value::from(r as i64) } else { Value::from(r) })
}

fn ram_mb(v: &Value) -> Result<Value, String> {
    if v.as_f64() == Some(0.0) {
        return Ok(Value::from(0));
    }
    entero_en(v, RAM_MB.0, RAM_MB.1, "La RAM máxima (en MB, 0 = sin límite)")
}

fn perfil_rendimiento(actual: &Value, v: &Value, donde: &str) -> Result<Value, String> {
    let o = v.as_object().ok_or_else(|| format!("{donde} tiene que ser un objeto."))?;
    revisar_claves(o, &["ramMB", "nucleos"], &format!("{donde}."))?;
    let mut out = actual.as_object().cloned().unwrap_or_default();
    if let Some(r) = o.get("ramMB") {
        out.insert("ramMB".into(), ram_mb(r)?);
    }
    if let Some(n) = o.get("nucleos") {
        out.insert("nucleos".into(), entero_en(n, 0.0, NUCLEOS_MAX, "Los núcleos (0 = todos)")?);
    }
    Ok(Value::Object(out))
}

fn tiene_control(s: &str) -> bool {
    s.chars().any(|c| matches!(c, '\u{0}'..='\u{1f}'))
}

fn texto_plan(v: &Value) -> Result<String, String> {
    let t = v.as_str().ok_or("El plan tiene que ser texto.")?.trim_matches(es_blanco_js);
    if t.encode_utf16().count() > MAX_PLAN || tiene_control(t) {
        return Err(format!("El plan puede tener hasta {MAX_PLAN} caracteres."));
    }
    Ok(t.to_string())
}

fn carpeta_de_proyectos(v: &Value) -> Result<String, String> {
    let t = v.as_str().ok_or("La carpeta de proyectos tiene que ser texto.")?.trim_matches(es_blanco_js);
    if t.encode_utf16().count() > MAX_PATH || tiene_control(t) {
        return Err("La carpeta de proyectos no es válida.".into());
    }
    Ok(t.to_string())
}

fn id_de_cuenta_valido(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn sub<'a>(o: &'a mut Objeto, k: &str) -> &'a mut Objeto {
    if !o.get(k).is_some_and(Value::is_object) {
        o.insert(k.into(), json!({}));
    }
    o.get_mut(k).and_then(Value::as_object_mut).expect("recién creado")
}

/// Aplica un cambio parcial validado. Cualquier clave desconocida o valor fuera de rango falla (no se aplica nada a
/// medias). Los mapas son parches: `accountColors` y `shortcuts` asignan con un valor y quitan con null; `terminal` y
/// `notify` se fusionan campo por campo. Con `existe_cuenta` solo se aceptan datos de cuentas que existen (quitar siempre se puede).
pub fn aplicar_cambio(actual: &Objeto, patch: &Value, existe_cuenta: Option<&dyn Fn(&str) -> bool>) -> Result<Objeto, String> {
    let p = patch.as_object().ok_or("El cambio de configuración tiene que ser un objeto.")?;
    revisar_claves(
        p,
        &[
            "theme", "density", "uiFontSize", "accent", "terminal", "accountColors", "accountPlans", "accountCupos", "openAtLogin", "confirmClosePanes", "reopenSpaces", "keepTerminalsAlive", "confirmQuit", "sleepAfterMin", "editor",
            "projectsDir", "sounds", "soundName", "noMolestar", "notify", "updateChannel", "lightMode", "shortcuts", "rendimiento",
        ],
        "",
    )?;
    let mut next = actual.clone();
    let cuenta_ok = |id: &str| existe_cuenta.is_none_or(|f| f(id));
    let mut poner = |o: &mut Objeto, k: &str, v: Value| {
        o.insert(k.into(), v);
    };
    if let Some(v) = p.get("theme") {
        poner(&mut next, "theme", Value::String(uno_de(v, &THEMES, "El tema")?));
    }
    if let Some(v) = p.get("density") {
        poner(&mut next, "density", Value::String(uno_de(v, &DENSITIES, "La densidad")?));
    }
    if let Some(v) = p.get("uiFontSize") {
        poner(&mut next, "uiFontSize", entero_en(v, UI_FONT.0, UI_FONT.1, "El tamaño de letra")?);
    }
    if let Some(v) = p.get("accent") {
        poner(&mut next, "accent", Value::String(uno_de(v, &ACCENTS, "El color de acento")?));
    }
    for (k, etiqueta) in [
        ("openAtLogin", "«Abrir al iniciar Windows»"),
        ("confirmClosePanes", "«Confirmar al cerrar»"),
        ("reopenSpaces", "«Reabrir los espacios»"),
        ("keepTerminalsAlive", "«Terminales vivas»"),
        ("confirmQuit", "«Preguntar antes de cerrar Sloth»"),
    ] {
        if let Some(v) = p.get(k) {
            poner(&mut next, k, booleano(v, etiqueta)?);
        }
    }
    if let Some(v) = p.get("sleepAfterMin") {
        match v.as_f64() {
            Some(n) if SLEEP_MINUTES.contains(&n) => poner(&mut next, "sleepAfterMin", Value::from(n as i64)),
            _ => return Err(format!("«Dormir espacios inactivos» tiene que ser {}.", SLEEP_MINUTES.iter().map(|m| num(*m)).collect::<Vec<_>>().join(", "))),
        }
    }
    if let Some(v) = p.get("editor") {
        poner(&mut next, "editor", Value::String(uno_de(v, &EDITORS, "El editor")?));
    }
    if let Some(v) = p.get("projectsDir") {
        poner(&mut next, "projectsDir", Value::String(carpeta_de_proyectos(v)?));
    }
    if let Some(v) = p.get("sounds") {
        poner(&mut next, "sounds", booleano(v, "«Sonidos»")?);
    }
    if let Some(v) = p.get("soundName") {
        poner(&mut next, "soundName", Value::String(uno_de(v, &SOUND_NAMES, "El sonido")?));
    }
    if let Some(v) = p.get("noMolestar") {
        poner(&mut next, "noMolestar", booleano(v, "«No molestar»")?);
    }
    if let Some(v) = p.get("updateChannel") {
        poner(&mut next, "updateChannel", Value::String(uno_de(v, &UPDATE_CHANNELS, "El canal de actualizaciones")?));
    }
    if let Some(v) = p.get("lightMode") {
        poner(&mut next, "lightMode", booleano(v, "«Modo liviano»")?);
    }
    if let Some(t) = p.get("terminal") {
        let t = t.as_object().ok_or("terminal tiene que ser un objeto.")?;
        revisar_claves(t, &["fontSize", "fontFamily", "lineHeight", "cursorStyle", "cursorBlink", "shell", "scrollback"], "terminal.")?;
        let term = sub(&mut next, "terminal");
        if let Some(v) = t.get("fontSize") {
            term.insert("fontSize".into(), entero_en(v, TERM_FONT.0, TERM_FONT.1, "El tamaño de la terminal")?);
        }
        if let Some(v) = t.get("fontFamily") {
            term.insert("fontFamily".into(), Value::String(uno_de(v, &TERM_FONTS, "La fuente")?));
        }
        if let Some(v) = t.get("lineHeight") {
            term.insert("lineHeight".into(), altura_de_linea(v)?);
        }
        if let Some(v) = t.get("cursorStyle") {
            term.insert("cursorStyle".into(), Value::String(uno_de(v, &CURSORS, "El cursor")?));
        }
        if let Some(v) = t.get("cursorBlink") {
            term.insert("cursorBlink".into(), booleano(v, "El parpadeo")?);
        }
        if let Some(v) = t.get("shell") {
            term.insert("shell".into(), Value::String(uno_de(v, &SHELLS, "El shell")?));
        }
        if let Some(v) = t.get("scrollback") {
            term.insert("scrollback".into(), entero_en(v, SCROLLBACK.0, SCROLLBACK.1, "El historial de la terminal")?);
        }
    }
    if let Some(n) = p.get("notify") {
        let n = n.as_object().ok_or("notify tiene que ser un objeto.")?;
        revisar_claves(n, &["done", "perm", "team", "soundIn", "soundOut"], "notify.")?;
        let notify = sub(&mut next, "notify");
        for (k, etiqueta) in [("done", "«Claude termina una tarea»"), ("perm", "«Claude pide permiso»"), ("team", "«Mensajes del equipo»"), ("soundIn", "«Sonido al recibir mensajes»"), ("soundOut", "«Sonido al enviar mensajes»")] {
            if let Some(v) = n.get(k) {
                notify.insert(k.into(), booleano(v, etiqueta)?);
            }
        }
    }
    if let Some(r) = p.get("rendimiento") {
        let r = r.as_object().ok_or("rendimiento tiene que ser un objeto.")?;
        revisar_claves(r, &["enchufada", "bateria", "bateriaDistinta"], "rendimiento.")?;
        let rend = sub(&mut next, "rendimiento");
        for perfil in ["enchufada", "bateria"] {
            if let Some(v) = r.get(perfil) {
                let nuevo = perfil_rendimiento(rend.get(perfil).unwrap_or(&Value::Null), v, &format!("rendimiento.{perfil}"))?;
                rend.insert(perfil.into(), nuevo);
            }
        }
        if let Some(v) = r.get("bateriaDistinta") {
            rend.insert("bateriaDistinta".into(), booleano(v, "«Otro límite con batería»")?);
        }
    }
    if let Some(c) = p.get("accountColors") {
        let c = c.as_object().ok_or("accountColors tiene que ser un objeto.")?;
        let mapa = sub(&mut next, "accountColors");
        for (id, color) in c {
            if !id_de_cuenta_valido(id) {
                return Err("Id de cuenta inválido.".into());
            }
            if color.is_null() {
                mapa.shift_remove(id);
                continue;
            }
            let hex = color.as_str().map(str::to_lowercase).filter(|h| ACCOUNT_PALETTE.iter().any(|(p, _)| p == h)).ok_or("Ese color no está en la paleta.")?;
            if !cuenta_ok(id) {
                return Err("Esa cuenta no existe.".into());
            }
            mapa.insert(id.clone(), Value::String(hex));
        }
        if mapa.len() > MAX_ACCOUNT_COLORS {
            return Err("Demasiados colores de cuenta.".into());
        }
    }
    if let Some(pl) = p.get("accountPlans") {
        let pl = pl.as_object().ok_or("accountPlans tiene que ser un objeto.")?;
        let mapa = sub(&mut next, "accountPlans");
        for (id, plan) in pl {
            if !id_de_cuenta_valido(id) {
                return Err("Id de cuenta inválido.".into());
            }
            if plan.is_null() || plan.as_str() == Some("") {
                mapa.shift_remove(id);
                continue;
            }
            if !cuenta_ok(id) {
                return Err("Esa cuenta no existe.".into());
            }
            mapa.insert(id.clone(), Value::String(texto_plan(plan)?));
        }
        if mapa.len() > MAX_ACCOUNT_COLORS {
            return Err("Demasiados planes de cuenta.".into());
        }
    }
    if let Some(cu) = p.get("accountCupos") {
        let cu = cu.as_object().ok_or("accountCupos tiene que ser un objeto.")?;
        let mapa = sub(&mut next, "accountCupos");
        for (id, tope) in cu {
            if !id_de_cuenta_valido(id) {
                return Err("Id de cuenta inválido.".into());
            }
            if tope.is_null() || tope.as_f64() == Some(0.0) {
                mapa.shift_remove(id);
                continue;
            }
            if !cuenta_ok(id) {
                return Err("Esa cuenta no existe.".into());
            }
            mapa.insert(id.clone(), entero_en(tope, 1.0, TOPE_MAX, "El tope de la ventana de 5 h")?);
        }
        if mapa.len() > MAX_ACCOUNT_COLORS {
            return Err("Demasiados topes de cuenta.".into());
        }
    }
    if let Some(s) = p.get("shortcuts") {
        let s = s.as_object().ok_or("shortcuts tiene que ser un objeto.")?;
        let mapa = sub(&mut next, "shortcuts");
        for (id, combo) in s {
            if !SHORTCUT_IDS.contains(&id.as_str()) {
                return Err(format!("Atajo desconocido: {id}."));
            }
            if combo.is_null() {
                mapa.shift_remove(id);
                continue;
            }
            let canon = combo.as_str().and_then(combo_canonico).ok_or("La combinación de teclas no es válida. Usá Ctrl o Alt, más una tecla.")?;
            mapa.insert(id.clone(), Value::String(canon));
        }
        if mapa.len() > MAX_SHORTCUTS {
            return Err("Demasiados atajos personalizados.".into());
        }
    }
    Ok(next)
}

/// Lee lo guardado en disco con tolerancia: cada campo inválido vuelve a su valor por defecto.
pub fn normalizar(raw: &Value) -> Objeto {
    let mut out = por_defecto();
    let Some(src) = raw.as_object() else { return out };
    let mut intentar = |out: &mut Objeto, p: Value| {
        // Un campo inválido queda con el valor por defecto.
        if let Ok(n) = aplicar_cambio(out, &p, None) {
            *out = n;
        }
    };
    for k in [
        "theme", "density", "uiFontSize", "accent", "openAtLogin", "confirmClosePanes", "reopenSpaces", "keepTerminalsAlive", "confirmQuit", "sleepAfterMin", "editor", "projectsDir", "sounds", "soundName", "noMolestar", "updateChannel",
        "lightMode",
    ] {
        if let Some(v) = src.get(k) {
            intentar(&mut out, json!({ k: v }));
        }
    }
    for grupo in ["terminal", "notify"] {
        if let Some(Value::Object(g)) = src.get(grupo) {
            for (k, v) in g {
                intentar(&mut out, json!({ grupo: { k: v } }));
            }
        }
    }
    if let Some(Value::Object(r)) = src.get("rendimiento") {
        if let Some(v) = r.get("bateriaDistinta") {
            intentar(&mut out, json!({ "rendimiento": { "bateriaDistinta": v } }));
        }
        for perfil in ["enchufada", "bateria"] {
            if let Some(Value::Object(pr)) = r.get(perfil) {
                for (k, v) in pr {
                    intentar(&mut out, json!({ "rendimiento": { perfil: { k: v } } }));
                }
            }
        }
    }
    for (grupo, tope) in [("accountColors", MAX_ACCOUNT_COLORS), ("accountPlans", MAX_ACCOUNT_COLORS), ("accountCupos", MAX_ACCOUNT_COLORS), ("shortcuts", MAX_SHORTCUTS)] {
        if let Some(Value::Object(g)) = src.get(grupo) {
            for (id, v) in g.iter().take(tope) {
                intentar(&mut out, json!({ grupo: { id: v } }));
            }
        }
    }
    out
}

/// Vuelve una sección a sus valores por defecto (lo demás queda igual).
pub fn restaurar_seccion(actual: &Objeto, seccion: &Value) -> Result<Objeto, String> {
    let mut next = actual.clone();
    let d = por_defecto();
    let copiar = |next: &mut Objeto, ks: &[&str]| {
        for k in ks {
            next.insert((*k).into(), d[*k].clone());
        }
    };
    match seccion.as_str() {
        Some("apariencia") => copiar(&mut next, &["theme", "density", "uiFontSize", "accent", "lightMode"]),
        Some("terminal") => copiar(&mut next, &["terminal"]),
        Some("cuentas") => copiar(&mut next, &["accountColors", "accountPlans", "accountCupos"]),
        Some("general") => copiar(&mut next, &["reopenSpaces", "keepTerminalsAlive", "confirmQuit", "sleepAfterMin", "openAtLogin", "confirmClosePanes", "editor", "projectsDir"]),
        Some("notif") => copiar(&mut next, &["notify", "noMolestar", "sounds", "soundName"]),
        Some("atajos") => copiar(&mut next, &["shortcuts"]),
        Some("updates") => copiar(&mut next, &["updateChannel"]),
        Some("rendimiento") => copiar(&mut next, &["rendimiento"]),
        _ => return Err("Sección desconocida.".into()),
    }
    Ok(next)
}

/// Tema efectivo: «Oscuro» y «Más oscuro» son siempre oscuros; «Según Windows» sigue al sistema.
pub fn resolver_oscuro(theme: &str, sistema_oscuro: bool) -> bool {
    if theme == "sistema" {
        sistema_oscuro
    } else {
        theme != "claro"
    }
}

#[cfg(test)]
mod tests;
