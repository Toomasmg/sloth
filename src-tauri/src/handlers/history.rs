//! Canales `feat:history:*` en Rust: el historial de conversaciones de cada cuenta, leído de sus transcripts
//! (`projects/<carpeta>/<uuid>.jsonl`). La lectura, la búsqueda y las validaciones viven en `sloth_core::history_core`;
//! acá están la caché de resúmenes, `history.json` (fijadas y ocultas), la Papelera y retomar una conversación.
//!
//! Retomar puede crear un espacio (lo hace el dueño del store, por `workspaces:add`) y reinicia la terminal: eso lo
//! pide al dueño de las terminales (`pty:running`, `pty:resumeOnce`, `pty:kill`), nunca al daemon directo.
use super::comun::{self, ahora_ms, nombre_base, texto};
use super::{a_json, arg};
use crate::entorno::{DialogoArchivo, Entorno};
use crate::router::Router;
use serde_json::{json, Value};
use sloth_core::avisos::Avisos;
use sloth_core::features::proceso::normalizar_ruta;
use sloth_core::history_core::{
    buscar_sesiones, es_clave_sesion, es_uuid, fecha_es_ar, fijar_pref, listar_sesiones, listar_sesiones_recientes, parsear_prefs, parsear_transcript, rutas_papelera,
    sesion_markdown, ArchivoSesion, CuentaBusqueda, FilaSesion, InfoSesion, ItemHistorial, Lista, OpcionesBusqueda, PrefsHistorial, SesionParseada, DIAS_RANGO_SESIONES,
    MAX_LINEA_TRANSCRIPT, MAX_RESULTADOS,
};
use sloth_core::persistencia::{escribir_json_atomico, es_objeto, leer_json, OpcionesLectura};
use sloth_core::proveedores::{capacidades_de, motivo_sin_capacidad};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const NOMBRE: &str = "history";

const ALTA_DE_ESPACIO: Duration = Duration::from_secs(180);

fn misma_ruta(a: &str, b: &str) -> bool {
    normalizar_ruta(a) == normalizar_ruta(b)
}

