//! Qué tickets se leen y cuáles se ven cuando el conector filtra por personas: los propios siempre, los de las personas
//! elegidas, los sin asignar si se pide, por estado y dentro de una ventana de días. Equivale a alcance.ts.
use super::conector::{regex_de_persona, ConectorDef};
use super::modelo::{
    categoria_de, dia_de, dias_civiles, fecha_civil, ticket_es_mio, AlcanceLeido, Categoria, ConteosTickets, FiltroVista, PendientesLista, Ticket, TicketsConfig, Yo, PERSONAS_ELEGIDAS_MAX, SIN_ASIGNAR, VENTANA_DEFECTO,
    VENTANA_MAX,
};
use super::texto::{len16, re};
use serde_json::Value;

const DIA_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
const ESTADOS_ELEGIDOS_MAX: usize = 30;
const CLAVE_RE: &str = r"^[a-z0-9_]{1,40}$";

/// Qué se le pide al conector en una consulta: a quién y desde cuándo (YYYY-MM-DD). Los propios van siempre.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlcanceLista {
    pub personas: Vec<String>,
    pub sin_asignar: bool,
    pub hechos: bool,
    pub desde: String,
}

pub fn ventana_valida(v: &Value) -> Option<u32> {
    let n = v.as_f64()?;
    (n.fract() == 0.0 && n >= 1.0 && n <= f64::from(VENTANA_MAX)).then_some(n as u32)
}

/// Los ids de persona elegidos, sin repetir y con la forma que pide el conector; None si algo no sirve.
pub fn personas_validas(def: &ConectorDef, raw: &Value) -> Option<Vec<String>> {
    let xs = raw.as_array().filter(|xs| xs.len() <= PERSONAS_ELEGIDAS_MAX)?;
    let rx = regex_de_persona(def.base());
    let mut out: Vec<String> = Vec::new();
    for p in xs {
        let p = p.as_str().filter(|p| rx.is_match(p))?;
        if !out.iter().any(|x| x == p) {
            out.push(p.to_string());
        }
    }
    Some(out)
}

/// Las claves de estado elegidas, sin repetir y entre las que el conector conoce; None si algo no sirve.
pub fn estados_validos(raw: &Value, conocidas: &[String]) -> Option<Vec<String>> {
    let xs = raw.as_array().filter(|xs| xs.len() <= ESTADOS_ELEGIDOS_MAX)?;
    let mut out: Vec<String> = Vec::new();
    for e in xs {
        let e = e.as_str().filter(|e| re(CLAVE_RE).is_match(e) && conocidas.iter().any(|c| c == e))?;
        if !out.iter().any(|x| x == e) {
            out.push(e.to_string());
        }
    }
    Some(out)
}

/// Sin elegir se ven todos los estados: lo abierto, sea cual sea, y lo terminado dentro de la ventana.
pub fn estados_por_defecto(def: &ConectorDef) -> Vec<String> {
    def.estados().iter().map(|e| e.clave.clone()).collect()
}

/// Lo guardado con los valores por defecto resueltos y lo que ya no sirve (estados que el conector no tiene) descartado.
pub fn filtro_de(c: &TicketsConfig, def: &ConectorDef) -> FiltroVista {
    let conocidas: Vec<&str> = def.estados().iter().map(|e| e.clave.as_str()).collect();
    let elegidos: Vec<String> = c.estados_elegidos.iter().flatten().filter(|e| conocidas.contains(&e.as_str())).cloned().collect();
    FiltroVista {
        personas_elegidas: c.personas_elegidas.clone().unwrap_or_default(),
        incluir_sin_asignar: c.incluir_sin_asignar == Some(true),
        estados_elegidos: if elegidos.is_empty() { estados_por_defecto(def) } else { elegidos },
        ventana_dias: c.ventana_dias.unwrap_or(VENTANA_DEFECTO),
    }
}

fn hay_hechos(f: &FiltroVista, def: &ConectorDef) -> bool {
    f.estados_elegidos.iter().any(|e| categoria_de(Some(e), &[def.estados()]) == Categoria::Hecho)
}

