//! Lógica pura de las funciones de `src/main/features`, portadas de a una. Lo que toca el SO, Electron, los diálogos, el
//! store o la red queda afuera: se pasa como dato o como closure.
pub mod broadcast;
pub mod diagnostico;
pub mod chat;
pub mod dictado_core;
pub mod dictado_modelo;
pub mod export_crypto;
pub mod export_import;
pub mod export_import_logic;
pub mod export_regla;
pub mod celular;
pub mod help;
pub mod move_account;
pub mod onboarding;
pub mod partes_dictado;
pub mod permissions;
pub mod permissions_paths;
pub mod poda;
pub mod proceso;
pub mod prs;
pub mod redactar;
pub mod report;
pub mod rendimiento;
pub mod sleep;
pub mod team;
pub mod team_config;
pub mod team_estado;
pub mod team_github;
pub mod templates;
pub mod tickets;
pub mod tray;
pub mod updater;
pub mod updater_notas;
pub mod url_lite;

/// Fecha civil (año, mes 1-12, día) de los días desde 1970-01-01 (algoritmo de Howard Hinnant).
pub(crate) fn civil_de_dias(dias: i64) -> (i64, i64, i64) {
    let z = dias + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// `s.slice(0, n)` en unidades UTF-16; un par de sustitutos partido por la mitad se descarta.
pub(crate) fn cortar_utf16(s: &str, n: usize) -> String {
    let mut u = 0;
    s.chars()
        .take_while(|c| {
            u += c.len_utf16();
            u <= n
        })
        .collect()
}
