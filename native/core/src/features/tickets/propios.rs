//! Conectores que no vienen con Sloth: los que arma la persona y los que trae el .sloth/conectores.json de un repo. Pasan por
//! el mismo validador que los incluidos y además nunca son «verificados» ni pueden leer con una herramienta que no parezca de
//! lectura. El hash se inyecta. Equivale a src/main/features/tickets/propios.ts.
use super::conector::{validar_conector, ConectorDef, ConectorMcp};
use super::errores::ConectorInvalido;
use super::modelo::{HerramientasVista, OrigenConector, Ordenado, PistasVista, ACCIONES};
use super::motor::permisos_por_consulta;
use super::texto::{cortar16, len16, num_valor, re};
use regex::Regex;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq)]
pub struct ConectorRegistrado {
    pub def: ConectorDef,
    pub origen: OrigenConector,
    pub hash: String,
    /// Del equipo: las claves (repoKey) de las otras copias del repo con el mismo conector, p. ej. worktrees.
    pub otros_repos: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArchivoPropios {
    pub conectores: Vec<ConectorDef>,
    /// `clave_aceptado(repoKey, id)` → hash de la versión del conector del equipo que la persona aceptó.
    pub aceptados: Ordenado<String>,
    /// Los que no validan (de otra versión de Sloth o tocados a mano), tal cual: no se borran al guardar y se reintentan al leer.
    pub apartados: Vec<Value>,
}

impl ArchivoPropios {
    pub fn vacio() -> Self {
        ArchivoPropios { conectores: Vec::new(), aceptados: Ordenado::default(), apartados: Vec::new() }
    }

