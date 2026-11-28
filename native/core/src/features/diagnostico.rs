//! Diagnóstico para pegar en un reporte. Equivale a src/main/diag/{diagnostico-texto,limite,error-renderer,estado}.ts y
//! a las partes puras de features/diagnostico.ts. El logger, las versiones y el SO los aporta quien llama.
use super::redactar::acotar;
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};

/// Cada entrada puede venir con un stack de 4000: acotada acá el texto que se copia no pasa de unos pocos KB.
const MAX_ENTRADA: usize = 600;
pub const MAX_ENTRADAS: usize = 30;
const MAX_CRUDO: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Nivel {
    Error,
    Aviso,
    Info,
}

#[derive(Debug, Clone)]
pub struct EntradaLog {
    pub t: f64,
    pub nivel: Nivel,
    pub origen: String,
    pub msg: String,
}

#[derive(Debug, Clone, Default)]
pub struct DatosDiagnostico {
    pub sloth: String,
    pub electron: String,
    pub node: String,
    pub chrome: String,
    pub so: String,
    pub features: Vec<String>,
    pub cuentas: usize,
    pub espacios: usize,
    pub ajustes: Vec<(String, bool)>,
    pub errores: Vec<EntradaLog>,
    pub avisos: Vec<String>,
    pub crash_previo: bool,
    pub fallos_log: Option<String>,
}

fn iso(t: f64) -> String {
    if !t.is_finite() || t.abs() > 8.64e15 {
        return "fecha desconocida".into();
    }
    let ms = t.trunc() as i64;
    let (y, m, d) = super::civil_de_dias(ms.div_euclid(86_400_000));
    let r = ms.rem_euclid(86_400_000);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", r / 3_600_000, r / 60_000 % 60, r / 1000 % 60, r % 1000)
}

fn ultimos<T>(v: &[T], n: usize) -> &[T] {
    &v[v.len().saturating_sub(n)..]
}

pub fn texto_diagnostico(d: &DatosDiagnostico, ahora: f64) -> String {
    let errores = ultimos(&d.errores, MAX_ENTRADAS);
    let avisos = ultimos(&d.avisos, MAX_ENTRADAS);
    let ajustes: Vec<String> = d.ajustes.iter().map(|(k, v)| format!("  {k}: {}", if *v { "sí" } else { "no" })).collect();
    let mut l: Vec<String> = vec![
        "Diagnóstico de Sloth".into(),
        iso(ahora),
        String::new(),
        format!("Sloth {} · Electron {} · Node {} · Chrome {}", d.sloth, d.electron, d.node, d.chrome),
        format!("Sistema: {}", d.so),
        String::new(),
        format!("Funciones activas: {}", if d.features.is_empty() { "(ninguna)".to_string() } else { d.features.join(", ") }),
        format!("Cuentas: {} · Espacios: {}", d.cuentas, d.espacios),
        String::new(),
        "Ajustes:".into(),
    ];
    if ajustes.is_empty() {
        l.push("  (sin datos)".into());
    } else {
        l.extend(ajustes);
    }
    l.push(String::new());
    l.push(format!("Últimos errores y avisos ({})", errores.len() + avisos.len()));
    if errores.is_empty() {
        l.push("(sin errores)".into());
    } else {
        l.extend(errores.iter().map(|e| format!("[{}] {}: {}", iso(e.t), e.origen, acotar(&e.msg, MAX_ENTRADA))));
    }
    if avisos.is_empty() {
        l.push("(sin avisos)".into());
    } else {
        l.extend(avisos.iter().map(|a| format!("[aviso] {a}")));
    }
    if d.crash_previo {
        l.extend([String::new(), "La sesión anterior terminó de forma inesperada.".into()]);
    }
    if let Some(f) = d.fallos_log.as_deref().filter(|f| !f.is_empty()) {
        l.extend([String::new(), format!("No se pudo escribir el archivo de log: {f}")]);
    }
    l.extend([String::new(), "Este texto no se envió a ningún lado: se copió a tu portapapeles. Revisalo antes de compartirlo.".into()]);
    l.join("\n")
}

/// Los ajustes booleanos para el diagnóstico: los de primer nivel y los de `notify` y `terminal` con prefijo.
pub fn ajustes_booleanos(settings: &Value) -> Vec<(String, bool)> {
    fn recorrer(obj: &serde_json::Map<String, Value>, prefijo: &str, nivel: u8, salida: &mut Vec<(String, bool)>) {
        for (k, v) in obj {
            match v {
                Value::Bool(b) => {
                    let clave = format!("{prefijo}{k}");
                    match salida.iter_mut().find(|(x, _)| *x == clave) {
                        Some(e) => e.1 = *b,
                        None => salida.push((clave, *b)),
                    }
                }
                Value::Object(o) if nivel < 1 && (k == "notify" || k == "terminal") => recorrer(o, &format!("{k}."), nivel + 1, salida),
                _ => {}
            }
        }
    }
    let mut salida = Vec::new();
    if let Some(o) = settings.as_object() {
        recorrer(o, "", 0, &mut salida);
    }
    salida
}

