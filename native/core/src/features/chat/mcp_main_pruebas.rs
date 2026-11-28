//! Pruebas del lado main del MCP: el registro con el CLI (con un CLI falso que escribe el `.claude.json` como lo haría
//! `claude mcp add`), los tokens, la config guardada y el canal local de verdad.
use super::*;
use crate::features::chat::datos::{Canales, Entorno, Fabrica, Nucleo};
use crate::features::chat::postgrest::Supabase;
use crate::features::chat::realtime::EventoRealtime;
use crate::features::chat::sesion::pruebas::carpeta;
use std::io::{Read, Write};

const HELPER: &str = "C:/Sloth/bin/sloth-hook.exe";
const UUID: &str = "11111111-1111-4111-8111-111111111111";

#[derive(Default)]
struct EntornoFalso {
    cuentas: Mutex<Vec<CuentaMcp>>,
    helper: Mutex<Option<String>>,
    conocidas: Mutex<bool>,
    libre: Mutex<bool>,
    llamadas: Mutex<Vec<(String, Vec<String>)>>,
    falla: Mutex<Option<String>>,
    emitidos: Mutex<Vec<(String, Value)>>,
    logs: Mutex<Vec<String>>,
}

impl EntornoMcp for EntornoFalso {
    fn emitir(&self, canal: &str, payload: Value) {
        self.emitidos.lock().unwrap().push((canal.into(), payload));
    }
    fn log(&self, m: &str) {
        self.logs.lock().unwrap().push(m.into());
    }
    fn cuentas(&self) -> Vec<CuentaMcp> {
        self.cuentas.lock().unwrap().clone()
    }
    fn helper_exe(&self) -> Option<String> {
        self.helper.lock().unwrap().clone()
    }
    fn terminales_conocidas(&self) -> bool {
        *self.conocidas.lock().unwrap()
    }
    fn cuenta_libre(&self, _: &str) -> bool {
        *self.libre.lock().unwrap()
    }
    /// Hace lo que el CLI: `mcp add` escribe la entrada «sloth» en el `.claude.json` de la cuenta y `mcp remove` la saca.
    fn correr(&self, exe: &str, args: &[String], env: &[(String, String)]) -> Res<()> {
        self.llamadas.lock().unwrap().push((exe.into(), args.to_vec()));
        if let Some(f) = self.falla.lock().unwrap().clone() {
            return Err(f);
        }
        let dir = env.iter().find(|(k, _)| k == "CLAUDE_CONFIG_DIR").map(|(_, v)| PathBuf::from(v)).unwrap();
        let archivo = dir.join(".claude.json");
        let mut v: Value = std::fs::read_to_string(&archivo).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}));
        if args[1] == "add" {
            let token = args.iter().find_map(|a| a.strip_prefix("SLOTH_CHAT_TOKEN=")).unwrap();
            let sep = args.iter().position(|a| a == "--").unwrap();
            v["mcpServers"]["sloth"] = json!({"type": "stdio", "command": args[sep + 1], "args": args[sep + 2..], "env": {"SLOTH_CHAT_TOKEN": token}});
        } else {
            v["mcpServers"].as_object_mut().map(|o| o.remove("sloth"));
        }
        std::fs::write(&archivo, v.to_string()).map_err(|e| e.to_string())
    }
    fn espacio(&self, id: &str) -> Option<EspacioMcp> {
        (id == "ws1").then(|| EspacioMcp { nombre: "Mi repo".into(), cuenta: "a1".into(), cwd: carpeta("mcp-ws") })
    }
    fn ventana_con_foco(&self) -> bool {
        false
    }
    fn notificar(&self, _: &str, _: &str) {}
    fn ahora_ms(&self) -> i64 {
        1_700_000_000_000
    }
    fn nuevo_id(&self) -> String {
        "55555555-5555-4555-8555-555555555555".into()
    }
}

struct SinSupabase;
impl Nucleo for SinSupabase {
    fn cliente(&self) -> Option<Arc<Supabase>> {
        None
    }
    fn me(&self) -> Option<ChatProfile> {
        None
    }
}

