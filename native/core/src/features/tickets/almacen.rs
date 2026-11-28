//! tickets.json en disco, con el fs inyectado (los tests usan uno en memoria). gruv.json solo se lee. Si tickets.json no
//! se pudo leer, es de una versión más nueva de Sloth o no se pudo apartar antes de reemplazarlo, la sesión trabaja en
//! memoria y no lo escribe nunca. Equivale a src/main/features/tickets/almacen.ts.
use super::estado::{parsear_archivo, resolver_estado, Buscar, Lectura, Origen, Respaldar, SoloLectura, TicketsState};
use super::modelo::Ordenado;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErrFs {
    pub no_existe: bool,
    pub codigo: String,
    pub mensaje: String,
}

impl ErrFs {
    pub fn de_io(e: &std::io::Error) -> Self {
        ErrFs { no_existe: e.kind() == std::io::ErrorKind::NotFound, codigo: format!("{:?}", e.kind()), mensaje: e.to_string() }
    }
}

pub trait FsTickets {
    fn leer(&self, ruta: &Path) -> Result<String, ErrFs>;
    fn mtime_ms(&self, ruta: &Path) -> Result<f64, ErrFs>;
    fn renombrar(&self, de: &Path, a: &Path) -> Result<(), ErrFs>;
    fn escribir(&self, ruta: &Path, datos: &str) -> Result<(), ErrFs>;
    fn crear_carpeta(&self, ruta: &Path) -> Result<(), ErrFs>;
    /// Si es un archivo y cuánto pesa.
    fn info(&self, ruta: &Path) -> Result<InfoArchivo, ErrFs>;
    fn borrar(&self, ruta: &Path) -> Result<(), ErrFs>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InfoArchivo {
    pub es_archivo: bool,
    pub bytes: u64,
}

pub struct FsReal;

impl FsTickets for FsReal {
    fn leer(&self, ruta: &Path) -> Result<String, ErrFs> {
        std::fs::read_to_string(ruta).map_err(|e| ErrFs::de_io(&e))
    }

    fn mtime_ms(&self, ruta: &Path) -> Result<f64, ErrFs> {
        let m = std::fs::metadata(ruta).and_then(|m| m.modified()).map_err(|e| ErrFs::de_io(&e))?;
        let d = m.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
        // Como el mtimeMs de Node: milisegundos con fracción.
        Ok(d.as_secs_f64() * 1000.0)
    }

    fn renombrar(&self, de: &Path, a: &Path) -> Result<(), ErrFs> {
        std::fs::rename(de, a).map_err(|e| ErrFs::de_io(&e))
    }

    fn escribir(&self, ruta: &Path, datos: &str) -> Result<(), ErrFs> {
        std::fs::write(ruta, datos).map_err(|e| ErrFs::de_io(&e))
    }

    fn crear_carpeta(&self, ruta: &Path) -> Result<(), ErrFs> {
        std::fs::create_dir_all(ruta).map_err(|e| ErrFs::de_io(&e))
    }

    fn info(&self, ruta: &Path) -> Result<InfoArchivo, ErrFs> {
        let m = std::fs::metadata(ruta).map_err(|e| ErrFs::de_io(&e))?;
        Ok(InfoArchivo { es_archivo: m.is_file(), bytes: m.len() })
    }

    fn borrar(&self, ruta: &Path) -> Result<(), ErrFs> {
        std::fs::remove_file(ruta).map_err(|e| ErrFs::de_io(&e))
    }
}

pub struct OpcionesAlmacen {
    pub fs: Box<dyn FsTickets>,
    /// Donde están tickets.json y gruv.json.
    pub carpeta: PathBuf,
    pub log: Box<dyn Fn(&str)>,
    pub ahora: Box<dyn Fn() -> f64>,
}

/// Los repos de tickets.json, sin escribir ni migrar nada: para buscar conectores del equipo antes de cargar.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ConfigCruda {
    pub default_repo: Option<String>,
    pub project_repos: Ordenado<String>,
}

const NO_SE_GUARDA: &str = "Lo que cambies en esta sesión no se guarda";

