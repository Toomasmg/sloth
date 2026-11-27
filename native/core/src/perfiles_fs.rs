//! Perfiles en disco: migración desde la raíz de userData, índice, carpetas de cada perfil y su ciclo de vida.
//! Equivale a src/main/perfiles-fs.ts. La raíz nunca se modifica: se copia, así una versión anterior de Sloth sigue
//! abriendo sus datos. Una vez que hay perfiles la raíz queda congelada, así que desde ahí un fallo nunca vuelve a ella
//! ni migra de nuevo: se rearma el índice con los perfil.json válidos o se devuelve `bloqueado` sin tocar nada.
use crate::avisos::Avisos;
use crate::candado::{tomar_candado, Candado, ResultadoCandado};
use crate::perfiles_core::*;
use crate::persistencia::{escribir_json_atomico, leer_json, respaldar, ruta_libre, OpcionesLectura};
use base64::Engine;
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

pub const MAX_NOMBRE_PERFIL: usize = 40;
pub const MAX_BYTES_FOTO: usize = 512 * 1024;
const META: &str = "perfil.json";
const FOTO: &str = "foto.png";
const TMP_PRINCIPAL: &str = ".principal.tmp";
const OCUPADO: &str = "Otra copia de Sloth está preparando tus perfiles en este momento. Cerrala y volvé a abrir Sloth.";

pub struct RutasPerfiles {
    pub raiz: PathBuf,
    pub carpeta: PathBuf,
    pub indice: PathBuf,
    pub respaldos: PathBuf,
    pub candado: PathBuf,
}

pub fn rutas_perfiles(raiz: &Path) -> RutasPerfiles {
    RutasPerfiles {
        raiz: raiz.to_path_buf(),
        carpeta: raiz.join("perfiles"),
        indice: raiz.join("perfiles.json"),
        respaldos: raiz.join("respaldos"),
        candado: raiz.join("perfiles.lock"),
    }
}

#[derive(Debug)]
pub struct ResultadoArranque {
    pub indice: IndicePerfiles,
    pub migrado: bool,
    pub reconstruido: bool,
    /// Todavía no había perfiles y no se pudieron preparar: se sigue con la raíz de siempre.
    pub error: Option<String>,
    /// Ya hay perfiles pero no se puede usar ninguno (o los tiene tomados otra copia): no se toca nada ni se cae a la raíz.
    pub bloqueado: Option<String>,
    /// Algo menor que no frena el arranque y que conviene decirle a la persona.
    pub aviso_usuario: Option<String>,
    /// Algo menor que no frena el arranque (restos de un intento cortado que no se pudieron borrar).
    pub aviso: Option<String>,
}

fn unir(partes: &[Option<String>]) -> Option<String> {
    let r: Vec<&str> = partes.iter().flatten().map(String::as_str).collect();
    (!r.is_empty()).then(|| r.join("; "))
}

fn listar(dir: &Path) -> std::io::Result<Vec<String>> {
    match fs::read_dir(dir) {
        Ok(r) => Ok(r.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e),
    }
}

enum Lectura<T> {
    Ok(T),
    Futura,
    Invalida,
    Ausente,
    Ilegible(String),
}

/// Solo mira: no aparta, no reescribe ni bloquea nada.
fn leer_archivo<T>(ruta: &Path, validar: impl Fn(&Value) -> Option<T>) -> Lectura<T> {
    let texto = match fs::read(ruta) {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
        Err(e) if e.kind() == ErrorKind::NotFound => return Lectura::Ausente,
        Err(e) => return Lectura::Ilegible(e.to_string()),
    };
    match clasificar_json(&texto, validar) {
        LecturaClasificada::Ok(v) => Lectura::Ok(v),
        LecturaClasificada::Futura => Lectura::Futura,
        LecturaClasificada::Invalida => Lectura::Invalida,
    }
}

fn leer_estado_meta(carpeta_perfil: &Path) -> Lectura<Perfil> {
    leer_archivo(&carpeta_perfil.join(META), validar_meta)
}

