//! Agentes que Sloth sabe lanzar (Claude Code, Codex, Copilot) y lo que cada uno permite. Equivale a src/shared/proveedores.ts.
//! Las cuentas son objetos JSON tal cual: un `proveedor` que esta versión no conoce no se reemplaza nunca por otro agente.
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProveedorId {
    Claude,
    Codex,
    Copilot,
}

pub const PROVEEDORES_IDS: [ProveedorId; 3] = [ProveedorId::Claude, ProveedorId::Codex, ProveedorId::Copilot];
pub const PROVEEDOR_DEFECTO: ProveedorId = ProveedorId::Claude;
/// Los agentes con un conteo de ticket experimental: la interfaz lo avisa.
pub const TICKETS_EXPERIMENTAL: [ProveedorId; 1] = [ProveedorId::Codex];

impl ProveedorId {
    pub fn como_texto(self) -> &'static str {
        match self {
            ProveedorId::Claude => "claude",
            ProveedorId::Codex => "codex",
            ProveedorId::Copilot => "copilot",
        }
    }

    pub fn desde_texto(s: &str) -> Option<ProveedorId> {
        PROVEEDORES_IDS.into_iter().find(|p| p.como_texto() == s)
    }

    pub fn nombre(self) -> &'static str {
        match self {
            ProveedorId::Claude => "Claude Code",
            ProveedorId::Codex => "Codex",
            ProveedorId::Copilot => "GitHub Copilot",
        }
    }

    pub fn etiqueta(self) -> &'static str {
        match self {
            ProveedorId::Claude => "Claude",
            ProveedorId::Codex => "Codex",
            ProveedorId::Copilot => "Copilot",
        }
    }

    pub fn capacidades(self) -> Capacidades {
        match self {
            ProveedorId::Claude => Capacidades::TODAS,
            ProveedorId::Codex => Capacidades { tickets_headless: true, aviso_turno: true, limites_experimental: true, ..Capacidades::NINGUNA },
            ProveedorId::Copilot => Capacidades::NINGUNA,
        }
    }
}

/// Ausente es el proveedor por defecto (las cuentas de antes). Un valor que esta versión no conoce (versión futura,
/// archivo editado a mano) da None: nunca se lo reemplaza por otro agente.
pub fn proveedor_id_de(cuenta: &Value) -> Option<ProveedorId> {
    match cuenta.get("proveedor") {
        None => Some(PROVEEDOR_DEFECTO),
        Some(v) => v.as_str().and_then(ProveedorId::desde_texto),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capacidades {
    pub hooks: bool,
    pub statusline: bool,
    pub setup_compartido: bool,
    pub tickets: bool,
    pub tickets_headless: bool,
    pub chat_mcp: bool,
    pub historial: bool,
    pub mover_cuenta: bool,
    pub dormir: bool,
    pub uso: bool,
    pub override_claude: bool,
    pub aviso_turno: bool,
    pub limites_experimental: bool,
}

impl Capacidades {
    const TODAS: Capacidades = Capacidades {
        hooks: true,
        statusline: true,
        setup_compartido: true,
        tickets: true,
        tickets_headless: true,
        chat_mcp: true,
        historial: true,
        mover_cuenta: true,
        dormir: true,
        uso: true,
        override_claude: true,
        aviso_turno: true,
        limites_experimental: false,
    };
    const NINGUNA: Capacidades = Capacidades {
        hooks: false,
        statusline: false,
        setup_compartido: false,
        tickets: false,
        tickets_headless: false,
        chat_mcp: false,
        historial: false,
        mover_cuenta: false,
        dormir: false,
        uso: false,
        override_claude: false,
        aviso_turno: false,
        limites_experimental: false,
    };

    /// El valor de una capacidad por su nombre (el mismo que en la interfaz).
    pub fn de(&self, k: &str) -> Option<bool> {
        Some(match k {
            "hooks" => self.hooks,
            "statusline" => self.statusline,
            "setupCompartido" => self.setup_compartido,
            "tickets" => self.tickets,
            "ticketsHeadless" => self.tickets_headless,
            "chatMcp" => self.chat_mcp,
            "historial" => self.historial,
            "moverCuenta" => self.mover_cuenta,
            "dormir" => self.dormir,
            "uso" => self.uso,
            "overrideClaude" => self.override_claude,
            "avisoTurno" => self.aviso_turno,
            "limitesExperimental" => self.limites_experimental,
            _ => return None,
        })
    }
}

pub fn nombre_proveedor(cuenta: &Value) -> &'static str {
    proveedor_id_de(cuenta).map_or("Agente desconocido", ProveedorId::nombre)
}

/// Nombre corto del agente de la cuenta para un texto; «el agente» si no se conoce.
pub fn agente_de(cuenta: &Value) -> &'static str {
    proveedor_id_de(cuenta).map_or("el agente", ProveedorId::etiqueta)
}

