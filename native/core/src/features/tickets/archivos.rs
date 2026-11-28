//! Los otros dos archivos de tickets en userData: tickets-conectores.json (los conectores propios y los aceptados del equipo)
//! y tickets-cuentas.json (qué servidores MCP tiene cada cuenta), más la lectura de `<repo>/.sloth/conectores.json`. Con el fs
//! inyectado, como el almacén; los avisos y los logs vuelven como texto. Equivale a las funciones de archivo de
//! src/main/features/tickets/index.ts.
use super::almacen::FsTickets;
use super::cuentas::{cache_a_valor, sanear_cache};
use super::modelo::{CuentaRevisada, Ordenado};
use super::propios::{parsear_archivo_propios, parsear_conectores_equipo, ArchivoPropios, EQUIPO_ARCHIVO, EQUIPO_MAX_BYTES};
use crate::features::poda::podar_segun_store;
use crate::features::team_config::TEAM_DIR;
use crate::persistencia::escribir_json_atomico;
use serde_json::Value;
use std::path::{Path, PathBuf};

fn con_sufijo(p: &Path, sufijo: &str) -> PathBuf {
    let mut s = p.as_os_str().to_os_string();
    s.push(sufijo);
    PathBuf::from(s)
}

fn texto_ms(n: f64) -> String {
    super::texto::num_valor(n).to_string()
}

pub struct CargaPropios {
    pub archivo: ArchivoPropios,
    pub avisos: Vec<String>,
    /// Si tickets-conectores.json no se pudo leer ni respaldar, o es de una versión más nueva, no se pisa.
    pub ilegible: bool,
}

pub fn leer_archivo_propios(fs: &dyn FsTickets, ruta: &Path, ahora_ms: f64) -> CargaPropios {
    let texto = match fs.leer(ruta) {
        Ok(t) => Some(t),
        Err(e) if e.no_existe => None,
        Err(e) => {
            return CargaPropios { archivo: ArchivoPropios::vacio(), avisos: vec![format!("No pude leer tus conectores propios: {}", e.mensaje)], ilegible: true };
        }
    };
    let r = parsear_archivo_propios(texto.as_deref());
    let mut ilegible = r.futuro;
    if !r.corrupto {
        return CargaPropios { archivo: r.archivo, avisos: r.avisos, ilegible };
    }
    let aviso = match fs.renombrar(ruta, &con_sufijo(ruta, &format!(".corrupto-{}", texto_ms(ahora_ms)))) {
        Ok(()) => "Tus conectores propios estaban dañados: guardé el archivo aparte y empezaste sin ninguno.".to_string(),
        Err(e) => {
            ilegible = true;
            format!("Tus conectores propios están dañados y no pude respaldarlos: {}", e.mensaje)
        }
    };
    CargaPropios { archivo: r.archivo, avisos: vec![aviso], ilegible }
}

/// tmp + fsync + rename, como todo lo que se escribe en userData. No pisa un archivo que no se pudo leer.
pub fn guardar_archivo_propios(ruta: &Path, a: &ArchivoPropios, ilegible: bool) -> Result<(), String> {
    if ilegible {
        return Err("No puedo guardar: el archivo de tus conectores propios no se pudo leer o es de una versión más nueva de Sloth.".into());
    }
    escribir_json_atomico(ruta, &a.a_valor()).map(|_| ()).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, PartialEq)]
pub enum ConectoresEquipo {
    SinArchivo,
    /// No se pudo leer o no sirve: el aviso para la persona.
    Aviso(String),
    Lista(Vec<Value>),
}

/// Los de `<repo>/.sloth/conectores.json`.
pub fn leer_conectores_equipo(fs: &dyn FsTickets, repo: &Path) -> ConectoresEquipo {
    let file = repo.join(TEAM_DIR).join(EQUIPO_ARCHIVO);
    let donde = format!("{TEAM_DIR}/{EQUIPO_ARCHIVO} de {}", repo.display());
    let info = match fs.info(&file) {
        Ok(i) => i,
        Err(e) if e.no_existe => return ConectoresEquipo::SinArchivo,
        Err(e) => return ConectoresEquipo::Aviso(format!("{donde} no se pudo leer: {}", e.mensaje)),
    };
    if !info.es_archivo {
        return ConectoresEquipo::Aviso(format!("{donde} no es un archivo."));
    }
    if info.bytes as usize > EQUIPO_MAX_BYTES {
        return ConectoresEquipo::Aviso(format!("{donde} pesa más de {} KB.", EQUIPO_MAX_BYTES / 1024));
    }
    match fs.leer(&file) {
        Err(e) if e.no_existe => ConectoresEquipo::SinArchivo,
        Err(e) => ConectoresEquipo::Aviso(format!("{donde} no se pudo leer: {}", e.mensaje)),
        Ok(t) => match parsear_conectores_equipo(&t) {
            Ok(l) => ConectoresEquipo::Lista(l),
            Err(m) => ConectoresEquipo::Aviso(format!("{donde} no se pudo leer: {m}")),
        },
    }
}

