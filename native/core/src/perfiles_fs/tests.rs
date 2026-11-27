use super::*;
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU32, Ordering};

const AHORA: u64 = 1_700_000_000_000;
fn ahora() -> u64 {
    AHORA
}

fn raiz() -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let d = std::env::temp_dir().join(format!("sloth-perfiles-rs-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn escribir(base: &Path, rel: &str, contenido: &[u8]) {
    let f = base.join(rel);
    fs::create_dir_all(f.parent().unwrap()).unwrap();
    fs::write(f, contenido).unwrap();
}

/// Ruta relativa -> contenido de cada archivo bajo las entradas pedidas (o todo).
fn foto(dir: &Path, entradas: Option<&[&str]>) -> BTreeMap<String, Vec<u8>> {
    fn andar(base: &Path, d: &Path, r: &mut BTreeMap<String, Vec<u8>>) {
        for e in fs::read_dir(d).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                andar(base, &p, r);
            } else {
                r.insert(p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/"), fs::read(&p).unwrap());
            }
        }
    }
    let mut r = BTreeMap::new();
    let nombres: Vec<String> = match entradas {
        Some(e) => e.iter().map(|s| s.to_string()).collect(),
        None => listar(dir).unwrap(),
    };
    for e in nombres {
        let f = dir.join(&e);
        if !f.exists() {
            continue;
        }
        if f.is_dir() {
            andar(dir, &f, &mut r);
        } else {
            r.insert(e, fs::read(&f).unwrap());
        }
    }
    r
}

