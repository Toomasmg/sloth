//! Cuentas de un agente en los otros perfiles, para que el tope valga entre todos. Equivale a src/main/tope-cuentas.ts.
use crate::proveedores::{proveedor_id_de, ProveedorId};
use serde_json::Value;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

const MAX_BYTES_ESTADO: u64 = 32 * 1024 * 1024;

/// Se leen las carpetas y no el índice: el tope vale aunque el índice esté desarmado, y un perfil borrado
/// (movido a respaldos/) deja de contar solo. Solo lectura. Un estado que no se puede leer no cuenta: bloquear para
/// siempre por un archivo roto es peor.
pub fn cuentas_en_otros_perfiles(carpeta_perfiles: &Path, perfil_propio: &str, id: ProveedorId, avisar: &mut dyn FnMut(String)) -> usize {
    let carpetas: Vec<String> = match fs::read_dir(carpeta_perfiles) {
        Ok(it) => it.filter_map(Result::ok).filter(|d| d.file_type().is_ok_and(|t| t.is_dir())).map(|d| d.file_name().to_string_lossy().into_owned()).filter(|n| n != perfil_propio).collect(),
        Err(e) => {
            if e.kind() != ErrorKind::NotFound {
                avisar(format!("no pude listar los perfiles para contar cuentas: {e}"));
            }
            return 0;
        }
    };
    let mut n = 0;
    for nombre in carpetas {
        let archivo = carpeta_perfiles.join(&nombre).join("sloth-state.json");
        match leer_cuentas(&archivo) {
            Ok(cuentas) => n += cuentas.iter().filter(|c| c.is_object() && proveedor_id_de(c) == Some(id)).count(),
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => avisar(format!("no pude leer las cuentas del perfil {nombre}: {e}")),
        }
    }
    n
}

fn leer_cuentas(archivo: &Path) -> std::io::Result<Vec<Value>> {
    if fs::metadata(archivo)?.len() > MAX_BYTES_ESTADO {
        return Err(std::io::Error::other("es demasiado grande"));
    }
    let texto = fs::read_to_string(archivo)?;
    let json: Value = serde_json::from_str(texto.strip_prefix('\u{feff}').unwrap_or(&texto)).map_err(std::io::Error::other)?;
    Ok(json.get("accounts").and_then(Value::as_array).cloned().unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proveedores::motivo_no_agregar;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct Perfiles(PathBuf);
    impl Drop for Perfiles {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn con_perfiles(estados: &[(&str, Option<&str>)]) -> Perfiles {
        static N: AtomicU32 = AtomicU32::new(0);
        let raiz = std::env::temp_dir().join(format!("sloth-tope-rs-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let carpeta = raiz.join("perfiles");
        for (id, texto) in estados {
            fs::create_dir_all(carpeta.join(id)).unwrap();
            if let Some(t) = texto {
                fs::write(carpeta.join(id).join("sloth-state.json"), t).unwrap();
            }
        }
        fs::create_dir_all(&carpeta).unwrap();
        Perfiles(raiz)
    }

    impl Perfiles {
        fn carpeta(&self) -> PathBuf {
            self.0.join("perfiles")
        }
    }

    fn estado(proveedores: &[Option<&str>]) -> String {
        let cuentas: Vec<Value> = proveedores
            .iter()
            .enumerate()
            .map(|(i, p)| match p {
                Some(p) => serde_json::json!({ "id": format!("c{i}"), "proveedor": p }),
                None => serde_json::json!({ "id": format!("c{i}") }),
            })
            .collect();
        serde_json::json!({ "version": 1, "accounts": cuentas }).to_string()
    }

    fn contar(c: &Path, propio: &str, id: ProveedorId, avisos: &mut Vec<String>) -> usize {
        cuentas_en_otros_perfiles(c, propio, id, &mut |m| avisos.push(m))
    }

    #[test]
    fn cuenta_las_de_copilot_de_los_otros_perfiles_y_no_las_del_propio_ni_las_de_otros_agentes() {
        let p = con_perfiles(&[
            ("principal", Some(&estado(&[Some("copilot")]))),
            ("p-b", Some(&estado(&[Some("copilot"), Some("codex"), None]))),
            ("p-c", Some(&estado(&[Some("codex")]))),
        ]);
        let mut avisos = vec![];
        assert_eq!(contar(&p.carpeta(), "principal", ProveedorId::Copilot, &mut avisos), 1);
        assert_eq!(contar(&p.carpeta(), "p-b", ProveedorId::Copilot, &mut avisos), 1);
        assert_eq!(contar(&p.carpeta(), "p-c", ProveedorId::Copilot, &mut avisos), 2);
        assert!(avisos.is_empty());
    }

    #[test]
    fn sin_carpeta_sin_estado_o_con_un_estado_roto_no_cuenta_y_solo_avisa_lo_que_no_es_un_archivo_ausente() {
        let mut avisos = vec![];
        assert_eq!(contar(&std::env::temp_dir().join("sloth-no-existe-tope-rs"), "principal", ProveedorId::Copilot, &mut avisos), 0);
        let bien = estado(&[Some("copilot")]);
        let p = con_perfiles(&[("vacio", None), ("roto", Some("{roto")), ("raro", Some("[1,2]")), ("sinLista", Some("{\"accounts\":3}")), ("bien", Some(&bien))]);
        assert_eq!(contar(&p.carpeta(), "principal", ProveedorId::Copilot, &mut avisos), 1);
        assert_eq!(avisos.len(), 1);
        assert!(avisos[0].contains("perfil roto"), "{}", avisos[0]);
    }

    #[test]
    fn un_estado_con_bom_se_lee() {
        let con_bom = format!("\u{feff}{}", estado(&[Some("copilot")]));
        let p = con_perfiles(&[("a", Some(&con_bom))]);
        assert_eq!(contar(&p.carpeta(), "principal", ProveedorId::Copilot, &mut vec![]), 1);
    }

    #[test]
    fn un_proveedor_que_esta_version_no_conoce_no_cuenta_como_copilot() {
        let p = con_perfiles(&[("a", Some(&estado(&[Some("otro-agente")])))]);
        assert_eq!(contar(&p.carpeta(), "principal", ProveedorId::Copilot, &mut vec![]), 0);
    }

    #[test]
    fn el_tope_de_copilot_vale_entre_perfiles() {
        let p = con_perfiles(&[("principal", Some(&estado(&[]))), ("p-b", Some(&estado(&[Some("copilot")])))]);
        let otros = contar(&p.carpeta(), "principal", ProveedorId::Copilot, &mut vec![]);
        assert!(motivo_no_agregar(&[], ProveedorId::Copilot, otros).unwrap().contains("en otro perfil"));
        assert_eq!(motivo_no_agregar(&[], ProveedorId::Claude, otros), None);
    }

    #[test]
    fn un_perfil_borrado_libera_el_tope() {
        let p = con_perfiles(&[("principal", Some(&estado(&[])))]);
        let otros = contar(&p.carpeta(), "principal", ProveedorId::Copilot, &mut vec![]);
        assert_eq!(motivo_no_agregar(&[], ProveedorId::Copilot, otros), None);
    }
}
