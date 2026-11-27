use super::*;

fn rutas(t: &str) -> Vec<String> {
    let a = analizar(t).unwrap_or_else(|e| panic!("{t}: {e}"));
    a.iter()
        .map(|s| {
            let tipo = match s.tipo {
                Tipo::Clave => "clave",
                Tipo::Tabla => "tabla",
                Tipo::TablaArray => "tablaArray",
            };
            let camino: Vec<&str> = s.tabla.iter().chain(&s.ruta).map(String::as_str).collect();
            format!("{tipo}:{}", camino.join("/"))
        })
        .collect()
}

#[test]
fn claves_peladas_con_comillas_punteadas_y_con_escapes() {
    assert_eq!(rutas("a = 1\n\"b.c\" = 2\n'd' = 3\ne . f = 4\n\"g\\u0068\" = 5\n"), ["clave:a", "clave:b.c", "clave:d", "clave:e/f", "clave:gh"]);
}

#[test]
fn tablas_y_tablas_de_array_con_sus_claves() {
    assert_eq!(rutas("[a.b]\nx = 1\n[[c]]\ny = 2\n[ \"d\" . e ]\n"), ["tabla:a/b", "clave:a/b/x", "tablaArray:c", "clave:c/y", "tabla:d/e"]);
}

#[test]
fn valores_cadenas_multilinea_arrays_anidados_con_comentarios_tablas_en_linea_y_fechas() {
    let t = "a = \"\"\"\nx \\\"\"\"\n\"\"\"\nb = '''\n\"\"\"\n'''\nc = [\n  [1, 2], # uno\n  [\"]\"],\n]\nd = { e = 1, f = { g = \"h\" } }\ni = 1979-05-27T07:32:00-08:00\nj = -1.5e+3\nk = 0xDEAD_beef\nl = +inf\n";
    assert_eq!(rutas(t), ["clave:a", "clave:b", "clave:c", "clave:d", "clave:i", "clave:j", "clave:k", "clave:l"]);
}

#[test]
fn lineas_y_offsets_de_cada_sentencia() {
    let texto = "a = \"\"\"x\ny\"\"\"\nb = 1 # c\n";
    let a = analizar(texto).unwrap();
    let lineas: Vec<(usize, usize)> = a.iter().map(|s| (s.linea_ini, s.linea_fin)).collect();
    assert_eq!(lineas, [(0, 1), (2, 2)]);
    assert_eq!(&texto[a[1].desde..a[1].hasta], "b = 1");
}

#[test]
fn lo_que_no_cierra_o_no_es_toml_devuelve_err_y_el_motivo_no_lleva_el_contenido() {
    for t in ["a = \"x", "a = \"\"\"x", "a = 'x", "a = '''x", "a = [1", "a = {b = 1", "[a", "[[a]", "a b = 1", "a = 1 2", "= 1", "a = \"\\uZZZZ\"", "a = \"\"\"\\x\"\"\"", "a = \"\"\"\"\"\"\"\"\""] {
        let motivo = analizar(t).expect_err(t);
        assert!(motivo.contains("(línea 1)"), "{t}: {motivo}");
    }
    let motivo = analizar("clave_secreta = \"token").unwrap_err();
    assert!(!motivo.contains("token"));
}

#[test]
fn anidado_excesivo_no_revienta_la_pila() {
    assert!(analizar(&format!("a = {}", "[".repeat(5000))).is_err());
}

#[test]
fn el_bom_se_saltea_y_el_motivo_cuenta_las_lineas() {
    let a = analizar("\u{feff}a = 1\n").unwrap();
    assert_eq!(a[0].desde, 3);
    assert!(analizar("a = 1\nb = \n").unwrap_err().contains("(línea 2)"));
}

#[test]
fn acepta_los_valores_sin_comillas_de_toml_y_rechaza_el_resto() {
    for v in ["true", "false", "-inf", "nan", "0", "+7", "1_000", "3.14", "6.02e23", "1E-2", "0o17", "0b1_0", "12:30", "12:30:45.5", "2020-01-01", "2020-01-01 10:20", "2020-01-01T10:20:30.123Z"] {
        assert!(analizar(&format!("a = {v}\n")).is_ok(), "{v}");
    }
    for v in ["01", "1__0", "1_", "_1", "0x", "1.", ".5", "1e", "yes", "True", "0xG"] {
        assert!(analizar(&format!("a = {v}\n")).is_err(), "{v}");
    }
}

#[test]
fn los_escapes_unicode_y_el_corte_de_linea_de_las_multilinea() {
    assert!(analizar("a = \"\\U0001F600 \\e\"\nb = \"\"\"uno \\\n   dos\"\"\"\n").is_ok());
    assert!(analizar("a = \"\\U00110000\"").is_err());
    assert!(analizar("a = \"\\ud800\"").is_ok());
    assert!(analizar("a = \"\\q\"").is_err());
}

#[test]
fn las_claves_con_texto_no_ascii_conservan_los_offsets() {
    let texto = "\"ñ\" = \"ñandú\"\nb = 1\n";
    let a = analizar(texto).unwrap();
    assert_eq!(a[0].ruta, ["ñ"]);
    assert_eq!(&texto[a[1].desde..a[1].hasta], "b = 1");
}

fn duplicados(t: &str) -> Option<&'static str> {
    problema_de_duplicados(&analizar(t).unwrap())
}

#[test]
fn detecta_claves_y_tablas_repetidas() {
    assert!(duplicados("a = 1\nb = 2\n").is_none());
    assert!(duplicados("a = 1\na = 2\n").is_some());
    assert!(duplicados("[a]\nx = 1\n[a]\n").is_some());
    assert!(duplicados("a = 1\n[a]\n").is_some());
    assert!(duplicados("[a]\nx = 1\n[a.x]\n").is_some());
    assert!(duplicados("a.b = 1\na.b.c = 2\n").is_some());
    assert!(duplicados("a.b = 1\n[a]\n").is_some());
}

#[test]
fn permite_tablas_de_array_repetidas_y_tablas_hijas_en_distinto_orden() {
    assert!(duplicados("[[c]]\nx = 1\n[[c]]\nx = 2\n").is_none());
    assert!(duplicados("[a.b]\nx = 1\n[a]\ny = 2\n").is_none());
    assert!(duplicados("[[c]]\n[c.d]\n[[c]]\n[c.d]\n").is_none());
    assert!(duplicados("[a.b]\n[[a]]\n").is_some());
}