fn aviso_solo_lectura(m: Option<SoloLectura>, sin_respaldo: bool) -> String {
    if sin_respaldo {
        return format!("No pude apartar el tickets.json anterior antes de reemplazarlo. {NO_SE_GUARDA}: cerrá Sloth y volvé a abrirlo.");
    }
    match m {
        Some(SoloLectura::Ilegible) => format!("No pude leer tickets.json (puede estar abierto en otro programa). {NO_SE_GUARDA}: cerrá Sloth y volvé a abrirlo."),
        Some(SoloLectura::VersionFutura) => format!("El archivo tickets.json es de una versión más nueva de Sloth. {NO_SE_GUARDA}, para no pisarlo: actualizá Sloth."),
        Some(SoloLectura::GruvIlegible) => format!("No pude leer gruv.json (puede estar abierto en otro programa). {NO_SE_GUARDA}, para no perder los tickets de antes: cerrá Sloth y volvé a abrirlo."),
        None => String::new(),
    }
}

fn repos_de(json: &Value) -> Option<ConfigCruda> {
    let o = json.as_object()?;
    let vacio = serde_json::Map::new();
    let c = o.get("config").and_then(Value::as_object).unwrap_or(&vacio);
    let mut out = ConfigCruda::default();
    if let Some(repos) = c.get("projectRepos").and_then(Value::as_object) {
        for (k, v) in repos {
            if let Some(s) = v.as_str() {
                out.project_repos.insert(k.clone(), s.to_string());
            }
        }
    }
    if let Some(d) = c.get("defaultRepo").and_then(Value::as_str).filter(|d| !d.is_empty()) {
        out.default_repo = Some(d.to_string());
    }
    Some(out)
}

pub struct Almacen {
    o: OpcionesAlmacen,
    archivo: PathBuf,
    solo_lectura: Option<String>,
    fallo: Option<String>,
    remigrado: Option<String>,
}

fn con_sufijo(p: &Path, sufijo: &str) -> PathBuf {
    let mut s = p.as_os_str().to_os_string();
    s.push(sufijo);
    PathBuf::from(s)
}

fn texto_ms(n: f64) -> String {
    super::texto::num_valor(n).to_string()
}

impl Almacen {
    pub fn nuevo(o: OpcionesAlmacen) -> Self {
        let archivo = o.carpeta.join("tickets.json");
        Almacen { o, archivo, solo_lectura: None, fallo: None, remigrado: None }
    }

    fn leer(&self, ruta: &Path) -> Lectura {
        let texto = match self.o.fs.leer(ruta) {
            Ok(t) => t,
            Err(e) if e.no_existe => return Lectura::Falta,
            Err(e) => return self.ilegible(ruta, &e),
        };
        match self.o.fs.mtime_ms(ruta) {
            Ok(m) => parsear_archivo(Some(&texto), m),
            Err(e) if e.no_existe => Lectura::Falta,
            Err(e) => self.ilegible(ruta, &e),
        }
    }

    fn ilegible(&self, ruta: &Path, e: &ErrFs) -> Lectura {
        (self.o.log)(&format!("tickets: no pude leer {}: {} {}", ruta.display(), e.codigo, e.mensaje));
        Lectura::Error(e.mensaje.clone())
    }

    fn apartar(&self, destino: &Path, motivo: &str) -> bool {
        match self.o.fs.renombrar(&self.archivo, destino) {
            Ok(()) => {
                (self.o.log)(&format!("tickets: tickets.json {motivo}, quedó en {}", destino.display()));
                true
            }
            Err(e) => {
                (self.o.log)(&format!("tickets: no pude apartar tickets.json: {} {}", e.codigo, e.mensaje));
                false
            }
        }
    }

    /// Si falla, el estado queda en memoria (y gruv.json se vuelve a migrar en el próximo arranque).
    fn escribir(&mut self, state: &TicketsState) -> bool {
        let res = (|| {
            self.o.fs.crear_carpeta(&self.o.carpeta)?;
            let tmp = con_sufijo(&self.archivo, ".tmp");
            let texto = serde_json::to_string_pretty(&state.a_valor()).map_err(|e| ErrFs { no_existe: false, codigo: "JSON".into(), mensaje: e.to_string() })?;
            self.o.fs.escribir(&tmp, &texto)?;
            self.o.fs.renombrar(&tmp, &self.archivo)
        })();
        match res {
            Ok(()) => {
                self.fallo = None;
                true
            }
            Err(e) => {
                (self.o.log)(&format!("tickets: no pude guardar tickets.json: {} {}", e.codigo, e.mensaje));
                self.fallo = Some(format!("No pude guardar tickets.json ({} {}). Si sigue pasando, lo que cambies se pierde al cerrar Sloth.", e.codigo, e.mensaje));
                false
            }
        }
    }

