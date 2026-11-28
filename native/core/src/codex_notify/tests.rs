use super::*;
use serde_json::json;
use std::cell::RefCell;
use std::sync::atomic::{AtomicU32, Ordering};
use CambioNotify::*;

const LINEA: &str = r#"notify = ["node", "C:\\Users\\a b\\sloth-notify.cjs"] # sloth-notify"#;

fn aplicar(toml: &str) -> (String, CambioNotify) {
    aplicar_notify(toml, LINEA)
}

fn quitado(toml: &str, quitada: bool) -> NotifyQuitado {
    NotifyQuitado { toml: toml.into(), quitada, dudoso: false }
}

#[test]
fn linea_notify_escapa_barras_y_comillas_y_lleva_la_marca() {
    assert_eq!(linea_notify("node", "C:\\Users\\a b\\x.js").as_deref(), Some(r#"notify = ["node", "C:\\Users\\a b\\x.js"] # sloth-notify"#));
    assert_eq!(linea_notify("node", "C:/d\"x/y.js").as_deref(), Some(r#"notify = ["node", "C:/d\"x/y.js"] # sloth-notify"#));
    assert!(linea_notify("node", "x").unwrap().ends_with(NOTIFY_MARCA));
}

#[test]
fn linea_notify_no_escribe_rutas_con_saltos_de_linea_o_caracteres_de_control() {
    for (exe, script) in [("node", "C:/a\nnotify = [\"x\"]"), ("node", "C:/a\r/x.js"), ("no\u{0}de", "x"), ("", "x"), ("node", "")] {
        assert_eq!(linea_notify(exe, script), None, "{exe:?} {script:?}");
    }
}

#[test]
fn archivo_vacio_se_agrega_la_linea_con_salto() {
    assert_eq!(aplicar(""), (format!("{LINEA}\n"), Agregada));
}

#[test]
fn con_solo_el_almacen_de_credenciales_la_linea_va_antes_y_el_resto_queda_igual() {
    let base = "cli_auth_credentials_store = \"file\"\n";
    assert_eq!(aplicar(base), (format!("{LINEA}\n{base}"), Agregada));
}

#[test]
fn con_una_tabla_la_linea_va_antes_de_la_primera_tabla_nunca_dentro() {
    let base = "model = \"x\"\n\n[mcp_servers.x]\ncommand = \"y\"\n";
    let (t, c) = aplicar(base);
    assert_eq!((t.as_str(), c), (format!("{LINEA}\n{base}").as_str(), Agregada));
    assert!(t.find("notify").unwrap() < t.find("[mcp_servers.x]").unwrap());
}

#[test]
fn un_notify_ajeno_no_se_toca() {
    let base = "notify = [\"python\", \"avisar.py\"]\n[tui]\nx = 1\n";
    assert_eq!(aplicar(base), (base.to_string(), Ajeno));
    assert_eq!(aplicar("\"notify\" = [\"a\"]\n").1, Ajeno);
    let multilinea = "notify = [\n  \"a\",\n  \"b\",\n]\n";
    assert_eq!(aplicar(multilinea), (multilinea.to_string(), Ajeno));
}

#[test]
fn una_marca_vieja_con_otra_ruta_se_reemplaza_e_igual_no_cambia_nada() {
    let vieja = "notify = [\"node\", \"C:/viejo.cjs\"] # sloth-notify\nmodel = \"x\"\n";
    assert_eq!(aplicar(vieja), (format!("{LINEA}\nmodel = \"x\"\n"), Actualizada));
    let igual = format!("{LINEA}\nmodel = \"x\"\n");
    assert_eq!(aplicar(&igual), (igual.clone(), Igual));
}

#[test]
fn crlf_la_linea_nueva_usa_crlf_y_el_resto_queda_byte_a_byte() {
    let base = "a = 1\r\n[t]\r\nb = 2\r\n";
    assert_eq!(aplicar(base).0, format!("{LINEA}\r\n{base}"));
    let vieja = "notify = [\"node\", \"x\"] # sloth-notify\r\nb = 2\r\n";
    assert_eq!(aplicar(vieja).0, format!("{LINEA}\r\nb = 2\r\n"));
}

#[test]
fn bom_se_conserva_al_principio_del_archivo() {
    assert_eq!(aplicar("\u{feff}a = 1\n").0, format!("\u{feff}{LINEA}\na = 1\n"));
    let con_marca = format!("\u{feff}notify = [\"node\", \"x\"] {NOTIFY_MARCA}\na = 1\n");
    assert_eq!(aplicar(&con_marca).0, format!("\u{feff}{LINEA}\na = 1\n"));
    assert_eq!(aplicar("\u{feff}notify = [\"a\"]\n").1, Ajeno);
}

#[test]
fn un_comentario_que_dice_notify_no_cuenta() {
    let base = "# notify = [\"x\"]\na = 1\n";
    assert_eq!(aplicar(base), (format!("{LINEA}\n{base}"), Agregada));
}

#[test]
fn notify_dentro_de_una_tabla_o_de_una_cadena_multilinea_no_cuenta() {
    let en_tabla = "[tui]\nnotify = [\"x\"]\n";
    assert_eq!(aplicar(en_tabla), (format!("{LINEA}\n{en_tabla}"), Agregada));
    let en_cadena = "instrucciones = \"\"\"\nnotify = [\"x\"]\n[otra]\n\"\"\"\nb = 1\n";
    assert_eq!(aplicar(en_cadena), (format!("{LINEA}\n{en_cadena}"), Agregada));
    assert_eq!(aplicar("x = '''\nnotify = [\"x\"]\n'''\n").1, Agregada);
}

#[test]
fn un_array_de_otra_clave_que_sigue_en_la_linea_de_abajo_no_se_toma_por_una_tabla() {
    assert_eq!(aplicar("lista = [\n  [\"a\"],\n  [\"b\"]\n]\nnotify = [\"x\"]\n").1, Ajeno);
}

#[test]
fn ruta_de_windows_con_espacios_y_barras() {
    let l = linea_notify("node", "C:\\Users\\a b\\x.js").unwrap();
    let (t, _) = aplicar_notify("", &l);
    assert_eq!(t, format!("{l}\n"));
    assert!(t.contains("C:\\\\Users\\\\a b\\\\x.js"));
}

#[test]
fn quitar_notify_saca_solo_la_linea_de_sloth_y_deja_el_resto_como_estaba() {
    let base = "cli_auth_credentials_store = \"file\"\n\n[tui]\nx = 1\n";
    assert_eq!(quitar_notify(&aplicar(base).0), quitado(base, true));
    for b in ["a = 1\r\n[t]\r\n", "\u{feff}a = 1\n", ""] {
        assert_eq!(quitar_notify(&aplicar(b).0).toml, b, "{b:?}");
    }
}

#[test]
fn quitar_notify_no_toca_un_notify_ajeno_ni_un_archivo_sin_notify() {
    for b in ["notify = [\"python\", \"x.py\"]\n", "a = 1\n", ""] {
        assert_eq!(quitar_notify(b), quitado(b, false));
    }
}

fn cuantos_notify_de_raiz(toml: &str) -> usize {
    analizar(toml).unwrap().iter().filter(|x| x.tipo == Tipo::Clave && x.tabla.is_empty() && x.ruta[0] == "notify").count()
}

#[test]
fn una_cadena_triple_con_comillas_escapadas_no_esconde_el_notify_del_usuario() {
    let base = "a = \"\"\"x \\\"\"\" y\"\"\"\nnotify = [\"py\", \"n.py\"]\n";
    assert_eq!(aplicar(base), (base.to_string(), Ajeno));
    for b in ["a = \"\"\"x \\\\\"\"\"\nnotify = [\"py\"]\n", "a = \"\"\"x\"\"\"\"\nnotify = [\"py\"]\n", "a = \"\"\"uno \\\n   dos\"\"\"\nnotify = [\"py\"]\n"] {
        assert_eq!(aplicar(b).1, Ajeno, "{b:?}");
    }
}

#[test]
fn cadenas_literales_la_barra_no_escapa_y_un_notify_adentro_no_cuenta() {
    assert_eq!(aplicar("a = '''x \\'''\nnotify = [\"py\"]\n").1, Ajeno);
    let (t, c) = aplicar("a = '''\nnotify = [\"x\"]\n\"\"\"\n'''\n");
    assert_eq!(c, Agregada);
    assert_eq!(cuantos_notify_de_raiz(&t), 1);
    assert_eq!(aplicar("a = 'C:\\x' # c\nnotify = [\"p\"]\n").1, Ajeno);
}

#[test]
fn notify_solo_dentro_de_una_tabla_o_de_una_tabla_en_linea_se_agrega_el_de_raiz_y_queda_uno() {
    for base in ["[tui]\nnotify = [\"x\"]\n", "x = { notify = 1 }\n", "[[hooks]]\nnotify = 1\n", "[a.notify]\nb = 1\n"] {
        let (t, c) = aplicar(base);
        assert_eq!(c, Agregada, "{base:?}");
        assert_eq!(cuantos_notify_de_raiz(&t), 1, "{base:?}");
        assert_eq!(verificar_cambio(base, &t, true), None, "{base:?}");
    }
}

#[test]
fn notify_con_comentario_al_final_con_comillas_o_con_escapes_en_la_clave_es_del_usuario() {
    for base in ["notify = [\"a\"] # mi aviso\n", "\"notify\" = [\"a\"]\n", "'notify' = [\"a\"]\n", "\"not\\u0069fy\" = [\"a\"]\n", "notify=[\"a\"]\n", "  notify   =   [ \"a\" ]  \n"] {
        assert_eq!(aplicar(base).1, Ajeno, "{base:?}");
    }
    assert_eq!(aplicar("\"no.tify\" = 1\n").1, Agregada);
    assert_eq!(aplicar("\"notify.x\" = 1\n").1, Agregada);
}

#[test]
fn notify_como_tabla_o_con_clave_punteada_choca_con_el_de_raiz() {
    for base in ["[notify]\nx = 1\n", "[ \"notify\" ]\n", "[[notify]]\n", "notify.x = 1\n", "[notify.sub]\n"] {
        assert_eq!(aplicar(base).1, Ajeno, "{base:?}");
    }
}

#[test]
fn una_marca_que_no_es_un_comentario_real_no_hace_nuestra_a_la_linea() {
    for base in ["notify = [\"a # sloth-notify\"]\n", "notify = [\"a\"] # x # sloth-notify\n", "notify = [\n \"a\",\n] # sloth-notify\n"] {
        assert_eq!(aplicar(base).1, Ajeno, "{base:?}");
    }
}

#[test]
fn strings_con_numeral_y_corchetes_arrays_con_comentarios_y_fechas_no_confunden_al_escaner() {
    let base = "a = \"x # y [z]\"\nl = [\n  \"]\", # c\n  \"[t]\"\n]\nd = 1979-05-27 07:32:00Z\nh = 07:32:00\nn = { a = [1, 2], b = \"c\" }\nnotify = [\"py\"]\n[t]\nx = 1\n";
    assert_eq!(aplicar(base).1, Ajeno);
    let sin = base.replace("notify = [\"py\"]\n", "");
    assert_eq!(aplicar(&sin), (format!("{LINEA}\n{sin}"), Agregada));
}

#[test]
fn crlf_y_bom_combinados_con_cadenas_multilinea() {
    let base = "\u{feff}a = \"\"\"x \\\"\"\" y\"\"\"\r\nb = 1\r\n[t]\r\nc = 2\r\n";
    let (t, _) = aplicar(base);
    assert_eq!(t, format!("\u{feff}{LINEA}\r\n{}", &base['\u{feff}'.len_utf8()..]));
    assert_eq!(quitar_notify(&t), quitado(base, true));
    assert_eq!(aplicar("\u{feff}a = \"\"\"x \\\"\"\" y\"\"\"\r\nnotify = [\"p\"]\r\n").1, Ajeno);
}

#[test]
fn un_toml_que_no_cierra_o_con_claves_repetidas_es_dudoso() {
    for base in ["a = \"\"\"sin cerrar\nnotify = [\"x\"]\n", "a = \"sin cerrar\n", "a = [1, 2\n", "a = 1\na = 2\n", "a.b = 1\na = 2\n", "[t]\n[t]\n", "a = 1\n[a]\n", "a = \n", "a = 1 b = 2\n", "a = nope\n", "a = \"\\q\"\n"] {
        assert_eq!(aplicar(base).1, Dudoso, "{base:?}");
    }
    let con_marca = format!("a = \"\"\"x\n{NOTIFY_MARCA}\n");
    assert_eq!(quitar_notify(&con_marca), NotifyQuitado { toml: con_marca.clone(), quitada: false, dudoso: true });
}

#[test]
fn verificar_cambio_rechaza_dos_notify_otro_contenido_o_sin_nuestra_linea() {
    let antes = "a = 1\n";
    assert_eq!(verificar_cambio(antes, &aplicar(antes).0, true), None);
    assert!(verificar_cambio(antes, antes, true).is_some());
    for malo in [format!("{LINEA}\n{LINEA}\n{antes}"), format!("notify = [\"x\"]\n{antes}"), format!("{LINEA}\n{antes}b = 2\n"), format!("{LINEA}\n[notify]\n{antes}"), "a = \"\"\"x".to_string()] {
        assert!(verificar_cambio(antes, &malo, true).is_some(), "{malo:?}");
    }
    assert_eq!(verificar_cambio(&format!("{antes}{LINEA}\n"), antes, false), None);
    assert!(verificar_cambio(&format!("{antes}{LINEA}\n"), &format!("{antes}{LINEA}\n"), false).is_some());
}

const SCRIPT: &str = "C:\\Users\\a b\\sloth-notify.cjs";

fn dir() -> PathBuf {
    PathBuf::from("C:/cuentas/a")
}

fn file() -> PathBuf {
    dir().join("config.toml")
}

#[derive(Default)]
struct Falso {
    texto: RefCell<Option<String>>,
    llamadas: RefCell<Vec<String>>,
    fallo_escribir: Option<ErrorKind>,
    fallo_leer: Option<ErrorKind>,
}

impl Falso {
    fn con(inicial: Option<&str>) -> Self {
        Falso { texto: RefCell::new(inicial.map(str::to_owned)), ..Falso::default() }
    }
    fn archivo(&self) -> Option<String> {
        self.texto.borrow().clone()
    }
}

impl FsNotify for Falso {
    fn leer(&self, _: &Path) -> Result<Option<String>, ErrNotify> {
        match self.fallo_leer {
            Some(k) => Err(std::io::Error::new(k, "x").into()),
            None => Ok(self.archivo()),
        }
    }
    fn respaldar(&self, f: &Path) -> Result<(), ErrNotify> {
        self.llamadas.borrow_mut().push(format!("respaldar {}", f.display()));
        Ok(())
    }
    fn escribir(&self, f: &Path, t: &str, previo: Option<&str>, verificar: &dyn Fn(&str) -> Option<&'static str>) -> Result<(), ErrNotify> {
        if let Some(k) = self.fallo_escribir {
            return Err(std::io::Error::new(k, format!("EPERM: operation not permitted, open '{}'", f.display())).into());
        }
        if verificar(t).is_some() {
            return Err(ErrNotify::Verif);
        }
        if self.archivo().as_deref() != previo {
            return Err(ErrNotify::Cambio);
        }
        self.llamadas.borrow_mut().push(format!("escribir {}", f.display()));
        *self.texto.borrow_mut() = Some(t.to_owned());
        Ok(())
    }
}

fn respaldo_y_escritura() -> Vec<String> {
    vec![format!("respaldar {}", file().display()), format!("escribir {}", file().display())]
}

#[test]
fn agrega_la_linea_respalda_antes_de_escribir_y_deja_el_resto_como_estaba() {
    let f = Falso::con(Some("cli_auth_credentials_store = \"file\"\n"));
    assert_eq!(preparar_notify(&dir(), Some("node"), SCRIPT, &f), None);
    assert_eq!(*f.llamadas.borrow(), respaldo_y_escritura());
    let a = f.archivo().unwrap();
    assert!(a.starts_with("notify = [\"node\", \"C:\\\\Users\\\\a b\\\\sloth-notify.cjs\"] # sloth-notify\n"));
    assert!(a.ends_with("cli_auth_credentials_store = \"file\"\n"));
}

#[test]
fn una_segunda_vez_no_escribe_ni_respalda() {
    let f = Falso::con(Some(""));
    preparar_notify(&dir(), Some("node"), SCRIPT, &f);
    f.llamadas.borrow_mut().clear();
    assert_eq!(preparar_notify(&dir(), Some("node"), SCRIPT, &f), None);
    assert!(f.llamadas.borrow().is_empty());
}

#[test]
fn un_notify_ajeno_no_se_pisa_ni_escribe_ni_respalda_y_da_el_motivo() {
    let inicial = "notify = [\"python\", \"mio.py\"]\n";
    let f = Falso::con(Some(inicial));
    assert_eq!(preparar_notify(&dir(), Some("node"), SCRIPT, &f).as_deref(), Some(MOTIVO_AJENO));
    assert!(f.llamadas.borrow().is_empty());
    assert_eq!(f.archivo().as_deref(), Some(inicial));
}

#[test]
fn sin_programa_o_con_una_ruta_que_no_se_puede_escribir_no_toca_nada() {
    let f = Falso::con(Some("a = 1\n"));
    assert_eq!(preparar_notify(&dir(), None, SCRIPT, &f).as_deref(), Some(MOTIVO_SIN_NODE));
    assert!(preparar_notify(&dir(), Some("node"), "C:/a\nb", &f).unwrap().contains("caracteres"));
    assert!(f.llamadas.borrow().is_empty());
}

#[test]
fn config_de_solo_lectura_devuelve_el_motivo_sin_datos_de_la_cuenta() {
    let f = Falso { fallo_escribir: Some(ErrorKind::PermissionDenied), ..Falso::con(Some("a = 1\n")) };
    let motivo = preparar_notify(&dir(), Some("node"), SCRIPT, &f).unwrap();
    assert!(motivo.contains("PermissionDenied"), "{motivo}");
    assert!(!motivo.contains("cuentas"));
    assert_eq!(f.archivo().as_deref(), Some("a = 1\n"));
    let g = Falso { fallo_leer: Some(ErrorKind::PermissionDenied), ..Falso::con(Some("a = 1\n")) };
    assert!(preparar_notify(&dir(), Some("node"), SCRIPT, &g).unwrap().contains("leer"));
}

#[test]
fn si_falta_el_config_toml_se_crea_solo_con_la_linea() {
    let f = Falso::con(None);
    assert_eq!(preparar_notify(&dir(), Some("node"), SCRIPT, &f), None);
    assert_eq!(f.archivo().unwrap().split('\n').count(), 2);
}

#[test]
fn desinstalar_saca_solo_la_linea_de_sloth_y_respalda_antes() {
    let base = "cli_auth_credentials_store = \"file\"\n[tui]\nx = 1\n";
    let f = Falso::con(Some(base));
    preparar_notify(&dir(), Some("node"), SCRIPT, &f);
    f.llamadas.borrow_mut().clear();
    assert_eq!(desinstalar_notify(&dir(), &f), None);
    assert_eq!(*f.llamadas.borrow(), respaldo_y_escritura());
    assert_eq!(f.archivo().as_deref(), Some(base));
}

#[test]
fn desinstalar_sin_linea_de_sloth_no_toca_el_archivo_ni_respalda() {
    for inicial in [None, Some("a = 1\n"), Some("notify = [\"x\"]\n")] {
        let f = Falso::con(inicial);
        assert_eq!(desinstalar_notify(&dir(), &f), None);
        assert!(f.llamadas.borrow().is_empty());
        assert_eq!(f.archivo().as_deref(), inicial);
    }
}

#[test]
fn aviso_una_vez_dice_cada_motivo_una_sola_vez() {
    let a = AvisoUnaVez::default();
    let dichos: Vec<&str> = ["uno", "uno", "dos"].into_iter().filter(|m| a.primera_vez(m)).collect();
    assert_eq!(dichos, ["uno", "dos"]);
}

#[test]
fn un_toml_dudoso_no_se_toca_ni_se_respalda() {
    for inicial in ["a = \"\"\"sin cerrar\n", "a = 1\na = 2\n", "[t]\n[t]\n", "a = \n"] {
        let f = Falso::con(Some(inicial));
        assert_eq!(preparar_notify(&dir(), Some("node"), SCRIPT, &f).as_deref(), Some(MOTIVO_DUDOSO));
        assert!(f.llamadas.borrow().is_empty());
        assert_eq!(f.archivo().as_deref(), Some(inicial));
    }
}

#[test]
fn desinstalar_con_un_toml_dudoso_que_dice_sloth_notify_no_lo_toca() {
    let f = Falso::con(Some("a = \"\"\"x\n# sloth-notify\n"));
    assert_eq!(desinstalar_notify(&dir(), &f).as_deref(), Some(MOTIVO_DUDOSO));
    assert!(f.llamadas.borrow().is_empty());
}

struct Mala(Falso);

impl FsNotify for Mala {
    fn leer(&self, f: &Path) -> Result<Option<String>, ErrNotify> {
        self.0.leer(f)
    }
    fn respaldar(&self, f: &Path) -> Result<(), ErrNotify> {
        self.0.respaldar(f)
    }
    fn escribir(&self, f: &Path, t: &str, previo: Option<&str>, verificar: &dyn Fn(&str) -> Option<&'static str>) -> Result<(), ErrNotify> {
        self.0.escribir(f, &format!("{t}a = 2\n"), previo, verificar)
    }
}

#[test]
fn si_la_verificacion_posterior_falla_no_se_escribe() {
    let m = Mala(Falso::con(Some("a = 1\n")));
    assert_eq!(preparar_notify(&dir(), Some("node"), SCRIPT, &m).as_deref(), Some(MOTIVO_DUDOSO));
    assert_eq!(m.0.archivo().as_deref(), Some("a = 1\n"));
}

fn tmp() -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let d = std::env::temp_dir().join(format!("sloth-notify-rs-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn nombres(d: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(d).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

#[test]
fn con_archivos_de_verdad_respaldo_una_sola_vez_sin_restos_de_tmp() {
    let d = tmp();
    let file = d.join("config.toml");
    let original = "\u{feff}a = 1\r\n[t]\r\nb = 2\r\n";
    fs::write(&file, original).unwrap();
    assert_eq!(preparar_notify(&d, Some("node"), SCRIPT, &FsReal), None);
    let bak = d.join("config.toml.sloth-bak");
    assert_eq!(fs::read_to_string(&bak).unwrap(), original);
    assert!(fs::read_to_string(&file).unwrap().contains("# sloth-notify\r\n"));
    assert_eq!(desinstalar_notify(&d, &FsReal), None);
    assert_eq!(fs::read_to_string(&file).unwrap(), original);
    assert_eq!(fs::read_to_string(&bak).unwrap(), original);
    assert_eq!(nombres(&d), ["config.toml", "config.toml.sloth-bak"]);
    let _ = fs::remove_dir_all(&d);
}

struct Carrera;

impl FsNotify for Carrera {
    fn leer(&self, f: &Path) -> Result<Option<String>, ErrNotify> {
        let t = FsReal.leer(f)?;
        fs::write(f, format!("{}[projects.x]\ntrust_level = \"trusted\"\n", t.as_deref().unwrap_or_default())).unwrap();
        Ok(t)
    }
    fn respaldar(&self, f: &Path) -> Result<(), ErrNotify> {
        FsReal.respaldar(f)
    }
    fn escribir(&self, f: &Path, t: &str, previo: Option<&str>, verificar: &dyn Fn(&str) -> Option<&'static str>) -> Result<(), ErrNotify> {
        FsReal.escribir(f, t, previo, verificar)
    }
}

#[test]
fn un_config_que_cambia_entre_la_lectura_y_el_rename_aborta_sin_perder_lo_de_codex() {
    let d = tmp();
    let file = d.join("config.toml");
    fs::write(&file, "a = 1\n").unwrap();
    assert_eq!(preparar_notify(&d, Some("node"), SCRIPT, &Carrera).as_deref(), Some(MOTIVO_CAMBIO));
    assert_eq!(fs::read_to_string(&file).unwrap(), "a = 1\n[projects.x]\ntrust_level = \"trusted\"\n");
    assert!(!nombres(&d).iter().any(|n| n.contains(".tmp-")));
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn con_archivos_de_verdad_un_archivo_raro_no_se_escribe_y_no_deja_respaldo_ni_tmp() {
    let d = tmp();
    let raro = "a = \"\"\"x \\\"\"\" y\"\"\"\nb = 1\nb = 2\n";
    fs::write(d.join("config.toml"), raro).unwrap();
    assert_eq!(preparar_notify(&d, Some("node"), SCRIPT, &FsReal).as_deref(), Some(MOTIVO_DUDOSO));
    assert_eq!(fs::read_to_string(d.join("config.toml")).unwrap(), raro);
    assert_eq!(nombres(&d), ["config.toml"]);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn ajustar_sin_config_deja_el_almacen_en_archivo_y_despues_el_notify_y_al_apagar_lo_saca() {
    let d = tmp();
    let mut cuenta = json!({ "id": "a", "configDir": d.to_string_lossy(), "proveedor": "codex", "avisoDeTurno": true });
    assert_eq!(ajustar_notify(&cuenta, Some(("node", SCRIPT)), &FsReal), None);
    let texto = fs::read_to_string(d.join("config.toml")).unwrap();
    assert!(texto.contains(crate::proveedores_fs::CONFIG_INICIAL));
    assert!(texto.starts_with("notify = ["));
    cuenta["avisoDeTurno"] = json!(false);
    assert_eq!(ajustar_notify(&cuenta, None, &FsReal), None);
    assert_eq!(fs::read_to_string(d.join("config.toml")).unwrap(), crate::proveedores_fs::CONFIG_INICIAL);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn ajustar_sin_programa_da_el_motivo_y_no_escribe_el_notify() {
    let d = tmp();
    let cuenta = json!({ "id": "a", "configDir": d.to_string_lossy(), "proveedor": "codex", "avisoDeTurno": true });
    let f = Falso::con(Some("a = 1\n"));
    assert_eq!(ajustar_notify(&cuenta, None, &f).as_deref(), Some(MOTIVO_SIN_NODE));
    assert!(f.llamadas.borrow().is_empty());
    let _ = fs::remove_dir_all(&d);
}
