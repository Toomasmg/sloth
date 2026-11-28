//! Reintento con tope: un intento que falla por algo pasajero se repite, pero el total no pasa de un tiempo ni de un costo.
//! Equivale a src/main/features/tickets/reintento.ts.
use super::errores::ErrorTickets;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PresupuestoReintento {
    /// Lo que queda para este intento; None = sin tope de costo.
    pub restante_usd: Option<f64>,
    pub restante_ms: f64,
}

pub struct OpcionesReintento<'a> {
    pub intentos_max: u32,
    /// Tope de tiempo de todos los intentos juntos.
    pub tiempo_max_ms: f64,
    /// Tope de costo de todos los intentos juntos; sin él, no se descuenta nada.
    pub costo_max_usd: Option<f64>,
    /// Menos que esto de tiempo restante no vale otro intento.
    pub minimo_ms: f64,
    /// Menos que esto de costo restante no vale otro intento (el tope de `claude` no admite menos de un centavo).
    pub minimo_usd: f64,
    pub reintentable: &'a dyn Fn(&ErrorTickets) -> bool,
    /// Lo que gastó el intento que falló, si se sabe.
    pub costo_de: Option<&'a dyn Fn(&ErrorTickets) -> Option<f64>>,
    pub ahora: &'a dyn Fn() -> f64,
}

/// El costo que dejó un intento con el servidor todavía conectando (descontado del tope del siguiente).
pub fn costo_de_pendiente(e: &ErrorTickets) -> Option<f64> {
    match e {
        ErrorTickets::ServidorPendiente { costo_usd, .. } => *costo_usd,
        _ => None,
    }
}

pub fn con_reintento<T>(corre: &mut dyn FnMut(PresupuestoReintento) -> Result<T, ErrorTickets>, o: &OpcionesReintento) -> Result<T, ErrorTickets> {
    let inicio = (o.ahora)();
    let mut gastado = 0.0;
    let mut intento = 1;
    loop {
        let restante_ms = (o.tiempo_max_ms - ((o.ahora)() - inicio)).max(0.0);
        let restante_usd = o.costo_max_usd.map(|m| (m - gastado).max(0.0));
        match corre(PresupuestoReintento { restante_usd, restante_ms }) {
            Ok(r) => return Ok(r),
            Err(e) => {
                if let Some(c) = o.costo_de.and_then(|f| f(&e)) {
                    if c.is_finite() && c > 0.0 {
                        gastado += c;
                    }
                }
                let sin_tiempo = o.tiempo_max_ms - ((o.ahora)() - inicio) < o.minimo_ms;
                let sin_costo = o.costo_max_usd.is_some_and(|m| m - gastado <= 0.0 || m - gastado < o.minimo_usd);
                if !(o.reintentable)(&e) || intento >= o.intentos_max || sin_tiempo || sin_costo {
                    return Err(e);
                }
                intento += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn pasajero(costo: Option<f64>) -> ErrorTickets {
        ErrorTickets::ServidorPendiente { mensaje: "pasajero".into(), costo_usd: costo }
    }

    fn es_pasajero(e: &ErrorTickets) -> bool {
        matches!(e, ErrorTickets::ServidorPendiente { .. })
    }

    fn reloj() -> f64 {
        0.0
    }

    fn base<'a>(reintentable: &'a dyn Fn(&ErrorTickets) -> bool, costo_de: &'a dyn Fn(&ErrorTickets) -> Option<f64>, ahora: &'a dyn Fn() -> f64) -> OpcionesReintento<'a> {
        OpcionesReintento { intentos_max: 3, tiempo_max_ms: 300_000.0, costo_max_usd: None, minimo_ms: 0.0, minimo_usd: 0.0, reintentable, costo_de: Some(costo_de), ahora }
    }

    #[test]
    fn reintenta_lo_pasajero_hasta_el_maximo_y_devuelve_lo_que_salga() {
        let o = base(&es_pasajero, &costo_de_pendiente, &reloj);
        let mut n = 0;
        let r = con_reintento(
            &mut |_| {
                n += 1;
                if n < 3 {
                    Err(pasajero(None))
                } else {
                    Ok("ok")
                }
            },
            &o,
        );
        assert_eq!((r.unwrap(), n), ("ok", 3));
        let mut n = 0;
        let e = con_reintento::<()>(
            &mut |_| {
                n += 1;
                Err(pasajero(None))
            },
            &o,
        );
        assert!(matches!(e, Err(ErrorTickets::ServidorPendiente { .. })));
        assert_eq!(n, 3);
    }

    #[test]
    fn lo_que_no_es_pasajero_no_se_reintenta() {
        let o = base(&es_pasajero, &costo_de_pendiente, &reloj);
        let mut n = 0;
        let e = con_reintento::<()>(
            &mut |_| {
                n += 1;
                Err(ErrorTickets::otro("otro"))
            },
            &o,
        );
        assert_eq!(e.unwrap_err(), ErrorTickets::otro("otro"));
        assert_eq!(n, 1);
    }

    #[test]
    fn cada_intento_fallido_descuenta_del_tope_de_costo_y_el_siguiente_recibe_lo_que_queda() {
        let mut o = base(&es_pasajero, &costo_de_pendiente, &reloj);
        o.costo_max_usd = Some(0.5);
        let mut vistos: Vec<Option<f64>> = Vec::new();
        let _ = con_reintento::<()>(
            &mut |p| {
                vistos.push(p.restante_usd);
                Err(pasajero(Some(0.3)))
            },
            &o,
        );
        assert_eq!(vistos.len(), 2);
        assert_eq!(vistos[0], Some(0.5));
        assert!((vistos[1].unwrap() - 0.2).abs() < 1e-9);
    }

    #[test]
    fn con_menos_del_minimo_de_costo_restante_no_se_reintenta() {
        let mut o = base(&es_pasajero, &costo_de_pendiente, &reloj);
        o.costo_max_usd = Some(0.5);
        o.minimo_usd = 0.01;
        let mut n = 0;
        let _ = con_reintento::<()>(
            &mut |_| {
                n += 1;
                Err(pasajero(Some(0.495)))
            },
            &o,
        );
        assert_eq!(n, 1);
    }

    #[test]
    fn sin_tope_de_costo_no_se_descuenta_nada() {
        let o = base(&es_pasajero, &costo_de_pendiente, &reloj);
        let mut vistos: Vec<Option<f64>> = Vec::new();
        let _ = con_reintento::<()>(
            &mut |p| {
                vistos.push(p.restante_usd);
                Err(pasajero(Some(5.0)))
            },
            &o,
        );
        assert_eq!(vistos, vec![None, None, None]);
    }

    #[test]
    fn el_tiempo_total_se_acota_no_se_reintenta_si_no_queda_lo_minimo_y_cada_intento_sabe_cuanto_le_queda() {
        let t = Cell::new(0.0);
        let ahora = || t.get();
        let mut o = base(&es_pasajero, &costo_de_pendiente, &ahora);
        o.minimo_ms = 30_000.0;
        let mut restantes: Vec<f64> = Vec::new();
        let _ = con_reintento::<()>(
            &mut |p| {
                restantes.push(p.restante_ms);
                t.set(t.get() + 200_000.0);
                Err(pasajero(None))
            },
            &o,
        );
        assert_eq!(restantes, vec![300_000.0, 100_000.0]);
        restantes.clear();
        t.set(0.0);
        let _ = con_reintento::<()>(
            &mut |p| {
                restantes.push(p.restante_ms);
                t.set(t.get() + 280_000.0);
                Err(pasajero(None))
            },
            &o,
        );
        assert_eq!(restantes, vec![300_000.0]);
    }
}