pub fn leer_meta(carpeta_perfil: &Path) -> Option<Perfil> {
    match leer_estado_meta(carpeta_perfil) {
        Lectura::Ok(p) => Some(p),
        _ => None,
    }
}

pub fn escribir_meta(carpeta_perfil: &Path, p: &Perfil) -> Result<(), String> {
    match escribir_json_atomico(&carpeta_perfil.join(META), &p.a_json()) {
        Ok(true) => Ok(()),
        Ok(false) => Err("perfil.json quedó en solo lectura".into()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn guardar_indice(raiz: &Path, indice: &IndicePerfiles) -> Result<(), String> {
    match escribir_json_atomico(&rutas_perfiles(raiz).indice, &indice.a_json()) {
        Ok(true) => Ok(()),
        Ok(false) => Err("perfiles.json quedó en solo lectura".into()),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Default)]
struct Escaneo {
    metas: Vec<Perfil>,
    /// Carpetas con pinta de perfil que no se pueden leer ahora o son de una versión futura: no se las deja fuera de un índice guardado.
    inutilizables: Vec<(String, String)>,
    /// Tienen un perfil.json que no sirve (roto, otro id, nombre inválido).
    descartadas: Vec<String>,
}

/// Solo cuenta la carpeta cuyo perfil.json dice ser ella: una carpeta copiada a mano con otro nombre no se confunde.
fn escanear(carpeta: &Path) -> std::io::Result<Escaneo> {
    let mut e = Escaneo::default();
    let nombres = match fs::read_dir(carpeta) {
        Ok(r) => r.filter_map(|x| x.ok()).map(|x| x.file_name().to_string_lossy().into_owned()).collect::<Vec<_>>(),
        Err(err) if err.kind() == ErrorKind::NotFound || err.kind() == ErrorKind::NotADirectory => return Ok(e),
        Err(err) => return Err(err),
    };
    for n in nombres {
        if !id_perfil_valido(&n) {
            continue;
        }
        let dir = carpeta.join(&n);
        match fs::symlink_metadata(&dir) {
            Ok(m) if m.is_dir() => {}
            Ok(_) => continue,
            Err(err) => {
                e.inutilizables.push((n, err.to_string()));
                continue;
            }
        }
        match leer_estado_meta(&dir) {
            Lectura::Ok(p) => {
                if p.id == n {
                    e.metas.push(p);
                } else {
                    e.descartadas.push(n);
                }
            }
            Lectura::Futura => e.inutilizables.push((n, "su perfil.json es de una versión más nueva de Sloth".into())),
            Lectura::Ilegible(m) => e.inutilizables.push((n, format!("no pude leer su perfil.json ({m})"))),
            Lectura::Invalida => e.descartadas.push(n),
            Lectura::Ausente => {}
        }
    }
    Ok(e)
}

fn es_respaldo_previo(n: &str) -> bool {
    n.strip_prefix("pre-perfiles-").is_some_and(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_digit()))
}

fn es_respaldo_tmp(n: &str) -> bool {
    n.strip_prefix(".pre-perfiles-").and_then(|r| r.strip_suffix(".tmp")).is_some_and(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_digit()))
}

/// Los .tmp que dejó una migración o un respaldo cortados. Va con el candado tomado: otra copia de Sloth podría tener uno en curso.
fn barrer_tmp(r: &RutasPerfiles) -> Option<String> {
    let mut fallas: Vec<String> = Vec::new();
    let mut barrer = |dir: &Path, es: &dyn Fn(&str) -> bool| match listar(dir) {
        Ok(nombres) => {
            for n in nombres.into_iter().filter(|n| es(n)) {
                let p = dir.join(&n);
                let r = if p.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
                if let Err(e) = r {
                    fallas.push(format!("{n}: {e}"));
                }
            }
        }
        Err(e) => fallas.push(e.to_string()),
    };
    barrer(&r.carpeta, &|n| n.starts_with('.') && n.contains(".tmp"));
    barrer(&r.respaldos, &es_respaldo_tmp);
    (!fallas.is_empty()).then(|| format!("no pude limpiar restos de una migración cortada ({})", fallas.join("; ")))
}

fn es_enlace(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

/// Cada archivo del original existe en la copia con el mismo tamaño. Los enlaces no se copian, así que tampoco se miran.
fn verificar_copia(origen: &Path, destino: &Path) -> Result<(), String> {
    let o = fs::symlink_metadata(origen).map_err(|e| e.to_string())?;
    if o.file_type().is_symlink() {
        return Ok(());
    }
    let d = fs::symlink_metadata(destino).map_err(|e| e.to_string())?;
    if o.is_dir() {
        if !d.is_dir() {
            return Err(format!("la copia de {} no es una carpeta", origen.display()));
        }
        for n in listar(origen).map_err(|e| e.to_string())? {
            verificar_copia(&origen.join(&n), &destino.join(&n))?;
        }
        return Ok(());
    }
    if o.len() != d.len() {
        return Err(format!("la copia de {} no coincide con el original", origen.display()));
    }
    Ok(())
}

/// Copia recursiva que no sigue enlaces (se anotan en `omitidos`), no pisa nada y conserva la fecha de modificación.
fn copiar_rec(origen: &Path, destino: &Path, omitidos: &mut BTreeSet<PathBuf>) -> std::io::Result<()> {
    let m = fs::symlink_metadata(origen)?;
    if m.file_type().is_symlink() {
        omitidos.insert(origen.to_path_buf());
        return Ok(());
    }
    if m.is_dir() {
        fs::create_dir_all(destino)?;
        for n in listar(origen)? {
            copiar_rec(&origen.join(&n), &destino.join(&n), omitidos)?;
        }
        return Ok(());
    }
    let mut src = File::open(origen)?;
    let mut dst = OpenOptions::new().write(true).create_new(true).open(destino)?;
    std::io::copy(&mut src, &mut dst)?;
    if let Ok(t) = m.modified() {
        let _ = dst.set_modified(t);
    }
    Ok(())
}

fn copiar_entradas(raiz: &Path, entradas: &[String], destino: &Path, omitidos: &mut BTreeSet<PathBuf>) -> Result<(), String> {
    for e in entradas {
        let origen = raiz.join(e);
        if es_enlace(&origen) {
            omitidos.insert(origen);
            continue;
        }
        copiar_rec(&origen, &destino.join(e), omitidos).map_err(|x| x.to_string())?;
        verificar_copia(&origen, &destino.join(e))?;
    }
    Ok(())
}

fn aviso_enlaces(omitidos: &BTreeSet<PathBuf>) -> Option<String> {
    if omitidos.is_empty() {
        return None;
    }
    let lista = omitidos.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ");
    let cuantos = if omitidos.len() == 1 { "un enlace".to_string() } else { format!("{} enlaces", omitidos.len()) };
    Some(format!("no copié {cuantos} ({lista}): seguirlos podía dejar al perfil apuntando a tu carpeta de datos de siempre. Quedan donde estaban"))
}

/// Uno solo, del primer intento: los reintentos no lo pisan ni suman otros.
fn respaldar_raiz(r: &RutasPerfiles, entradas: &[String], ahora: u64, omitidos: &mut BTreeSet<PathBuf>) -> Result<(), String> {
    if entradas.is_empty() || listar(&r.respaldos).map_err(|e| e.to_string())?.iter().any(|n| es_respaldo_previo(n)) {
        return Ok(());
    }
    let tmp = r.respaldos.join(format!(".pre-perfiles-{ahora}.tmp"));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let r2 = copiar_entradas(&r.raiz, entradas, &tmp, omitidos).and_then(|_| fs::rename(&tmp, r.respaldos.join(format!("pre-perfiles-{ahora}"))).map_err(|e| e.to_string()));
    if r2.is_err() {
        let _ = fs::remove_dir_all(&tmp);
    }
    r2
}

fn migrar(r: &RutasPerfiles, ahora: u64, omitidos: &mut BTreeSet<PathBuf>) -> Result<Perfil, String> {
    let nombres = listar(&r.raiz).map_err(|e| e.to_string())?;
    let entradas = a_copiar(&nombres.iter().map(String::as_str).collect::<Vec<_>>());
    respaldar_raiz(r, &entradas, ahora, omitidos)?;
    let meta = Perfil { id: PERFIL_INICIAL_ID.into(), nombre: NOMBRE_INICIAL.into(), creado: ahora as f64, gh_login: None };
    fs::create_dir_all(&r.carpeta).map_err(|e| e.to_string())?;
    let tmp = r.carpeta.join(TMP_PRINCIPAL);
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir(&tmp).map_err(|e| e.to_string())?;
    let r2 = (|| -> Result<(), String> {
        copiar_entradas(&r.raiz, &entradas, &tmp, omitidos)?;
        escribir_meta(&tmp, &meta)?;
        leer_meta(&tmp).ok_or("no se pudo verificar perfil.json")?;
        fs::rename(&tmp, r.carpeta.join(PERFIL_INICIAL_ID)).map_err(|e| e.to_string())
    })();
    if let Err(e) = r2 {
        let _ = fs::remove_dir_all(&tmp);
        return Err(e);
    }
    Ok(meta)
}

/// Un perfiles.json sano pero que apunta a carpetas que ya no están se guarda aparte antes de rearmarlo.
fn reemplazar_indice(raiz: &Path, indice: &IndicePerfiles) -> Result<(), String> {
    let ruta = rutas_perfiles(raiz).indice;
    if ruta.exists() {
        respaldar(&ruta).map_err(|e| e.to_string())?;
    }
    guardar_indice(raiz, indice)
}

/// Un perfiles.json roto se aparta como .corrupt para que lo nuevo no lo pise. Si no se puede apartar queda en solo lectura.
fn apartar_indice(raiz: &Path) {
    let validar = |v: &Value| validar_indice(v).map(Some);
    let defecto = || None::<IndicePerfiles>;
    let mut o = OpcionesLectura::nuevas(&validar, &defecto);
    o.silencioso = true;
    leer_json(&rutas_perfiles(raiz).indice, &o, &Avisos::nuevo());
}

fn indice_vacio(ahora: u64) -> IndicePerfiles {
    IndicePerfiles { activo: PERFIL_INICIAL_ID.into(), perfiles: vec![Perfil { id: PERFIL_INICIAL_ID.into(), nombre: NOMBRE_INICIAL.into(), creado: ahora as f64, gh_login: None }] }
}

fn resultado(indice: IndicePerfiles) -> ResultadoArranque {
    ResultadoArranque { indice, migrado: false, reconstruido: false, error: None, bloqueado: None, aviso_usuario: None, aviso: None }
}

fn emergencia(ahora: u64, error: String) -> ResultadoArranque {
    ResultadoArranque { error: Some(error), ..resultado(indice_vacio(ahora)) }
}

fn bloquear(ahora: u64, motivo: String) -> ResultadoArranque {
    ResultadoArranque { bloqueado: Some(motivo), ..resultado(indice_vacio(ahora)) }
}

fn motivo_bloqueo<T>(indice: &Lectura<T>, e: &Escaneo) -> String {
    let mut partes: Vec<String> = Vec::new();
    match indice {
        Lectura::Futura => partes.push("perfiles.json es de una versión más nueva de Sloth: actualizá Sloth".into()),
        Lectura::Ilegible(m) => partes.push(format!("no pude leer perfiles.json ({m})")),
        Lectura::Ok(_) => partes.push("perfiles.json lista perfiles pero no encuentro sus carpetas".into()),
        _ => {}
    }
    for (id, motivo) in &e.inutilizables {
        partes.push(format!("perfiles/{id}: {motivo}"));
    }
    if !e.descartadas.is_empty() {
        partes.push(format!("perfil.json que no sirve en: {}", e.descartadas.iter().map(|n| format!("perfiles/{n}")).collect::<Vec<_>>().join(", ")));
    }
    partes.join("; ")
}

/// Con el candado tomado: otra copia de Sloth no puede migrar ni barrer tmp a la vez.
fn arrancar_lento(raiz: &Path, r: &RutasPerfiles, ahora: &dyn Fn() -> u64) -> ResultadoArranque {
    let lectura = leer_archivo(&r.indice, validar_indice);
    let previo: Option<&IndicePerfiles> = if let Lectura::Ok(i) = &lectura { Some(i) } else { None };
    let e = match escanear(&r.carpeta) {
        Ok(e) => e,
        Err(err) => return bloquear(ahora(), format!("no pude leer la carpeta de perfiles ({err})")),
    };

    if !e.metas.is_empty() {
        if previo.is_some_and(|p| e.inutilizables.iter().any(|(id, _)| *id == p.activo)) {
            return bloquear(ahora(), motivo_bloqueo(&lectura, &e));
        }
        let (indice, reconstruido) = match previo {
            Some(p) if e.metas.iter().any(|m| m.id == p.activo) => (p.clone(), false),
            _ => match reconstruir_indice(&e.metas, previo.map(|p| p.activo.as_str())) {
                Some(i) => (i, true),
                None => return bloquear(ahora(), "no pude rearmar perfiles.json".into()),
            },
        };
        // Con un perfiles.json que no se puede leer o con perfiles que hoy no se pueden leer, guardar el rearmado los dejaría afuera.
        let mut aviso_usuario: Option<String> = None;
        if reconstruido && (matches!(lectura, Lectura::Futura | Lectura::Ilegible(_)) || !e.inutilizables.is_empty()) {
            aviso_usuario = Some(format!("No guardé perfiles.json: {}. Sigo con los perfiles que pude leer.", motivo_bloqueo(&lectura, &e)));
        } else if reconstruido {
            if matches!(lectura, Lectura::Invalida) {
                apartar_indice(raiz);
            }
            if let Err(err) = reemplazar_indice(raiz, &indice) {
                aviso_usuario = Some(format!("No pude guardar perfiles.json ({err}). Sigo con el que armé en memoria."));
            }
        }
        let descartadas = (!e.descartadas.is_empty()).then(|| format!("perfil.json que no sirve en {}", e.descartadas.join(", ")));
        return ResultadoArranque { reconstruido, aviso_usuario, aviso: unir(&[barrer_tmp(r), descartadas]), ..resultado(indice) };
    }

    // Sin ningún perfil usable: si ya había (índice o carpetas con perfil.json), la raíz está congelada y migrar de nuevo pisaría lo nuevo.
    let habia = matches!(lectura, Lectura::Ok(_) | Lectura::Futura | Lectura::Ilegible(_)) || !e.inutilizables.is_empty() || !e.descartadas.is_empty();
    if habia {
        return bloquear(ahora(), motivo_bloqueo(&lectura, &e));
    }

    let mut omitidos = BTreeSet::new();
    let meta = match migrar(r, ahora(), &mut omitidos) {
        Ok(m) => m,
        Err(err) => return emergencia(ahora(), err),
    };
    let indice = IndicePerfiles { activo: meta.id.clone(), perfiles: vec![meta] };
    let mut fallo_indice: Option<String> = None;
    if matches!(lectura, Lectura::Invalida) {
        apartar_indice(raiz);
    }
    if let Err(err) = reemplazar_indice(raiz, &indice) {
        // `principal` ya está completo: seguir en la raíz dejaría lo que se haga ahora fuera del perfil que el próximo arranque va a usar.
        fallo_indice = Some(format!("No pude guardar perfiles.json ({err}). Sigo con el perfil principal y lo reintento al abrir de nuevo."));
    }
    let enlaces = aviso_enlaces(&omitidos).map(|e| format!("Perfiles: {e}."));
    ResultadoArranque { migrado: true, aviso_usuario: unir(&[fallo_indice, enlaces]), aviso: barrer_tmp(r), ..resultado(indice) }
}

fn barrer_con_candado(r: &RutasPerfiles) -> Option<String> {
    let c = match tomar_candado(&r.candado, None) {
        Ok(ResultadoCandado::Tomado(c)) => c,
        Ok(ResultadoCandado::Ocupado { .. }) => return None,
        Err(e) => return Some(format!("no pude tomar el candado para limpiar restos de una migración cortada ({e})")),
    };
    let restos = barrer_tmp(r);
    match c.liberar() {
        Ok(()) => restos,
        Err(e) => unir(&[restos, Some(format!("no pude borrar perfiles.lock ({e})"))]),
    }
}

/// Idempotente. Devuelve el índice vigente. Solo si todavía no había perfiles y la migración falla se sigue con la
/// raíz (`error`).
pub fn iniciar_perfiles_fs(raiz: &Path, ahora: &dyn Fn() -> u64) -> ResultadoArranque {
    let r = rutas_perfiles(raiz);
    if let Lectura::Ok(indice) = leer_archivo(&r.indice, validar_indice) {
        if let Lectura::Ok(activo) = leer_estado_meta(&r.carpeta.join(&indice.activo)) {
            if activo.id == indice.activo {
                return ResultadoArranque { aviso: barrer_con_candado(&r), ..resultado(indice) };
            }
        }
    }
    let mut candado: Option<Candado> = None;
    let mut sin_candado: Option<String> = None;
    match tomar_candado(&r.candado, None) {
        Ok(ResultadoCandado::Tomado(c)) => candado = Some(c),
        Ok(ResultadoCandado::Ocupado { .. }) => return bloquear(ahora(), OCUPADO.into()),
        Err(e) => sin_candado = Some(format!("no pude tomar el candado de los perfiles ({e})")),
    }
    let mut res = arrancar_lento(raiz, &r, ahora);
    let sin_liberar = candado.and_then(|c| c.liberar().err()).map(|e| format!("no pude borrar perfiles.lock ({e})"));
    if let Some(extra) = unir(&[sin_candado, sin_liberar]) {
        res.aviso = unir(&[res.aviso.take(), Some(extra)]);
    }
    res
}

pub fn tipo_imagen(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if b.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

pub fn leer_indice_vigente(raiz: &Path) -> Option<IndicePerfiles> {
    match leer_archivo(&rutas_perfiles(raiz).indice, validar_indice) {
        Lectura::Ok(i) => Some(i),
        _ => None,
    }
}

fn indice_vigente(raiz: &Path) -> Result<IndicePerfiles, String> {
    match leer_archivo(&rutas_perfiles(raiz).indice, validar_indice) {
        Lectura::Ok(i) => Ok(i),
        Lectura::Futura => Err("perfiles.json es de una versión más nueva de Sloth. Actualizá Sloth para administrar los perfiles.".into()),
        _ => Err("No pude leer perfiles.json. Reiniciá Sloth para que lo rearme.".into()),
    }
}

/// El id viene de la interfaz: solo vale uno que ya está en el índice y cuya carpeta queda dentro de perfiles/.
fn carpeta_de(raiz: &Path, id: &str, indice: &IndicePerfiles) -> Result<(Perfil, PathBuf), String> {
    if !id_perfil_valido(id) {
        return Err("Perfil inválido.".into());
    }
    let base = rutas_perfiles(raiz).carpeta;
    let dir = base.join(id);
    match indice.perfiles.iter().find(|p| p.id == id) {
        Some(p) if dentro_de(&base, &dir) => Ok((p.clone(), dir)),
        _ => Err("Ese perfil no existe.".into()),
    }
}

fn nombre_o_error(nombre: &str) -> Result<String, String> {
    nombre_perfil_valido(nombre).ok_or_else(|| format!("El nombre del perfil tiene que tener entre 1 y {MAX_NOMBRE_PERFIL} caracteres y no puede llevar caracteres de control."))
}

fn reemplazar_perfil(raiz: &Path, indice: &IndicePerfiles, dir: &Path, nuevo: Perfil) -> Result<(), String> {
    escribir_meta(dir, &nuevo)?;
    let perfiles = indice.perfiles.iter().map(|p| if p.id == nuevo.id { nuevo.clone() } else { p.clone() }).collect();
    guardar_indice(raiz, &IndicePerfiles { activo: indice.activo.clone(), perfiles })
}

pub fn crear_perfil_fs(raiz: &Path, nombre: &str, ahora: u64, azar: impl FnMut() -> String) -> Result<Perfil, String> {
    let n = nombre_o_error(nombre)?;
    let indice = indice_vigente(raiz)?;
    if indice.perfiles.len() >= MAX_PERFILES {
        return Err(format!("No se pueden tener más de {MAX_PERFILES} perfiles."));
    }
    if !nombre_libre(&n, &indice.perfiles, None) {
        return Err("Ya hay un perfil con ese nombre.".into());
    }
    let r = rutas_perfiles(raiz);
    fs::create_dir_all(&r.carpeta).map_err(|e| e.to_string())?;
    let mut existentes: Vec<String> = indice.perfiles.iter().map(|p| p.id.clone()).collect();
    existentes.extend(listar(&r.carpeta).map_err(|e| e.to_string())?);
    let id = nuevo_id_perfil(&existentes, azar);
    let perfil = Perfil { id: id.clone(), nombre: n, creado: ahora as f64, gh_login: None };
    let tmp = r.carpeta.join(format!(".tmp-{id}"));
    let destino = r.carpeta.join(&id);
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(tmp.join("features")).map_err(|e| e.to_string())?;
    let creado = (|| -> Result<(), String> {
        escribir_meta(&tmp, &perfil)?;
        leer_meta(&tmp).ok_or("no se pudo verificar perfil.json")?;
        fs::rename(&tmp, &destino).map_err(|e| e.to_string())
    })();
    if let Err(e) = creado {
        let _ = fs::remove_dir_all(&tmp);
        return Err(e);
    }
    let mut perfiles = indice.perfiles.clone();
    perfiles.push(perfil.clone());
    if let Err(e) = guardar_indice(raiz, &IndicePerfiles { activo: indice.activo.clone(), perfiles }) {
        // La carpeta es nueva y está vacía: no hay nada del usuario que perder.
        let _ = fs::remove_dir_all(&destino);
        return Err(e);
    }
    Ok(perfil)
}

pub fn renombrar_perfil_fs(raiz: &Path, id: &str, nombre: &str) -> Result<Perfil, String> {
    let n = nombre_o_error(nombre)?;
    let indice = indice_vigente(raiz)?;
    let (perfil, dir) = carpeta_de(raiz, id, &indice)?;
    if !nombre_libre(&n, &indice.perfiles, Some(&perfil.id)) {
        return Err("Ya hay un perfil con ese nombre.".into());
    }
    let nuevo = Perfil { nombre: n, ..perfil };
    reemplazar_perfil(raiz, &indice, &dir, nuevo.clone())?;
    Ok(nuevo)
}

pub fn guardar_gh_login(raiz: &Path, id: &str, login: &str) -> Result<Perfil, String> {
    if !login_gh_valido(login) {
        return Err("Usuario de GitHub inválido.".into());
    }
    let indice = indice_vigente(raiz)?;
    let (perfil, dir) = carpeta_de(raiz, id, &indice)?;
    let nuevo = Perfil { gh_login: Some(login.to_string()), ..perfil };
    reemplazar_perfil(raiz, &indice, &dir, nuevo.clone())?;
    Ok(nuevo)
}

/// Valida el destino y devuelve lo que escribe el cambio. Se separa para poder validar antes de cerrar terminales: si el
/// perfil no está o está dañado no se debe haber matado nada.
pub fn preparar_cambio_fs(raiz: &Path, id: &str) -> Result<impl FnOnce() -> Result<(), String>, String> {
    let indice = indice_vigente(raiz)?;
    let (perfil, dir) = carpeta_de(raiz, id, &indice)?;
    leer_meta(&dir).ok_or("La carpeta de ese perfil no está o está dañada.")?;
    let raiz = raiz.to_path_buf();
    Ok(move || {
        let vigente = indice_vigente(&raiz)?;
        guardar_indice(&raiz, &IndicePerfiles { activo: perfil.id, perfiles: vigente.perfiles })
    })
}

pub fn cambiar_activo_fs(raiz: &Path, id: &str) -> Result<(), String> {
    preparar_cambio_fs(raiz, id)?()
}

/// rename; si cruza de disco copia, verifica que cada archivo llegó con su tamaño y recién ahí borra el origen.
fn mover(origen: &Path, destino: &Path) -> Result<(), String> {
    match fs::rename(origen, destino) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::CrossesDevices => {
            let copiado = copiar_rec(origen, destino, &mut BTreeSet::new()).map_err(|e| e.to_string()).and_then(|_| verificar_copia(origen, destino));
            if let Err(err) = copiado {
                let _ = fs::remove_dir_all(destino);
                return Err(err);
            }
            fs::remove_dir_all(origen).map_err(|e| e.to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Un perfil borrado se mueve a respaldos/: nunca se elimina. Devuelve la carpeta donde quedó.
pub fn borrar_perfil_fs(raiz: &Path, id: &str, ahora: u64) -> Result<PathBuf, String> {
    let indice = indice_vigente(raiz)?;
    let (perfil, dir) = carpeta_de(raiz, id, &indice)?;
    if perfil.id == indice.activo {
        return Err("No se puede borrar el perfil activo. Cambiá a otro primero.".into());
    }
    if indice.perfiles.len() <= 1 {
        return Err("No se puede borrar el último perfil.".into());
    }
    let r = rutas_perfiles(raiz);
    fs::create_dir_all(&r.respaldos).map_err(|e| e.to_string())?;
    let destino = ruta_libre(&r.respaldos.join(format!("perfil-{}-{ahora}", perfil.id)).display().to_string());
    if dir.exists() {
        mover(&dir, &destino)?;
    }
    let perfiles = indice.perfiles.iter().filter(|p| p.id != perfil.id).cloned().collect();
    if let Err(e) = guardar_indice(raiz, &IndicePerfiles { activo: indice.activo.clone(), perfiles }) {
        if destino.exists() {
            mover(&destino, &dir)?;
        }
        return Err(e);
    }
    Ok(destino)
}

pub fn guardar_foto(raiz: &Path, id: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES_FOTO {
        return Err("La foto tiene que pesar menos de 512 KB.".into());
    }
    if tipo_imagen(bytes).is_none() {
        return Err("La foto tiene que ser PNG, JPEG o WebP.".into());
    }
    let (_, dir) = carpeta_de(raiz, id, &indice_vigente(raiz)?)?;
    let tmp = dir.join(format!("{FOTO}.{}.tmp", std::process::id()));
    let r = fs::write(&tmp, bytes).and_then(|_| fs::rename(&tmp, dir.join(FOTO)));
    if let Err(e) = r {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

pub fn tiene_foto(raiz: &Path, id: &str) -> bool {
    id_perfil_valido(id) && rutas_perfiles(raiz).carpeta.join(id).join(FOTO).exists()
}

pub fn leer_foto_data_url(raiz: &Path, id: &str) -> Result<Option<String>, String> {
    let (_, dir) = carpeta_de(raiz, id, &indice_vigente(raiz)?)?;
    let f = dir.join(FOTO);
    match fs::metadata(&f) {
        Ok(m) if m.len() as usize > MAX_BYTES_FOTO => return Ok(None),
        Ok(_) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    }
    let bytes = fs::read(&f).map_err(|e| e.to_string())?;
    Ok(tipo_imagen(&bytes).map(|t| format!("data:{t};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes))))
}

#[cfg(test)]
mod tests;
