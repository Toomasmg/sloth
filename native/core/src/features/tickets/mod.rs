//! La feature «tickets»: consultar y escribir tickets de un sistema externo (Jira, Gruv, GitHub…) con `claude -p`,
//! `codex exec` o `gh`. Equivale a src/main/features/tickets/. Lo puro (prompts, lectura de lo que devuelve el agente,
//! validaciones, formatos de userData) está en módulos que se prueban solos; correr el agente es el trait `Ejecutor`.
pub mod conector;
pub mod conectores;
pub mod errores;
pub mod modelo;
pub mod texto;
pub mod uso;
pub mod alcance;
pub mod motor;
#[cfg(test)]
mod motor_tests;
pub mod estado;
pub mod almacen;
#[cfg(test)]
mod estado_tests;
pub mod cuentas;
pub mod descubrir;
#[cfg(test)]
mod cuentas_tests;
pub mod probar;
#[cfg(test)]
mod probar_tests;
pub mod claude_run;
pub mod gh;
pub mod codex_config;
pub mod codex_salida;
pub mod motor_tickets;
pub mod motor_codex;
pub mod eleccion;
pub mod reintento;
pub mod concurrencia;
pub mod lanzamiento;
pub mod propios;
#[cfg(test)]
mod propios_tests;
pub mod acciones;
pub mod archivos;
