//! «Probar» un conector en una cuenta: qué se encontró, por qué y qué hacer. Une lo que dijo el system/init de una sesión,
//! lo que cuenta `claude mcp get <servidor>` (el motivo de un fallo) y una consulta mínima de lectura. Equivale a
//! src/main/features/tickets/probar.ts.
use super::conector::ConectorMcp;
use super::errores::Res;
use super::modelo::{Disponibilidad, EstadoMcp, EstadoPrueba, ResultadoPrueba};
use super::motor::{accion_schema, build_args, negadas, parse_envelope, Limites, OpcionesArgs, TOOL_MISSING};
use super::texto::{cortar16, len16, num_valor, re, trim_js};
use regex::{Regex, RegexBuilder};
use serde_json::Value;
use std::sync::OnceLock;

pub const PROBAR_VUELTAS: u32 = 6;
const CAUSA_MAX: usize = 200;

/// Lo que `\s` es en JavaScript (el de `regex` es otro conjunto).
const S: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// Los nombres que se le pasan a `claude mcp get`: sin espacios ni nada que parezca una opción.
pub fn nombre_probable(nombre: &str) -> bool {
    re(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$").is_match(nombre)
}

/// La herramienta de lectura con la que se prueba: la primera de la lista del conector.
pub fn herramienta_de_probar(def: &ConectorMcp) -> &str {
    def.herramientas.lista.first().map_or("", String::as_str)
}

pub fn build_probar_prompt(def: &ConectorMcp) -> String {
    let t = herramienta_de_probar(def);
    [
        format!("Prueba de conexión de solo lectura con {}. No modifiques nada.", def.nombre()),
        format!("Llamá UNA sola vez a {t}, pidiendo lo mínimo (un solo resultado o la página más corta que admita). No llames a otra herramienta."),
        "Respondé SOLO con JSON, sin texto antes ni después y sin bloque de código:".into(),
        "- si la herramienta respondió: {\"ok\":true}".into(),
        "- si devolvió un error o no se pudo llamar: {\"ok\":false,\"error\":\"<el motivo que dio, en pocas palabras>\"}".into(),
        format!("Si la herramienta no está disponible en esta sesión, respondé {{\"ok\":false,\"error\":\"{TOOL_MISSING}\"}}."),
    ]
    .join("\n")
}

pub fn build_probar_args(def: &ConectorMcp, model: &str, ajenos: &[String], limites: Limites) -> Vec<String> {
    let mut a = build_args(
        model,
        &OpcionesArgs {
            allow: vec![def.nombre_completo(herramienta_de_probar(def))],
            deny: negadas(def),
            schema: &accion_schema(),
            extra_deny: ajenos,
            limites: Limites { max_turns: Some(f64::from(PROBAR_VUELTAS)), max_cost_usd: limites.max_cost_usd },
        },
    );
    a.push("--verbose".into());
    a
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prueba {
    pub ok: bool,
    pub error: Option<String>,
}

struct Reglas {
    control: Regex,
    credencial: Regex,
    clave: Regex,
    usuario_url: Regex,
    url: Regex,
    largo: Regex,
    blancos: Regex,
}

fn reglas() -> &'static Reglas {
    static R: OnceLock<Reglas> = OnceLock::new();
    R.get_or_init(|| {
        let ci = |p: &str| RegexBuilder::new(p).case_insensitive(true).build().unwrap_or_else(|e| panic!("{p}: {e}"));
        Reglas {
            control: Regex::new(r"[\x00-\x1f\x7f]+").unwrap(),
            credencial: ci(&format!(r"(?-u:\b)(Bearer|Basic)[{S}]+[^{S}]+")),
            clave: ci(&format!(r"(?-u:\b)([A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|passwd)[A-Za-z0-9_-]*)[{S}]*[:=][{S}]*[^{S}]+")),
            usuario_url: ci(&format!(r#"(https?://)[^{S}/?#"']*@"#)),
            url: ci(&format!(r#"(https?://[^{S}/?#"']+)[^{S}"']*"#)),
            largo: Regex::new(r"(?-u:\b)[A-Za-z0-9_+/=.~-]{32,}(?-u:\b)").unwrap(),
            blancos: Regex::new(&format!(r"[{S}]+")).unwrap(),
        }
    })
}

/// Lo que sale de un error de servidor puede traer una URL con claves, un `Bearer` o un token: se recorta a una línea, se
/// tapan las partes que parecen secretos y de las URL queda solo el origen.
pub fn limpiar_causa(texto: &str, max: usize) -> String {
    let r = reglas();
    let t = r.control.replace_all(texto, " ");
    let t = r.credencial.replace_all(&t, "${1} ***");
    let t = r.clave.replace_all(&t, "${1}=***");
    let t = r.usuario_url.replace_all(&t, "${1}");
    let t = r.url.replace_all(&t, "${1}");
    let t = r.largo.replace_all(&t, "***");
    let t = r.blancos.replace_all(&t, " ");
    let limpio = trim_js(&t);
    if len16(limpio) > max {
        format!("{}…", cortar16(limpio, max - 1))
    } else {
        limpio.to_string()
    }
}

pub fn limpiar_causa_defecto(texto: &str) -> String {
    limpiar_causa(texto, CAUSA_MAX)
}

/// Lee la respuesta de la consulta mínima. Falla con lo mismo que `parse_envelope` (sobre con error, sin JSON…).
pub fn parse_probar(def: &ConectorMcp, stdout: &str) -> Res<Prueba> {
    let data = parse_envelope(&def.base, stdout)?.data;
    let o = data.as_object();
    if o.and_then(|o| o.get("ok")) == Some(&Value::Bool(true)) {
        return Ok(Prueba { ok: true, error: None });
    }
    let error = match o.and_then(|o| o.get("error")) {
        Some(Value::String(e)) if !trim_js(e).is_empty() => limpiar_causa_defecto(e),
        _ => "sin motivo".to_string(),
    };
    Ok(Prueba { ok: false, error: Some(error) })
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DatosMcp {
    /// «usuario», «local» o «proyecto»: dónde se definió el servidor.
    pub alcance: Option<String>,
    /// «Issue:» de `claude mcp get`: por qué no conectó.
    pub motivo: Option<String>,
}

fn alcance_de(s: &str) -> Option<&'static str> {
    let s = trim_js(s).to_lowercase();
    let empieza = |p: &str| s.strip_prefix(p).is_some_and(|resto| !resto.chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_'));
    if empieza("user") {
        Some("usuario")
    } else if empieza("local") {
        Some("local")
    } else if empieza("project") {
        Some("proyecto")
    } else {
        None
    }
}

/// Solo Scope e Issue de `claude mcp get`: el resto (URL, cabeceras, variables) puede traer credenciales y no se lee.
pub fn datos_de_mcp_get(stdout: &str) -> DatosMcp {
    static LINEA: OnceLock<Regex> = OnceLock::new();
    let linea = LINEA.get_or_init(|| Regex::new(&format!(r"^[{S}]*(Scope|Issue):[{S}]*(.+)$")).unwrap());
    let mut out = DatosMcp::default();
    for l in stdout.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)) {
        let Some(m) = linea.captures(l) else { continue };
        if &m[1] == "Scope" {
            out.alcance = alcance_de(&m[2]).map(str::to_string);
        } else {
            out.motivo = Some(limpiar_causa_defecto(&m[2]));
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq)]
pub enum ResultadoDePrueba {
    Prueba(Prueba),
    PlazoS(f64),
    Cayo(String),
}

pub struct EntradaDiagnostico<'a> {
    pub def: &'a ConectorMcp,
    /// El nombre de la cuenta, tal como la ve la persona.
    pub cuenta: &'a str,
    pub d: &'a Disponibilidad,
    /// Si la revisión de la cuenta falló (no se pudo ni abrir Claude): por qué.
    pub error_revision: Option<String>,
    pub datos: Option<DatosMcp>,
    /// La consulta mínima, si se llegó a hacer.
    pub prueba: Option<ResultadoDePrueba>,
    pub ms: u64,
}

fn sobre_alcance(datos: Option<&DatosMcp>) -> String {
    match datos.and_then(|d| d.alcance.as_deref()) {
        Some(a) if a != "usuario" => format!(" Está definido con alcance {a}: Sloth consulta desde otra carpeta y no lo ve; agregalo con alcance usuario (claude mcp add --scope user)."),
        _ => String::new(),
    }
}

pub fn diagnosticar(e: &EntradaDiagnostico) -> ResultadoPrueba {
    let (def, cuenta, ms) = (e.def, e.cuenta, e.ms);
    let n = def.nombre();
    let motivo = e.datos.as_ref().and_then(|d| d.motivo.clone());
    let r = |estado: EstadoPrueba, mensaje: String, causa: Option<String>, que_hacer: Option<String>| ResultadoPrueba {
        estado,
        mensaje,
        causa: causa.filter(|c| !c.is_empty()),
        que_hacer: que_hacer.filter(|c| !c.is_empty()),
        ms,
    };
    let es_claude_ai = def.herramientas.prefijo.starts_with("mcp__claude_ai_");
    let (nombre, estado, verificado) = match e.d {
        Disponibilidad::SinRevisar => {
            return r(
                EstadoPrueba::Error,
                format!("No se pudo revisar la cuenta «{cuenta}»."),
                e.error_revision.clone(),
                Some("Revisá que la cuenta tenga la sesión iniciada y probá de nuevo.".into()),
            )
        }
        Disponibilidad::Falta { parecido: Some((nombre, faltan)) } => {
            return r(
                EstadoPrueba::SinHerramientas,
                format!("«{nombre}» no tiene todas las herramientas de {n}."),
                Some(format!("Le faltan: {}.", faltan.join(", "))),
                Some(format!("Copiá {n} como conector propio y ajustá sus herramientas, o agregalas al servidor.")),
            )
        }
        Disponibilidad::Falta { parecido: None } => {
            return r(
                EstadoPrueba::SinHerramientas,
                format!("La cuenta «{cuenta}» no tiene el servidor MCP de {n}."),
                None,
                Some(if es_claude_ai {
                    format!("Conectá {n} en claude.ai con esa cuenta (Configuración → Conectores) y probá de nuevo.")
                } else {
                    "Agregalo en esa cuenta con alcance usuario (claude mcp add --scope user) y probá de nuevo. Un servidor de alcance local o de proyecto solo anda dentro de su carpeta: Sloth consulta desde otra.".into()
                }),
            )
        }
        Disponibilidad::Elegir { .. } => {
            return r(EstadoPrueba::Error, format!("La cuenta «{cuenta}» tiene más de un servidor que puede ser {n}."), None, Some("Elegí cuál usa Sloth en «Conectores por cuenta».".into()))
        }
        Disponibilidad::Tiene { nombre, estado, verificado, .. } => (nombre, *estado, *verificado),
    };
    let s = format!("«{nombre}»");
    match estado {
        EstadoMcp::NecesitaAuth => {
            return r(
                EstadoPrueba::NecesitaSesion,
                format!("El servidor {s} pide iniciar sesión."),
                motivo,
                Some(if nombre.starts_with("claude.ai ") {
                    format!("Volvé a autorizar {n} en claude.ai con la cuenta «{cuenta}» y probá de nuevo.")
                } else {
                    format!("Abrí Claude Code con la cuenta «{cuenta}», corré /mcp, elegí {s} y autenticalo; después tocá Probar.")
                }),
            )
        }
        EstadoMcp::Fallo => {
            return r(
                EstadoPrueba::Error,
                format!("No se pudo conectar a {s}."),
                Some(motivo.unwrap_or_else(|| "Claude Code no dijo por qué.".into())),
                Some(format!("Corré /mcp con la cuenta «{cuenta}» para ver el error.{}", sobre_alcance(e.datos.as_ref()))),
            )
        }
        EstadoMcp::Conectado => {}
        _ => {
            return r(
                EstadoPrueba::Error,
                format!("{s} no terminó de conectar a tiempo."),
                Some(motivo.unwrap_or_else(|| "Todavía figuraba conectando (pending).".into())),
                Some("Probá de nuevo. Si sigue igual, corré /mcp con esa cuenta: puede estar esperando que lo autentiques o arrancar lento.".into()),
            )
        }
    }
    if !verificado {
        return r(EstadoPrueba::SinHerramientas, format!("{s} conectó, pero no se le vieron las herramientas de {n}."), None, Some("Tocá «Revisar» y probá de nuevo.".into()));
    }
    let t = herramienta_de_probar(def);
    match &e.prueba {
        None => r(EstadoPrueba::Conectado, format!("{s} está conectado y tiene las herramientas de {n}."), None, None),
        Some(ResultadoDePrueba::PlazoS(p)) => r(
            EstadoPrueba::Error,
            format!("{s} está conectado, pero {t} tardó más de {} s en responder.", num_valor(*p)),
            None,
            Some("Probá de nuevo. Si es un servidor propio, revisá que no esté lento o colgado.".into()),
        ),
        Some(ResultadoDePrueba::Cayo(c)) => r(EstadoPrueba::Error, format!("{s} está conectado, pero la consulta de prueba falló."), Some(c.clone()), Some("Probá de nuevo o corré /mcp con esa cuenta.".into())),
        Some(ResultadoDePrueba::Prueba(p)) if p.ok => {
            let seg = ((ms as f64) / 1000.0).round().max(1.0);
            r(EstadoPrueba::Conectado, format!("{s} está conectado y respondió a una consulta de prueba ({seg} s)."), None, None)
        }
        Some(ResultadoDePrueba::Prueba(p)) if p.error.as_deref() == Some(TOOL_MISSING) => r(
            EstadoPrueba::SinHerramientas,
            format!("{s} conectó, pero la herramienta {t} no está disponible en esta sesión."),
            None,
            Some(format!("Revisá que el servidor exponga {t}, o ajustá las herramientas del conector.")),
        ),
        Some(ResultadoDePrueba::Prueba(p)) => r(
            EstadoPrueba::Error,
            format!("{s} conectó, pero {t} devolvió un error."),
            p.error.clone(),
            Some("Revisá el servidor o tus permisos en el sistema de tickets, y probá de nuevo.".into()),
        ),
    }
}
