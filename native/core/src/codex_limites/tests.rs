use super::*;
use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};

const AHORA: i64 = 1_700_000_000_000;

fn en_una_hora() -> f64 {
    ((AHORA + 3_600_000) / 1000) as f64
}

fn en_un_dia() -> f64 {
    ((AHORA + 86_400_000) / 1000) as f64
}

fn cinco() -> Value {
    json!({ "usedPercent": 37, "windowDurationMins": 300, "resetsAt": en_una_hora() })
}

fn semana() -> Value {
    json!({ "usedPercent": 12, "windowDurationMins": 10080, "resetsAt": en_un_dia() })
}

fn con(primary: Value, secondary: Value) -> Value {
    json!({ "rateLimits": { "primary": primary, "secondary": secondary } })
}

fn vl(pct: f64, reinicia_en: Option<f64>) -> Option<VentanaLimite> {
    Some(VentanaLimite { pct, reinicia_en })
}

fn con_campo(base: Value, k: &str, v: Value) -> Value {
    let mut o = base;
    o[k] = v;
    o
}

#[test]
fn los_pedidos_son_una_linea_json_cada_uno_con_ids_fijos_y_sin_jsonrpc() {
    let lineas = lineas_de_pedido();
    assert_eq!(lineas.len(), 3);
    let j: Vec<Value> = lineas.iter().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(j[0]["method"], "initialize");
    assert_eq!(j[0]["id"].as_f64(), Some(ID_INICIALIZAR));
    assert_eq!(j[0]["params"], json!({ "clientInfo": { "name": "sloth", "version": "1" } }));
    assert_eq!(j[1], json!({ "method": "initialized" }));
    assert_eq!(j[2]["method"], "account/rateLimits/read");
    assert_eq!(j[2]["id"].as_f64(), Some(ID_LIMITES));
    assert!(!lineas.iter().any(|l| l.contains('\n') || l.contains("jsonrpc")));
    assert_eq!(linea_inicializar(), lineas[0]);
    assert_eq!(lineas_tras_inicializar().to_vec(), lineas[1..]);
    assert_eq!(linea_inicializar(), r#"{"id":1,"method":"initialize","params":{"clientInfo":{"name":"sloth","version":"1"}}}"#);
}

#[test]
fn las_dos_ventanas_con_el_reinicio_en_ms() {
    let r = limites_de_resultado(&con(cinco(), semana()), AHORA);
    assert_eq!(r, LimitesCodex { cinco_horas: vl(37.0, Some(en_una_hora() * 1000.0)), semana: vl(12.0, Some(en_un_dia() * 1000.0)), at: AHORA });
}

#[test]
fn se_asigna_por_duracion_no_por_posicion() {
    let r = limites_de_resultado(&con(semana(), cinco()), AHORA);
    assert_eq!(r.cinco_horas.map(|v| v.pct), Some(37.0));
    assert_eq!(r.semana.map(|v| v.pct), Some(12.0));
}

#[test]
fn solo_semanal_la_de_cinco_horas_queda_en_none_sin_ceros() {
    let r = limites_de_resultado(&con(semana(), Value::Null), AHORA);
    assert_eq!(r.cinco_horas, None);
    assert_eq!(r.semana.map(|v| v.pct), Some(12.0));
}

#[test]
fn tolera_snake_case() {
    let r = limites_de_resultado(&json!({ "rate_limits": { "primary": { "used_percent": 20, "window_duration_mins": 300, "resets_at": en_una_hora() }, "secondary": null } }), AHORA);
    assert_eq!(r.cinco_horas, vl(20.0, Some(en_una_hora() * 1000.0)));
}

#[test]
fn un_reinicio_en_ms_se_respeta_y_uno_ausente_da_none() {
    let r = limites_de_resultado(&con(con_campo(cinco(), "resetsAt", json!(AHORA + 60_000)), json!({ "usedPercent": 5, "windowDurationMins": 10080, "resetsAt": null })), AHORA);
    assert_eq!(r.cinco_horas.and_then(|v| v.reinicia_en), Some((AHORA + 60_000) as f64));
    assert_eq!(r.semana, vl(5.0, None));
}

#[test]
fn una_ventana_de_otra_duracion_se_descarta_sin_adivinar() {
    let r = limites_de_resultado(&con(json!({ "usedPercent": 50, "windowDurationMins": 60, "resetsAt": en_una_hora() }), semana()), AHORA);
    assert_eq!(r.cinco_horas, None);
    assert_eq!(r.semana.map(|v| v.pct), Some(12.0));
    let sin_duracion = limites_de_resultado(&con(json!({ "usedPercent": 50, "windowDurationMins": null }), Value::Null), AHORA);
    assert_eq!(sin_duracion, LimitesCodex { cinco_horas: None, semana: None, at: AHORA });
}

#[test]
fn la_duracion_admite_la_tolerancia_y_no_mas() {
    let dentro = limites_de_resultado(&con(json!({ "usedPercent": 1, "windowDurationMins": 303 }), Value::Null), AHORA);
    assert_eq!(dentro.cinco_horas.map(|v| v.pct), Some(1.0));
    let fuera = limites_de_resultado(&con(json!({ "usedPercent": 1, "windowDurationMins": 320 }), Value::Null), AHORA);
    assert_eq!(fuera.cinco_horas, None);
}

#[test]
fn un_porcentaje_fuera_de_0_100_o_no_numerico_descarta_la_ventana_y_los_bordes_valen() {
    let r = limites_de_resultado(&con(con_campo(cinco(), "usedPercent", json!(100)), con_campo(semana(), "usedPercent", json!(0))), AHORA);
    assert_eq!(r.cinco_horas.map(|v| v.pct), Some(100.0));
    assert_eq!(r.semana.map(|v| v.pct), Some(0.0));
    for malo in [json!(150), json!(100.5), json!(-3), json!("40"), Value::Null] {
        assert_eq!(limites_de_resultado(&con(con_campo(cinco(), "usedPercent", malo.clone()), Value::Null), AHORA).cinco_horas, None, "{malo}");
    }
    let mut sin = cinco();
    sin.as_object_mut().unwrap().remove("usedPercent");
    assert_eq!(limites_de_resultado(&con(sin, Value::Null), AHORA).cinco_horas, None);
}

#[test]
fn una_ventana_con_el_reinicio_vencido_es_none() {
    let vencido = ((AHORA - 1000) / 1000) as f64;
    let r = limites_de_resultado(&con(con_campo(cinco(), "resetsAt", json!(vencido)), semana()), AHORA);
    assert_eq!(r.cinco_horas, None);
    assert_eq!(r.semana.map(|v| v.pct), Some(12.0));
}

#[test]
fn un_reinicio_con_otra_unidad_se_descarta() {
    let c = |resets: f64| limites_de_resultado(&con(con_campo(cinco(), "resetsAt", json!(resets)), Value::Null), AHORA).cinco_horas;
    assert_eq!(c(3600.0), None);
    assert_eq!(c(1.7e15), None);
    assert_eq!(c((AHORA + 6 * 3_600_000) as f64), None);
    assert_eq!(c(((AHORA + 6 * 3_600_000) / 1000) as f64), None);
    assert_eq!(c(((AHORA as f64 + 5.4 * 3_600_000.0) / 1000.0).floor()).map(|v| v.pct), Some(37.0));
    assert_eq!(c((AHORA + 1) as f64).map(|v| v.pct), Some(37.0));
}

#[test]
fn si_rate_limits_no_sirve_prueba_el_bucket_codex() {
    let r = limites_de_resultado(&json!({ "rateLimits": { "primary": null, "secondary": null }, "rateLimitsByLimitId": { "codex": { "primary": cinco() }, "otro": { "primary": semana() } } }), AHORA);
    assert_eq!(r.cinco_horas.map(|v| v.pct), Some(37.0));
    assert_eq!(r.semana, None);
}

#[test]
fn formas_inesperadas_dan_todo_none_y_nunca_fallan() {
    let vacio = LimitesCodex { cinco_horas: None, semana: None, at: AHORA };
    for x in [Value::Null, json!([]), json!("x"), json!(5), json!({}), json!({ "rateLimits": 5 }), json!({ "rateLimits": [] }), json!({ "rateLimits": { "primary": "x", "secondary": [1] } }), json!({ "rateLimitsByLimitId": "x" })] {
        assert_eq!(limites_de_resultado(&x, AHORA), vacio, "{x}");
    }
}

#[test]
fn leer_respuesta_resultado_error_y_lo_que_no_es_una_respuesta() {
    assert_eq!(leer_respuesta(r#"{"id":2,"result":{"a":1}}"#), Some(Respuesta { id: 2.0, result: Some(json!({ "a": 1 })), error: false }));
    assert_eq!(leer_respuesta("  {\"id\":2,\"result\":null}\r"), Some(Respuesta { id: 2.0, result: Some(Value::Null), error: false }));
    assert_eq!(leer_respuesta(r#"{"id":2,"error":{"code":-32600,"message":"x"}}"#), Some(Respuesta { id: 2.0, result: None, error: true }));
    for no in ["Starting server...", "", "{roto", "[1]", r#"{"method":"account/rateLimits/updated","params":{}}"#, r#"{"id":3,"method":"item/tool/requestApproval","params":{}}"#, r#"{"id":"2","result":{}}"#, r#"{"id":2}"#] {
        assert_eq!(leer_respuesta(no), None, "{no}");
    }
}

#[test]
fn la_lectura_para_ajustes_se_serializa_como_la_espera_la_interfaz() {
    let l = LimitesCodex { cinco_horas: vl(37.0, Some(1.5e12)), semana: None, at: 7 };
    assert_eq!(serde_json::to_value(LecturaLimitesCodex::Datos { limites: l }).unwrap(), json!({ "tipo": "datos", "limites": { "cincoHoras": { "pct": 37, "reiniciaEn": 1_500_000_000_000_i64 }, "semana": null, "at": 7 } }));
    assert_eq!(serde_json::to_value(LecturaLimitesCodex::SinDato { reintenta_en_min: Some(3) }).unwrap(), json!({ "tipo": "sin-dato", "reintentaEnMin": 3 }));
    assert_eq!(serde_json::to_value(LecturaLimitesCodex::SinDato { reintenta_en_min: None }).unwrap(), json!({ "tipo": "sin-dato" }));
    assert_eq!(serde_json::to_value(LecturaLimitesCodex::EnUso).unwrap(), json!({ "tipo": "en-uso" }));
}

type Guion = dyn Fn(&Value) -> Vec<String> + Send + Sync;

struct Pedido {
    exe: String,
    args: Vec<String>,
    verbatim: bool,
    arbol: bool,
    stdin_abierto: bool,
    env: BTreeMap<String, String>,
}

/// Un app-server de mentira: contesta a cada línea que recibe según el guion y termina con `fin` si nadie lo corta.
struct ServidorFalso {
    guion: Box<Guion>,
    fin: fn() -> SalidaRun,
    antes: Box<dyn Fn(&str) + Send + Sync>,
    spawns: AtomicUsize,
    cortados: AtomicUsize,
    abiertos: AtomicUsize,
    maximo: AtomicUsize,
    pedidos: Mutex<Vec<Pedido>>,
    recibido: Mutex<Vec<String>>,
}

impl ProcesoRun for ServidorFalso {
    fn correr(&self, p: &Peticion, _: Option<&AtomicBool>, mirar: &mut dyn FnMut(&str) -> Mirada) -> SalidaRun {
        self.spawns.fetch_add(1, Ordering::SeqCst);
        let abiertos = self.abiertos.fetch_add(1, Ordering::SeqCst) + 1;
        self.maximo.fetch_max(abiertos, Ordering::SeqCst);
        self.pedidos.lock().unwrap().push(Pedido { exe: p.exe.clone(), args: p.args.clone(), verbatim: p.verbatim, arbol: p.arbol, stdin_abierto: p.stdin_abierto, env: p.env.clone() });
        (self.antes)(p.env.get("CODEX_HOME").map(String::as_str).unwrap_or_default());
        let r = self.conversar(&p.prompt, mirar);
        self.abiertos.fetch_sub(1, Ordering::SeqCst);
        r
    }
}

impl ServidorFalso {
    fn conversar(&self, prompt: &str, mirar: &mut dyn FnMut(&str) -> Mirada) -> SalidaRun {
        let mut salida: VecDeque<String> = VecDeque::new();
        let mut recibir = |texto: &str, salida: &mut VecDeque<String>| {
            for l in texto.split('\n').filter(|l| !l.is_empty()) {
                self.recibido.lock().unwrap().push(l.to_string());
                salida.extend((self.guion)(&serde_json::from_str(l).unwrap()));
            }
        };
        recibir(prompt, &mut salida);
        while let Some(l) = salida.pop_front() {
            match mirar(&l) {
                Mirada::Seguir => {}
                Mirada::Cortar => {
                    self.cortados.fetch_add(1, Ordering::SeqCst);
                    return SalidaRun::Cortada;
                }
                Mirada::Escribir(t) => recibir(&t, &mut salida),
            }
        }
        (self.fin)()
    }
}

fn resultado() -> Value {
    json!({ "rateLimits": { "primary": { "usedPercent": 37, "windowDurationMins": 300, "resetsAt": en_una_hora() }, "secondary": null } })
}

fn con_exito(r: Value) -> Box<Guion> {
    Box::new(move |m| match m["method"].as_str() {
        Some("initialize") => vec![json!({ "id": m["id"], "result": { "userAgent": "x" } }).to_string()],
        Some("account/rateLimits/read") => vec![json!({ "id": m["id"], "result": r }).to_string()],
        _ => vec![],
    })
}

fn mudo() -> Box<Guion> {
    Box::new(|_| vec![])
}

struct Armado {
    lector: Arc<LectorLimites>,
    srv: Arc<ServidorFalso>,
    ahora: Arc<AtomicI64>,
}

fn armar_con(guion: Box<Guion>, fin: fn() -> SalidaRun, antes: Box<dyn Fn(&str) + Send + Sync>, windows: bool) -> Armado {
    let srv = Arc::new(ServidorFalso {
        guion,
        fin,
        antes,
        spawns: AtomicUsize::new(0),
        cortados: AtomicUsize::new(0),
        abiertos: AtomicUsize::new(0),
        maximo: AtomicUsize::new(0),
        pedidos: Mutex::new(Vec::new()),
        recibido: Mutex::new(Vec::new()),
    });
    let ahora = Arc::new(AtomicI64::new(AHORA));
    let reloj = ahora.clone();
    let entorno = || [("PATH", "x"), ("OPENAI_API_KEY", "k"), ("CODEX_HOME", "C:\\otra"), ("SLOTH_TOKEN", "s")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    let deps = DepsLimites { proceso: srv.clone(), ahora: Box::new(move || reloj.load(Ordering::SeqCst)), entorno: Box::new(entorno), windows };
    Armado { lector: Arc::new(LectorLimites::nuevo(deps)), srv, ahora }
}

fn armar(guion: Box<Guion>) -> Armado {
    armar_con(guion, || SalidaRun::Plazo, Box::new(|_| {}), false)
}

fn cuenta(id: &str) -> Value {
    json!({ "id": id, "configDir": format!("C:\\cuentas\\{id}"), "proveedor": "codex" })
}

fn pct(r: ResultadoLectura) -> Option<f64> {
    match r {
        ResultadoLectura::Datos(l) => l.cinco_horas.map(|v| v.pct),
        _ => None,
    }
}

fn permisos(a: &Armado, inicial: &[(&str, PermisoLimites)]) -> Arc<Mutex<HashMap<String, PermisoLimites>>> {
    let m = Arc::new(Mutex::new(inicial.iter().map(|(k, v)| (k.to_string(), *v)).collect::<HashMap<_, _>>()));
    let leer = m.clone();
    a.lector.conectar_permiso(move |id| leer.lock().unwrap().get(id).copied().unwrap_or(PermisoLimites::Ok));
    m
}

#[test]
fn lee_los_limites_escribe_el_pedido_en_dos_tiempos_y_corta_el_arbol() {
    let a = armar(con_exito(resultado()));
    let r = a.lector.leer(&cuenta("c1"), "codex");
    assert_eq!(r, ResultadoLectura::Datos(LimitesCodex { cinco_horas: vl(37.0, Some(en_una_hora() * 1000.0)), semana: None, at: AHORA }));
    assert_eq!(a.srv.spawns.load(Ordering::SeqCst), 1);
    assert_eq!(a.srv.cortados.load(Ordering::SeqCst), 1);
    let pedidos = a.srv.pedidos.lock().unwrap();
    let p = &pedidos[0];
    assert_eq!((p.exe.as_str(), p.args.clone(), p.arbol, p.stdin_abierto), ("codex", vec!["app-server".to_string()], true, true));
    assert_eq!(p.env.get("CODEX_HOME").map(String::as_str), Some("C:\\cuentas\\c1"));
    assert!(!p.env.contains_key("OPENAI_API_KEY") && !p.env.contains_key("SLOTH_TOKEN"));
    assert_eq!(p.env.get("PATH").map(String::as_str), Some("x"));
    let metodos: Vec<String> = a.srv.recibido.lock().unwrap().iter().map(|l| serde_json::from_str::<Value>(l).unwrap()["method"].as_str().unwrap().to_string()).collect();
    assert_eq!(metodos, ["initialize", "initialized", "account/rateLimits/read"]);
}

#[test]
fn cache_de_5_minutos_por_cuenta() {
    let a = armar(con_exito(resultado()));
    a.lector.leer(&cuenta("c1"), "codex");
    a.ahora.fetch_add(4 * 60_000, Ordering::SeqCst);
    assert_eq!(pct(a.lector.leer(&cuenta("c1"), "codex")), Some(37.0));
    assert_eq!(a.srv.spawns.load(Ordering::SeqCst), 1);
    assert_eq!(a.lector.cacheado("c1").and_then(|l| l.cinco_horas).map(|v| v.pct), Some(37.0));
    a.ahora.fetch_add(2 * 60_000, Ordering::SeqCst);
    assert_eq!(a.lector.cacheado("c1"), None);
    a.lector.leer(&cuenta("c1"), "codex");
    assert_eq!(a.srv.spawns.load(Ordering::SeqCst), 2);
}

#[test]
fn dos_llamadas_simultaneas_son_un_solo_spawn() {
    let a = armar(con_exito(resultado()));
    let (x, y) = std::thread::scope(|t| {
        let h = t.spawn(|| a.lector.leer(&cuenta("c1"), "codex"));
        let y = a.lector.leer(&cuenta("c1"), "codex");
        (h.join().unwrap(), y)
    });
    assert_eq!(a.srv.spawns.load(Ordering::SeqCst), 1);
    assert_eq!(x, y);
}

#[test]
fn cuentas_distintas_se_leen_de_a_dos_como_maximo() {
    // Las dos primeras no terminan hasta estar las dos adentro: así el máximo llega a 2 sin depender de tiempos.
    let entraron = Arc::new(AtomicUsize::new(0));
    let e = entraron.clone();
    let antes = Box::new(move |_: &str| {
        if e.fetch_add(1, Ordering::SeqCst) < 2 {
            while e.load(Ordering::SeqCst) < 2 {
                std::thread::yield_now();
            }
        }
    });
    let a = armar_con(con_exito(resultado()), || SalidaRun::Plazo, antes, false);
    std::thread::scope(|t| {
        for id in ["c1", "c2", "c3", "c4"] {
            let l = &a.lector;
            t.spawn(move || l.leer(&cuenta(id), "codex"));
        }
    });
    assert_eq!(a.srv.spawns.load(Ordering::SeqCst), 4);
    assert_eq!(a.srv.maximo.load(Ordering::SeqCst), 2);
    assert_eq!(a.srv.cortados.load(Ordering::SeqCst), 4);
}

fn con_error_en_initialize() -> Box<Guion> {
    Box::new(|m| if m["method"] == "initialize" { vec![json!({ "id": m["id"], "error": { "code": -32600, "message": "C:\\Users\\alguien\\x" } }).to_string()] } else { vec![] })
}

#[test]
fn un_error_json_rpc_es_sin_dato_corta_el_arbol_y_no_se_reintenta_por_30_minutos() {
    let a = armar(con_error_en_initialize());
    assert_eq!(a.lector.leer(&cuenta("c1"), "codex"), ResultadoLectura::SinDato);
    assert_eq!(a.srv.cortados.load(Ordering::SeqCst), 1);
    a.ahora.fetch_add(29 * 60_000, Ordering::SeqCst);
    assert_eq!(a.lector.leer(&cuenta("c1"), "codex"), ResultadoLectura::SinDato);
    assert_eq!(a.srv.spawns.load(Ordering::SeqCst), 1);
    a.ahora.fetch_add(2 * 60_000, Ordering::SeqCst);
    assert_eq!(a.lector.leer(&cuenta("c1"), "codex"), ResultadoLectura::SinDato);
    assert_eq!(a.srv.spawns.load(Ordering::SeqCst), 2);
}

#[test]
fn si_el_metodo_devuelve_error_tras_el_handshake_tambien_es_sin_dato() {
    let a = armar(Box::new(|m| match m["method"].as_str() {
        Some("initialize") => vec![json!({ "id": m["id"], "result": {} }).to_string()],
        Some("account/rateLimits/read") => vec![json!({ "id": m["id"], "error": { "code": -32601, "message": "x" } }).to_string()],
        _ => vec![],
    }));
    assert_eq!(a.lector.leer(&cuenta("c1"), "codex"), ResultadoLectura::SinDato);
}

#[test]
fn una_respuesta_sin_ventanas_validas_es_un_resultado_vacio_no_un_numero_inventado() {
    let a = armar(con_exito(json!({ "rateLimits": { "primary": { "usedPercent": 10, "windowDurationMins": 60 } } })));
    assert_eq!(a.lector.leer(&cuenta("c1"), "codex"), ResultadoLectura::Datos(LimitesCodex { cinco_horas: None, semana: None, at: AHORA }));
}

#[test]
fn el_plazo_vencido_da_sin_dato() {
    let a = armar(mudo());
    assert_eq!(a.lector.leer(&cuenta("c1"), "codex"), ResultadoLectura::SinDato);
    assert_eq!(a.lector.reintento_en_min("c1"), Some(30));
}

#[test]
fn si_el_proceso_se_cierra_solo_o_no_se_puede_lanzar_es_sin_dato() {
    let cierra = armar_con(mudo(), || SalidaRun::Termino { code: Some(0), stdout: String::new(), stderr: String::new() }, Box::new(|_| {}), false);
    assert_eq!(cierra.lector.leer(&cuenta("c1"), "codex"), ResultadoLectura::SinDato);
    let falla = armar_con(mudo(), || SalidaRun::NoAbrio("ENOENT C:\\secreto".into()), Box::new(|_| {}), false);
    assert_eq!(falla.lector.leer(&cuenta("c1"), "codex"), ResultadoLectura::SinDato);
}

#[test]
fn mas_de_256_kb_de_salida_aborta_la_lectura() {
    let a = armar(Box::new(|_| vec!["x".repeat(300 * 1024)]));
    assert_eq!(a.lector.leer(&cuenta("c1"), "codex"), ResultadoLectura::SinDato);
    assert_eq!(a.srv.cortados.load(Ordering::SeqCst), 1);
}

#[test]
fn texto_suelto_y_notificaciones_del_servidor_se_ignoran() {
    let a = armar(Box::new(|m| match m["method"].as_str() {
        Some("initialize") => vec!["Starting...".to_string(), json!({ "method": "account/rateLimits/updated", "params": {} }).to_string(), json!({ "id": m["id"], "result": {} }).to_string()],
        Some("account/rateLimits/read") => vec![json!({ "id": m["id"], "result": resultado() }).to_string()],
        _ => vec![],
    }));
    assert_eq!(pct(a.lector.leer(&cuenta("c1"), "codex")), Some(37.0));
}

#[test]
fn un_agente_que_sloth_no_conoce_no_lanza_nada() {
    let a = armar(con_exito(resultado()));
    let mut c = cuenta("c1");
    c["proveedor"] = json!("otro");
    assert_eq!(a.lector.leer(&c, "codex"), ResultadoLectura::SinDato);
    assert_eq!(a.srv.spawns.load(Ordering::SeqCst), 0);
}

#[test]
fn en_windows_un_cmd_corre_por_cmd_exe_verbatim_con_argv_fijo_y_una_ruta_rara_no_se_lanza() {
    let ok = armar_con(con_exito(resultado()), || SalidaRun::Plazo, Box::new(|_| {}), true);
    ok.lector.leer(&cuenta("c1"), "C:\\Users\\Yo Mismo\\npm\\codex.cmd");
    let pedidos = ok.srv.pedidos.lock().unwrap();
    assert_eq!(pedidos[0].exe, "cmd.exe");
    assert_eq!(pedidos[0].args, ["/d", "/s", "/c", "\"\"C:\\Users\\Yo Mismo\\npm\\codex.cmd\" app-server\""]);
    assert!(pedidos[0].verbatim);
    let rara = armar_con(con_exito(resultado()), || SalidaRun::Plazo, Box::new(|_| {}), true);
    assert_eq!(rara.lector.leer(&cuenta("c1"), "C:\\a&b\\codex.cmd"), ResultadoLectura::SinDato);
    assert_eq!(rara.srv.spawns.load(Ordering::SeqCst), 0);
}

#[test]
fn con_una_terminal_abierta_de_la_cuenta_no_se_lanza_nada_y_no_queda_espera_de_30_minutos() {
    let a = armar(con_exito(resultado()));
    let p = permisos(&a, &[("c1", PermisoLimites::EnUso)]);
    assert_eq!(a.lector.leer(&cuenta("c1"), "codex"), ResultadoLectura::EnUso);
    assert!(a.lector.en_uso("c1"));
    assert_eq!(a.srv.spawns.load(Ordering::SeqCst), 0);
    assert_eq!(a.lector.reintento_en_min("c1"), None);
    p.lock().unwrap().insert("c1".into(), PermisoLimites::Ok);
    assert_eq!(pct(a.lector.leer(&cuenta("c1"), "codex")), Some(37.0));
    assert_eq!(a.srv.spawns.load(Ordering::SeqCst), 1);
}

#[test]
fn lo_ya_leido_se_sigue_mostrando_aunque_la_cuenta_abra_una_terminal_despues() {
    let a = armar(con_exito(resultado()));
    let p = permisos(&a, &[]);
    a.lector.leer(&cuenta("c1"), "codex");
    p.lock().unwrap().insert("c1".into(), PermisoLimites::EnUso);
    assert_eq!(pct(a.lector.leer(&cuenta("c1"), "codex")), Some(37.0));
    assert_eq!(a.srv.spawns.load(Ordering::SeqCst), 1);
}

#[test]
fn si_la_cuenta_abre_una_terminal_mientras_la_lectura_espera_su_turno_no_se_lanza() {
    let liberar = Arc::new(AtomicBool::new(false));
    let l = liberar.clone();
    let antes = Box::new(move |_: &str| {
        while !l.load(Ordering::SeqCst) {
            std::thread::yield_now();
        }
    });
    let a = armar_con(mudo(), || SalidaRun::Termino { code: Some(0), stdout: String::new(), stderr: String::new() }, antes, false);
    let preguntas_c3 = Arc::new(AtomicUsize::new(0));
    let mapa: Arc<Mutex<HashMap<String, PermisoLimites>>> = Arc::new(Mutex::new(HashMap::new()));
    let (m, q) = (mapa.clone(), preguntas_c3.clone());
    a.lector.conectar_permiso(move |id| {
        if id == "c3" {
            q.fetch_add(1, Ordering::SeqCst);
        }
        m.lock().unwrap().get(id).copied().unwrap_or(PermisoLimites::Ok)
    });
    let esperar = |cond: &dyn Fn() -> bool| {
        while !cond() {
            std::thread::yield_now();
        }
    };
    std::thread::scope(|t| {
        let lector = &a.lector;
        let h1 = t.spawn(move || lector.leer(&cuenta("c1"), "codex"));
        let h2 = t.spawn(move || lector.leer(&cuenta("c2"), "codex"));
        esperar(&|| a.srv.spawns.load(Ordering::SeqCst) == 2);
        let h3 = t.spawn(move || lector.leer(&cuenta("c3"), "codex"));
        esperar(&|| preguntas_c3.load(Ordering::SeqCst) >= 1);
        mapa.lock().unwrap().insert("c3".into(), PermisoLimites::EnUso);
        liberar.store(true, Ordering::SeqCst);
        h1.join().unwrap();
        h2.join().unwrap();
        assert_eq!(h3.join().unwrap(), ResultadoLectura::EnUso);
    });
    assert_eq!(a.srv.spawns.load(Ordering::SeqCst), 2);
}

#[test]
fn con_el_switch_apagado_no_se_lee_ni_se_castiga_la_cuenta() {
    let a = armar(con_exito(resultado()));
    permisos(&a, &[("c1", PermisoLimites::Apagada)]);
    assert_eq!(a.lector.leer(&cuenta("c1"), "codex"), ResultadoLectura::SinDato);
    assert_eq!(a.srv.spawns.load(Ordering::SeqCst), 0);
    assert_eq!(a.lector.reintento_en_min("c1"), None);
}

#[test]
fn olvidar_saca_la_espera_de_un_fallo_y_la_cache() {
    let falla = Arc::new(AtomicBool::new(true));
    let f = falla.clone();
    let a = armar(Box::new(move |m| match m["method"].as_str() {
        Some("initialize") if f.load(Ordering::SeqCst) => vec![json!({ "id": m["id"], "error": { "code": -1, "message": "x" } }).to_string()],
        Some("initialize") => vec![json!({ "id": m["id"], "result": {} }).to_string()],
        Some("account/rateLimits/read") => vec![json!({ "id": m["id"], "result": resultado() }).to_string()],
        _ => vec![],
    }));
    assert_eq!(a.lector.leer(&cuenta("c1"), "codex"), ResultadoLectura::SinDato);
    assert_eq!(a.lector.reintento_en_min("c1"), Some(30));
    a.ahora.fetch_add(60_000, Ordering::SeqCst);
    assert_eq!(a.lector.reintento_en_min("c1"), Some(29));
    assert_eq!(a.lector.leer(&cuenta("c1"), "codex"), ResultadoLectura::SinDato);
    assert_eq!(a.srv.spawns.load(Ordering::SeqCst), 1);
    falla.store(false, Ordering::SeqCst);
    a.lector.olvidar("c1");
    assert_eq!(a.lector.reintento_en_min("c1"), None);
    assert_eq!(pct(a.lector.leer(&cuenta("c1"), "codex")), Some(37.0));
    assert_eq!(a.srv.spawns.load(Ordering::SeqCst), 2);
}

fn carpeta_tmp(nombre: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("sloth-limites-{nombre}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn cuenta_en(dir: &Path, activada: bool) -> Value {
    json!({ "id": "c1", "configDir": dir.to_string_lossy(), "proveedor": "codex", "limitesExperimentales": activada })
}

#[test]
fn limites_de_cuenta_solo_con_el_switch_la_capacidad_y_la_sesion() {
    let a = armar(con_exito(resultado()));
    let exe = |_: ProveedorId| Some("codex".to_string());
    let sin = LecturaLimitesCodex::SinDato { reintenta_en_min: None };
    assert_eq!(limites_de_cuenta(&a.lector, None, true, &exe), sin);
    let dir = carpeta_tmp("sesion");
    assert_eq!(limites_de_cuenta(&a.lector, Some(&cuenta_en(&dir, false)), true, &exe), sin);
    let claude = json!({ "id": "c1", "configDir": dir.to_string_lossy(), "limitesExperimentales": true });
    assert_eq!(limites_de_cuenta(&a.lector, Some(&claude), true, &exe), sin);
    assert_eq!(limites_de_cuenta(&a.lector, Some(&cuenta_en(&dir, true)), true, &exe), sin);
    assert_eq!(a.srv.spawns.load(Ordering::SeqCst), 0);
    std::fs::write(dir.join("auth.json"), "{}").unwrap();
    assert_eq!(limites_de_cuenta(&a.lector, Some(&cuenta_en(&dir, true)), true, &|_| None), sin);
    let LecturaLimitesCodex::Datos { limites } = limites_de_cuenta(&a.lector, Some(&cuenta_en(&dir, true)), true, &exe) else { panic!() };
    assert_eq!(limites.cinco_horas.map(|v| v.pct), Some(37.0));
    assert!(matches!(limites_de_cuenta(&a.lector, Some(&cuenta_en(&dir, true)), false, &exe), LecturaLimitesCodex::Datos { .. }));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn limites_de_cuenta_sin_sesion_olvida_la_espera_y_con_fallo_dice_cuando_reintenta() {
    let a = armar(con_error_en_initialize());
    let exe = |_: ProveedorId| Some("codex".to_string());
    let dir = carpeta_tmp("olvido");
    std::fs::write(dir.join("auth.json"), "{}").unwrap();
    assert_eq!(limites_de_cuenta(&a.lector, Some(&cuenta_en(&dir, true)), true, &exe), LecturaLimitesCodex::SinDato { reintenta_en_min: Some(30) });
    std::fs::remove_file(dir.join("auth.json")).unwrap();
    limites_de_cuenta(&a.lector, Some(&cuenta_en(&dir, true)), true, &exe);
    assert_eq!(a.lector.reintento_en_min("c1"), None);
    let _ = std::fs::remove_dir_all(&dir);
}
