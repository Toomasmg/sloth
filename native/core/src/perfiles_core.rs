//! Perfiles: validación del índice, nombres e ids, y qué terminales son de cada perfil. Equivale a src/main/perfiles-core.ts.
use crate::versionado::{migrar, EstadoVersion, Migraciones};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, PartialEq)]
pub struct Perfil {
    pub id: String,
    pub nombre: String,
    pub creado: f64,
    pub gh_login: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IndicePerfiles {
    pub activo: String,
    pub perfiles: Vec<Perfil>,
}

pub const PERFIL_INICIAL_ID: &str = "principal";
pub const NOMBRE_INICIAL: &str = "Mi perfil";
/// Entradas de la raíz de userData que pasan a ser del perfil. Todo lo demás es común a la app.
pub const ENTRADAS_DE_PERFIL: [&str; 2] = ["sloth-state.json", "features"];
pub const MAX_PERFILES: usize = 50;
const MAX_NOMBRE: usize = 40;

/// Los blancos que `String.prototype.trim` de JavaScript recorta (incluye U+FEFF; no incluye U+0085).
fn es_blanco_js(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn es_control(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}')
}

/// Cambian el sentido del texto o son invisibles: un nombre podría hacerse pasar por otro.
fn es_enganoso(c: char) -> bool {
    matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
}

pub fn login_gh_valido(s: &str) -> bool {
    (1..=39).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// El id es nombre de carpeta: Windows no deja crear estas aunque el resto del formato sea válido.
fn reservado_windows(id: &str) -> bool {
    matches!(id, "con" | "prn" | "aux" | "nul")
        || ((id.len() == 4) && (id.starts_with("com") || id.starts_with("lpt")) && id.as_bytes()[3].is_ascii_digit())
}

pub fn id_perfil_valido(id: &str) -> bool {
    let b = id.as_bytes();
    (1..=40).contains(&b.len())
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && !reservado_windows(id)
}

pub fn nombre_perfil_valido(n: &str) -> Option<String> {
    let nfc: String = n.nfc().collect();
    let limpio = nfc.trim_matches(es_blanco_js);
    if limpio.is_empty() || limpio.chars().count() > MAX_NOMBRE || limpio.chars().any(|c| es_control(c) || es_enganoso(c)) {
        return None;
    }
    Some(limpio.to_string())
}

pub fn nombre_libre(nombre: &str, perfiles: &[Perfil], ignorar_id: Option<&str>) -> bool {
    let k = clave_nombre(nombre);
    !perfiles.iter().any(|p| Some(p.id.as_str()) != ignorar_id && p.nombre.to_lowercase() == k)
}

fn clave_nombre(n: &str) -> String {
    n.nfc().collect::<String>().trim_matches(es_blanco_js).to_lowercase()
}

pub fn nuevo_id_perfil(existentes: &[String], mut azar: impl FnMut() -> String) -> String {
    loop {
        let id = format!("p-{}", azar());
        if id_perfil_valido(&id) && !existentes.contains(&id) {
            return id;
        }
    }
}

pub fn validar_meta(raw: &Value) -> Option<Perfil> {
    let o = raw.as_object()?;
    let id = o.get("id")?.as_str().filter(|i| id_perfil_valido(i))?.to_string();
    let nombre = nombre_perfil_valido(o.get("nombre")?.as_str()?)?;
    let creado = o.get("creado")?.as_f64().filter(|c| c.is_finite() && *c >= 0.0)?;
    let gh_login = match o.get("ghLogin") {
        None => None,
        Some(v) => Some(v.as_str().filter(|l| login_gh_valido(l))?.to_string()),
    };
    Some(Perfil { id, nombre, creado, gh_login })
}

pub fn validar_indice(raw: &Value) -> Option<IndicePerfiles> {
    let o = raw.as_object()?;
    if o.get("version").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    let lista = o.get("perfiles")?.as_array()?;
    let activo = o.get("activo")?.as_str()?.to_string();
    let mut perfiles: Vec<Perfil> = Vec::new();
    for x in lista {
        let p = validar_meta(x)?;
        if perfiles.iter().any(|o| o.id == p.id) {
            return None;
        }
        perfiles.push(p);
    }
    perfiles.iter().any(|p| p.id == activo).then_some(IndicePerfiles { activo, perfiles })
}

pub fn reconstruir_indice(metas: &[Perfil], activo_previo: Option<&str>) -> Option<IndicePerfiles> {
    let mut ordenadas: Vec<&Perfil> = metas.iter().collect();
    ordenadas.sort_by(|a, b| a.creado.partial_cmp(&b.creado).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.id.cmp(&b.id)));
    let mut unicos: Vec<Perfil> = Vec::new();
    for m in ordenadas {
        if !unicos.iter().any(|u| u.id == m.id) {
            unicos.push(m.clone());
        }
    }
    let primero = unicos.first()?.id.clone();
    let activo = activo_previo.filter(|a| unicos.iter().any(|p| p.id == *a)).map(str::to_owned).unwrap_or(primero);
    Some(IndicePerfiles { activo, perfiles: unicos })
}

pub fn es_panel_login(id: &str) -> bool {
    id.starts_with("login:")
}

/// Los ids de espacio son UUID únicos entre perfiles; la terminal de login de una cuenta (`login:<cuenta>`) no es de
/// ningún espacio pero es de quien tenga esa cuenta.
pub fn es_terminal_propia(id: &str, tiene_espacio: &dyn Fn(&str) -> bool, tiene_cuenta: &dyn Fn(&str) -> bool) -> bool {
    tiene_espacio(id) || (es_panel_login(id) && tiene_cuenta(&id["login:".len()..]))
}

pub struct Sesion {
    pub id: String,
    pub running: bool,
}

/// Terminales vivas en el daemon que no son de este perfil.
pub fn terminales_ajenas(sesiones: &[Sesion], es_propia: &dyn Fn(&str) -> bool) -> Vec<String> {
    sesiones.iter().filter(|s| s.running && !es_propia(&s.id)).map(|s| s.id.clone()).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CierreTerminales {
    Conservar,
    Apagar,
    CerrarPropias,
}

/// Qué hacer con las terminales al salir. Con terminales de otros perfiles vivas en el daemon nunca se lo apaga entero:
/// «Terminales vivas» apagado en este perfil solo vale para las terminales de este perfil.
pub fn decidir_cierre_terminales(conservar: bool, en_proceso: bool, hay_ajenas: bool) -> CierreTerminales {
    if en_proceso {
        CierreTerminales::Apagar
    } else if conservar {
        CierreTerminales::Conservar
    } else if hay_ajenas {
        CierreTerminales::CerrarPropias
    } else {
        CierreTerminales::Apagar
    }
}

#[derive(Debug, PartialEq)]
pub enum LecturaClasificada<T> {
    Ok(T),
    Futura,
    Invalida,
}

/// Una versión más nueva que la que entiende esta Sloth no está rota: no se aparta ni se reescribe.
pub fn clasificar_json<T>(texto: &str, validar: impl Fn(&Value) -> Option<T>) -> LecturaClasificada<T> {
    let Ok(raw) = serde_json::from_str::<Value>(texto.strip_prefix('\u{feff}').unwrap_or(texto)) else { return LecturaClasificada::Invalida };
    match migrar(&raw, &Migraciones::new(), 1).estado {
        EstadoVersion::Futura => LecturaClasificada::Futura,
        EstadoVersion::Invalida => LecturaClasificada::Invalida,
        _ => validar(&raw).map_or(LecturaClasificada::Invalida, LecturaClasificada::Ok),
    }
}

pub fn a_copiar(entradas_raiz: &[&str]) -> Vec<String> {
    entradas_raiz.iter().filter(|e| ENTRADAS_DE_PERFIL.contains(e)).map(|e| e.to_string()).collect()
}

/// Quita `.` y resuelve `..` sin tocar el disco, como `path.resolve` de Node.
fn normalizar(p: &Path) -> PathBuf {
    let abs = std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf());
    let mut salida = PathBuf::new();
    for c in abs.components() {
        match c {
            Component::ParentDir => {
                salida.pop();
            }
            Component::CurDir => {}
            otro => salida.push(otro.as_os_str()),
        }
    }
    salida
}

fn componentes(p: &Path) -> Vec<String> {
    p.components().map(|c| if cfg!(windows) { c.as_os_str().to_string_lossy().to_lowercase() } else { c.as_os_str().to_string_lossy().into_owned() }).collect()
}

/// ¿`destino` está estrictamente dentro de `base`? Rechaza salir con `..` y carpetas hermanas con el mismo prefijo.
pub fn dentro_de(base: &Path, destino: &Path) -> bool {
    let (b, d) = (componentes(&normalizar(base)), componentes(&normalizar(destino)));
    d.len() > b.len() && d[..b.len()] == b[..]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn p(id: &str, nombre: &str, creado: f64) -> Perfil {
        Perfil { id: id.into(), nombre: nombre.into(), creado, gh_login: None }
    }

    #[test]
    fn ids_solo_minusculas_digitos_y_guiones_sin_reservados_de_windows() {
        for ok in ["principal", "p-abc123", "a", &"x".repeat(40), "con1", "nulo"] {
            assert!(id_perfil_valido(ok), "{ok}");
        }
        for mal in ["", "../x", "..", ".", "A", "a/b", "a\\b", "-a", &"x".repeat(41), "con", "nul", "aux", "prn", "com1", "lpt9", "perfil.", "ñandú", "a b"] {
            assert!(!id_perfil_valido(mal), "{mal}");
        }
    }

    #[test]
    fn nombre_se_recorta_de_1_a_40_sin_control_ni_enganosos() {
        assert_eq!(nombre_perfil_valido("  Trabajo  ").as_deref(), Some("Trabajo"));
        assert_eq!(nombre_perfil_valido("Ñandú 🦥").as_deref(), Some("Ñandú 🦥"));
        assert_eq!(nombre_perfil_valido("../../Windows").as_deref(), Some("../../Windows"));
        assert_eq!(nombre_perfil_valido(&"🦥".repeat(40)), Some("🦥".repeat(40)));
        assert_eq!(nombre_perfil_valido(&"x".repeat(40)), Some("x".repeat(40)));
        for mal in ["", "   ", &"x".repeat(41), "a\nb", "a\u{0}b", "a\u{7f}b", "abc\u{202e}dcba", "a\u{200b}b"] {
            assert_eq!(nombre_perfil_valido(mal), None, "{mal:?}");
        }
        assert_eq!(nombre_perfil_valido("José").as_deref(), Some("José"));
        // JavaScript recorta el BOM de los extremos y no el NEL (U+0085): igual acá.
        assert_eq!(nombre_perfil_valido("\u{feff}Casa\u{feff}").as_deref(), Some("Casa"));
        assert_eq!(nombre_perfil_valido("Casa\u{85}"), None);
        // Normaliza a NFC: «e» + acento combinado queda como «é».
        assert_eq!(nombre_perfil_valido("Jose\u{301}").as_deref(), Some("José"));
    }

    #[test]
    fn nombre_libre_no_distingue_mayusculas_y_puede_ignorar_el_propio() {
        let lista = [p("principal", "Mi perfil", 1.0), p("p-1", "Trabajo", 2.0)];
        assert!(!nombre_libre("TRABAJO", &lista, None));
        assert!(!nombre_libre(" trabajo ", &lista, None));
        assert!(nombre_libre("Trabajo", &lista, Some("p-1")));
        assert!(nombre_libre("Casa", &lista, None));
    }

    #[test]
    fn nuevo_id_reintenta_hasta_no_chocar() {
        let mut salidas = vec!["abc", "abc", "def"].into_iter();
        assert_eq!(nuevo_id_perfil(&["p-abc".to_string()], || salidas.next().unwrap_or("zzz").to_string()), "p-def");
    }

    #[test]
    fn validar_meta_exige_id_nombre_y_fecha_validos() {
        assert_eq!(validar_meta(&json!({ "id": "principal", "nombre": "Mi perfil", "creado": 5, "extra": 1 })), Some(p("principal", "Mi perfil", 5.0)));
        let con_gh = validar_meta(&json!({ "id": "p-1", "nombre": "A", "creado": 1, "ghLogin": "octo-cat" })).unwrap();
        assert_eq!(con_gh.gh_login.as_deref(), Some("octo-cat"));
        for mal in [
            json!(null),
            json!([]),
            json!("x"),
            json!({ "id": "../x", "nombre": "A", "creado": 1 }),
            json!({ "id": "a", "nombre": "", "creado": 1 }),
            json!({ "id": "a", "nombre": "A", "creado": "hoy" }),
            json!({ "id": "a", "nombre": "A", "creado": -1 }),
            json!({ "id": "a", "nombre": "A", "creado": 1, "ghLogin": "a b" }),
        ] {
            assert_eq!(validar_meta(&mal), None, "{mal}");
        }
    }

    fn indice(activo: &str, perfiles: Vec<Value>) -> Value {
        json!({ "version": 1, "activo": activo, "perfiles": perfiles })
    }
    fn meta(id: &str, nombre: &str, creado: u32) -> Value {
        json!({ "id": id, "nombre": nombre, "creado": creado })
    }

    #[test]
    fn validar_indice_rechaza_activo_inexistente_repetidos_otra_version_y_no_objetos() {
        let bueno = indice("principal", vec![meta("principal", "Mi perfil", 1)]);
        let v = validar_indice(&bueno).unwrap();
        assert_eq!((v.activo.as_str(), v.perfiles.len()), ("principal", 1));
        assert!(validar_indice(&indice("otro", vec![meta("principal", "Mi perfil", 1)])).is_none());
        assert!(validar_indice(&indice("principal", vec![meta("principal", "A", 1), meta("principal", "B", 2)])).is_none());
        let mut v2 = bueno.clone();
        v2["version"] = json!(2);
        assert!(validar_indice(&v2).is_none());
        assert!(validar_indice(&indice("con", vec![meta("con", "A", 1)])).is_none());
        for mal in [json!(null), json!("x"), json!([]), json!(1), json!({ "version": 1 })] {
            assert!(validar_indice(&mal).is_none());
        }
    }

    #[test]
    fn reconstruir_ordena_por_fecha_y_conserva_el_activo_previo_si_existe() {
        let metas = [p("p-b", "B", 20.0), p("principal", "Mi perfil", 10.0)];
        let r = reconstruir_indice(&metas, Some("p-b")).unwrap();
        assert_eq!(r.activo, "p-b");
        assert_eq!(r.perfiles.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["principal", "p-b"]);
        assert_eq!(reconstruir_indice(&metas, Some("p-perdido")).unwrap().activo, "principal");
        assert_eq!(reconstruir_indice(&metas, None).unwrap().activo, "principal");
        assert!(reconstruir_indice(&[], None).is_none());
    }

    fn s(id: &str, running: bool) -> Sesion {
        Sesion { id: id.into(), running }
    }

    #[test]
    fn terminales_ajenas_las_vivas_sin_espacio_en_este_perfil() {
        let sesiones = [s("ws-1", true), s("ws-otro", true), s("ws-muerta", false)];
        assert_eq!(terminales_ajenas(&sesiones, &|id| id == "ws-1"), ["ws-otro"]);
        assert!(terminales_ajenas(&[], &|_| false).is_empty());
    }

    #[test]
    fn la_terminal_de_login_de_una_cuenta_propia_no_es_ajena() {
        let propia = |id: &str| es_terminal_propia(id, &|x| x == "ws-1", &|x| x == "cta-propia");
        let sesiones = [s("ws-1", true), s("login:cta-propia", true), s("login:cta-de-otro-perfil", true), s("ws-otro", true), s("login:cta-propia-cerrada", false)];
        assert_eq!(terminales_ajenas(&sesiones, &propia), ["login:cta-de-otro-perfil", "ws-otro"]);
        assert!(!propia("login:"));
        assert!(propia("ws-1"));
    }

    #[test]
    fn a_copiar_solo_el_estado_y_las_funciones() {
        assert_eq!(
            a_copiar(&["accounts", "daemon-key", "daemon-token", "sloth-state.json", "sloth-state.json.bak-1", "sloth-state.json.corrupt-2", "features", "logs", "whisper", "perfiles", "respaldos"]),
            ["sloth-state.json", "features"]
        );
    }

    #[test]
    fn dentro_de_rechaza_salir_con_puntos_y_carpetas_hermanas() {
        let base = Path::new("/a").join("perfiles");
        assert!(dentro_de(&base, &base.join("principal")));
        assert!(dentro_de(&base, &base.join("principal").join("features").join("x.json")));
        assert!(!dentro_de(&base, &base));
        assert!(!dentro_de(&base, &base.join("..").join("accounts")));
        assert!(!dentro_de(&base, &base.join("principal").join("..").join("..").join("x")));
        assert!(!dentro_de(&base, &Path::new("/a").join("perfiles-x")));
        assert!(!dentro_de(&base, &Path::new("/a").join("perfiles-x").join("y")));
    }

    #[test]
    fn decidir_cierre_con_terminales_de_otros_perfiles_no_apaga_el_daemon_entero() {
        use CierreTerminales::*;
        assert_eq!(decidir_cierre_terminales(false, false, false), Apagar);
        assert_eq!(decidir_cierre_terminales(false, false, true), CerrarPropias);
        assert_eq!(decidir_cierre_terminales(true, false, true), Conservar);
        assert_eq!(decidir_cierre_terminales(true, false, false), Conservar);
        assert_eq!(decidir_cierre_terminales(true, true, true), Apagar);
    }

    #[test]
    fn clasificar_json_una_version_futura_no_es_corrupta() {
        let validar = |v: &Value| validar_meta(v);
        let ok = |t: &str| matches!(clasificar_json(t, validar), LecturaClasificada::Ok(_));
        assert!(ok("{\"id\":\"principal\",\"nombre\":\"Mi perfil\",\"creado\":1}"));
        assert!(ok("\u{feff}{\"version\":1,\"id\":\"principal\",\"nombre\":\"Mi perfil\",\"creado\":1}"));
        assert_eq!(clasificar_json("{\"version\":2,\"id\":\"principal\",\"nombre\":\"Mi perfil\",\"creado\":1,\"nuevo\":true}", validar), LecturaClasificada::Futura);
        assert_eq!(clasificar_json("{\"version\":2,\"id\":42,\"nombre\":{\"es\":\"x\"}}", validar), LecturaClasificada::Futura);
        assert_eq!(clasificar_json("{ roto", validar), LecturaClasificada::Invalida);
        assert_eq!(clasificar_json("[]", validar), LecturaClasificada::Invalida);
        assert_eq!(clasificar_json("{\"version\":\"x\",\"id\":\"principal\",\"nombre\":\"A\",\"creado\":1}", validar), LecturaClasificada::Invalida);
        assert_eq!(clasificar_json("{\"id\":\"../x\",\"nombre\":\"A\",\"creado\":1}", validar), LecturaClasificada::Invalida);
    }
}
