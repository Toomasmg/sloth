use super::*;
use std::sync::atomic::{AtomicU32, Ordering};

struct Temporal(PathBuf);

impl Temporal {
    fn nuevo() -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!("sloth-enlace-rs-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
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

#[test]
fn normaliza_barras_mayusculas_y_prefijos() {
    assert_eq!(normalizar_ruta(r"C:\Users\Maria\.claude\"), r"c:\users\maria\.claude");
    assert_eq!(normalizar_ruta("C:/Users//Maria/.claude"), r"c:\users\maria\.claude");
    assert_eq!(normalizar_ruta(r"\??\C:\Users\Maria"), r"c:\users\maria");
    assert_eq!(normalizar_ruta(r"\\?\C:\Users\Maria"), r"c:\users\maria");
    assert_eq!(normalizar_ruta(r"\\servidor\recurso\x"), r"\\servidor\recurso\x");
}

#[test]
fn el_buffer_de_junction_tiene_el_formato_de_windows() {
    let b = buffer_de_junction(r"C:\a\b\").unwrap();
    let u16_en = |i: usize| u16::from_le_bytes([b[i], b[i + 1]]) as usize;
    assert_eq!(u32::from_le_bytes([b[0], b[1], b[2], b[3]]), 0xA000_0003);
    let sustituto = r"\??\C:\a\b".encode_utf16().count() * 2;
    let imprimible = r"C:\a\b".encode_utf16().count() * 2;
    assert_eq!([u16_en(8), u16_en(10), u16_en(12), u16_en(14)], [0, sustituto, sustituto + 2, imprimible]);
    assert_eq!(u16_en(4), 8 + sustituto + 2 + imprimible + 2);
    assert_eq!(b.len(), 8 + u16_en(4));
    let nombre = |desde: usize, largo: usize| String::from_utf16(&(0..largo / 2).map(|k| u16_en(16 + desde + k * 2) as u16).collect::<Vec<_>>()).unwrap();
    assert_eq!(nombre(0, sustituto), r"\??\C:\a\b");
    assert_eq!(nombre(sustituto + 2, imprimible), r"C:\a\b");
    assert_eq!(u16_en(16 + sustituto), 0);
}

#[test]
fn una_ruta_demasiado_larga_no_entra_en_el_buffer() {
    assert!(buffer_de_junction(&format!("C:\\{}", "a".repeat(9000))).is_err());
}

#[test]
fn crea_un_enlace_que_se_reconoce_se_atraviesa_y_se_quita_sin_borrar_el_destino() {
    let t = Temporal::nuevo();
    let destino = t.0.join("destino");
    fs::create_dir_all(&destino).unwrap();
    fs::write(destino.join("a.txt"), "hola").unwrap();
    let enlace = t.0.join("enlace");
    crear_enlace_carpeta(&destino, &enlace).unwrap();
    assert!(es_enlace_a(&enlace, &destino));
    assert!(!es_enlace_a(&enlace, &t.0.join("otro")));
    assert!(!es_enlace_a(&destino, &destino), "una carpeta común no es un enlace");
    assert_eq!(fs::read_to_string(enlace.join("a.txt")).unwrap(), "hola");
    quitar_enlace(&enlace).unwrap();
    assert!(!enlace.exists() && !es_enlace_roto(&enlace));
    assert!(destino.join("a.txt").exists());
    quitar_enlace(&enlace).unwrap();
}

#[test]
fn un_enlace_con_el_destino_borrado_cuenta_como_roto() {
    let t = Temporal::nuevo();
    let destino = t.0.join("destino");
    fs::create_dir_all(&destino).unwrap();
    let enlace = t.0.join("enlace");
    crear_enlace_carpeta(&destino, &enlace).unwrap();
    fs::remove_dir_all(&destino).unwrap();
    assert!(!enlace.exists());
    assert!(es_enlace_roto(&enlace));
    quitar_enlace(&enlace).unwrap();
    assert!(!es_enlace_roto(&enlace));
}

#[test]
fn no_pisa_algo_que_ya_esta_en_ese_nombre() {
    let t = Temporal::nuevo();
    let destino = t.0.join("destino");
    fs::create_dir_all(&destino).unwrap();
    assert!(crear_enlace_carpeta(&destino, &destino).is_err());
    assert!(destino.exists());
}
