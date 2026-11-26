use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;

pub struct Log {
    file: Option<PathBuf>,
    writes: AtomicU64,
}

impl Log {
    pub fn new(file: Option<PathBuf>) -> Self {
        Log { file, writes: AtomicU64::new(0) }
    }

    pub fn write(&self, msg: &str) {
        let Some(file) = &self.file else { return };
        if self.writes.fetch_add(1, Ordering::Relaxed) % 200 == 0 {
            if let Ok(m) = fs::metadata(file) {
                if m.len() > LOG_MAX_BYTES {
                    let mut vieja = file.clone().into_os_string();
                    vieja.push(".1");
                    let _ = fs::rename(file, vieja);
                }
            }
        }
        let linea = format!("{} [{}] {}\n", iso(SystemTime::now()), std::process::id(), msg);
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(file) {
            let _ = f.write_all(linea.as_bytes());
        }
    }
}

/// AAAA-MM-DDTHH:MM:SS.mmmZ, igual que `toISOString()`.
pub fn iso(t: SystemTime) -> String {
    let d = t.duration_since(UNIX_EPOCH).unwrap_or_default();
    let (secs, ms) = (d.as_secs() as i64, d.subsec_millis());
    let (dias, resto) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = dias + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let dia = doy - (153 * mp + 2) / 5 + 1;
    let mes = if mp < 10 { mp + 3 } else { mp - 9 };
    let anio = yoe + era * 400 + i64::from(mes <= 2);
    format!(
        "{anio:04}-{mes:02}-{dia:02}T{:02}:{:02}:{:02}.{ms:03}Z",
        resto / 3600,
        resto % 3600 / 60,
        resto % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn fechas_conocidas() {
        assert_eq!(iso(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(UNIX_EPOCH + Duration::from_millis(1_709_164_800_123)), "2024-02-29T00:00:00.123Z");
        assert_eq!(iso(UNIX_EPOCH + Duration::from_secs(1_796_000_000)), "2026-11-30T00:53:20.000Z");
    }
}
