//! Los errores de tickets. En el TypeScript quien llama los distingue por clase (el plazo vencido no culpa a la
//! conexión, el tope de vueltas conserva lo gastado, etc.); acá, por variante.
use super::modelo::Tope;
use super::uso::UsoCorrida;
use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub struct ConectorInvalido {
    pub ruta: String,
    pub motivo: String,
}

impl fmt::Display for ConectorInvalido {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Conector inválido en {}: {}", self.ruta, self.motivo)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ErrorTickets {
    Conector(ConectorInvalido),
    /// La cuenta no tiene el conector (Claude respondió `faltaConector.clave` o lo dijo en texto).
    ConectorFalta(String),
    /// La herramienta de la acción no está en la sesión de Claude.
    HerramientaFalta(String),
    /// La consulta no terminó en su plazo.
    Plazo { segundos: u64, mensaje: String },
    /// Una corrida cortada por un tope de vueltas o de costo.
    Tope { mensaje: String, tope: Tope, uso: UsoCorrida },
    /// La sesión arrancó con el servidor todavía conectando; un segundo intento suele andar.
    ServidorPendiente { mensaje: String, costo_usd: Option<f64> },
    Otro(String),
}

impl ErrorTickets {
    pub fn otro(m: impl Into<String>) -> Self {
        ErrorTickets::Otro(m.into())
    }

    pub fn plazo(quien: &str, segundos: u64) -> Self {
        ErrorTickets::Plazo { segundos, mensaje: format!("{quien} no respondió en {segundos} s. Probá de nuevo.") }
    }

    pub fn mensaje(&self) -> String {
        self.to_string()
    }
}

impl fmt::Display for ErrorTickets {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ErrorTickets::Conector(c) => c.fmt(f),
            ErrorTickets::ConectorFalta(m) | ErrorTickets::HerramientaFalta(m) | ErrorTickets::Otro(m) => f.write_str(m),
            ErrorTickets::Plazo { mensaje, .. } | ErrorTickets::Tope { mensaje, .. } | ErrorTickets::ServidorPendiente { mensaje, .. } => f.write_str(mensaje),
        }
    }
}

impl std::error::Error for ErrorTickets {}

impl From<ConectorInvalido> for ErrorTickets {
    fn from(c: ConectorInvalido) -> Self {
        ErrorTickets::Conector(c)
    }
}

pub type Res<T> = Result<T, ErrorTickets>;
