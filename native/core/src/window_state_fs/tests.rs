use super::*;
use std::sync::atomic::{AtomicU32, Ordering};

struct Temporal(PathBuf);

impl Temporal {
    fn nuevo() -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!("sloth-ventana-rs-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        Temporal(d)
    }
}

impl Drop for Temporal {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn r(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect { x, y, width: w, height: h }
}
const PANTALLA: Rect = Rect { x: 0.0, y: 0.0, width: 1920.0, height: 1040.0 };

#[test]
fn guarda_y_vuelve_a_cargar_lo_mismo() {
    let t = Temporal::nuevo();
    let f = ruta_estado(&t.0);
    guardar_estado(&f, r(100.0, 80.0, 1280.0, 800.0), true).unwrap();
    assert_eq!(cargar_estado(&f, &[PANTALLA]).unwrap(), EstadoCargado { bounds: Some(r(100.0, 80.0, 1280.0, 800.0)), maximized: true });
    assert!(!t.0.join("window-state.json.tmp").exists());
}

#[test]
fn el_json_es_el_mismo_que_escribia_electron() {
    assert_eq!(texto_de_estado(r(-8.0, 0.0, 1200.0, 800.0), false), r#"{"bounds":{"x":-8,"y":0,"width":1200,"height":800},"maximized":false}"#);
}

#[test]
fn sin_archivo_o_roto_arranca_vacio() {
    let t = Temporal::nuevo();
    let f = ruta_estado(&t.0);
    assert_eq!(cargar_estado(&f, &[PANTALLA]).unwrap(), EstadoCargado::default());
    fs::write(&f, "{ roto").unwrap();
    assert_eq!(cargar_estado(&f, &[PANTALLA]).unwrap(), EstadoCargado::default());
}

#[test]
fn si_el_monitor_ya_no_esta_arranca_vacio_aunque_estuviera_maximizada() {
    let t = Temporal::nuevo();
    let f = ruta_estado(&t.0);
    guardar_estado(&f, r(3000.0, 0.0, 1000.0, 600.0), true).unwrap();
    assert_eq!(cargar_estado(&f, &[PANTALLA]).unwrap(), EstadoCargado::default());
}

#[test]
fn un_maximized_que_no_es_true_cuenta_como_false() {
    let t = Temporal::nuevo();
    let f = ruta_estado(&t.0);
    fs::write(&f, r#"{"bounds":{"x":0,"y":0,"width":1000,"height":600},"maximized":"si"}"#).unwrap();
    assert!(!cargar_estado(&f, &[PANTALLA]).unwrap().maximized);
}

#[test]
fn un_archivo_ilegible_se_informa_para_el_log() {
    let t = Temporal::nuevo();
    let f = ruta_estado(&t.0);
    fs::create_dir_all(&f).unwrap();
    assert!(cargar_estado(&f, &[PANTALLA]).is_err());
}

#[test]
fn si_no_se_puede_guardar_no_deja_el_tmp() {
    let t = Temporal::nuevo();
    let f = ruta_estado(&t.0);
    fs::create_dir_all(&f).unwrap();
    assert!(guardar_estado(&f, r(0.0, 0.0, 1000.0, 600.0), false).is_err());
    assert!(!t.0.join("window-state.json.tmp").exists());
}