/// Deja pasar hasta `max` en la ventana; los rechazados no cuentan.
pub struct Limite {
    max: usize,
    ventana_ms: f64,
    marcas: VecDeque<f64>,
}

impl Limite {
    pub fn nuevo(max: usize, ventana_ms: f64) -> Self {
        Limite { max, ventana_ms, marcas: VecDeque::new() }
    }

    pub fn pasa(&mut self, ahora: f64) -> bool {
        while self.marcas.front().is_some_and(|m| ahora - m >= self.ventana_ms) {
            self.marcas.pop_front();
        }
        if self.marcas.len() >= self.max {
            return false;
        }
        self.marcas.push_back(ahora);
        true
    }
}

fn cortar(s: &str, n: usize) -> String {
    let mut u = 0;
    s.chars()
        .take_while(|c| {
            u += c.len_utf16();
            u <= n
        })
        .collect()
}

/// Lo que manda la UI desde window.onerror / unhandledrejection; llega por IPC sin validar. El corte fino lo hace el
/// logger después de redactar, así un secreto no queda partido por la mitad.
pub fn leer_error_renderer(payload: &Value) -> Option<String> {
    let o = payload.as_object()?;
    let mensaje = o.get("mensaje")?.as_str().filter(|m| !m.is_empty())?;
    let cabeza = cortar(mensaje, MAX_CRUDO);
    Some(match o.get("stack").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        Some(stack) => format!("{cabeza}\n{}", cortar(stack, MAX_CRUDO)),
        None => cabeza,
    })
}

/// True solo la primera vez que se pregunta: el aviso al arrancar se muestra una vez por sesión.
#[derive(Default)]
pub struct EstadoCrash {
    crash_previo: AtomicBool,
    preguntado: AtomicBool,
}

impl EstadoCrash {
    pub fn marcar(&self, v: bool) {
        self.crash_previo.store(v, Ordering::SeqCst);
    }

    pub fn tomar(&self) -> bool {
        if self.preguntado.swap(true, Ordering::SeqCst) {
            return false;
        }
        self.crash_previo.load(Ordering::SeqCst)
    }

