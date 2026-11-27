//! Copiar una conversación de una cuenta a otra. Equivale a src/main/features/move-account-core.ts.
//!
//! Claude guarda cada conversación en `<CLAUDE_CONFIG_DIR>/projects/<slug del cwd>/<uuid>.jsonl`, y sus subagentes y
//! resultados de herramientas en la carpeta homónima `<uuid>/`.
use crate::perfiles_core::es_blanco_js;
use crate::proveedores_fs::nombre_carpeta_proyecto;
use serde_json::Value;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const SUMMARY_MAX: usize = 4000;

/// `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` sin distinguir mayúsculas.
pub fn es_uuid(s: &str) -> bool {
    const LARGOS: [usize; 5] = [8, 4, 4, 4, 12];
    let partes: Vec<&str> = s.split('-').collect();
    partes.len() == 5 && partes.iter().zip(LARGOS).all(|(p, n)| p.len() == n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

pub fn slug_proyecto(cwd: &str) -> String {
    nombre_carpeta_proyecto(cwd)
}

/// La carpeta projects/<slug> de una cuenta para un cwd.
pub fn carpeta_proyecto(config_dir: &Path, cwd: &str) -> PathBuf {
    config_dir.join("projects").join(slug_proyecto(cwd))
}

#[derive(Debug, Clone, PartialEq)]
pub struct SesionRef {
    pub session_id: String,
    pub file: PathBuf,
    pub mtime_ms: f64,
}

fn mtime_ms(m: &fs::Metadata) -> f64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// La conversación más reciente de una carpeta projects/<slug> (el nombre del .jsonl es el sessionId).
pub fn ultima_sesion(project_dir: &Path) -> Option<SesionRef> {
    let mut mejor: Option<SesionRef> = None;
    for e in fs::read_dir(project_dir).ok()?.flatten() {
        let nombre = e.file_name().to_string_lossy().into_owned();
        let Some(id) = nombre.strip_suffix(".jsonl") else { continue };
        if !es_uuid(id) {
            continue;
        }
        let Ok(st) = fs::metadata(e.path()) else { continue };
        if !st.is_file() || st.len() == 0 {
            continue;
        }
        let m = mtime_ms(&st);
        if mejor.as_ref().map_or(true, |b| m > b.mtime_ms) {
            mejor = Some(SesionRef { session_id: id.to_string(), file: e.path(), mtime_ms: m });
        }
    }
    mejor
}

#[derive(Debug, Default, PartialEq)]
pub struct ReporteCopia {
    /// Se copió el .jsonl (false si el destino ya tenía la misma copia).
    pub copied: bool,
    /// Si el destino tenía otro .jsonl con ese nombre, se renombró a esto (no se pisa nada).
    pub backup: Option<PathBuf>,
    /// Hubo carpeta homónima en el origen (subagentes, resultados).
    pub dir_copied: bool,
}

/// `new Date(ms).toISOString()` con `:` y `.` pasados a `-`, para usar en un nombre de archivo.
pub fn marca_de_respaldo(epoch_ms: i64) -> String {
    let dias = epoch_ms.div_euclid(86_400_000);
    let resto = epoch_ms.rem_euclid(86_400_000);
    let (y, m, d) = super::civil_de_dias(dias);
    format!("{y:04}-{m:02}-{d:02}T{:02}-{:02}-{:02}-{:03}Z", resto / 3_600_000, resto / 60_000 % 60, resto / 1000 % 60, resto % 1000)
}

fn copiar_sin_pisar(origen: &Path, destino: &Path) -> io::Result<()> {
    fs::create_dir_all(destino)?;
    for e in fs::read_dir(origen)? {
        let e = e?;
        let a = e.path();
        let b = destino.join(e.file_name());
        if fs::metadata(&a)?.is_dir() {
            copiar_sin_pisar(&a, &b)?;
        } else if !b.exists() {
            fs::copy(&a, &b)?;
        }
    }
    Ok(())
}

/// Copia la conversación `session_id` (y su carpeta homónima) de una cuenta a otra, en el mismo cwd. Nunca pisa: si el
/// destino ya tenía ese .jsonl y es distinto, lo guarda como `<id>.jsonl.sloth-<fecha>.bak`; en la carpeta solo agrega lo que falta.
pub fn copiar_conversacion(from: &Path, to: &Path, cwd: &str, session_id: &str, ahora_ms: i64) -> io::Result<ReporteCopia> {
    if !es_uuid(session_id) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Id de conversación inválido."));
    }
    let src_dir = carpeta_proyecto(from, cwd);
    let dst_dir = carpeta_proyecto(to, cwd);
    let src = src_dir.join(format!("{session_id}.jsonl"));
    let dst = dst_dir.join(format!("{session_id}.jsonl"));
    fs::create_dir_all(&dst_dir)?;
    let mut reporte = ReporteCopia::default();
    let src_st = fs::metadata(&src)?;
    let dst_st = fs::metadata(&dst).ok();
    let misma_copia = dst_st.as_ref().is_some_and(|d| d.len() == src_st.len() && mtime_ms(d) >= mtime_ms(&src_st));
    if !misma_copia {
        if dst_st.is_some() {
            let respaldo = PathBuf::from(format!("{}.sloth-{}.bak", dst.display(), marca_de_respaldo(ahora_ms)));
            fs::rename(&dst, &respaldo)?;
            reporte.backup = Some(respaldo);
        }
        let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&dst)?;
        io::copy(&mut fs::File::open(&src)?, &mut f)?;
        reporte.copied = true;
    }
    let carpeta = src_dir.join(session_id);
    if fs::metadata(&carpeta).is_ok_and(|m| m.is_dir()) {
        copiar_sin_pisar(&carpeta, &dst_dir.join(session_id))?;
        reporte.dir_copied = true;
    }
    Ok(reporte)
}