/// Como `projectSlug` del TS: Claude guarda cada carpeta en `projects/<slug>`.
fn slug_de(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

fn ids(cuenta: &Value, sesion: &Value) -> Result<(String, String), String> {
    let (Some(a), Some(s)) = (cuenta.as_str(), sesion.as_str()) else { return Err("Datos inválidos.".into()) };
    if !es_uuid(s) {
        return Err("Id de conversación inválido.".into());
    }
    Ok((a.to_string(), s.to_string()))
}

struct EnCache {
    mtime_ms: i64,
    size: u64,
    sesion: SesionParseada,
}

pub struct Historial {
    entorno: Arc<Entorno>,
    busquedas: Mutex<HashMap<String, Arc<AtomicBool>>>,
    cache: Mutex<HashMap<PathBuf, EnCache>>,
}

impl Historial {
    fn archivo_prefs(&self) -> Result<PathBuf, String> {
        Ok(self.entorno.carpeta_features()?.join("history.json"))
    }

    fn leer_prefs(&self) -> Result<PrefsHistorial, String> {
        let validar = |v: &Value| es_objeto(v).then(|| parsear_prefs(v));
        let por_defecto = PrefsHistorial::default;
        let r = leer_json(&self.archivo_prefs()?, &OpcionesLectura::nuevas(&validar, &por_defecto), Avisos::global());
        for aviso in Avisos::global().tomar() {
            sloth_core::logger_global::aviso(NOMBRE, &aviso);
        }
        Ok(r.valor)
    }

    fn escribir_prefs(&self, p: &PrefsHistorial) -> Result<(), String> {
        let v = serde_json::to_value(p).map_err(|e| e.to_string())?;
        escribir_json_atomico(&self.archivo_prefs()?, &v).map(|_| ()).map_err(|e| e.to_string())
    }

    fn espacios_de(&self, cuenta: &str, cwd: &str) -> Vec<Value> {
        comun::espacios(&self.entorno)
            .into_iter()
            .filter(|w| texto(w, "accountId").as_deref() == Some(cuenta) && (texto(w, "cwd").is_some_and(|c| misma_ruta(&c, cwd)) || texto(w, "repoPath").is_some_and(|c| misma_ruta(&c, cwd))))
            .collect()
    }

    fn cuenta_de_busqueda(a: &Value) -> Option<CuentaBusqueda> {
        Some(CuentaBusqueda { id: texto(a, "id")?, label: texto(a, "label").unwrap_or_default(), config_dir: PathBuf::from(texto(a, "configDir")?) })
    }

    fn cuentas_a_escanear(&self) -> Vec<CuentaBusqueda> {
        comun::cuentas(&self.entorno).iter().filter(|a| capacidades_de(a).is_some_and(|c| c.historial)).filter_map(Self::cuenta_de_busqueda).collect()
    }

    fn fila(&self, f: &ArchivoSesion, p: &SesionParseada) -> Option<FilaSesion> {
        if p.cwd.is_empty() {
            return None;
        }
        let cwd = p.cwd.clone();
        let ws = self.espacios_de(&f.cuenta.id, &cwd).into_iter().next();
        let ws_texto = |k: &str| ws.as_ref().and_then(|w| texto(w, k));
        let nombre = ws_texto("name").unwrap_or_else(|| Some(nombre_base(&cwd)).filter(|s| !s.is_empty()).unwrap_or_else(|| cwd.clone()));
        Some(FilaSesion {
            key: format!("{}:{}", f.cuenta.id, f.session_id),
            account_id: f.cuenta.id.clone(),
            account_label: f.cuenta.label.clone(),
            session_id: f.session_id.clone(),
            space_id: ws_texto("id"),
            space_key: ws_texto("id").unwrap_or_else(|| format!("cwd:{}", cwd.to_lowercase())),
            space_name: nombre,
            branch: if p.branch.is_empty() { ws_texto("branch").unwrap_or_default() } else { p.branch.clone() },
            title: p.title.clone(),
            start: if p.start != 0 { p.start } else { f.mtime_ms },
            end: if p.end != 0 { p.end } else { f.mtime_ms },
            messages: p.messages,
            tools: p.tools,
            files: p.files.clone(),
            status: p.status,
            cwd,
        })
    }

    fn cuenta_con_historial(&self, id: &str) -> Result<Value, String> {
        let acc = comun::cuenta(&self.entorno, id).ok_or("Esa cuenta ya no existe en Sloth.")?;
        if let Some(m) = motivo_sin_capacidad(&acc, "historial") {
            return Err(m);
        }
        Ok(acc)
    }

    fn buscar_archivo(&self, cuenta: &str, sesion: &str) -> Result<ArchivoSesion, String> {
        let acc = self.cuenta_con_historial(cuenta)?;
        let c = Self::cuenta_de_busqueda(&acc).ok_or("Esa cuenta ya no existe en Sloth.")?;
        listar_sesiones(&[c]).into_iter().find(|f| f.session_id == sesion).ok_or_else(|| "No encontré esa conversación en la carpeta de la cuenta.".to_string())
    }

    fn info(&self, f: &ArchivoSesion) -> Result<InfoSesion, String> {
        let d = parsear_transcript(&f.file, true, MAX_LINEA_TRANSCRIPT).map_err(|e| e.to_string())?;
        let fila = self.fila(f, &d.sesion).ok_or("La conversación no tiene carpeta registrada.")?;
        Ok(InfoSesion { fila, last_answer: d.sesion.last_answer, items: d.items })
    }

    fn list(&self) -> Result<Value, String> {
        // Modo liviano: solo la última semana (la lista es lo que más se lee del disco).
        let dias = if comun::ajuste(&self.entorno, "lightMode").and_then(|v| v.as_bool()) == Some(true) { 7 } else { DIAS_RANGO_SESIONES };
        let desde = ahora_ms() as i64 - dias * 86_400_000;
        let archivos = listar_sesiones_recientes(&self.cuentas_a_escanear(), desde);
        let mut filas: Vec<FilaSesion> = Vec::new();
        {
            let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
            for f in &archivos {
                let vigente = cache.get(&f.file).is_some_and(|c| c.mtime_ms == f.mtime_ms && c.size == f.size);
                if !vigente {
                    let Ok(d) = parsear_transcript(&f.file, false, MAX_LINEA_TRANSCRIPT) else { continue };
                    cache.insert(f.file.clone(), EnCache { mtime_ms: f.mtime_ms, size: f.size, sesion: d.sesion });
                }
                if let Some(fila) = cache.get(&f.file).and_then(|c| self.fila(f, &c.sesion)) {
                    filas.push(fila);
                }
            }
            cache.retain(|k, _| archivos.iter().any(|f| &f.file == k));
        }
        filas.sort_by(|a, b| b.start.cmp(&a.start));
        let prefs = self.leer_prefs()?;
        Ok(json!({ "sessions": filas, "pinned": prefs.pinned, "hidden": prefs.hidden }))
    }

    fn detail(&self, cuenta: &Value, sesion: &Value) -> Result<Value, String> {
        let (c, s) = ids(cuenta, sesion)?;
        let f = self.buscar_archivo(&c, &s)?;
        a_json(self.info(&f))
    }

    fn delete(&self, cuenta: &Value, sesion: &Value) -> Result<Value, String> {
        let (c, s) = ids(cuenta, sesion)?;
        let acc = comun::cuenta(&self.entorno, &c).ok_or("Esa cuenta ya no existe en Sloth.")?;
        let f = self.buscar_archivo(&c, &s)?;
        let config = PathBuf::from(texto(&acc, "configDir").unwrap_or_default());
        let slug = f.file.parent().and_then(Path::file_name).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        // Solo rutas <configDir>/projects/<carpeta>/<uuid>(.jsonl): cualquier otra cosa se rechaza.
        let rutas = rutas_papelera(&config, &slug, &s).filter(|r| std::path::absolute(&r.file).ok() == std::path::absolute(&f.file).ok());
        let Some(rutas) = rutas else { return Err("Esa conversación no está en la carpeta de proyectos de la cuenta. No borré nada.".into()) };
        let parseada = parsear_transcript(&f.file, false, MAX_LINEA_TRANSCRIPT).map_err(|e| e.to_string())?;
        // Si la sesión puede estar corriendo en una terminal de Sloth, no se toca: primero hay que cerrarla.
        if !parseada.sesion.cwd.is_empty() {
            for w in self.espacios_de(&c, &parseada.sesion.cwd) {
                if comun::terminal_viva(&self.entorno, &texto(&w, "id").unwrap_or_default())? {
                    return Err(format!("«{}» tiene la terminal abierta. Cerrala antes de borrar esta conversación.", texto(&w, "name").unwrap_or_default()));
                }
            }
        }
        if !std::fs::symlink_metadata(&rutas.file).is_ok_and(|m| m.is_file()) {
            return Err("No encontré esa conversación en la carpeta de la cuenta.".into());
        }
        self.entorno.plataforma.a_la_papelera(&rutas.file)?;
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).remove(&f.file);
        sloth_core::logger_global::info(NOMBRE, "historial: conversación enviada a la Papelera");
        // La carpeta asociada (subagentes, resultados) va con la conversación. Si falla, el .jsonl ya está en la Papelera.
        if std::fs::symlink_metadata(&rutas.dir).is_ok_and(|m| m.is_dir()) && self.entorno.plataforma.a_la_papelera(&rutas.dir).is_err() {
            return Err("La conversación fue a la Papelera, pero no pude mover su carpeta asociada. Revisala a mano.".into());
        }
        let clave = format!("{c}:{s}");
        let actual = self.leer_prefs()?;
        let siguiente = PrefsHistorial { pinned: actual.pinned.into_iter().filter(|k| *k != clave).collect(), hidden: actual.hidden.into_iter().filter(|k| *k != clave).collect() };
        self.escribir_prefs(&siguiente)?;
        a_json(Ok(siguiente))
    }

    fn marcar(&self, cual: Lista, clave: &Value, on: &Value) -> Result<Value, String> {
        let (Some(k), Some(on)) = (clave.as_str().filter(|k| es_clave_sesion(k)), on.as_bool()) else { return Err("Datos inválidos.".into()) };
        let siguiente = fijar_pref(&self.leer_prefs()?, cual, k, on).ok_or("Datos inválidos.")?;
        self.escribir_prefs(&siguiente)?;
        a_json(Ok(siguiente))
    }

    fn export(&self, cuenta: &Value, sesion: &Value) -> Result<Value, String> {
        let (c, s) = ids(cuenta, sesion)?;
        let f = self.buscar_archivo(&c, &s)?;
        let info = self.info(&f)?;
        let dia = comun::fecha_local(info.fila.start.max(0) as u64);
        let nombre = nombre_de_archivo(&info.fila.title);
        let d = DialogoArchivo {
            titulo: "Exportar conversación como Markdown",
            ruta_sugerida: Some(self.entorno.plataforma.carpeta_documentos().join(format!("{dia} {nombre}.md"))),
            filtro: ("Markdown", &["md"]),
        };
        let Some(destino) = self.entorno.plataforma.guardar_como(&d) else { return Ok(Value::Null) };
        let cuando = |ms: i64| fecha_es_ar(ms, comun::desfase_local_min(ms.max(0) as u64));
        std::fs::write(&destino, sesion_markdown(&info, &info.fila.space_name, &cuando)).map_err(|e| e.to_string())?;
        sloth_core::logger_global::info(NOMBRE, &format!("historial: conversación exportada a {}", destino.display()));
        Ok(json!({ "file": destino.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() }))
    }

    fn search(&self, id: &Value, consulta: &Value, opts: &Value) -> Result<Value, String> {
        let Some(id) = id.as_str().filter(|s| (1..=64).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')) else {
            return Err("Búsqueda inválida.".into());
        };
        let Some(q) = consulta.as_str() else { return Err("Búsqueda inválida.".into()) };
        let q = q.trim();
        let largo = q.encode_utf16().count();
        if !(2..=200).contains(&largo) {
            return Err("Escribí entre 2 y 200 caracteres.".into());
        }
        let account_id = opts.get("accountId").and_then(Value::as_str).filter(|a| comun::cuenta(&self.entorno, a).is_some()).map(String::from);
        let control = Arc::new(AtomicBool::new(false));
        {
            // Una búsqueda a la vez: la nueva cancela las anteriores.
            let mut b = self.busquedas.lock().unwrap_or_else(|e| e.into_inner());
            for c in b.values() {
                c.store(true, Ordering::SeqCst);
            }
            b.insert(id.to_string(), control.clone());
        }
        let t0 = Instant::now();
        let mut todos: Vec<ItemHistorial> = Vec::new();
        let archivos = listar_sesiones(&self.cuentas_a_escanear());
        let r = buscar_sesiones(
            &archivos,
            q,
            &control,
            &mut |items| {
                self.entorno.emitir(NOMBRE, "results", &[json!({ "searchId": id, "items": items })]);
                todos.extend(items);
            },
            &OpcionesBusqueda { account_id, max: Some(MAX_RESULTADOS) },
        );
        self.busquedas.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        match r {
            Ok(stats) => {
                todos.sort_by(|a, b| b.ts.cmp(&a.ts));
                let mut fin = json!({ "searchId": id });
                if !control.load(Ordering::SeqCst) {
                    fin["items"] = serde_json::to_value(&todos).map_err(|e| e.to_string())?;
                }
                if let (Some(o), Ok(Value::Object(s))) = (fin.as_object_mut(), serde_json::to_value(stats)) {
                    o.extend(s);
                }
                fin["ms"] = json!(t0.elapsed().as_millis() as u64);
                self.entorno.emitir(NOMBRE, "done", &[fin]);
                Ok(json!({ "ok": true }))
            }
            Err(e) => {
                let msg = e.to_string();
                self.entorno.emitir(NOMBRE, "done", &[json!({ "searchId": id, "error": msg, "cancelled": control.load(Ordering::SeqCst), "total": todos.len() })]);
                Err(msg)
            }
        }
    }

    fn cancel(&self, id: &Value) -> Result<Value, String> {
        if let Some(c) = id.as_str().and_then(|id| self.busquedas.lock().unwrap_or_else(|e| e.into_inner()).get(id).cloned()) {
            c.store(true, Ordering::SeqCst);
        }
        Ok(Value::Null)
    }

    fn open(&self, a: &Value) -> Result<Value, String> {
        let (Some(cuenta), Some(sesion), Some(cwd)) = (a.get("accountId").and_then(Value::as_str), a.get("sessionId").and_then(Value::as_str), a.get("cwd").and_then(Value::as_str)) else {
            return Err("Datos inválidos.".into());
        };
        if !es_uuid(sesion) {
            return Err("Id de conversación inválido.".into());
        }
        if cwd.is_empty() || cwd.encode_utf16().count() > 1000 {
            return Err("Carpeta inválida.".into());
        }
        let acc = self.cuenta_con_historial(cuenta)?;
        if !Path::new(cwd).is_dir() {
            return Err(format!("La carpeta {cwd} ya no existe: no se puede retomar ahí."));
        }
        // Claude busca la conversación en projects/<slug del cwd>: tiene que estar ahí.
        let config = PathBuf::from(texto(&acc, "configDir").unwrap_or_default());
        if !config.join("projects").join(slug_de(cwd)).join(format!("{sesion}.jsonl")).exists() {
            return Err("No encontré esa conversación en la carpeta de la cuenta.".into());
        }
        let existente = comun::espacios(&self.entorno).into_iter().find(|w| texto(w, "accountId").as_deref() == Some(cuenta) && texto(w, "cwd").is_some_and(|c| misma_ruta(&c, cwd)));
        let (ws, creado) = match existente {
            Some(ws) => {
                let id = texto(&ws, "id").unwrap_or_default();
                if a.get("confirmRestart") != Some(&Value::Bool(true)) && comun::terminal_viva(&self.entorno, &id).unwrap_or(false) {
                    return Ok(json!({ "needsConfirm": true, "wsId": id, "wsName": texto(&ws, "name") }));
                }
                (ws, false)
            }
            None => {
                let nombre = Some(nombre_base(cwd)).filter(|s| !s.is_empty()).unwrap_or_else(|| cwd.to_string());
                let input = json!({ "name": nombre, "repoPath": cwd, "accountId": cuenta, "autoStartClaude": true, "resume": true });
                (self.entorno.pedir("workspaces:add", vec![input], ALTA_DE_ESPACIO)?, true)
            }
        };
        let id = texto(&ws, "id").ok_or("No se pudo crear el espacio.")?;
        let mut r = json!({ "wsId": id, "created": creado, "wsName": texto(&ws, "name") });
        if ws.get("autoStartClaude").and_then(Value::as_bool) == Some(true) {
            self.entorno.pedir("pty:resumeOnce", vec![json!(id), json!(cuenta), json!(sesion)], Duration::from_secs(10))?;
        } else {
            r["manualCommand"] = json!(format!("claude --resume {sesion}"));
        }
        if !creado {
            comun::reiniciar_terminal(&self.entorno, &id)?;
        }
        comun::ui(&self.entorno, json!({ "type": "open-pane", "id": id }));
        Ok(r)
    }
}