struct EntornoDatosMudo;
impl Entorno for EntornoDatosMudo {
    fn emitir(&self, _: &str, _: Value) {}
    fn log(&self, _: &str) {}
    fn al_cambiar(&self) {}
    fn ventana_con_foco(&self) -> bool {
        false
    }
    fn ventana_abierta(&self) -> bool {
        false
    }
    fn ajustes(&self) -> crate::features::chat::datos::AjustesAviso {
        crate::features::chat::datos::AjustesAviso { notificar_equipo: false, no_molestar: false }
    }
    fn notificar(&self, _: &str, _: &str, _: &ChatConvRef) {}
    fn ahora_ms(&self) -> i64 {
        0
    }
}

struct Mundo {
    mcp: McpMain,
    env: Arc<EntornoFalso>,
    datos_dir: PathBuf,
    features_dir: PathBuf,
}

fn cuenta(id: &str, dir: PathBuf, prov: ProveedorMcp) -> CuentaMcp {
    std::fs::create_dir_all(&dir).unwrap();
    CuentaMcp { id: id.into(), label: format!("Cuenta {id}"), config_dir: dir.clone(), proveedor: prov }
}

fn soporta(dir: &std::path::Path) -> ProveedorMcp {
    ProveedorMcp::Soporta { exe: Some("C:/bin/claude.exe".into()), env: vec![("CLAUDE_CONFIG_DIR".into(), dir.to_string_lossy().into_owned())] }
}

fn mundo_con(n: &str, config: Option<Value>) -> Mundo {
    let base = carpeta(n);
    let (datos_dir, features_dir) = (base.join("userData"), base.join("userData").join("features"));
    std::fs::create_dir_all(&features_dir).unwrap();
    if let Some(c) = config {
        std::fs::write(features_dir.join("chat-mcp.json"), c.to_string()).unwrap();
    }
    let env = Arc::new(EntornoFalso::default());
    let dir = base.join("a1");
    env.cuentas.lock().unwrap().push(cuenta("a1", dir.clone(), soporta(&dir)));
    *env.helper.lock().unwrap() = Some(HELPER.into());
    *env.conocidas.lock().unwrap() = true;
    *env.libre.lock().unwrap() = true;
    let fabrica: Fabrica = Arc::new(|_| -> (Arc<dyn Canales>, std::sync::mpsc::Receiver<EventoRealtime>) { panic!("sin sesión no se abre realtime") });
    let datos = Arc::new(ChatDatos::nuevo(Arc::new(SinSupabase), Arc::new(EntornoDatosMudo), fabrica));
    let mcp = McpMain::nuevo(env.clone(), datos, datos_dir.clone(), features_dir.clone());
    Mundo { mcp, env, datos_dir, features_dir }
}

fn mundo(n: &str) -> Mundo {
    mundo_con(n, Some(json!({"v": 2, "enabled": true, "cuentas": ["a1"], "grants": [], "tokens": {}})))
}

fn cuenta_a1(m: &Mundo) -> CuentaMcp {
    m.env.cuentas()[0].clone()
}

fn estado_de(m: &Mundo) -> (EstadoRegistro, Option<String>) {
    let r = bloquear(&m.mcp.interno().regs).get("a1").cloned().unwrap();
    (r.state, r.detail)
}

fn sincronizar(m: &Mundo) {
    m.mcp.interno().sincronizar_ahora(&cuenta_a1(m), false);
}

fn guardado(m: &Mundo) -> Value {
    serde_json::from_str(&std::fs::read_to_string(m.features_dir.join("chat-mcp.json")).unwrap()).unwrap()
}

/// Espera a que se cumpla algo que pasa en otro hilo; el plazo es solo para que un fallo no cuelgue la corrida.
fn esperar(cond: impl Fn() -> bool) {
    let limite = std::time::Instant::now() + Duration::from_secs(30);
    while !cond() {
        assert!(std::time::Instant::now() < limite, "no pasó lo esperado");
        std::thread::sleep(Duration::from_millis(5));
    }
}

// ----- registro con el CLI -----

#[test]
fn el_alta_registra_sloth_hook_chat_mcp_con_un_token_y_guarda_solo_su_hash() {
    let m = mundo("mm-1");
    sincronizar(&m);
    assert_eq!(estado_de(&m).0, EstadoRegistro::Ok);
    let ll = m.env.llamadas.lock().unwrap().clone();
    assert_eq!(ll.len(), 1);
    assert_eq!(ll[0].0, "C:/bin/claude.exe");
    let a = &ll[0].1;
    assert_eq!(&a[..6], ["mcp", "add", "-s", "user", "sloth", "-e"]);
    let token = a[6].strip_prefix("SLOTH_CHAT_TOKEN=").unwrap();
    assert_eq!(token.len(), 64);
    assert_eq!(&a[7..], ["--", HELPER, "chat-mcp"]);
    let g = guardado(&m);
    assert_eq!(g["tokens"]["a1"], hash_token(token));
    assert!(!g.to_string().contains(token), "el token en claro no se guarda");
}

