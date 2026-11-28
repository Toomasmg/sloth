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