    /// Lee tickets.json (o migra gruv.json) y deja en disco lo que haga falta, si se puede.
    pub fn cargar(&mut self, buscar: Buscar) -> TicketsState {
        let ahora = (self.o.ahora)();
        let tickets = self.leer(&self.archivo.clone());
        let gruv = self.leer(&self.o.carpeta.join("gruv.json"));
        let r = resolver_estado(&tickets, &gruv, buscar, ahora);
        let sufijo = texto_ms(ahora);
        let bak = con_sufijo(&self.archivo, &format!(".bak-{sufijo}"));
        if r.solo_lectura.is_some() {
            self.solo_lectura = Some(aviso_solo_lectura(r.solo_lectura, false));
        } else if r.respaldar == Some(Respaldar::Corrupto) && !self.apartar(&con_sufijo(&self.archivo, &format!(".corrupt-{sufijo}")), "ilegible") {
            self.solo_lectura = Some(aviso_solo_lectura(None, true));
        } else if r.respaldar == Some(Respaldar::Previo) {
            if self.apartar(&bak, "reemplazado por gruv.json, que cambió") {
                self.remigrado = Some(format!("Volví a cargar gruv.json porque cambió desde la última vez. Tu tickets.json anterior quedó en {}.", bak.display()));
            } else {
                self.solo_lectura = Some(aviso_solo_lectura(None, true));
            }
        }
        if r.origen == Origen::Gruv {
            (self.o.log)(&format!("tickets: estado migrado desde gruv.json{}", if self.solo_lectura.is_some() { " (solo en memoria)" } else { "" }));
        }
        if let Some(m) = self.solo_lectura.clone() {
            (self.o.log)(&format!("tickets: {m}"));
        } else if r.guardar {
            self.escribir(&r.state);
        }
        r.state
    }

    /// Escribe tickets.json. En solo lectura no hace nada. true si quedó guardado.
    pub fn guardar(&mut self, state: &TicketsState) -> bool {
        if self.solo_lectura.is_some() {
            (self.o.log)("tickets: tickets.json no se guarda en esta sesión");
            return false;
        }
        self.escribir(state)
    }

    /// Para mostrar: por qué esta sesión no guarda, si falló el último guardado o si se reemplazó tickets.json.
    pub fn aviso(&self) -> Option<String> {
        let partes: Vec<&str> = [&self.solo_lectura, &self.fallo, &self.remigrado].into_iter().filter_map(|x| x.as_deref()).filter(|s| !s.is_empty()).collect();
        (!partes.is_empty()).then(|| partes.join(" "))
    }