/// Lo que cargó tickets-cuentas.json y lo que hay que anotar en el log.
pub struct CargaCuentas {
    pub cuentas: Ordenado<CuentaRevisada>,
    pub logs: Vec<String>,
}

pub fn cargar_cuentas(fs: &dyn FsTickets, ruta: &Path, ahora_ms: f64) -> CargaCuentas {
    let vacio = |logs: Vec<String>| CargaCuentas { cuentas: Ordenado::default(), logs };
    let texto = match fs.leer(ruta) {
        Ok(t) => t,
        Err(e) if e.no_existe => return vacio(vec![]),
        Err(e) => return vacio(vec![format!("tickets: no pude leer las cuentas revisadas: {}", e.mensaje)]),
    };
    let mut logs = Vec::new();
    match serde_json::from_str::<Value>(texto.strip_prefix('\u{feff}').unwrap_or(&texto)) {
        Ok(v) => {
            if let Some(c) = sanear_cache(&v) {
                return CargaCuentas { cuentas: c, logs };
            }
        }
        Err(e) => logs.push(format!("tickets: las cuentas revisadas no son un JSON: {e}")),
    }
    if let Err(e) = fs.renombrar(ruta, &con_sufijo(ruta, &format!(".corrupto-{}", texto_ms(ahora_ms)))) {
        logs.push(format!("tickets: no pude apartar las cuentas revisadas dañadas: {}", e.mensaje));
    }
    vacio(logs)
}

