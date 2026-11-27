//! Dormir espacios inactivos: las decisiones y el archivo `sleep.json`, sin hooks ni terminales. Equivale a las partes
//! puras de src/main/features/sleep.ts; quien lo use aporta el estado de la terminal y los permisos pendientes.
use super::poda::podar_segun_store;
use serde_json::{json, Value};

pub const TICK_MS: f64 = 60_000.0;

/// Un evento de hook de Claude, con lo único que mira esta función.
#[derive(Debug, Clone, PartialEq)]
pub struct EventoHook {
    pub evento: String,
    pub tipo_aviso: Option<String>,
}

pub fn es_aviso_de_inactividad(e: &EventoHook) -> bool {
    e.evento == "Notification" && e.tipo_aviso.as_deref() == Some("idle_prompt")
}

/// ¿Lo escrito tiene texto? Las secuencias de escape (el aviso de foco de la terminal, por ejemplo) no cuentan.
pub fn tiene_texto(d: &str) -> bool {
    let c: Vec<char> = d.chars().collect();
    let sin_control = |ch: char| !matches!(ch, '\u{0}'..='\u{1f}' | '\u{7f}');
    // Como `.` de JS sin flag `u`: no cruza saltos de línea y, con un carácter fuera del plano básico, deja su mitad baja como texto.
    let punto = |ch: char| !matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}');
    let mut i = 0;
    while i < c.len() {
        if c[i] != '\u{1b}' {
            if sin_control(c[i]) {
                return true;
            }
            i += 1;
            continue;
        }
        if c.get(i + 1) == Some(&'[') {
            let mut j = i + 2;
            while c.get(j).is_some_and(|x| ('\u{30}'..='\u{3f}').contains(x)) {
                j += 1;
            }
            while c.get(j).is_some_and(|x| ('\u{20}'..='\u{2f}').contains(x)) {
                j += 1;
            }
            if c.get(j).is_some_and(|x| ('\u{40}'..='\u{7e}').contains(x)) {
                i = j + 1;
                continue;
            }
        }
        if c.get(i + 1) == Some(&'O') {
            if let Some(&x) = c.get(i + 2).filter(|x| punto(**x)) {
                if x.len_utf16() == 2 {
                    return true;
                }
                i += 3;
                continue;
            }
        }
        match c.get(i + 1) {
            Some(&x) if punto(x) => {
                if x.len_utf16() == 2 {
                    return true;
                }
                i += 2;
            }
            _ => i += 1,
        }
    }
    false
}