    pub fn config_cruda(&self) -> Option<ConfigCruda> {
        match self.leer(&self.archivo) {
            Lectura::Ok { json, .. } => repos_de(&json),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::tickets::conectores::conector_por_id;
    use serde_json::json;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::rc::Rc;

    const AHORA: f64 = 1_700_000_000_000.0;

    fn carpeta() -> PathBuf {
        PathBuf::from("C:/datos/features")
    }
    fn tickets() -> PathBuf {
        carpeta().join("tickets.json")
    }
    fn gruv() -> PathBuf {
        carpeta().join("gruv.json")
    }

    const GRUV_V1: &str = r#"{"version":1,"tickets":[{"id":"TCK-1","titulo":"De gruv.json"}],"config":{"model":"sonnet"}}"#;

    fn v2(gruv_mtime: Option<f64>) -> String {
        let mut o = json!({ "version": 2, "tickets": [{ "id": "TCK-9", "titulo": "De tickets.json" }] });
        if let Some(m) = gruv_mtime {
            o["migradoDe"] = json!({ "archivo": "gruv.json", "en": 1, "gruvMtimeMs": m });
        }
        o["config"] = json!({ "conectorId": "gruv", "model": "opus", "assigneeId": "", "projectRepos": {}, "confirmRefresh": true });
        o.to_string()
    }

    #[derive(Default)]
    struct Estado {
        archivos: HashMap<PathBuf, (String, f64)>,
        ops: Vec<String>,
        logs: Vec<String>,
        leer_falla: HashMap<PathBuf, String>,
        apartar_falla: bool,
        escribir_falla: Option<String>,
    }

    type Falso = Rc<RefCell<Estado>>;

    struct FsFalso(Falso);

    fn err(c: &str) -> ErrFs {
        ErrFs { no_existe: c == "ENOENT", codigo: c.into(), mensaje: format!("{c}: falló") }
    }

    fn corto(p: &Path) -> String {
        p.file_name().unwrap().to_string_lossy().into_owned()
    }

    impl FsTickets for FsFalso {
        fn leer(&self, r: &Path) -> Result<String, ErrFs> {
            let s = self.0.borrow();
            if let Some(c) = s.leer_falla.get(r) {
                return Err(err(c));
            }
            s.archivos.get(r).map(|a| a.0.clone()).ok_or_else(|| err("ENOENT"))
        }
        fn mtime_ms(&self, r: &Path) -> Result<f64, ErrFs> {
            self.0.borrow().archivos.get(r).map(|a| a.1).ok_or_else(|| err("ENOENT"))
        }
        fn renombrar(&self, de: &Path, a: &Path) -> Result<(), ErrFs> {
            let mut s = self.0.borrow_mut();
            s.ops.push(format!("renombrar {} {}", corto(de), corto(a)));
            if s.apartar_falla && de == tickets() {
                return Err(err("EPERM"));
            }
            let x = s.archivos.remove(de).ok_or_else(|| err("ENOENT"))?;
            s.archivos.insert(a.to_path_buf(), x);
            Ok(())
        }
        fn escribir(&self, r: &Path, datos: &str) -> Result<(), ErrFs> {
            let mut s = self.0.borrow_mut();
            s.ops.push(format!("escribir {}", corto(r)));
            if let Some(c) = &s.escribir_falla {
                return Err(err(c));
            }
            s.archivos.insert(r.to_path_buf(), (datos.to_string(), AHORA));
            Ok(())
        }
        fn crear_carpeta(&self, _: &Path) -> Result<(), ErrFs> {
            Ok(())
        }
        fn info(&self, r: &Path) -> Result<InfoArchivo, ErrFs> {
            self.0.borrow().archivos.get(r).map(|a| InfoArchivo { es_archivo: true, bytes: a.0.len() as u64 }).ok_or_else(|| err("ENOENT"))
        }
        fn borrar(&self, r: &Path) -> Result<(), ErrFs> {
            self.0.borrow_mut().archivos.remove(r).map(|_| ()).ok_or_else(|| err("ENOENT"))
        }
    }

    fn falso(inicial: &[(PathBuf, &str, f64)]) -> Falso {
        let f: Falso = Rc::default();
        for (p, t, m) in inicial {
            f.borrow_mut().archivos.insert(p.clone(), (t.to_string(), *m));
        }
        f
    }

    fn almacen(f: &Falso, ahora: f64) -> Almacen {
        let logs = f.clone();
        Almacen::nuevo(OpcionesAlmacen {
            fs: Box::new(FsFalso(f.clone())),
            carpeta: carpeta(),
            log: Box::new(move |m| logs.borrow_mut().logs.push(m.to_string())),
            ahora: Box::new(move || ahora),
        })
    }

    fn buscar(id: &str) -> Option<&'static super::super::conector::ConectorDef> {
        conector_por_id(id)
    }

    fn guardar_ops() -> Vec<String> {
        vec!["escribir tickets.json.tmp".into(), "renombrar tickets.json.tmp tickets.json".into()]
    }

    fn ops(f: &Falso) -> Vec<String> {
        f.borrow().ops.clone()
    }

    fn en_disco(f: &Falso) -> Value {
        serde_json::from_str(&f.borrow().archivos.get(&tickets()).unwrap().0).unwrap()
    }

    fn gruv_intacto(f: &Falso, texto: Option<&str>) {
        let s = f.borrow();
        assert_eq!(s.archivos.get(&gruv()).map(|a| a.0.as_str()), texto);
        assert!(!s.ops.iter().any(|o| o.contains("gruv.json")), "{:?}", s.ops);
    }

    fn id0(s: &TicketsState) -> Value {
        s.tickets[0]["id"].clone()
    }

    #[test]
    fn sin_archivos_vacio_no_escribe_al_arrancar_y_guarda_despues() {
        let f = falso(&[]);
        let mut a = almacen(&f, AHORA);
        let s = a.cargar(&buscar);
        assert!(s.tickets.is_empty());
        assert!(ops(&f).is_empty());
        assert_eq!(a.aviso(), None);
        assert!(a.guardar(&s));
        assert_eq!(ops(&f), guardar_ops());
        gruv_intacto(&f, None);
    }

    #[test]
    fn migracion_inicial_guarda_con_el_mtime_de_gruv() {
        let f = falso(&[(gruv(), GRUV_V1, 500.0)]);
        let s = almacen(&f, AHORA).cargar(&buscar);
        assert_eq!(id0(&s), json!("TCK-1"));
        assert_eq!(ops(&f), guardar_ops());
        assert_eq!(en_disco(&f)["migradoDe"], json!({ "archivo": "gruv.json", "en": 1_700_000_000_000_i64, "gruvMtimeMs": 500 }));
        gruv_intacto(&f, Some(GRUV_V1));
    }

    #[test]
    fn gruv_cambio_respalda_como_bak_y_vuelve_a_migrar() {
        let previo = v2(Some(100.0));
        let f = falso(&[(tickets(), &previo, 900.0), (gruv(), GRUV_V1, 200.0)]);
        let mut a = almacen(&f, AHORA);
        let s = a.cargar(&buscar);
        assert_eq!(id0(&s), json!("TCK-1"));
        let mut esperado = vec!["renombrar tickets.json tickets.json.bak-1700000000000".to_string()];
        esperado.extend(guardar_ops());
        assert_eq!(ops(&f), esperado);
        assert_eq!(f.borrow().archivos.get(&carpeta().join("tickets.json.bak-1700000000000")).unwrap().0, previo);
        assert_eq!(en_disco(&f)["migradoDe"]["gruvMtimeMs"], json!(200));
        let aviso = a.aviso().unwrap();
        assert!(aviso.contains("Volví a cargar gruv.json") && aviso.contains("tickets.json.bak-1700000000000"));
        gruv_intacto(&f, Some(GRUV_V1));
    }

    #[test]
    fn mismo_mtime_que_el_migrado_no_migra_ni_escribe() {
        let f = falso(&[(tickets(), &v2(Some(200.0)), 100.0), (gruv(), GRUV_V1, 200.0)]);
        let s = almacen(&f, AHORA).cargar(&buscar);
        assert_eq!(id0(&s), json!("TCK-9"));
        assert!(ops(&f).is_empty());
    }

    #[test]
    fn gruv_con_mtime_en_el_futuro_migra_una_vez() {
        let futuro = AHORA + 365.0 * 24.0 * 3600.0 * 1000.0;
        let f = falso(&[(tickets(), &v2(None), AHORA), (gruv(), GRUV_V1, futuro)]);
        almacen(&f, AHORA).cargar(&buscar);
        let mut esperado = vec!["renombrar tickets.json tickets.json.bak-1700000000000".to_string()];
        esperado.extend(guardar_ops());
        assert_eq!(ops(&f), esperado);
        for ahora in [AHORA + 1.0, AHORA + 2.0] {
            f.borrow_mut().ops.clear();
            assert_eq!(id0(&almacen(&f, ahora).cargar(&buscar)), json!("TCK-1"));
            assert!(ops(&f).is_empty());
        }
        gruv_intacto(&f, Some(GRUV_V1));
    }

    #[test]
    fn tickets_corrupto_queda_como_corrupt_y_migra_gruv() {
        let f = falso(&[(tickets(), "{roto", 1.0), (gruv(), GRUV_V1, 2.0)]);
        let mut a = almacen(&f, AHORA);
        assert_eq!(id0(&a.cargar(&buscar)), json!("TCK-1"));
        let mut esperado = vec!["renombrar tickets.json tickets.json.corrupt-1700000000000".to_string()];
        esperado.extend(guardar_ops());
        assert_eq!(ops(&f), esperado);
        assert_eq!(f.borrow().archivos.get(&carpeta().join("tickets.json.corrupt-1700000000000")).unwrap().0, "{roto");
        assert_eq!(a.aviso(), None);
        gruv_intacto(&f, Some(GRUV_V1));
    }

    #[test]
    fn tickets_corrupto_sin_gruv_se_aparta_y_no_escribe_uno_vacio() {
        let f = falso(&[(tickets(), "[]", 1.0)]);
        almacen(&f, AHORA).cargar(&buscar);
        assert_eq!(ops(&f), vec!["renombrar tickets.json tickets.json.corrupt-1700000000000".to_string()]);
    }

    #[test]
    fn error_de_lectura_no_respalda_ni_escribe_en_toda_la_sesion() {
        for code in ["EBUSY", "EPERM", "EACCES"] {
            let t = v2(None);
            let f = falso(&[(tickets(), &t, 1.0), (gruv(), GRUV_V1, 2.0)]);
            f.borrow_mut().leer_falla.insert(tickets(), code.into());
            let mut a = almacen(&f, AHORA);
            let s = a.cargar(&buscar);
            assert_eq!(id0(&s), json!("TCK-1"), "trabaja en memoria con gruv.json");
            let aviso = a.aviso().unwrap();
            assert!(aviso.starts_with("No pude leer tickets.json") && aviso.contains("no se guarda"));
            assert!(!a.guardar(&s));
            assert!(ops(&f).is_empty());
            assert_eq!(f.borrow().archivos.get(&tickets()).unwrap().0, t);
            assert!(f.borrow().logs.iter().any(|l| l.contains(code)));
            gruv_intacto(&f, Some(GRUV_V1));
        }
    }

    #[test]
    fn error_al_leer_gruv_tickets_manda_y_no_se_toca() {
        let f = falso(&[(tickets(), &v2(Some(5.0)), 1.0), (gruv(), GRUV_V1, 9.0)]);
        f.borrow_mut().leer_falla.insert(gruv(), "EBUSY".into());
        let mut a = almacen(&f, AHORA);
        assert_eq!(id0(&a.cargar(&buscar)), json!("TCK-9"));
        assert!(ops(&f).is_empty());
        assert_eq!(a.aviso(), None);
    }

    #[test]
    fn sin_tickets_valido_y_gruv_ilegible_no_guarda_y_migra_en_el_proximo_arranque() {
        for con_roto in [false, true] {
            let mut ini = vec![(gruv(), GRUV_V1, 500.0)];
            if con_roto {
                ini.push((tickets(), "{roto", 1.0));
            }
            let f = falso(&ini);
            f.borrow_mut().leer_falla.insert(gruv(), "EBUSY".into());
            let mut a = almacen(&f, AHORA);
            let mut s = a.cargar(&buscar);
            assert!(s.tickets.is_empty());
            let aviso = a.aviso().unwrap();
            assert!(aviso.starts_with("No pude leer gruv.json") && aviso.contains("no se guarda"));
            s.tickets.push(json!({ "id": "TCK-77", "titulo": "De esta sesión" }).as_object().unwrap().clone());
            assert!(!a.guardar(&s));
            assert!(ops(&f).is_empty());
            let copia: Vec<(PathBuf, String, f64)> = f.borrow().archivos.iter().map(|(k, v)| (k.clone(), v.0.clone(), v.1)).collect();
            let f2 = falso(&copia.iter().map(|(p, t, m)| (p.clone(), t.as_str(), *m)).collect::<Vec<_>>());
            let mut b = almacen(&f2, AHORA + 1.0);
            assert_eq!(id0(&b.cargar(&buscar)), json!("TCK-1"));
            assert_eq!(en_disco(&f2)["migradoDe"]["gruvMtimeMs"], json!(500));
            assert!(!ops(&f2).iter().any(|o| o.contains(".bak")), "{:?}", ops(&f2));
            gruv_intacto(&f2, Some(GRUV_V1));
        }
    }

    #[test]
    fn version_futura_no_renombra_ni_escribe_y_avisa() {
        let futuro = json!({ "version": 3, "cosas": "nuevas" }).to_string();
        for con_gruv in [true, false] {
            let mut ini = vec![(tickets(), futuro.as_str(), 1.0)];
            if con_gruv {
                ini.push((gruv(), GRUV_V1, 2.0));
            }
            let f = falso(&ini);
            let mut a = almacen(&f, AHORA);
            let mut s = a.cargar(&buscar);
            assert_eq!(s.tickets.len(), usize::from(con_gruv));
            assert!(a.aviso().unwrap().contains("versión más nueva de Sloth"));
            s.tickets.push(json!({ "id": "TCK-5", "titulo": "Cambio" }).as_object().unwrap().clone());
            assert!(!a.guardar(&s));
            assert!(ops(&f).is_empty());
            assert_eq!(f.borrow().archivos.get(&tickets()).unwrap().0, futuro);
            gruv_intacto(&f, con_gruv.then_some(GRUV_V1));
        }
    }

    #[test]
    fn si_falla_guardar_avisa_con_el_motivo_y_el_aviso_se_va_al_volver_a_guardar() {
        let f = falso(&[]);
        f.borrow_mut().escribir_falla = Some("ENOSPC".into());
        let mut a = almacen(&f, AHORA);
        let s = a.cargar(&buscar);
        assert_eq!(a.aviso(), None);
        assert!(!a.guardar(&s));
        assert!(a.aviso().unwrap().starts_with("No pude guardar tickets.json (ENOSPC"));
        assert!(f.borrow().logs.iter().any(|l| l.contains("ENOSPC")));
        f.borrow_mut().escribir_falla = None;
        assert!(a.guardar(&s));
        assert_eq!(a.aviso(), None);
    }

    #[test]
    fn si_no_se_puede_apartar_tickets_no_se_guarda_en_toda_la_sesion() {
        for (texto, motivo) in [("{roto".to_string(), "corrupt"), (v2(Some(1.0)), "bak")] {
            let f = falso(&[(tickets(), &texto, 1.0), (gruv(), GRUV_V1, 2.0)]);
            f.borrow_mut().apartar_falla = true;
            let mut a = almacen(&f, AHORA);
            let s = a.cargar(&buscar);
            let esperado = vec![format!("renombrar tickets.json tickets.json.{motivo}-1700000000000")];
            assert_eq!(ops(&f), esperado);
            assert!(a.aviso().unwrap().contains("No pude apartar"));
            assert!(!a.guardar(&s));
            assert_eq!(ops(&f), esperado);
            assert_eq!(f.borrow().archivos.get(&tickets()).unwrap().0, texto);
            gruv_intacto(&f, Some(GRUV_V1));
        }
    }

    #[test]
    fn config_cruda_lee_los_repos_sin_escribir_ni_migrar() {
        let texto = json!({ "version": 2, "tickets": [], "config": { "conectorId": "gruv", "defaultRepo": "C:/repo", "projectRepos": { "Web": "C:/web", "Malo": 7 } } }).to_string();
        let f = falso(&[(tickets(), &texto, 1.0), (gruv(), GRUV_V1, 500.0)]);
        let c = almacen(&f, AHORA).config_cruda().unwrap();
        assert_eq!(c.default_repo.as_deref(), Some("C:/repo"));
        assert_eq!(c.project_repos.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect::<Vec<_>>(), vec![("Web", "C:/web")]);
        assert!(ops(&f).is_empty());
    }

    #[test]
    fn config_cruda_sin_tickets_danado_o_raro_da_none() {
        for ini in [vec![], vec![(tickets(), "{roto", 1.0)], vec![(tickets(), "[1]", 1.0)]] {
            let f = falso(&ini);
            assert_eq!(almacen(&f, AHORA).config_cruda(), None);
            assert!(ops(&f).is_empty());
        }
        let t = json!({ "version": 2, "config": { "defaultRepo": 3 } }).to_string();
        let f = falso(&[(tickets(), &t, 1.0)]);
        assert_eq!(almacen(&f, AHORA).config_cruda(), Some(ConfigCruda::default()));
    }
}
