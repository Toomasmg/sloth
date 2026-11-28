use super::*;

fn d() -> Objeto {
    por_defecto()
}
fn ap(actual: &Objeto, p: Value) -> Result<Objeto, String> {
    aplicar_cambio(actual, &p, None)
}
fn ok(p: Value) -> Objeto {
    ap(&d(), p).unwrap()
}
fn falla(p: Value) -> String {
    ap(&d(), p).unwrap_err()
}
fn v(o: &Objeto) -> Value {
    Value::Object(o.clone())
}

#[test]
fn normalizar_de_algo_que_no_es_objeto_da_los_valores_por_defecto() {
    for x in [json!(null), json!(3), json!("x"), json!([]), json!(true)] {
        assert_eq!(normalizar(&x), d());
    }
}

#[test]
fn normalizar_conserva_lo_valido_y_descarta_campo_por_campo_lo_invalido() {
    let s = normalizar(&json!({ "theme": "claro", "uiFontSize": 99, "editor": "Cursor", "terminal": { "fontSize": 14, "shell": "zsh" }, "notify": { "done": false, "perm": "sí" } }));
    assert_eq!(s["theme"], json!("claro"));
    assert_eq!(s["uiFontSize"], d()["uiFontSize"]);
    assert_eq!(s["editor"], json!("Cursor"));
    assert_eq!(s["terminal"]["fontSize"], json!(14));
    assert_eq!(s["terminal"]["shell"], d()["terminal"]["shell"]);
    assert_eq!(s["notify"]["done"], json!(false));
    assert_eq!(s["notify"]["perm"], json!(true));
}

#[test]
fn normalizar_ignora_campos_desconocidos_y_claves_viejas() {
    let s = normalizar(&json!({ "tema": "claro", "foo": 1, "terminal": { "viejo": 1 }, "shortcuts": { "fantasma": "Ctrl K" } }));
    assert_eq!(s, d());
    assert!(!s.contains_key("foo"));
}

#[test]
fn normalizar_limita_la_cantidad_de_colores_y_planes() {
    let mut colores = serde_json::Map::new();
    let mut planes = serde_json::Map::new();
    for i in 0..200 {
        colores.insert(format!("c{i}"), json!(ACCOUNT_PALETTE[0].0));
        planes.insert(format!("c{i}"), json!("Pro"));
    }
    let s = normalizar(&json!({ "accountColors": colores, "accountPlans": planes }));
    assert_eq!(s["accountColors"].as_object().unwrap().len(), MAX_ACCOUNT_COLORS);
    assert_eq!(s["accountPlans"].as_object().unwrap().len(), MAX_ACCOUNT_COLORS);
}

#[test]
fn normalizar_canoniza_atajos_y_descarta_los_invalidos() {
    let s = normalizar(&json!({ "shortcuts": { "palette": "ctrl shift k", "new": "K", "help": null } }));
    assert_eq!(s["shortcuts"], json!({ "palette": "Ctrl Shift K" }));
}

#[test]
fn aplicar_cambio_rechaza_lo_que_no_es_objeto_y_las_claves_desconocidas() {
    for p in [json!(null), json!(1), json!("x"), json!([])] {
        assert!(falla(p).contains("objeto"));
    }
    assert!(falla(json!({ "nope": 1 })).contains("desconocido: nope"));
    assert!(falla(json!({ "terminal": { "nope": 1 } })).contains("terminal.nope"));
    assert!(falla(json!({ "notify": { "nope": 1 } })).contains("notify.nope"));
}

#[test]
fn aplicar_cambio_no_muta_el_original_ni_aplica_nada_a_medias() {
    let antes = d();
    assert_eq!(ok(json!({ "theme": "claro" }))["theme"], json!("claro"));
    assert_eq!(antes, d());
    assert!(ap(&antes, json!({ "theme": "claro", "uiFontSize": 1 })).is_err());
    assert_eq!(antes, d());
}