/// `Number(texto)` de JS para lo que importa acá (la variable de prueba): vacío es 0, no numérico es NaN.
pub fn numero_js(t: &str) -> f64 {
    let t = t.trim_matches(crate::perfiles_core::es_blanco_js);
    if t.is_empty() {
        return 0.0;
    }
    let sin_signo = t.strip_prefix(['+', '-']).unwrap_or(t);
    if sin_signo == "Infinity" {
        return if t.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    let radix = |p: [&str; 2], r: u32| -> Option<f64> {
        let d = t.strip_prefix(p[0]).or_else(|| t.strip_prefix(p[1]))?;
        u64::from_str_radix(d, r).ok().map(|n| n as f64).or(Some(f64::NAN))
    };
    if let Some(n) = radix(["0x", "0X"], 16).or_else(|| radix(["0o", "0O"], 8)).or_else(|| radix(["0b", "0B"], 2)) {
        return n;
    }
    let valido = sin_signo.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-')) && sin_signo.chars().any(|c| c.is_ascii_digit());
    if !valido {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// Milisegundos de inactividad para dormir: `SLOTH_SLEEP_AFTER_MS` (solo para probar) pisa la Configuración.
/// None es «nunca duerme» (0 o no numérico sin minutos configurados).
pub fn espera_para_dormir_ms(env_ms: Option<&str>, minutos: f64) -> Option<f64> {
    let de_env = env_ms.map(numero_js).filter(|n| *n != 0.0 && !n.is_nan());
    let ms = de_env.unwrap_or(minutos * 60_000.0);
    if ms == 0.0 || ms.is_nan() {
        None
    } else {
        Some(ms)
    }
}

pub fn intervalo_del_tick_ms(env_ms: Option<&str>) -> f64 {
    let de_env = env_ms.map(numero_js).filter(|n| *n != 0.0 && !n.is_nan());
    TICK_MS.min(de_env.unwrap_or(TICK_MS))
}

pub struct EntradaDormir<'a> {
    pub corriendo: bool,
    pub borrador: bool,
    pub ultimo_evento: Option<&'a EventoHook>,
    pub permiso_pendiente: bool,
    pub ahora: f64,
    pub ultima_actividad: Option<f64>,
    pub despues_ms: f64,
}

/// ¿Se puede dormir sin perder nada? Solo con Claude quieto en su prompt: tras SessionEnd la shell puede estar
/// corriendo cualquier cosa, y dormir la mataría.
pub fn puede_dormir(e: &EntradaDormir) -> bool {
    if !e.corriendo || e.borrador {
        return false;
    }
    let Some(ev) = e.ultimo_evento else { return false };
    if ev.evento != "Stop" && !es_aviso_de_inactividad(ev) {
        return false;
    }
    if e.permiso_pendiente {
        return false;
    }
    e.ahora - e.ultima_actividad.unwrap_or(e.ahora) >= e.despues_ms
}

#[derive(Debug, PartialEq)]
pub enum AlDespertar {
    /// Ya no estaba dormido: no hay nada que hacer.
    Nada,
    /// La terminal seguía viva: se reconecta tal cual, sin `--continue`.
    QuitarMarca,
    /// La terminal está cerrada: se reabre con `claude --continue`.
    Reabrir,
}

pub fn validar_despertar(id: &Value, existe: impl Fn(&str) -> bool) -> Result<String, String> {
    match id.as_str() {
        Some(s) if existe(s) => Ok(s.to_string()),
        _ => Err("Ese espacio ya no existe.".to_string()),
    }
}

pub fn al_despertar(dormido: bool, terminal_viva: bool) -> AlDespertar {
    match (dormido, terminal_viva) {
        (false, _) => AlDespertar::Nada,
        (true, true) => AlDespertar::QuitarMarca,
        (true, false) => AlDespertar::Reabrir,
    }
}

pub const COMANDO_AL_DESPERTAR: &str = "claude --continue";

/// Los dormidos: su terminal está cerrada y al abrirlos se retoma con --continue. Sobrevive a reiniciar Sloth.
/// El orden de inserción se conserva, como el `Set` del original.
#[derive(Debug, Default, PartialEq)]
pub struct Dormidos {
    ids: Vec<String>,
    /// Con el store incompleto, los que no aparecen se conservan en el archivo en vez de podarse.
    ajenos: Vec<String>,
}

impl Dormidos {
    pub fn desde_archivo(leidos: &[String], existe: impl Fn(&str) -> bool, store_confiable: bool) -> Self {
        let p = podar_segun_store(leidos, |id| existe(id), store_confiable);
        let mut ids: Vec<String> = Vec::new();
        for id in p.vista {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        let ajenos = p.guardar.into_iter().filter(|id| !ids.contains(id)).collect();
        Dormidos { ids, ajenos }
    }

    pub fn ids(&self) -> &[String] {
        &self.ids
    }

    pub fn contiene(&self, id: &str) -> bool {
        self.ids.iter().any(|x| x == id)
    }

    pub fn agregar(&mut self, id: &str) {
        if !self.contiene(id) {
            self.ids.push(id.to_string());
        }
    }

    /// true si estaba.
    pub fn quitar(&mut self, id: &str) -> bool {
        let antes = self.ids.len();
        self.ids.retain(|x| x != id);
        self.ids.len() != antes
    }

    pub fn a_json(&self) -> Value {
        let todos: Vec<&String> = self.ids.iter().chain(self.ajenos.iter()).collect();
        json!({ "asleep": todos })
    }
}

/// Lo que valida la lectura de `sleep.json`: un objeto da sus textos; cualquier otra cosa se rechaza (queda el valor por defecto).
pub fn leer_dormidos(v: &Value) -> Option<Vec<String>> {
    let o = v.as_object()?;
    Some(match o.get("asleep") {
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
        _ => vec![],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(evento: &str, tipo: Option<&str>) -> EventoHook {
        EventoHook { evento: evento.into(), tipo_aviso: tipo.map(str::to_string) }
    }

    #[test]
    fn tiene_texto_ignora_las_secuencias_de_escape() {
        assert!(tiene_texto("hola"));
        assert!(tiene_texto("a\r"));
        assert!(!tiene_texto("\r"));
        assert!(!tiene_texto(""));
        assert!(!tiene_texto("\u{1b}[I"));
        assert!(!tiene_texto("\u{1b}[O"));
        assert!(!tiene_texto("\u{1b}[1;5A"));
        assert!(!tiene_texto("\u{1b}OP"));
        assert!(tiene_texto("\u{1b}[Ihola"));
        assert!(!tiene_texto("\u{1b}[I\u{1b}[O\u{7f}"));
        assert!(tiene_texto("é"));
    }

    #[test]
    fn tiene_texto_con_un_escape_sin_cerrar_se_come_el_siguiente_caracter() {
        assert!(!tiene_texto("\u{1b}x"));
        assert!(!tiene_texto("\u{1b}["));
        assert!(tiene_texto("\u{1b}[\u{1}x"));
        assert!(!tiene_texto("\u{1b}"));
        assert!(!tiene_texto("\u{1b}\n"));
        assert!(tiene_texto("\u{1b}\u{1F600}"));
    }

    #[test]
    fn el_aviso_de_inactividad_es_una_notificacion_idle_prompt() {
        assert!(es_aviso_de_inactividad(&ev("Notification", Some("idle_prompt"))));
        assert!(!es_aviso_de_inactividad(&ev("Notification", Some("permission_prompt"))));
        assert!(!es_aviso_de_inactividad(&ev("Notification", None)));
        assert!(!es_aviso_de_inactividad(&ev("Stop", Some("idle_prompt"))));
    }

    #[test]
    fn numero_js_replica_number() {
        assert_eq!(numero_js(""), 0.0);
        assert_eq!(numero_js("  20000 "), 20000.0);
        assert_eq!(numero_js("1e3"), 1000.0);
        assert_eq!(numero_js("0x10"), 16.0);
        assert_eq!(numero_js("-5"), -5.0);
        assert_eq!(numero_js(".5"), 0.5);
        assert_eq!(numero_js("Infinity"), f64::INFINITY);
        assert!(numero_js("abc").is_nan());
        assert!(numero_js("inf").is_nan());
        assert!(numero_js("nan").is_nan());
        assert!(numero_js("12px").is_nan());
        assert!(numero_js("e").is_nan());
    }

    #[test]
    fn la_variable_de_prueba_pisa_la_configuracion() {
        assert_eq!(espera_para_dormir_ms(Some("20000"), 30.0), Some(20_000.0));
        assert_eq!(espera_para_dormir_ms(None, 30.0), Some(1_800_000.0));
        assert_eq!(espera_para_dormir_ms(Some("basura"), 2.0), Some(120_000.0));
        assert_eq!(espera_para_dormir_ms(Some("0"), 2.0), Some(120_000.0));
        assert_eq!(espera_para_dormir_ms(None, 0.0), None);
        assert_eq!(espera_para_dormir_ms(Some(""), 0.0), None);
    }

    #[test]
    fn el_tick_no_pasa_de_un_minuto() {
        assert_eq!(intervalo_del_tick_ms(None), 60_000.0);
        assert_eq!(intervalo_del_tick_ms(Some("20000")), 20_000.0);
        assert_eq!(intervalo_del_tick_ms(Some("900000")), 60_000.0);
        assert_eq!(intervalo_del_tick_ms(Some("x")), 60_000.0);
    }

    fn base<'a>(e: Option<&'a EventoHook>) -> EntradaDormir<'a> {
        EntradaDormir { corriendo: true, borrador: false, ultimo_evento: e, permiso_pendiente: false, ahora: 10_000.0, ultima_actividad: Some(0.0), despues_ms: 5_000.0 }
    }

    #[test]
    fn duerme_con_claude_quieto_y_tiempo_cumplido() {
        let stop = ev("Stop", None);
        assert!(puede_dormir(&base(Some(&stop))));
        let idle = ev("Notification", Some("idle_prompt"));
        assert!(puede_dormir(&base(Some(&idle))));
    }

    #[test]
    fn no_duerme_si_algo_lo_impide() {
        let stop = ev("Stop", None);
        assert!(!puede_dormir(&EntradaDormir { corriendo: false, ..base(Some(&stop)) }));
        assert!(!puede_dormir(&EntradaDormir { borrador: true, ..base(Some(&stop)) }));
        assert!(!puede_dormir(&EntradaDormir { permiso_pendiente: true, ..base(Some(&stop)) }));
        assert!(!puede_dormir(&base(None)));
        assert!(!puede_dormir(&EntradaDormir { ultima_actividad: Some(8_000.0), ..base(Some(&stop)) }));
        for otro in [ev("SessionEnd", None), ev("PreToolUse", None), ev("Notification", Some("permission_prompt"))] {
            assert!(!puede_dormir(&base(Some(&otro))), "{otro:?}");
        }
    }

    #[test]
    fn sin_actividad_registrada_cuenta_desde_ahora() {
        let stop = ev("Stop", None);
        assert!(!puede_dormir(&EntradaDormir { ultima_actividad: None, ..base(Some(&stop)) }));
        assert!(puede_dormir(&EntradaDormir { ultima_actividad: None, despues_ms: 0.0, ..base(Some(&stop)) }));
        assert!(puede_dormir(&EntradaDormir { ultima_actividad: Some(5_000.0), ..base(Some(&stop)) }));
    }

    #[test]
    fn despertar_valida_el_espacio_y_decide_segun_la_terminal() {
        let existe = |id: &str| id == "ws1";
        assert_eq!(validar_despertar(&json!("ws1"), existe), Ok("ws1".to_string()));
        for malo in [json!("otro"), json!(5), json!(null)] {
            assert_eq!(validar_despertar(&malo, existe), Err("Ese espacio ya no existe.".to_string()));
        }
        assert_eq!(al_despertar(false, true), AlDespertar::Nada);
        assert_eq!(al_despertar(true, true), AlDespertar::QuitarMarca);
        assert_eq!(al_despertar(true, false), AlDespertar::Reabrir);
    }

    #[test]
    fn leer_dormidos_filtra_lo_que_no_es_texto() {
        assert_eq!(leer_dormidos(&json!({ "asleep": ["a", 3, null, "b"] })), Some(vec!["a".into(), "b".into()]));
        assert_eq!(leer_dormidos(&json!({ "asleep": "a" })), Some(vec![]));
        assert_eq!(leer_dormidos(&json!({})), Some(vec![]));
        assert_eq!(leer_dormidos(&json!([1])), None);
        assert_eq!(leer_dormidos(&json!(null)), None);
    }

    #[test]
    fn dormidos_poda_con_store_confiable_y_conserva_los_ajenos_si_no() {
        let leidos: Vec<String> = ["a", "b", "c"].map(String::from).to_vec();
        let d = Dormidos::desde_archivo(&leidos, |id| id != "b", true);
        assert_eq!(d.ids(), ["a", "c"]);
        assert_eq!(d.a_json(), json!({ "asleep": ["a", "c"] }));
        let d = Dormidos::desde_archivo(&leidos, |id| id != "b", false);
        assert_eq!(d.ids(), ["a", "c"]);
        assert_eq!(d.a_json(), json!({ "asleep": ["a", "c", "b"] }));
    }

    #[test]
    fn dormidos_agrega_sin_repetir_y_quita() {
        let mut d = Dormidos::default();
        d.agregar("x");
        d.agregar("x");
        d.agregar("y");
        assert_eq!(d.ids(), ["x", "y"]);
        assert!(d.quitar("x"));
        assert!(!d.quitar("x"));
        assert!(!d.contiene("x") && d.contiene("y"));
    }

    #[test]
    fn dormidos_colapsa_repetidos_del_archivo() {
        let leidos: Vec<String> = ["a", "a", "b"].map(String::from).to_vec();
        let d = Dormidos::desde_archivo(&leidos, |_| true, true);
        assert_eq!(d.ids(), ["a", "b"]);
        assert_eq!(d.a_json(), json!({ "asleep": ["a", "b"] }));
    }
}
