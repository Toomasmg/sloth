use super::*;
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::sync::Arc;

struct Temporal(PathBuf);

impl Temporal {
    fn nuevo() -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!("sloth-logger-rs-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        Temporal(d)
    }

    fn logs(&self) -> PathBuf {
        self.0.join("logs")
    }

    fn leer(&self) -> String {
        fs::read_to_string(self.logs().join("sloth.log")).unwrap()
    }

    fn nombres(&self) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(self.logs()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }
}

impl Drop for Temporal {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const CASA: &str = "casa-de-maria";

// Un redactor mínimo: la redacción real se prueba donde vive.
fn redactor() -> Redactor {
    Box::new(|s| {
        let mut t = s.replace(CASA, "~").replace("me@empresa.com", "[email]").replace("hunter2", "[redactado]");
        while let Some(i) = t.find("ghp_") {
            let fin = t[i..].find(|c: char| !c.is_ascii_alphanumeric() && c != '_').map_or(t.len(), |f| i + f);
            t.replace_range(i..fin, "[token]");
        }
        t
    })
}

fn opts(t: &Temporal) -> OpcionesLogger {
    OpcionesLogger::nuevas(t.logs(), redactor())
}

fn con_reloj(mut o: OpcionesLogger, t: &Arc<AtomicI64>) -> OpcionesLogger {
    let t = Arc::clone(t);
    o.ahora = Box::new(move || t.load(Ordering::SeqCst));
    o
}

#[test]
fn escribe_lineas_con_fecha_nivel_y_origen_y_las_devuelve_en_recientes() {
    let t = Temporal::nuevo();
    let reloj = Arc::new(AtomicI64::new(1_794_916_800_000));
    let log = Logger::nuevo(con_reloj(opts(&t), &reloj));
    log.info("main", "arrancó");
    reloj.fetch_add(1000, Ordering::SeqCst);
    log.aviso("avisos", "archivo dañado");
    reloj.fetch_add(1000, Ordering::SeqCst);
    log.error("renderer", "se rompió");
    let texto = t.leer();
    let lineas: Vec<&str> = texto.trim_end().split('\n').collect();
    assert_eq!(lineas, ["2026-11-17T12:00:00.000Z info [main] arrancó", "2026-11-17T12:00:01.000Z aviso [avisos] archivo dañado", "2026-11-17T12:00:02.000Z error [renderer] se rompió"]);
    let niveles: Vec<Nivel> = log.recientes(2).iter().map(|e| e.nivel).collect();
    assert_eq!(niveles, [Nivel::Aviso, Nivel::Error]);
    assert_eq!(log.recientes(50).len(), 3);
    assert_eq!(log.fallo(), None);
}

#[test]
fn una_entrada_es_una_sola_linea_aunque_traiga_saltos() {
    let t = Temporal::nuevo();
    let log = Logger::nuevo(opts(&t));
    log.aviso("x", "uno\ndos\r\ntres");
    let texto = t.leer();
    assert_eq!(texto.trim_end().split('\n').count(), 1);
    assert!(texto.contains("uno | dos | tres"), "{texto}");
}

#[test]
fn los_blancos_sin_salto_se_dejan_como_estan() {
    assert_eq!(una_linea("a  b\tc"), "a  b\tc");
    assert_eq!(una_linea("a \n\n  b"), "a | b");
    assert_eq!(una_linea("\nfin\r\n"), " | fin | ");
}

#[test]
fn redacta_antes_de_escribir_y_antes_de_guardar_en_memoria() {
    let t = Temporal::nuevo();
    let log = Logger::nuevo(opts(&t));
    let token = format!("ghp_{}wxyz", "a1B2c3D4".repeat(4));
    log.error("main", format!("falló con {token} en {CASA}/repo/x.ts para me@empresa.com"));
    log.aviso("main", "password=hunter2");
    let texto = t.leer();
    let memoria = format!("{:?}", log.recientes(10));
    for s in [token.as_str(), CASA, "me@empresa.com", "hunter2"] {
        assert!(!texto.contains(s), "se coló {s}");
        assert!(!memoria.contains(s), "se coló {s} en memoria");
    }
    assert!(texto.contains("[token]") && texto.contains('~'));
}

#[test]
fn acota_las_lineas_largas() {
    let t = Temporal::nuevo();
    let log = Logger::nuevo(opts(&t));
    log.info("main", &"z".repeat(50_000));
    let linea = t.leer();
    assert!(linea.len() < 4200);
    assert!(linea.ends_with("…[cortado]\n"), "{linea}");
}

#[test]
fn errores_de_cualquier_tipo_se_escriben_igual() {
    let t = Temporal::nuevo();
    let log = Logger::nuevo(opts(&t));
    log.error("main", "texto suelto");
    log.error("main", 42);
    log.error("main", std::io::Error::other("raro"));
    assert_eq!(log.recientes(10).len(), 3);
    assert_eq!(log.fallo(), None);
}

#[test]
fn con_causas_junta_la_cadena_de_errores() {
    #[derive(Debug)]
    struct Externo(std::io::Error);
    impl Display for Externo {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "no se pudo leer")
        }
    }
    impl std::error::Error for Externo {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(&self.0)
        }
    }
    assert_eq!(con_causas(&Externo(std::io::Error::other("disco lleno"))), "no se pudo leer\ncausado por: disco lleno");
}

