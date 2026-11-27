//! Respaldos de los archivos de configuración de cada cuenta. Equivale a src/main/respaldo.ts.
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

fn con_sufijo(file: &Path, sufijo: &str) -> PathBuf {
    let mut s = file.as_os_str().to_owned();
    s.push(sufijo);
    PathBuf::from(s)
}

/// Se guarda una sola vez: la primera copia es la del usuario, antes de que Sloth la toque.
pub fn respaldar_una_vez(file: &Path) -> std::io::Result<bool> {
    let bak = con_sufijo(file, ".sloth-bak");
    if !file.exists() || bak.exists() {
        return Ok(false);
    }
    let contenido = fs::read(file)?;
    match OpenOptions::new().write(true).create_new(true).open(&bak) {
        Ok(mut f) => f.write_all(&contenido).map(|_| true),
        Err(e) if e.kind() == ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e),
    }
}

/// Antes de reemplazar un archivo sin mezclarlo: si lo que hay no es lo que se va a escribir, alguien lo cambió desde la
/// última vez (a mano o con /config) y esa versión va a `.sloth-prev`.
pub fn respaldar_antes_de_reemplazar(file: &Path, nuevo: &str) -> std::io::Result<bool> {
    if !file.exists() {
        return Ok(false);
    }
    let actual = fs::read(file)?;
    if actual == nuevo.as_bytes() {
        return Ok(false);
    }
    let prev = con_sufijo(file, ".sloth-prev");
    let tmp = con_sufijo(&prev, &format!(".{}.tmp", std::process::id()));
    fs::write(&tmp, actual)?;
    fs::rename(&tmp, &prev)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn dir() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!("sloth-respaldo-rs-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn copia_el_archivo_la_primera_vez_y_no_pisa_el_respaldo_despues() {
        let f = dir().join("settings.json");
        fs::write(&f, "uno").unwrap();
        assert!(respaldar_una_vez(&f).unwrap());
        assert_eq!(fs::read_to_string(con_sufijo(&f, ".sloth-bak")).unwrap(), "uno");
        fs::write(&f, "dos").unwrap();
        assert!(!respaldar_una_vez(&f).unwrap());
        assert_eq!(fs::read_to_string(con_sufijo(&f, ".sloth-bak")).unwrap(), "uno");
    }

    #[test]
    fn sin_archivo_no_hace_nada() {
        let f = dir().join("settings.json");
        assert!(!respaldar_una_vez(&f).unwrap());
        assert!(!con_sufijo(&f, ".sloth-bak").exists());
    }

    #[test]
    fn antes_de_reemplazar_respalda_lo_que_cambio_y_no_lo_que_ya_es_igual() {
        let f = dir().join("settings.json");
        assert!(!respaldar_antes_de_reemplazar(&f, "base").unwrap());
        fs::write(&f, "base").unwrap();
        assert!(!respaldar_antes_de_reemplazar(&f, "base").unwrap());
        assert!(!con_sufijo(&f, ".sloth-prev").exists());
        fs::write(&f, "editado a mano").unwrap();
        assert!(respaldar_antes_de_reemplazar(&f, "base").unwrap());
        assert_eq!(fs::read_to_string(con_sufijo(&f, ".sloth-prev")).unwrap(), "editado a mano");
    }
}
