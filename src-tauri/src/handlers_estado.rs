//! Canales del núcleo que atiende Rust: estado, cuentas, espacios, terminales, portapapeles, diálogos y la función
//! `settings`. Mismos nombres y mismas validaciones que src/main/index.ts y src/main/features/settings.ts (los
//! argumentos llegan sin validar). También los pedidos del proceso de apoyo (`rust.store`, `rust.ajustes`, `rust.nucleo`).
use crate::handlers::arg;
use crate::nucleo::arranque::ahora_ms;
use crate::nucleo::{texto_de_estado, Nucleo};
use crate::router::{Respuesta, Router};
use serde_json::{json, Map, Value};
use sloth_core::agent_machine::EntradaAgente;
use sloth_core::app_state::EstadoDeAgente;
use sloth_core::cuentas as c;
use sloth_core::espacios as e;
use sloth_core::ipc_guard::{dim_valida, id_valido};
use sloth_core::proveedores::{proveedor_id_de, ProveedorId};
use sloth_core::ptys_core::{a_spawn_spec, detectar_shells, resolver_shell, PtySpec, ShellsDisponibles};
use sloth_core::settings_model::{aplicar_cambio, restaurar_seccion};
use std::path::Path;
use std::sync::{Arc, OnceLock};

pub const NOMBRE_SETTINGS: &str = "settings";
const PEDIDO_INVALIDO: &str = "Pedido inválido.";

/// Lee la imagen del portapapeles como PNG (la da la cáscara; sin ventana, en los tests, no hay).
pub type LeerImagen = Arc<dyn Fn() -> Option<Vec<u8>> + Send + Sync>;

pub fn uuid() -> String {
    let h = sloth_core::daemon_protocolo::nuevo_nonce();
    let variante = ["8", "9", "a", "b"][usize::from_str_radix(&h[16..17], 16).unwrap_or(0) % 4];
    format!("{}-{}-4{}-{}{}-{}", &h[0..8], &h[8..12], &h[13..16], variante, &h[17..20], &h[20..32])
}

/// Lo que la primera terminal necesita y tarda (buscar pwsh): se hace antes de que la pidan.
pub fn precalentar() {
    shells();
}

fn shells() -> &'static ShellsDisponibles {
    static S: OnceLock<ShellsDisponibles> = OnceLock::new();
    S.get_or_init(detectar_shells)
}

fn es_directorio(p: &str) -> bool {
    Path::new(p).is_dir()
}