#[test]
fn rota_por_tamano_sin_pasar_de_mantener_mas_1_archivos() {
    let t = Temporal::nuevo();
    let mut o = opts(&t);
    o.max = 300;
    o.mantener = 3;
    let log = Logger::nuevo(o);
    for i in 0..80 {
        log.info("main", &format!("línea número {i} con algo de relleno para ocupar lugar"));
    }
    assert_eq!(t.nombres(), ["sloth.1.log", "sloth.2.log", "sloth.3.log", "sloth.log"]);
    assert!(t.leer().contains("línea número 79"));
    assert_eq!(log.fallo(), None);
}

#[test]
fn la_rotacion_no_toca_archivos_ajenos_de_la_carpeta() {
    let t = Temporal::nuevo();
    let mut o = opts(&t);
    o.max = 200;
    o.mantener = 1;
    let log = Logger::nuevo(o);
    fs::write(t.logs().join("sesion.json"), "{}").unwrap();
    for i in 0..20 {
        log.info("main", &format!("relleno relleno relleno relleno {i}"));
    }
    assert_eq!(t.nombres(), ["sesion.json", "sloth.1.log", "sloth.log"]);
}

#[test]
fn retoma_un_log_que_ya_existia() {
    let t = Temporal::nuevo();
    Logger::nuevo(opts(&t)).info("main", "primera");
    Logger::nuevo(opts(&t)).info("main", "segunda");
    assert_eq!(t.leer().trim_end().split('\n').count(), 2);
}

#[test]
fn con_la_carpeta_inescribible_no_falla_informa_y_sigue_en_memoria() {
    let t = Temporal::nuevo();
    let archivo = t.0.join("es-un-archivo");
    fs::write(&archivo, "x").unwrap();
    let log = Logger::nuevo(OpcionesLogger::nuevas(archivo.join("logs"), redactor()));
    assert!(log.fallo().is_some_and(|f| !f.is_empty()));
    log.error("main", "sigue andando");
    assert_eq!(log.recientes(5).len(), 1);
}

#[test]
fn si_falla_el_append_mas_tarde_guarda_el_motivo_y_no_falla() {
    let t = Temporal::nuevo();
    let log = Logger::nuevo(opts(&t));
    log.info("main", "ok");
    fs::remove_dir_all(t.logs()).unwrap();
    fs::write(t.logs(), "ahora soy un archivo").unwrap();
    log.info("main", "otra");
    assert!(log.fallo().is_some());
    assert_eq!(log.recientes(5).len(), 2);
}

#[test]
fn solo_memoria_no_crea_nada_en_disco() {
    let t = Temporal::nuevo();
    let mut o = opts(&t);
    o.solo_memoria = true;
    let log = Logger::nuevo(o);
    log.info("main", "hola");
    assert_eq!(fs::read_dir(&t.0).unwrap().count(), 0);
    assert_eq!(log.recientes(1)[0].msg, "hola");
}

#[test]
fn el_buffer_en_memoria_guarda_las_ultimas_200() {
    let mut o = OpcionesLogger::nuevas("", redactor());
    o.solo_memoria = true;
    let log = Logger::nuevo(o);
    for i in 0..250 {
        log.info("main", &format!("n{i}"));
    }
    let todas = log.recientes(1000);
    assert_eq!(todas.len(), 200);
    assert_eq!(todas[0].msg, "n50");
    assert_eq!(todas[199].msg, "n249");
    assert!(log.recientes(0).is_empty());
}

#[test]
fn iso_utc_coincide_con_to_iso_string() {
    assert_eq!(iso_utc(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso_utc(1_794_916_800_123), "2026-11-17T12:00:00.123Z");
    assert_eq!(iso_utc(951_782_400_000), "2000-02-29T00:00:00.000Z");
    assert_eq!(iso_utc(-1), "1969-12-31T23:59:59.999Z");
}