#[test]
fn aplicar_cambio_valida_enteros_en_rango() {
    assert_eq!(ok(json!({ "uiFontSize": 12 }))["uiFontSize"], json!(12));
    assert_eq!(ok(json!({ "uiFontSize": 16 }))["uiFontSize"], json!(16));
    for x in [json!(11), json!(17), json!(13.5), json!("13"), json!(null)] {
        assert!(ap(&d(), json!({ "uiFontSize": x })).is_err());
    }
    assert!(ap(&d(), json!({ "terminal": { "fontSize": 10 } })).is_err());
    assert!(ap(&d(), json!({ "terminal": { "scrollback": 999 } })).is_err());
    assert_eq!(ok(json!({ "terminal": { "scrollback": 20000 } }))["terminal"]["scrollback"], json!(20000));
}

#[test]
fn aplicar_cambio_valida_listas_cerradas_y_booleanos() {
    for p in [json!({ "theme": "rojo" }), json!({ "editor": 3 }), json!({ "sounds": "si" }), json!({ "updateChannel": "nightly" }), json!({ "sleepAfterMin": 20 })] {
        assert!(ap(&d(), p).is_err());
    }
    assert_eq!(ok(json!({ "updateChannel": "beta" }))["updateChannel"], json!("beta"));
    assert_eq!(ok(json!({ "sleepAfterMin": 60 }))["sleepAfterMin"], json!(60));
    assert_eq!(falla(json!({ "theme": "rojo" })), "El tema tiene que ser «oscuro», «noche», «claro», «sistema».");
}

#[test]
fn aplicar_cambio_acepta_la_altura_de_linea_en_pasos_de_5_centesimas() {
    assert_eq!(ok(json!({ "terminal": { "lineHeight": 1.2 } }))["terminal"]["lineHeight"], json!(1.2));
    assert_eq!(ok(json!({ "terminal": { "lineHeight": 1.15 } }))["terminal"]["lineHeight"], json!(1.15));
    for x in [json!(1.22), json!(0.95), json!(1.45), json!("1.2")] {
        assert!(ap(&d(), json!({ "terminal": { "lineHeight": x } })).is_err());
    }
}

#[test]
fn aplicar_cambio_fusiona_terminal_y_notify_campo_por_campo() {
    let n = ok(json!({ "terminal": { "cursorBlink": false }, "notify": { "team": false } }));
    assert_eq!(n["terminal"]["cursorBlink"], json!(false));
    assert_eq!(n["terminal"]["fontFamily"], d()["terminal"]["fontFamily"]);
    assert_eq!(n["notify"]["team"], json!(false));
    assert_eq!(n["notify"]["done"], json!(true));
}

#[test]
fn colores_de_cuenta_paleta_minusculas_quitar_con_null_y_cuenta_existente() {
    let hex = ACCOUNT_PALETTE[1].0;
    assert_eq!(ok(json!({ "accountColors": { "a1": hex.to_uppercase() } }))["accountColors"]["a1"], json!(hex));
    assert!(falla(json!({ "accountColors": { "a1": "#000000" } })).contains("paleta"));
    assert!(falla(json!({ "accountColors": { "a b": hex } })).contains("Id"));
    let nunca: &dyn Fn(&str) -> bool = &|_| false;
    assert!(aplicar_cambio(&d(), &json!({ "accountColors": { "a1": hex } }), Some(nunca)).unwrap_err().contains("no existe"));
    let con = ok(json!({ "accountColors": { "a1": hex } }));
    assert_eq!(aplicar_cambio(&con, &json!({ "accountColors": { "a1": null } }), Some(nunca)).unwrap()["accountColors"], json!({}));
}

