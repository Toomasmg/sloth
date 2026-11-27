//! Lectura y escritura de los JSON del usuario. Equivale a src/main/json-file.ts: tmp + fsync + rename, archivos
//! dañados que se apartan en vez de pisarse, solo lectura cuando no se puede leer ni apartar, respaldos podados.
use crate::avisos::Avisos;
use serde_json::Value;
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const RESPALDOS_POR_ARCHIVO: usize = 5;
const TMP_HUERFANO: Duration = Duration::from_secs(60);

pub struct OpcionesLectura<'a, T> {
    /// Devuelve el valor normalizado, o None si el contenido no sirve (el archivo se aparta).
    pub validar: &'a dyn Fn(&Value) -> Option<T>,
    pub por_defecto: &'a dyn Fn() -> T,
    /// Sin aviso a la UI (p. ej. quien llama arma su propio mensaje).
    pub silencioso: bool,
    /// Solo mirar: ante cualquier problema devuelve el valor por defecto sin apartar, avisar ni bloquear.
    pub solo_consulta: bool,
}

impl<'a, T> OpcionesLectura<'a, T> {
    pub fn nuevas(validar: &'a dyn Fn(&Value) -> Option<T>, por_defecto: &'a dyn Fn() -> T) -> Self {
        OpcionesLectura { validar, por_defecto, silencioso: false, solo_consulta: false }
    }
}

#[derive(Debug, PartialEq)]
pub struct LecturaJson<T> {
    pub valor: T,
    /// Ruta donde quedó el archivo roto, si hubo que apartarlo.
    pub apartado: Option<PathBuf>,
    /// No se pudo leer o apartar: el archivo puede estar sano, así que no se escribe encima hasta reiniciar.
    pub solo_lectura: bool,
    pub motivo: Option<String>,
}

fn bloqueados() -> &'static Mutex<HashSet<String>> {
    static B: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    B.get_or_init(Mutex::default)
}

fn clave(p: &Path) -> String {
    let abs = std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf());
    let t = abs.to_string_lossy().into_owned();
    if cfg!(windows) {
        t.to_lowercase()
    } else {
        t
    }
}

fn ahora_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// `<base>` si está libre; si no, `<base>-1`, `<base>-2`...
pub fn ruta_libre(base: &str) -> PathBuf {
    let b = PathBuf::from(base);
    if !b.exists() {
        return b;
    }
    (1..).map(|i| PathBuf::from(format!("{base}-{i}"))).find(|p| !p.exists()).expect("rango infinito")
}

/// ¿Este archivo quedó en solo lectura en esta sesión?
pub fn bloqueado(p: &Path) -> bool {
    bloqueados().lock().unwrap_or_else(|e| e.into_inner()).contains(&clave(p))
}

fn en_solo_lectura<T>(p: &Path, o: &OpcionesLectura<T>, avisos: &Avisos, motivo: String) -> LecturaJson<T> {
    bloqueados().lock().unwrap_or_else(|e| e.into_inner()).insert(clave(p));
    if !o.silencioso {
        avisos.solo_lectura(p, &motivo);
    }
    LecturaJson { valor: (o.por_defecto)(), apartado: None, solo_lectura: true, motivo: Some(motivo) }
}

