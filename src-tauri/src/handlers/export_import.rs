//! Canales `feat:export-import:*` en Rust: llevar la configuración a otra PC en un archivo `.sloth` (JSON, o cifrado con
//! contraseña de forma compatible con el de Node). Armar el documento, leerlo y planear la importación vive en
//! `sloth_core::features::export_import*`; acá están los diálogos, la vista previa pendiente y la importación, que pide
//! al dueño del store las cuentas y los espacios (`accounts:add`, `accounts:setShareSetup`, `workspaces:add`,
//! `workspaces:remove`). Plantillas, ajustes y reglas los guarda la UI con sus canales, como en el TS.
use super::comun::{self, ahora_ms, texto};
use super::arg;
use crate::entorno::{DialogoArchivo, Entorno};
use crate::router::Router;
use serde_json::{json, Map, Value};
use sloth_core::features::chat::fecha::iso_de_ms;
use sloth_core::features::export_import::{build_doc, equipo_de_chat, parse_choices, parse_selection, texto_exportado, unique_name, validar_export, vista_previa, Conflicto, EntradaDoc, Selection};
use sloth_core::features::export_import_logic::{
    build_plan, export_rules, export_templates, norm, open_envelope, parse_import, read_envelope, share_setup_al_importar, templates_to_save, Envelope, ExportDoc,
    ImportPlan, ParsedImport, MAX_FILE_BYTES,
};
use sloth_core::perfiles_core::NOMBRE_INICIAL;
use sloth_core::perfiles_fs::leer_indice_vigente;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const NOMBRE: &str = "export-import";

const VENCE_MS: u64 = 10 * 60_000;
const PEDIDO: Duration = Duration::from_secs(60);
const VENCIDA: &str = "La vista previa venció: volvé a elegir el archivo.";

enum Contenido {
    Cifrado { cifrado: Value, datos: String },
    Abierto(ParsedImport),
}

struct Pendiente {
    file: String,
    at: u64,
    contenido: Contenido,
}

pub struct ExportImport {
    entorno: Arc<Entorno>,
    pendientes: Mutex<HashMap<String, Pendiente>>,
    ultimo: Mutex<Option<PathBuf>>,
}

fn es_dir(p: &str) -> bool {
    Path::new(p).is_dir()
}

/// Un JSON de la carpeta de funciones, sin migrar ni reescribir (lo escribe su función); `null` si no está o es enorme.
fn leer_json(archivo: PathBuf) -> Value {
    if fs::metadata(&archivo).map(|m| m.len() as usize > MAX_FILE_BYTES).unwrap_or(true) {
        return Value::Null;
    }
    fs::read_to_string(&archivo).ok().and_then(|t| serde_json::from_str(t.strip_prefix('\u{feff}').unwrap_or(&t)).ok()).unwrap_or(Value::Null)
}

impl ExportImport {
    fn funciones(&self, archivo: &str) -> Value {
        self.entorno.carpeta_features().map(|d| leer_json(d.join(archivo))).unwrap_or(Value::Null)
    }

    fn plantillas(&self) -> Value {
        self.funciones("templates.json")
    }

    /// Reglas «Permitir siempre» de Sloth (permissions.json), crudas: `export_rules` las valida una por una.
    fn reglas(&self) -> Vec<Value> {
        self.funciones("permissions.json").get("rules").and_then(Value::as_array).cloned().unwrap_or_default()
    }

    fn equipo(&self) -> Option<String> {
        equipo_de_chat(&self.funciones("chat.json"))
    }

    fn ajustes(&self) -> Map<String, Value> {
        comun::ajustes(&self.entorno).and_then(|v| v.as_object().cloned()).unwrap_or_default()
    }