/// «Claude» si todas son de Claude o no hay cuentas (el texto de siempre); el nombre si todas son del mismo agente; None si hay mezcla.
pub fn agente_comun(cuentas: &[Value]) -> Option<&'static str> {
    let mut nombres: Vec<&str> = cuentas.iter().map(agente_de).collect();
    nombres.sort_unstable();
    nombres.dedup();
    match nombres.len() {
        0 => Some(ProveedorId::Claude.etiqueta()),
        1 => Some(nombres[0]),
        _ => None,
    }
}

/// None si el agente de la cuenta no se conoce: quien lo use decide qué hacer (en general, no lanzar nada).
pub fn capacidades_de(cuenta: &Value) -> Option<Capacidades> {
    proveedor_id_de(cuenta).map(ProveedorId::capacidades)
}

/// hooks, statusline, setupCompartido, overrideClaude y uso son permanentes; tickets, historial y moverCuenta (y chatMcp,
/// dormir) se retoman más adelante.
fn motivo_especifico(id: ProveedorId, k: &str) -> Option<&'static str> {
    match (id, k) {
        (ProveedorId::Codex, "hooks") => Some("Con Codex no hay avisos de permisos desde el celu: Codex todavía no se los manda a Sloth."),
        (ProveedorId::Codex, "tickets") => Some("Con Codex las consultas de tickets andan (experimental), pero el trabajo por ticket todavía solo corre con Claude Code."),
        (ProveedorId::Codex, "historial") => Some("El historial todavía solo lee las conversaciones de Claude Code."),
        (ProveedorId::Codex, "moverCuenta") => Some("Mover espacios todavía solo anda entre cuentas de Claude Code."),
        (ProveedorId::Codex, "statusline") => Some("Codex no ejecuta un comando externo para la barra de estado: Sloth no puede leer sus límites por ahí."),
        (ProveedorId::Codex, "setupCompartido") => Some("El setup compartido es el de tu carpeta de Claude Code: no aplica a Codex."),
        (ProveedorId::Codex, "uso") => Some("El conteo de tokens todavía solo lee las conversaciones de Claude Code."),
        (ProveedorId::Codex, "overrideClaude") => Some("Estos reemplazos de comando son de Claude Code."),
        (ProveedorId::Copilot, "hooks") => Some("Con Copilot no hay avisos de permisos desde el celu todavía."),
        (ProveedorId::Copilot, "tickets") => Some("Los tickets todavía solo corren con Claude Code: ni las consultas ni el trabajo por ticket usan cuentas de Copilot."),
        (ProveedorId::Copilot, "ticketsHeadless") => Some("Las consultas de tickets todavía solo corren con Claude Code o Codex: no usan cuentas de Copilot."),
        (ProveedorId::Copilot, "historial") => Some("El historial todavía solo lee las conversaciones de Claude Code."),
        (ProveedorId::Copilot, "moverCuenta") => Some("Mover espacios todavía solo anda entre cuentas de Claude Code."),
        (ProveedorId::Copilot, "uso") => Some("Copilot no informa cuánto te queda: Sloth no puede mostrar el uso."),
        (ProveedorId::Copilot, "statusline") => Some("Copilot no ejecuta un comando externo para la barra de estado."),
        (ProveedorId::Copilot, "setupCompartido") => Some("El setup compartido es el de tu carpeta de Claude Code: no aplica a Copilot."),
        (ProveedorId::Copilot, "overrideClaude") => Some("Estos reemplazos de comando son de Claude Code."),
        _ => None,
    }
}

