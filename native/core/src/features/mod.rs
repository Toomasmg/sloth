//! Lógica pura de las funciones chicas de `src/main/features`. Lo que toca el SO o Electron queda afuera: se pasa como dato o como closure.
pub mod help;
pub mod move_account;
pub mod onboarding;
pub mod poda;
pub mod rendimiento;
pub mod sleep;
pub mod templates;

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