#[test]
fn planes_recortados_vacio_o_null_los_quita_largo_y_control_rechazados() {
    assert_eq!(ok(json!({ "accountPlans": { "a1": "  Max " } }))["accountPlans"]["a1"], json!("Max"));
    let con = ok(json!({ "accountPlans": { "a1": "Pro" } }));
    assert_eq!(ap(&con, json!({ "accountPlans": { "a1": "" } })).unwrap()["accountPlans"], json!({}));
    assert_eq!(ap(&con, json!({ "accountPlans": { "a1": null } })).unwrap()["accountPlans"], json!({}));
    for x in [json!("x".repeat(MAX_PLAN + 1)), json!("a\nb"), json!(3)] {
        assert!(ap(&d(), json!({ "accountPlans": { "a1": x } })).is_err());
    }
}

#[test]
fn tope_de_cupo_entero_cero_o_null_lo_quita_fuera_de_rango_rechazado() {
    let con = ok(json!({ "accountCupos": { "a1": 2_500_000 } }));
    assert_eq!(con["accountCupos"]["a1"], json!(2_500_000));
    assert_eq!(ap(&con, json!({ "accountCupos": { "a1": null } })).unwrap()["accountCupos"], json!({}));
    assert_eq!(ap(&con, json!({ "accountCupos": { "a1": 0 } })).unwrap()["accountCupos"], json!({}));
    for malo in [json!(-1), json!(1.5), json!(2e9), json!("5")] {
        assert!(ap(&d(), json!({ "accountCupos": { "a1": malo } })).is_err(), "{malo}");
    }
    assert!(ap(&d(), json!({ "accountCupos": { "a b": 5 } })).is_err());
    let nunca: &dyn Fn(&str) -> bool = &|_| false;
    assert!(aplicar_cambio(&d(), &json!({ "accountCupos": { "a1": 5 } }), Some(nunca)).is_err());
}

#[test]
fn un_archivo_viejo_sin_topes_queda_con_el_mapa_vacio_y_uno_con_topes_invalidos_los_descarta() {
    assert_eq!(normalizar(&json!({ "theme": "claro" }))["accountCupos"], json!({}));
    assert_eq!(normalizar(&json!({ "accountCupos": { "a": 100, "b": "x", "c": -3 } }))["accountCupos"], json!({ "a": 100 }));
}

#[test]
fn demasiados_colores_falla() {
    let mut c = serde_json::Map::new();
    for i in 0..=MAX_ACCOUNT_COLORS {
        c.insert(format!("c{i}"), json!(ACCOUNT_PALETTE[0].0));
    }
    assert!(falla(json!({ "accountColors": c })).contains("Demasiados"));
}

#[test]
fn carpeta_de_proyectos_recorta_y_rechaza_largos_y_control() {
    assert_eq!(ok(json!({ "projectsDir": "  C:\\Dev " }))["projectsDir"], json!("C:\\Dev"));
    for x in [json!("x".repeat(261)), json!("a\u{0}b"), json!(5)] {
        assert!(ap(&d(), json!({ "projectsDir": x })).is_err());
    }
}

#[test]
fn atajos_validos_null_quita_desconocidos_y_combos_malos_fallan() {
    let n = ok(json!({ "shortcuts": { "palette": "alt k" } }));
    assert_eq!(n["shortcuts"], json!({ "palette": "Alt K" }));
    assert_eq!(ap(&n, json!({ "shortcuts": { "palette": null } })).unwrap()["shortcuts"], json!({}));
    assert!(falla(json!({ "shortcuts": { "fantasma": "Ctrl K" } })).contains("desconocido"));
    assert!(falla(json!({ "shortcuts": { "palette": "K" } })).contains("no es válida"));
    assert!(falla(json!({ "shortcuts": { "palette": 5 } })).contains("no es válida"));
    assert!(MAX_SHORTCUTS >= SHORTCUT_IDS.len());
}

fn combo(ctrl: bool, alt: bool, shift: bool, key: &str) -> Option<Combo> {
    Some(Combo { ctrl, alt, shift, key: key.into() })
}