/// Nombre de archivo a partir del título: sin caracteres que Windows no acepta y de 60 como mucho.
fn nombre_de_archivo(titulo: &str) -> String {
    let limpio: String = titulo.chars().map(|c| if "<>:\"/\\|?*".contains(c) || (c as u32) < 0x20 { ' ' } else { c }).collect();
    let junto = limpio.split_whitespace().collect::<Vec<_>>().join(" ");
    let corto: String = String::from_utf16_lossy(&junto.encode_utf16().take(60).collect::<Vec<u16>>());
    let corto = corto.trim().to_string();
    if corto.is_empty() { "conversacion".into() } else { corto }
}

pub fn armar(entorno: Arc<Entorno>) -> Arc<Historial> {
    Arc::new(Historial { entorno, busquedas: Mutex::default(), cache: Mutex::default() })
}

pub fn registrar(router: &mut Router, entorno: Arc<Entorno>) {
    let h = armar(entorno);
    macro_rules! canal {
        ($op:literal, |$f:ident, $a:ident| $cuerpo:expr) => {{
            let $f = h.clone();
            router.registrar(concat!("feat:history:", $op), move |$a: Vec<Value>| {
                let _ = &$a;
                $cuerpo
            });
        }};
    }
    canal!("list", |f, a| f.list());
    canal!("detail", |f, a| f.detail(arg(&a, 0), arg(&a, 1)));
    canal!("delete", |f, a| f.delete(arg(&a, 0), arg(&a, 1)));
    canal!("pin", |f, a| f.marcar(Lista::Fijadas, arg(&a, 0), arg(&a, 1)));
    canal!("hide", |f, a| f.marcar(Lista::Ocultas, arg(&a, 0), arg(&a, 1)));
    canal!("export", |f, a| f.export(arg(&a, 0), arg(&a, 1)));
    canal!("search", |f, a| f.search(arg(&a, 0), arg(&a, 1), arg(&a, 2)));
    canal!("cancel", |f, a| f.cancel(arg(&a, 0)));
    canal!("open", |f, a| f.open(arg(&a, 0)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_comunes::{EntornoDePrueba, ReenvioNulo};
    use std::fs;

    const SID: &str = "11111111-2222-3333-4444-555555555555";

    struct Prueba {
        t: EntornoDePrueba,
        router: Router,
        config: PathBuf,
        repo: PathBuf,
        pedidos: Arc<Mutex<Vec<(String, Vec<Value>)>>>,
    }

    fn transcript(cwd: &str) -> String {
        [
            json!({ "type": "user", "cwd": cwd, "gitBranch": "main", "timestamp": "2026-11-20T10:00:00Z", "message": { "role": "user", "content": "arreglá el login por favor" } }),
            json!({ "type": "assistant", "cwd": cwd, "timestamp": "2026-11-20T10:05:00Z", "message": { "role": "assistant", "content": [{ "type": "text", "text": "Listo, arreglé el login." }] } }),
        ]
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
    }

    /// Una cuenta de Claude con una conversación en `repo` y, si `con_espacio`, un espacio que la usa.
    fn armar_prueba(nombre: &str, con_espacio: bool, viva: bool) -> Prueba {
        let t = EntornoDePrueba::nuevo(nombre);
        let config = t.carpeta.join("cuenta");
        let repo = t.carpeta.join("repo");
        fs::create_dir_all(&repo).unwrap();
        let cwd = repo.to_string_lossy().into_owned();
        let dir = config.join("projects").join(slug_de(&cwd));
        fs::create_dir_all(dir.join(SID)).unwrap();
        fs::write(dir.join(format!("{SID}.jsonl")), transcript(&cwd)).unwrap();
        let espacios = if con_espacio { json!([{ "id": "w1", "name": "Repo", "repoPath": cwd, "cwd": cwd, "accountId": "acc", "autoStartClaude": true }]) } else { json!([]) };
        t.fijar_estado(&json!({ "version": 1, "accounts": [{ "id": "acc", "label": "Trabajo", "configDir": config.to_string_lossy() }], "workspaces": espacios }));
        let pedidos: Arc<Mutex<Vec<(String, Vec<Value>)>>> = Arc::default();
        let anotados = pedidos.clone();
        t.fijar_apoyo(move |canal, args| {
            anotados.lock().unwrap().push((canal.to_string(), args.to_vec()));
            match canal {
                "pty:running" => Ok(json!(viva)),
                "workspaces:add" => Ok(json!({ "id": "nuevo", "name": args[0]["name"], "cwd": args[0]["repoPath"], "accountId": "acc", "autoStartClaude": true })),
                "feat:settings:get" => Ok(json!({ "settings": { "lightMode": false } })),
                _ => Ok(Value::Null),
            }
        });
        let mut router = Router::nuevo(Arc::new(ReenvioNulo));
        registrar(&mut router, t.entorno.clone());
        Prueba { t, router, config, repo, pedidos }
    }

    impl Prueba {
        async fn pedir(&self, op: &str, args: Vec<Value>) -> Result<Value, String> {
            self.router.invocar(format!("feat:history:{op}"), args).await
        }
        fn canales_pedidos(&self) -> Vec<String> {
            self.pedidos.lock().unwrap().iter().map(|(c, _)| c.clone()).collect()
        }
        fn jsonl(&self) -> PathBuf {
            self.config.join("projects").join(slug_de(&self.repo.to_string_lossy())).join(format!("{SID}.jsonl"))
        }
    }

    #[test]
    fn registra_los_nueve_canales() {
        let p = armar_prueba("hist-canales", false, false);
        for op in ["list", "detail", "delete", "pin", "hide", "export", "search", "cancel", "open"] {
            assert!(p.router.atiende(&format!("feat:history:{op}")), "{op}");
        }
        assert_eq!(p.router.canales().len(), 9);
    }

    #[tokio::test]
    async fn list_arma_la_fila_con_el_espacio_que_usa_la_carpeta() {
        let p = armar_prueba("hist-list", true, false);
        let v = p.pedir("list", vec![]).await.unwrap();
        let s = &v["sessions"][0];
        assert_eq!(s["key"], json!(format!("acc:{SID}")));
        assert_eq!((s["spaceId"].clone(), s["spaceName"].clone(), s["accountLabel"].clone()), (json!("w1"), json!("Repo"), json!("Trabajo")));
        assert_eq!(s["branch"], json!("main"));
        assert_eq!((v["pinned"].clone(), v["hidden"].clone()), (json!([]), json!([])));
    }

    #[tokio::test]
    async fn sin_espacio_la_fila_usa_la_carpeta() {
        let p = armar_prueba("hist-sinesp", false, false);
        let s = p.pedir("list", vec![]).await.unwrap()["sessions"][0].clone();
        assert_eq!(s["spaceId"], Value::Null);
        assert_eq!(s["spaceName"], json!("repo"));
        assert_eq!(s["spaceKey"], json!(format!("cwd:{}", p.repo.to_string_lossy().to_lowercase())));
    }

    #[tokio::test]
    async fn pin_y_hide_quedan_en_history_json_y_validan_la_clave() {
        let p = armar_prueba("hist-pin", false, false);
        let k = format!("acc:{SID}");
        assert_eq!(p.pedir("pin", vec![json!(k), json!(true)]).await.unwrap(), json!({ "pinned": [k], "hidden": [] }));
        p.pedir("hide", vec![json!(k), json!(true)]).await.unwrap();
        let guardado: Value = serde_json::from_str(&fs::read_to_string(p.t.carpeta.join("perfil/features/history.json")).unwrap()).unwrap();
        assert_eq!(guardado, json!({ "pinned": [k], "hidden": [k] }));
        assert_eq!(p.pedir("pin", vec![json!("mal"), json!(true)]).await.unwrap_err(), "Datos inválidos.");
        assert_eq!(p.pedir("pin", vec![json!(k), json!("si")]).await.unwrap_err(), "Datos inválidos.");
    }

    #[tokio::test]
    async fn detail_valida_los_ids_con_los_mensajes_del_ts() {
        let p = armar_prueba("hist-detail", false, false);
        assert_eq!(p.pedir("detail", vec![json!(1), json!(SID)]).await.unwrap_err(), "Datos inválidos.");
        assert_eq!(p.pedir("detail", vec![json!("acc"), json!("no-uuid")]).await.unwrap_err(), "Id de conversación inválido.");
        assert_eq!(p.pedir("detail", vec![json!("otra"), json!(SID)]).await.unwrap_err(), "Esa cuenta ya no existe en Sloth.");
        let d = p.pedir("detail", vec![json!("acc"), json!(SID)]).await.unwrap();
        assert_eq!(d["lastAnswer"], json!("Listo, arreglé el login."));
        assert!(d["items"].as_array().unwrap().len() >= 2);
    }

    #[tokio::test]
    async fn delete_no_toca_nada_con_la_terminal_abierta() {
        let p = armar_prueba("hist-del-viva", true, true);
        let e = p.pedir("delete", vec![json!("acc"), json!(SID)]).await.unwrap_err();
        assert_eq!(e, "«Repo» tiene la terminal abierta. Cerrala antes de borrar esta conversación.");
        assert!(p.jsonl().exists());
        assert!(p.t.plataforma.papelera.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn delete_manda_el_jsonl_y_su_carpeta_a_la_papelera_y_limpia_las_marcas() {
        let p = armar_prueba("hist-del", true, false);
        let k = format!("acc:{SID}");
        p.pedir("pin", vec![json!(k), json!(true)]).await.unwrap();
        assert_eq!(p.pedir("delete", vec![json!("acc"), json!(SID)]).await.unwrap(), json!({ "pinned": [], "hidden": [] }));
        assert!(!p.jsonl().exists());
        assert_eq!(p.t.plataforma.papelera.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn export_escribe_el_markdown_donde_se_eligio_y_cancelar_da_null() {
        let p = armar_prueba("hist-export", false, false);
        assert_eq!(p.pedir("export", vec![json!("acc"), json!(SID)]).await.unwrap(), Value::Null);
        let destino = p.t.carpeta.join("salida.md");
        *p.t.plataforma.guardar_en.lock().unwrap() = Some(destino.clone());
        assert_eq!(p.pedir("export", vec![json!("acc"), json!(SID)]).await.unwrap(), json!({ "file": "salida.md" }));
        let md = fs::read_to_string(destino).unwrap();
        assert!(md.starts_with("# arreglá el login por favor"), "{md}");
        assert!(md.contains("- **Cuenta:** Trabajo"));
    }

    #[tokio::test]
    async fn search_emite_resultados_y_done_y_valida_la_consulta() {
        let p = armar_prueba("hist-search", false, false);
        assert_eq!(p.pedir("search", vec![json!("b 1"), json!("login"), Value::Null]).await.unwrap_err(), "Búsqueda inválida.");
        assert_eq!(p.pedir("search", vec![json!("b1"), json!(" x "), Value::Null]).await.unwrap_err(), "Escribí entre 2 y 200 caracteres.");
        assert_eq!(p.pedir("search", vec![json!("b1"), json!("login"), json!({})]).await.unwrap(), json!({ "ok": true }));
        let ev = p.t.eventos();
        let done = ev.iter().find(|(c, _)| c == "feat:history:done").expect("done");
        assert_eq!(done.1[0]["searchId"], json!("b1"));
        assert_eq!(done.1[0]["cancelled"], json!(false));
        assert!(!done.1[0]["items"].as_array().unwrap().is_empty());
        assert!(ev.iter().any(|(c, _)| c == "feat:history:results"));
    }

    #[tokio::test]
    async fn open_sin_espacio_lo_pide_al_dueno_del_store_y_pide_retomar_la_conversacion() {
        let p = armar_prueba("hist-open", false, false);
        let cwd = p.repo.to_string_lossy().into_owned();
        let v = p.pedir("open", vec![json!({ "accountId": "acc", "sessionId": SID, "cwd": cwd })]).await.unwrap();
        assert_eq!(v, json!({ "wsId": "nuevo", "created": true, "wsName": "repo" }));
        assert_eq!(p.canales_pedidos(), ["workspaces:add", "pty:resumeOnce"]);
        let pedidos = p.pedidos.lock().unwrap().clone();
        assert_eq!(pedidos[0].1[0], json!({ "name": "repo", "repoPath": cwd, "accountId": "acc", "autoStartClaude": true, "resume": true }));
        assert_eq!(pedidos[1].1, vec![json!("nuevo"), json!("acc"), json!(SID)]);
        assert!(p.t.eventos().contains(&("ui:command".to_string(), vec![json!({ "type": "open-pane", "id": "nuevo" })])));
    }

    #[tokio::test]
    async fn open_con_la_terminal_viva_pide_confirmar_y_despues_la_reinicia() {
        let p = armar_prueba("hist-open-viva", true, true);
        let cwd = p.repo.to_string_lossy().into_owned();
        let v = p.pedir("open", vec![json!({ "accountId": "acc", "sessionId": SID, "cwd": cwd })]).await.unwrap();
        assert_eq!(v, json!({ "needsConfirm": true, "wsId": "w1", "wsName": "Repo" }));
        let v = p.pedir("open", vec![json!({ "accountId": "acc", "sessionId": SID, "cwd": cwd, "confirmRestart": true })]).await.unwrap();
        assert_eq!(v, json!({ "wsId": "w1", "created": false, "wsName": "Repo" }));
        assert!(p.canales_pedidos().ends_with(&["pty:resumeOnce".to_string(), "pty:kill".to_string()]));
        assert!(p.t.eventos().contains(&("ui:command".to_string(), vec![json!({ "type": "restart-pane", "id": "w1" })])));
    }

    #[tokio::test]
    async fn open_rechaza_lo_que_no_esta_en_la_carpeta_de_la_cuenta() {
        let p = armar_prueba("hist-open-mal", false, false);
        let otra = p.t.carpeta.join("otra");
        fs::create_dir_all(&otra).unwrap();
        let e = p.pedir("open", vec![json!({ "accountId": "acc", "sessionId": SID, "cwd": otra.to_string_lossy() })]).await.unwrap_err();
        assert_eq!(e, "No encontré esa conversación en la carpeta de la cuenta.");
        assert_eq!(p.pedir("open", vec![json!({ "accountId": "acc" })]).await.unwrap_err(), "Datos inválidos.");
        assert!(p.canales_pedidos().is_empty());
    }

    #[test]
    fn el_nombre_del_archivo_exportado_saca_lo_que_windows_no_acepta() {
        assert_eq!(nombre_de_archivo("a/b: c?"), "a b c");
        assert_eq!(nombre_de_archivo("  "), "conversacion");
        assert_eq!(nombre_de_archivo(&"x".repeat(80)).len(), 60);
    }
}
