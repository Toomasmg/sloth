//! Sloth sin Node: el núcleo que reemplaza, módulo a módulo, a `src/main` (ver docs/migracion-rust.md).
pub mod agent_machine;
pub mod avisos;
pub mod candado;
pub mod hook_env;
pub mod hooks;
pub mod perfiles_core;
pub mod perfiles_fs;
pub mod persistencia;
pub mod respaldo;
pub mod store;
pub mod store_core;
pub mod versionado;
pub mod window_state_core;
pub mod workspace_patch;