#[test]
fn con_el_registro_al_dia_no_se_vuelve_a_llamar_al_cli() {
    let m = mundo("mm-2");
    sincronizar(&m);
    sincronizar(&m);
    assert_eq!(m.env.llamadas.lock().unwrap().len(), 1);
    assert_eq!(estado_de(&m).0, EstadoRegistro::Ok);
}

#[test]
fn un_helper_en_otra_ruta_reemplaza_el_registro_con_baja_y_alta_y_cambia_el_token() {
    let m = mundo("mm-3");
    sincronizar(&m);
    let primero = bloquear(&m.mcp.interno().cfg).hash_de("a1").unwrap().to_string();
    *m.env.helper.lock().unwrap() = Some("C:/Otra/sloth-hook.exe".into());
    sincronizar(&m);
    let ll = m.env.llamadas.lock().unwrap().clone();
    assert_eq!(ll.len(), 3);
    assert_eq!(ll[1].1, args_baja());
    assert_eq!(ll[2].1.last().map(String::as_str), Some("chat-mcp"));
    assert_ne!(bloquear(&m.mcp.interno().cfg).hash_de("a1").unwrap(), primero);
}

#[test]
fn apagar_el_interruptor_saca_el_registro_y_borra_los_tokens() {
    let m = mundo("mm-4");
    sincronizar(&m);
    m.mcp.poner_activado(&json!(false)).unwrap();
    // `poner_activado` sincroniza en otro hilo: se vuelve a pedir acá, que va detrás en la cola de la cuenta.
    sincronizar(&m);
    let ll = m.env.llamadas.lock().unwrap().clone();
    assert!(ll.iter().any(|(_, a)| *a == args_baja()), "{ll:?}");
    assert_eq!(guardado(&m)["enabled"], false);
    assert_eq!(guardado(&m)["tokens"], json!({}));
    assert_eq!(estado_de(&m).0, EstadoRegistro::Ok);
    let v: Value = serde_json::from_str(&std::fs::read_to_string(cuenta_a1(&m).config_dir.join(".claude.json")).unwrap()).unwrap();
    assert!(v["mcpServers"].get("sloth").is_none());
}

#[test]
fn un_mcp_sloth_ajeno_es_un_conflicto_y_no_se_toca() {
    let m = mundo("mm-5");
    std::fs::write(cuenta_a1(&m).config_dir.join(".claude.json"), json!({"mcpServers": {"sloth": {"command": "otra-cosa", "args": []}}}).to_string()).unwrap();
    sincronizar(&m);
    assert_eq!(estado_de(&m), (EstadoRegistro::Conflicto, Some("Ya hay un MCP «sloth» que no puso Sloth; no se tocó.".into())));
    assert!(m.env.llamadas.lock().unwrap().is_empty());
}

#[test]
fn un_claude_json_ilegible_no_se_toca() {
    let m = mundo("mm-6");
    std::fs::write(cuenta_a1(&m).config_dir.join(".claude.json"), "{ roto").unwrap();
    sincronizar(&m);
    assert_eq!(estado_de(&m), (EstadoRegistro::Error, Some("No se pudo leer el .claude.json de la cuenta; no se tocó.".into())));
    assert!(m.env.llamadas.lock().unwrap().is_empty());
}

#[test]
fn con_terminales_abiertas_o_sin_saber_se_deja_pendiente() {
    let m = mundo("mm-7");
    *m.env.libre.lock().unwrap() = false;
    sincronizar(&m);
    assert_eq!(estado_de(&m), (EstadoRegistro::Pendiente, Some("Se aplica cuando cierres las terminales de esta cuenta.".into())));
    *m.env.conocidas.lock().unwrap() = false;
    sincronizar(&m);
    assert!(estado_de(&m).1.unwrap().starts_with("Todavía no se sabe"));
    assert!(m.env.llamadas.lock().unwrap().is_empty());
    *m.env.conocidas.lock().unwrap() = true;
    *m.env.libre.lock().unwrap() = true;
    sincronizar(&m);
    assert_eq!(estado_de(&m).0, EstadoRegistro::Ok);
}

