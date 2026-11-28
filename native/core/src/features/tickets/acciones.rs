//! Lo que llega por IPC para un ticket (id, acción y sus datos) se valida acá, y el resultado de una escritura se aplica acá
//! al estado local. Sin fs ni Claude. Equivale a src/main/features/tickets/acciones.ts.
use super::conector::ConectorDef;
use super::errores::{ErrorTickets, Res};
use super::modelo::{Accion, Criterio, Comentario, Detalle, EstadoBase, Ticket, Via, Yo};
use super::motor::{claves_ocultas, id_valido, AccionInput};
use super::texto::{colapsar, len16};
use serde_json::Value;

pub const MAX_HORAS: f64 = 12.0;
const MOTIVO_HORAS: &str = "Horas cargadas desde Sloth";

pub fn es_accion(v: &Value) -> Option<Accion> {
    v.as_str().and_then(Accion::de_str)
}

pub fn ticket_id(def: &ConectorDef, v: &Value) -> Res<String> {
    id_valido(def, v).ok_or_else(|| ErrorTickets::otro(format!("El ticket tiene que ser tipo {}.", def.base().ejemplo.id)))
}

/// Texto en una línea (los espacios y saltos se colapsan). None si viene vacío.
pub fn texto(v: &Value, max: usize, name: &str) -> Res<Option<String>> {
    match v {
        Value::Null => return Ok(None),
        Value::String(s) if s.is_empty() => return Ok(None),
        Value::String(_) => {}
        _ => return Err(ErrorTickets::otro(format!("{name} no es válido."))),
    }
    let s = colapsar(v.as_str().unwrap_or_default());
    if len16(&s) > max {
        return Err(ErrorTickets::otro(format!("{name} es demasiado largo (máx. {max}).")));
    }
    Ok((!s.is_empty()).then_some(s))
}

pub fn texto_obligatorio(v: &Value, max: usize, name: &str) -> Res<String> {
    texto(v, max, name)?.ok_or_else(|| ErrorTickets::otro(format!("Falta {name}.")))
}

pub struct Contexto {
    /// Las columnas del tablero (sin las de categoría 'hecho').
    pub estados: Vec<EstadoBase>,
    pub me: Option<Yo>,
    /// El último detalle leído del ticket, si se abrió.
    pub detalle: Option<Detalle>,
}

/// Lo que se le pide a Claude para la acción, o None si no hay nada que hacer (ya está en ese estado).
pub fn entrada_de_accion(def: &ConectorDef, a: Accion, t: &Ticket, raw: &Value, c: &Contexto) -> Res<Option<AccionInput>> {
    let nulo = Value::Null;
    let p = raw.as_object();
    let campo = |k: &str| p.and_then(|o| o.get(k)).unwrap_or(&nulo);
    let ticket = t.id.clone();
    let nombre = def.nombre();
    match a {
        Accion::Estado => {
            let estado = campo("estado").as_str().unwrap_or("");
            // Con gh, cerrar es mover a un estado 'hecho': no se esconde como en el tablero.
            let en_flujo = if def.via() == Via::Gh { def.estados().iter().any(|e| e.clave == estado) } else { !claves_ocultas(def).iter().any(|k| k == estado) && c.estados.iter().any(|e| e.clave == estado) };
            if !en_flujo {
                return Err(ErrorTickets::otro(format!("Ese estado no está en el flujo de {nombre}.")));
            }
            if t.estado.as_deref() == Some(estado) {
                return Ok(None);
            }
            let mut i = AccionInput::nuevo(ticket);
            i.estado = Some(estado.to_string());
            Ok(Some(i))
        }
        Accion::Tomar => {
            if let Some(r) = t.responsable.as_deref().filter(|r| !r.is_empty()) {
                return Err(ErrorTickets::otro(format!("Ya lo tiene {r}.")));
            }
            let Some(id) = c.me.as_ref().and_then(|m| m.id.clone()).filter(|i| !i.is_empty()) else {
                return Err(ErrorTickets::otro(format!("Falta tu id de {nombre}: actualizá la lista para cargarlo.")));
            };
            let mut i = AccionInput::nuevo(ticket);
            i.persona = Some(Some(id));
            Ok(Some(i))
        }
        Accion::Soltar => {
            if !super::modelo::ticket_es_mio(c.me.as_ref(), t) {
                return Err(ErrorTickets::otro("Solo podés soltar un ticket que tenés asignado."));
            }
            let mut i = AccionInput::nuevo(ticket);
            i.persona = Some(None);
            Ok(Some(i))
        }
        Accion::Comentar => {
            let mut i = AccionInput::nuevo(ticket);
            i.cuerpo = Some(texto_obligatorio(campo("cuerpo"), 2000, "El comentario")?);
            Ok(Some(i))
        }
        Accion::Criterio => {
            let criterio_id = campo("criterioId").as_str().unwrap_or("");
            if !c.detalle.as_ref().is_some_and(|d| d.criterios.iter().any(|x| x.id.as_deref() == Some(criterio_id))) {
                return Err(ErrorTickets::otro("Abrí el ticket de nuevo: no encuentro ese criterio."));
            }
            let mut i = AccionInput::nuevo(ticket);
            i.criterio_id = Some(criterio_id.to_string());
            i.hecho = Some(campo("hecho") == &Value::Bool(true));
            Ok(Some(i))
        }
        Accion::Horas => {
            let h = campo("horas").as_f64().unwrap_or(f64::NAN);
            let minutos = (h * 60.0).round();
            if !h.is_finite() || h <= 0.0 || h > MAX_HORAS || minutos < 1.0 {
                return Err(ErrorTickets::otro(format!("Las horas tienen que ser más de 0 y hasta {}.", MAX_HORAS)));
            }
            let mut i = AccionInput::nuevo(ticket);
            i.minutos = Some(minutos as i64);
            i.motivo = Some(MOTIVO_HORAS.to_string());
            Ok(Some(i))
        }
    }
}