/// Por qué la cuenta no puede usar esa función, o None si puede.
pub fn motivo_sin_capacidad(cuenta: &Value, k: &str) -> Option<String> {
    let Some(id) = proveedor_id_de(cuenta) else { return Some("Esta cuenta es de un agente que esta versión de Sloth no conoce; actualizá Sloth.".into()) };
    if id.capacidades().de(k) == Some(true) {
        return None;
    }
    Some(motivo_especifico(id, k).map_or_else(|| format!("{} todavía no soporta esto en Sloth.", id.nombre()), str::to_owned))
}

/// La cuenta sugerida: con sesión y la que menos usó en las últimas 5 h. Una cuenta sin dato de uso (agente sin esa
/// capacidad, o desconocido) cuenta 0 y ganaría siempre: solo se elige si no hay otra.
pub fn cuenta_sugerida(cuentas: &[Value], con_sesion: &dyn Fn(&str) -> bool, usado_5h: &dyn Fn(&str) -> f64) -> Option<String> {
    let id = |c: &Value| c.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    let con_uso = |c: &&Value| capacidades_de(c).is_some_and(|k| k.uso);
    let logueadas: Vec<&Value> = cuentas.iter().filter(|c| con_sesion(&id(c))).collect();
    let todas: Vec<&Value> = cuentas.iter().collect();
    let candidatos = [
        logueadas.iter().copied().filter(con_uso).collect::<Vec<_>>(),
        todas.iter().copied().filter(con_uso).collect(),
        logueadas,
        todas,
    ];
    let mut pool = candidatos.into_iter().find(|l| !l.is_empty())?;
    pool.sort_by(|a, b| usado_5h(&id(a)).partial_cmp(&usado_5h(&id(b))).unwrap_or(std::cmp::Ordering::Equal));
    pool.first().map(|c| id(c))
}

/// Con un login compartido del sistema, dos cuentas de Copilot se pisarían entre sí.
fn max_cuentas(id: ProveedorId) -> Option<usize> {
    (id == ProveedorId::Copilot).then_some(1)
}