#[test]
fn sin_cli_o_sin_helper_no_se_toca_nada() {
    let m = mundo("mm-8");
    *m.env.helper.lock().unwrap() = None;
    sincronizar(&m);
    assert_eq!(estado_de(&m).0, EstadoRegistro::Error);
    assert!(estado_de(&m).1.unwrap().contains("sloth-hook"));
    let dir = cuenta_a1(&m).config_dir;
    m.env.cuentas.lock().unwrap()[0].proveedor = ProveedorMcp::Soporta { exe: None, env: vec![("CLAUDE_CONFIG_DIR".into(), dir.to_string_lossy().into_owned())] };
    *m.env.helper.lock().unwrap() = Some(HELPER.into());
    sincronizar(&m);
    assert_eq!(estado_de(&m), (EstadoRegistro::SinCli, Some("No encontré Claude Code (claude.exe) en el PATH; no se tocó nada.".into())));
    assert!(m.env.llamadas.lock().unwrap().is_empty());
}

#[test]
fn otros_agentes_y_agentes_desconocidos_no_se_tocan() {
    let m = mundo("mm-9");
    let dir = cuenta_a1(&m).config_dir;
    m.env.cuentas.lock().unwrap()[0].proveedor = ProveedorMcp::SinMcp { nombre: "Codex".into() };
    sincronizar(&m);
    assert_eq!(estado_de(&m), (EstadoRegistro::NoSoportado, Some("Esta cuenta es de Codex: el chat con MCP todavía no está disponible.".into())));
    m.env.cuentas.lock().unwrap()[0].proveedor = ProveedorMcp::Desconocido { aviso: "actualizá".into(), nombre: "X".into() };
    sincronizar(&m);
    assert_eq!(estado_de(&m), (EstadoRegistro::Error, Some("actualizá".into())));
    assert!(m.env.llamadas.lock().unwrap().is_empty());
    assert!(!dir.join(".claude.json").exists());
}

#[test]
fn si_el_cli_falla_queda_el_error_y_ningun_token_vale() {
    let m = mundo("mm-10");
    *m.env.falla.lock().unwrap() = Some("Claude Code no pudo cambiar su config: boom".into());
    sincronizar(&m);
    assert_eq!(estado_de(&m), (EstadoRegistro::Error, Some("Claude Code no pudo cambiar su config: boom".into())));
    assert!(bloquear(&m.mcp.interno().cfg).tokens.is_empty());
}

#[test]
fn una_cuenta_que_deja_de_estar_marcada_pierde_el_token_aunque_el_cli_no_corra() {
    let m = mundo("mm-11");
    sincronizar(&m);
    assert!(!bloquear(&m.mcp.interno().cfg).tokens.is_empty());
    *m.env.libre.lock().unwrap() = false;
    m.mcp.poner_cuentas(&json!([])).unwrap();
    assert!(bloquear(&m.mcp.interno().cfg).tokens.is_empty());
    assert_eq!(guardado(&m)["tokens"], json!({}));
}

#[test]
fn borrar_una_cuenta_saca_sus_permisos_su_token_y_su_registro() {
    let g = json!({"accountId": "a1", "conv": {"kind": "team", "id": UUID}, "nombre": "Equipo", "at": 5});
    let m = mundo_con("mm-12", Some(json!({"v": 2, "enabled": true, "cuentas": ["a1"], "grants": [g], "tokens": {}})));
    sincronizar(&m);
    m.mcp.cuenta_borrada(cuenta_a1(&m));
    let esperado = guardado(&m);
    assert_eq!((esperado["cuentas"].clone(), esperado["grants"].clone(), esperado["tokens"].clone()), (json!([]), json!([]), json!({})));
    // La baja del registro corre en otro hilo: se espera a que la UI se entere (último paso).
    esperar(|| !bloquear(&m.mcp.interno().regs).contains_key("a1") && m.env.llamadas.lock().unwrap().iter().any(|(_, a)| *a == args_baja()));
}

// ----- canales IPC -----

