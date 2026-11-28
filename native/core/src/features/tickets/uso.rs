//! Límites de una corrida de `claude -p` y lo que gastó. Equivale a src/main/features/tickets/uso.ts.
use super::errores::ErrorTickets;
use super::modelo::{Corrida, Ordenado, Tope, UsoAcum, UsoPorDia, VUELTAS_DEFECTO, VUELTAS_MAX};
use super::texto::{num_valor, re, Num};
use serde_json::Value;

pub const VUELTAS_MIN: u32 = 1;
pub const COSTO_MIN: f64 = 0.01;
pub const COSTO_MAX: f64 = 100.0;
const DIAS_MAX: usize = 60;
const CONECTORES_MAX: usize = 50;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct UsoCorrida {
    pub cost_usd: Option<f64>,
    pub duration_ms: Option<f64>,
    pub num_turns: Option<f64>,
    pub tokens: Option<f64>,
    pub tope: Option<Tope>,
}

impl UsoCorrida {
    pub fn a_corrida(&self, max_turns: u32) -> Corrida {
        Corrida {
            tokens: self.tokens.map(Num),
            cost_usd: self.cost_usd.map(Num),
            duration_ms: self.duration_ms.map(Num),
            num_turns: self.num_turns.map(Num),
            max_turns: Some(Num(f64::from(max_turns))),
            tope: self.tope,
        }
    }
}

/// Un día `YYYY-MM-DD` que existe en el calendario.
fn dia_real(d: &str) -> bool {
    if !re(r"^\d{4}-\d{2}-\d{2}$").is_match(d) {
        return false;
    }
    let (a, m, dia): (i64, u32, u32) = (d[0..4].parse().unwrap_or(0), d[5..7].parse().unwrap_or(0), d[8..10].parse().unwrap_or(0));
    if !(1..=12).contains(&m) || dia < 1 {
        return false;
    }
    let bisiesto = (a % 4 == 0 && a % 100 != 0) || a % 400 == 0;
    let dias = match m {
        2 if bisiesto => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    dia <= dias
}

pub fn vueltas_validas(v: &Value) -> Option<u32> {
    let n = v.as_f64()?;
    (n.fract() == 0.0 && n >= f64::from(VUELTAS_MIN) && n <= f64::from(VUELTAS_MAX)).then_some(n as u32)
}

pub fn costo_valido(v: &Value) -> Option<f64> {
    let n = v.as_f64().filter(|n| n.is_finite())?;
    let r = (n * 100.0 + 0.5).floor() / 100.0;
    (COSTO_MIN..=COSTO_MAX).contains(&r).then_some(r)
}

pub fn costo_valido_f(v: Option<f64>) -> Option<f64> {
    v.and_then(|n| costo_valido(&num_valor(n)))
}

pub fn vueltas_validas_f(v: Option<f64>) -> Option<u32> {
    v.and_then(|n| vueltas_validas(&num_valor(n)))
}

const TOKENS_CLAVES: [&str; 4] = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];

fn es_resultado(m: &Value) -> bool {
    m.is_object() && m.get("type").and_then(Value::as_str) == Some("result")
}

fn resultado_de(stdout: &str) -> Option<Value> {
    let t = super::texto::trim_js(stdout);
    if t.is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(t) {
        Ok(Value::Array(xs)) => xs.into_iter().rev().find(es_resultado),
        Ok(j) => es_resultado(&j).then_some(j),
        Err(_) => t.lines().rev().find_map(|l| serde_json::from_str::<Value>(l).ok().filter(es_resultado)),
    }
}

pub fn leer_uso(stdout: &str) -> Option<UsoCorrida> {
    let env = resultado_de(stdout)?;
    let sumas: Vec<f64> = env
        .get("usage")
        .filter(|u| u.is_object())
        .map(|u| TOKENS_CLAVES.iter().filter_map(|k| u.get(*k).and_then(super::texto::numero)).collect())
        .unwrap_or_default();
    let tope = match env.get("subtype").and_then(Value::as_str) {
        Some("error_max_turns") => Some(Tope::Vueltas),
        Some("error_max_budget_usd") => Some(Tope::Costo),
        _ => None,
    };
    let num = |k: &str| env.get(k).and_then(super::texto::numero);
    Some(UsoCorrida {
        cost_usd: num("total_cost_usd"),
        duration_ms: num("duration_ms"),
        num_turns: num("num_turns"),
        tokens: (!sumas.is_empty()).then(|| sumas.iter().sum()),
        tope,
    })
}