    /// Lo que se escribe en disco: `{ version: 1, conectores, aceptados, apartados }`.
    pub fn a_valor(&self) -> Value {
        let mut o = Map::new();
        o.insert("version".into(), Value::from(1));
        o.insert("conectores".into(), Value::Array(self.conectores.iter().map(ConectorDef::a_valor).collect()));
        o.insert("aceptados".into(), serde_json::to_value(&self.aceptados).unwrap_or(Value::Null));
        o.insert("apartados".into(), Value::Array(self.apartados.clone()));
        Value::Object(o)
    }
}

pub const PROPIOS_MAX: usize = 30;
pub const EQUIPO_MAX: usize = 10;
pub const IMPORT_MAX_BYTES: usize = 64 * 1024;
/// `<repo>/.sloth/conectores.json`: aparte del team.json para que las versiones viejas de Sloth no lo rechacen entero.
pub const EQUIPO_ARCHIVO: &str = "conectores.json";
pub const EQUIPO_FORMATO: &str = "sloth-conectores";
pub const EQUIPO_MAX_BYTES: usize = 256 * 1024;

const AVISO_MAX: usize = 200;
const AVISOS_MAX: usize = 10;
const CLAVE_ACEPTADO_MAX: usize = 1100;
const PROHIBIDAS: [&str; 3] = ["__proto__", "constructor", "prototype"];

// Heurística, no garantía: una herramienta de lectura tiene que tener alguna parte de LECTURA y ninguna de ESCRITURA. Lo que
// no se reconoce como lectura se trata como escritura.
const LECTURA: &[&str] = &[
    "get", "list", "search", "find", "fetch", "read", "query", "lookup", "view", "show", "describe", "count", "filter", "info", "whoami", "retrieve", "listar", "ver", "buscar", "leer", "obtener", "consultar", "traer",
    "mostrar",
];
const ESCRITURA: &[&str] = &[
    "create", "update", "delete", "remove", "add", "edit", "set", "move", "transition", "assign", "unassign", "save", "post", "put", "patch", "write", "close", "reopen", "merge", "upload", "send", "archive", "complete",
    "toggle", "log", "duplicate", "execute", "exec", "run", "push", "fork", "bulk", "publish", "submit", "import", "invite", "share", "approve", "reject", "cancel", "trigger", "deploy", "rollback", "rename", "insert",
    "upsert", "drop", "batch", "replace", "dismiss", "destroy", "trash", "purge", "revoke", "grant", "restore", "reset", "clear", "mark", "modify", "mutate", "apply", "sync", "transfer", "attach", "detach", "enable",
    "disable", "notify", "subscribe", "unsubscribe", "vote", "pin", "unpin", "crear", "actualizar", "borrar", "eliminar", "agregar", "mover", "asignar", "cerrar", "editar", "guardar", "enviar", "comentar", "cargar",
    "tildar", "tomar", "soltar", "cambiar", "subir", "publicar", "ejecutar",
];

/// `getJiraIssue` → get, jira, issue; `jira_create_issue` → jira, create, issue.
pub fn partes(corto: &str) -> Vec<String> {
    static A: OnceLock<Regex> = OnceLock::new();
    static B: OnceLock<Regex> = OnceLock::new();
    static C: OnceLock<Regex> = OnceLock::new();
    let a = A.get_or_init(|| Regex::new(r"([a-z0-9])([A-Z])").unwrap());
    let b = B.get_or_init(|| Regex::new(r"([A-Z]+)([A-Z][a-z])").unwrap());
    let c = C.get_or_init(|| Regex::new(r"[\s_-]+").unwrap());
    let t = a.replace_all(corto, "${1} ${2}");
    let t = b.replace_all(&t, "${1} ${2}");
    c.split(&t.to_lowercase()).filter(|x| !x.is_empty()).map(str::to_string).collect()
}

pub fn parece_de_lectura(corto: &str) -> bool {
    let xs = partes(corto);
    xs.iter().any(|x| LECTURA.contains(&x.as_str())) && !xs.iter().any(|x| ESCRITURA.contains(&x.as_str()))
}

fn invalido(ruta: &str, motivo: &str) -> ConectorInvalido {
    ConectorInvalido { ruta: ruta.into(), motivo: motivo.into() }
}

/// Copia con `verificado: false`. Falla si no es de vía mcp o si lee con algo que no parece de lectura.
pub fn revisar_no_confiable(def: &ConectorDef) -> Result<ConectorDef, ConectorInvalido> {
    let ConectorDef::Mcp(m) = def else { return Err(invalido("conector.via", "los conectores propios son de vía mcp")) };
    let h = &m.herramientas;
    let mut grupos: Vec<(String, Vec<String>)> = vec![("lista".into(), h.lista.clone()), ("detalle".into(), h.detalle.clone()), ("apoyo".into(), h.apoyo.clone().unwrap_or_default())];
    if let Some(en) = &h.apoyo_en {
        for (a, xs) in en.iter() {
            grupos.push((format!("apoyoEn.{a}"), xs.clone()));
        }
    }
    for (g, xs) in grupos {
        if let Some(i) = xs.iter().position(|x| !parece_de_lectura(x)) {
            return Err(invalido(&format!("conector.herramientas.{g}[{i}]"), &format!("«{}» no parece de lectura: no puede leer", xs[i])));
        }
    }
    let mut copia = m.clone();
    copia.base.verificado = false;
    Ok(ConectorDef::Mcp(copia))
}

pub fn validar_propio(raw: &Value) -> Result<ConectorDef, ConectorInvalido> {
    revisar_no_confiable(&validar_conector(raw)?)
}

pub type Hash<'a> = &'a dyn Fn(&str) -> String;

/// Los primeros 16 caracteres del SHA-256 en hexadecimal: lo que identifica una versión de un conector.
pub fn hash_corto(texto: &str) -> String {
    hex::encode(Sha256::digest(texto.as_bytes()))[..16].to_string()
}

fn cmp_utf16(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// JSON con las claves ordenadas: el mismo conector da el mismo hash aunque cambie el orden.
pub fn json_canonico(v: &Value) -> String {
    match v {
        Value::Array(xs) => format!("[{}]", xs.iter().map(json_canonico).collect::<Vec<_>>().join(",")),
        Value::Object(o) => {
            let mut claves: Vec<&String> = o.keys().collect();
            claves.sort_by(|a, b| cmp_utf16(a, b));
            format!("{{{}}}", claves.iter().map(|k| format!("{}:{}", serde_json::to_string(k).unwrap_or_default(), json_canonico(&o[*k]))).collect::<Vec<_>>().join(","))
        }
        Value::Number(n) => n.as_f64().map_or_else(|| v.to_string(), |f| num_valor(f).to_string()),
        otro => otro.to_string(),
    }
}

pub fn clave_aceptado(repo_key: &str, id: &str) -> String {
    format!("{repo_key}::{id}")
}

/// Las claves a guardar al aceptar: una por copia del repo, así borrar un worktree no deshace la aceptación.
pub fn claves_aceptadas(r: &ConectorRegistrado, repo_key: &dyn Fn(&str) -> String) -> Vec<String> {
    let OrigenConector::Equipo { repo, .. } = &r.origen else { return Vec::new() };
    std::iter::once(repo_key(repo)).chain(r.otros_repos.clone().unwrap_or_default()).map(|k| clave_aceptado(&k, r.def.id())).collect()
}

/// Uno del equipo vale si se aceptó esta misma versión desde cualquiera de las copias del repo.
pub fn esta_aceptado(r: &ConectorRegistrado, aceptados: &Ordenado<String>, repo_key: &dyn Fn(&str) -> String) -> bool {
    let OrigenConector::Equipo { repo, .. } = &r.origen else { return true };
    std::iter::once(repo_key(repo)).chain(r.otros_repos.clone().unwrap_or_default()).any(|k| aceptados.get(&clave_aceptado(&k, r.def.id())) == Some(&r.hash))
}

pub fn recortar_avisos(avisos: &[String]) -> Vec<String> {
    avisos.iter().take(AVISOS_MAX).map(|a| if len16(a) > AVISO_MAX { format!("{}…", cortar16(a, AVISO_MAX - 1)) } else { a.clone() }).collect()
}

enum ErrorParseo {
    Sintaxis,
    ClavePermitida(ConectorInvalido),
}

fn sin_prototipos(v: &Value) -> Result<(), ConectorInvalido> {
    match v {
        Value::Object(o) => {
            for (k, x) in o {
                if PROHIBIDAS.contains(&k.as_str()) {
                    return Err(invalido("conector", &format!("clave no permitida «{k}»")));
                }
                sin_prototipos(x)?;
            }
            Ok(())
        }
        Value::Array(xs) => xs.iter().try_for_each(sin_prototipos),
        _ => Ok(()),
    }
}

/// `JSON.parse` con el reviver que rechaza `__proto__`, `constructor` y `prototype` en cualquier nivel.
fn parsear_sin_prototipos(texto: &str) -> Result<Value, ErrorParseo> {
    let v: Value = serde_json::from_str(texto.strip_prefix('\u{feff}').unwrap_or(texto)).map_err(|_| ErrorParseo::Sintaxis)?;
    sin_prototipos(&v).map_err(ErrorParseo::ClavePermitida)?;
    Ok(v)
}

#[derive(Debug, Clone, PartialEq)]
pub struct LecturaPropios {
    pub archivo: ArchivoPropios,
    /// No se entiende: se aparta el archivo entero.
    pub corrupto: bool,
    /// De una versión más nueva de Sloth: no se toca ni se aparta.
    pub futuro: bool,
    pub avisos: Vec<String>,
}

fn nada() -> LecturaPropios {
    LecturaPropios { archivo: ArchivoPropios::vacio(), corrupto: false, futuro: false, avisos: Vec::new() }
}

pub fn parsear_archivo_propios(texto: Option<&str>) -> LecturaPropios {
    let Some(texto) = texto else { return nada() };
    let Ok(raw) = parsear_sin_prototipos(texto) else { return LecturaPropios { corrupto: true, ..nada() } };
    let Some(o) = raw.as_object() else { return LecturaPropios { corrupto: true, ..nada() } };
    if o.get("version").and_then(Value::as_f64).is_some_and(|v| v > 1.0) {
        return LecturaPropios { futuro: true, avisos: vec!["Tus conectores propios son de una versión más nueva de Sloth: actualizá Sloth. Mientras, no se pueden cambiar.".into()], ..nada() };
    }
    if o.get("version").and_then(Value::as_f64) != Some(1.0) {
        return LecturaPropios { corrupto: true, ..nada() };
    }
    let mut avisos: Vec<String> = Vec::new();
    let mut archivo = ArchivoPropios::vacio();
    let lista = |k: &str| o.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
    for x in lista("conectores").into_iter().chain(lista("apartados")) {
        let r = validar_propio(&x).map_err(|e| e.to_string()).and_then(|def| {
            if archivo.conectores.iter().any(|c| c.id() == def.id()) {
                Err(format!("el id «{}» está repetido", def.id()))
            } else {
                Ok(def)
            }
        });
        match r {
            Ok(def) => archivo.conectores.push(def),
            Err(motivo) => {
                if archivo.apartados.len() >= PROPIOS_MAX {
                    avisos.push(format!("Hay más de {PROPIOS_MAX} conectores propios que no se cargan: los que sobran se pierden al guardar."));
                    continue;
                }
                let id = x.get("id").and_then(Value::as_str).map(|i| format!("«{}» ", cortar16(i, 32))).unwrap_or_default();
                archivo.apartados.push(x);
                avisos.push(format!("Tu conector {id}no se cargó ({motivo}). Quedó guardado aparte en el archivo: no se borra."));
            }
        }
    }
    if let Some(ac) = o.get("aceptados").and_then(Value::as_object) {
        let hash_ok = re(r"^[0-9a-f]{16}$");
        for (k, v) in ac {
            if len16(k) <= CLAVE_ACEPTADO_MAX && v.as_str().is_some_and(|h| hash_ok.is_match(h)) {
                archivo.aceptados.insert(k.clone(), v.as_str().unwrap_or_default().to_string());
            }
        }
    }
    let mut unicos: Vec<String> = Vec::new();
    for a in avisos {
        if !unicos.contains(&a) {
            unicos.push(a);
        }
    }
    LecturaPropios { archivo, avisos: recortar_avisos(&unicos), ..nada() }
}

pub struct EquipoCrudo {
    pub repo: String,
    pub repo_key: String,
    pub equipo: String,
    pub conectores: Vec<Value>,
}

pub struct EntradaRegistro<'a> {
    pub incluidos: &'a [ConectorDef],
    pub usuario: &'a [Value],
    pub equipos: &'a [EquipoCrudo],
    pub hash: Hash<'a>,
}

pub fn armar_registro(o: &EntradaRegistro) -> (Vec<ConectorRegistrado>, Vec<String>) {
    let mut avisos: Vec<String> = Vec::new();
    let mut lista: Vec<ConectorRegistrado> = o.incluidos.iter().map(|def| ConectorRegistrado { def: def.clone(), origen: OrigenConector::Incluido, hash: (o.hash)(&json_canonico(&def.a_valor())), otros_repos: None }).collect();
    let origen_de = |lista: &[ConectorRegistrado], id: &str| lista.iter().find(|r| r.def.id() == id).map(|r| r.origen.clone());

    for raw in o.usuario.iter().take(PROPIOS_MAX) {
        let def = match validar_propio(raw) {
            Ok(d) => d,
            Err(e) => {
                avisos.push(format!("Un conector propio no se cargó: {e}"));
                continue;
            }
        };
        match origen_de(&lista, def.id()) {
            Some(OrigenConector::Incluido) => avisos.push(format!("El conector «{}» usa el id de uno incluido: no se cargó.", def.id())),
            Some(_) => avisos.push(format!("El conector «{}» está repetido: no se cargó.", def.id())),
            None => {
                let hash = (o.hash)(&json_canonico(&def.a_valor()));
                lista.push(ConectorRegistrado { def, origen: OrigenConector::Usuario, hash, otros_repos: None });
            }
        }
    }
    if o.usuario.len() > PROPIOS_MAX {
        avisos.push(format!("Hay más de {PROPIOS_MAX} conectores propios: se cargaron los primeros {PROPIOS_MAX}."));
    }

    let mut equipos: Vec<&EquipoCrudo> = o.equipos.iter().collect();
    equipos.sort_by(|a, b| a.repo_key.cmp(&b.repo_key));
    for e in equipos {
        let del = format!("Del equipo {}: ", e.equipo);
        if e.conectores.len() > EQUIPO_MAX {
            avisos.push(format!("{del}trae más de {EQUIPO_MAX} conectores; se cargaron los primeros {EQUIPO_MAX}."));
        }
        for raw in e.conectores.iter().take(EQUIPO_MAX) {
            let def = match validar_propio(raw) {
                Ok(d) => d,
                Err(err) => {
                    avisos.push(format!("{del}un conector no se cargó: {err}"));
                    continue;
                }
            };
            let hash = (o.hash)(&json_canonico(&def.a_valor()));
            let previo = lista.iter().position(|r| r.def.id() == def.id());
            // El mismo conector en otra copia del repo (p. ej. un worktree): no es un choque.
            if let Some(i) = previo {
                if matches!(lista[i].origen, OrigenConector::Equipo { .. }) && lista[i].hash == hash {
                    lista[i].otros_repos.get_or_insert_with(Vec::new).push(e.repo_key.clone());
                    continue;
                }
            }
            match previo.map(|i| lista[i].origen.clone()) {
                Some(OrigenConector::Incluido) => avisos.push(format!("{del}«{}» usa el id de uno incluido: no se cargó.", def.id())),
                Some(OrigenConector::Usuario) => avisos.push(format!("{del}«{}» tiene el id de uno tuyo: no se cargó.", def.id())),
                Some(_) => avisos.push(format!("{del}«{}» ya viene de otro repo o está repetido: no se cargó.", def.id())),
                None => lista.push(ConectorRegistrado { def, origen: OrigenConector::Equipo { repo: e.repo.clone(), equipo: e.equipo.clone() }, hash, otros_repos: None }),
            }
        }
    }
    (lista, recortar_avisos(&avisos))
}

/// El texto de un archivo `.sloth-conector.json`. Falla con un mensaje legible.
pub fn parsear_import(texto: &str) -> Result<ConectorDef, String> {
    if texto.len() > IMPORT_MAX_BYTES {
        return Err(format!("El archivo pesa más de {} KB.", IMPORT_MAX_BYTES / 1024));
    }
    let raw = match parsear_sin_prototipos(texto) {
        Ok(v) => v,
        Err(ErrorParseo::ClavePermitida(e)) => return Err(e.to_string()),
        Err(ErrorParseo::Sintaxis) => return Err("El archivo no es un JSON válido.".into()),
    };
    validar_propio(&raw).map_err(|e| e.to_string())
}

/// El texto de `.sloth/conectores.json`: la lista cruda, que después pasa por `armar_registro`. Falla con un mensaje legible.
pub fn parsear_conectores_equipo(texto: &str) -> Result<Vec<Value>, String> {
    if texto.len() > EQUIPO_MAX_BYTES {
        return Err(format!("pesa más de {} KB.", EQUIPO_MAX_BYTES / 1024));
    }
    let raw = match parsear_sin_prototipos(texto) {
        Ok(v) => v,
        Err(ErrorParseo::ClavePermitida(e)) => return Err(e.to_string()),
        Err(ErrorParseo::Sintaxis) => return Err("no es un JSON válido.".into()),
    };
    let Some(o) = raw.as_object() else { return Err("tiene que ser un objeto JSON.".into()) };
    for k in o.keys() {
        if k.starts_with('_') || k.starts_with('$') {
            continue;
        }
        if !["formato", "versión", "conectores"].contains(&k.as_str()) {
            return Err(format!("no conozco la clave «{k}»."));
        }
    }
    if o.get("formato").and_then(Value::as_str) != Some(EQUIPO_FORMATO) {
        return Err(format!("formato: tiene que ser «{EQUIPO_FORMATO}»."));
    }
    if o.get("versión").and_then(Value::as_f64) != Some(1.0) {
        return Err("versión: esta versión de Sloth entiende la 1. Actualizá Sloth.".into());
    }
    let Some(conectores) = o.get("conectores").and_then(Value::as_array) else { return Err("conectores: tiene que ser una lista.".into()) };
    if conectores.len() > EQUIPO_MAX {
        return Err(format!("conectores: como mucho {EQUIPO_MAX}."));
    }
    Ok(conectores.clone())
}

pub fn texto_export(def: &ConectorDef) -> String {
    format!("{}\n", serde_json::to_string_pretty(&def.a_valor()).unwrap_or_default())
}

/// Lo que se muestra antes de aceptar o guardar un conector que no armó la persona: sale de lo mismo que usa el motor.
pub fn vista_herramientas(def: &ConectorMcp) -> HerramientasVista {
    let h = &def.herramientas;
    let p = &def.pistas;
    let permisos = permisos_por_consulta(def);
    let mut acciones: Ordenado<(String, Option<String>)> = Ordenado::default();
    for a in ACCIONES {
        if let Some(x) = p.acciones.get(a.como_str()) {
            acciones.insert(a.como_str(), (serde_json::to_string(&x.args).unwrap_or_default(), x.nota.clone().filter(|n| !n.is_empty())));
        }
    }
    HerramientasVista {
        prefijo: h.prefijo.clone(),
        lista: permisos.lista,
        detalle: permisos.detalle,
        acciones: permisos.acciones,
        escritura: h.escritura.clone(),
        negar: h.negar.len(),
        comando_ticket: def.base.comando_ticket.clone(),
        pistas: PistasVista {
            yo_con_id: p.yo.con_id.clone(),
            yo_sin_id: p.yo.sin_id.clone(),
            lista: p.lista.clone(),
            estados: p.estados.clone(),
            apoyo: p.apoyo.clone(),
            detalle: p.detalle.iter().map(|x| format!("{} {}", x.herramienta, serde_json::to_string(&x.args).unwrap_or_default())).collect(),
            acciones,
        },
    }
}