pub struct EntradaResumen<'a> {
    pub name: &'a str,
    pub cwd: &'a str,
    pub branch: Option<&'a str>,
    /// Archivos con cambios sin confirmar. -1 = no se pudo leer.
    pub changes: i64,
}

/// Resumen inicial para el texto editable.
pub fn armar_resumen(s: &EntradaResumen) -> String {
    let donde = match s.branch.filter(|b| !b.is_empty()) {
        Some(b) => format!("carpeta {}, rama {b}", s.cwd),
        None => format!("carpeta {}", s.cwd),
    };
    let cambios = match s.changes {
        c if c < 0 => "No pude leer los cambios sin confirmar".to_string(),
        0 => "No hay cambios sin confirmar".to_string(),
        1 => "Hay 1 archivo con cambios sin confirmar".to_string(),
        n => format!("Hay {n} archivos con cambios sin confirmar"),
    };
    format!("Estábamos trabajando en el espacio «{}» ({donde}). {cambios}. Antes de seguir, revisá el estado del repo con git status y retomá desde ahí.", s.name)
}

/// Texto que escribe el usuario: sin caracteres de control (salvo saltos de línea), con tope de largo.
pub fn sanear_resumen(v: &Value) -> Result<String, String> {
    let t = v.as_str().ok_or("El resumen tiene que ser texto.")?;
    let limpio: String = t.chars().filter(|c| !matches!(c, '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{7f}')).collect();
    let limpio = limpio.trim_matches(es_blanco_js);
    if limpio.encode_utf16().count() > SUMMARY_MAX {
        return Err(format!("El resumen es demasiado largo (máximo {SUMMARY_MAX} caracteres)."));
    }
    Ok(limpio.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const ID: &str = "11111111-2222-3333-4444-555555555555";
    const ID2: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const CWD: &str = "C:\\Users\\yo\\repo";

    fn con_tmp(f: impl FnOnce(&Path, &Path)) {
        static N: AtomicUsize = AtomicUsize::new(0);
        let base = std::env::temp_dir().join(format!("sloth-move-rs-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let (a, b) = (base.join("a"), base.join("b"));
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        f(&a, &b);
        let _ = fs::remove_dir_all(&base);
    }

    fn escribir_sesion(config: &Path, id: &str, contenido: &str) -> PathBuf {
        let dir = carpeta_proyecto(config, CWD);
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join(format!("{id}.jsonl"));
        fs::write(&f, contenido).unwrap();
        f
    }

    fn fijar_mtime(f: &Path, segundos: u64) {
        let t = UNIX_EPOCH + std::time::Duration::from_secs(segundos);
        fs::File::options().write(true).open(f).unwrap().set_modified(t).unwrap();
    }

    fn nombres(d: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[test]
    fn slug_reemplaza_todo_lo_no_alfanumerico_por_guiones() {
        assert_eq!(slug_proyecto("C:\\Users\\yo\\mi repo"), "C--Users-yo-mi-repo");
        assert_eq!(slug_proyecto("/home/ñu/x.y"), "-home--u-x-y");
    }

    #[test]
    fn uuid_acepta_uuids_y_rechaza_ids_con_rutas_o_de_largo_raro() {
        assert!(es_uuid(ID));
        assert!(es_uuid(&ID2.to_uppercase()));
        for mal in ["", "abc", &format!("../{ID}"), &format!("{ID}/.."), &format!("{ID}\n"), &format!("{ID}.jsonl"), "1111111-2222-3333-4444-555555555555"] {
            assert!(!es_uuid(mal), "{mal:?}");
        }
    }

    #[test]
    fn ultima_sesion_elige_la_mas_reciente_e_ignora_lo_que_no_es_una_sesion() {
        con_tmp(|from, _| {
            fijar_mtime(&escribir_sesion(from, ID, "vieja"), 1000);
            fijar_mtime(&escribir_sesion(from, ID2, "nueva"), 2000);
            let dir = carpeta_proyecto(from, CWD);
            fs::write(dir.join("notas.jsonl"), "x").unwrap();
            fs::write(dir.join("a1111111-2222-3333-4444-555555555555.txt"), "x").unwrap();
            fs::write(dir.join("ffffffff-2222-3333-4444-555555555555.jsonl"), "").unwrap();
            fs::create_dir(dir.join("99999999-2222-3333-4444-555555555555.jsonl")).unwrap();
            let mejor = ultima_sesion(&dir).unwrap();
            assert_eq!(mejor.session_id, ID2);
            assert_eq!(mejor.file, dir.join(format!("{ID2}.jsonl")));
        });
    }

    #[test]
    fn ultima_sesion_es_none_si_la_carpeta_no_existe_o_no_hay_sesiones() {
        con_tmp(|from, _| {
            assert_eq!(ultima_sesion(&carpeta_proyecto(from, CWD)), None);
            fs::create_dir_all(carpeta_proyecto(from, CWD)).unwrap();
            assert_eq!(ultima_sesion(&carpeta_proyecto(from, CWD)), None);
        });
    }

    #[test]
    fn copia_la_conversacion_y_su_carpeta_y_deja_el_origen_intacto() {
        con_tmp(|from, to| {
            escribir_sesion(from, ID, "hola");
            let sub = carpeta_proyecto(from, CWD).join(ID).join("subagents");
            fs::create_dir_all(&sub).unwrap();
            fs::write(sub.join("a.jsonl"), "sub").unwrap();
            let r = copiar_conversacion(from, to, CWD, ID, 0).unwrap();
            assert_eq!(r, ReporteCopia { copied: true, backup: None, dir_copied: true });
            assert_eq!(fs::read_to_string(carpeta_proyecto(to, CWD).join(format!("{ID}.jsonl"))).unwrap(), "hola");
            assert_eq!(fs::read_to_string(carpeta_proyecto(to, CWD).join(ID).join("subagents").join("a.jsonl")).unwrap(), "sub");
            assert_eq!(fs::read_to_string(carpeta_proyecto(from, CWD).join(format!("{ID}.jsonl"))).unwrap(), "hola");
        });
    }

    #[test]
    fn sin_carpeta_homonima_no_la_inventa() {
        con_tmp(|from, to| {
            escribir_sesion(from, ID, "hola");
            let r = copiar_conversacion(from, to, CWD, ID, 0).unwrap();
            assert!(!r.dir_copied);
            assert_eq!(nombres(&carpeta_proyecto(to, CWD)), vec![format!("{ID}.jsonl")]);
        });
    }

    #[test]
    fn con_la_misma_copia_en_el_destino_no_la_duplica_ni_hace_respaldo() {
        con_tmp(|from, to| {
            fijar_mtime(&escribir_sesion(from, ID, "hola"), 1000);
            copiar_conversacion(from, to, CWD, ID, 0).unwrap();
            let r = copiar_conversacion(from, to, CWD, ID, 0).unwrap();
            assert!(!r.copied);
            assert_eq!(r.backup, None);
            assert_eq!(nombres(&carpeta_proyecto(to, CWD)), vec![format!("{ID}.jsonl")]);
        });
    }

    #[test]
    fn con_otro_contenido_en_el_destino_lo_respalda_en_vez_de_pisarlo() {
        con_tmp(|from, to| {
            escribir_sesion(to, ID, "del destino, distinto");
            escribir_sesion(from, ID, "del origen");
            let r = copiar_conversacion(from, to, CWD, ID, 1_764_245_000_123).unwrap();
            assert!(r.copied);
            let backup = r.backup.unwrap();
            let nombre = backup.to_string_lossy().into_owned();
            assert!(nombre.contains(&format!("{ID}.jsonl.sloth-")) && nombre.ends_with("2025-11-27T12-03-20-123Z.bak"), "{nombre}");
            assert_eq!(fs::read_to_string(&backup).unwrap(), "del destino, distinto");
            assert_eq!(fs::read_to_string(carpeta_proyecto(to, CWD).join(format!("{ID}.jsonl"))).unwrap(), "del origen");
        });
    }

    #[test]
    fn no_pisa_lo_que_ya_hay_en_la_carpeta_del_destino() {
        con_tmp(|from, to| {
            escribir_sesion(from, ID, "hola");
            let src_sub = carpeta_proyecto(from, CWD).join(ID);
            fs::create_dir_all(&src_sub).unwrap();
            fs::write(src_sub.join("x.txt"), "origen").unwrap();
            fs::write(src_sub.join("nuevo.txt"), "nuevo").unwrap();
            let dst_sub = carpeta_proyecto(to, CWD).join(ID);
            fs::create_dir_all(&dst_sub).unwrap();
            fs::write(dst_sub.join("x.txt"), "destino").unwrap();
            copiar_conversacion(from, to, CWD, ID, 0).unwrap();
            assert_eq!(fs::read_to_string(dst_sub.join("x.txt")).unwrap(), "destino");
            assert_eq!(fs::read_to_string(dst_sub.join("nuevo.txt")).unwrap(), "nuevo");
        });
    }

    #[test]
    fn rechaza_ids_invalidos_o_con_rutas_y_no_escribe_nada() {
        con_tmp(|from, to| {
            escribir_sesion(from, ID, "hola");
            for mal in ["", "../../../etc/passwd", &format!("..\\{ID}"), &format!("{ID}/.."), "no-es-uuid"] {
                let e = copiar_conversacion(from, to, CWD, mal, 0).unwrap_err();
                assert!(e.to_string().contains("Id de conversación inválido"), "{mal}");
            }
            assert!(nombres(to).is_empty());
        });
    }

    #[test]
    fn falla_si_la_conversacion_no_existe_en_el_origen() {
        con_tmp(|from, to| {
            let e = copiar_conversacion(from, to, CWD, ID, 0).unwrap_err();
            assert_eq!(e.kind(), io::ErrorKind::NotFound);
        });
    }

    #[test]
    fn deja_cada_cwd_en_su_carpeta() {
        con_tmp(|from, to| {
            escribir_sesion(from, ID, "hola");
            copiar_conversacion(from, to, CWD, ID, 0).unwrap();
            assert_eq!(ultima_sesion(&carpeta_proyecto(to, "C:\\otro\\repo")), None);
        });
    }

    #[test]
    fn resumen_nombra_el_espacio_la_carpeta_y_la_rama() {
        let s = armar_resumen(&EntradaResumen { name: "api", cwd: CWD, branch: Some("feat/x"), changes: 3 });
        assert!(s.contains("«api»"));
        assert!(s.contains(&format!("carpeta {CWD}, rama feat/x")));
        assert!(s.contains("Hay 3 archivos con cambios sin confirmar"));
    }

    #[test]
    fn resumen_sin_rama_y_con_cada_cantidad_de_cambios() {
        let r = |changes| armar_resumen(&EntradaResumen { name: "a", cwd: CWD, branch: None, changes });
        assert!(r(0).contains(&format!("(carpeta {CWD})")));
        assert!(r(0).contains("No hay cambios sin confirmar"));
        assert!(r(1).contains("Hay 1 archivo con cambios"));
        assert!(r(-1).contains("No pude leer los cambios"));
    }

    #[test]
    fn sanear_saca_controles_conserva_saltos_de_linea_y_recorta() {
        assert_eq!(sanear_resumen(&json!("  hola\u{0} mundo\u{1b}[31m\nchau\u{7f}  ")).unwrap(), "hola mundo[31m\nchau");
        assert_eq!(sanear_resumen(&json!("a\tb")).unwrap(), "a\tb");
    }

    #[test]
    fn sanear_rechaza_lo_que_no_es_texto_y_lo_demasiado_largo() {
        for mal in [json!(null), json!(5), json!({}), json!(["a"])] {
            assert!(sanear_resumen(&mal).unwrap_err().contains("tiene que ser texto"));
        }
        assert_eq!(sanear_resumen(&json!("a".repeat(SUMMARY_MAX))).unwrap().len(), SUMMARY_MAX);
        assert!(sanear_resumen(&json!("a".repeat(SUMMARY_MAX + 1))).unwrap_err().contains("demasiado largo"));
    }

    #[test]
    fn marca_de_respaldo_formatea_como_iso_con_guiones() {
        assert_eq!(marca_de_respaldo(0), "1970-01-01T00-00-00-000Z");
        assert_eq!(marca_de_respaldo(951_782_400_000 + 86_399_999), "2000-02-29T23-59-59-999Z");
    }
}