#[test]
fn el_interruptor_valida_el_tipo_y_se_guarda() {
    let m = mundo_con("mm-13", None);
    assert_eq!(m.mcp.poner_activado(&json!("si")), Err("Valor inválido.".to_string()));
    let v = m.mcp.poner_activado(&json!(true)).unwrap();
    assert_eq!(v["enabled"], true);
    assert_eq!(guardado(&m)["enabled"], true);
    assert_eq!(v["limits"], json!({"enviarPorMinuto": 6, "leerPorMinuto": 20, "maxTexto": 4000, "maxLeer": 50}));
    assert_eq!(v["accounts"][0]["accountId"], "a1");
    m.mcp.cerrar();
}

#[test]
fn las_cuentas_tienen_que_existir_y_soportar_el_chat() {
    let m = mundo("mm-14");
    assert!(m.mcp.poner_cuentas(&json!(["no-existe"])).is_err());
    assert!(m.mcp.poner_cuentas(&json!("a1")).is_err());
    m.env.cuentas.lock().unwrap()[0].proveedor = ProveedorMcp::SinMcp { nombre: "Codex".into() };
    assert_eq!(m.mcp.poner_cuentas(&json!(["a1"])), Err("La cuenta «Cuenta a1» es de Codex: el chat con MCP todavía no está disponible.".to_string()));
}

#[test]
fn revocar_valida_la_clave_y_saca_solo_ese_permiso() {
    let g = |id: &str| json!({"accountId": "a1", "conv": {"kind": "team", "id": id}, "nombre": "E", "at": 1});
    let otro = "22222222-2222-4222-8222-222222222222";
    let m = mundo_con("mm-15", Some(json!({"v": 2, "enabled": false, "cuentas": ["a1"], "grants": [g(UUID), g(otro)], "tokens": {}})));
    assert_eq!(m.mcp.revocar(&json!(""), &json!(format!("team:{UUID}"))), Err("Cuenta inválida.".to_string()));
    assert_eq!(m.mcp.revocar(&json!("a1"), &json!("team:x")), Err("Conversación inválida.".to_string()));
    let v = m.mcp.revocar(&json!("a1"), &json!(format!("TEAM:{}", UUID.to_uppercase()))).unwrap();
    assert_eq!(v["grants"].as_array().unwrap().len(), 1);
    assert_eq!(v["grants"][0]["conv"]["id"], otro);
    assert_eq!(m.mcp.revocar_todo().unwrap()["grants"], json!([]));
    assert_eq!(guardado(&m)["grants"], json!([]));
}

#[test]
fn responder_valida_el_pedido_y_la_eleccion() {
    let m = mundo("mm-16");
    assert_eq!(m.mcp.responder(&json!(5), &json!("once")), Err("Pedido inválido.".to_string()));
    assert_eq!(m.mcp.responder(&json!("x"), &json!("tal vez")), Err("Respuesta inválida.".to_string()));
    assert_eq!(m.mcp.pendientes(), json!([]));
}

#[test]
fn una_config_ilegible_deja_el_mcp_apagado_y_se_loguea() {
    let base = carpeta("mm-17");
    std::fs::create_dir_all(base.join("userData").join("features")).unwrap();
    std::fs::write(base.join("userData").join("features").join("chat-mcp.json"), "{ roto").unwrap();
    let env = Arc::new(EntornoFalso::default());
    let fabrica: Fabrica = Arc::new(|_| panic!("sin sesión"));
    let datos = Arc::new(ChatDatos::nuevo(Arc::new(SinSupabase), Arc::new(EntornoDatosMudo), fabrica));
    let mcp = McpMain::nuevo(env.clone(), datos, base.join("userData"), base.join("userData").join("features"));
    assert_eq!(mcp.config()["enabled"], false);
    assert!(env.logs.lock().unwrap().iter().any(|l| l.contains("config ilegible")));
}

#[test]
fn la_config_guardada_se_lee_al_arrancar_y_vive_con_el_formato_v2() {
    let m = mundo("mm-18");
    sincronizar(&m);
    let g = guardado(&m);
    assert_eq!(g["v"], 2);
    assert_eq!(g["cuentas"], json!(["a1"]));
    assert!(g["tokens"]["a1"].as_str().is_some_and(|h| h.len() == 64));
}

// ----- el canal local de verdad -----