/// Por qué no se puede sumar otra cuenta de ese agente, o None si se puede. El login del sistema es el mismo para todos
/// los perfiles: `en_otros_perfiles` son las cuentas de ese agente que ya hay en los demás.
pub fn motivo_no_agregar(cuentas: &[Value], id: ProveedorId, en_otros_perfiles: usize) -> Option<String> {
    let tope = max_cuentas(id)?;
    let aca = cuentas.iter().filter(|c| proveedor_id_de(c) == Some(id)).count();
    if aca >= tope {
        return Some(format!("Ya tenés una cuenta de {}: su login es del sistema y dos cuentas se pisarían entre sí.", id.nombre()));
    }
    (aca + en_otros_perfiles >= tope).then(|| format!("Ya tenés una cuenta de {} en otro perfil: su login es del sistema y es el mismo en todos los perfiles.", id.nombre()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use ProveedorId::*;

    #[test]
    fn proveedor_id_de_ausente_es_claude_y_desconocido_no_es_ninguno() {
        assert_eq!(proveedor_id_de(&json!({})), Some(Claude));
        assert_eq!(proveedor_id_de(&json!({ "proveedor": "claude" })), Some(Claude));
        assert_eq!(proveedor_id_de(&json!({ "proveedor": "codex" })), Some(Codex));
        for raro in [json!("otro-agente"), json!(5), json!("__proto__"), json!(null), json!("toString")] {
            assert_eq!(proveedor_id_de(&json!({ "proveedor": raro })), None);
        }
    }

    #[test]
    fn capacidades_claude_las_tiene_todas_y_codex_solo_algunas() {
        assert_eq!(PROVEEDORES_IDS.map(ProveedorId::como_texto), ["claude", "codex", "copilot"]);
        for k in ["hooks", "statusline", "setupCompartido", "tickets", "chatMcp", "historial", "moverCuenta", "dormir", "uso", "overrideClaude"] {
            assert_eq!(Claude.capacidades().de(k), Some(true), "claude {k}");
            assert_eq!(Codex.capacidades().de(k), Some(false), "codex {k}");
        }
        assert_eq!(capacidades_de(&json!({})).unwrap().hooks, true);
        assert_eq!(capacidades_de(&json!({ "proveedor": "codex" })).unwrap().hooks, false);
        assert_eq!(capacidades_de(&json!({ "proveedor": "otro-agente" })), None);
        assert_eq!(Claude.capacidades().de("inexistente"), None);
    }

    #[test]
    fn nombre_y_motivos() {
        assert_eq!(nombre_proveedor(&json!({})), "Claude Code");
        assert_eq!(nombre_proveedor(&json!({ "proveedor": "codex" })), "Codex");
        assert_eq!(nombre_proveedor(&json!({ "proveedor": "otro-agente" })), "Agente desconocido");
        let codex = json!({ "proveedor": "codex" });
        assert_eq!(motivo_sin_capacidad(&json!({}), "tickets"), None);
        assert!(motivo_sin_capacidad(&codex, "tickets").unwrap().contains("trabajo por ticket todavía solo corre con Claude Code"));
        assert!(motivo_sin_capacidad(&codex, "historial").unwrap().contains("historial"));
        assert!(motivo_sin_capacidad(&codex, "moverCuenta").unwrap().contains("Mover espacios"));
        assert_eq!(motivo_sin_capacidad(&codex, "dormir").as_deref(), Some("Codex todavía no soporta esto en Sloth."));
        assert!(motivo_sin_capacidad(&codex, "hooks").unwrap().contains("avisos de permisos desde el celu"));
        assert!(motivo_sin_capacidad(&json!({ "proveedor": "otro-agente" }), "tickets").unwrap().contains("actualizá Sloth"));
    }

    fn uso<'a>(m: &'a [(&'a str, f64)]) -> impl Fn(&str) -> f64 + 'a {
        move |id| m.iter().find(|(i, _)| *i == id).map_or(0.0, |(_, v)| *v)
    }

    #[test]
    fn cuenta_sugerida_una_de_codex_no_gana_por_tener_menos_uso() {
        let cuentas = [json!({ "id": "cx", "proveedor": "codex" }), json!({ "id": "a" }), json!({ "id": "b", "proveedor": "claude" })];
        let m = [("cx", 0.0), ("a", 500.0), ("b", 100.0)];
        assert_eq!(cuenta_sugerida(&cuentas, &|_| true, &uso(&m)).as_deref(), Some("b"));
        assert_eq!(cuenta_sugerida(&cuentas, &|id| id != "b", &uso(&m)).as_deref(), Some("a"));
    }

    #[test]
    fn cuenta_sugerida_sin_sesion_en_claude_se_prefiere_una_claude_antes_que_codex_con_sesion() {
        let cuentas = [json!({ "id": "cx", "proveedor": "codex" }), json!({ "id": "a" })];
        assert_eq!(cuenta_sugerida(&cuentas, &|id| id == "cx", &|_| 0.0).as_deref(), Some("a"));
    }

    #[test]
    fn cuenta_sugerida_solo_codex_o_desconocido_se_usa_igual_y_sin_cuentas_no_hay_nada() {
        assert_eq!(cuenta_sugerida(&[json!({ "id": "cx", "proveedor": "codex" })], &|_| true, &|_| 0.0).as_deref(), Some("cx"));
        assert_eq!(cuenta_sugerida(&[json!({ "id": "x", "proveedor": "otro-agente" })], &|_| false, &|_| 0.0).as_deref(), Some("x"));
        assert_eq!(cuenta_sugerida(&[], &|_| true, &|_| 0.0), None);
    }

    #[test]
    fn cuenta_sugerida_solo_claude_con_sesion_y_menos_uso_o_todas_si_ninguna_tiene() {
        let cuentas = [json!({ "id": "a" }), json!({ "id": "b" }), json!({ "id": "c" })];
        let m = [("a", 30.0), ("b", 10.0), ("c", 5.0)];
        assert_eq!(cuenta_sugerida(&cuentas, &|id| id != "c", &uso(&m)).as_deref(), Some("b"));
        assert_eq!(cuenta_sugerida(&cuentas, &|_| false, &uso(&m)).as_deref(), Some("c"));
    }

    #[test]
    fn aviso_de_turno_y_limites_experimentales_por_agente() {
        assert_eq!((Claude.capacidades().aviso_turno, Claude.capacidades().limites_experimental), (true, false));
        assert_eq!((Codex.capacidades().aviso_turno, Codex.capacidades().limites_experimental), (true, true));
        assert_eq!(motivo_sin_capacidad(&json!({ "proveedor": "codex" }), "limitesExperimental"), None);
        assert_eq!(capacidades_de(&json!({ "proveedor": "zzz" })), None);
    }

    #[test]
    fn agente_de_y_agente_comun() {
        assert_eq!(agente_de(&json!({})), "Claude");
        assert_eq!(agente_de(&json!({ "proveedor": "codex" })), "Codex");
        assert_eq!(agente_de(&json!({ "proveedor": "zzz" })), "el agente");
        assert_eq!(agente_comun(&[]), Some("Claude"));
        assert_eq!(agente_comun(&[json!({}), json!({ "proveedor": "claude" })]), Some("Claude"));
        assert_eq!(agente_comun(&[json!({ "proveedor": "codex" }), json!({ "proveedor": "codex" })]), Some("Codex"));
        assert_eq!(agente_comun(&[json!({}), json!({ "proveedor": "codex" })]), None);
        assert_eq!(agente_comun(&[json!({}), json!({ "proveedor": "zzz" })]), None);
        assert_eq!(agente_de(&json!({ "proveedor": "copilot" })), "Copilot");
        assert_eq!(agente_comun(&[json!({ "proveedor": "copilot" }), json!({ "proveedor": "codex" })]), None);
    }

    #[test]
    fn motivos_permanentes_de_codex_no_son_el_generico() {
        for k in ["statusline", "setupCompartido", "uso", "overrideClaude"] {
            assert_ne!(motivo_sin_capacidad(&json!({ "proveedor": "codex" }), k).as_deref(), Some("Codex todavía no soporta esto en Sloth."), "{k}");
            assert_eq!(motivo_sin_capacidad(&json!({}), k), None, "{k}");
        }
    }

    #[test]
    fn copilot_sin_capacidades_con_motivos_propios() {
        let c = json!({ "proveedor": "copilot" });
        assert_eq!(proveedor_id_de(&c), Some(Copilot));
        assert_eq!(nombre_proveedor(&c), "GitHub Copilot");
        assert_eq!(capacidades_de(&c).unwrap(), Capacidades::NINGUNA);
        assert!(motivo_sin_capacidad(&c, "tickets").unwrap().contains("Copilot"));
        assert!(motivo_sin_capacidad(&c, "uso").unwrap().contains("no informa cuánto te queda"));
        assert_eq!(motivo_sin_capacidad(&c, "dormir").as_deref(), Some("GitHub Copilot todavía no soporta esto en Sloth."));
    }

    #[test]
    fn motivo_no_agregar_claude_sin_tope_copilot_una_sola_y_los_desconocidos_no_cuentan() {
        assert_eq!(motivo_no_agregar(&[json!({}), json!({}), json!({})], Claude, 0), None);
        assert_eq!(motivo_no_agregar(&[json!({}), json!({ "proveedor": "codex" })], Copilot, 0), None);
        assert_eq!(motivo_no_agregar(&[json!({ "proveedor": "otro-agente" })], Copilot, 0), None);
        assert!(motivo_no_agregar(&[json!({ "proveedor": "copilot" })], Copilot, 0).unwrap().starts_with("Ya tenés una cuenta de GitHub Copilot: su login es del sistema"));
        assert!(motivo_no_agregar(&[], Copilot, 1).unwrap().contains("en otro perfil"));
    }

    #[test]
    fn tickets_codex_consulta_pero_no_trabaja_por_ticket_y_copilot_nada() {
        assert!(Codex.capacidades().tickets_headless && !Codex.capacidades().tickets);
        assert!(!Copilot.capacidades().tickets_headless);
        assert!(TICKETS_EXPERIMENTAL.contains(&Codex) && !TICKETS_EXPERIMENTAL.contains(&Claude));
        assert!(motivo_sin_capacidad(&json!({ "proveedor": "copilot" }), "ticketsHeadless").unwrap().contains("Copilot"));
        assert!(motivo_sin_capacidad(&json!({ "proveedor": "futuro" }), "ticketsHeadless").unwrap().contains("actualizá Sloth"));
    }
}