    fn nombre_del_perfil(&self) -> String {
        let id = self.entorno.perfil().ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()));
        leer_indice_vigente(&self.entorno.raiz())
            .and_then(|i| i.perfiles.into_iter().find(|p| Some(&p.id) == id.as_ref()))
            .map_or_else(|| NOMBRE_INICIAL.to_string(), |p| p.nombre)
    }

    fn documento(&self, sel: &Selection) -> ExportDoc {
        let (cuentas, espacios) = (comun::cuentas(&self.entorno), comun::espacios(&self.entorno));
        let (version, exportado, perfil) = (self.entorno.plataforma.version(), iso_de_ms(ahora_ms() as i64), self.nombre_del_perfil());
        let (plantillas, reglas, equipo, ajustes) = (self.plantillas(), self.reglas(), self.equipo(), self.ajustes());
        build_doc(
            sel,
            &EntradaDoc { version: &version, exportado: &exportado, perfil: &perfil, cuentas: &cuentas, espacios: &espacios, plantillas: &plantillas, reglas: &reglas, equipo: equipo.as_deref(), ajustes: &ajustes },
        )
    }

    fn apariencia(a: &Map<String, Value>) -> Value {
        json!({ "theme": a.get("theme"), "density": a.get("density"), "uiFontSize": a.get("uiFontSize"), "accent": a.get("accent"), "lightMode": a.get("lightMode") })
    }

    /// Inventario para armar la selección: espacios (con su cuenta y color) y qué hay en cada grupo.
    fn overview(&self) -> Value {
        let ajustes = self.ajustes();
        let cuentas = comun::cuentas(&self.entorno);
        let reglas = self.reglas();
        let label_de = |id: &str| cuentas.iter().find(|a| texto(a, "id").as_deref() == Some(id)).map(|a| texto(a, "label").unwrap_or_default());
        let espacios: Vec<Value> = comun::espacios(&self.entorno)
            .iter()
            .filter_map(|w| {
                let acc = texto(w, "accountId")?;
                let cuenta = label_de(&acc)?;
                let n = export_rules(&reglas, std::slice::from_ref(w)).first().map_or(0, |p| p.reglas.len());
                Some(json!({
                    "id": texto(w, "id"), "nombre": texto(w, "name"), "ruta": texto(w, "repoPath"), "cuenta": cuenta,
                    "color": ajustes.get("accountColors").and_then(|c| c.get(&acc)).cloned().unwrap_or(Value::Null),
                    "colorEspacio": w.get("color").cloned().unwrap_or(Value::Null), "reglas": n
                }))
            })
            .collect();
        let total: u64 = espacios.iter().filter_map(|e| e["reglas"].as_u64()).sum();
        json!({
            "espacios": espacios,
            "plantillas": export_templates(&self.plantillas(), &cuentas).len(),
            "apariencia": Self::apariencia(&ajustes),
            "atajos": ajustes.get("shortcuts").and_then(Value::as_object).map_or(0, Map::len),
            "equipo": self.equipo(),
            "reglasTotal": total,
            "sesiones": "no se exportan"
        })
    }

    fn preview(&self, raw: &Value) -> Result<Value, String> {
        serde_json::to_value(vista_previa(&self.documento(&parse_selection(raw)))).map_err(|e| e.to_string())
    }

    fn export(&self, raw_sel: &Value, raw_pw: &Value) -> Result<Value, String> {
        let sel = parse_selection(raw_sel);
        let pw = validar_export(&sel, raw_pw)?;
        let dia = &iso_de_ms(ahora_ms() as i64)[..10];
        let d = DialogoArchivo {
            titulo: "Exportar configuración de Sloth",
            ruta_sugerida: Some(self.entorno.plataforma.carpeta_documentos().join(format!("sloth-config-{dia}.sloth"))),
            filtro: ("Configuración de Sloth", &["sloth"]),
        };
        let Some(elegido) = self.entorno.plataforma.guardar_como(&d) else { return Ok(Value::Null) };
        let file = if elegido.extension().is_some_and(|e| e.eq_ignore_ascii_case("sloth")) { elegido } else { PathBuf::from(format!("{}.sloth", elegido.display())) };
        let doc = self.documento(&sel);
        let text = texto_exportado(&doc, pw.as_deref())?;
        escribir_atomico(&file, &text).map_err(|e| e.to_string())?;
        let espacios = doc.espacios.as_ref().map_or(0, Vec::len);
        sloth_core::logger_global::info(NOMBRE, &format!("exportado: {espacios} espacios{} → {}", if pw.is_some() { " (cifrado)" } else { "" }, file.display()));
        *self.ultimo.lock().unwrap_or_else(|e| e.into_inner()) = Some(file.clone());
        Ok(json!({ "file": file.to_string_lossy(), "espacios": espacios, "cifrado": pw.is_some(), "kb": (text.len() as f64 / 1024.0).round() as u64 }))
    }

    fn reveal(&self) -> Result<Value, String> {
        let ultimo = self.ultimo.lock().unwrap_or_else(|e| e.into_inner()).clone().filter(|p| p.exists());
        let Some(f) = ultimo else { return Err("Todavía no exportaste ningún archivo en esta sesión.".into()) };
        self.entorno.plataforma.mostrar_en_carpeta(&f)?;
        Ok(json!(true))
    }

    fn podar(&self) {
        let ahora = ahora_ms();
        self.pendientes.lock().unwrap_or_else(|e| e.into_inner()).retain(|_, p| ahora.saturating_sub(p.at) <= VENCE_MS);
    }

    fn plan(&self, parsed: &ParsedImport) -> ImportPlan {
        build_plan(parsed, &comun::cuentas(&self.entorno), &comun::espacios(&self.entorno), &es_dir, &self.plantillas())
    }

    fn cargar(&self, file: String, text: &str) -> Result<Value, String> {
        self.podar();
        let token = comun::nuevo_uuid();
        let (contenido, respuesta) = match read_envelope(text)? {
            Envelope::Cifrado { cifrado, datos, version } => (Contenido::Cifrado { cifrado, datos }, json!({ "token": token, "file": file, "needsPassword": true, "version": version })),
            Envelope::Plano { text } => {
                let parsed = parse_import(&text)?;
                let plan = serde_json::to_value(self.plan(&parsed)).map_err(|e| e.to_string())?;
                (Contenido::Abierto(parsed), json!({ "token": token, "file": file, "plan": plan }))
            }
        };
        self.pendientes.lock().unwrap_or_else(|e| e.into_inner()).insert(token, Pendiente { file, at: ahora_ms(), contenido });
        Ok(respuesta)
    }

    fn import(&self) -> Result<Value, String> {
        self.podar();
        let d = DialogoArchivo { titulo: "Importar configuración de Sloth", ruta_sugerida: None, filtro: ("Configuración de Sloth", &["sloth", "json"]) };
        let Some(file) = self.entorno.plataforma.elegir_archivo(&d) else { return Ok(Value::Null) };
        if fs::metadata(&file).map_err(|e| e.to_string())?.len() as usize > MAX_FILE_BYTES {
            return Err("El archivo es demasiado grande para ser una configuración de Sloth.".into());
        }
        let text = fs::read_to_string(&file).map_err(|e| e.to_string())?;
        self.cargar(file.to_string_lossy().into_owned(), &text)
    }

    /// Para soltar un archivo en la ventana: la interfaz manda el contenido (no hay ruta).
    fn import_text(&self, nombre: &Value, text: &Value) -> Result<Value, String> {
        let text = text.as_str().unwrap_or_default();
        if text.is_empty() || text.encode_utf16().count() > MAX_FILE_BYTES {
            return Err("El archivo no es una configuración de Sloth válida.".into());
        }
        let nombre: String = String::from_utf16_lossy(&nombre.as_str().unwrap_or_default().encode_utf16().take(200).collect::<Vec<u16>>());
        self.cargar(if nombre.is_empty() { "configuración.sloth".into() } else { nombre }, text)
    }

    fn unlock(&self, token: &Value, pw: &Value) -> Result<Value, String> {
        let token = token.as_str().ok_or(VENCIDA)?;
        let mut p = self.pendientes.lock().unwrap_or_else(|e| e.into_inner());
        let e = p.get_mut(token).ok_or(VENCIDA)?;
        let Contenido::Cifrado { cifrado, datos } = &e.contenido else { return Err("Ese archivo ya está abierto.".into()) };
        let parsed = parse_import(&open_envelope(cifrado, datos, pw.as_str().unwrap_or_default())?)?;
        let plan = serde_json::to_value(self.plan(&parsed)).map_err(|e| e.to_string())?;
        e.contenido = Contenido::Abierto(parsed);
        e.at = ahora_ms();
        Ok(json!({ "token": token, "file": e.file, "plan": plan }))
    }

    fn cancel(&self, token: &Value) -> Result<Value, String> {
        if let Some(t) = token.as_str() {
            self.pendientes.lock().unwrap_or_else(|e| e.into_inner()).remove(t);
        }
        Ok(Value::Null)
    }

    fn confirm(&self, token: &Value, raw: &Value) -> Result<Value, String> {
        let token = token.as_str().ok_or(VENCIDA)?;
        let parsed = {
            let p = self.pendientes.lock().unwrap_or_else(|e| e.into_inner());
            match p.get(token).map(|e| &e.contenido) {
                None => return Err(VENCIDA.into()),
                Some(Contenido::Cifrado { .. }) => return Err("Falta la contraseña del archivo.".into()),
                Some(Contenido::Abierto(parsed)) => parsed.clone(),
            }
        };
        comun::exigir_escritura(&self.entorno)?;
        self.pendientes.lock().unwrap_or_else(|e| e.into_inner()).remove(token);
        let choices = parse_choices(raw);
        let g = choices.grupos;
        let mut res = Resultado::default();
        let clave = |s: &str| s.trim().to_lowercase();

        // Cuentas que no existen acá: se crean sin sesión (las cuentas nunca traen sesión).
        let mut no_creadas: HashMap<String, String> = HashMap::new();
        // Las recién creadas se toman de la respuesta: no dependen de cuándo el dueño reescribe el estado.
        let mut id_por_label: HashMap<String, String> = HashMap::new();
        if g.espacios {
            for c in &parsed.cuentas {
                if comun::cuentas(&self.entorno).iter().any(|a| clave(&texto(a, "label").unwrap_or_default()) == clave(&c.label)) {
                    continue;
                }
                let mut args = vec![json!(c.label)];
                if let Some(p) = &c.proveedor {
                    args.push(json!(p));
                }
                match self.entorno.pedir("accounts:add", args, PEDIDO) {
                    Ok(acc) => {
                        if let Some(id) = texto(&acc, "id") {
                            id_por_label.insert(clave(&c.label), id);
                        }
                        let compartir = share_setup_al_importar(c.share_setup, &acc);
                        if acc.get("shareSetup").and_then(Value::as_bool) != Some(compartir) {
                            if let Some(id) = texto(&acc, "id") {
                                if let Err(e) = self.entorno.pedir("accounts:setShareSetup", vec![json!(id), json!(compartir)], PEDIDO) {
                                    sloth_core::logger_global::aviso(NOMBRE, &format!("setup compartido de {}: {e}", c.label));
                                }
                            }
                        }
                        res.cuentas += 1;
                    }
                    Err(e) => {
                        no_creadas.insert(clave(&c.label), e.clone());
                        res.errores.push(format!("Cuenta «{}»: {e}", c.label));
                    }
                }
            }
        }
        for a in comun::cuentas(&self.entorno) {
            if let (Some(l), Some(id)) = (texto(&a, "label"), texto(&a, "id")) {
                id_por_label.entry(clave(&l)).or_insert(id);
            }
        }

        // Espacios. Con colores y planes de cuenta que todavía no tenían, los del archivo.
        let local = self.ajustes();
        let ya_tiene = |k: &str, id: &str| local.get(k).and_then(|m| m.get(id)).is_some_and(|v| !v.is_null() && v != "");
        let mut colores = Map::new();
        let mut planes = Map::new();
        if g.espacios {
            for c in &parsed.cuentas {
                if let (Some(plan), Some(id)) = (&c.plan, id_por_label.get(&clave(&c.label))) {
                    if !ya_tiene("accountPlans", id) {
                        planes.insert(id.clone(), json!(plan));
                    }
                }
            }
            let locales = comun::espacios(&self.entorno);
            let mut tomados: HashSet<String> = locales.iter().map(|w| clave(&texto(w, "name").unwrap_or_default())).collect();
            for (i, e) in parsed.espacios.iter().enumerate() {
                let o = choices.espacios.get(&i.to_string());
                let Some(account_id) = id_por_label.get(&e.cuenta.to_lowercase()).cloned() else {
                    let motivo = match no_creadas.get(&clave(&e.cuenta)) {
                        Some(m) => format!("la cuenta «{}» no se pudo crear: {m}", e.cuenta),
                        None => format!("no se encontró la cuenta «{}»", e.cuenta),
                    };
                    res.saltar(&e.nombre, &motivo);
                    continue;
                };
                let carpeta = o.and_then(|o| o.carpeta.clone()).unwrap_or_else(|| e.ruta.clone());
                if !es_dir(&carpeta) {
                    res.saltar(&e.nombre, "la carpeta no existe en esta PC");
                    continue;
                }
                let igual = locales.iter().find(|w| clave(&texto(w, "name").unwrap_or_default()) == clave(&e.nombre));
                if let Some(w) = igual.filter(|w| norm(&texto(w, "repoPath").unwrap_or_default()) == norm(&carpeta)) {
                    res.saltar(&e.nombre, "ya está en Sloth");
                    res.espacios_ws.insert(i.to_string(), json!(texto(w, "id")));
                    continue;
                }
                let conflicto = igual.map(|_| o.and_then(|o| o.conflicto).unwrap_or(Conflicto::Saltear));
                if conflicto == Some(Conflicto::Saltear) {
                    res.saltar(&e.nombre, "ya tenés un espacio con ese nombre");
                    continue;
                }
                let mut nombre = e.nombre.clone();
                let alta = (|| -> Result<Value, String> {
                    if let (Some(w), Some(c)) = (igual, conflicto) {
                        if c == Conflicto::Reemplazar {
                            self.entorno.pedir("workspaces:remove", vec![json!(texto(w, "id"))], PEDIDO)?;
                        } else {
                            nombre = unique_name(&e.nombre, &tomados);
                        }
                    }
                    let mut input = json!({ "name": nombre, "repoPath": carpeta, "accountId": account_id, "autoStartClaude": e.auto_start_claude, "resume": e.resume });
                    for (k, v) in [("initialPrompt", &e.initial_prompt), ("ticket", &e.ticket), ("color", &e.color_espacio)] {
                        if let Some(v) = v {
                            input[k] = json!(v);
                        }
                    }
                    self.entorno.pedir("workspaces:add", vec![input], PEDIDO)
                })();
                match alta {
                    Ok(ws) => {
                        tomados.insert(clave(&texto(&ws, "name").unwrap_or_default()));
                        res.espacios += 1;
                        res.espacios_ws.insert(i.to_string(), json!(texto(&ws, "id")));
                        if let Some(color) = e.color.as_ref().filter(|_| !ya_tiene("accountColors", &account_id)) {
                            colores.insert(account_id.clone(), json!(color));
                        }
                    }
                    Err(err) => res.errores.push(format!("Espacio «{}»: {err}", e.nombre)),
                }
            }
        }

        // Plantillas, apariencia, atajos y colores/planes: los guarda la interfaz con sus canales (validan ahí).
        if g.plantillas {
            res.plantillas = templates_to_save(&parsed, &self.plan(&parsed), &id_por_label);
        }
        let mut ajustes = Map::new();
        if let Some(a) = parsed.apariencia.as_ref().filter(|_| g.apariencia) {
            let v = serde_json::to_value(a).map_err(|e| e.to_string())?;
            if v.as_object().is_some_and(|o| !o.is_empty()) {
                ajustes.insert("apariencia".into(), v);
            }
        }
        if let Some(atajos) = parsed.atajos.as_ref().filter(|_| g.atajos) {
            ajustes.insert("atajos".into(), Value::Object(atajos.iter().map(|(k, v)| (k.clone(), json!(v))).collect()));
        }
        if !colores.is_empty() {
            ajustes.insert("accountColors".into(), Value::Object(colores));
        }
        if !planes.is_empty() {
            ajustes.insert("accountPlans".into(), Value::Object(planes));
        }
        // Equipo: la URL no alcanza para conectar (falta la anon key). Se avisa, no se cambia nada.
        if let Some(url) = &parsed.equipo {
            res.notas.push(if g.equipo { format!("La URL del equipo ({url}) no se cambió: cargala en Equipo con tu anon key.") } else { "El equipo no se importó (lo elegiste sin marcar).".into() });
        }
        sloth_core::logger_global::info(NOMBRE, &format!("importado: {} cuentas, {} espacios, {} plantillas para guardar", res.cuentas, res.espacios, res.plantillas.len()));
        comun::ui(&self.entorno, json!({ "type": "reload" }));
        Ok(json!({
            "cuentas": res.cuentas, "espacios": res.espacios, "espaciosWs": res.espacios_ws, "plantillas": res.plantillas,
            "ajustes": ajustes, "saltados": res.saltados, "notas": res.notas, "errores": res.errores
        }))
    }
}

