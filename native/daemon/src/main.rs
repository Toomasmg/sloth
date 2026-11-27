//! Daemon de terminales de Sloth en Rust. Mismo protocolo (v2) que src/daemon/index.ts: el cliente
//! de la app no distingue cuál de los dos le contesta. Las terminales sobreviven al cierre de la app.
//!
//!   sloth-daemon --user-data <dir> --pipe <nombre del pipe> [--app-version x]
#![cfg_attr(windows, windows_subsystem = "windows")]

mod auth;
mod buffer;
mod core;
mod http;
mod log;
mod utf8;

#[cfg(windows)]
mod server;

#[cfg(windows)]
fn main() {
    server::run();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("sloth-daemon solo funciona en Windows");
    std::process::exit(1);
}
