//! Enlaces de carpeta: junctions en Windows (no piden permisos de administrador) y symlinks en el resto.
//! Es lo que hacía `symlinkSync(from, to, 'junction')` de Node.
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Como `path.resolve` + sin barra final + minúsculas: dos formas de escribir la misma carpeta dan el mismo texto.
/// Se saca el prefijo `\??\` o `\\?\` con el que Windows devuelve el destino de un junction.
pub fn normalizar_ruta(ruta: &str) -> String {
    let sin_prefijo = ruta.strip_prefix(r"\??\").or_else(|| ruta.strip_prefix(r"\\?\")).unwrap_or(ruta);
    let unificada = sin_prefijo.replace('/', "\\");
    let (inicio, resto) = match unificada.strip_prefix("\\\\") {
        Some(r) => ("\\\\", r),
        None => ("", unificada.as_str()),
    };
    let mut out = String::from(inicio);
    let mut anterior_barra = false;
    for c in resto.chars() {
        if c == '\\' {
            if !anterior_barra {
                out.push(c);
            }
            anterior_barra = true;
        } else {
            out.push(c);
            anterior_barra = false;
        }
    }
    out.trim_end_matches('\\').to_lowercase()
}

fn absoluta(p: &Path) -> PathBuf {
    std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf())
}

pub fn ruta_normalizada(p: &Path) -> String {
    normalizar_ruta(&absoluta(p).to_string_lossy())
}

/// Si `ruta` es un enlace (junction o symlink) que apunta a `destino`.
pub fn es_enlace_a(ruta: &Path, destino: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(ruta) else { return false };
    if !meta.file_type().is_symlink() {
        return false;
    }
    fs::read_link(ruta).is_ok_and(|a| ruta_normalizada(&a) == ruta_normalizada(destino))
}

/// Un enlace cuyo destino ya no existe: `exists()` dice que no, pero el nombre está ocupado.
pub fn es_enlace_roto(ruta: &Path) -> bool {
    fs::symlink_metadata(ruta).is_ok_and(|m| m.file_type().is_symlink())
}

/// Saca el enlace sin tocar lo que hay del otro lado. Si no existe no hace nada.
pub fn quitar_enlace(ruta: &Path) -> io::Result<()> {
    let r = fs::remove_dir(ruta).or_else(|_| fs::remove_file(ruta));
    match r {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        otro => otro,
    }
}

const TAG_MOUNT_POINT: u32 = 0xA000_0003;
pub const MAX_BUFFER_REPARSE: usize = 16 * 1024;

/// El `REPARSE_DATA_BUFFER` de un junction hacia `destino` (ruta absoluta de Windows, sin prefijo `\\?\`).
pub fn buffer_de_junction(destino: &str) -> io::Result<Vec<u8>> {
    let imprimible: Vec<u16> = destino.replace('/', "\\").trim_end_matches('\\').encode_utf16().collect();
    let mut sustituto: Vec<u16> = r"\??\".encode_utf16().collect();
    sustituto.extend(&imprimible);
    let (sub, imp) = (sustituto.len() * 2, imprimible.len() * 2);
    let datos = 8 + sub + 2 + imp + 2;
    if datos + 8 > MAX_BUFFER_REPARSE {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "la ruta es demasiado larga para un junction"));
    }
    let mut b = Vec::with_capacity(datos + 8);
    b.extend(TAG_MOUNT_POINT.to_le_bytes());
    b.extend((datos as u16).to_le_bytes());
    b.extend(0u16.to_le_bytes());
    b.extend(0u16.to_le_bytes());
    b.extend((sub as u16).to_le_bytes());
    b.extend(((sub + 2) as u16).to_le_bytes());
    b.extend((imp as u16).to_le_bytes());
    for u in sustituto.iter().chain([&0u16]).chain(&imprimible).chain([&0u16]) {
        b.extend(u.to_le_bytes());
    }
    Ok(b)
}

#[cfg(windows)]
pub fn crear_enlace_carpeta(destino: &Path, enlace: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, OPEN_EXISTING};
    use windows_sys::Win32::System::Ioctl::FSCTL_SET_REPARSE_POINT;
    use windows_sys::Win32::System::IO::DeviceIoControl;

    let destino = absoluta(destino);
    let texto = destino.to_string_lossy();
    let buffer = buffer_de_junction(texto.strip_prefix(r"\\?\").unwrap_or(&texto))?;
    fs::create_dir(enlace)?;
    let resultado = (|| {
        let ancha: Vec<u16> = enlace.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: `ancha` termina en cero y vive durante la llamada; los demás punteros son nulos a propósito.
        let h = unsafe {
            CreateFileW(ancha.as_ptr(), GENERIC_WRITE, 0, std::ptr::null(), OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, std::ptr::null_mut())
        };
        if h == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let mut devueltos = 0u32;
        // SAFETY: `h` es un handle válido recién abierto y `buffer` es un REPARSE_DATA_BUFFER completo de ese largo.
        let ok = unsafe {
            DeviceIoControl(h, FSCTL_SET_REPARSE_POINT, buffer.as_ptr().cast(), buffer.len() as u32, std::ptr::null_mut(), 0, &mut devueltos, std::ptr::null_mut())
        };
        let error = (ok == 0).then(io::Error::last_os_error);
        // SAFETY: `h` es nuestro y se cierra una sola vez.
        unsafe { CloseHandle(h) };
        error.map_or(Ok(()), Err)
    })();
    if resultado.is_err() {
        let _ = fs::remove_dir(enlace);
    }
    resultado
}

#[cfg(not(windows))]
pub fn crear_enlace_carpeta(destino: &Path, enlace: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(destino, enlace)
}

#[cfg(test)]
mod tests;
