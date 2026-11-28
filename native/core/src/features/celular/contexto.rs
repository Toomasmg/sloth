//! Lo que la función «celular» necesita de Electron (o de su reemplazo) y del sistema, como trait sin implementar:
//! las cuentas y espacios del store, los agentes, los permisos pendientes, las terminales del daemon, la ventana, las
//! interfaces de red y los avisos a la UI. Equivale a lo que `celular.ts` sacaba de `FeatureContext`. La cáscara
//! (Tauri) lo implementa; los módulos puros de al lado no lo conocen.
use super::core::{AgenteEstado, EspacioEntrada, InterfazRed, PedidoPendiente};
use super::servidor::Decision;
use super::tipos::CelularVista;
use crate::daemon_protocolo::PtyChunk;
use crate::usage::UsoCuenta;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CuentaInfo {
    pub id: String,
    pub label: String,
    /// Carpeta de configuración de la cuenta: ahí deja la statusline `sloth-limites.json`.
    pub config_dir: String,
    /// Si su agente deja los límites en un archivo (Claude); si no (Codex), se leen del propio agente.
    pub limites_por_statusline: bool,
    /// Cómo se llama el agente en los avisos («Claude», «Codex»).
    pub agente: String,
}

/// La foto del buffer de una terminal: lo que ya pasó y hasta qué seq.
#[derive(Debug, Clone, PartialEq)]
pub struct FotoTerminal {
    pub chunks: Vec<PtyChunk>,
    pub hasta: u64,
}

pub trait ContextoCelular: Send + Sync {
    fn log(&self, texto: &str);
    /// Avisa a la UI que cambió la vista del panel «Celular» (`changed`).
    fn emitir_cambio(&self, vista: &CelularVista);
    /// Otros avisos a la UI: `celu-nuevo` e `ip-cambio`.
    fn emitir(&self, evento: &str, datos: Value);

    fn cuentas(&self) -> Vec<CuentaInfo>;
    fn espacios(&self) -> Vec<EspacioEntrada>;
    fn nombre_espacio(&self, id: &str) -> Option<String>;
    fn agentes(&self) -> HashMap<String, AgenteEstado>;
    /// El último escaneo de uso por cuenta (se vuelve a leer con `escanear_uso`).
    fn uso_reciente(&self) -> HashMap<String, UsoCuenta>;
    fn escanear_uso(&self) -> Result<HashMap<String, UsoCuenta>, String>;

    fn pedidos_pendientes(&self) -> Vec<PedidoPendiente>;
    /// Responde un permiso pendiente como si se hubiera tocado el botón en la PC.
    fn responder_permiso(&self, id: &str, decision: Decision);

    fn terminal_viva(&self, id: &str) -> bool;
    /// Corriendo, devuelve el buffer sin arrancar nada: si justo se cerró, falla en vez de abrir otra shell.
    fn foto_terminal(&self, id: &str) -> Result<FotoTerminal, String>;
    /// Escribe en la terminal de un espacio. Lo que llega del celu ya pasó por `sin_automaticas` y por la validación del pedido.
    fn escribir_pty(&self, id: &str, texto: &str);
    fn tam_pty(&self, id: &str) -> Option<(u32, u32)>;

    fn interfaces_de_red(&self) -> Vec<(String, Vec<InterfazRed>)>;
    /// Los PNG de la página: sin archivo, el de 192 px.
    fn leer_icono(&self, archivo: Option<&str>) -> Option<Vec<u8>>;
    /// xterm.js y su css, empaquetados con la app: `(js, css)`.
    fn xterm(&self) -> Option<(String, String)>;

    fn ventana_enfocada(&self) -> bool;
    fn no_molestar(&self) -> bool;
}