fn preguntar(canal: &str, linea: &str) -> String {
    #[cfg(windows)]
    let mut s = loop {
        match std::fs::OpenOptions::new().read(true).write(true).open(canal) {
            Ok(f) => break f,
            Err(e) if e.raw_os_error() == Some(231) => std::thread::yield_now(),
            Err(e) => panic!("{e}"),
        }
    };
    #[cfg(unix)]
    let mut s = std::os::unix::net::UnixStream::connect(canal).unwrap();
    s.write_all(format!("{linea}\n").as_bytes()).unwrap();
    let mut r = String::new();
    let mut buf = [0u8; 512];
    while !r.ends_with('\n') {
        let n = s.read(&mut buf).unwrap();
        if n == 0 {
            break;
        }
        r.push_str(&String::from_utf8_lossy(&buf[..n]));
    }
    r
}

#[test]
fn el_canal_local_publica_su_ruta_atiende_pedidos_y_desaparece_al_apagar() {
    let m = mundo_con("mm-19", None);
    let info = m.datos_dir.join("chat-mcp.json");
    assert!(!info.exists(), "apagado no hay canal");
    m.mcp.poner_activado(&json!(true)).unwrap();
    let canal = serde_json::from_str::<Value>(&std::fs::read_to_string(&info).unwrap()).unwrap()["pipe"].as_str().unwrap().to_string();
    // Sin un token válido no se llega a ningún dato: es lo único que contesta.
    let r: Value = serde_json::from_str(&preguntar(&canal, &json!({"token": "nada", "ws": "", "pedido": {"op": "listar"}}).to_string())).unwrap();
    assert_eq!(r["ok"], false);
    assert!(r["error"].is_string());
    let basura: Value = serde_json::from_str(&preguntar(&canal, "esto no es json")).unwrap();
    assert_eq!(basura["ok"], false);
    m.mcp.poner_activado(&json!(false)).unwrap();
    assert!(!info.exists());
}

#[test]
fn un_chat_mcp_json_viejo_se_borra_al_arrancar() {
    let base = carpeta("mm-20");
    let datos = base.join("userData");
    std::fs::create_dir_all(datos.join("features")).unwrap();
    std::fs::write(datos.join("chat-mcp.json"), r#"{"pipe":"viejo"}"#).unwrap();
    let env = Arc::new(EntornoFalso::default());
    let fabrica: Fabrica = Arc::new(|_| panic!("sin sesión"));
    let d = Arc::new(ChatDatos::nuevo(Arc::new(SinSupabase), Arc::new(EntornoDatosMudo), fabrica));
    McpMain::nuevo(env, d, datos.clone(), datos.join("features"));
    assert!(!datos.join("chat-mcp.json").exists());
}

// ----- el CLI de verdad -----

fn sh(script: &str) -> (String, Vec<String>) {
    if cfg!(windows) {
        ("cmd".into(), vec!["/C".into(), script.into()])
    } else {
        ("sh".into(), vec!["-c".into(), script.into()])
    }
}

#[test]
fn correr_claude_devuelve_ok_o_la_primera_linea_de_stderr() {
    let (exe, args) = sh("exit 0");
    assert_eq!(correr_claude(&exe, &args, &[], 20_000), Ok(()));
    let (exe, args) = sh(if cfg!(windows) { "echo boom 1>&2 & exit 1" } else { "echo boom >&2; exit 1" });
    assert_eq!(correr_claude(&exe, &args, &[], 20_000), Err("Claude Code no pudo cambiar su config: boom".to_string()));
}

#[test]
fn correr_claude_pasa_el_entorno_de_la_cuenta() {
    let (exe, args) = sh(if cfg!(windows) { "if \"%CUENTA%\"==\"a1\" (exit 0) else (echo falta 1>&2 & exit 1)" } else { "[ \"$CUENTA\" = a1 ] || { echo falta >&2; exit 1; }" });
    assert_eq!(correr_claude(&exe, &args, &[("CUENTA".into(), "a1".into())], 20_000), Ok(()));
    assert!(correr_claude(&exe, &args, &[], 20_000).is_err());
}

#[test]
fn correr_claude_con_un_ejecutable_que_no_existe_explica_el_fallo() {
    let e = correr_claude("no-existe-sloth-xyz", &[], &[], 20_000).unwrap_err();
    assert!(e.starts_with("Claude Code no pudo cambiar su config: "), "{e}");
}
