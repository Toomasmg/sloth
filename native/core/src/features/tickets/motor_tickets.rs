//! Qué es un motor de tickets: el agente headless que corre cada consulta (Claude Code, Codex). Equivale a
//! src/main/features/tickets/motor-tickets.ts, motor-claude.ts y motores.ts.
use super::conector::ConectorMcp;
use super::descubrir::{build_descubrir_args, descubrir_schema, Formato};
use super::errores::{ErrorTickets, Res};
use super::modelo::Accion;
use super::motor::{build_accion_args, build_detalle_args, build_lista_args, build_personas_args, Limites};
use super::motor_codex::MOTOR_CODEX;
use crate::proveedores::{proveedor_id_de, ProveedorId};
use serde_json::Value;
use std::cell::Cell;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TareaMotor {
    Lista,
    Detalle,
    Accion,
    Descubrir,
    Revisar,
    Personas,
}

pub struct PedidoMotor<'a> {
    pub tarea: TareaMotor,
    pub def: Option<&'a ConectorMcp>,
    pub model: String,
    /// Herramientas o servidores MCP de la cuenta que no son del conector.
    pub ajenos: Vec<String>,
    pub limites: Limites,
    pub accion: Option<Accion>,
    pub schema: Option<Value>,
    /// Nombres de los servidores MCP que tiene la cuenta en su config (Codex). Claude los ignora.
    pub servidores_cuenta: Option<Vec<String>>,
    /// Servidor del conector, sin el prefijo `mcp__` ni el `__` final. Claude lo ignora.
    pub servidor_elegido: Option<String>,
    /// Llamadas MCP que el motor ya vio anunciar (el tope de vueltas emulado de Codex): vive con el pedido.
    pub llamadas: Cell<u32>,
}

impl<'a> PedidoMotor<'a> {
    pub fn nuevo(tarea: TareaMotor, model: &str) -> Self {
        PedidoMotor { tarea, def: None, model: model.into(), ajenos: Vec::new(), limites: Limites::default(), accion: None, schema: None, servidores_cuenta: None, servidor_elegido: None, llamadas: Cell::new(0) }
    }
}

pub trait MotorTickets: Send + Sync {
    fn id(&self) -> ProveedorId;
    /// true: algo clave sin confirmar; la UI lo dice.
    fn experimental(&self) -> bool;
    /// true si el motor entiende el `system/init` con los servidores MCP de la sesión.
    fn lee_init(&self) -> bool;
    /// Argumentos del ejecutable, sin el ejecutable. El prompt va siempre por stdin: nunca en argv.
    fn argv(&self, p: &PedidoMotor) -> Res<Vec<String>>;
    /// Variables que suma el motor al entorno de la cuenta.
    fn env_extra(&self, _p: &PedidoMotor) -> BTreeMap<String, String> {
        BTreeMap::new()
    }
    /// stdout crudo del agente a stdout con la forma del sobre común (`{type:'result',...}`).
    fn normalizar(&self, stdout: &str, p: &PedidoMotor) -> String;
    /// Mira cada línea; devuelve un error para cortar el proceso (tope emulado).
    fn cortar_si(&self, _linea: &str, _p: &PedidoMotor) -> Option<ErrorTickets> {
        None
    }
}

/// Un error común (los propios, como el tope de vueltas, se devuelven tal cual) con el nombre del agente que corrió la consulta.
pub fn etiquetar_agente(e: ErrorTickets, nombre: &str) -> ErrorTickets {
    let prefijo = "Claude no pudo completar la consulta:";
    match e {
        ErrorTickets::Otro(m) if nombre != "Claude" && m.starts_with(prefijo) => ErrorTickets::Otro(format!("{nombre} no pudo completar la consulta:{}", &m[prefijo.len()..])),
        otro => otro,
    }
}

pub fn incompleto() -> ErrorTickets {
    ErrorTickets::otro("Pedido de motor incompleto")
}

pub struct MotorClaude;

pub static MOTOR_CLAUDE: MotorClaude = MotorClaude;

impl MotorTickets for MotorClaude {
    fn id(&self) -> ProveedorId {
        ProveedorId::Claude
    }

    fn experimental(&self) -> bool {
        false
    }

    fn lee_init(&self) -> bool {
        true
    }

