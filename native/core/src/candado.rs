//! Candado de archivo entre procesos. Equivale a src/main/candado-archivo.ts: crea `ruta` con «crear nuevo» y la deja
//! hasta liberar. Si ya existe y su dueño sigue vivo y reciente, no se toma; si quedó de un proceso que murió, sí.
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Un candado más viejo que esto se da por abandonado aunque el pid siga existiendo (el pid se puede reusar).
const VENCIMIENTO_MS: u64 = 10 * 60_000;
/// Entre crear el archivo y escribirle el pid hay un instante en que está vacío: no es abandono.
const GRACIA_MS: u64 = 5_000;

pub struct Candado {
    ruta: PathBuf,
}

impl Candado {
    /// Liberar dos veces no falla.
    pub fn liberar(&self) -> std::io::Result<()> {
        borrar(&self.ruta)
    }
}

#[derive(Debug)]
pub enum ResultadoCandado {
    Tomado(Candado),
    Ocupado { pid: Option<u32> },
}

pub struct OpcionesCandado<'a> {
    pub pid: u32,
    pub ahora: &'a dyn Fn() -> u64,
    pub vivo: &'a dyn Fn(u32) -> bool,
    pub vencimiento_ms: u64,
}

impl std::fmt::Debug for Candado {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Candado({})", self.ruta.display())
    }
}

fn ahora_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(windows)]
pub fn proceso_vivo(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    // SAFETY: llamadas simples a la API de Windows; el handle se cierra siempre.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            // Sin permiso para abrirlo el proceso existe igual (ACCESS_DENIED); solo «no encontrado» es que murió.
            return std::io::Error::last_os_error().raw_os_error() == Some(5);
        }
        let mut codigo: u32 = 0;
        let ok = GetExitCodeProcess(h, &mut codigo);
        CloseHandle(h);
        ok == 0 || codigo == STILL_ACTIVE as u32
    }
}