#[derive(Default)]
struct Resultado {
    cuentas: usize,
    espacios: usize,
    espacios_ws: Map<String, Value>,
    plantillas: Vec<Value>,
    saltados: Vec<Value>,
    notas: Vec<String>,
    errores: Vec<String>,
}

impl Resultado {
    fn saltar(&mut self, nombre: &str, motivo: &str) {
        self.saltados.push(json!({ "nombre": nombre, "motivo": motivo }));
    }
}

fn escribir_atomico(file: &Path, text: &str) -> std::io::Result<()> {
    if let Some(d) = file.parent() {
        fs::create_dir_all(d)?;
    }
    let tmp = PathBuf::from(format!("{}.{}.tmp", file.display(), std::process::id()));
    fs::write(&tmp, text)?;
    fs::rename(&tmp, file)
}

pub fn registrar(router: &mut Router, entorno: Arc<Entorno>) {
    let f = Arc::new(ExportImport { entorno, pendientes: Mutex::default(), ultimo: Mutex::default() });
    macro_rules! canal {
        ($op:literal, |$f:ident, $a:ident| $cuerpo:expr) => {{
            let $f = f.clone();
            router.registrar(concat!("feat:export-import:", $op), move |$a: Vec<Value>| {
                let _ = &$a;
                $cuerpo
            });
        }};
    }
    canal!("overview", |f, a| Ok(f.overview()));
    canal!("preview", |f, a| f.preview(arg(&a, 0)));
    canal!("export", |f, a| f.export(arg(&a, 0), arg(&a, 1)));
    canal!("reveal", |f, a| f.reveal());
    canal!("import", |f, a| f.import());
    canal!("importText", |f, a| f.import_text(arg(&a, 0), arg(&a, 1)));
    canal!("unlock", |f, a| f.unlock(arg(&a, 0), arg(&a, 1)));
    canal!("pickFolder", |f, a| Ok(f.entorno.plataforma.elegir_carpeta().map_or(Value::Null, Value::String)));
    canal!("cancel", |f, a| f.cancel(arg(&a, 0)));
    canal!("confirm", |f, a| f.confirm(arg(&a, 0), arg(&a, 1)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_comunes::{EntornoDePrueba, ReenvioNulo};

    struct Prueba {
        t: EntornoDePrueba,
        router: Router,
        repo: PathBuf,
        pedidos: Arc<Mutex<Vec<(String, Vec<Value>)>>>,
    }

    fn armar_prueba(nombre: &str) -> Prueba {
        let t = EntornoDePrueba::nuevo(nombre);
        let repo = t.carpeta.join("repo");
        fs::create_dir_all(&repo).unwrap();
        let r = repo.to_string_lossy().into_owned();
        t.fijar_estado(&json!({ "version": 1, "accounts": [{ "id": "a1", "label": "Trabajo", "configDir": "C:\\secreto" }], "workspaces": [
            { "id": "w1", "name": "Repo", "repoPath": r, "cwd": r, "accountId": "a1" }
        ] }));
        let pedidos: Arc<Mutex<Vec<(String, Vec<Value>)>>> = Arc::default();
        let anotados = pedidos.clone();
        t.fijar_apoyo(move |canal, args| {
            anotados.lock().unwrap().push((canal.to_string(), args.to_vec()));
            match canal {
                "feat:settings:get" => Ok(json!({ "settings": { "theme": "oscuro", "density": "comoda", "uiFontSize": 13, "accent": "azul", "lightMode": false, "accountColors": {}, "accountPlans": {}, "shortcuts": {} } })),
                "state:get" => Ok(json!({ "agents": {} })),
                "accounts:add" => Ok(json!({ "id": "nueva", "label": args[0], "shareSetup": true })),
                "workspaces:add" => Ok(json!({ "id": "ws-nuevo", "name": args[0]["name"] })),
                _ => Ok(Value::Null),
            }
        });
        let mut router = Router::nuevo(Arc::new(ReenvioNulo));
        registrar(&mut router, t.entorno.clone());
        Prueba { t, router, repo, pedidos }
    }

    impl Prueba {
        async fn pedir(&self, op: &str, args: Vec<Value>) -> Result<Value, String> {
            self.router.invocar(format!("feat:export-import:{op}"), args).await
        }
        fn canales(&self) -> Vec<String> {
            self.pedidos.lock().unwrap().iter().map(|(c, _)| c.clone()).collect()
        }
    }

    #[test]
    fn registra_los_diez_canales() {
        let p = armar_prueba("ei-canales");
        for op in ["overview", "preview", "export", "reveal", "import", "importText", "unlock", "pickFolder", "cancel", "confirm"] {
            assert!(p.router.atiende(&format!("feat:export-import:{op}")), "{op}");
        }
        assert_eq!(p.router.canales().len(), 10);
    }

    #[tokio::test]
    async fn overview_y_preview_no_exportan_la_carpeta_de_la_cuenta() {
        let p = armar_prueba("ei-overview");
        let o = p.pedir("overview", vec![]).await.unwrap();
        assert_eq!(o["espacios"][0]["nombre"], json!("Repo"));
        assert_eq!(o["espacios"][0]["cuenta"], json!("Trabajo"));
        assert_eq!(o["sesiones"], json!("no se exportan"));
        let v = p.pedir("preview", vec![json!({ "espacios": ["w1"], "apariencia": true })]).await.unwrap();
        let doc: Value = serde_json::from_str(v["json"].as_str().unwrap()).unwrap();
        assert_eq!(doc["formato"], json!("sloth-config"));
        assert_eq!(doc["perfil"], json!("Mi perfil"));
        assert_eq!(doc["apariencia"]["theme"], json!("oscuro"));
        assert!(!v["json"].as_str().unwrap().contains("secreto"));
    }

    #[tokio::test]
    async fn export_valida_escribe_y_se_puede_volver_a_importar_cifrado() {
        let p = armar_prueba("ei-export");
        assert_eq!(p.pedir("export", vec![json!({}), Value::Null]).await.unwrap_err(), "Marcá al menos un grupo para exportar.");
        assert_eq!(p.pedir("export", vec![json!({ "plantillas": true }), json!("corta")]).await.unwrap_err(), "La contraseña tiene que tener al menos 8 caracteres.");
        assert_eq!(p.pedir("export", vec![json!({ "plantillas": true }), Value::Null]).await.unwrap(), Value::Null);
        assert_eq!(p.pedir("reveal", vec![]).await.unwrap_err(), "Todavía no exportaste ningún archivo en esta sesión.");
        *p.t.plataforma.guardar_en.lock().unwrap() = Some(p.t.carpeta.join("config"));
        let r = p.pedir("export", vec![json!({ "espacios": ["w1"] }), json!("una clave larga")]).await.unwrap();
        let file = p.t.carpeta.join("config.sloth");
        assert_eq!((r["file"].clone(), r["cifrado"].clone(), r["espacios"].clone()), (json!(file.to_string_lossy()), json!(true), json!(1)));
        assert_eq!(p.pedir("reveal", vec![]).await.unwrap(), json!(true));

        *p.t.plataforma.elegido.lock().unwrap() = Some(file);
        let abierto = p.pedir("import", vec![]).await.unwrap();
        assert_eq!(abierto["needsPassword"], json!(true));
        let token = abierto["token"].clone();
        assert!(p.pedir("unlock", vec![token.clone(), json!("otra clave")]).await.is_err());
        let plan = p.pedir("unlock", vec![token.clone(), json!("una clave larga")]).await.unwrap();
        assert_eq!(plan["plan"]["espacios"][0]["nombre"], json!("Repo"));
        assert_eq!(p.pedir("unlock", vec![token, json!("una clave larga")]).await.unwrap_err(), "Ese archivo ya está abierto.");
    }

    fn archivo(repo: &Path, cuenta: &str) -> String {
        json!({ "formato": "sloth-config", "formatoVersion": 2, "versión": "0.8.0", "exportado": "2026-11-28T00:00:00.000Z",
            "cuentas": [{ "label": cuenta, "shareSetup": false }],
            "espacios": [{ "nombre": "Repo", "ruta": repo.to_string_lossy(), "cuenta": cuenta, "autoStartClaude": true, "resume": true }, { "nombre": "Lejos", "ruta": "C:\\no\\existe", "cuenta": cuenta }] })
        .to_string()
    }

    #[tokio::test]
    async fn confirm_crea_la_cuenta_y_los_espacios_por_el_dueno_del_store() {
        let p = armar_prueba("ei-confirm");
        let otra = p.t.carpeta.join("otra");
        fs::create_dir_all(&otra).unwrap();
        let v = p.pedir("importText", vec![json!("x.sloth"), json!(archivo(&otra, "Casa"))]).await.unwrap();
        let r = p.pedir("confirm", vec![v["token"].clone(), json!({ "espacios": { "0": { "conflicto": "dos" } } })]).await.unwrap();
        assert_eq!((r["cuentas"].clone(), r["espacios"].clone()), (json!(1), json!(1)));
        assert_eq!(r["saltados"], json!([{ "nombre": "Lejos", "motivo": "la carpeta no existe en esta PC" }]));
        let pedidos = p.pedidos.lock().unwrap().clone();
        let add = pedidos.iter().find(|(c, _)| c == "workspaces:add").unwrap();
        assert_eq!(add.1[0]["name"], json!("Repo (copia)"));
        assert!(p.canales().contains(&"accounts:setShareSetup".to_string()));
        assert!(p.t.eventos().contains(&("ui:command".to_string(), vec![json!({ "type": "reload" })])));
        assert_eq!(p.pedir("confirm", vec![v["token"].clone(), json!({})]).await.unwrap_err(), VENCIDA);
    }

    #[tokio::test]
    async fn el_mismo_espacio_en_la_misma_carpeta_ya_esta() {
        let p = armar_prueba("ei-ya-esta");
        let v = p.pedir("importText", vec![json!("x.sloth"), json!(archivo(&p.repo, "Trabajo"))]).await.unwrap();
        let r = p.pedir("confirm", vec![v["token"].clone(), json!({})]).await.unwrap();
        assert_eq!(r["espaciosWs"], json!({ "0": "w1" }));
        assert!(!p.canales().contains(&"workspaces:add".to_string()));
        assert!(!p.canales().contains(&"accounts:add".to_string()));
    }

    #[tokio::test]
    async fn un_texto_que_no_es_configuracion_se_rechaza() {
        let p = armar_prueba("ei-mal");
        assert_eq!(p.pedir("importText", vec![json!("x"), json!("")]).await.unwrap_err(), "El archivo no es una configuración de Sloth válida.");
        assert!(p.pedir("importText", vec![json!("x"), json!("{}")]).await.unwrap_err().contains("sloth-config"));
        assert_eq!(p.pedir("unlock", vec![json!("nada"), json!("x")]).await.unwrap_err(), VENCIDA);
    }
}