    fn argv(&self, p: &PedidoMotor) -> Res<Vec<String>> {
        let model = p.model.as_str();
        match p.tarea {
            // --verbose trae el system/init: de ahí sale qué servidores tenía la sesión de verdad.
            TareaMotor::Lista => {
                let mut a = build_lista_args(p.def.ok_or_else(incompleto)?, model, &p.ajenos, p.limites);
                a.push("--verbose".into());
                Ok(a)
            }
            TareaMotor::Detalle => Ok(build_detalle_args(p.def.ok_or_else(incompleto)?, model, &p.ajenos, p.limites)),
            TareaMotor::Accion => match (p.def, p.accion) {
                (Some(d), Some(a)) => build_accion_args(d, model, a, &p.ajenos, p.limites),
                _ => Err(incompleto()),
            },
            TareaMotor::Personas => Ok(build_personas_args(p.def.ok_or_else(incompleto)?, model, &p.ajenos, p.limites)),
            TareaMotor::Descubrir => Ok(build_descubrir_args(&descubrir_schema(), Formato::Json)),
            TareaMotor::Revisar => Ok(build_descubrir_args(&p.schema.clone().unwrap_or_else(descubrir_schema), Formato::StreamJson)),
        }
    }

    fn normalizar(&self, stdout: &str, _p: &PedidoMotor) -> String {
        stdout.to_string()
    }
}

/// Un proveedor nuevo (Gemini, Copilot) se suma con una entrada acá y la capacidad `ticketsHeadless`.
pub fn motor_por_id(id: ProveedorId) -> Option<&'static dyn MotorTickets> {
    match id {
        ProveedorId::Claude => Some(&MOTOR_CLAUDE),
        ProveedorId::Codex => Some(&MOTOR_CODEX),
        ProveedorId::Copilot => None,
    }
}

pub fn motor_de(cuenta: &Value) -> Option<&'static dyn MotorTickets> {
    proveedor_id_de(cuenta).and_then(motor_por_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::tickets::conectores::conector_por_id;
    use serde_json::json;

    #[test]
    fn etiquetar_agente_cambia_solo_el_nombre_en_errores_comunes() {
        let e = ErrorTickets::otro("Claude no pudo completar la consulta: sin sesión");
        assert_eq!(etiquetar_agente(e.clone(), "Claude"), e);
        assert_eq!(etiquetar_agente(e, "Codex"), ErrorTickets::otro("Codex no pudo completar la consulta: sin sesión"));
        let otro = ErrorTickets::otro("otra cosa");
        assert_eq!(etiquetar_agente(otro.clone(), "Codex"), otro);
        let plazo = ErrorTickets::plazo("X", 3);
        assert_eq!(etiquetar_agente(plazo.clone(), "Codex"), plazo);
    }

    #[test]
    fn motor_de_elige_por_proveedor_y_sin_proveedor_es_claude() {
        assert_eq!(motor_de(&json!({})).map(|m| m.id()), Some(ProveedorId::Claude));
        assert_eq!(motor_de(&json!({ "proveedor": "claude" })).map(|m| m.id()), Some(ProveedorId::Claude));
        assert_eq!(motor_de(&json!({ "proveedor": "codex" })).map(|m| m.id()), Some(ProveedorId::Codex));
        assert!(motor_de(&json!({ "proveedor": "copilot" })).is_none());
        assert!(motor_de(&json!({ "proveedor": "otro" })).is_none());
    }

    #[test]
    fn el_motor_de_claude_arma_lo_mismo_que_el_motor_comun_y_la_lista_suma_verbose() {
        let def = conector_por_id("gruv").unwrap().mcp().unwrap();
        let mut p = PedidoMotor::nuevo(TareaMotor::Lista, "haiku");
        p.def = Some(def);
        let a = MOTOR_CLAUDE.argv(&p).unwrap();
        assert_eq!(a.last().map(String::as_str), Some("--verbose"));
        assert_eq!(&a[..a.len() - 1], build_lista_args(def, "haiku", &[], Limites::default()).as_slice());
        p.tarea = TareaMotor::Detalle;
        assert_eq!(MOTOR_CLAUDE.argv(&p).unwrap(), build_detalle_args(def, "haiku", &[], Limites::default()));
        p.tarea = TareaMotor::Accion;
        assert_eq!(MOTOR_CLAUDE.argv(&p).unwrap_err().mensaje(), "Pedido de motor incompleto");
        p.tarea = TareaMotor::Revisar;
        p.schema = Some(json!({ "type": "object" }));
        let r = MOTOR_CLAUDE.argv(&p).unwrap();
        assert!(r.contains(&"stream-json".to_string()) && r.contains(&"{\"type\":\"object\"}".to_string()));
        assert_eq!(MOTOR_CLAUDE.argv(&PedidoMotor::nuevo(TareaMotor::Lista, "m")).unwrap_err().mensaje(), "Pedido de motor incompleto");
        assert!(!MOTOR_CLAUDE.experimental() && MOTOR_CLAUDE.lee_init());
        assert_eq!(MOTOR_CLAUDE.normalizar("x", &p), "x");
    }
}