#[cfg(not(windows))]
pub fn proceso_vivo(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

fn borrar(ruta: &Path) -> std::io::Result<()> {
    match fs::remove_file(ruta) {
        Err(e) if e.kind() != ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

fn leer_dueno(ruta: &Path) -> std::io::Result<Option<(u32, u64)>> {
    let texto = match fs::read_to_string(ruta) {
        Ok(t) => t,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let Ok(v) = serde_json::from_str::<Value>(&texto) else { return Ok(None) };
    let pid = v.get("pid").and_then(Value::as_u64).filter(|p| *p <= u64::from(u32::MAX));
    let desde = v.get("desde").and_then(Value::as_f64);
    Ok(pid.zip(desde).map(|(p, d)| (p as u32, d as u64)))
}

/// Falla solo ante un error de disco (no poder crear el archivo), no por contención.
pub fn tomar_candado(ruta: &Path, o: Option<&OpcionesCandado>) -> std::io::Result<ResultadoCandado> {
    let pid = o.map_or_else(std::process::id, |o| o.pid);
    let ahora = |()| o.map_or_else(ahora_ms, |o| (o.ahora)());
    let vivo = |p: u32| o.map_or_else(|| proceso_vivo(p), |o| (o.vivo)(p));
    let vence = o.map_or(VENCIMIENTO_MS, |o| o.vencimiento_ms);
    if let Some(dir) = ruta.parent() {
        fs::create_dir_all(dir)?;
    }
    for _ in 0..2 {
        match OpenOptions::new().write(true).create_new(true).open(ruta) {
            Ok(mut f) => {
                f.write_all(json!({ "pid": pid, "desde": ahora(()) }).to_string().as_bytes())?;
                return Ok(ResultadoCandado::Tomado(Candado { ruta: ruta.to_path_buf() }));
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
        match leer_dueno(ruta)? {
            Some((dueno, desde)) => {
                if ahora(()).saturating_sub(desde) < vence && vivo(dueno) {
                    return Ok(ResultadoCandado::Ocupado { pid: Some(dueno) });
                }
            }
            None => {
                let mtime = fs::metadata(ruta)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_millis() as u64);
                if ahora(()).saturating_sub(mtime) < GRACIA_MS {
                    return Ok(ResultadoCandado::Ocupado { pid: None });
                }
            }
        }
        borrar(ruta)?;
    }
    Ok(ResultadoCandado::Ocupado { pid: None })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn ruta() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        std::env::temp_dir().join(format!("sloth-candado-rs-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst))).join("perfiles.lock")
    }

    fn opciones<'a>(pid: u32, ahora: &'a dyn Fn() -> u64, vivo: &'a dyn Fn(u32) -> bool) -> OpcionesCandado<'a> {
        OpcionesCandado { pid, ahora, vivo, vencimiento_ms: VENCIMIENTO_MS }
    }

    #[test]
    fn el_segundo_que_lo_pide_no_lo_toma_hasta_que_el_primero_lo_libera() {
        let r = ruta();
        let ahora = || 1_000_000u64;
        let vivo = |_: u32| true;
        let a = tomar_candado(&r, Some(&opciones(1, &ahora, &vivo))).unwrap();
        let ResultadoCandado::Tomado(c) = a else { panic!("debía tomarlo") };
        assert!(matches!(tomar_candado(&r, Some(&opciones(2, &ahora, &vivo))).unwrap(), ResultadoCandado::Ocupado { pid: Some(1) }));
        c.liberar().unwrap();
        assert!(matches!(tomar_candado(&r, Some(&opciones(2, &ahora, &vivo))).unwrap(), ResultadoCandado::Tomado(_)));
    }

    #[test]
    fn uno_que_quedo_de_un_proceso_que_murio_se_toma() {
        let r = ruta();
        let ahora = || 1_000_000u64;
        let (vivo, muerto) = (|_: u32| true, |_: u32| false);
        assert!(matches!(tomar_candado(&r, Some(&opciones(1, &ahora, &vivo))).unwrap(), ResultadoCandado::Tomado(_)));
        let ResultadoCandado::Tomado(c) = tomar_candado(&r, Some(&opciones(2, &ahora, &muerto))).unwrap() else { panic!("debía tomarlo") };
        let dueno: Value = serde_json::from_str(&fs::read_to_string(&r).unwrap()).unwrap();
        assert_eq!(dueno["pid"], json!(2));
        c.liberar().unwrap();
    }

    #[test]
    fn uno_muy_viejo_se_toma_aunque_el_pid_exista() {
        let r = ruta();
        let (vivo, antes, despues) = (|_: u32| true, || 1_000u64, || 1_000u64 + VENCIMIENTO_MS + 1);
        assert!(matches!(tomar_candado(&r, Some(&opciones(1, &antes, &vivo))).unwrap(), ResultadoCandado::Tomado(_)));
        assert!(matches!(tomar_candado(&r, Some(&opciones(2, &despues, &vivo))).unwrap(), ResultadoCandado::Tomado(_)));
    }

    #[test]
    fn un_archivo_vacio_recien_creado_es_de_otro_y_uno_viejo_y_roto_se_toma() {
        let r = ruta();
        fs::create_dir_all(r.parent().unwrap()).unwrap();
        fs::write(&r, "").unwrap();
        let ahora_real = ahora_ms;
        let vivo = |_: u32| true;
        assert!(matches!(tomar_candado(&r, Some(&opciones(1, &ahora_real, &vivo))).unwrap(), ResultadoCandado::Ocupado { pid: None }));
        let mucho_despues = || ahora_ms() + GRACIA_MS + 1;
        assert!(matches!(tomar_candado(&r, Some(&opciones(1, &mucho_despues, &vivo))).unwrap(), ResultadoCandado::Tomado(_)));
        fs::write(&r, "no es json").unwrap();
        assert!(matches!(tomar_candado(&r, Some(&opciones(1, &mucho_despues, &vivo))).unwrap(), ResultadoCandado::Tomado(_)));
    }

    #[test]
    fn crea_la_carpeta_que_falte_y_liberar_dos_veces_no_falla() {
        let r = ruta().parent().unwrap().join("a").join("b").join("x.lock");
        let ResultadoCandado::Tomado(c) = tomar_candado(&r, None).unwrap() else { panic!("debía tomarlo") };
        assert!(r.exists());
        c.liberar().unwrap();
        c.liberar().unwrap();
    }

    #[test]
    fn el_proceso_actual_esta_vivo_y_uno_inexistente_no() {
        assert!(proceso_vivo(std::process::id()));
        assert!(!proceso_vivo(0x7fff_fff0));
    }
}