/// El corte por tope, con lo que la corrida alcanzó a gastar.
pub fn tope_vueltas_error(mensaje: String, tope: Tope, uso: UsoCorrida) -> ErrorTickets {
    ErrorTickets::Tope { mensaje, tope, uso }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LimitesEfectivos {
    pub vueltas: u32,
    pub costo: Option<f64>,
}

/// Los topes que de verdad llevan los args de la consulta; se toman antes de correrla, porque la config puede cambiar mientras tanto.
pub fn limites_efectivos(max_turns: Option<f64>, max_cost_usd: Option<f64>) -> LimitesEfectivos {
    LimitesEfectivos { vueltas: vueltas_validas_f(max_turns).unwrap_or(VUELTAS_DEFECTO), costo: costo_valido_f(max_cost_usd) }
}

pub fn texto_tope(tope: Tope, limite: f64, accion: bool) -> String {
    let base = match tope {
        Tope::Vueltas if limite >= f64::from(VUELTAS_MAX) => {
            format!("La consulta se cortó por tope de vueltas ({}), el máximo. Probá con algo más acotado.", num_txt(limite))
        }
        Tope::Vueltas => format!("La consulta se cortó por tope de vueltas ({}). Podés continuar con más vueltas o subir el tope en los ajustes.", num_txt(limite)),
        Tope::Costo => format!("La consulta se cortó por tope de costo (US$ {}). Podés subir el tope en los ajustes.", num_txt(limite).replace('.', ",")),
    };
    if accion {
        format!("{base} Revisá el ticket: el cambio pudo quedar a medias.")
    } else {
        base
    }
}

fn num_txt(n: f64) -> String {
    serde_json::to_string(&Num(n)).unwrap_or_default()
}

/// Qué queda en `lastRun` tras un intento fallido: solo el corte por tope conserva su `tope`; cualquier otro error lo limpia.
pub fn last_run_tras_error(previo: Option<&Corrida>, e: Option<&ErrorTickets>, max_turns: u32) -> Option<Corrida> {
    if let Some(ErrorTickets::Tope { tope, uso, .. }) = e {
        let mut c = uso.a_corrida(max_turns);
        c.tope = Some(*tope);
        return Some(c);
    }
    let previo = previo?;
    if previo.tope.is_none() {
        return Some(previo.clone());
    }
    let mut c = previo.clone();
    c.tope = None;
    Some(c)
}

/// Un claude que no conoce --max-budget-usd sale con error y stdout vacío: se explica en vez de mostrar el parse genérico.
pub fn texto_flag_viejo(msg: &str) -> Option<&'static str> {
    let a = msg.to_lowercase();
    let flag = "--max-budget-usd";
    let hay = a.contains("unknown option") && a.contains(flag);
    hay.then_some("Tu versión de Claude Code no soporta el tope de costo: actualizala o borrá el tope en los ajustes de Tickets.")
}

fn suma_sana(previo: f64, nuevo: Option<f64>) -> f64 {
    let r = previo + nuevo.filter(|n| *n >= 0.0).unwrap_or(0.0);
    if r.is_finite() {
        r
    } else {
        previo
    }
}

/// Suma una corrida al acumulado del día y conector, y deja solo los 60 días más nuevos. No toca lo anterior.
pub fn sumar_uso(uso: Option<&UsoPorDia>, dia: &str, conector_id: &str, u: &UsoCorrida) -> UsoPorDia {
    let mut todo = uso.cloned().unwrap_or_default();
    let previo = todo.get(dia).and_then(|d| d.get(conector_id)).copied().unwrap_or_default();
    let nuevo = UsoAcum {
        corridas: Num(previo.corridas.0 + 1.0),
        cost_usd: Num(suma_sana(previo.cost_usd.0, u.cost_usd)),
        vueltas: Num(suma_sana(previo.vueltas.0, u.num_turns)),
        duration_ms: Num(suma_sana(previo.duration_ms.0, u.duration_ms)),
    };
    let mut del_dia = todo.get(dia).cloned().unwrap_or_default();
    del_dia.insert(conector_id, nuevo);
    todo.insert(dia, del_dia);
    let mut dias: Vec<(String, Ordenado<UsoAcum>)> = todo.0;
    dias.sort_by(|a, b| a.0.cmp(&b.0));
    let desde = dias.len().saturating_sub(DIAS_MAX);
    Ordenado(dias.split_off(desde))
}

fn acum_no_negativo(v: Option<&Value>) -> Option<f64> {
    v.and_then(super::texto::numero).filter(|n| *n >= 0.0)
}