fn sembrar(d: &Path) {
    escribir(d, "sloth-state.json", r#"{"version":1,"accounts":[{"id":"a1","label":"Trabajo"}],"workspaces":[{"id":"3f2c1e8a","name":"Ñandú 🦥"}],"openPanes":[]}"#.as_bytes());
    escribir(d, "sloth-state.json.bak-1699999999999", br#"{"version":1,"accounts":[]}"#);
    escribir(d, "features/settings.json", "\u{feff}{\"version\":1,\"theme\":\"claro\"}".as_bytes());
    escribir(d, "features/tickets/uso.json", br#"{"dias":{}}"#);
    escribir(d, "features/chat-session.bin", &[0, 1, 2, 255, 254]);
    escribir(d, "features/celular.json", "{\"clave\":\"anónima\"}".as_bytes());
    escribir(d, "accounts/a1/.credentials.json", br#"{"token":"no-se-copia"}"#);
    escribir(d, "daemon-key", b"clave");
    escribir(d, "daemon-token", b"token");
    escribir(d, "window-state.json", b"{}");
    escribir(d, "logs/sloth.log", "línea".as_bytes());
}

const ORIGINALES: [&str; 8] = ["sloth-state.json", "sloth-state.json.bak-1699999999999", "features", "accounts", "daemon-key", "daemon-token", "window-state.json", "logs"];

fn leer_indice(d: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(rutas_perfiles(d).indice).unwrap()).unwrap()
}

fn respaldos_previos(d: &Path) -> Vec<String> {
    listar(&rutas_perfiles(d).respaldos).unwrap().into_iter().filter(|n| n.starts_with("pre-perfiles-")).collect()
}

fn ordenados(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

fn meta_json(id: &str, nombre: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({ "id": id, "nombre": nombre, "creado": 5 })).unwrap()
}

#[test]
fn migra_por_copia_la_raiz_queda_igual_el_perfil_idéntico_respaldo_e_indice_validos() {
    let d = raiz();
    sembrar(&d);
    let antes = foto(&d, Some(&ORIGINALES));
    let r = iniciar_perfiles_fs(&d, &ahora);
    assert_eq!(r.error, None);
    assert!(r.migrado);
    assert_eq!(foto(&d, Some(&ORIGINALES)), antes);
    let perfil = d.join("perfiles").join("principal");
    assert_eq!(foto(&perfil, Some(&["sloth-state.json", "features"])), foto(&d, Some(&["sloth-state.json", "features"])));
    assert_eq!(leer_meta(&perfil), Some(Perfil { id: "principal".into(), nombre: "Mi perfil".into(), creado: AHORA as f64, gh_login: None }));
    assert_eq!(respaldos_previos(&d), [format!("pre-perfiles-{AHORA}")]);
    assert_eq!(foto(&d.join("respaldos").join(format!("pre-perfiles-{AHORA}")), None), foto(&d, Some(&["sloth-state.json", "features"])));
    assert_eq!(validar_indice(&leer_indice(&d)), Some(r.indice.clone()));
    assert_eq!(r.indice.activo, "principal");
}

#[test]
fn logins_claves_logs_ventana_y_bak_de_la_raiz_no_pasan_al_perfil() {
    let d = raiz();
    sembrar(&d);
    iniciar_perfiles_fs(&d, &ahora);
    assert_eq!(ordenados(listar(&d.join("perfiles").join("principal")).unwrap()), ["features", "perfil.json", "sloth-state.json"]);
    assert_eq!(ordenados(listar(&d.join("respaldos").join(format!("pre-perfiles-{AHORA}"))).unwrap()), ["features", "sloth-state.json"]);
}

#[test]
fn archivos_de_una_version_futura_se_copian_sin_tocarlos() {
    let d = raiz();
    let futuro = br#"{"version":9,"nuevo":{"x":[1,2]}}"#;
    escribir(&d, "sloth-state.json", futuro);
    escribir(&d, "features/settings.json", futuro);
    iniciar_perfiles_fs(&d, &ahora);
    assert_eq!(fs::read(d.join("perfiles/principal/sloth-state.json")).unwrap(), futuro);
    assert_eq!(fs::read(d.join("perfiles/principal/features/settings.json")).unwrap(), futuro);
}

#[test]
fn la_segunda_vez_no_copia_ni_reescribe_nada() {
    let d = raiz();
    sembrar(&d);
    let primera = iniciar_perfiles_fs(&d, &ahora);
    let antes = foto(&d, None);
    let segunda = iniciar_perfiles_fs(&d, &|| AHORA + 5000);
    assert!(!segunda.migrado && !segunda.reconstruido);
    assert_eq!(segunda.indice, primera.indice);
    assert_eq!(foto(&d, None), antes);
    assert!(!rutas_perfiles(&d).candado.exists(), "no deja el candado");
}

#[test]
fn corte_con_la_copia_a_medias_se_descarta_el_tmp_y_se_rearma_bien() {
    let d = raiz();
    sembrar(&d);
    escribir(&d, "perfiles/.principal.tmp/features/parcial.json", b"{");
    let r = iniciar_perfiles_fs(&d, &ahora);
    assert!(r.migrado && r.error.is_none());
    assert!(!d.join("perfiles/.principal.tmp").exists());
    assert!(!d.join("perfiles/principal/features/parcial.json").exists());
}

#[test]
fn perfil_ya_migrado_pero_sin_indice_solo_escribe_el_indice() {
    let d = raiz();
    sembrar(&d);
    iniciar_perfiles_fs(&d, &ahora);
    let perfil = foto(&d.join("perfiles/principal"), None);
    fs::remove_file(rutas_perfiles(&d).indice).unwrap();
    let r = iniciar_perfiles_fs(&d, &|| AHORA + 1);
    assert!(!r.migrado && r.reconstruido);
    assert_eq!(foto(&d.join("perfiles/principal"), None), perfil);
    assert_eq!(validar_indice(&leer_indice(&d)), Some(r.indice));
    assert_eq!(respaldos_previos(&d).len(), 1, "sin respaldo nuevo");
}

#[test]
fn indice_corrupto_con_carpetas_validas_se_aparta_y_se_rearma() {
    let d = raiz();
    sembrar(&d);
    iniciar_perfiles_fs(&d, &ahora);
    fs::write(rutas_perfiles(&d).indice, "{ roto").unwrap();
    let r = iniciar_perfiles_fs(&d, &|| AHORA + 1);
    assert!(r.reconstruido && !r.migrado);
    assert!(listar(&d).unwrap().iter().any(|n| n.starts_with("perfiles.json.corrupt-")));
    assert_eq!(validar_indice(&leer_indice(&d)), Some(r.indice));
}

#[test]
fn indice_sano_que_apunta_a_un_perfil_que_ya_no_esta_se_respalda_y_se_rearma() {
    let d = raiz();
    sembrar(&d);
    iniciar_perfiles_fs(&d, &ahora);
    let con_otro = IndicePerfiles {
        activo: "p-perdido".into(),
        perfiles: vec![Perfil { id: "p-perdido".into(), nombre: "Perdido".into(), creado: 9.0, gh_login: None }, Perfil { id: "principal".into(), nombre: "Mi perfil".into(), creado: AHORA as f64, gh_login: None }],
    };
    guardar_indice(&d, &con_otro).unwrap();
    let r = iniciar_perfiles_fs(&d, &|| AHORA + 1);
    assert!(r.reconstruido);
    assert_eq!(r.indice.activo, "principal");
    assert_eq!(r.indice.perfiles.len(), 1);
    assert!(listar(&d).unwrap().iter().any(|n| n.starts_with("perfiles.json.bak-")));
}

#[test]
fn arranque_limpio_perfil_vacio_con_su_perfil_json_sin_respaldo() {
    let d = raiz();
    let r = iniciar_perfiles_fs(&d, &ahora);
    assert!(r.migrado);
    assert!(respaldos_previos(&d).is_empty());
    assert_eq!(ordenados(listar(&d.join("perfiles/principal")).unwrap()), ["perfil.json"]);
}

#[test]
fn raiz_que_todavia_no_existe_se_crea_y_queda_el_perfil_vacio() {
    let d = raiz().join("no-existe-aun");
    let r = iniciar_perfiles_fs(&d, &ahora);
    assert!(r.migrado && r.error.is_none());
    assert!(d.join("perfiles/principal/perfil.json").exists());
}

#[test]
fn si_perfiles_es_un_archivo_la_copia_falla_sin_indice_y_la_raiz_intacta() {
    let d = raiz();
    sembrar(&d);
    fs::write(d.join("perfiles"), "soy un archivo").unwrap();
    let antes = foto(&d, Some(&ORIGINALES));
    let r = iniciar_perfiles_fs(&d, &ahora);
    assert!(r.error.is_some() && !r.migrado);
    assert!(!rutas_perfiles(&d).indice.exists());
    assert_eq!(foto(&d, Some(&ORIGINALES)), antes);
    assert_eq!(fs::read_to_string(d.join("perfiles")).unwrap(), "soy un archivo");
}

#[test]
fn una_carpeta_ajena_con_el_nombre_del_perfil_inicial_no_se_pisa() {
    let d = raiz();
    sembrar(&d);
    escribir(&d, "perfiles/principal/mio.txt", b"mio");
    let r = iniciar_perfiles_fs(&d, &ahora);
    assert!(r.error.is_some() || r.bloqueado.is_some());
    assert_eq!(fs::read(d.join("perfiles/principal/mio.txt")).unwrap(), b"mio");
}

#[test]
fn carpetas_con_nombres_peligrosos_o_que_dicen_ser_otra_no_cuentan() {
    let d = raiz();
    sembrar(&d);
    escribir(&d, "perfiles/p-copia/perfil.json", &meta_json("p-otro", "Otro"));
    escribir(&d, "perfiles/CON/perfil.json", &meta_json("con", "X"));
    escribir(&d, "perfiles/espacio uno/perfil.json", &meta_json("espacio-uno", "X"));
    let r = iniciar_perfiles_fs(&d, &ahora);
    // La única carpeta con pinta de perfil dice ser otra: no cuenta, pero hay un perfil.json que no sirve → no se migra de nuevo.
    assert!(r.bloqueado.is_some() || r.indice.perfiles.iter().all(|p| p.id != "p-otro"));
}

#[test]
fn restos_que_no_se_pueden_borrar_no_frenan_el_arranque() {
    let d = raiz();
    sembrar(&d);
    iniciar_perfiles_fs(&d, &ahora);
    escribir(&d, "perfiles/.viejo.tmp/x", b"x");
    let r = iniciar_perfiles_fs(&d, &|| AHORA + 1);
    assert!(!r.migrado && r.bloqueado.is_none());
    assert!(!d.join("perfiles/.viejo.tmp").exists(), "se barrió");
}

fn perfiles_listos() -> PathBuf {
    let d = raiz();
    sembrar(&d);
    iniciar_perfiles_fs(&d, &ahora);
    d
}

fn azar_fijo(v: &'static [&'static str]) -> impl FnMut() -> String {
    let mut i = 0;
    move || {
        let s = v[i.min(v.len() - 1)];
        i += 1;
        s.to_string()
    }
}

#[test]
fn crear_carpeta_con_perfil_json_y_features_vacio_indice_actualizado_el_activo_no_cambia() {
    let d = perfiles_listos();
    let p = crear_perfil_fs(&d, "  Trabajo ", AHORA + 10, azar_fijo(&["abc123"])).unwrap();
    assert_eq!((p.id.as_str(), p.nombre.as_str()), ("p-abc123", "Trabajo"));
    assert!(d.join("perfiles/p-abc123/features").is_dir());
    assert_eq!(leer_meta(&d.join("perfiles/p-abc123")), Some(p));
    let i = leer_indice_vigente(&d).unwrap();
    assert_eq!(i.activo, "principal");
    assert_eq!(i.perfiles.len(), 2);
}

#[test]
fn crear_rechaza_nombre_repetido_vacio_largo_o_con_control_sin_tocar_nada() {
    let d = perfiles_listos();
    let antes = foto(&d, None);
    for mal in ["MI PERFIL", "", "   ", &"x".repeat(41), "a\nb"] {
        assert!(crear_perfil_fs(&d, mal, AHORA, azar_fijo(&["z1"])).is_err(), "{mal:?}");
    }
    assert_eq!(foto(&d, None), antes);
    assert!(!d.join("perfiles/p-z1").exists());
}

#[test]
fn crear_si_el_id_al_azar_ya_existe_como_carpeta_usa_otro() {
    let d = perfiles_listos();
    fs::create_dir_all(d.join("perfiles/p-uno")).unwrap();
    let p = crear_perfil_fs(&d, "Nuevo", AHORA, azar_fijo(&["uno", "dos"])).unwrap();
    assert_eq!(p.id, "p-dos");
}

#[test]
fn crear_si_no_se_puede_escribir_el_indice_la_carpeta_nueva_se_saca() {
    let d = perfiles_listos();
    // El .tmp del índice ocupado por una carpeta: el guardado falla pero el índice sigue legible.
    fs::create_dir(format!("{}.{}.tmp", rutas_perfiles(&d).indice.display(), std::process::id())).unwrap();
    let antes = leer_indice_vigente(&d);
    assert!(crear_perfil_fs(&d, "Nuevo", AHORA, azar_fijo(&["fallo"])).is_err());
    assert!(!d.join("perfiles/p-fallo").exists());
    assert_eq!(leer_indice_vigente(&d), antes);
}

#[test]
fn renombrar_actualiza_perfil_json_y_el_indice_y_rechaza_repetido_y_nombres_malos() {
    let d = perfiles_listos();
    let p = crear_perfil_fs(&d, "Casa", AHORA, azar_fijo(&["casa"])).unwrap();
    let nuevo = renombrar_perfil_fs(&d, &p.id, " Hogar ").unwrap();
    assert_eq!(nuevo.nombre, "Hogar");
    assert_eq!(leer_meta(&d.join("perfiles/p-casa")).unwrap().nombre, "Hogar");
    assert!(leer_indice_vigente(&d).unwrap().perfiles.iter().any(|x| x.nombre == "Hogar"));
    assert!(renombrar_perfil_fs(&d, &p.id, "mi perfil").is_err());
    assert!(renombrar_perfil_fs(&d, &p.id, "").is_err());
    assert!(renombrar_perfil_fs(&d, &p.id, "HOGAR").is_ok(), "puede cambiar solo las mayúsculas de su propio nombre");
}

#[test]
fn cambiar_activo_solo_toca_activo_y_exige_un_perfil_existente() {
    let d = perfiles_listos();
    let p = crear_perfil_fs(&d, "Casa", AHORA, azar_fijo(&["casa"])).unwrap();
    cambiar_activo_fs(&d, &p.id).unwrap();
    let i = leer_indice_vigente(&d).unwrap();
    assert_eq!((i.activo.as_str(), i.perfiles.len()), ("p-casa", 2));
    assert!(cambiar_activo_fs(&d, "p-nada").is_err());
    assert!(cambiar_activo_fs(&d, "../x").is_err());
}

#[test]
fn cambiar_un_destino_danado_se_rechaza_antes_de_escribir_y_se_aplica_al_confirmar() {
    let d = perfiles_listos();
    let p = crear_perfil_fs(&d, "Casa", AHORA, azar_fijo(&["casa"])).unwrap();
    fs::write(d.join("perfiles/p-casa/perfil.json"), "{ roto").unwrap();
    assert!(preparar_cambio_fs(&d, &p.id).is_err());
    assert_eq!(leer_indice_vigente(&d).unwrap().activo, "principal");
    escribir(&d, "perfiles/p-casa/perfil.json", &serde_json::to_vec(&p.a_json()).unwrap());
    let aplicar = preparar_cambio_fs(&d, &p.id).unwrap();
    assert_eq!(leer_indice_vigente(&d).unwrap().activo, "principal", "preparar no escribe");
    aplicar().unwrap();
    assert_eq!(leer_indice_vigente(&d).unwrap().activo, "p-casa");
}

#[test]
fn borrar_mueve_a_respaldos_con_su_contenido_y_no_pisa_un_respaldo_previo() {
    let d = perfiles_listos();
    let p = crear_perfil_fs(&d, "Casa", AHORA, azar_fijo(&["casa"])).unwrap();
    escribir(&d, "perfiles/p-casa/features/x.json", b"{\"a\":1}");
    let destino = borrar_perfil_fs(&d, &p.id, AHORA + 1).unwrap();
    assert!(!d.join("perfiles/p-casa").exists());
    assert_eq!(fs::read(destino.join("features/x.json")).unwrap(), b"{\"a\":1}");
    assert!(leer_indice_vigente(&d).unwrap().perfiles.iter().all(|x| x.id != "p-casa"));
    let otra = crear_perfil_fs(&d, "Casa", AHORA, azar_fijo(&["casa"])).unwrap();
    let destino2 = borrar_perfil_fs(&d, &otra.id, AHORA + 1).unwrap();
    assert_ne!(destino, destino2);
    assert!(destino.exists() && destino2.exists());
}

#[test]
fn borrar_no_el_activo_no_el_ultimo_no_uno_que_no_existe() {
    let d = perfiles_listos();
    assert!(borrar_perfil_fs(&d, "principal", AHORA).unwrap_err().contains("activo"));
    assert!(borrar_perfil_fs(&d, "p-nada", AHORA).is_err());
    let p = crear_perfil_fs(&d, "Casa", AHORA, azar_fijo(&["casa"])).unwrap();
    cambiar_activo_fs(&d, &p.id).unwrap();
    borrar_perfil_fs(&d, "principal", AHORA).unwrap();
    assert!(borrar_perfil_fs(&d, &p.id, AHORA).is_err());
}

#[test]
fn borrar_si_el_indice_no_se_puede_escribir_el_perfil_vuelve_a_su_lugar() {
    let d = perfiles_listos();
    let p = crear_perfil_fs(&d, "Casa", AHORA, azar_fijo(&["casa"])).unwrap();
    escribir(&d, "perfiles/p-casa/features/x.json", b"{}");
    fs::create_dir(format!("{}.{}.tmp", rutas_perfiles(&d).indice.display(), std::process::id())).unwrap();
    assert!(borrar_perfil_fs(&d, &p.id, AHORA + 1).is_err());
    assert!(d.join("perfiles/p-casa/features/x.json").exists());
    assert!(leer_indice_vigente(&d).unwrap().perfiles.iter().any(|x| x.id == "p-casa"));
}

#[test]
fn ids_con_barras_mayusculas_rutas_o_reservados_se_rechazan_en_todas_las_operaciones() {
    let d = perfiles_listos();
    for mal in ["../x", "..", "A", "C:\\Windows", "con", "p/x", "", "a\\b"] {
        assert!(renombrar_perfil_fs(&d, mal, "X").is_err(), "{mal}");
        assert!(cambiar_activo_fs(&d, mal).is_err(), "{mal}");
        assert!(borrar_perfil_fs(&d, mal, AHORA).is_err(), "{mal}");
        assert!(guardar_gh_login(&d, mal, "octo").is_err(), "{mal}");
        assert!(guardar_foto(&d, mal, &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).is_err(), "{mal}");
        assert!(leer_foto_data_url(&d, mal).is_err(), "{mal}");
        assert!(!tiene_foto(&d, mal));
    }
}

#[test]
fn foto_guarda_png_jpeg_webp_devuelve_data_url_y_rechaza_lo_que_no_es_imagen_o_pesa_de_mas() {
    let d = perfiles_listos();
    let png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
    assert!(!tiene_foto(&d, "principal"));
    assert_eq!(leer_foto_data_url(&d, "principal").unwrap(), None);
    guardar_foto(&d, "principal", &png).unwrap();
    assert!(tiene_foto(&d, "principal"));
    let url = leer_foto_data_url(&d, "principal").unwrap().unwrap();
    assert!(url.starts_with("data:image/png;base64,"));
    guardar_foto(&d, "principal", &[0xff, 0xd8, 0xff, 0xe0, 1]).unwrap();
    assert!(leer_foto_data_url(&d, "principal").unwrap().unwrap().starts_with("data:image/jpeg;base64,"));
    let mut webp = b"RIFF\0\0\0\0WEBPVP8 ".to_vec();
    webp.extend_from_slice(&[0; 8]);
    guardar_foto(&d, "principal", &webp).unwrap();
    assert!(leer_foto_data_url(&d, "principal").unwrap().unwrap().starts_with("data:image/webp;base64,"));
    assert!(guardar_foto(&d, "principal", b"no es imagen").is_err());
    assert!(guardar_foto(&d, "principal", &[]).is_err());
    let mut grande = png.to_vec();
    grande.resize(MAX_BYTES_FOTO + 1, 0);
    assert!(guardar_foto(&d, "principal", &grande).is_err());
}

#[test]
fn foto_alterada_a_mano_no_se_devuelve() {
    let d = perfiles_listos();
    fs::write(d.join("perfiles/principal/foto.png"), "no es una imagen").unwrap();
    assert_eq!(leer_foto_data_url(&d, "principal").unwrap(), None);
    fs::write(d.join("perfiles/principal/foto.png"), vec![0x89u8; MAX_BYTES_FOTO + 10]).unwrap();
    assert_eq!(leer_foto_data_url(&d, "principal").unwrap(), None);
}

#[test]
fn gh_login_se_valida_y_queda_en_perfil_json_y_en_el_indice() {
    let d = perfiles_listos();
    assert!(guardar_gh_login(&d, "principal", "a b").is_err());
    assert!(guardar_gh_login(&d, "principal", "").is_err());
    let p = guardar_gh_login(&d, "principal", "octo-cat").unwrap();
    assert_eq!(p.gh_login.as_deref(), Some("octo-cat"));
    assert_eq!(leer_meta(&d.join("perfiles/principal")).unwrap().gh_login.as_deref(), Some("octo-cat"));
    assert_eq!(leer_indice_vigente(&d).unwrap().perfiles[0].gh_login.as_deref(), Some("octo-cat"));
}

#[test]
fn perfil_json_ilegible_con_indice_sano_no_migra_de_nuevo_ni_cae_a_la_raiz() {
    let d = perfiles_listos();
    let meta = d.join("perfiles/principal/perfil.json");
    fs::remove_file(&meta).unwrap();
    fs::create_dir(&meta).unwrap(); // no se puede leer como archivo
    let antes = foto(&d, Some(&["perfiles.json"]));
    let r = iniciar_perfiles_fs(&d, &|| AHORA + 1);
    assert!(r.bloqueado.is_some() && r.error.is_none() && !r.migrado);
    assert_eq!(foto(&d, Some(&["perfiles.json"])), antes);
    assert!(meta.is_dir(), "no se tocó");
}

#[test]
fn perfil_json_roto_en_el_unico_perfil_no_se_aparta_ni_se_migra() {
    let d = perfiles_listos();
    fs::remove_file(rutas_perfiles(&d).indice).unwrap();
    fs::write(d.join("perfiles/principal/perfil.json"), "{ roto").unwrap();
    let r = iniciar_perfiles_fs(&d, &|| AHORA + 1);
    assert!(r.bloqueado.is_some() && !r.migrado);
    assert_eq!(fs::read_to_string(d.join("perfiles/principal/perfil.json")).unwrap(), "{ roto");
    assert!(!listar(&d.join("perfiles/principal")).unwrap().iter().any(|n| n.contains("corrupt")));
}

#[test]
fn perfiles_json_de_una_version_futura_no_se_aparta_ni_se_reescribe() {
    let d = perfiles_listos();
    let futuro = br#"{"version":2,"activo":"principal","perfiles":[],"nuevo":true}"#;
    fs::write(rutas_perfiles(&d).indice, futuro).unwrap();
    let r = iniciar_perfiles_fs(&d, &|| AHORA + 1);
    assert_eq!(r.indice.activo, "principal", "sigue con los perfiles en memoria");
    assert!(r.reconstruido && r.aviso_usuario.as_deref().is_some_and(|a| a.contains("No guardé perfiles.json")));
    assert_eq!(fs::read(rutas_perfiles(&d).indice).unwrap(), futuro);
    assert!(!listar(&d).unwrap().iter().any(|n| n.contains("corrupt")));
}

#[test]
fn perfil_json_futuro_no_se_aparta_y_si_es_el_unico_se_avisa() {
    let d = perfiles_listos();
    fs::remove_file(rutas_perfiles(&d).indice).unwrap();
    let futuro = br#"{"version":2,"id":"principal","nombre":"Mi perfil","creado":1}"#;
    fs::write(d.join("perfiles/principal/perfil.json"), futuro).unwrap();
    let r = iniciar_perfiles_fs(&d, &|| AHORA + 1);
    assert!(r.bloqueado.as_deref().is_some_and(|b| b.contains("más nueva")));
    assert_eq!(fs::read(d.join("perfiles/principal/perfil.json")).unwrap(), futuro);
}

#[test]
fn perfil_futuro_de_uno_que_no_es_el_activo_queda_como_esta_y_el_indice_no_lo_deja_afuera() {
    let d = perfiles_listos();
    let p = crear_perfil_fs(&d, "Casa", AHORA, azar_fijo(&["casa"])).unwrap();
    let futuro = br#"{"version":3,"id":"p-casa","nombre":"Casa","creado":1}"#;
    fs::write(d.join("perfiles/p-casa/perfil.json"), futuro).unwrap();
    fs::remove_file(rutas_perfiles(&d).indice).unwrap();
    let r = iniciar_perfiles_fs(&d, &|| AHORA + 1);
    assert_eq!(r.indice.activo, "principal");
    assert!(r.reconstruido && r.aviso_usuario.is_some());
    assert!(!rutas_perfiles(&d).indice.exists(), "no se guardó un índice que dejaría afuera a {}", p.id);
    assert_eq!(fs::read(d.join("perfiles/p-casa/perfil.json")).unwrap(), futuro);
}

#[test]
fn candado_con_otra_copia_migrando_no_se_migra_ni_se_toca_nada() {
    let d = raiz();
    sembrar(&d);
    let r = rutas_perfiles(&d);
    let ResultadoCandado::Tomado(c) = tomar_candado(&r.candado, None).unwrap() else { panic!("debía tomarlo") };
    let antes = foto(&d, None);
    let res = iniciar_perfiles_fs(&d, &ahora);
    assert!(res.bloqueado.as_deref().is_some_and(|b| b.contains("Otra copia de Sloth")));
    assert!(!res.migrado);
    assert!(!d.join("perfiles").exists());
    c.liberar().unwrap();
    assert_eq!(foto(&d, None).keys().filter(|k| *k != "perfiles.lock").count(), antes.keys().filter(|k| *k != "perfiles.lock").count());
}

#[test]
fn candado_abandonado_no_frena_la_migracion_y_no_queda_ninguno_al_terminar() {
    let d = raiz();
    sembrar(&d);
    let r = rutas_perfiles(&d);
    fs::write(&r.candado, serde_json::to_string(&json!({ "pid": 0x7fff_fff0u32, "desde": 1 })).unwrap()).unwrap();
    let res = iniciar_perfiles_fs(&d, &ahora);
    assert!(res.migrado);
    assert!(!r.candado.exists());
}

#[cfg(windows)]
#[test]
fn enlaces_dentro_de_features_no_se_siguen_ni_en_la_copia_ni_en_el_respaldo() {
    let d = raiz();
    sembrar(&d);
    let afuera = raiz();
    escribir(&afuera, "secreto.txt", b"no-copiar");
    let enlace = d.join("features").join("enlace");
    let ok = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(&enlace).arg(&afuera).output().map(|o| o.status.success()).unwrap_or(false);
    if !ok {
        return; // sin permiso para crear junctions en este entorno
    }
    let res = iniciar_perfiles_fs(&d, &ahora);
    assert!(res.migrado, "{res:?}");
    assert!(!d.join("perfiles/principal/features/enlace").exists());
    assert!(!d.join("respaldos").join(format!("pre-perfiles-{AHORA}")).join("features/enlace").exists());
    assert!(res.aviso_usuario.as_deref().is_some_and(|a| a.contains("no copié un enlace")));
    assert_eq!(fs::read(afuera.join("secreto.txt")).unwrap(), b"no-copiar");
}

#[test]
fn tipo_imagen_solo_mira_los_bytes() {
    assert_eq!(tipo_imagen(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Some("image/png"));
    assert_eq!(tipo_imagen(&[0xff, 0xd8, 0xff]), Some("image/jpeg"));
    assert_eq!(tipo_imagen(b"RIFFxxxxWEBP"), Some("image/webp"));
    assert_eq!(tipo_imagen(b"RIFFxxxxWAVE"), None);
    assert_eq!(tipo_imagen(b"GIF89a"), None);
    assert_eq!(tipo_imagen(&[]), None);
}