    pub fn hubo(&self) -> bool {
        self.crash_previo.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const AHORA: f64 = 1_794_916_800_000.0;

    fn base() -> DatosDiagnostico {
        DatosDiagnostico {
            sloth: "0.6.28".into(),
            electron: "33.0.0".into(),
            node: "20.18.0".into(),
            chrome: "130.0.0".into(),
            so: "win32 10.0.26300 x64".into(),
            features: vec!["git".into(), "chat".into(), "celular".into()],
            cuentas: 2,
            espacios: 5,
            ajustes: vec![("sounds".into(), true), ("lightMode".into(), false)],
            ..Default::default()
        }
    }

    fn entrada(i: usize) -> EntradaLog {
        EntradaLog { t: AHORA - (100.0 - i as f64) * 1000.0, nivel: Nivel::Error, origen: "main".into(), msg: format!("falla {i}") }
    }

    #[test]
    fn trae_todas_las_secciones() {
        let d = DatosDiagnostico {
            errores: vec![EntradaLog { t: AHORA - 5000.0, nivel: Nivel::Error, origen: "renderer".into(), msg: "TypeError: x es undefined".into() }],
            avisos: vec!["Encontré un archivo dañado".into()],
            ..base()
        };
        let t = texto_diagnostico(&d, AHORA);
        assert!(t.starts_with("Diagnóstico de Sloth\n2026-11-17T12:00:00.000Z\n"), "{t}");
        for s in [
            "Sloth 0.6.28 · Electron 33.0.0 · Node 20.18.0 · Chrome 130.0.0",
            "Sistema: win32 10.0.26300 x64",
            "Funciones activas: git, chat, celular",
            "Cuentas: 2 · Espacios: 5",
            "sounds: sí\n  lightMode: no",
            "Últimos errores y avisos (2)",
            "[2026-11-17T11:59:55.000Z] renderer: TypeError: x es undefined",
            "[aviso] Encontré un archivo dañado",
        ] {
            assert!(t.contains(s), "falta {s}");
        }
        assert!(t.ends_with("Este texto no se envió a ningún lado: se copió a tu portapapeles. Revisalo antes de compartirlo."));
    }

    #[test]
    fn las_listas_vacias_lo_dicen() {
        let t = texto_diagnostico(&DatosDiagnostico { features: vec![], ajustes: vec![], ..base() }, AHORA);
        assert!(t.contains("Últimos errores y avisos (0)\n(sin errores)\n(sin avisos)"));
        assert!(t.contains("Funciones activas: (ninguna)") && t.contains("  (sin datos)"));
        assert!(!t.contains("sesión anterior") && !t.contains("No se pudo escribir"));
    }

    #[test]
    fn muestra_solo_las_30_mas_nuevas() {
        let d = DatosDiagnostico { errores: (0..45).map(entrada).collect(), ..base() };
        let t = texto_diagnostico(&d, AHORA);
        assert!(t.contains("Últimos errores y avisos (30)"));
        assert!(!t.contains("falla 14\n") && !t.contains("falla 14 "));
        assert!(t.find("falla 15").unwrap() < t.find("falla 44").unwrap());
    }

    #[test]
    fn avisa_del_cierre_inesperado_y_del_log() {
        let t = texto_diagnostico(&DatosDiagnostico { crash_previo: true, fallos_log: Some("EACCES: permission denied".into()), ..base() }, AHORA);
        assert!(t.contains("La sesión anterior terminó de forma inesperada."));
        assert!(t.contains("No se pudo escribir el archivo de log: EACCES: permission denied"));
    }

    #[test]
    fn una_fecha_invalida_no_tira_el_diagnostico() {
        let d = DatosDiagnostico { errores: vec![EntradaLog { t: f64::NAN, nivel: Nivel::Error, origen: "main".into(), msg: "x".into() }], ..base() };
        assert!(texto_diagnostico(&d, AHORA).contains("[fecha desconocida] main: x"));
    }

    #[test]
    fn el_mensaje_largo_se_acota() {
        let d = DatosDiagnostico { errores: vec![EntradaLog { t: 0.0, nivel: Nivel::Info, origen: "m".into(), msg: "a".repeat(5000) }], ..base() };
        assert!(texto_diagnostico(&d, AHORA).contains(&format!("{}…[cortado]", "a".repeat(600))));
    }

    #[test]
    fn ajustes_de_primer_nivel_y_de_notify_y_terminal() {
        let s = json!({ "sounds": true, "x": 1, "notify": { "done": false, "hondo": { "a": true } }, "terminal": { "bell": true }, "otro": { "b": true }, "lista": [true] });
        assert_eq!(ajustes_booleanos(&s), vec![("sounds".to_string(), true), ("notify.done".to_string(), false), ("terminal.bell".to_string(), true)]);
        assert!(ajustes_booleanos(&json!(null)).is_empty());
    }

    #[test]
    fn el_limite_deja_pasar_hasta_el_maximo_y_despues_corta() {
        let mut l = Limite::nuevo(3, 60_000.0);
        assert_eq!((0..5).map(|_| l.pasa(1000.0)).collect::<Vec<_>>(), [true, true, true, false, false]);
    }

    #[test]
    fn los_rechazados_no_cuentan_y_la_ventana_se_libera() {
        let mut l = Limite::nuevo(2, 1000.0);
        let r: Vec<bool> = [0.0, 400.0, 900.0, 1000.0, 1100.0, 1400.0].iter().map(|t| l.pasa(*t)).collect();
        assert_eq!(r, [true, true, false, true, false, true]);
        assert!(!Limite::nuevo(0, 1000.0).pasa(0.0));
    }

    #[test]
    fn error_del_renderer_rechaza_lo_que_no_sirve() {
        for p in [json!(null), json!("x"), json!(5), json!([]), json!({}), json!({ "mensaje": "" }), json!({ "mensaje": 3 }), json!({ "stack": "a" })] {
            assert_eq!(leer_error_renderer(&p), None, "{p}");
        }
    }

    #[test]
    fn error_del_renderer_con_stack_y_acotado() {
        assert_eq!(leer_error_renderer(&json!({ "mensaje": "roto" })).as_deref(), Some("roto"));
        assert_eq!(leer_error_renderer(&json!({ "mensaje": "roto", "stack": "at a" })).as_deref(), Some("roto\nat a"));
        assert_eq!(leer_error_renderer(&json!({ "mensaje": "m", "stack": 5 })).as_deref(), Some("m"));
        assert_eq!(leer_error_renderer(&json!({ "mensaje": "m", "stack": "" })).as_deref(), Some("m"));
        let t = leer_error_renderer(&json!({ "mensaje": "a".repeat(50_000), "stack": "b".repeat(50_000) })).unwrap();
        assert_eq!(t.len(), 20_000 + 1 + 20_000);
    }

    #[test]
    fn el_crash_previo_se_avisa_una_sola_vez() {
        let e = EstadoCrash::default();
        e.marcar(true);
        assert!(e.hubo());
        assert!(e.tomar());
        assert!(!e.tomar());
        assert!(e.hubo());
        let otro = EstadoCrash::default();
        assert!(!otro.tomar());
    }
}
