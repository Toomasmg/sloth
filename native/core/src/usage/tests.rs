use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime};

const HORA: i64 = 60 * 60 * 1000;
// 2026-11-17T15:00:00Z: a las 12:00 en Buenos Aires, así la medianoche local cae 12 h atrás.
const AHORA: i64 = 1_794_927_600_000;
const BA: i32 = -180;

struct Temporal(PathBuf);

impl Temporal {
    fn nuevo() -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!("sloth-uso-rs-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        Temporal(d)
    }

    fn escribir(&self, rel: &str, contenido: &str) -> PathBuf {
        let f = self.0.join(rel);
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(&f, contenido).unwrap();
        f
    }
}

impl Drop for Temporal {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn iso(ts: i64) -> String {
    let dias = ts.div_euclid(DIA_MS);
    let resto = ts.rem_euclid(DIA_MS);
    let z = dias + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", resto / HORA, resto / 60_000 % 60, resto / 1000 % 60, resto % 1000)
}

fn linea(ts: i64, id: &str, input: u32, output: u32, cw: u32, cr: u32) -> String {
    json!({
        "type": "assistant",
        "timestamp": iso(ts),
        "message": { "id": id, "usage": { "input_tokens": input, "output_tokens": output, "cache_creation_input_tokens": cw, "cache_read_input_tokens": cr } }
    })
    .to_string()
}

fn cuenta(t: &Temporal, id: &str) -> CuentaUso {
    CuentaUso { id: id.into(), config_dir: t.0.join(id), carpeta_historial: Some("projects") }
}

fn entrada(ts: i64, input: f64) -> Entrada {
    Entrada { id: ts.to_string(), ts, input, output: 0.0, cache_write: 0.0, cache_read: 0.0 }
}

#[test]
fn iso_de_prueba_y_parseo_son_inversos() {
    assert_eq!(iso(AHORA), "2026-11-17T15:00:00.000Z");
    assert_eq!(parsear_iso_ms("2026-11-17T15:00:00.000Z"), Some(AHORA));
    assert_eq!(parsear_iso_ms("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(parsear_iso_ms("2024-02-29T23:59:59.999Z"), Some(1_709_251_199_999));
}

#[test]
fn parsear_iso_acepta_las_variantes_de_date_parse() {
    assert_eq!(parsear_iso_ms("2026-11-17"), Some(AHORA - 15 * HORA));
    assert_eq!(parsear_iso_ms("2026-11-17T15:00Z"), Some(AHORA));
    assert_eq!(parsear_iso_ms("2026-11-17T15:00:00.5Z"), Some(AHORA + 500));
    assert_eq!(parsear_iso_ms("2026-11-17T15:00:00.123456Z"), Some(AHORA + 123));
    assert_eq!(parsear_iso_ms("2026-11-17T12:00:00-03:00"), Some(AHORA));
    assert_eq!(parsear_iso_ms("2026-11-17T17:30:00+02:30"), Some(AHORA));
    assert_eq!(parsear_iso_ms("2026-11-17T15:00:00"), Some(AHORA));
}

#[test]
fn parsear_iso_rechaza_lo_que_no_es_fecha() {
    for malo in ["", "hola", "2026-13-01T00:00:00Z", "2026-11-32", "2026-11-17T25:00:00Z", "2026-11-17T15:00:00X", "2026-11-17T15:00:00Zextra", "2026-11-17 15:00:00Z", "2026-11-17T15:00:00.Z"] {
        assert_eq!(parsear_iso_ms(malo), None, "{malo}");
    }
}

#[test]
fn parse_line_lee_una_linea_de_asistente() {
    let e = parse_line(&linea(AHORA, "msg_1", 10, 20, 30, 40)).unwrap();
    assert_eq!(e, Entrada { id: "msg_1".into(), ts: AHORA, input: 10.0, output: 20.0, cache_write: 30.0, cache_read: 40.0 });
}

#[test]
fn parse_line_ignora_lo_que_no_tiene_usage_o_no_es_del_asistente() {
    assert_eq!(parse_line(""), None);
    assert_eq!(parse_line("{roto \"usage\""), None);
    assert_eq!(parse_line(r#"{"type":"assistant","timestamp":"2026-11-17T15:00:00Z","message":{"id":"a"}}"#), None);
    assert_eq!(parse_line(r#"{"type":"user","timestamp":"2026-11-17T15:00:00Z","message":{"usage":{"input_tokens":1}}}"#), None);
    assert_eq!(parse_line(r#"{"type":"assistant","message":{"usage":{"input_tokens":1}}}"#), None);
    assert_eq!(parse_line(r#"{"type":"assistant","timestamp":"","message":{"usage":{"input_tokens":1}}}"#), None);
    assert_eq!(parse_line(r#"{"type":"assistant","timestamp":"no es fecha","message":{"usage":{"input_tokens":1}}}"#), None);
    assert_eq!(parse_line(r#"{"type":"assistant","timestamp":"2026-11-17T15:00:00Z","message":{"usage":null}}"#), None);
}

#[test]
fn parse_line_cuenta_cero_lo_que_falta_o_no_es_numero() {
    let e = parse_line(r#"{"type":"assistant","timestamp":"2026-11-17T15:00:00Z","message":{"id":"a","usage":{"input_tokens":7,"output_tokens":null,"cache_read_input_tokens":"x"}}}"#).unwrap();
    assert_eq!((e.input, e.output, e.cache_write, e.cache_read), (7.0, 0.0, 0.0, 0.0));
}

#[test]
fn parse_line_elige_el_id_message_id_luego_request_id_y_al_final_el_timestamp() {
    let base = |extra_msg: &str, extra: &str| {
        format!(r#"{{"type":"assistant","timestamp":"2026-11-17T15:00:00.000Z"{extra},"message":{{{extra_msg}"usage":{{"input_tokens":1}}}}}}"#)
    };
    assert_eq!(parse_line(&base(r#""id":"m","#, r#","requestId":"r""#)).unwrap().id, "m");
    assert_eq!(parse_line(&base("", r#","requestId":"r""#)).unwrap().id, "r");
    assert_eq!(parse_line(&base("", "")).unwrap().id, AHORA.to_string());
}

#[test]
fn parse_line_tolera_el_retorno_de_carro_de_windows() {
    assert!(parse_line(&format!("{}\r", linea(AHORA, "a", 1, 1, 1, 1))).is_some());
}

#[test]
fn medianoche_local_respeta_el_desfase_de_la_zona() {
    assert_eq!(medianoche_local(AHORA, BA), AHORA - 12 * HORA);
    assert_eq!(medianoche_local(AHORA, 0), AHORA - 15 * HORA);
    assert_eq!(medianoche_local(AHORA, 120), AHORA - 17 * HORA);
    assert_eq!(medianoche_local(AHORA - 14 * HORA, BA), AHORA - 12 * HORA - DIA_MS);
    assert_eq!(medianoche_local(AHORA - 15 * HORA, 0), AHORA - 15 * HORA);
}

#[test]
fn acumular_reparte_entre_cinco_horas_hoy_y_siete_dias() {
    let medianoche = AHORA - 12 * HORA;
    let entradas = [
        entrada(AHORA - 8 * DIA_MS, 1000.0),
        entrada(AHORA - 6 * DIA_MS, 1.0),
        entrada(medianoche - HORA, 2.0),
        entrada(medianoche + HORA, 4.0),
        entrada(AHORA - 6 * HORA, 8.0),
        entrada(AHORA - 4 * HORA, 16.0),
        entrada(AHORA - HORA, 32.0),
    ];
    let u = acumular(&entradas, AHORA, BA);
    assert_eq!((u.last7d.input, u.last7d.messages), (1.0 + 2.0 + 4.0 + 8.0 + 16.0 + 32.0, 6));
    assert_eq!((u.today.input, u.today.messages), (4.0 + 8.0 + 16.0 + 32.0, 4));
    assert_eq!((u.last5h.input, u.last5h.messages), (16.0 + 32.0, 2));
    assert_eq!(u.window_start, Some(AHORA - 4 * HORA));
    assert_eq!(u.scanned_at, AHORA);
}

#[test]
fn acumular_usa_la_zona_para_hoy() {
    let entradas = [entrada(AHORA - 13 * HORA, 5.0)];
    assert_eq!(acumular(&entradas, AHORA, BA).today.messages, 0);
    assert_eq!(acumular(&entradas, AHORA, 0).today.messages, 1);
}

#[test]
fn acumular_sin_entradas_deja_todo_en_cero_y_sin_ventana() {
    let u = acumular(&[], AHORA, BA);
    assert_eq!((u.last5h, u.today, u.last7d), (Totales::default(), Totales::default(), Totales::default()));
    assert_eq!((u.window_start, u.ventana), (None, None));
}

#[test]
fn acumular_arma_la_ventana_de_cupo_con_entrada_salida_y_cache_escrita() {
    let e = Entrada { id: "a".into(), ts: AHORA - 2 * HORA, input: 10.0, output: 20.0, cache_write: 30.0, cache_read: 1000.0 };
    let v = acumular(&[e], AHORA, BA).ventana.unwrap();
    assert_eq!(v.tokens, 60.0);
    assert_eq!(v.inicio, (AHORA - 2 * HORA) as f64);
    assert_eq!(v.fin, (AHORA + 3 * HORA) as f64);
}

#[test]
fn buscar_jsonl_baja_hasta_profundidad_4_y_solo_toma_jsonl() {
    let t = Temporal::nuevo();
    t.escribir("a.jsonl", "");
    t.escribir("a.txt", "");
    t.escribir("d1/b.jsonl", "");
    t.escribir("d1/d2/d3/d4/ok.jsonl", "");
    t.escribir("d1/d2/d3/d4/d5/muy-hondo.jsonl", "");
    fs::create_dir_all(t.0.join("carpeta.jsonl")).unwrap();
    let rel: Vec<String> = buscar_jsonl(&t.0).iter().map(|p| p.strip_prefix(&t.0).unwrap().to_string_lossy().replace('\\', "/")).collect();
    assert_eq!(rel, ["a.jsonl", "d1/b.jsonl", "d1/d2/d3/d4/ok.jsonl"]);
    assert!(buscar_jsonl(&t.0.join("no-existe")).is_empty());
}

#[test]
fn escanear_suma_los_archivos_de_la_cuenta_y_cuenta_una_vez_un_mensaje_repetido() {
    let t = Temporal::nuevo();
    let c = cuenta(&t, "a");
    let ahora = AHORA;
    t.escribir(
        "a/projects/p1/s.jsonl",
        &format!("{}\n{}\n{}\n", linea(ahora - HORA, "m1", 10, 1, 0, 0), linea(ahora - HORA, "m1", 10, 1, 0, 0), linea(ahora - 2 * HORA, "m2", 5, 2, 3, 100)),
    );
    t.escribir("a/projects/p2/otro.jsonl", &format!("{}\n", linea(ahora - 30 * 60_000, "m3", 1, 1, 1, 1)));
    t.escribir("a/otra-carpeta/ignorado.jsonl", &format!("{}\n", linea(ahora - HORA, "m9", 999, 0, 0, 0)));
    let mut esc = EscanerUso::nuevo();
    let r = esc.escanear(&[c], ahora, BA);
    let u = &r["a"];
    assert_eq!(u.last5h.messages, 3);
    assert_eq!((u.last5h.input, u.last5h.output, u.last5h.cache_write, u.last5h.cache_read), (16.0, 4.0, 4.0, 101.0));
    assert_eq!(u.window_start, Some(ahora - 2 * HORA));
}

#[test]
fn escanear_no_toca_una_cuenta_sin_capacidad_de_uso() {
    let t = Temporal::nuevo();
    t.escribir("a/projects/s.jsonl", &format!("{}\n", linea(AHORA - HORA, "m1", 10, 1, 0, 0)));
    let c = CuentaUso { id: "a".into(), config_dir: t.0.join("a"), carpeta_historial: None };
    let mut esc = EscanerUso::nuevo();
    let u = &esc.escanear(&[c], AHORA, BA)["a"];
    assert_eq!(u.last7d.messages, 0);
    assert_eq!(u.ventana, None);
}

#[test]
fn cuenta_uso_toma_la_carpeta_del_proveedor_solo_si_tiene_uso() {
    let c = CuentaUso::desde_cuenta(&json!({ "id": "a", "configDir": "C:/x" })).unwrap();
    assert_eq!((c.id.as_str(), c.carpeta_historial), ("a", Some("projects")));
    assert_eq!(CuentaUso::desde_cuenta(&json!({ "id": "a", "configDir": "C:/x", "proveedor": "codex" })).unwrap().carpeta_historial, None);
    assert_eq!(CuentaUso::desde_cuenta(&json!({ "id": "a", "configDir": "C:/x", "proveedor": "copilot" })).unwrap().carpeta_historial, None);
    assert_eq!(CuentaUso::desde_cuenta(&json!({ "id": "a", "configDir": "C:/x", "proveedor": "futuro" })).unwrap().carpeta_historial, None);
    assert!(CuentaUso::desde_cuenta(&json!({ "id": "a" })).is_none());
}

#[test]
fn lectura_incremental_sigue_desde_el_offset_y_no_cuenta_dos_veces() {
    let t = Temporal::nuevo();
    let c = cuenta(&t, "a");
    let f = t.escribir("a/projects/s.jsonl", &format!("{}\n", linea(AHORA - 2 * HORA, "m1", 1, 0, 0, 0)));
    let mut esc = EscanerUso::nuevo();
    esc.escanear_ya(std::slice::from_ref(&c), AHORA, BA);
    assert_eq!(esc.ultimo()["a"].last5h.messages, 1);
    assert_eq!(esc.cache[&f].offset, fs::metadata(&f).unwrap().len());

    let mut abierto = fs::OpenOptions::new().append(true).open(&f).unwrap();
    writeln!(abierto, "{}", linea(AHORA - HORA, "m2", 2, 0, 0, 0)).unwrap();
    drop(abierto);
    esc.escanear_ya(std::slice::from_ref(&c), AHORA, BA);
    assert_eq!((esc.ultimo()["a"].last5h.messages, esc.ultimo()["a"].last5h.input), (2, 3.0));
    esc.escanear_ya(std::slice::from_ref(&c), AHORA, BA);
    assert_eq!(esc.ultimo()["a"].last5h.messages, 2);
}

use std::io::Write;

#[test]
fn una_linea_sin_salto_de_linea_se_relee_cuando_se_completa() {
    let t = Temporal::nuevo();
    let c = cuenta(&t, "a");
    let completa = linea(AHORA - HORA, "m2", 2, 0, 0, 0);
    let (mitad_a, mitad_b) = completa.split_at(completa.len() / 2);
    let f = t.escribir("a/projects/s.jsonl", &format!("{}\n{mitad_a}", linea(AHORA - 2 * HORA, "m1", 1, 0, 0, 0)));
    let mut esc = EscanerUso::nuevo();
    esc.escanear_ya(std::slice::from_ref(&c), AHORA, BA);
    assert_eq!(esc.ultimo()["a"].last5h.messages, 1);
    let largo_completo = linea(AHORA - 2 * HORA, "m1", 1, 0, 0, 0).len() as u64 + 1;
    assert_eq!(esc.cache[&f].offset, largo_completo);

    let mut abierto = fs::OpenOptions::new().append(true).open(&f).unwrap();
    write!(abierto, "{mitad_b}\n").unwrap();
    drop(abierto);
    esc.escanear_ya(std::slice::from_ref(&c), AHORA, BA);
    assert_eq!(esc.ultimo()["a"].last5h.messages, 2);
}

#[test]
fn si_el_archivo_se_reescribe_mas_chico_se_lee_de_cero() {
    let t = Temporal::nuevo();
    let c = cuenta(&t, "a");
    let f = t.escribir("a/projects/s.jsonl", &format!("{}\n{}\n", linea(AHORA - 3 * HORA, "m1", 100, 0, 0, 0), linea(AHORA - 2 * HORA, "m2", 100, 0, 0, 0)));
    let mut esc = EscanerUso::nuevo();
    esc.escanear_ya(std::slice::from_ref(&c), AHORA, BA);
    assert_eq!(esc.ultimo()["a"].last5h.input, 200.0);
    fs::write(&f, format!("{}\n", linea(AHORA - HORA, "m3", 7, 0, 0, 0))).unwrap();
    esc.escanear_ya(std::slice::from_ref(&c), AHORA, BA);
    let u = &esc.ultimo()["a"];
    assert_eq!((u.last5h.messages, u.last5h.input), (1, 7.0));
}

#[test]
fn un_archivo_que_desaparece_sale_del_total() {
    let t = Temporal::nuevo();
    let c = cuenta(&t, "a");
    let f = t.escribir("a/projects/s.jsonl", &format!("{}\n", linea(AHORA - HORA, "m1", 1, 0, 0, 0)));
    let mut esc = EscanerUso::nuevo();
    esc.escanear_ya(std::slice::from_ref(&c), AHORA, BA);
    fs::remove_file(&f).unwrap();
    esc.escanear_ya(std::slice::from_ref(&c), AHORA, BA);
    assert_eq!(esc.ultimo()["a"].last7d.messages, 0);
}

#[test]
fn descarta_las_entradas_de_mas_de_siete_dias_del_cache() {
    let t = Temporal::nuevo();
    let c = cuenta(&t, "a");
    let f = t.escribir("a/projects/s.jsonl", &format!("{}\n{}\n", linea(AHORA - 9 * DIA_MS, "viejo", 100, 0, 0, 0), linea(AHORA - HORA, "nuevo", 1, 0, 0, 0)));
    let mut esc = EscanerUso::nuevo();
    esc.escanear_ya(std::slice::from_ref(&c), AHORA, BA);
    assert_eq!(esc.ultimo()["a"].last7d.messages, 1);
    assert_eq!(esc.cache[&f].entradas.keys().collect::<Vec<_>>(), ["nuevo"]);
}

#[test]
fn un_archivo_sin_tocar_desde_antes_de_la_ventana_no_se_lee() {
    let t = Temporal::nuevo();
    let c = cuenta(&t, "a");
    let f = t.escribir("a/projects/s.jsonl", &format!("{}\n", linea(AHORA - HORA, "m1", 1, 0, 0, 0)));
    let viejo = SystemTime::now() - Duration::from_secs(30 * 24 * 3600);
    fs::File::options().write(true).open(&f).unwrap().set_modified(viejo).unwrap();
    let mut esc = EscanerUso::nuevo();
    esc.escanear_ya(std::slice::from_ref(&c), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64, 0);
    assert_eq!(esc.ultimo()["a"].last7d.messages, 0);
    assert!(!esc.cache.contains_key(&f));
}

#[test]
fn lee_por_bloques_un_archivo_mas_grande_que_el_bloque_y_con_utf8_multibyte() {
    let t = Temporal::nuevo();
    let c = cuenta(&t, "a");
    let mut contenido = String::new();
    let n = 2000;
    for i in 0..n {
        let mut l = linea(AHORA - HORA, &format!("m{i}"), 1, 0, 0, 0);
        l.pop();
        contenido.push_str(&format!("{l},\"relleno\":\"{}ñ€😀\"}}\n", "x".repeat(1000)));
    }
    assert!(contenido.len() > 2 * BLOQUE_LECTURA);
    t.escribir("a/projects/grande.jsonl", &contenido);
    let mut esc = EscanerUso::nuevo();
    esc.escanear_ya(std::slice::from_ref(&c), AHORA, BA);
    let u = &esc.ultimo()["a"];
    assert_eq!((u.last5h.messages, u.last5h.input), (n as u64, n as f64));
}

#[test]
fn una_sola_linea_mas_larga_que_un_bloque_se_arma_sin_perder_nada() {
    let t = Temporal::nuevo();
    let c = cuenta(&t, "a");
    let mut l = linea(AHORA - HORA, "gigante", 3, 0, 0, 0);
    l.pop();
    t.escribir("a/projects/g.jsonl", &format!("{l},\"relleno\":\"{}\"}}\n", "y".repeat(BLOQUE_LECTURA + 5000)));
    let mut esc = EscanerUso::nuevo();
    esc.escanear_ya(std::slice::from_ref(&c), AHORA, BA);
    assert_eq!(esc.ultimo()["a"].last5h.input, 3.0);
}

#[test]
fn escanear_reusa_el_resultado_fresco_y_reescanea_si_vence_o_cambian_las_cuentas() {
    let t = Temporal::nuevo();
    let a = cuenta(&t, "a");
    let b = cuenta(&t, "b");
    let f = t.escribir("a/projects/s.jsonl", &format!("{}\n", linea(AHORA - HORA, "m1", 1, 0, 0, 0)));
    let mut esc = EscanerUso::nuevo();
    assert_eq!(esc.escanear(std::slice::from_ref(&a), AHORA, BA)["a"].last5h.messages, 1);
    let mut abierto = fs::OpenOptions::new().append(true).open(&f).unwrap();
    writeln!(abierto, "{}", linea(AHORA - HORA, "m2", 1, 0, 0, 0)).unwrap();
    drop(abierto);
    assert_eq!(esc.escanear(std::slice::from_ref(&a), AHORA + 19_000, BA)["a"].last5h.messages, 1);
    assert_eq!(esc.escanear(std::slice::from_ref(&a), AHORA + 21_000, BA)["a"].last5h.messages, 2);
    let r = esc.escanear(&[a, b], AHORA + 22_000, BA);
    assert_eq!(r.len(), 2);
    assert_eq!(r["b"].last7d.messages, 0);
}

#[test]
fn el_uso_se_serializa_como_el_account_usage_de_la_interfaz() {
    let e = Entrada { id: "m".into(), ts: AHORA - HORA, input: 10.0, output: 5.0, cache_write: 2.0, cache_read: 1.5 };
    let u = acumular([&e], AHORA, BA);
    let j = serde_json::to_value(&u).unwrap();
    let totales = json!({ "input": 10, "output": 5, "cacheWrite": 2, "cacheRead": 1.5, "messages": 1 });
    assert_eq!(j["last5h"], totales);
    assert_eq!(j["today"], totales);
    assert_eq!(j["scannedAt"], AHORA);
    assert_eq!(j["windowStart"], AHORA - HORA);
    assert_eq!(j["ventana"]["inicio"], AHORA - HORA);
    let vacio = serde_json::to_value(acumular([], AHORA, BA)).unwrap();
    assert!(vacio.get("windowStart").is_none() && vacio.get("ventana").is_none());
}

#[test]
fn cuentas_de_uso_saltea_las_que_no_tienen_id_o_carpeta() {
    let c = cuentas_de_uso(&[json!({ "id": "a", "configDir": "X" }), json!({ "id": "b" }), json!({ "configDir": "Y" })]);
    assert_eq!(c.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["a"]);
}
