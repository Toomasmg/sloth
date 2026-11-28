//! Cupo de la ventana de 5 h de cada cuenta (estimado desde los logs locales). Equivale a src/shared/cupo.ts.
//! `texto_renovacion` recibe el desfase de la zona horaria en minutos (Buenos Aires es -180) en vez de un nombre de zona.

pub const VENTANA_5H_MS: f64 = 5.0 * 60.0 * 60.0 * 1000.0;
/// Desde acá el cupo avisa; desde el siguiente umbral es casi seguro que Claude se frene pronto.
pub const UMBRAL_ATENCION: f64 = 70.0;
pub const UMBRAL_ALTO: f64 = 90.0;
/// Tope máximo que acepta Configuración, en tokens (evita un cero de más que deje la barra siempre vacía).
pub const TOPE_MAX: f64 = 1_000_000_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NivelCupo {
    SinTope,
    Ok,
    Atencion,
    Alto,
    Lleno,
}

#[derive(Debug, Clone, Copy)]
pub struct EventoUso {
    pub ts: f64,
    pub tokens: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct VentanaUso {
    #[serde(serialize_with = "crate::features::celular::tipos::numero_js")]
    pub inicio: f64,
    #[serde(serialize_with = "crate::features::celular::tipos::numero_js")]
    pub fin: f64,
    #[serde(serialize_with = "crate::features::celular::tipos::numero_js")]
    pub tokens: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cupo {
    pub usados: f64,
    /// None: sin tope conocido (plan sin valor por defecto y sin tope propio).
    pub tope: Option<f64>,
    /// Redondeado y sin pasar de 999. None si no hay tope.
    pub pct: Option<f64>,
    pub nivel: NivelCupo,
    /// Fin de la ventana activa. None si no hay ventana (sin uso en las últimas 5 h).
    pub renueva: Option<f64>,
}

/// `Math.round` de JavaScript.
fn redondear(n: f64) -> f64 {
    (n + 0.5).floor()
}

/// Lo que cuenta para el cupo: entrada, salida y caché escrita. La caché leída queda afuera porque pesa muy poco contra
/// el límite y, sumada, haría parecer que cualquier sesión larga se pasó.
pub fn tokens_cupo(input: f64, output: f64, cache_write: f64) -> f64 {
    input + output + cache_write
}

fn tiene_palabra(texto: &str, palabra: &str) -> bool {
    let b = texto.as_bytes();
    let es_palabra = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    texto.match_indices(palabra).any(|(i, _)| (i == 0 || !es_palabra(b[i - 1])) && (i + palabra.len() == b.len() || !es_palabra(b[i + palabra.len()])))
}

/// Un «20x» con el número pegado a la «x», como `\b20\s*x\b`.
fn tiene_20x(texto: &str) -> bool {
    let b = texto.as_bytes();
    let es_palabra = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    texto.match_indices("20").any(|(i, _)| {
        if i > 0 && es_palabra(b[i - 1]) {
            return false;
        }
        let resto = texto[i + 2..].trim_start_matches(|c: char| c.is_whitespace());
        resto.strip_prefix('x').is_some_and(|r| r.bytes().next().is_none_or(|c| !es_palabra(c)))
    })
}

/// Topes por defecto de la ventana de 5 h, en tokens de `tokens_cupo`. Son una estimación nuestra: Anthropic no publica
/// el límite ni lo deja en los logs, y cambia según la carga. Por eso el usuario puede pisarlos por cuenta.
pub fn tope_de_plan(plan: Option<&str>) -> Option<f64> {
    let p = plan.unwrap_or("").trim().to_lowercase();
    if p.is_empty() {
        return None;
    }
    if tiene_palabra(&p, "max") && tiene_20x(&p) {
        Some(20_000_000.0)
    } else if tiene_palabra(&p, "max") {
        Some(10_000_000.0)
    } else if tiene_palabra(&p, "team") || tiene_palabra(&p, "equipo") {
        Some(4_000_000.0)
    } else if tiene_palabra(&p, "pro") {
        Some(2_000_000.0)
    } else {
        None
    }
}

/// El tope propio manda si es un número positivo; 0, negativo o NaN cuentan como «sin tope propio».
pub fn tope_efectivo(plan: Option<&str>, propio: Option<f64>) -> Option<f64> {
    match propio {
        Some(p) if p.is_finite() && p > 0.0 => Some(redondear(p).min(TOPE_MAX)),
        _ => tope_de_plan(plan),
    }
}

/// La ventana de 5 h en curso. Claude abre una ventana con el primer mensaje y dura 5 h exactas; el mensaje siguiente a
/// esa hora abre otra. Sin mensajes, o con la última ventana ya vencida, no hay ventana activa.
pub fn ventana_activa(eventos: &[EventoUso], ahora: f64) -> Option<VentanaUso> {
    let mut orden: Vec<&EventoUso> = eventos.iter().filter(|e| e.ts.is_finite() && e.ts <= ahora).collect();
    orden.sort_by(|a, b| a.ts.partial_cmp(&b.ts).unwrap_or(std::cmp::Ordering::Equal));
    let mut actual: Option<VentanaUso> = None;
    for e in orden {
        let w = match actual {
            Some(w) if e.ts < w.fin => w,
            _ => VentanaUso { inicio: e.ts, fin: e.ts + VENTANA_5H_MS, tokens: 0.0 },
        };
        actual = Some(VentanaUso { tokens: w.tokens + e.tokens.max(0.0), ..w });
    }
    actual.filter(|w| w.fin > ahora)
}

pub fn nivel_de(pct: f64) -> NivelCupo {
    if pct >= 100.0 {
        NivelCupo::Lleno
    } else if pct >= UMBRAL_ALTO {
        NivelCupo::Alto
    } else if pct >= UMBRAL_ATENCION {
        NivelCupo::Atencion
    } else {
        NivelCupo::Ok
    }
}

/// Una ventana vencida cuenta como sin uso: el dato guardado puede tener hasta un minuto de atraso.
pub fn calcular_cupo(ventana: Option<VentanaUso>, tope: Option<f64>, ahora: f64) -> Cupo {
    let vigente = ventana.filter(|w| w.fin > ahora);
    let usados = vigente.map_or(0.0, |w| w.tokens);
    let renueva = vigente.map(|w| w.fin);
    match tope.filter(|t| t.is_finite() && *t > 0.0) {
        None => Cupo { usados, tope: None, pct: None, nivel: NivelCupo::SinTope, renueva },
        Some(t) => Cupo { usados, tope: Some(t), pct: Some(redondear(usados / t * 100.0).min(999.0)), nivel: nivel_de(usados / t * 100.0), renueva },
    }
}

/// Año, mes, día, hora y minuto de un instante en una zona con ese desfase.
fn fecha_local(ms: f64, desfase_min: i32) -> (i64, u32, u32, u32, u32) {
    let total_min = ((ms / 60_000.0).floor() as i64) + i64::from(desfase_min);
    let (dias, resto) = (total_min.div_euclid(1440), total_min.rem_euclid(1440));
    // Días desde 1970-01-01 a fecha civil (algoritmo de Howard Hinnant).
    let z = dias + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let dia = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let mes = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let anio = yoe + era * 400 + i64::from(mes <= 2);
    (anio, mes, dia, (resto / 60) as u32, (resto % 60) as u32)
}

/// «17:10», o «mañana 01:10» si la ventana cruza la medianoche (en la zona con ese desfase en minutos).
pub fn texto_renovacion(renueva: f64, ahora: f64, desfase_min: i32) -> String {
    let (a, m, d, h, mi) = fecha_local(renueva, desfase_min);
    let hora = format!("{h:02}:{mi:02}");
    let (a2, m2, d2, _, _) = fecha_local(ahora, desfase_min);
    if (a, m, d) == (a2, m2, d2) {
        hora
    } else {
        format!("mañana {hora}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: f64 = 60.0 * 60.0 * 1000.0;
    // 2026-11-26 12:00 UTC
    const T0: f64 = 1_795_694_400_000.0;
    fn utc(d: u32, h: u32, m: u32) -> f64 {
        T0 + f64::from(d) * 24.0 * H + (f64::from(h) - 12.0) * H + f64::from(m) * 60_000.0
    }
    fn ev(ts: f64, tokens: f64) -> EventoUso {
        EventoUso { ts, tokens }
    }

    #[test]
    fn tokens_cupo_no_suma_la_cache_leida() {
        assert_eq!(tokens_cupo(10.0, 20.0, 5.0), 35.0);
    }

    #[test]
    fn tope_de_plan_tabla_de_planes() {
        for (plan, esperado) in [
            (Some("Pro"), Some(2e6)),
            (Some(" pro "), Some(2e6)),
            (Some("Team"), Some(4e6)),
            (Some("Equipo"), Some(4e6)),
            (Some("Max"), Some(10e6)),
            (Some("Max 5x"), Some(10e6)),
            (Some("Max 20x"), Some(20e6)),
            (Some("20x Max"), Some(20e6)),
            (Some("Max 20 x"), Some(20e6)),
            (Some("Enterprise"), None),
            (Some("Maximo"), None),
            (Some("Producto"), None),
            (Some(""), None),
            (None, None),
        ] {
            assert_eq!(tope_de_plan(plan), esperado, "{plan:?}");
        }
    }

    #[test]
    fn tope_efectivo_el_propio_pisa_al_del_plan() {
        assert_eq!(tope_efectivo(Some("Pro"), Some(500_000.0)), Some(500_000.0));
        assert_eq!(tope_efectivo(Some("Pro"), Some(0.0)), Some(2e6));
        assert_eq!(tope_efectivo(Some("Pro"), Some(-5.0)), Some(2e6));
        assert_eq!(tope_efectivo(Some("Pro"), Some(f64::NAN)), Some(2e6));
        assert_eq!(tope_efectivo(None, None), None);
        assert_eq!(tope_efectivo(None, Some(1000.0)), Some(1000.0));
        assert_eq!(tope_efectivo(Some("Pro"), Some(5e12)), Some(1e9));
    }

    #[test]
    fn ventana_activa_sin_mensajes_no_hay_ventana() {
        assert_eq!(ventana_activa(&[], T0), None);
    }

    #[test]
    fn la_ventana_arranca_en_el_primer_mensaje_y_dura_5_horas_exactas() {
        let v = ventana_activa(&[ev(T0 - 2.0 * H, 100.0), ev(T0 - H, 50.0)], T0);
        assert_eq!(v, Some(VentanaUso { inicio: T0 - 2.0 * H, fin: T0 + 3.0 * H, tokens: 150.0 }));
    }

    #[test]
    fn una_ventana_vencida_no_cuenta() {
        assert_eq!(ventana_activa(&[ev(T0 - 6.0 * H, 100.0)], T0), None);
    }

    #[test]
    fn el_mensaje_posterior_al_fin_abre_otra_ventana_y_no_arrastra_lo_anterior() {
        let v = ventana_activa(&[ev(T0 - 6.0 * H, 10.0), ev(T0 - 4.0 * H, 20.0), ev(T0 - H, 30.0)], T0);
        assert_eq!(v, Some(VentanaUso { inicio: T0 - H, fin: T0 + 4.0 * H, tokens: 30.0 }));
    }

    #[test]
    fn ignora_mensajes_del_futuro_desordenados_y_con_tokens_raros() {
        let v = ventana_activa(&[ev(T0 + H, 999.0), ev(T0 - H, -4.0), ev(T0 - 2.0 * H, 7.0), ev(f64::NAN, 1.0)], T0);
        assert_eq!(v, Some(VentanaUso { inicio: T0 - 2.0 * H, fin: T0 - 2.0 * H + VENTANA_5H_MS, tokens: 7.0 }));
    }

    #[test]
    fn nivel_de_umbrales() {
        use NivelCupo::*;
        let n: Vec<NivelCupo> = [0.0, 69.0, 70.0, 89.0, 90.0, 99.0, 100.0, 250.0].iter().map(|p| nivel_de(*p)).collect();
        assert_eq!(n, [Ok, Ok, Atencion, Atencion, Alto, Alto, Lleno, Lleno]);
    }

    #[test]
    fn calcular_cupo_sin_uso_con_tope_y_con_uso() {
        assert_eq!(calcular_cupo(None, Some(1000.0), T0), Cupo { usados: 0.0, tope: Some(1000.0), pct: Some(0.0), nivel: NivelCupo::Ok, renueva: None });
        let c = calcular_cupo(Some(VentanaUso { inicio: T0 - H, fin: T0 + 4.0 * H, tokens: 820.0 }), Some(1000.0), T0);
        assert_eq!(c, Cupo { usados: 820.0, tope: Some(1000.0), pct: Some(82.0), nivel: NivelCupo::Atencion, renueva: Some(T0 + 4.0 * H) });
    }

    #[test]
    fn calcular_cupo_con_tope_invalido_no_divide_por_cero() {
        let v = Some(VentanaUso { inicio: T0 - H, fin: T0 + 4.0 * H, tokens: 820.0 });
        for tope in [Some(0.0), None, Some(-1.0), Some(f64::NAN)] {
            let c = calcular_cupo(v, tope, T0);
            assert_eq!((c.nivel, c.pct, c.usados), (NivelCupo::SinTope, None, 820.0));
        }
    }

    #[test]
    fn pasado_el_tope_queda_lleno_y_el_porcentaje_se_acota() {
        let c = calcular_cupo(Some(VentanaUso { inicio: T0, fin: T0 + 5.0 * H, tokens: 5_000_000.0 }), Some(1000.0), T0);
        assert_eq!((c.pct, c.nivel), (Some(999.0), NivelCupo::Lleno));
    }

    #[test]
    fn una_ventana_ya_vencida_cuenta_como_sin_uso() {
        let c = calcular_cupo(Some(VentanaUso { inicio: T0 - 6.0 * H, fin: T0 - H, tokens: 900.0 }), Some(1000.0), T0);
        assert_eq!(c, Cupo { usados: 0.0, tope: Some(1000.0), pct: Some(0.0), nivel: NivelCupo::Ok, renueva: None });
    }

    #[test]
    fn texto_de_renovacion_mismo_dia_cruce_de_medianoche_y_zona() {
        assert_eq!(texto_renovacion(utc(0, 17, 10), utc(0, 15, 0), 0), "17:10");
        assert_eq!(texto_renovacion(utc(1, 1, 10), utc(0, 21, 0), 0), "mañana 01:10");
        // 02:30 UTC del 27 es 23:30 del 26 en Buenos Aires (-03:00): para quien está allá sigue siendo «hoy».
        assert_eq!(texto_renovacion(utc(1, 2, 30), utc(0, 20, 0), -180), "23:30");
        assert_eq!(texto_renovacion(utc(1, 2, 30), utc(0, 20, 0), 0), "mañana 02:30");
        assert_eq!(texto_renovacion(utc(1, 0, 0), utc(0, 20, 0), 0), "mañana 00:00");
    }
}
