//! Lógica pura del estado de la ventana: leer lo guardado y decidir si sirve con los monitores de ahora.
//! Equivale a src/main/window-state-core.ts.
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Default, PartialEq)]
pub struct EstadoVentana {
    pub bounds: Option<Rect>,
    pub maximized: Option<bool>,
}

/// Tamaño mínimo que se acepta para restaurar (igual que el mínimo de la ventana).
pub const MIN_SIZE: (f64, f64) = (900.0, 560.0);
/// Cuánto tiene que verse del rectángulo dentro de algún monitor para usarlo.
pub const MIN_VISIBLE: (f64, f64) = (120.0, 80.0);

/// `Math.round` de JavaScript: la mitad va hacia arriba, también con negativos.
fn redondear(n: f64) -> f64 {
    (n + 0.5).floor()
}

/// Lee el JSON guardado. Tolerante: si está roto o tiene forma rara, devuelve el estado vacío.
pub fn leer_estado(json: &str) -> EstadoVentana {
    let Ok(Value::Object(r)) = serde_json::from_str::<Value>(json) else { return EstadoVentana::default() };
    let mut out = EstadoVentana::default();
    if let Some(Value::Object(b)) = r.get("bounds") {
        let n = |k: &str| b.get(k).and_then(Value::as_f64).filter(|v| v.is_finite());
        if let (Some(x), Some(y), Some(w), Some(h)) = (n("x"), n("y"), n("width"), n("height")) {
            if w > 0.0 && h > 0.0 {
                out.bounds = Some(Rect { x: redondear(x), y: redondear(y), width: redondear(w), height: redondear(h) });
            }
        }
    }
    if let Some(Value::Bool(m)) = r.get("maximized") {
        out.maximized = Some(*m);
    }
    out
}

/// Área común de dos rectángulos (0 si no se tocan).
fn superposicion(a: &Rect, b: &Rect) -> (f64, f64) {
    let w = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
    let h = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
    (w.max(0.0), h.max(0.0))
}

/// Devuelve los bounds guardados si siguen siendo usables con los monitores actuales: al menos 900×560 de tamaño y al
/// menos 120×80 visibles dentro de algún área de trabajo. Si no, None (la ventana arranca con el tamaño por defecto).
pub fn elegir_bounds(guardado: Option<Rect>, areas_de_trabajo: &[Rect]) -> Option<Rect> {
    let s = guardado?;
    if ![s.x, s.y, s.width, s.height].iter().all(|v| v.is_finite()) || s.width < MIN_SIZE.0 || s.height < MIN_SIZE.1 {
        return None;
    }
    areas_de_trabajo
        .iter()
        .any(|a| {
            let (w, h) = superposicion(&s, a);
            w >= MIN_VISIBLE.0 && h >= MIN_VISIBLE.1
        })
        .then_some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x, y, width: w, height: h }
    }
    const PANTALLA: Rect = Rect { x: 0.0, y: 0.0, width: 1920.0, height: 1040.0 };

    #[test]
    fn lee_lo_guardado_y_redondea() {
        let e = leer_estado(r#"{"bounds":{"x":10.4,"y":20.5,"width":1200.6,"height":800},"maximized":true}"#);
        assert_eq!(e, EstadoVentana { bounds: Some(r(10.0, 21.0, 1201.0, 800.0)), maximized: Some(true) });
        // Como Math.round: -0.5 va a -0, no a -1.
        assert_eq!(leer_estado(r#"{"bounds":{"x":-0.5,"y":-1.5,"width":10,"height":10}}"#).bounds, Some(r(0.0, -1.0, 10.0, 10.0)));
    }

    #[test]
    fn lo_roto_o_de_forma_rara_es_vacio() {
        for t in ["", "{ roto", "null", "[1]", "3", "\"x\"", r#"{"bounds":{"x":1,"y":1,"width":0,"height":5}}"#, r#"{"bounds":{"x":"1","y":1,"width":5,"height":5}}"#, r#"{"bounds":5}"#] {
            assert_eq!(leer_estado(t).bounds, None, "{t}");
        }
        assert_eq!(leer_estado(r#"{"maximized":"si"}"#).maximized, None);
        assert_eq!(leer_estado(r#"{"maximized":false}"#).maximized, Some(false));
    }

    #[test]
    fn usa_los_bounds_guardados_si_siguen_a_la_vista() {
        let b = r(100.0, 100.0, 1280.0, 800.0);
        assert_eq!(elegir_bounds(Some(b), &[PANTALLA]), Some(b));
        assert_eq!(elegir_bounds(None, &[PANTALLA]), None);
    }

    #[test]
    fn rechaza_los_muy_chicos_y_los_que_quedaron_fuera_de_todos_los_monitores() {
        assert_eq!(elegir_bounds(Some(r(0.0, 0.0, 899.0, 800.0)), &[PANTALLA]), None);
        assert_eq!(elegir_bounds(Some(r(0.0, 0.0, 1000.0, 559.0)), &[PANTALLA]), None);
        assert_eq!(elegir_bounds(Some(r(3000.0, 0.0, 1000.0, 600.0)), &[PANTALLA]), None, "monitor desconectado");
        assert_eq!(elegir_bounds(Some(r(1900.0, 0.0, 1000.0, 600.0)), &[PANTALLA]), None, "se ven 20 px");
        assert!(elegir_bounds(Some(r(1800.0, 960.0, 1000.0, 600.0)), &[PANTALLA]).is_some(), "se ven 120×80");
        assert!(elegir_bounds(Some(r(2500.0, 0.0, 1000.0, 600.0)), &[PANTALLA, r(1920.0, 0.0, 1920.0, 1040.0)]).is_some(), "segundo monitor");
        assert_eq!(elegir_bounds(Some(r(f64::NAN, 0.0, 1000.0, 600.0)), &[PANTALLA]), None);
    }
}