pub struct Aplicar<'a> {
    pub me: Option<&'a Yo>,
    /// El detalle cargado ahora (puede haberse releído mientras corría la acción).
    pub detalle: Option<&'a mut Detalle>,
    /// El total de minutos que devolvió el conector al sumar horas, si lo dio.
    pub minutos_total: Option<i64>,
    /// ISO, para el comentario recién publicado.
    pub fecha: String,
}

/// Pasa al estado local lo que se pidió, para no tener que releer el ticket.
pub fn aplicar_accion(a: Accion, t: &mut Ticket, i: &AccionInput, c: Aplicar) {
    match a {
        Accion::Estado => t.estado = i.estado.clone(),
        Accion::Tomar => {
            if let Some(me) = c.me {
                t.responsable = Some(me.nombre.clone());
                if let Some(id) = me.id.as_deref().filter(|i| !i.is_empty()) {
                    t.responsable_id = Some(id.to_string());
                }
            }
        }
        Accion::Soltar => {
            t.responsable = None;
            t.responsable_id = None;
        }
        Accion::Comentar => {
            if let (Some(d), Some(cuerpo)) = (c.detalle, i.cuerpo.as_ref().filter(|c| !c.is_empty())) {
                d.comentarios.push(Comentario { autor: c.me.map_or_else(|| "Vos".to_string(), |m| m.nombre.clone()), cuerpo: cuerpo.clone(), fecha: Some(c.fecha) });
            }
        }
        Accion::Criterio => {
            let Some(d) = c.detalle else { return };
            if let Some(crit) = d.criterios.iter_mut().find(|x| x.id.is_some() && x.id == i.criterio_id) {
                crit.hecho = i.hecho == Some(true);
            }
            t.criterios = Some(d.criterios.iter().map(|x| Criterio { id: x.id.clone(), texto: x.texto.clone(), hecho: x.hecho }).collect());
        }
        Accion::Horas => {
            if let (Some(d), Some(m)) = (c.detalle, i.minutos.filter(|m| *m != 0)) {
                d.minutos = Some(c.minutos_total.unwrap_or(d.minutos.unwrap_or(0) + m));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::tickets::conectores::conector_por_id;
    use crate::features::tickets::modelo::{ticket_es_mio, EstadoBase};
    use crate::features::tickets::motor::estados_por_defecto;
    use serde_json::json;

    const CRIT: &str = "0f8c12ab-0000-4000-8000-000000000001";

    fn gruv() -> &'static ConectorDef {
        conector_por_id("gruv").unwrap()
    }

    fn me() -> Yo {
        Yo { id: Some("u-1".into()), nombre: "Tomy".into() }
    }

    fn detalle() -> Detalle {
        Detalle { criterios: vec![Criterio { id: Some(CRIT.into()), texto: "Anda".into(), hecho: false }], comentarios: vec![], minutos: Some(30), descripcion: None }
    }

    fn base(def: &ConectorDef) -> Vec<EstadoBase> {
        estados_por_defecto(def).into_iter().map(|e| EstadoBase { clave: e.clave, nombre: e.nombre }).collect()
    }

    fn ctx() -> Contexto {
        Contexto { estados: base(gruv()), me: Some(me()), detalle: Some(detalle()) }
    }

    fn libre() -> Ticket {
        let mut t = Ticket::nuevo("TCK-1", "Uno");
        t.estado = Some("abierto".into());
        t
    }

    fn mio() -> Ticket {
        let mut t = libre();
        t.responsable = Some("Tomy".into());
        t.responsable_id = Some("u-1".into());
        t
    }

    fn ent(def: &ConectorDef, a: Accion, t: &Ticket, raw: Value, c: &Contexto) -> Res<Option<AccionInput>> {
        entrada_de_accion(def, a, t, &raw, c)
    }

    fn falla<T: std::fmt::Debug>(r: Res<T>, msg: &str) {
        assert_eq!(r.unwrap_err().mensaje(), msg);
    }

    fn con(f: impl FnOnce(&mut AccionInput)) -> Option<AccionInput> {
        let mut i = AccionInput::nuevo("TCK-1");
        f(&mut i);
        Some(i)
    }

    #[test]
    fn es_accion_solo_acepta_las_seis_acciones() {
        for a in ["estado", "tomar", "soltar", "comentar", "criterio", "horas"] {
            assert!(es_accion(&json!(a)).is_some());
        }
        for a in [json!("borrar"), json!(""), json!(3), Value::Null, json!("ESTADO")] {
            assert!(es_accion(&a).is_none(), "{a}");
        }
    }

    #[test]
    fn ticket_id_normaliza_y_explica_con_el_ejemplo_del_conector() {
        assert_eq!(ticket_id(gruv(), &json!(" tck-12 ")).unwrap(), "TCK-12");
        for v in [json!("TCK"), json!(12), Value::Null, json!(format!("{:1<20}", "TCK-1") + "1")] {
            falla(ticket_id(gruv(), &v), "El ticket tiene que ser tipo TCK-1234.");
        }
    }

    #[test]
    fn texto_colapsa_espacios_y_valida_largo_y_tipo() {
        assert_eq!(texto(&json!("  a \n b  "), 10, "X").unwrap().as_deref(), Some("a b"));
        for v in [json!(""), Value::Null, json!("   ")] {
            assert_eq!(texto(&v, 10, "X").unwrap(), None);
        }
        falla(texto(&json!(3), 10, "X"), "X no es válido.");
        falla(texto(&json!("abcdef"), 5, "X"), "X es demasiado largo (máx. 5).");
        falla(texto_obligatorio(&json!("  "), 5, "X"), "Falta X.");
        assert_eq!(texto_obligatorio(&json!(" hola "), 5, "X").unwrap(), "hola");
    }

    #[test]
    fn es_mio_compara_por_id_si_hay_si_no_por_nombre() {
        assert!(ticket_es_mio(Some(&me()), &mio()));
        let mut otro = mio();
        otro.responsable_id = Some("u-2".into());
        assert!(!ticket_es_mio(Some(&me()), &otro));
        let mut por_nombre = libre();
        por_nombre.responsable = Some("Tomy".into());
        assert!(ticket_es_mio(Some(&Yo { id: None, nombre: " tomy ".into() }), &por_nombre));
        assert!(!ticket_es_mio(None, &mio()));
        assert!(!ticket_es_mio(Some(&me()), &libre()));
    }

    #[test]
    fn estado_solo_columnas_del_flujo_y_nunca_las_ocultas() {
        let c = ctx();
        assert_eq!(ent(gruv(), Accion::Estado, &libre(), json!({ "estado": "en_qa" }), &c).unwrap(), con(|i| i.estado = Some("en_qa".into())));
        assert_eq!(ent(gruv(), Accion::Estado, &libre(), json!({ "estado": "abierto" }), &c).unwrap(), None);
        for estado in [json!("cerrado"), json!("inventado"), json!(3), Value::Null] {
            falla(ent(gruv(), Accion::Estado, &libre(), json!({ "estado": estado }), &c), "Ese estado no está en el flujo de Gruv.");
        }
        falla(ent(gruv(), Accion::Estado, &libre(), json!({}), &c), "Ese estado no está en el flujo de Gruv.");
        let mut con_cerrado = ctx();
        con_cerrado.estados.push(EstadoBase { clave: "cerrado".into(), nombre: "Cerrado".into() });
        falla(ent(gruv(), Accion::Estado, &libre(), json!({ "estado": "cerrado" }), &con_cerrado), "Ese estado no está en el flujo de Gruv.");
    }

    #[test]
    fn tomar_y_soltar() {
        let c = ctx();
        assert_eq!(ent(gruv(), Accion::Tomar, &libre(), json!({}), &c).unwrap(), con(|i| i.persona = Some(Some("u-1".into()))));
        let mut ana = libre();
        ana.responsable = Some("Ana".into());
        falla(ent(gruv(), Accion::Tomar, &ana, json!({}), &c), "Ya lo tiene Ana.");
        let sin_id = Contexto { me: Some(Yo { id: None, nombre: "Tomy".into() }), ..ctx() };
        falla(ent(gruv(), Accion::Tomar, &libre(), json!({}), &sin_id), "Falta tu id de Gruv: actualizá la lista para cargarlo.");
        assert_eq!(ent(gruv(), Accion::Soltar, &mio(), Value::Null, &c).unwrap(), con(|i| i.persona = Some(None)));
        falla(ent(gruv(), Accion::Soltar, &ana, json!({}), &c), "Solo podés soltar un ticket que tenés asignado.");
    }

    #[test]
    fn comentar_criterio_y_horas() {
        let c = ctx();
        assert_eq!(ent(gruv(), Accion::Comentar, &libre(), json!({ "cuerpo": " hola\n che " }), &c).unwrap(), con(|i| i.cuerpo = Some("hola che".into())));
        falla(ent(gruv(), Accion::Comentar, &libre(), json!({ "cuerpo": "" }), &c), "Falta El comentario.");
        falla(ent(gruv(), Accion::Comentar, &libre(), json!({ "cuerpo": "x".repeat(2001) }), &c), "El comentario es demasiado largo (máx. 2000).");
        let crit = |hecho: bool| con(|i| {
            i.criterio_id = Some(CRIT.into());
            i.hecho = Some(hecho)
        });
        assert_eq!(ent(gruv(), Accion::Criterio, &libre(), json!({ "criterioId": CRIT, "hecho": true }), &c).unwrap(), crit(true));
        assert_eq!(ent(gruv(), Accion::Criterio, &libre(), json!({ "criterioId": CRIT, "hecho": "si" }), &c).unwrap(), crit(false));
        for cc in [Contexto { detalle: None, ..ctx() }, ctx()] {
            falla(ent(gruv(), Accion::Criterio, &libre(), json!({ "criterioId": "otro" }), &cc), "Abrí el ticket de nuevo: no encuentro ese criterio.");
        }
        assert_eq!(
            ent(gruv(), Accion::Horas, &libre(), json!({ "horas": 1.5 }), &c).unwrap(),
            con(|i| {
                i.minutos = Some(90);
                i.motivo = Some("Horas cargadas desde Sloth".into())
            })
        );
        for horas in [json!(0), json!(-1), json!(MAX_HORAS + 0.1), json!(0.001), Value::Null, json!("2")] {
            falla(ent(gruv(), Accion::Horas, &libre(), json!({ "horas": horas }), &c), "Las horas tienen que ser más de 0 y hasta 12.");
        }
    }

    fn aplicar<'a>(me: Option<&'a Yo>, d: Option<&'a mut Detalle>, total: Option<i64>) -> Aplicar<'a> {
        Aplicar { me, detalle: d, minutos_total: total, fecha: "2026-11-11T12:00:00.000Z".into() }
    }

    #[test]
    fn aplicar_accion_deja_el_ticket_y_el_detalle_como_quedaron_en_el_conector() {
        let mut t = libre();
        let yo = me();
        let mut ie = AccionInput::nuevo("TCK-1");
        ie.estado = Some("en_qa".into());
        aplicar_accion(Accion::Estado, &mut t, &ie, aplicar(None, None, None));
        let mut it = AccionInput::nuevo("TCK-1");
        it.persona = Some(Some("u-1".into()));
        aplicar_accion(Accion::Tomar, &mut t, &it, aplicar(Some(&yo), None, None));
        let mut esperado = libre();
        esperado.estado = Some("en_qa".into());
        esperado.responsable = Some("Tomy".into());
        esperado.responsable_id = Some("u-1".into());
        assert_eq!(t, esperado);
        aplicar_accion(Accion::Soltar, &mut t, &AccionInput::nuevo("TCK-1"), aplicar(None, None, None));
        let mut sin = libre();
        sin.estado = Some("en_qa".into());
        assert_eq!(t, sin);

        let mut d = detalle();
        let mut ic = AccionInput::nuevo("TCK-1");
        ic.cuerpo = Some("hola".into());
        aplicar_accion(Accion::Comentar, &mut t, &ic, aplicar(None, Some(&mut d), None));
        let mut icr = AccionInput::nuevo("TCK-1");
        icr.criterio_id = Some(CRIT.into());
        icr.hecho = Some(true);
        aplicar_accion(Accion::Criterio, &mut t, &icr, aplicar(None, Some(&mut d), None));
        let mut ih = AccionInput::nuevo("TCK-1");
        ih.minutos = Some(60);
        aplicar_accion(Accion::Horas, &mut t, &ih, aplicar(None, Some(&mut d), None));
        assert_eq!(
            d,
            Detalle {
                criterios: vec![Criterio { id: Some(CRIT.into()), texto: "Anda".into(), hecho: true }],
                comentarios: vec![Comentario { autor: "Vos".into(), cuerpo: "hola".into(), fecha: Some("2026-11-11T12:00:00.000Z".into()) }],
                minutos: Some(90),
                descripcion: None
            }
        );
        assert_eq!(t.criterios, Some(d.criterios.clone()));
        aplicar_accion(Accion::Horas, &mut t, &ih, aplicar(None, Some(&mut d), Some(200)));
        assert_eq!(d.minutos, Some(200));
        let mut sin_registro = Detalle { minutos: None, ..detalle() };
        let mut i15 = AccionInput::nuevo("TCK-1");
        i15.minutos = Some(15);
        aplicar_accion(Accion::Horas, &mut t, &i15, aplicar(None, Some(&mut sin_registro), None));
        assert_eq!(sin_registro.minutos, Some(15));
    }

    #[test]
    fn aplicar_accion_sin_detalle_cargado_no_rompe() {
        let mut t = libre();
        let mut i = AccionInput::nuevo("TCK-1");
        i.cuerpo = Some("x".into());
        i.criterio_id = Some(CRIT.into());
        i.minutos = Some(5);
        for a in [Accion::Comentar, Accion::Criterio, Accion::Horas] {
            aplicar_accion(a, &mut t, &i, aplicar(None, None, None));
        }
        assert_eq!(t, libre());
    }

    #[test]
    fn con_gh_cerrar_es_un_estado_valido_con_gruv_cerrado_sigue_fuera_del_tablero() {
        let gh = conector_por_id("github").unwrap();
        let mut issue = Ticket::nuevo("42", "Uno");
        issue.estado = Some("abierto".into());
        let c = Contexto { estados: base(gh), me: Some(me()), detalle: Some(detalle()) };
        assert_eq!(
            entrada_de_accion(gh, Accion::Estado, &issue, &json!({ "estado": "cerrado" }), &c).unwrap(),
            Some({
                let mut i = AccionInput::nuevo("42");
                i.estado = Some("cerrado".into());
                i
            })
        );
        assert_eq!(entrada_de_accion(gh, Accion::Estado, &issue, &json!({ "estado": "abierto" }), &c).unwrap(), None);
        falla(entrada_de_accion(gh, Accion::Estado, &issue, &json!({ "estado": "en_curso" }), &c), "Ese estado no está en el flujo de GitHub Issues.");
        falla(ent(gruv(), Accion::Estado, &libre(), json!({ "estado": "cerrado" }), &ctx()), "Ese estado no está en el flujo de Gruv.");
    }

    #[test]
    fn es_mio_ignora_tildes_y_espacios_de_mas_igual_que_mios_en_la_ui() {
        let mut t = libre();
        t.responsable = Some("Jose Perez ".into());
        assert!(ticket_es_mio(Some(&Yo { id: None, nombre: "José Pérez".into() }), &t));
        t.responsable = Some("José Pérez".into());
        assert!(!ticket_es_mio(Some(&Yo { id: None, nombre: "Jose".into() }), &t));
    }
}