/// Milisegundos desde 1970 de una fecha en los formatos que entiende `Date.parse` y que mandan los conectores: ISO 8601
/// (`2026-11-18`, `2026-11-18T13:57:15.236983+00:00`, con `Z` o con espacio en vez de `T`). Sin desfase se toma UTC.
pub fn parsear_fecha_ms(s: &str) -> Option<f64> {
    let c = re(r"^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$").captures(s)?;
    let num = |i: usize| c.get(i).map(|m| m.as_str().parse::<i64>().unwrap_or(0));
    let (a, mes, dia) = (num(1)?, num(2).unwrap_or(1), num(3).unwrap_or(1));
    let (h, mi, seg) = (num(4).unwrap_or(0), num(5).unwrap_or(0), num(6).unwrap_or(0));
    if !(1..=12).contains(&mes) || dia < 1 || h > 24 || mi > 59 || seg > 59 || (h == 24 && (mi > 0 || seg > 0)) {
        return None;
    }
    let bisiesto = (a % 4 == 0 && a % 100 != 0) || a % 400 == 0;
    let max_dia = match mes {
        2 if bisiesto => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if dia > max_dia {
        return None;
    }
    let frac = c.get(7).map(|m| format!("0.{}", m.as_str()).parse::<f64>().unwrap_or(0.0)).unwrap_or(0.0);
    let ms_frac = (frac * 1000.0).floor();
    let desfase = match c.get(8).map(|m| m.as_str()) {
        None | Some("Z") => 0,
        Some(z) => {
            let signo = if z.starts_with('-') { -1 } else { 1 };
            let d: String = z[1..].chars().filter(char::is_ascii_digit).collect();
            let (zh, zm): (i64, i64) = (d[0..2].parse().unwrap_or(0), d[2..4].parse().unwrap_or(0));
            if zh > 23 || zm > 59 {
                return None;
            }
            signo * (zh * 60 + zm)
        }
    };
    let dias = dias_civiles(a, mes as u32, dia as u32);
    Some(((dias * 86_400 + h * 3600 + mi * 60 + seg - desfase * 60) * 1000) as f64 + ms_frac)
}

/// `new Date(ms).toISOString()`
pub fn iso_de_ms(ms: f64) -> String {
    let t = ms.floor() as i64;
    let (dias, resto) = (t.div_euclid(86_400_000), t.rem_euclid(86_400_000));
    let (a, m, d) = fecha_civil(dias);
    let anio = if (0..=9999).contains(&a) { format!("{a:04}") } else { format!("{}{:06}", if a < 0 { '-' } else { '+' }, a.abs()) };
    format!("{anio}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", resto / 3_600_000, resto / 60_000 % 60, resto / 1000 % 60, resto % 1000)
}

/// ISO normalizado si es una fecha; None si no (el ticket se conserva, sin fecha).
pub fn fecha_valida(v: &Value) -> Option<String> {
    let s = v.as_str().filter(|s| len16(s) <= 40)?;
    let ms = parsear_fecha_ms(s)?;
    (ms.is_finite() && ms > 0.0).then(|| iso_de_ms(ms))
}

pub fn dia_desde(ahora: f64, dias: f64) -> String {
    dia_de((ahora - dias * DIA_MS).floor() as i64)
}

/// Lo que falta leer: todo si no se leyó nada, se sumaron los terminados o se alargó la ventana; si no, las personas que no se leyeron.
pub fn pendientes_de(f: &FiltroVista, leido: Option<&AlcanceLeido>, def: &ConectorDef, me: Option<&Yo>) -> PendientesLista {
    let mi_id = me.and_then(|m| m.id.as_deref());
    let sin_mi = |p: &&String| Some(p.as_str()) != mi_id;
    match (leido, me) {
        (Some(leido), Some(_)) if !(hay_hechos(f, def) && (!leido.hechos || f.ventana_dias > leido.ventana_dias)) => PendientesLista {
            personas: f.personas_elegidas.iter().filter(sin_mi).filter(|p| !leido.personas.contains(p)).cloned().collect(),
            sin_asignar: f.incluir_sin_asignar && !leido.sin_asignar,
            todo: false,
        },
        _ => PendientesLista { personas: f.personas_elegidas.iter().filter(sin_mi).cloned().collect(), sin_asignar: f.incluir_sin_asignar, todo: true },
    }
}

pub fn sin_pendientes(p: &PendientesLista) -> bool {
    !p.todo && p.personas.is_empty() && !p.sin_asignar
}

/// Lo que se pide en la consulta: todo el filtro, o solo lo pendiente.
pub fn alcance_a_pedir(f: &FiltroVista, p: &PendientesLista, def: &ConectorDef, ahora: f64, me: Option<&Yo>, completo: bool) -> AlcanceLista {
    let todo = completo || p.todo;
    let mi_id = me.and_then(|m| m.id.as_deref());
    AlcanceLista {
        personas: if todo { f.personas_elegidas.iter().filter(|x| Some(x.as_str()) != mi_id).cloned().collect() } else { p.personas.clone() },
        sin_asignar: if todo { f.incluir_sin_asignar } else { p.sin_asignar },
        hechos: hay_hechos(f, def),
        desde: dia_desde(ahora, f64::from(f.ventana_dias)),
    }
}

/// Lo leído después de una consulta; `todo` reemplaza lo anterior y si no se suma. La ventana guardada es la más corta que se trajo.
pub fn leido_tras(f: &FiltroVista, previo: Option<&AlcanceLeido>, pedido: &AlcanceLista, todo: bool, def: &ConectorDef, no_leidos: u32) -> AlcanceLeido {
    let desde_cero = todo || previo.is_none();
    let (base_personas, base_sin): (Vec<String>, bool) = match previo {
        Some(p) if !desde_cero => (p.personas.clone(), p.sin_asignar),
        _ => (Vec::new(), false),
    };
    let sin_leer = if desde_cero { 0 } else { previo.and_then(|p| p.no_leidos).unwrap_or(0) } + no_leidos;
    let mut personas = base_personas;
    for p in &pedido.personas {
        if !personas.contains(p) {
            personas.push(p.clone());
        }
    }
    AlcanceLeido {
        personas,
        sin_asignar: base_sin || pedido.sin_asignar,
        hechos: hay_hechos(f, def) && match previo {
            Some(p) if !desde_cero => p.hechos,
            _ => pedido.hechos,
        },
        ventana_dias: match previo {
            Some(p) if !desde_cero => p.ventana_dias.min(f.ventana_dias),
            _ => f.ventana_dias,
        },
        no_leidos: (sin_leer > 0).then_some(sin_leer),
    }
}

/// Los de lo que se volvió a leer se reemplazan; el resto de lo ya leído queda.
pub fn mezclar(previos: &[Ticket], nuevos: &[Ticket], pedido: &AlcanceLista, me: Option<&Yo>, todo: bool) -> Vec<Ticket> {
    if todo {
        return nuevos.to_vec();
    }
    let releidos = |t: &Ticket| {
        ticket_es_mio(me, t) || t.responsable_id.as_ref().is_some_and(|r| pedido.personas.contains(r)) || (pedido.sin_asignar && t.responsable.as_deref().map_or(true, str::is_empty))
    };
    previos.iter().filter(|t| !releidos(t) && !nuevos.iter().any(|n| n.id == t.id)).chain(nuevos.iter()).cloned().collect()
}

fn es_hecho(t: &Ticket, def: &ConectorDef) -> bool {
    categoria_de(t.estado.as_deref(), &[def.estados()]) == Categoria::Hecho
}

fn sin_responsable(t: &Ticket) -> bool {
    t.responsable.as_deref().map_or(true, str::is_empty)
}

/// ¿Es de alguien que se ve? Los propios, los de las personas elegidas y los sin responsable si se pidió.
fn dentro_del_alcance(t: &Ticket, f: &FiltroVista, me: Option<&Yo>) -> bool {
    if ticket_es_mio(me, t) {
        return true;
    }
    if sin_responsable(t) {
        return f.incluir_sin_asignar;
    }
    t.responsable_id.as_ref().is_some_and(|r| f.personas_elegidas.contains(r))
}

/// Lo mío que está abierto no lo oculta nunca el filtro de estados: es lo que la persona tiene que hacer.
fn abierto_mio(t: &Ticket, me: Option<&Yo>, def: &ConectorDef) -> bool {
    ticket_es_mio(me, t) && !es_hecho(t, def)
}

/// Un estado que el conector no conoce no se puede elegir ni descartar en el filtro: pasa.
fn estado_pasa(t: &Ticket, f: &FiltroVista, def: &ConectorDef) -> bool {
    match &t.estado {
        None => true,
        Some(e) => f.estados_elegidos.contains(e) || !def.estados().iter().any(|x| &x.clave == e),
    }
}

/// La ventana corta solo lo terminado: lo abierto, de quien sea, se ve siempre. Sin fecha válida no se descarta.
fn dentro_de_la_ventana(t: &Ticket, f: &FiltroVista, def: &ConectorDef, ahora: f64) -> bool {
    if !es_hecho(t, def) {
        return true;
    }
    match t.fecha.as_deref().and_then(parsear_fecha_ms) {
        None => true,
        Some(ms) => ms >= ahora - f64::from(f.ventana_dias) * DIA_MS,
    }
}

pub fn visibles(tickets: &[Ticket], f: &FiltroVista, me: Option<&Yo>, def: &ConectorDef, ahora: f64) -> Vec<Ticket> {
    tickets
        .iter()
        .filter(|t| dentro_del_alcance(t, f, me) && dentro_de_la_ventana(t, f, def, ahora) && (abierto_mio(t, me, def) || estado_pasa(t, f, def)))
        .cloned()
        .collect()
}

/// Lo que ve Equipo: todo lo abierto de lo elegido, sin pasar por el filtro de estados, y lo terminado dentro de la ventana.
pub fn para_equipo(tickets: &[Ticket], f: &FiltroVista, me: Option<&Yo>, def: &ConectorDef, ahora: f64) -> Vec<Ticket> {
    tickets.iter().filter(|t| dentro_del_alcance(t, f, me) && dentro_de_la_ventana(t, f, def, ahora)).cloned().collect()
}

fn sumar1(o: &mut super::modelo::Ordenado<u32>, k: &str) {
    let n = o.get(k).copied().unwrap_or(0) + 1;
    o.insert(k, n);
}

pub fn conteos(tickets: &[Ticket], f: &FiltroVista, me: Option<&Yo>, def: &ConectorDef, ahora: f64) -> ConteosTickets {
    let mut c = ConteosTickets::default();
    for t in tickets {
        let en_alcance = dentro_del_alcance(t, f, me);
        let en_ventana = dentro_de_la_ventana(t, f, def, ahora);
        let en_estado = abierto_mio(t, me, def) || estado_pasa(t, f, def);
        if en_alcance && en_ventana {
            if let Some(e) = &t.estado {
                sumar1(&mut c.por_estado, e);
            }
        }
        if en_alcance && en_ventana && en_estado {
            let quien = match (ticket_es_mio(me, t), me.and_then(|m| m.id.as_deref()), t.responsable.as_deref()) {
                (true, Some(id), _) if !id.is_empty() => id.to_string(),
                (_, _, Some(r)) if !r.is_empty() => t.responsable_id.clone().unwrap_or_else(|| r.to_string()),
                _ => SIN_ASIGNAR.to_string(),
            };
            sumar1(&mut c.por_persona, &quien);
            if t.fecha.is_none() {
                c.sin_fecha += 1;
            }
        } else {
            c.ocultos += 1;
        }
    }
    c
}

#[cfg(test)]
mod tests {
    use super::super::conectores::conector_por_id;
    use super::*;
    use serde_json::json;

    fn gruv() -> &'static ConectorDef {
        conector_por_id("gruv").unwrap()
    }
    fn ahora() -> f64 {
        parsear_fecha_ms("2026-11-18T15:00:00Z").unwrap()
    }
    fn iso(dias_atras: f64) -> String {
        iso_de_ms(ahora() - dias_atras * DIA_MS)
    }
    fn yo() -> Yo {
        Yo { id: Some("u-yo".into()), nombre: "Tomy".into() }
    }
    fn t(id: &str) -> Ticket {
        let mut x = Ticket::nuevo(id, id);
        x.estado = Some("en_curso".into());
        x
    }
    fn mio(id: &str) -> Ticket {
        let mut x = t(id);
        x.responsable = Some("Tomy".into());
        x.responsable_id = Some("u-yo".into());
        x
    }
    fn de(id: &str, persona: &str) -> Ticket {
        let mut x = t(id);
        x.responsable = Some(persona.into());
        x.responsable_id = Some(format!("u-{persona}"));
        x
    }
    fn est(mut x: Ticket, e: &str) -> Ticket {
        x.estado = Some(e.into());
        x
    }
    fn fec(mut x: Ticket, f: String) -> Ticket {
        x.fecha = Some(f);
        x
    }
    fn cfg(f: impl FnOnce(&mut TicketsConfig)) -> FiltroVista {
        let mut c = TicketsConfig::nueva("gruv");
        f(&mut c);
        filtro_de(&c, gruv())
    }
    fn ids(v: Vec<Ticket>) -> Vec<String> {
        v.into_iter().map(|t| t.id).collect()
    }
    fn elegidas(c: &mut TicketsConfig, xs: &[&str]) {
        c.personas_elegidas = Some(xs.iter().map(|s| s.to_string()).collect());
    }

    #[test]
    fn sin_elegir_se_ven_todos_los_estados_con_4_dias_de_ventana() {
        let todos = vec!["abierto", "en_curso", "bloqueado", "en_revision", "pre_rtd", "en_qa", "rechazado", "cerrado"];
        assert_eq!(estados_por_defecto(gruv()), todos);
        let f = cfg(|_| {});
        assert_eq!(f, FiltroVista { personas_elegidas: vec![], incluir_sin_asignar: false, estados_elegidos: estados_por_defecto(gruv()), ventana_dias: 4 });
        assert_eq!(cfg(|c| {
            c.estados_elegidos = Some(vec!["bloqueado".into(), "zzz".into()]);
            c.ventana_dias = Some(9);
        }).estados_elegidos, vec!["bloqueado"]);
    }

    #[test]
    fn validaciones_ventana_personas_y_estados() {
        assert_eq!(ventana_valida(&json!(4)), Some(4));
        for mal in [json!(0), json!(15), json!(2.5), json!("4"), json!(null)] {
            assert_eq!(ventana_valida(&mal), None);
        }
        assert_eq!(personas_validas(gruv(), &json!(["a-1", "a-1", "b"])), Some(vec!["a-1".into(), "b".into()]));
        assert_eq!(personas_validas(gruv(), &json!("a-1")), None);
        assert_eq!(personas_validas(gruv(), &json!(["a b"])), None);
        assert_eq!(personas_validas(gruv(), &json!(["a\"]; rm -rf"])), None);
        let veintiuna: Vec<String> = (0..21).map(|i| format!("p{i}")).collect();
        assert_eq!(personas_validas(gruv(), &json!(veintiuna)), None);
        let conocidas = vec!["en_qa".to_string(), "cerrado".to_string()];
        assert_eq!(estados_validos(&json!(["en_qa", "en_qa"]), &conocidas), Some(vec!["en_qa".into()]));
        assert_eq!(estados_validos(&json!(["otro"]), &["en_qa".to_string()]), None);
        assert_eq!(estados_validos(&json!([1]), &["en_qa".to_string()]), None);
    }

    #[test]
    fn fecha_valida_normaliza_a_iso_y_descarta_lo_que_no_es_una_fecha() {
        assert_eq!(fecha_valida(&json!("2026-11-18T13:57:15.236983+00:00")).as_deref(), Some("2026-11-18T13:57:15.236Z"));
        assert_eq!(fecha_valida(&json!("2026-11-17T10:00:00-03:00")).as_deref(), Some("2026-11-17T13:00:00.000Z"));
        assert_eq!(fecha_valida(&json!("2026-11-17")).as_deref(), Some("2026-11-17T00:00:00.000Z"));
        for mal in [json!("mañana"), json!(""), json!(12), json!(null), json!("x".repeat(50)), json!("2026-13-01"), json!("2026-02-30"), json!("1970-01-01T00:00:00Z")] {
            assert_eq!(fecha_valida(&mal), None, "{mal}");
        }
        assert_eq!(dia_desde(ahora(), 4.0), "2026-11-14");
    }

    #[test]
    fn lo_abierto_se_ve_siempre_y_lo_terminado_solo_dentro_de_la_ventana() {
        let f = cfg(|c| {
            elegidas(c, &["u-Mateo"]);
            c.estados_elegidos = Some(vec!["en_curso".into(), "cerrado".into()]);
        });
        let ts = vec![
            fec(mio("M-VIEJO"), iso(30.0)),
            fec(est(mio("M-CERRADO-VIEJO"), "cerrado"), iso(10.0)),
            fec(est(mio("M-CERRADO"), "cerrado"), iso(1.0)),
            fec(de("T-VIEJO", "Mateo"), iso(6.0)),
            fec(de("T-NUEVO", "Mateo"), iso(2.0)),
            fec(est(de("T-CERRADO-VIEJO", "Mateo"), "cerrado"), iso(6.0)),
            fec(est(de("T-CERRADO", "Mateo"), "cerrado"), iso(3.0)),
            de("T-SIN-FECHA", "Mateo"),
            fec(de("OTRO", "Lola"), iso(1.0)),
        ];
        assert_eq!(ids(visibles(&ts, &f, Some(&yo()), gruv(), ahora())), vec!["M-VIEJO", "M-CERRADO", "T-VIEJO", "T-NUEVO", "T-CERRADO", "T-SIN-FECHA"]);
    }

    #[test]
    fn sin_asignar_solo_si_se_pide_y_el_estado_filtra_lo_de_los_demas() {
        let ts = vec![fec(t("S"), iso(1.0)), est(de("B", "Mateo"), "bloqueado"), est(de("E", "Mateo"), "en_qa")];
        let base = |c: &mut TicketsConfig| elegidas(c, &["u-Mateo"]);
        assert_eq!(ids(visibles(&ts, &cfg(base), Some(&yo()), gruv(), ahora())), vec!["B", "E"]);
        let con_sin = cfg(|c| {
            base(c);
            c.incluir_sin_asignar = Some(true);
        });
        assert_eq!(ids(visibles(&ts, &con_sin, Some(&yo()), gruv(), ahora())), vec!["S", "B", "E"]);
        let solo_qa = cfg(|c| {
            base(c);
            c.estados_elegidos = Some(vec!["en_qa".into()]);
        });
        assert_eq!(ids(visibles(&ts, &solo_qa, Some(&yo()), gruv(), ahora())), vec!["E"]);
    }

    #[test]
    fn por_defecto_se_ve_todo_lo_abierto() {
        let mut ts: Vec<Ticket> = ["abierto", "en_curso", "bloqueado", "en_revision", "pre_rtd", "en_qa", "rechazado"].iter().map(|e| est(mio(&format!("M-{e}")), e)).collect();
        ts.extend(["abierto", "bloqueado", "rechazado"].iter().map(|e| est(de(&format!("T-{e}"), "Mateo"), e)));
        assert_eq!(visibles(&ts, &cfg(|c| elegidas(c, &["u-Mateo"])), Some(&yo()), gruv(), ahora()).len(), ts.len());
        assert_eq!(visibles(&ts, &cfg(|_| {}), Some(&yo()), gruv(), ahora()).len(), 7);
    }

    #[test]
    fn lo_mio_abierto_no_lo_oculta_nunca_el_filtro_de_estados() {
        let ts = vec![
            est(mio("A"), "abierto"),
            est(mio("B"), "bloqueado"),
            fec(est(mio("C"), "cerrado"), iso(1.0)),
            fec(est(mio("D"), "cerrado"), iso(9.0)),
            est(de("X", "Mateo"), "abierto"),
        ];
        let solo = cfg(|c| {
            elegidas(c, &["u-Mateo"]);
            c.estados_elegidos = Some(vec!["en_curso".into()]);
        });
        assert_eq!(ids(visibles(&ts, &solo, Some(&yo()), gruv(), ahora())), vec!["A", "B"]);
        let con_cerrado = cfg(|c| {
            elegidas(c, &["u-Mateo"]);
            c.estados_elegidos = Some(vec!["en_curso".into(), "cerrado".into()]);
        });
        assert_eq!(ids(visibles(&ts, &con_cerrado, Some(&yo()), gruv(), ahora())), vec!["A", "B", "C"]);
        assert_eq!(conteos(&ts, &solo, Some(&yo()), gruv(), ahora()).por_persona.get("u-yo"), Some(&2));
    }

    #[test]
    fn un_estado_que_el_conector_no_conoce_no_se_puede_descartar() {
        let ts = vec![est(mio("A"), "nuevo"), est(de("B", "Mateo"), "nuevo"), est(de("C", "Mateo"), "en_qa")];
        let f = cfg(|c| {
            elegidas(c, &["u-Mateo"]);
            c.estados_elegidos = Some(vec!["en_curso".into()]);
        });
        assert_eq!(ids(visibles(&ts, &f, Some(&yo()), gruv(), ahora())), vec!["A", "B"]);
    }

    #[test]
    fn equipo_recibe_todo_lo_abierto_de_lo_elegido_sin_el_filtro_de_estados() {
        let ts = vec![
            est(mio("M"), "bloqueado"),
            est(de("T1", "Mateo"), "bloqueado"),
            fec(est(de("T2", "Mateo"), "en_revision"), iso(30.0)),
            fec(est(de("T3", "Mateo"), "cerrado"), iso(1.0)),
            fec(est(de("T4", "Mateo"), "cerrado"), iso(8.0)),
            est(de("OTRO", "Lola"), "bloqueado"),
        ];
        let f = cfg(|c| {
            elegidas(c, &["u-Mateo"]);
            c.estados_elegidos = Some(vec!["en_curso".into()]);
        });
        assert_eq!(ids(para_equipo(&ts, &f, Some(&yo()), gruv(), ahora())), vec!["M", "T1", "T2", "T3"]);
        assert_eq!(ids(visibles(&ts, &f, Some(&yo()), gruv(), ahora())), vec!["M"]);
    }

    #[test]
    fn el_contador_de_lo_mio_cuenta_lo_mismo_que_el_tablero() {
        let ts = vec![est(mio("A"), "abierto"), est(mio("B"), "en_curso"), est(mio("C"), "rechazado")];
        let vistos = visibles(&ts, &cfg(|_| {}), Some(&yo()), gruv(), ahora());
        assert_eq!(vistos.len(), 3);
        assert_eq!(conteos(&ts, &cfg(|_| {}), Some(&yo()), gruv(), ahora()).por_persona.get("u-yo"), Some(&(vistos.len() as u32)));
    }

    #[test]
    fn sin_saber_quien_sos_solo_se_ve_lo_de_las_personas_elegidas() {
        let ts = vec![mio("M"), de("T", "Mateo")];
        assert_eq!(ids(visibles(&ts, &cfg(|c| elegidas(c, &["u-Mateo"])), None, gruv(), ahora())), vec!["T"]);
    }

    #[test]
    fn conteos_por_persona_por_estado_ocultos_y_sin_fecha() {
        let f = cfg(|c| {
            elegidas(c, &["u-Mateo"]);
            c.incluir_sin_asignar = Some(true);
        });
        let ts = vec![
            mio("A"),
            fec(est(mio("B"), "en_qa"), iso(1.0)),
            fec(de("C", "Mateo"), iso(1.0)),
            t("D"),
            de("E", "Lola"),
            fec(est(de("F", "Mateo"), "abierto"), iso(1.0)),
        ];
        let c = conteos(&ts, &f, Some(&yo()), gruv(), ahora());
        assert_eq!(serde_json::to_string(&c.por_persona).unwrap(), r#"{"u-yo":2,"u-Mateo":2,"sin_asignar":1}"#);
        assert_eq!(serde_json::to_string(&c.por_estado).unwrap(), r#"{"en_curso":3,"en_qa":1,"abierto":1}"#);
        assert_eq!((c.ocultos, c.sin_fecha), (1, 2));
    }

    fn leido(personas: &[&str], sin: bool, hechos: bool, ventana: u32) -> AlcanceLeido {
        AlcanceLeido { personas: personas.iter().map(|s| s.to_string()).collect(), sin_asignar: sin, hechos, ventana_dias: ventana, no_leidos: None }
    }

    #[test]
    fn pendientes_todo_la_primera_vez_y_despues_solo_lo_que_se_sumo() {
        let f = cfg(|c| {
            elegidas(c, &["u-Mateo", "u-yo"]);
            c.incluir_sin_asignar = Some(true);
        });
        let yo = yo();
        assert_eq!(pendientes_de(&f, None, gruv(), Some(&yo)), PendientesLista { personas: vec!["u-Mateo".into()], sin_asignar: true, todo: true });
        let l = leido(&[], false, true, 4);
        assert_eq!(pendientes_de(&f, Some(&l), gruv(), Some(&yo)), PendientesLista { personas: vec!["u-Mateo".into()], sin_asignar: true, todo: false });
        assert!(sin_pendientes(&pendientes_de(&cfg(|_| {}), Some(&l), gruv(), Some(&yo))));
        let con_mateo = leido(&["u-Mateo"], false, true, 4);
        assert!(pendientes_de(&cfg(|c| elegidas(c, &["u-Mateo"])), Some(&con_mateo), gruv(), Some(&yo)).personas.is_empty());
        assert!(pendientes_de(&cfg(|c| c.ventana_dias = Some(7)), Some(&l), gruv(), Some(&yo)).todo);
        assert!(!pendientes_de(&cfg(|c| c.ventana_dias = Some(2)), Some(&l), gruv(), Some(&yo)).todo);
        let sin_hechos = leido(&[], false, false, 4);
        assert!(!pendientes_de(&cfg(|c| {
            c.ventana_dias = Some(7);
            c.estados_elegidos = Some(vec!["en_curso".into()]);
        }), Some(&sin_hechos), gruv(), Some(&yo)).todo);
        assert!(pendientes_de(&cfg(|_| {}), Some(&sin_hechos), gruv(), Some(&yo)).todo);
        assert!(!pendientes_de(&cfg(|c| c.estados_elegidos = Some(vec!["en_curso".into()])), Some(&sin_hechos), gruv(), Some(&yo)).todo);
        assert!(pendientes_de(&cfg(|_| {}), Some(&l), gruv(), None).todo);
    }

    #[test]
    fn lo_que_se_pide_solo_lo_pendiente_o_todo_si_se_actualiza() {
        let f = cfg(|c| {
            elegidas(c, &["u-Mateo", "u-Lola"]);
            c.incluir_sin_asignar = Some(true);
        });
        let l = leido(&["u-Mateo"], true, true, 4);
        let yo = yo();
        let p = pendientes_de(&f, Some(&l), gruv(), Some(&yo));
        let desde = "2026-11-14".to_string();
        assert_eq!(alcance_a_pedir(&f, &p, gruv(), ahora(), Some(&yo), false), AlcanceLista { personas: vec!["u-Lola".into()], sin_asignar: false, hechos: true, desde: desde.clone() });
        assert_eq!(alcance_a_pedir(&f, &p, gruv(), ahora(), Some(&yo), true), AlcanceLista { personas: vec!["u-Mateo".into(), "u-Lola".into()], sin_asignar: true, hechos: true, desde });
        let pedido = alcance_a_pedir(&f, &p, gruv(), ahora(), Some(&yo), false);
        assert_eq!(leido_tras(&f, Some(&l), &pedido, false, gruv(), 0), leido(&["u-Mateo", "u-Lola"], true, true, 4));
        let todo = alcance_a_pedir(&f, &p, gruv(), ahora(), Some(&yo), true);
        assert_eq!(leido_tras(&f, Some(&l), &todo, true, gruv(), 0).personas, vec!["u-Mateo", "u-Lola"]);
    }

    #[test]
    fn una_lectura_parcial_con_ventana_mas_corta_guarda_la_ventana_que_trajo() {
        let l = leido(&["u-Mateo"], false, true, 14);
        let yo = yo();
        let corta = cfg(|c| {
            elegidas(c, &["u-Mateo", "u-Lola"]);
            c.ventana_dias = Some(4);
        });
        let pedido = alcance_a_pedir(&corta, &pendientes_de(&corta, Some(&l), gruv(), Some(&yo)), gruv(), ahora(), Some(&yo), false);
        assert_eq!(pedido.personas, vec!["u-Lola"]);
        assert_eq!(pedido.desde, "2026-11-14");
        let tras = leido_tras(&corta, Some(&l), &pedido, false, gruv(), 0);
        assert_eq!(tras.ventana_dias, 4);
        let larga = cfg(|c| {
            elegidas(c, &["u-Mateo", "u-Lola"]);
            c.ventana_dias = Some(14);
        });
        assert!(pendientes_de(&larga, Some(&tras), gruv(), Some(&yo)).todo);
        assert!(!pendientes_de(&corta, Some(&tras), gruv(), Some(&yo)).todo);
    }

    #[test]
    fn lo_que_no_se_trajo_por_un_tope_se_acumula_en_lo_parcial_y_se_reemplaza_al_leer_todo() {
        let f = cfg(|c| elegidas(c, &["u-Mateo"]));
        let pedido = AlcanceLista { personas: vec!["u-Mateo".into()], sin_asignar: false, hechos: true, desde: "2026-11-14".into() };
        let uno = leido_tras(&f, None, &pedido, true, gruv(), 30);
        assert_eq!(uno.no_leidos, Some(30));
        assert_eq!(leido_tras(&f, Some(&uno), &pedido, false, gruv(), 5).no_leidos, Some(35));
        assert_eq!(leido_tras(&f, Some(&uno), &pedido, true, gruv(), 0).no_leidos, None);
        assert_eq!(leido_tras(&f, None, &pedido, true, gruv(), 0).no_leidos, None);
    }

    #[test]
    fn mezclar_lo_relleido_reemplaza_a_lo_viejo_y_lo_demas_queda() {
        let previos = vec![mio("M1"), de("T1", "Mateo"), de("L1", "Lola"), t("S1")];
        let nuevos = vec![mio("M2"), de("L2", "Lola")];
        let pedido = AlcanceLista { personas: vec!["u-Lola".into()], sin_asignar: false, hechos: false, desde: "2026-11-14".into() };
        let yo = yo();
        assert_eq!(ids(mezclar(&previos, &nuevos, &pedido, Some(&yo), false)), vec!["T1", "S1", "M2", "L2"]);
        assert_eq!(ids(mezclar(&previos, &nuevos, &pedido, Some(&yo), true)), vec!["M2", "L2"]);
    }
}