fn nombre(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Lee un JSON del usuario. Si no existe, el valor por defecto. Si existe pero no se puede usar, lo aparta como
/// `<archivo>.corrupt-<ts>` para que el próximo guardado no lo pise. Si no se puede leer (permisos, antivirus) o
/// apartar, no falla: devuelve el valor por defecto y deja el archivo en solo lectura, porque puede estar sano.
pub fn leer_json<T>(p: &Path, o: &OpcionesLectura<T>, avisos: &Avisos) -> LecturaJson<T> {
    if !o.solo_consulta {
        limpiar_tmp_huerfanos(p);
    }
    let defecto = |t: T| LecturaJson { valor: t, apartado: None, solo_lectura: false, motivo: None };
    let crudo = match fs::read(p) {
        Ok(b) => b,
        Err(e) => {
            if e.kind() == ErrorKind::NotFound || o.solo_consulta {
                return defecto((o.por_defecto)());
            }
            return en_solo_lectura(p, o, avisos, format!("no se pudo leer ({e})"));
        }
    };
    let texto = String::from_utf8_lossy(&crudo);
    let texto = texto.strip_prefix('\u{feff}').unwrap_or(&texto);
    let valor = serde_json::from_str::<Value>(texto).ok().and_then(|v| (o.validar)(&v));
    if let Some(v) = valor {
        return defecto(v);
    }
    if o.solo_consulta {
        return defecto((o.por_defecto)());
    }
    let apartado = ruta_libre(&format!("{}.corrupt-{}", p.display(), ahora_ms()));
    if let Err(e) = fs::rename(p, &apartado) {
        return en_solo_lectura(p, o, avisos, format!("está dañado y no se pudo apartar ({e})"));
    }
    podar_respaldos(p, ".corrupt-", RESPALDOS_POR_ARCHIVO);
    if !o.silencioso {
        avisos.archivo_apartado(p, &apartado);
    }
    LecturaJson { valor: (o.por_defecto)(), apartado: Some(apartado), solo_lectura: false, motivo: None }
}

/// tmp + fsync + rename: ni un corte de luz deja el JSON a medias o vacío. Devuelve `Ok(false)` sin tocar nada si el
/// archivo quedó en solo lectura al leerlo.
pub fn escribir_json_atomico(p: &Path, datos: &Value) -> std::io::Result<bool> {
    if bloqueado(p) {
        return Ok(false);
    }
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = PathBuf::from(format!("{}.{}.tmp", p.display(), std::process::id()));
    let resultado = (|| -> std::io::Result<()> {
        let mut f: File = OpenOptions::new().write(true).create(true).truncate(true).open(&tmp)?;
        f.write_all(serde_json::to_string_pretty(datos).map_err(std::io::Error::other)?.as_bytes())?;
        sincronizar(&f)?;
        drop(f);
        fs::rename(&tmp, p)
    })();
    if let Err(e) = resultado {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(true)
}

/// Algunos montajes (unidades virtuales, ciertos SMB) no soportan fsync: ahí se sigue sin él.
fn sincronizar(f: &File) -> std::io::Result<()> {
    match f.sync_all() {
        Err(e) if matches!(e.kind(), ErrorKind::Unsupported | ErrorKind::InvalidInput | ErrorKind::PermissionDenied) => Ok(()),
        otro => otro,
    }
}

fn listar(dir: &Path) -> Vec<String> {
    fs::read_dir(dir).map(|r| r.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default()
}

/// Los `<archivo>.<pid>.tmp` de otro proceso que quedaron de un guardado cortado.
fn limpiar_tmp_huerfanos(p: &Path) {
    let dir = p.parent().unwrap_or_else(|| Path::new("."));
    let prefijo = format!("{}.", nombre(p));
    let propio = std::process::id().to_string();
    for n in listar(dir) {
        let Some(medio) = n.strip_prefix(&prefijo).and_then(|r| r.strip_suffix(".tmp")) else { continue };
        if medio.is_empty() || !medio.bytes().all(|b| b.is_ascii_digit()) || medio == propio {
            continue;
        }
        let f = dir.join(&n);
        let viejo = fs::metadata(&f).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|d| d > TMP_HUERFANO).unwrap_or(false);
        if viejo {
            let _ = fs::remove_file(f);
        }
    }
}

/// Respaldos `<archivo><marcador><ts>[-n]`, del más nuevo al más viejo.
fn respaldos(p: &Path, marcador: &str) -> Vec<PathBuf> {
    let dir = p.parent().unwrap_or_else(|| Path::new("."));
    let prefijo = format!("{}{marcador}", nombre(p));
    let mut v: Vec<(u128, u128, PathBuf)> = listar(dir)
        .into_iter()
        .filter_map(|n| {
            let resto = n.strip_prefix(&prefijo)?;
            let (a, b) = match resto.split_once('-') {
                Some((a, b)) => (a, Some(b)),
                None => (resto, None),
            };
            let ts: u128 = a.parse().ok().filter(|_| !a.is_empty() && a.bytes().all(|c| c.is_ascii_digit()))?;
            let n2: u128 = match b {
                Some(b) if !b.is_empty() && b.bytes().all(|c| c.is_ascii_digit()) => b.parse().ok()?,
                Some(_) => return None,
                None => 0,
            };
            Some((ts, n2, dir.join(n)))
        })
        .collect();
    v.sort_by(|x, y| y.0.cmp(&x.0).then(y.1.cmp(&x.1)));
    v.into_iter().map(|x| x.2).collect()
}

/// Deja solo los `conservar` respaldos más nuevos de ese archivo.
pub fn podar_respaldos(p: &Path, marcador: &str, conservar: usize) {
    for f in respaldos(p, marcador).into_iter().skip(conservar) {
        let _ = fs::remove_file(f);
    }
}

/// Copia el archivo a `<archivo>.bak-<ts>` y poda los viejos. Si el respaldo más nuevo ya tiene el mismo contenido
/// lo reusa, así no se suma uno por arranque. Falla si no puede copiar.
pub fn respaldar(p: &Path) -> std::io::Result<PathBuf> {
    let actual = fs::read(p)?;
    if let Some(ultimo) = respaldos(p, ".bak-").into_iter().next() {
        if fs::read(&ultimo).map(|c| c == actual).unwrap_or(false) {
            return Ok(ultimo);
        }
    }
    let bak = ruta_libre(&format!("{}.bak-{}", p.display(), ahora_ms()));
    fs::copy(p, &bak)?;
    podar_respaldos(p, ".bak-", RESPALDOS_POR_ARCHIVO);
    Ok(bak)
}

pub fn es_objeto(v: &Value) -> bool {
    v.is_object()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn carpeta() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!("sloth-json-rs-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn nombres(d: &Path) -> Vec<String> {
        let mut n = listar(d);
        n.sort();
        n
    }

    fn validar(v: &Value) -> Option<String> {
        v.get("theme").and_then(Value::as_str).map(str::to_owned)
    }
    fn defecto() -> String {
        "oscuro".into()
    }
    fn opciones() -> OpcionesLectura<'static, String> {
        OpcionesLectura::nuevas(&validar, &defecto)
    }

    #[test]
    fn sin_archivo_valor_por_defecto_sin_apartar_ni_avisar() {
        let (d, av) = (carpeta(), Avisos::nuevo());
        let r = leer_json(&d.join("settings.json"), &opciones(), &av);
        assert_eq!(r, LecturaJson { valor: "oscuro".into(), apartado: None, solo_lectura: false, motivo: None });
        assert!(av.tomar().is_empty());
    }

    #[test]
    fn archivo_valido_con_bom_se_lee_y_no_se_toca() {
        let (d, av) = (carpeta(), Avisos::nuevo());
        let f = d.join("settings.json");
        fs::write(&f, "\u{feff}{\"theme\":\"claro\"}").unwrap();
        assert_eq!(leer_json(&f, &opciones(), &av).valor, "claro");
        assert_eq!(nombres(&d), vec!["settings.json"]);
    }

    #[test]
    fn json_con_coma_de_mas_se_aparta_con_su_contenido_y_avisa() {
        let (d, av) = (carpeta(), Avisos::nuevo());
        let f = d.join("settings.json");
        let roto = "{ \"theme\":\"claro\", \"shortcuts\":{}, }";
        fs::write(&f, roto).unwrap();
        let r = leer_json(&f, &opciones(), &av);
        assert_eq!(r.valor, "oscuro");
        let apartado = r.apartado.clone().expect("se aparta");
        assert!(nombre(&apartado).starts_with("settings.json.corrupt-"));
        assert_eq!(fs::read_to_string(&apartado).unwrap(), roto);
        assert_eq!(nombres(&d), vec![nombre(&apartado)]);
        let a = av.tomar();
        assert_eq!(a.len(), 1);
        assert!(a[0].contains("settings.json") && a[0].contains("valores por defecto"));
        escribir_json_atomico(&f, &json!({ "theme": "oscuro" })).unwrap();
        assert_eq!(fs::read_to_string(&apartado).unwrap(), roto, "el guardado siguiente no pisa el respaldo");
    }

    #[test]
    fn json_valido_que_no_valida_tambien_se_aparta() {
        let (d, av) = (carpeta(), Avisos::nuevo());
        let f = d.join("settings.json");
        fs::write(&f, "[1,2]").unwrap();
        let o = OpcionesLectura { silencioso: true, ..opciones() };
        let r = leer_json(&f, &o, &av);
        assert!(r.apartado.is_some());
        assert_eq!(r.valor, "oscuro");
        assert!(av.tomar().is_empty());
    }

    #[test]
    fn error_de_lectura_que_no_es_not_found_deja_solo_lectura_y_no_pisa() {
        let (d, av) = (carpeta(), Avisos::nuevo());
        let f = d.join("settings.json");
        fs::create_dir(&f).unwrap();
        let r = leer_json(&f, &opciones(), &av);
        assert_eq!(r.valor, "oscuro");
        assert!(r.solo_lectura);
        assert!(r.motivo.unwrap().contains("no se pudo leer"));
        assert!(bloqueado(&f));
        assert!(!escribir_json_atomico(&f, &json!({ "theme": "claro" })).unwrap());
        assert!(f.is_dir(), "no se tocó");
        assert_eq!(nombres(&d), vec!["settings.json"]);
        let a = av.tomar();
        assert_eq!(a.len(), 1);
        assert!(a[0].contains("settings.json no se pudo leer") && a[0].contains("no voy a guardar cambios"));
    }

    #[test]
    fn solo_consulta_con_el_archivo_roto_no_aparta_ni_avisa_ni_bloquea() {
        let (d, av) = (carpeta(), Avisos::nuevo());
        let f = d.join("settings.json");
        fs::write(&f, "{ roto").unwrap();
        let o = OpcionesLectura { solo_consulta: true, ..opciones() };
        let r = leer_json(&f, &o, &av);
        assert_eq!(r.valor, "oscuro");
        assert_eq!(nombres(&d), vec!["settings.json"]);
        assert!(av.tomar().is_empty());
        assert!(!bloqueado(&f));
    }

    #[test]
    fn se_conservan_solo_los_cinco_corrupt_mas_nuevos_de_cada_archivo() {
        let (d, av) = (carpeta(), Avisos::nuevo());
        let f = d.join("git.json");
        for ts in 1..=6 {
            fs::write(format!("{}.corrupt-{ts}", f.display()), ts.to_string()).unwrap();
        }
        fs::write(format!("{}.corrupt-6-1", f.display()), "6-1").unwrap();
        fs::write(d.join("otro.json.corrupt-1"), "x").unwrap();
        fs::write(&f, "roto").unwrap();
        let o = OpcionesLectura { silencioso: true, ..opciones() };
        let r = leer_json(&f, &o, &av);
        let quedan: Vec<String> = nombres(&d).into_iter().filter(|n| n.starts_with("git.json.corrupt-")).collect();
        assert_eq!(quedan.len(), RESPALDOS_POR_ARCHIVO);
        assert!(quedan.contains(&nombre(&r.apartado.unwrap())));
        assert!(quedan.contains(&"git.json.corrupt-6-1".to_string()));
        for viejo in ["git.json.corrupt-1", "git.json.corrupt-2", "git.json.corrupt-3"] {
            assert!(!quedan.contains(&viejo.to_string()), "{viejo}");
        }
        assert!(d.join("otro.json.corrupt-1").exists(), "los de otro archivo no se tocan");
    }

    #[test]
    fn respaldar_reusa_el_ultimo_bak_si_no_cambio_y_poda_los_viejos() {
        let d = carpeta();
        let f = d.join("sloth-state.json");
        fs::write(&f, "{\"version\":2}").unwrap();
        let a = respaldar(&f).unwrap();
        assert_eq!(respaldar(&f).unwrap(), a, "mismo contenido: no se suma otro .bak");
        fs::write(&f, "{\"version\":3}").unwrap();
        let b = respaldar(&f).unwrap();
        assert_ne!(b, a);
        assert_eq!(fs::read_to_string(&b).unwrap(), "{\"version\":3}");
        for ts in 1..=5 {
            fs::write(format!("{}.bak-{ts}", f.display()), ts.to_string()).unwrap();
        }
        fs::write(&f, "{\"version\":4}").unwrap();
        respaldar(&f).unwrap();
        assert_eq!(nombres(&d).iter().filter(|n| n.starts_with("sloth-state.json.bak-")).count(), RESPALDOS_POR_ARCHIVO);
    }

    #[test]
    fn respaldar_falla_si_no_hay_archivo_que_copiar() {
        assert!(respaldar(&carpeta().join("no.json")).is_err());
    }

    #[test]
    fn al_leer_se_borran_los_tmp_viejos_de_otro_proceso() {
        let (d, av) = (carpeta(), Avisos::nuevo());
        let f = d.join("a.json");
        let viejo = PathBuf::from(format!("{}.999999.tmp", f.display()));
        let reciente = PathBuf::from(format!("{}.999998.tmp", f.display()));
        let propio = PathBuf::from(format!("{}.{}.tmp", f.display(), std::process::id()));
        for t in [&viejo, &reciente, &propio] {
            fs::write(t, "{").unwrap();
        }
        let hace = SystemTime::now() - Duration::from_secs(600);
        for t in [&viejo, &propio] {
            File::options().write(true).open(t).unwrap().set_modified(hace).unwrap();
        }
        leer_json(&f, &opciones(), &av);
        assert!(!viejo.exists());
        assert!(reciente.exists());
        assert!(propio.exists());
    }

    #[test]
    fn si_el_rename_falla_escribir_falla_y_no_deja_el_tmp() {
        let d = carpeta();
        let f = d.join("a.json");
        fs::create_dir_all(f.join("adentro")).unwrap();
        assert!(escribir_json_atomico(&f, &json!({ "a": 1 })).is_err());
        assert_eq!(nombres(&d), vec!["a.json"]);
    }

    #[test]
    fn escribir_crea_la_carpeta_reemplaza_y_no_deja_el_tmp() {
        let d = carpeta();
        let f = d.join("features").join("a.json");
        escribir_json_atomico(&f, &json!({ "a": 1 })).unwrap();
        escribir_json_atomico(&f, &json!({ "a": 2 })).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&fs::read_to_string(&f).unwrap()).unwrap(), json!({ "a": 2 }));
        assert_eq!(nombres(&d.join("features")), vec!["a.json"]);
    }

    #[test]
    fn el_formato_es_el_de_json_stringify_con_dos_espacios() {
        let d = carpeta();
        let f = d.join("a.json");
        escribir_json_atomico(&f, &json!({ "version": 1, "lista": [1, 2], "vacio": {}, "texto": "ñ/ó" })).unwrap();
        assert_eq!(
            fs::read_to_string(&f).unwrap(),
            "{\n  \"version\": 1,\n  \"lista\": [\n    1,\n    2\n  ],\n  \"vacio\": {},\n  \"texto\": \"ñ/ó\"\n}"
        );
    }
}