fn objeto(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

/// `<padre>/<repo>-worktrees/<rama>`: usa la rama si ya existe; si no, la crea desde la base (o desde HEAD).
pub fn crear_worktree(repo: &str, rama: &str, base: Option<&str>) -> Result<String, String> {
    use sloth_core::git_run::{Git, OpcionesRun, ProcesoEjecutor};
    let g = Git::new(ProcesoEjecutor);
    let ms = || OpcionesRun::timeout(120_000);
    if g.git(repo, &["rev-parse", "--is-inside-work-tree"], ms()).map(|s| s.trim() == "true") != Ok(true) {
        return Err(format!("{repo} no es un repositorio git"));
    }
    let limpio: String = {
        let mut s = String::new();
        for ch in rama.chars() {
            if ch.is_ascii_alphanumeric() || "._-".contains(ch) {
                s.push(ch);
            } else if !s.ends_with('-') {
                s.push('-');
            }
        }
        let s = s.trim_matches('-').to_string();
        if s.is_empty() { "rama".into() } else { s }
    };
    let r = Path::new(repo);
    let nombre = r.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let destino = r.parent().unwrap_or(r).join(format!("{nombre}-worktrees")).join(limpio);
    let destino_t = destino.to_string_lossy().into_owned();
    if destino.exists() {
        return Err(format!("Ya existe la carpeta {destino_t}"));
    }
    let existe = g.git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{rama}")], ms()).is_ok();
    let mut args = vec!["worktree", "add"];
    if existe {
        args.extend([destino_t.as_str(), rama]);
    } else {
        args.extend(["-b", rama, destino_t.as_str()]);
        args.extend(base);
    }
    g.git(repo, &args, ms()).map_err(|x| format!("git worktree falló: {}", x.mensaje))?;
    Ok(destino_t)
}

pub fn alta_de_espacio(n: &Nucleo, input: &Value) -> Respuesta {
    e::comprobar_pedido_de_alta(input)?;
    n.store().exigir_escritura()?;
    let a = e::validar_alta_de_espacio(input, &es_directorio, &|id| c::exigir_cuenta(n.cuenta(id).as_ref(), &|d| Path::new(d).exists()).map(|_| ()))?;
    let cwd = match &a.branch {
        Some(b) => crear_worktree(&a.repo_path, b, a.base_branch.as_deref())?,
        None => a.repo_path.clone(),
    };
    let ws = e::armar_registro_de_espacio(&a, uuid(), cwd, ahora_ms());
    n.cambiar(|s| s.add_workspace(ws.clone()))?;
    Ok(ws)
}

pub fn baja_de_espacio(n: &Nucleo, id: &Value) -> Respuesta {
    let id = id_valido(id).ok_or(PEDIDO_INVALIDO)?;
    n.store().exigir_escritura()?;
    // El worktree queda en disco a propósito: puede tener trabajo sin commitear.
    n.backend()?.kill(id)?;
    n.olvidar_agente(id);
    n.cambiar(|s| s.remove_workspace(id))?;
    Ok(Value::Null)
}

fn arrancar_terminal(n: &Nucleo, id: &Value, cols: &Value, rows: &Value) -> Respuesta {
    let (Some(id), Some(cols), Some(rows)) = (id_valido(id), dim_valida(cols), dim_valida(rows)) else { return Err(PEDIDO_INVALIDO.into()) };
    let t = n.backend()?;
    if n.es_ajena(id) {
        return Err("Esa terminal es de otro perfil.".into());
    }
    // Si ya corre (siguió viva en el daemon), solo se reconecta: no se rearma la cuenta ni el comando.
    let corriendo = t.esta_corriendo(id);
    let spec = if corriendo { PtySpec { cwd: std::env::var("USERPROFILE").unwrap_or_default(), ..Default::default() } } else { n.cuentas.spec(n, id)? };
    let shell = resolver_shell(&n.shell_elegida(), shells());
    let (spawn, paste) = a_spawn_spec(&spec, cols, rows, &shell);
    let r = t.start(id, spawn)?;
    n.tam_pc.lock().unwrap_or_else(|x| x.into_inner()).insert(id.to_string(), (cols, rows));
    n.apoyo.evento("rust.pty", json!(["tam", id, cols, rows]));
    n.apoyo.evento("rust.pty", json!(["start", id]));
    let ws = if corriendo { None } else { n.espacio(id) };
    if let Some(ws) = &ws {
        let nombre = ws["name"].as_str().unwrap_or_default();
        if let Err(x) = crate::entorno::agregar_actividad_espacio(&n.arranque.perfil.join("actividad"), nombre, ahora_ms()) {
            sloth_core::logger_global::aviso("perfiles", &format!("no se pudo registrar la actividad: {x}"));
        }
        let pendiente = ws["initialPrompt"].as_str().is_some_and(|p| !p.is_empty()) && ws["initialPromptUsed"] != Value::Bool(true);
        if pendiente && spec.claude.as_ref().is_some_and(|a| a.iter().any(|x| x == "--")) {
            let acc = ws["accountId"].as_str().and_then(|a| n.cuenta(a));
            let p = acc.as_ref().and_then(proveedor_id_de);
            match sloth_core::primer_mensaje::destino_primer_mensaje(p.map_or(true, |p| p.capacidades().hooks), paste.as_deref()) {
                sloth_core::primer_mensaje::DestinoPrimerMensaje::Pegar => n.anotar_pegado(id, paste.unwrap_or_default()),
                destino => {
                    let mut parche = Map::new();
                    parche.insert("initialPromptUsed".into(), Value::Bool(true));
                    n.cambiar(|s| s.update_workspace(id, &parche))?;
                    if let (sloth_core::primer_mensaje::DestinoPrimerMensaje::AMano, Some(p)) = (destino, p) {
                        sloth_core::avisos::Avisos::global().avisar(sloth_core::primer_mensaje::aviso_primer_mensaje_a_mano(p.nombre(), nombre));
                    }
                }
            }
        }
    }
    if n.espacio(id).is_some() {
        n.mover_agente(id, EntradaAgente::Start, None, None);
    }
    serde_json::to_value(r).map_err(|x| x.to_string())
}

fn alta_de_cuenta(n: &Nucleo, label: &Value, proveedor: Option<&Value>) -> Respuesta {
    let alta = c::validar_alta_de_cuenta(label, proveedor)?;
    n.store().exigir_escritura()?;
    if let Some(id) = alta.proveedor {
        let carpeta_perfiles = n.arranque.raiz.join("perfiles");
        let cuentas = n.store().accounts().to_vec();
        let motivo = c::motivo_no_agregar_cuenta(&cuentas, id, &mut || sloth_core::tope_cuentas::cuentas_en_otros_perfiles(&carpeta_perfiles, &n.arranque.id_perfil, id, &mut |t| sloth_core::logger_global::aviso("cuentas", &t)));
        if let Some(m) = motivo {
            return Err(m);
        }
        if id == ProveedorId::Copilot && !hay_powershell_7() {
            return Err(sloth_core::agente_exe::AVISO_POWERSHELL_7.into());
        }
    }
    let creada = c::crear_cuenta(&c::carpeta_de_cuentas(&n.arranque.raiz), &alta.label, alta.proveedor, uuid(), ahora_ms())?;
    for a in creada.avisos {
        sloth_core::logger_global::aviso(a.origen, &a.texto);
    }
    let acc = c::con_setup_compartido(creada.cuenta);
    n.cambiar(|s| s.add_account(acc.clone()))?;
    n.cuentas.preparar(n, &acc);
    Ok(acc)
}

fn hay_powershell_7() -> bool {
    if !cfg!(windows) {
        return true;
    }
    let v = |k: &str| std::env::var(k).ok();
    let candidatos = sloth_core::agente_exe::candidatos_pwsh(v("ProgramW6432").as_deref(), v("ProgramFiles").as_deref(), &v("PATH").unwrap_or_default(), v("LOCALAPPDATA").as_deref(), &|p| Path::new(p).exists());
    sloth_core::agente_exe::hay_powershell_7(&candidatos, &mut |exe| {
        let mut cmd = std::process::Command::new(exe);
        cmd.args(["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", "$PSVersionTable.PSVersion.Major"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        cmd.output().ok().map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
    })
}

fn compartir_setup(n: &Nucleo, id: &Value, share: &Value) -> Respuesta {
    let (id, share) = c::pedido_id_y_booleano(id, share)?;
    c::comprobar_setup_compartido(n.cuenta(id).as_ref())?;
    let mut parche = Map::new();
    parche.insert("shareSetup".into(), Value::Bool(share));
    let acc = n.cambiar(|s| s.update_account(id, &parche))?.ok_or(c::CUENTA_INEXISTENTE)?;
    c::exigir_proveedor(&acc)?;
    Ok(n.cuentas.aplicar_compartir(n, &acc))
}

fn baja_de_cuenta(n: &Nucleo, id: &Value) -> Respuesta {
    let id = id_valido(id).ok_or(PEDIDO_INVALIDO)?;
    c::comprobar_baja_de_cuenta(id, n.store().workspaces())?;
    n.store().exigir_escritura()?;
    n.backend()?.kill(&format!("login:{id}"))?;
    if let Some(acc) = n.cuenta(id) {
        // Las funciones del apoyo limpian lo suyo con la cuenta todavía en el store.
        n.avisar_funciones("cuentaBorrada", &acc);
        if let Err(x) = n.apoyo.pedir("nucleo:cuentaBorrada", vec![acc]) {
            sloth_core::logger_global::error("borrar cuenta", x);
        }
    }
    n.cambiar(|s| s.remove_account(id))?;
    Ok(Value::Null)
}

fn cambiar_espacio(n: &Nucleo, id: &Value, patch: &Value) -> Respuesta {
    let id = id.as_str().filter(|i| n.espacio(i).is_some()).ok_or(e::ESPACIO_INEXISTENTE)?;
    let cambio = sloth_core::workspace_patch::validar_cambio_de_espacio(patch)?;
    let p = e::parche_de_cambio(&cambio);
    let quitar = if p.quitar_icono { vec!["icon".to_string()] } else { vec![] };
    n.cambiar(|s| s.update_workspace_quitando(id, &p.campos, &quitar))?.ok_or_else(|| e::ESPACIO_INEXISTENTE.to_string())
}

fn mostrar_espacio(n: &Nucleo, id: &Value, target: &Value) -> Respuesta {
    let ws = id.as_str().and_then(|i| n.espacio(i)).ok_or(e::ESPACIO_INEXISTENTE)?;
    let cwd = ws["cwd"].as_str().unwrap_or_default().to_string();
    if !es_directorio(&cwd) {
        return Err(e::error_sin_carpeta(&cwd));
    }
    let editor = n.ajustes().get("editor").and_then(Value::as_str).unwrap_or_default().to_string();
    match (e::destino_de_reveal(target)?, e::esquema_de_editor(&editor)) {
        (e::DestinoReveal::Editor, Some(esquema)) => n.plataforma.abrir_enlace_externo(&e::url_de_editor(esquema, &cwd)).map_err(|_| e::error_al_abrir_editor(&editor))?,
        _ => n.plataforma.abrir_ruta(&cwd)?,
    }
    Ok(Value::Null)
}

fn leer_portapapeles(n: &Nucleo, imagen: &LeerImagen) -> Respuesta {
    let v = n.plataforma.leer_portapapeles();
    if let Some(t) = v["text"].as_str().filter(|t| !t.is_empty()) {
        return Ok(json!(t));
    }
    let comillas = |p: &str| if p.chars().any(char::is_whitespace) { format!("\"{p}\"") } else { p.to_string() };
    let archivos: Vec<String> = v["files"].as_array().map(|a| a.iter().filter_map(Value::as_str).filter(|s| !s.is_empty()).map(comillas).collect()).unwrap_or_default();
    if !archivos.is_empty() {
        return Ok(json!(archivos.join(" ")));
    }
    // Una captura de pantalla se guarda como PNG y se pega su ruta, que Claude Code adjunta.
    let Some(png) = imagen().filter(|b| !b.is_empty()) else { return Ok(json!("")) };
    let dir = std::env::temp_dir().join("Sloth").join("pegados");
    std::fs::create_dir_all(&dir).map_err(|x| x.to_string())?;
    let un_dia = std::time::Duration::from_secs(24 * 3600);
    for f in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        if f.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|d| d > un_dia) {
            let _ = std::fs::remove_file(f.path());
        }
    }
    let archivo = dir.join(format!("imagen-{}.png", ahora_ms()));
    std::fs::write(&archivo, png).map_err(|x| x.to_string())?;
    Ok(json!(comillas(&archivo.to_string_lossy())))
}

fn cambiar_ajustes(n: &Nucleo, patch: &Value) -> Respuesta {
    if serde_json::to_string(patch).map(|s| s.len()).unwrap_or(usize::MAX) > 8_192 {
        return Err("Cambio demasiado grande.".into());
    }
    let nuevos = aplicar_cambio(&n.ajustes(), patch, Some(&|id: &str| n.cuenta(id).is_some()))?;
    Ok(n.guardar_ajustes(nuevos))
}

pub fn registrar(router: &mut Router, n: &Arc<Nucleo>, imagen: LeerImagen) {
    macro_rules! canal {
        ($nombre:expr, |$nn:ident, $a:ident| $cuerpo:expr) => {{
            let $nn = n.clone();
            router.registrar($nombre, move |$a: Vec<Value>| {
                let $nn: &Nucleo = &$nn;
                let _ = &$a;
                $cuerpo
            });
        }};
    }
    canal!("state:get", |n, a| Ok(n.estado_ui()));
    canal!("permission:pending", |n, a| Ok(Value::Array(n.permisos_pendientes())));
    canal!("daemon:info", |n, a| n.info_daemon());
    canal!("daemon:shutdown", |n, a| n.apagar_daemon().map(|_| Value::Null));
    canal!("accounts:add", |n, a| alta_de_cuenta(n, arg(&a, 0), a.get(1).filter(|v| !v.is_null())));
    canal!("accounts:setShareSetup", |n, a| compartir_setup(n, arg(&a, 0), arg(&a, 1)));
    canal!("accounts:remove", |n, a| baja_de_cuenta(n, arg(&a, 0)));
    canal!("accounts:statuses", |n, a| Ok(Value::Object(n.store().accounts().iter().filter_map(|x| Some((x["id"].as_str()?.to_string(), c::estado_de_cuenta(x)))).collect())));
    canal!("workspaces:add", |n, a| alta_de_espacio(n, arg(&a, 0)));
    canal!("workspaces:remove", |n, a| baja_de_espacio(n, arg(&a, 0)));
    canal!("workspaces:update", |n, a| cambiar_espacio(n, arg(&a, 0), arg(&a, 1)));
    canal!("workspaces:reveal", |n, a| mostrar_espacio(n, arg(&a, 0), arg(&a, 1)));
    canal!("ui:openPanes", |n, a| {
        if let Some(ids) = e::paneles_a_guardar(arg(&a, 0)) {
            n.cambiar(|s| s.set_open_panes(&ids))?;
        }
        Ok(Value::Null)
    });
    canal!("dialog:pickFolder", |n, a| Ok(n.plataforma.elegir_carpeta().map_or(Value::Null, Value::String)));
    canal!("pty:start", |n, a| arrancar_terminal(n, arg(&a, 0), arg(&a, 1), arg(&a, 2)));
    // Las funciones que tocan la config de una cuenta (el MCP del chat) preguntan antes si tiene terminales abiertas.
    // `conocidas` es false hasta que el daemon reporta las que sobrevivieron.
    canal!("pty:cuentaOcupada", |n, a| {
        let id = arg(&a, 0);
        if !id.is_null() && id_valido(id).is_none() {
            return Err(PEDIDO_INVALIDO.into());
        }
        let conocidas = n.terminales_si_hay().is_some();
        Ok(json!({ "conocidas": conocidas, "ocupada": id.as_str().is_some_and(|i| !conocidas || n.cuenta_ocupada(i)) }))
    });
    canal!("pty:running", |n, a| Ok(json!(n.backend()?.esta_corriendo(id_valido(arg(&a, 0)).ok_or(PEDIDO_INVALIDO)?))));
    canal!("pty:resumeOnce", |n, a| {
        let (Some(ws), Some(cuenta), Some(sesion)) = (id_valido(arg(&a, 0)), id_valido(arg(&a, 1)), arg(&a, 2).as_str().filter(|s| sloth_core::history_core::es_uuid(s))) else {
            return Err(PEDIDO_INVALIDO.into());
        };
        if n.espacio(ws).is_none() {
            return Err(e::ESPACIO_INEXISTENTE.into());
        }
        n.cuentas.retomar_una_vez(ws, cuenta, sesion);
        Ok(Value::Null)
    });
    canal!("pty:kill", |n, a| n.matar(id_valido(arg(&a, 0)).ok_or(PEDIDO_INVALIDO)?).map(|_| Value::Null));
    let ni = n.clone();
    router.registrar("clipboard:read", move |_| leer_portapapeles(&ni, &imagen));
    canal!("clipboard:write", |n, a| {
        let v = arg(&a, 0);
        n.plataforma.escribir_portapapeles(&v.as_str().map(str::to_owned).unwrap_or_else(|| if v.is_null() { "undefined".into() } else { v.to_string() }));
        Ok(Value::Null)
    });
    let nw = n.clone();
    router.registrar_envio("pty:write", move |a| {
        if let (Some(id), Some(data)) = (id_valido(arg(&a, 0)), arg(&a, 1).as_str()) {
            nw.escribir(id, data);
        }
    });
    let nr = n.clone();
    router.registrar_envio("pty:resize", move |a| {
        if let (Some(id), Some(cols), Some(rows)) = (id_valido(arg(&a, 0)), dim_valida(arg(&a, 1)), dim_valida(arg(&a, 2))) {
            nr.redimensionar(id, cols, rows, true);
        }
    });
    canal!("feat:settings:get", |n, a| Ok(n.payload_de_ajustes()));
    canal!("feat:settings:set", |n, a| cambiar_ajustes(n, arg(&a, 0)));
    canal!("feat:settings:reset", |n, a| Ok(n.guardar_ajustes(restaurar_seccion(&n.ajustes(), arg(&a, 0))?)));
    canal!("feat:settings:pickProjectsDir", |n, a| match n.plataforma.elegir_carpeta() {
        None => Ok(n.payload_de_ajustes()),
        Some(dir) => Ok(n.guardar_ajustes(aplicar_cambio(&n.ajustes(), &json!({ "projectsDir": dir }), None)?)),
    });
}

/// Los nombres de las funciones del apoyo: solo se muestran en el diagnóstico, pero igual se acotan.
fn nombres_de_funciones(v: &Value) -> Vec<String> {
    let lista = v.as_array().map(Vec::as_slice).unwrap_or_default();
    lista.iter().filter_map(Value::as_str).filter(|s| !s.is_empty() && s.len() <= 64).take(100).map(str::to_owned).collect()
}

/// Lo que el proceso de apoyo le pide al dueño del estado (`rust.*` del puente nativo).
pub fn atender_apoyo(n: &Nucleo, op: &str, args: &[Value]) -> Respuesta {
    let a = |i: usize| arg(args, i);
    let texto = |i: usize| a(i).as_str().ok_or_else(|| PEDIDO_INVALIDO.to_string());
    match op {
        "rust.store" => {
            let sub = texto(0)?;
            match sub {
                "addAccount" => {
                    let acc = sloth_core::store_core::validar_cuenta(a(1)).ok_or(PEDIDO_INVALIDO)?;
                    n.cambiar(|s| s.add_account(Value::Object(acc)))?;
                    Ok(Value::Null)
                }
                "updateAccount" => Ok(n.cambiar(|s| s.update_account(texto(1)?, &objeto(a(2))))?.unwrap_or(Value::Null)),
                "updateWorkspace" => {
                    let quitar: Vec<String> = a(3).as_array().map(|q| q.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default();
                    Ok(n.cambiar(|s| s.update_workspace_quitando(texto(1)?, &objeto(a(2)), &quitar))?.unwrap_or(Value::Null))
                }
                "removeAccount" => n.cambiar(|s| s.remove_account(texto(1)?)).map(|_| Value::Null),
                "addWorkspace" => {
                    let ws = sloth_core::store_core::validar_espacio(a(1)).ok_or(PEDIDO_INVALIDO)?;
                    n.cambiar(|s| s.add_workspace(Value::Object(ws)))?;
                    Ok(Value::Null)
                }
                "removeWorkspace" => n.cambiar(|s| s.remove_workspace(texto(1)?)).map(|_| Value::Null),
                "setOpenPanes" => {
                    let ids = e::paneles_a_guardar(a(1)).ok_or(PEDIDO_INVALIDO)?;
                    n.cambiar(|s| s.set_open_panes(&ids)).map(|_| Value::Null)
                }
                otro => Err(format!("operación del store desconocida: {otro}")),
            }
        }
        "rust.ajustes" => {
            let nuevos = aplicar_cambio(&n.ajustes(), a(0), Some(&|id: &str| n.cuenta(id).is_some()))?;
            Ok(n.guardar_ajustes(nuevos))
        }
        "rust.nucleo" => {
            let sub = texto(0)?;
            match sub {
                "addWorkspace" => alta_de_espacio(n, a(1)),
                "removeWorkspace" => baja_de_espacio(n, a(1)),
                "setAgent" => {
                    let ws = texto(1)?;
                    let st = a(2);
                    let estado = st["state"].as_str().and_then(texto_de_estado).ok_or(PEDIDO_INVALIDO)?;
                    n.fijar_agente(ws, EstadoDeAgente { estado, detalle: st["detail"].as_str().map(str::to_owned), at: st["at"].as_u64().unwrap_or_else(ahora_ms) });
                    Ok(Value::Null)
                }
                "prepareAccount" => {
                    let acc = n.cuenta(texto(1)?).ok_or(c::CUENTA_INEXISTENTE)?;
                    n.cuentas.preparar(n, &acc);
                    Ok(Value::Null)
                }
                "write" => {
                    // `crudo`: lo que una función escribe directo en la terminal, sin pasar por «lo que escribe la persona».
                    if a(3).as_bool() == Some(true) {
                        n.escribir_crudo(texto(1)?, texto(2)?);
                    } else {
                        n.escribir(texto(1)?, texto(2)?);
                    }
                    Ok(Value::Null)
                }
                "resize" => {
                    let (Some(cols), Some(rows)) = (dim_valida(a(2)), dim_valida(a(3))) else { return Err(PEDIDO_INVALIDO.into()) };
                    n.redimensionar(texto(1)?, cols, rows, false);
                    Ok(Value::Null)
                }
                "start" => {
                    let id = texto(1)?;
                    let spawn = serde_json::from_value(a(2).clone()).map_err(|_| PEDIDO_INVALIDO.to_string())?;
                    serde_json::to_value(n.backend()?.start(id, spawn)?).map_err(|x| x.to_string())
                }
                "kill" => {
                    let id = texto(1)?;
                    if n.es_ajena(id) {
                        return Err("Esa terminal es de otro perfil.".into());
                    }
                    n.backend()?.kill(id).map(|_| Value::Null)
                }
                "list" => serde_json::to_value(n.backend()?.list()?).map_err(|x| x.to_string()),
                "info" => Ok(n.backend()?.info()),
                "shutdown" => n.apagar_daemon().map(|_| Value::Null),
                "answer" => {
                    n.responder_permiso(texto(1)?, a(2).clone());
                    Ok(Value::Null)
                }
                "conectar" => {
                    n.backend()?;
                    Ok(n.terminales_si_hay().map(|t| t.info()).unwrap_or(Value::Null))
                }
                "cerrarAjenas" => n.cerrar_terminales_ajenas().map(|x| json!(x)),
                "cambioDePerfil" => {
                    n.cambiando_perfil.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(Value::Null)
                }
                "listo" => {
                    n.marcar_apoyo_listo(nombres_de_funciones(a(1)));
                    Ok(Value::Null)
                }
                "cerrar" => {
                    n.al_salir();
                    Ok(Value::Null)
                }
                "log" => {
                    let (nivel, origen, msg) = (texto(1)?, texto(2)?, texto(3)?);
                    match nivel {
                        "error" => sloth_core::logger_global::error(origen, msg),
                        "aviso" => sloth_core::logger_global::aviso(origen, msg),
                        _ => sloth_core::logger_global::info(origen, msg),
                    }
                    Ok(Value::Null)
                }
                otro => Err(format!("operación del núcleo desconocida: {otro}")),
            }
        }
        otro => n.nativo_de_funciones(otro, args),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nucleo::arranque::arrancar;
    use crate::nucleo::terminales::ConfDaemon;
    use crate::nucleo::Apoyo;
    use crate::router::{Futuro, Reenvio};
    use crate::tests_comunes::PlataformaSimulada;
    use sloth_core::agent_machine::EstadoAgente;
    use std::path::PathBuf;
    use std::sync::Mutex;

    #[derive(Default)]
    struct ApoyoSimulado {
        eventos: Mutex<Vec<(String, Value)>>,
        pedidos: Mutex<Vec<(String, Vec<Value>)>>,
        reenviados: Mutex<Vec<String>>,
    }

    impl Apoyo for ApoyoSimulado {
        fn evento(&self, nombre: &str, args: Value) {
            self.eventos.lock().unwrap().push((nombre.into(), args));
        }
        fn pedir(&self, canal: &str, args: Vec<Value>) -> Result<Value, String> {
            self.pedidos.lock().unwrap().push((canal.into(), args));
            Ok(Value::Null)
        }
    }

    struct ReenvioSimulado(Arc<ApoyoSimulado>);

    impl Reenvio for ReenvioSimulado {
        fn invocar(&self, canal: String, _: Vec<Value>) -> Futuro<Respuesta> {
            self.0.reenviados.lock().unwrap().push(canal.clone());
            Box::pin(async move { Ok(json!({ "desde": "apoyo", "canal": canal })) })
        }
        fn enviar(&self, canal: String, _: Vec<Value>) {
            self.0.reenviados.lock().unwrap().push(canal);
        }
    }

    struct Armado {
        router: Router,
        nucleo: Arc<Nucleo>,
        apoyo: Arc<ApoyoSimulado>,
        plataforma: Arc<PlataformaSimulada>,
        raiz: PathBuf,
    }

    impl Drop for Armado {
        fn drop(&mut self) {
            self.nucleo.al_salir();
            let _ = std::fs::remove_dir_all(&self.raiz);
        }
    }

    fn armar(nombre: &str, estado: Option<Value>, exe: Option<PathBuf>) -> Armado {
        armar_con(nombre, estado, exe, |_| {})
    }

    /// `antes` recibe la carpeta del perfil para dejar archivos antes de crear el núcleo.
    fn armar_con(nombre: &str, estado: Option<Value>, exe: Option<PathBuf>, antes: impl FnOnce(&Path)) -> Armado {
        let raiz = std::env::temp_dir().join(format!("sloth-nucleo-{nombre}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&raiz);
        let arranque = arrancar(&raiz, None, sloth_core::avisos::Avisos::global());
        if let Some(e) = estado {
            std::fs::write(arranque.perfil.join("sloth-state.json"), e.to_string()).unwrap();
        }
        antes(&arranque.perfil);
        let plataforma = Arc::new(PlataformaSimulada::default());
        let apoyo = Arc::new(ApoyoSimulado::default());
        let conf = ConfDaemon { raiz: raiz.clone(), version: "0.0.0-prueba".into(), exe };
        let nucleo = Nucleo::nuevo(plataforma.clone(), arranque, apoyo.clone(), conf);
        let mut router = Router::nuevo(Arc::new(ReenvioSimulado(apoyo.clone())));
        registrar(&mut router, &nucleo, Arc::new(|| None));
        nucleo.marcar_apoyo_listo(vec![]);
        Armado { router, nucleo, apoyo, plataforma, raiz }
    }

    fn estado_con_espacio(raiz_repo: &str) -> Value {
        json!({ "version": 1, "accounts": [{ "id": "a1", "label": "Prueba", "configDir": raiz_repo, "createdAt": 1 }],
                "workspaces": [{ "id": "w1", "name": "Uno", "repoPath": raiz_repo, "cwd": raiz_repo, "accountId": "a1", "autoStartClaude": false, "createdAt": 2, "icon": "x" }],
                "openPanes": ["w1"] })
    }

    fn invocar(a: &Armado, canal: &str, args: Vec<Value>) -> Respuesta {
        tauri::async_runtime::block_on(a.router.invocar(canal.into(), args))
    }

    fn copias_empujadas(a: &Armado) -> usize {
        a.apoyo.eventos.lock().unwrap().iter().filter(|(n, _)| n == "rust.estado").count()
    }

    #[test]
    fn state_get_sale_del_store_de_rust_y_lo_que_no_es_del_nucleo_va_al_apoyo() {
        let repo = std::env::temp_dir().to_string_lossy().into_owned();
        let a = armar("estado", Some(estado_con_espacio(&repo)), None);
        let e = invocar(&a, "state:get", vec![]).unwrap();
        assert_eq!(e["accounts"][0]["id"], "a1");
        assert_eq!(e["workspaces"][0]["name"], "Uno");
        assert_eq!(e["openPanes"], json!(["w1"]));
        assert!(e.get("soloLectura").is_none());
        assert!(a.apoyo.reenviados.lock().unwrap().is_empty());
        let v = invocar(&a, "accounts:usage", vec![]).unwrap();
        assert_eq!(v["desde"], "apoyo");
        assert!(invocar(&a, "nucleo:comando", vec![]).is_err());
    }

    #[test]
    fn state_get_espera_a_que_las_funciones_del_apoyo_fijen_su_estado() {
        let repo = std::env::temp_dir().to_string_lossy().into_owned();
        let raiz = std::env::temp_dir().join(format!("sloth-nucleo-espera-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&raiz);
        let arranque = arrancar(&raiz, None, sloth_core::avisos::Avisos::global());
        std::fs::write(arranque.perfil.join("sloth-state.json"), estado_con_espacio(&repo).to_string()).unwrap();
        let n = Nucleo::nuevo(Arc::new(PlataformaSimulada::default()), arranque, Arc::new(ApoyoSimulado::default()), ConfDaemon { raiz: raiz.clone(), version: "x".into(), exe: None });
        let apoyo = n.clone();
        let hilo = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(200));
            atender_apoyo(&apoyo, "rust.nucleo", &[json!("setAgent"), json!("w1"), json!({ "state": "sleeping", "at": 1 })]).unwrap();
            atender_apoyo(&apoyo, "rust.nucleo", &[json!("listo")]).unwrap();
        });
        assert_eq!(n.estado_ui()["agents"]["w1"]["state"], "sleeping");
        hilo.join().unwrap();
        let _ = std::fs::remove_dir_all(&raiz);
    }

    #[test]
    fn terminales_que_consultan_otras_funciones() {
        let repo = std::env::temp_dir().to_string_lossy().into_owned();
        let a = armar("consultas", Some(estado_con_espacio(&repo)), None);
        // Sin daemon conectado no se sabe qué terminales hay: la cuenta se da por ocupada.
        assert_eq!(invocar(&a, "pty:cuentaOcupada", vec![json!("a1")]).unwrap(), json!({ "conocidas": false, "ocupada": true }));
        assert_eq!(invocar(&a, "pty:cuentaOcupada", vec![]).unwrap(), json!({ "conocidas": false, "ocupada": false }));
        assert_eq!(invocar(&a, "pty:cuentaOcupada", vec![json!(7)]).unwrap_err(), PEDIDO_INVALIDO);
        let uuid = "123e4567-e89b-12d3-a456-426614174000";
        assert_eq!(invocar(&a, "pty:resumeOnce", vec![json!("w1"), json!("a1"), json!("no-uuid")]).unwrap_err(), PEDIDO_INVALIDO);
        assert_eq!(invocar(&a, "pty:resumeOnce", vec![json!("nada"), json!("a1"), json!(uuid)]).unwrap_err(), e::ESPACIO_INEXISTENTE);
        invocar(&a, "pty:resumeOnce", vec![json!("w1"), json!("a1"), json!(uuid)]).unwrap();
        assert!(invocar(&a, "pty:running", vec![json!(1)]).is_err());
    }

    #[test]
    fn cambiar_un_espacio_valida_saca_el_icono_guarda_y_empuja_la_copia() {
        let repo = std::env::temp_dir().to_string_lossy().into_owned();
        let a = armar("cambiar", Some(estado_con_espacio(&repo)), None);
        assert_eq!(invocar(&a, "workspaces:update", vec![json!("nada"), json!({ "name": "x" })]).unwrap_err(), e::ESPACIO_INEXISTENTE);
        assert!(invocar(&a, "workspaces:update", vec![json!("w1"), json!({ "name": 5 })]).is_err());
        let antes = copias_empujadas(&a);
        let ws = invocar(&a, "workspaces:update", vec![json!("w1"), json!({ "name": "Nuevo", "icon": null })]).unwrap();
        assert_eq!(ws["name"], "Nuevo");
        assert!(ws.get("icon").is_none());
        assert_eq!(copias_empujadas(&a), antes + 1);
        let guardado: Value = serde_json::from_str(&std::fs::read_to_string(a.nucleo.arranque.perfil.join("sloth-state.json")).unwrap()).unwrap();
        assert_eq!(guardado["workspaces"][0]["name"], "Nuevo");
        assert!(guardado["workspaces"][0].get("icon").is_none());
    }

    #[test]
    fn paneles_abiertos_y_baja_de_cuenta_con_espacios() {
        let repo = std::env::temp_dir().to_string_lossy().into_owned();
        let a = armar("paneles", Some(estado_con_espacio(&repo)), None);
        invocar(&a, "ui:openPanes", vec![json!(["w1", 3, "login:a1"])]).unwrap();
        assert_eq!(a.nucleo.store().open_panes(), ["w1", "login:a1"]);
        invocar(&a, "ui:openPanes", vec![json!("no es lista")]).unwrap();
        assert_eq!(a.nucleo.store().open_panes(), ["w1", "login:a1"]);
        let err = invocar(&a, "accounts:remove", vec![json!("a1")]).unwrap_err();
        assert!(err.starts_with("La usan 1 espacio(s): Uno"), "{err}");
        assert_eq!(invocar(&a, "accounts:remove", vec![json!(42)]).unwrap_err(), PEDIDO_INVALIDO);
    }

    #[test]
    fn la_configuracion_se_valida_se_guarda_y_avisa_a_la_ui_y_al_apoyo() {
        let a = armar("ajustes", None, None);
        assert!(invocar(&a, "feat:settings:set", vec![json!({ "theme": "violeta" })]).is_err());
        let grande = json!({ "projectsDir": "x".repeat(9000) });
        assert_eq!(invocar(&a, "feat:settings:set", vec![grande]).unwrap_err(), "Cambio demasiado grande.");
        let p = invocar(&a, "feat:settings:set", vec![json!({ "theme": "claro" })]).unwrap();
        assert_eq!(p["settings"]["theme"], "claro");
        assert_eq!(p["dark"], false);
        let archivo: Value = serde_json::from_str(&std::fs::read_to_string(a.nucleo.arranque.perfil.join("features").join("settings.json")).unwrap()).unwrap();
        assert_eq!(archivo["theme"], "claro");
        assert_eq!(archivo["version"], 1);
        assert!(a.plataforma.eventos.lock().unwrap().iter().any(|(c, args)| c == "feat:settings:changed" && args[0]["settings"]["theme"] == "claro"));
        assert!(a.apoyo.eventos.lock().unwrap().iter().any(|(n, v)| n == "rust.ajustes" && v[0]["theme"] == "claro"));
        let r = invocar(&a, "feat:settings:reset", vec![json!("apariencia")]).unwrap();
        assert_eq!(r["settings"]["theme"], "oscuro");
        assert!(invocar(&a, "feat:settings:reset", vec![json!("inventada")]).is_err());
    }

    #[test]
    fn las_escrituras_del_apoyo_pasan_por_rust_validadas() {
        let repo = std::env::temp_dir().to_string_lossy().into_owned();
        let a = armar("apoyo", Some(estado_con_espacio(&repo)), None);
        let n = &a.nucleo;
        assert!(atender_apoyo(n, "rust.store", &[json!("addAccount"), json!({ "id": "x" })]).is_err());
        atender_apoyo(n, "rust.store", &[json!("addAccount"), json!({ "id": "a2", "label": "Dos", "configDir": "C:\\x", "createdAt": 3, "rara": 1 })]).unwrap();
        assert_eq!(n.cuenta("a2").unwrap()["rara"], 1);
        let ws = atender_apoyo(n, "rust.store", &[json!("updateWorkspace"), json!("w1"), json!({ "initialPromptUsed": true }), json!(["icon"])]).unwrap();
        assert_eq!(ws["initialPromptUsed"], true);
        assert!(ws.get("icon").is_none());
        atender_apoyo(n, "rust.store", &[json!("setOpenPanes"), json!([])]).unwrap();
        assert!(n.store().open_panes().is_empty());
        atender_apoyo(n, "rust.nucleo", &[json!("setAgent"), json!("w1"), json!({ "state": "sleeping", "at": 9 })]).unwrap();
        assert_eq!(n.agentes_json()["w1"], json!({ "state": "sleeping", "at": 9 }));
        assert!(a.plataforma.eventos.lock().unwrap().iter().any(|(c, args)| c == "agent:status" && args[0] == "w1"));
        assert!(atender_apoyo(n, "rust.nucleo", &[json!("setAgent"), json!("w1"), json!({ "state": "volando" })]).is_err());
        assert!(atender_apoyo(n, "rust.store", &[json!("borrarTodo")]).is_err());
    }

    #[test]
    fn un_store_de_una_version_futura_queda_en_solo_lectura_sin_reescribirse() {
        let texto = json!({ "version": 99, "accounts": [], "workspaces": [], "openPanes": [] }).to_string();
        let raiz = std::env::temp_dir().join(format!("sloth-nucleo-futura-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&raiz);
        let arranque = arrancar(&raiz, None, sloth_core::avisos::Avisos::global());
        let archivo = arranque.perfil.join("sloth-state.json");
        std::fs::write(&archivo, &texto).unwrap();
        let n = Nucleo::nuevo(Arc::new(PlataformaSimulada::default()), arranque, Arc::new(ApoyoSimulado::default()), ConfDaemon { raiz: raiz.clone(), version: "x".into(), exe: None });
        let e = n.store().solo_lectura().map(|s| s.causa);
        assert_eq!(e, Some(sloth_core::store::CausaSoloLectura::VersionFutura));
        assert!(n.store().exigir_escritura().is_err());
        let _ = n.cambiar(|s| s.set_open_panes(&["w".into()]));
        assert_eq!(std::fs::read_to_string(&archivo).unwrap(), texto);
        let _ = std::fs::remove_dir_all(&raiz);
    }

    #[cfg(windows)]
    #[test]
    fn con_el_daemon_real_pty_start_write_y_kill_mueven_terminal_y_agente() {
        let Some(exe) = crate::tests_comunes::exe_del_daemon() else {
            eprintln!("SIN DAEMON: compilá native/daemon en el mismo CARGO_TARGET_DIR para correr esta prueba");
            return;
        };
        let carpeta = std::env::temp_dir().join(format!("sloth-nucleo-repo-{}", std::process::id()));
        std::fs::create_dir_all(carpeta.join("cuenta")).unwrap();
        let repo = carpeta.to_string_lossy().into_owned();
        let mut estado = estado_con_espacio(&repo);
        estado["accounts"][0]["configDir"] = json!(carpeta.join("cuenta").to_string_lossy());
        let a = armar("pty", Some(estado), Some(exe));
        invocar(&a, "feat:settings:set", vec![json!({ "terminal": { "shell": "Símbolo del sistema" } })]).unwrap();
        assert_eq!(invocar(&a, "pty:start", vec![json!("w1"), json!(0), json!(24)]).unwrap_err(), PEDIDO_INVALIDO);
        let r = invocar(&a, "pty:start", vec![json!("w1"), json!(80), json!(24)]).unwrap();
        assert_eq!(r["running"], true);
        assert_eq!(a.nucleo.agentes_json()["w1"]["state"], "idle");
        // Los hooks de Claude quedan instalados en la cuenta antes de abrir la terminal.
        let settings = std::fs::read_to_string(carpeta.join("cuenta").join("settings.json")).unwrap();
        assert!(settings.contains("sloth-hook"), "{settings}");
        a.router.enviar("pty:write".into(), vec![json!("w1"), json!("echo hola-nucleo\r\n")]);
        let limite = std::time::Instant::now() + std::time::Duration::from_secs(15);
        let vio = || a.plataforma.eventos.lock().unwrap().iter().any(|(c, args)| c == "pty:data" && args[0] == "w1" && args[1].to_string().contains("hola-nucleo"));
        while !vio() && std::time::Instant::now() < limite {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(vio(), "no llegó la salida a la interfaz");
        assert!(a.apoyo.eventos.lock().unwrap().iter().any(|(n, v)| n == "rust.pty" && v[0] == "write" && v[1] == "w1"));
        assert!(a.apoyo.eventos.lock().unwrap().iter().any(|(n, v)| n == "rust.pty" && v[0] == "data"));
        assert_eq!(invocar(&a, "daemon:info", vec![]).unwrap()["sessions"], 1);
        invocar(&a, "pty:kill", vec![json!("w1")]).unwrap();
        assert_eq!(a.nucleo.agentes_json()["w1"]["state"], "exited");
        invocar(&a, "daemon:shutdown", vec![]).unwrap();
        assert!(a.nucleo.terminales_si_hay().is_none());
        drop(a);
        let _ = std::fs::remove_dir_all(&carpeta);
    }

    #[test]
    fn diagnostico_lista_las_funciones_de_rust_y_del_apoyo_y_avisa_el_cierre_inesperado_una_vez() {
        let mut a = armar("diagnostico", None, None);
        crate::handlers::diagnostico::registrar(&mut a.router, &a.nucleo, "142.0.3595.53".into());
        a.nucleo.marcar_apoyo_listo(nombres_de_funciones(&json!(["permissions", "", 7, "x".repeat(65), "celular"])));
        let (_, _) = crate::nucleo::arranque::MarcaDeSesion::iniciar(&a.raiz);
        let (marca, crash) = crate::nucleo::arranque::MarcaDeSesion::iniciar(&a.raiz);
        assert!(crash);
        a.nucleo.fijar_sesion(marca, crash);

        let texto = invocar(&a, "feat:diagnostico:texto", vec![]).unwrap();
        let texto = texto.as_str().unwrap();
        assert!(texto.contains("WebView2 142.0.3595.53") && !texto.contains("Electron"), "{texto}");
        assert!(texto.contains("settings, diagnostico, sleep, permissions, celular
"), "{texto}");
        assert!(texto.contains("Funciones activas: git, "), "{texto}");
        assert!(texto.contains("La sesión anterior terminó de forma inesperada."));

        assert_eq!(invocar(&a, "feat:diagnostico:crashPrevio", vec![]).unwrap(), json!(true));
        assert_eq!(invocar(&a, "feat:diagnostico:crashPrevio", vec![]).unwrap(), json!(false));
        for p in [json!(null), json!({ "mensaje": "" }), json!({ "mensaje": "roto", "stack": "at a" })] {
            assert_eq!(invocar(&a, "feat:diagnostico:errorRenderer", vec![p]).unwrap(), Value::Null);
        }
    }

    #[test]
    fn al_salir_la_sesion_queda_limpia() {
        let a = armar("sesion-limpia", None, None);
        let (marca, _) = crate::nucleo::arranque::MarcaDeSesion::iniciar(&a.raiz);
        a.nucleo.fijar_sesion(marca, false);
        a.nucleo.al_salir();
        let (_, crash) = crate::nucleo::arranque::MarcaDeSesion::iniciar(&a.raiz);
        assert!(!crash);
    }

    #[test]
    fn un_dormido_arranca_dormido_y_al_despertarlo_se_reabre_con_continue() {
        let repo = std::env::temp_dir().join(format!("sloth-repo-dormido-{}", std::process::id()));
        std::fs::create_dir_all(&repo).unwrap();
        let estado = estado_con_espacio(&repo.to_string_lossy());
        let mut a = armar_con("dormido", Some(estado), None, |perfil| {
            std::fs::create_dir_all(perfil.join("features")).unwrap();
            std::fs::write(perfil.join("features").join("sleep.json"), r#"{"asleep":["w1"]}"#).unwrap();
        });
        crate::handlers::sleep::registrar(&mut a.router, &a.nucleo);
        assert_eq!(a.nucleo.estado_de_agente("w1").map(|e| e.estado), Some(EstadoAgente::Sleeping));

        assert_eq!(invocar(&a, "feat:sleep:wake", vec![json!("no-existe")]).unwrap_err(), "Ese espacio ya no existe.");
        assert!(invocar(&a, "feat:sleep:wake", vec![json!(5)]).is_err());
        assert_eq!(invocar(&a, "feat:sleep:wake", vec![json!("w1")]).unwrap(), Value::Null);
        assert_eq!(a.nucleo.estado_de_agente("w1").map(|e| e.estado), Some(EstadoAgente::Idle));
        let reinicio = a.plataforma.eventos.lock().unwrap().iter().any(|(c, args)| c == "ui:command" && args[0] == json!({ "type": "restart-pane", "id": "w1" }));
        assert!(reinicio, "la UI reabre la terminal");
        // Sin terminal viva la marca queda: la próxima terminal arranca con `claude --continue` y la gasta.
        assert!(a.nucleo.dormir.tomar_para_retomar("w1"));
        assert!(!a.nucleo.dormir.tomar_para_retomar("w1"));
        let _ = std::fs::remove_dir_all(&repo);
    }
}