#[test]
fn leer_combo_y_combo_canonico() {
    assert_eq!(combo_canonico("shift ctrl k").as_deref(), Some("Ctrl Shift K"));
    assert_eq!(combo_canonico("  Ctrl   Alt  F5 ").as_deref(), Some("Ctrl Alt F5"));
    assert_eq!(combo_canonico("F2").as_deref(), Some("F2"));
    assert_eq!(combo_canonico("Ctrl ←").as_deref(), Some("Ctrl ←"));
    assert_eq!(combo_canonico("Ctrl Shift ,").as_deref(), Some("Ctrl Shift ,"));
    for malo in ["", " ", "Ctrl", "Shift K", "Ctrl Ctrl K", "Ctrl Meta K", "Ctrl F13", "Ctrl Escape", "F13", "Ctrl K L"] {
        assert_eq!(leer_combo(malo), None, "{malo:?}");
    }
    assert_eq!(leer_combo("ctrl Enter"), combo(true, false, false, "Enter"));
}

#[test]
fn leer_combo_normaliza_la_tecla_sin_importar_mayusculas() {
    assert_eq!(leer_combo("ctrl enter"), combo(true, false, false, "Enter"));
    assert_eq!(leer_combo("alt pageup"), combo(false, true, false, "PageUp"));
    assert_eq!(leer_combo("ctrl f5"), combo(true, false, false, "F5"));
    assert_eq!(leer_combo("f5"), combo(false, false, false, "F5"));
    assert_eq!(leer_combo("ctrl f13"), None);
    assert_eq!(leer_combo("ctrl esc"), None);
    assert_eq!(leer_combo("ctrl f05"), None);
}

#[test]
fn restaurar_seccion_restaura_solo_su_seccion() {
    let s = ok(json!({ "theme": "claro", "terminal": { "fontSize": 16 }, "updateChannel": "beta", "editor": "Cursor", "shortcuts": { "palette": "Ctrl K" } }));
    let a = restaurar_seccion(&s, &json!("apariencia")).unwrap();
    assert_eq!((a["theme"].clone(), a["editor"].clone()), (json!("oscuro"), json!("Cursor")));
    assert_eq!(restaurar_seccion(&s, &json!("terminal")).unwrap()["terminal"]["fontSize"], d()["terminal"]["fontSize"]);
    assert_eq!(restaurar_seccion(&s, &json!("updates")).unwrap()["updateChannel"], json!("estable"));
    assert_eq!(restaurar_seccion(&s, &json!("atajos")).unwrap()["shortcuts"], json!({}));
    assert_eq!(restaurar_seccion(&s, &json!("atajos")).unwrap()["theme"], json!("claro"));
    assert_eq!(restaurar_seccion(&s, &json!("general")).unwrap()["editor"], json!("VS Code"));
    assert_eq!(s["theme"], json!("claro"));
}

#[test]
fn restaurar_seccion_acepta_todas_las_secciones_y_rechaza_otras() {
    for sec in SECTIONS {
        assert!(restaurar_seccion(&d(), &json!(sec)).is_ok());
    }
    for x in [json!("nada"), json!(null), json!(3)] {
        assert!(restaurar_seccion(&d(), &x).unwrap_err().contains("Sección"));
    }
}

#[test]
fn restaurar_todas_las_secciones_deja_los_valores_por_defecto() {
    let mut s = ok(json!({ "theme": "noche", "sounds": true, "noMolestar": true, "notify": { "done": false }, "accountPlans": { "a": "Pro" }, "lightMode": true }));
    for sec in SECTIONS {
        s = restaurar_seccion(&s, &json!(sec)).unwrap();
    }
    assert_eq!(s, d());
}

#[test]
fn resolver_oscuro_sigue_al_sistema_solo_con_sistema() {
    assert!(!resolver_oscuro("claro", true));
    assert!(resolver_oscuro("oscuro", false));
    assert!(resolver_oscuro("noche", false));
    assert!(resolver_oscuro("sistema", true));
    assert!(!resolver_oscuro("sistema", false));
}