/// Guarda solo las cuentas que siguen existiendo (si el store cargó entero). Devuelve el log si falló.
pub fn guardar_cuentas(fs: &dyn FsTickets, ruta: &Path, carpeta: &Path, pid: u32, cuentas: &Ordenado<CuentaRevisada>, existe: &dyn Fn(&str) -> bool, store_confiable: bool) -> Option<String> {
    let items: Vec<(String, CuentaRevisada)> = cuentas.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let guardar = podar_segun_store(&items, |(id, _)| existe(id), store_confiable).guardar;
    let mut a_guardar: Ordenado<CuentaRevisada> = Ordenado::default();
    for (id, c) in guardar {
        a_guardar.insert(id, c);
    }
    let tmp = con_sufijo(ruta, &format!(".{pid}.tmp"));
    let res = (|| {
        fs.crear_carpeta(carpeta)?;
        let texto = serde_json::to_string_pretty(&cache_a_valor(&a_guardar)).unwrap_or_default();
        fs.escribir(&tmp, &texto)?;
        fs.renombrar(&tmp, ruta)
    })();
    match res {
        Ok(()) => None,
        Err(e) => {
            let _ = fs.borrar(&tmp);
            Some(format!("tickets: no pude guardar las cuentas revisadas: {}", e.mensaje))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::tickets::almacen::{ErrFs, InfoArchivo};
    use crate::features::tickets::modelo::{EstadoMcp, ServidorMcp};
    use crate::features::tickets::texto::Num;
    use serde_json::json;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Mem {
        archivos: RefCell<HashMap<PathBuf, String>>,
        leer_falla: RefCell<HashMap<PathBuf, &'static str>>,
        renombrar_falla: RefCell<bool>,
        escribir_falla: RefCell<bool>,
        directorios: RefCell<Vec<PathBuf>>,
    }

    fn err(c: &str) -> ErrFs {
        ErrFs { no_existe: c == "ENOENT", codigo: c.into(), mensaje: format!("{c}: falló") }
    }

    impl FsTickets for Mem {
        fn leer(&self, r: &Path) -> Result<String, ErrFs> {
            if let Some(c) = self.leer_falla.borrow().get(r) {
                return Err(err(c));
            }
            self.archivos.borrow().get(r).cloned().ok_or_else(|| err("ENOENT"))
        }
        fn mtime_ms(&self, _: &Path) -> Result<f64, ErrFs> {
            Ok(0.0)
        }
        fn renombrar(&self, de: &Path, a: &Path) -> Result<(), ErrFs> {
            if *self.renombrar_falla.borrow() {
                return Err(err("EPERM"));
            }
            let t = self.archivos.borrow_mut().remove(de).ok_or_else(|| err("ENOENT"))?;
            self.archivos.borrow_mut().insert(a.to_path_buf(), t);
            Ok(())
        }
        fn escribir(&self, r: &Path, d: &str) -> Result<(), ErrFs> {
            if *self.escribir_falla.borrow() {
                return Err(err("ENOSPC"));
            }
            self.archivos.borrow_mut().insert(r.to_path_buf(), d.to_string());
            Ok(())
        }
        fn crear_carpeta(&self, r: &Path) -> Result<(), ErrFs> {
            self.directorios.borrow_mut().push(r.to_path_buf());
            Ok(())
        }
        fn info(&self, r: &Path) -> Result<InfoArchivo, ErrFs> {
            self.archivos.borrow().get(r).map(|t| InfoArchivo { es_archivo: true, bytes: t.len() as u64 }).ok_or_else(|| err("ENOENT"))
        }
        fn borrar(&self, r: &Path) -> Result<(), ErrFs> {
            self.archivos.borrow_mut().remove(r).map(|_| ()).ok_or_else(|| err("ENOENT"))
        }
    }

    fn con(p: &str, t: &str) -> Mem {
        let m = Mem::default();
        m.archivos.borrow_mut().insert(PathBuf::from(p), t.to_string());
        m
    }

    const P: &str = "C:/datos/tickets-conectores.json";

    #[test]
    fn sin_archivo_de_propios_empieza_vacio_y_sin_avisos() {
        let c = leer_archivo_propios(&Mem::default(), Path::new(P), 1.0);
        assert!(c.archivo.conectores.is_empty() && c.avisos.is_empty() && !c.ilegible);
    }

    #[test]
    fn un_propios_ilegible_no_se_pisa_y_avisa() {
        let m = con(P, "{}");
        m.leer_falla.borrow_mut().insert(PathBuf::from(P), "EBUSY");
        let c = leer_archivo_propios(&m, Path::new(P), 1.0);
        assert!(c.ilegible);
        assert_eq!(c.avisos, vec!["No pude leer tus conectores propios: EBUSY: falló".to_string()]);
        assert!(guardar_archivo_propios(Path::new(P), &c.archivo, c.ilegible).unwrap_err().contains("no se pudo leer o es de una versión más nueva"));
    }

    #[test]
    fn un_propios_danado_se_aparta_con_la_hora_y_si_no_se_puede_queda_solo_lectura() {
        let m = con(P, "{roto");
        let c = leer_archivo_propios(&m, Path::new(P), 1_700_000_000_000.0);
        assert!(!c.ilegible);
        assert_eq!(c.avisos, vec!["Tus conectores propios estaban dañados: guardé el archivo aparte y empezaste sin ninguno.".to_string()]);
        assert_eq!(m.archivos.borrow().get(Path::new("C:/datos/tickets-conectores.json.corrupto-1700000000000")).map(String::as_str), Some("{roto"));
        let m = con(P, "{roto");
        *m.renombrar_falla.borrow_mut() = true;
        let c = leer_archivo_propios(&m, Path::new(P), 1.0);
        assert!(c.ilegible);
        assert!(c.avisos[0].starts_with("Tus conectores propios están dañados y no pude respaldarlos: EPERM"));
    }

    #[test]
    fn un_propios_de_version_futura_no_se_aparta_ni_se_pisa() {
        let m = con(P, &json!({ "version": 2, "conectores": [] }).to_string());
        let c = leer_archivo_propios(&m, Path::new(P), 1.0);
        assert!(c.ilegible);
        assert!(c.avisos[0].contains("actualizá Sloth"));
        assert!(m.archivos.borrow().contains_key(Path::new(P)));
    }

    #[test]
    fn conectores_del_equipo_sin_archivo_con_aviso_y_con_lista() {
        let repo = Path::new("C:/repo");
        let ruta = "C:/repo/.sloth/conectores.json";
        assert_eq!(leer_conectores_equipo(&Mem::default(), repo), ConectoresEquipo::SinArchivo);
        let ok = json!({ "formato": "sloth-conectores", "versión": 1, "conectores": [{ "id": "x" }] }).to_string();
        assert_eq!(leer_conectores_equipo(&con(ruta, &ok), repo), ConectoresEquipo::Lista(vec![json!({ "id": "x" })]));
        let roto = leer_conectores_equipo(&con(ruta, "{"), repo);
        assert!(matches!(&roto, ConectoresEquipo::Aviso(a) if a.contains("no se pudo leer: no es un JSON válido.")), "{roto:?}");
        let grande = leer_conectores_equipo(&con(ruta, &" ".repeat(EQUIPO_MAX_BYTES + 1)), repo);
        assert!(matches!(&grande, ConectoresEquipo::Aviso(a) if a.contains("pesa más de 256 KB.")), "{grande:?}");
    }

    fn cuenta(nombre: &str) -> CuentaRevisada {
        CuentaRevisada { revisada_en: Num(5.0), servidores: vec![ServidorMcp { nombre: nombre.into(), prefijo: format!("mcp__{nombre}__"), estado: EstadoMcp::Conectado, herramientas: None }], error: None }
    }

    const C: &str = "C:/datos/tickets-cuentas.json";

    #[test]
    fn las_cuentas_se_guardan_podadas_y_vuelven_iguales() {
        let mut todas: Ordenado<CuentaRevisada> = Ordenado::default();
        todas.insert("a", cuenta("uno"));
        todas.insert("b", cuenta("dos"));
        let m = Mem::default();
        assert_eq!(guardar_cuentas(&m, Path::new(C), Path::new("C:/datos"), 7, &todas, &|id| id == "a", true), None);
        assert!(!m.archivos.borrow().keys().any(|k| k.to_string_lossy().ends_with(".tmp")));
        let c = cargar_cuentas(&m, Path::new(C), 1.0);
        assert_eq!(c.cuentas.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), vec!["a"]);
        assert!(c.logs.is_empty());
        // Con el store incompleto el archivo conserva todo.
        assert_eq!(guardar_cuentas(&m, Path::new(C), Path::new("C:/datos"), 7, &todas, &|id| id == "a", false), None);
        assert_eq!(cargar_cuentas(&m, Path::new(C), 1.0).cuentas.len(), 2);
    }

    #[test]
    fn si_falla_guardar_las_cuentas_se_loguea_y_no_queda_el_tmp() {
        let m = Mem::default();
        *m.escribir_falla.borrow_mut() = true;
        let log = guardar_cuentas(&m, Path::new(C), Path::new("C:/datos"), 7, &Ordenado::default(), &|_| true, true).unwrap();
        assert!(log.starts_with("tickets: no pude guardar las cuentas revisadas: ENOSPC"));
        assert!(m.archivos.borrow().is_empty());
    }

    #[test]
    fn cuentas_sin_archivo_ilegibles_o_danadas() {
        assert!(cargar_cuentas(&Mem::default(), Path::new(C), 1.0).logs.is_empty());
        let m = con(C, "{}");
        m.leer_falla.borrow_mut().insert(PathBuf::from(C), "EBUSY");
        assert!(cargar_cuentas(&m, Path::new(C), 1.0).logs[0].starts_with("tickets: no pude leer las cuentas revisadas: EBUSY"));
        let m = con(C, "{roto");
        let c = cargar_cuentas(&m, Path::new(C), 1_700_000_000_000.0);
        assert!(c.cuentas.is_empty());
        assert!(c.logs[0].starts_with("tickets: las cuentas revisadas no son un JSON:"));
        assert!(m.archivos.borrow().contains_key(Path::new("C:/datos/tickets-cuentas.json.corrupto-1700000000000")));
        let m = con(C, &json!({ "version": 2, "cuentas": {} }).to_string());
        assert!(cargar_cuentas(&m, Path::new(C), 5.0).cuentas.is_empty());
        assert!(m.archivos.borrow().contains_key(Path::new("C:/datos/tickets-cuentas.json.corrupto-5")));
    }
}