pub fn sanear_uso(raw: &Value) -> Option<UsoPorDia> {
    let obj = raw.as_object()?;
    let mut dias: Vec<&String> = obj.keys().filter(|k| dia_real(k)).collect();
    dias.sort();
    let desde = dias.len().saturating_sub(DIAS_MAX);
    let mut out: UsoPorDia = Ordenado::default();
    for d in &dias[desde..] {
        let Some(por_conector) = obj[*d].as_object() else { continue };
        let mut dia: Ordenado<UsoAcum> = Ordenado::default();
        for (id, a) in por_conector {
            if dia.len() >= CONECTORES_MAX {
                break;
            }
            if !re(r"^[a-z][a-z0-9-]{1,31}$").is_match(id) || !a.is_object() {
                continue;
            }
            let (Some(corridas), Some(cost), Some(vueltas), Some(dur)) =
                (acum_no_negativo(a.get("corridas")), acum_no_negativo(a.get("costUsd")), acum_no_negativo(a.get("vueltas")), acum_no_negativo(a.get("durationMs")))
            else {
                continue;
            };
            dia.insert(id.clone(), UsoAcum { corridas: Num(corridas), cost_usd: Num(cost), vueltas: Num(vueltas), duration_ms: Num(dur) });
        }
        if !dia.is_empty() {
            out.insert((*d).clone(), dia);
        }
    }
    (!out.is_empty()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn acum(c: f64, k: f64, v: f64, d: f64) -> UsoAcum {
        UsoAcum { corridas: Num(c), cost_usd: Num(k), vueltas: Num(v), duration_ms: Num(d) }
    }

    #[test]
    fn vueltas_validas_acepta_enteros_de_1_a_200_y_nada_mas() {
        for v in [1, 40, 200] {
            assert_eq!(vueltas_validas(&json!(v)), Some(v));
        }
        for v in [json!(0), json!(201), json!(1.5), json!("40"), json!(-1), json!(null), json!({})] {
            assert_eq!(vueltas_validas(&v), None, "{v}");
        }
    }

    #[test]
    fn costo_valido_acepta_de_0_01_a_100_y_redondea_a_2_decimales() {
        assert_eq!(costo_valido(&json!(0.01)), Some(0.01));
        assert_eq!(costo_valido(&json!(2.345)), Some(2.35));
        assert_eq!(costo_valido(&json!(100)), Some(100.0));
        for v in [json!(0), json!(0.004), json!(100.01), json!(-1), json!("2"), json!(null)] {
            assert_eq!(costo_valido(&v), None, "{v}");
        }
    }

    fn resultado() -> Value {
        json!({ "type": "result", "subtype": "success", "total_cost_usd": 0.12, "duration_ms": 3400, "num_turns": 6, "usage": { "input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 100 } })
    }

    #[test]
    fn leer_uso_lee_un_objeto_un_arreglo_y_lineas_con_basura_antes() {
        let esperado = UsoCorrida { cost_usd: Some(0.12), duration_ms: Some(3400.0), num_turns: Some(6.0), tokens: Some(115.0), tope: None };
        assert_eq!(leer_uso(&resultado().to_string()), Some(esperado.clone()));
        assert_eq!(leer_uso(&json!([{ "type": "system" }, resultado(), { "type": "otro" }]).to_string()), Some(esperado.clone()));
        let con_basura = format!("aviso raro\n{}\n{}\n", json!({ "type": "system" }), resultado());
        assert_eq!(leer_uso(&con_basura), Some(esperado));
    }

    #[test]
    fn leer_uso_marca_el_tope_segun_el_subtype() {
        let mut r = resultado();
        r["subtype"] = json!("error_max_turns");
        assert_eq!(leer_uso(&r.to_string()).unwrap().tope, Some(Tope::Vueltas));
        r["subtype"] = json!("error_max_budget_usd");
        assert_eq!(leer_uso(&r.to_string()).unwrap().tope, Some(Tope::Costo));
        assert_eq!(leer_uso(&resultado().to_string()).unwrap().tope, None);
    }

    #[test]
    fn leer_uso_ignora_lo_no_numerico_y_no_tira_con_salidas_raras() {
        let r = json!({ "type": "result", "total_cost_usd": "1", "num_turns": null, "usage": { "input_tokens": "x", "output_tokens": 4 } });
        assert_eq!(leer_uso(&r.to_string()), Some(UsoCorrida { tokens: Some(4.0), ..Default::default() }));
        for s in ["", "   ", "no es json", "[]", "{\"type\":\"system\"}", "[1,null,\"x\"]", "null", "7"] {
            assert_eq!(leer_uso(s), None, "{s}");
        }
    }

    #[test]
    fn el_error_de_tope_conserva_el_tope_y_el_uso() {
        let e = tope_vueltas_error("cortada".into(), Tope::Vueltas, UsoCorrida { num_turns: Some(40.0), ..Default::default() });
        assert_eq!(e.to_string(), "cortada");
        match e {
            ErrorTickets::Tope { tope, uso, .. } => {
                assert_eq!(tope, Tope::Vueltas);
                assert_eq!(uso.num_turns, Some(40.0));
            }
            _ => panic!("no es un tope"),
        }
    }

    #[test]
    fn texto_tope_dice_cual_fue_el_tope_y_avisa_si_una_accion_pudo_quedar_a_medias() {
        assert_eq!(texto_tope(Tope::Vueltas, 40.0, false), "La consulta se cortó por tope de vueltas (40). Podés continuar con más vueltas o subir el tope en los ajustes.");
        assert!(texto_tope(Tope::Vueltas, 40.0, true).ends_with("Revisá el ticket: el cambio pudo quedar a medias."));
        assert!(texto_tope(Tope::Costo, 2.5, false).contains("tope de costo (US$ 2,5)"));
        assert!(!texto_tope(Tope::Costo, 2.5, false).contains("a medias"));
        let t = texto_tope(Tope::Vueltas, 200.0, false);
        assert!(t.contains("tope de vueltas (200)") && !t.contains("continuar"));
        assert!(texto_tope(Tope::Vueltas, 199.0, false).contains("continuar"));
    }

    #[test]
    fn sumar_uso_acumula_por_dia_y_conector_sin_mutar_lo_anterior() {
        let a = sumar_uso(None, "2026-11-17", "gruv", &UsoCorrida { cost_usd: Some(0.1), num_turns: Some(4.0), duration_ms: Some(1000.0), ..Default::default() });
        let copia = a.clone();
        let b = sumar_uso(Some(&a), "2026-11-17", "gruv", &UsoCorrida { cost_usd: Some(0.2), num_turns: Some(6.0), ..Default::default() });
        let c = sumar_uso(Some(&b), "2026-11-17", "github", &UsoCorrida::default());
        assert_eq!(a, copia);
        assert_eq!(*b.get("2026-11-17").unwrap().get("gruv").unwrap(), acum(2.0, 0.1 + 0.2, 10.0, 1000.0));
        assert_eq!(*c.get("2026-11-17").unwrap().get("github").unwrap(), acum(1.0, 0.0, 0.0, 0.0));
        assert_eq!(c.get("2026-11-17").unwrap().get("gruv"), b.get("2026-11-17").unwrap().get("gruv"));
    }

    fn dia_n(i: i64) -> String {
        super::super::modelo::dia_de((super::super::modelo::dias_civiles(2026, 1, 1) + i) * 86_400_000)
    }

    #[test]
    fn sumar_uso_conserva_solo_los_60_dias_mas_nuevos() {
        let mut uso: Option<UsoPorDia> = None;
        for i in 0..65 {
            uso = Some(sumar_uso(uso.as_ref(), &dia_n(i), "gruv", &UsoCorrida { cost_usd: Some(1.0), ..Default::default() }));
        }
        let dias: Vec<&String> = uso.as_ref().unwrap().claves().collect();
        assert_eq!(dias.len(), 60);
        assert_eq!(dias[0], &dia_n(5));
        assert_eq!(dias[59], &dia_n(64));
    }

    #[test]
    fn sanear_uso_descarta_claves_malas_negativos_y_no_numeros() {
        let bueno = json!({ "corridas": 2, "costUsd": 0.5, "vueltas": 9, "durationMs": 100 });
        let mut negativo = bueno.clone();
        negativo["costUsd"] = json!(-1);
        let mut texto = bueno.clone();
        texto["vueltas"] = json!("3");
        let raw = json!({
            "2026-11-17": { "gruv": bueno, "Mal Id": bueno, "github": negativo, "asana": texto, "jira": "x" },
            "17/11/2026": { "gruv": bueno },
            "2026-11-16": { "gruv": { "corridas": null, "costUsd": 0, "vueltas": 0, "durationMs": 0 } }
        });
        let esperado: UsoPorDia = serde_json::from_value(json!({ "2026-11-17": { "gruv": bueno } })).unwrap();
        assert_eq!(sanear_uso(&raw), Some(esperado));
        for v in [json!(null), json!("x"), json!([]), json!({}), json!({ "2026-11-17": {} })] {
            assert_eq!(sanear_uso(&v), None);
        }
    }

    #[test]
    fn sanear_uso_acota_dias_y_conectores_y_es_idempotente() {
        let acum = json!({ "corridas": 1, "costUsd": 0, "vueltas": 0, "durationMs": 0 });
        let dias: serde_json::Map<String, Value> = (0..70).map(|i| (dia_n(i), json!({ "gruv": acum }))).collect();
        let una = sanear_uso(&Value::Object(dias)).unwrap();
        assert_eq!(una.len(), 60);
        assert_eq!(sanear_uso(&serde_json::to_value(&una).unwrap()), Some(una));
        let muchos: serde_json::Map<String, Value> = (0..80).map(|i| (format!("con-{i:02}"), acum.clone())).collect();
        let r = sanear_uso(&json!({ "2026-11-17": muchos })).unwrap();
        assert_eq!(r.get("2026-11-17").unwrap().len(), 50);
    }

    #[test]
    fn sanear_uso_descarta_dias_imposibles() {
        let bueno = json!({ "corridas": 1, "costUsd": 0, "vueltas": 0, "durationMs": 0 });
        let r = sanear_uso(&json!({ "2026-13-45": { "gruv": bueno }, "2026-02-30": { "gruv": bueno }, "2026-02-28": { "gruv": bueno } })).unwrap();
        assert_eq!(r.claves().collect::<Vec<_>>(), vec!["2026-02-28"]);
    }

    #[test]
    fn last_run_tras_error_conserva_el_tope_solo_si_el_error_es_el_corte() {
        let cortada = Corrida { num_turns: Some(Num(40.0)), max_turns: Some(Num(40.0)), tope: Some(Tope::Vueltas), ..Default::default() };
        let corte = tope_vueltas_error("cortada".into(), Tope::Costo, UsoCorrida { cost_usd: Some(1.0), tope: Some(Tope::Costo), ..Default::default() });
        let r = last_run_tras_error(None, Some(&corte), 20).unwrap();
        assert_eq!((r.cost_usd, r.max_turns, r.tope), (Some(Num(1.0)), Some(Num(20.0)), Some(Tope::Costo)));
        for e in [Some(ErrorTickets::otro("Consulta cancelada.")), Some(ErrorTickets::otro("timeout")), None] {
            let r = last_run_tras_error(Some(&cortada), e.as_ref(), 40).unwrap();
            assert_eq!((r.num_turns, r.max_turns, r.tope), (Some(Num(40.0)), Some(Num(40.0)), None));
        }
        assert_eq!(last_run_tras_error(None, Some(&ErrorTickets::otro("x")), 40), None);
        let sana = Corrida { num_turns: Some(Num(3.0)), ..Default::default() };
        assert_eq!(last_run_tras_error(Some(&sana), None, 40), Some(sana));
    }

    #[test]
    fn limites_efectivos_toma_los_topes_validos_o_los_de_defecto() {
        assert_eq!(limites_efectivos(Some(10.0), Some(2.5)), LimitesEfectivos { vueltas: 10, costo: Some(2.5) });
        assert_eq!(limites_efectivos(Some(999.0), Some(0.0)), LimitesEfectivos { vueltas: 40, costo: None });
        assert_eq!(limites_efectivos(None, None), LimitesEfectivos { vueltas: 40, costo: None });
    }

    #[test]
    fn texto_flag_viejo_reconoce_el_rechazo_de_max_budget_usd() {
        assert!(texto_flag_viejo("No se pudo leer (salió con código 1: error: unknown option '--max-budget-usd')").unwrap().contains("actualizala o borrá el tope"));
        assert_eq!(texto_flag_viejo("unknown option '--otra'"), None);
        assert_eq!(texto_flag_viejo("Consulta cancelada."), None);
    }

    #[test]
    fn sumar_uso_trata_negativos_e_infinitos_como_0_y_no_desborda() {
        let a = sumar_uso(None, "2026-11-17", "gruv", &UsoCorrida { cost_usd: Some(0.5), num_turns: Some(2.0), duration_ms: Some(10.0), ..Default::default() });
        let b = sumar_uso(Some(&a), "2026-11-17", "gruv", &UsoCorrida { cost_usd: Some(-3.0), num_turns: Some(f64::NAN), duration_ms: Some(f64::INFINITY), ..Default::default() });
        assert_eq!(*b.get("2026-11-17").unwrap().get("gruv").unwrap(), acum(2.0, 0.5, 2.0, 10.0));
        let g1 = sumar_uso(None, "2026-11-17", "gruv", &UsoCorrida { cost_usd: Some(1e308), ..Default::default() });
        let grande = sumar_uso(Some(&g1), "2026-11-17", "gruv", &UsoCorrida { cost_usd: Some(1e308), ..Default::default() });
        assert_eq!(grande.get("2026-11-17").unwrap().get("gruv").unwrap().cost_usd.0, 1e308);
    }
}