#[test]
fn los_colores_de_la_paleta_son_hex_unicos() {
    let hex: Vec<&str> = ACCOUNT_PALETTE.iter().map(|c| c.0).collect();
    let mut unicos = hex.clone();
    unicos.sort();
    unicos.dedup();
    assert_eq!(unicos.len(), hex.len());
    for h in hex {
        assert!(h.len() == 7 && h.starts_with('#') && h[1..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "{h}");
    }
}

#[test]
fn rendimiento_valida_ram_y_nucleos_de_cada_perfil_y_cero_es_sin_limite() {
    let s = ok(json!({ "rendimiento": { "enchufada": { "ramMB": 8192, "nucleos": 8 }, "bateriaDistinta": true } }));
    assert_eq!(s["rendimiento"]["enchufada"], json!({ "ramMB": 8192, "nucleos": 8 }));
    assert_eq!(s["rendimiento"]["bateriaDistinta"], json!(true));
    assert_eq!(ap(&s, json!({ "rendimiento": { "bateria": { "nucleos": 2 } } })).unwrap()["rendimiento"]["bateria"], json!({ "ramMB": 0, "nucleos": 2 }));
    assert_eq!(ap(&s, json!({ "rendimiento": { "enchufada": { "ramMB": 0 } } })).unwrap()["rendimiento"]["enchufada"]["ramMB"], json!(0));
    for malo in [
        json!({ "enchufada": { "ramMB": 1024 } }),
        json!({ "enchufada": { "ramMB": 2048.5 } }),
        json!({ "bateria": { "nucleos": -1 } }),
        json!({ "bateria": { "nucleos": 65 } }),
        json!({ "bateria": { "otro": 1 } }),
        json!({ "turbo": true }),
        json!({ "bateriaDistinta": "sí" }),
    ] {
        assert!(ap(&d(), json!({ "rendimiento": malo })).is_err());
    }
    assert_eq!(d()["rendimiento"]["enchufada"]["ramMB"], json!(0));
}

#[test]
fn rendimiento_normalizar_descarta_campo_por_campo_y_restaurar_vuelve_a_sin_limites() {
    let s = normalizar(&json!({ "rendimiento": { "enchufada": { "ramMB": 500, "nucleos": 4 }, "bateria": "x", "bateriaDistinta": true } }));
    assert_eq!(s["rendimiento"], json!({ "enchufada": { "ramMB": 0, "nucleos": 4 }, "bateria": { "ramMB": 0, "nucleos": 0 }, "bateriaDistinta": true }));
    assert_eq!(restaurar_seccion(&s, &json!("rendimiento")).unwrap()["rendimiento"], d()["rendimiento"]);
}

#[test]
fn el_orden_de_las_claves_es_el_del_archivo_de_siempre() {
    let claves: Vec<String> = d().keys().cloned().collect();
    assert_eq!(claves[..5], ["theme", "density", "uiFontSize", "accent", "terminal"]);
    let t: Vec<String> = d()["terminal"].as_object().unwrap().keys().cloned().collect();
    assert_eq!(t, ["fontSize", "fontFamily", "lineHeight", "cursorStyle", "cursorBlink", "shell", "scrollback", "dictadoPreciso"]);
    assert_eq!(serde_json::to_string(&v(&ok(json!({ "theme": "claro" })))).unwrap().find("\"theme\":\"claro\""), Some(1));
}

#[test]
fn dictado_preciso_apagado_por_defecto_se_prende_con_un_parche_y_sobrevive_a_normalizar() {
    assert_eq!(d()["terminal"]["dictadoPreciso"], json!(false));
    let s = ok(json!({ "terminal": { "dictadoPreciso": true } }));
    assert_eq!(s["terminal"]["dictadoPreciso"], json!(true));
    assert_eq!(normalizar(&v(&s))["terminal"]["dictadoPreciso"], json!(true));
    assert_eq!(normalizar(&json!({ "terminal": { "fontSize": 14 } }))["terminal"]["dictadoPreciso"], json!(false));
    assert!(ap(&d(), json!({ "terminal": { "dictadoPreciso": "sí" } })).is_err());
}
