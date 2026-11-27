//! «Reportar un problema»: filtro de datos personales, cuerpo del issue, URL con host fijo y lectura del final del
//! registro. Equivale a src/main/features/report-core.ts y a la validación de `submit` en report.ts. La captura de
//! pantalla y el navegador quedan del lado del SO.
use crate::perfiles_core::es_blanco_js;
use fancy_regex::{Captures, Regex, RegexBuilder};
use serde_json::Value;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::OnceLock;

pub const REPORT_ISSUE_URL: &str = "https://github.com/Toomasmg/sloth/issues/new";
pub const TITLE_MIN: usize = 8;
pub const TITLE_MAX: usize = 200;
pub const BODY_MAX: usize = 6000;
/// Tope de la URL prellenada. Por encima, el navegador o GitHub la pueden truncar.
pub const URL_MAX: usize = 8000;
pub const WHAT_MAX: usize = 1500;
pub const EXPECT_MAX: usize = 800;
pub const STEP_MAX: usize = 200;
pub const STEPS_MAX: usize = 8;
pub const LOG_MINUTES: f64 = 30.0;
pub const LOG_KEEP: usize = 40;
pub const LOG_READ_LINES: usize = 400;
pub const LOG_MAX_BYTES: u64 = 64 * 1024;

const WS: &str = r"\t\n\r\x0b\x0c \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

fn utf16(s: &str) -> usize {
    s.encode_utf16().count()
}

fn compilar(p: &str) -> Regex {
    RegexBuilder::new(p).backtrack_limit(usize::MAX).delegate_size_limit(64 << 20).build().unwrap_or_else(|e| panic!("patrón inválido {p}: {e}"))
}

pub struct ContextoSaneo<'a> {
    /// Carpeta personal. Se reemplaza por %USERPROFILE%.
    pub home: &'a str,
    pub username: &'a str,
    pub hostname: &'a str,
    /// Ids de cuentas de Sloth: aparecen en rutas y en el registro.
    pub account_ids: &'a [String],
}

struct Patrones {
    ruta_windows: Regex,
    ruta_unix: Regex,
    email: Regex,
    tokens: Vec<Regex>,
    bearer: Regex,
    pares: Regex,
    cuentas: Regex,
    uuid: Regex,
    hex: Regex,
    base64: Regex,
    ip: Regex,
}

fn patrones() -> &'static Patrones {
    static P: OnceLock<Patrones> = OnceLock::new();
    P.get_or_init(|| {
        let tokens = [
            "(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9_]{20,}",
            "(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]+",
            "(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]+",
            "(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}",
            "(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}",
            "(?<![A-Za-z0-9])npm_[A-Za-z0-9]{30,}",
            "(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{30,}",
            "(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])",
            "eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*",
            "(?<![A-Za-z0-9])sb_(?:secret|publishable)_[A-Za-z0-9_-]+",
            "(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9_-]+",
        ];
        Patrones {
            ruta_windows: compilar(&format!(r#"(?i)[A-Za-z]:[\\/]+Users[\\/]+[^\\/{WS}"'`<>|]+"#)),
            ruta_unix: compilar(&format!(r#"/(home|Users)/[^/{WS}"'`<>|]+"#)),
            email: compilar(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+"),
            tokens: tokens.iter().map(|t| compilar(t)).collect(),
            bearer: compilar(&format!(r"(?i)Bearer[ \t]+[^{WS}]+")),
            pares: compilar(&format!(r#"(?i)(\b[A-Za-z0-9_.-]*(?:token|password|passwd|secret|api[_-]?key)["']?[ \t]*[=:][ \t]*["']?)[^{WS}"'&;,]+"#)),
            cuentas: compilar(&format!(r#"(?i)([\\/])accounts([\\/])[^\\/{WS}"'`<>|]+"#)),
            uuid: compilar("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"),
            hex: compilar("(?i)(?<![A-Za-z0-9])[0-9a-f]{32,}(?![A-Za-z0-9])"),
            base64: compilar(r"(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])"),
            ip: compilar(r"(?<![0-9.])(?!127\.0\.0\.1(?![0-9.]))(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![0-9.])"),
        }
    })
}

fn reemplazar(re: &Regex, texto: &str, con: &str) -> String {
    re.replace_all(texto, con).into_owned()
}

/// Una ruta como patrón: los separadores `\` y `/` dan igual, sin distinguir mayúsculas.
fn patron_de_ruta(p: &str) -> Option<Regex> {
    let partes: Vec<String> = p.split(['\\', '/']).filter(|s| !s.is_empty()).map(|s| fancy_regex::escape(s).into_owned()).collect();
    if partes.is_empty() {
        return None;
    }
    Some(compilar(&format!(r"(?i){}(?![A-Za-z0-9_])", partes.join(r"[\\/]+"))))
}

/// Quita lo personal de un texto. Orden: rutas, correos, tokens conocidos, pares clave=valor, cuentas, UUID, hex y base64
/// largos, nombre de usuario y de PC, IPs.
pub fn sanitizar(texto: &str, ctx: &ContextoSaneo) -> String {
    let p = patrones();
    let mut s = texto.to_string();
    if let Some(home) = patron_de_ruta(ctx.home) {
        s = home.replace_all(&s, fancy_regex::NoExpand("%USERPROFILE%")).into_owned();
    }
    s = p.ruta_windows.replace_all(&s, fancy_regex::NoExpand("C:\\Users\\<usuario>")).into_owned();
    s = reemplazar(&p.ruta_unix, &s, "/${1}/<usuario>");
    s = reemplazar(&p.email, &s, "<email>");
    for re in &p.tokens {
        s = reemplazar(re, &s, "<token>");
    }
    s = reemplazar(&p.bearer, &s, "Bearer <token>");
    s = reemplazar(&p.pares, &s, "${1}<token>");
    // Antes que los UUID: la carpeta de una cuenta se llama con su id.
    s = reemplazar(&p.cuentas, &s, "${1}accounts${2}<cuenta>");
    for id in ctx.account_ids.iter().filter(|id| utf16(id) >= 4) {
        s = reemplazar(&compilar(&format!("(?i){}", fancy_regex::escape(id))), &s, "<cuenta>");
    }
    s = reemplazar(&p.uuid, &s, "<id>");
    s = reemplazar(&p.hex, &s, "<hex>");
    // Con «/» (base64 estándar, p. ej. claves de AWS) se exige mayúscula, minúscula y dígito, así no se come rutas largas.
    s = p
        .base64
        .replace_all(&s, |c: &Captures| {
            let m = &c[0];
            let letra = m.bytes().any(|b| b.is_ascii_alphabetic());
            let ok = m.bytes().any(|b| b.is_ascii_digit()) && letra && (!m.contains('/') || (m.bytes().any(|b| b.is_ascii_lowercase()) && m.bytes().any(|b| b.is_ascii_uppercase())));
            if ok { "<clave>".to_string() } else { m.to_string() }
        })
        .into_owned();
    // Como palabra suelta: «PC» no tiene que comerse «PCB», ni «ana» la palabra «ventana».
    let palabra = |w: &str| compilar(&format!(r"(?i)(?<![\p{{L}}\p{{N}}]){}(?![\p{{L}}\p{{N}}])", fancy_regex::escape(w)));
    if utf16(ctx.username) >= 3 {
        s = palabra(ctx.username).replace_all(&s, fancy_regex::NoExpand("<usuario>")).into_owned();
    }
    if utf16(ctx.hostname) >= 2 {
        s = palabra(ctx.hostname).replace_all(&s, fancy_regex::NoExpand("<pc>")).into_owned();
    }
    reemplazar(&p.ip, &s, "<ip>")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TipoReporte {
    Error,
    Idea,
    Otra,
}

impl TipoReporte {
    pub fn desde_texto(t: &str) -> Option<Self> {
        Some(match t {
            "error" => Self::Error,
            "idea" => Self::Idea,
            "otra" => Self::Otra,
            _ => return None,
        })
    }

    pub fn etiqueta(self) -> &'static str {
        match self {
            Self::Error => "Error",
            Self::Idea => "Idea",
            Self::Otra => "Otra cosa",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Formulario {
    pub tipo: TipoReporte,
    pub title: String,
    pub what: String,
    pub expect: String,
    pub steps: Vec<String>,
}

pub struct DatosSistema<'a> {
    pub sloth: &'a str,
    pub windows: &'a str,
    pub arch: &'a str,
    pub electron: &'a str,
    pub daemon: &'a str,
    pub accounts: usize,
    pub workspaces: usize,
}

/// Datos del sistema, uno por línea (sin sanitizar: quien llama pasa todo por `sanitizar`).
pub fn lineas_de_sistema(f: &DatosSistema) -> Vec<String> {
    vec![
        format!("Sloth {}", f.sloth),
        format!("Windows {} · {}", f.windows, f.arch),
        format!("Electron {}", f.electron),
        format!("Daemon: {}", f.daemon),
        format!("Cuentas: {} · Espacios: {}", f.accounts, f.workspaces),
    ]
}

fn o_sin_completar(s: &str, vacio: &str) -> String {
    let t = s.trim_matches(es_blanco_js);
    if t.is_empty() { vacio.to_string() } else { t.to_string() }
}

/// Cuerpo del issue (markdown). `sys` y `logs` son None si la persona no los quiere incluir.
pub fn armar_cuerpo(f: &Formulario, sys: Option<&[String]>, logs: Option<&[String]>) -> String {
    let steps: Vec<&str> = f.steps.iter().map(|s| s.trim_matches(es_blanco_js)).filter(|s| !s.is_empty()).collect();
    let mut out: Vec<String> = vec![
        format!("**Tipo:** {}", f.tipo.etiqueta()),
        String::new(),
        "## Qué pasó".into(),
        o_sin_completar(&f.what, "(sin completar)"),
        String::new(),
        "## Qué esperaba".into(),
        o_sin_completar(&f.expect, "(sin completar)"),
        String::new(),
        "## Pasos para reproducirlo".into(),
    ];
    if steps.is_empty() {
        out.push("(sin pasos)".into());
    } else {
        out.extend(steps.iter().enumerate().map(|(i, s)| format!("{}. {s}", i + 1)));
    }
    if let Some(sys) = sys {
        out.extend([String::new(), "## Sistema".into()]);
        out.extend(sys.iter().map(|l| format!("- {l}")));
    }
    if let Some(logs) = logs {
        out.extend([String::new(), format!("## Registro (últimos {LOG_MINUTES} minutos)")]);
        if logs.is_empty() {
            out.push("(sin registros recientes)".into());
        } else {
            out.push("```".into());
            out.extend(logs.iter().cloned());
            out.push("```".into());
        }
    }
    out.join("\n") + "\n"
}

fn bloque_de_registro() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| compilar("(?m)(^## Registro[^\\n]*\\n```\\n)((?s:.*?))(\\n```)"))
}

/// Deja el cuerpo en `max` caracteres recortando SOLO las líneas más viejas del registro. El texto de la persona no se
/// toca. None si ni sin registro entra.
pub fn ajustar_cuerpo(body: &str, max: usize) -> Option<String> {
    if utf16(body) <= max {
        return Some(body.to_string());
    }
    let c = bloque_de_registro().captures(body).ok()??;
    let (todo, cabeza, medio, cierre) = (c.get(0)?, c.get(1)?, c.get(2)?, c.get(3)?);
    let head = format!("{}{}", &body[..todo.start()], cabeza.as_str());
    let tail = &body[todo.end()..];
    let mut lineas: Vec<&str> = if medio.as_str().is_empty() { vec![] } else { medio.as_str().split('\n').collect() };
    let mut out = body.to_string();
    while utf16(&out) > max && !lineas.is_empty() {
        lineas.remove(0);
        out = format!("{head}{}{}{tail}", lineas.join("\n"), cierre.as_str());
    }
    (utf16(&out) <= max).then_some(out)
}

/// Como `encodeURIComponent`.
pub fn codificar_componente(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn url_del_issue(title: &str, body: &str) -> String {
    format!("{REPORT_ISSUE_URL}?title={}&body={}", codificar_componente(title), codificar_componente(body))
}

/// true solo para una URL armada por `url_del_issue` (mismo host y ruta fijos, tamaño acotado).
pub fn es_url_del_issue(u: &Value) -> bool {
    u.as_str().is_some_and(|u| utf16(u) <= URL_MAX && u.starts_with(&format!("{REPORT_ISSUE_URL}?")))
}

/// Epoch ms de una marca ISO al inicio de una línea del registro del daemon (`2026-11-27T12:00:00.123Z `), o None
/// si no tiene marca. `Some(NaN)` es una marca con fecha imposible.
fn marca_de_linea(l: &str) -> Option<f64> {
    let b = l.as_bytes();
    let num = |a: usize, n: usize| -> Option<i64> { b.get(a..a + n).filter(|x| x.iter().all(u8::is_ascii_digit)).and_then(|x| std::str::from_utf8(x).ok()?.parse().ok()) };
    let sep = |i: usize, c: u8| b.get(i) == Some(&c);
    let (y, mo, d, h, mi, s) = (num(0, 4)?, num(5, 2)?, num(8, 2)?, num(11, 2)?, num(14, 2)?, num(17, 2)?);
    if !(sep(4, b'-') && sep(7, b'-') && sep(10, b'T') && sep(13, b':') && sep(16, b':')) {
        return None;
    }
    let mut i = 19;
    let mut ms = 0i64;
    if sep(i, b'.') {
        let digs: Vec<u8> = b[i + 1..].iter().copied().take_while(u8::is_ascii_digit).collect();
        if digs.is_empty() {
            return None;
        }
        for k in 0..3 {
            ms = ms * 10 + i64::from(digs.get(k).map_or(0, |c| c - b'0'));
        }
        i += 1 + digs.len();
    }
    if !sep(i, b'Z') || !l[i + 1..].chars().next().is_some_and(es_blanco_js) {
        return None;
    }
    let bisiesto = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let dias_mes = [31, if bisiesto { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if !(1..=12).contains(&mo) || d < 1 || d > dias_mes[(mo - 1) as usize] || h > 23 || mi > 59 || s > 59 {
        return Some(f64::NAN);
    }
    let (yy, mm) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
    let era = yy.div_euclid(400);
    let yoe = yy.rem_euclid(400);
    let doy = (153 * mm + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let dias = era * 146_097 + doe - 719_468;
    Some(((dias * 86_400 + h * 3600 + mi * 60 + s) * 1000 + ms) as f64)
}

/// Líneas de los últimos `minutos` (según la marca de tiempo al inicio de cada línea), como mucho `keep`. Las líneas
/// sin marca siguen a la anterior.
pub fn lineas_recientes(lineas: &[String], ahora: f64, minutos: f64, keep: usize) -> Vec<String> {
    let desde = ahora - minutos * 60_000.0;
    let mut out = Vec::new();
    let mut en_ventana = false;
    for l in lineas {
        if let Some(t) = marca_de_linea(l) {
            en_ventana = t >= desde;
        }
        if en_ventana {
            out.push(l.clone());
        }
    }
    out.split_off(out.len().saturating_sub(keep))
}

/// Últimas `lineas` de un archivo, leyendo desde el final por bloques (nunca el archivo entero), como mucho `max_bytes`.
/// Tolerante: si no se puede leer, devuelve [].
pub fn leer_cola_del_log(file: &Path, lineas: usize, max_bytes: u64) -> Vec<String> {
    let Ok(mut f) = File::open(file) else { return vec![] };
    let Ok(size) = f.metadata().map(|m| m.len()) else { return vec![] };
    let limite = size.min(max_bytes);
    const CHUNK: u64 = 8192;
    let mut partes: Vec<Vec<u8>> = vec![];
    let (mut pos, mut leido, mut saltos) = (size, 0u64, 0usize);
    while pos > 0 && leido < limite {
        let len = CHUNK.min(pos).min(limite - leido);
        pos -= len;
        let mut buf = vec![0u8; len as usize];
        if f.seek(SeekFrom::Start(pos)).is_err() || f.read_exact(&mut buf).is_err() {
            return vec![];
        }
        leido += len;
        saltos += buf.iter().filter(|b| **b == b'\n').count();
        partes.insert(0, buf);
        if saltos > lineas {
            break;
        }
    }
    let texto = String::from_utf8_lossy(&partes.concat()).into_owned();
    let mut arr: Vec<&str> = texto.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    if pos > 0 && !arr.is_empty() {
        arr.remove(0);
    }
    if arr.last() == Some(&"") {
        arr.pop();
    }
    arr[arr.len().saturating_sub(lineas)..].iter().map(|s| s.to_string()).collect()
}

fn texto_acotado(v: &Value, max: usize, que: &str) -> Result<String, String> {
    let s = v.as_str().ok_or_else(|| format!("Dato inválido: {que}."))?;
    if utf16(s) > max {
        return Err(format!("«{que}» es demasiado largo (máximo {max} caracteres)."));
    }
    Ok(s.to_string())
}

#[derive(Debug, PartialEq)]
pub struct Envio {
    pub form: Formulario,
    pub con_sistema: bool,
    pub con_registro: bool,
    pub con_captura: bool,
}

/// Valida lo que llega por IPC en `feat:report:submit`, en el mismo orden que el original.
pub fn validar_envio(raw: &Value) -> Result<Envio, String> {
    let nulo = Value::Null;
    let get = |k: &str| raw.as_object().and_then(|o| o.get(k)).unwrap_or(&nulo);
    let tipo = get("type").as_str().and_then(TipoReporte::desde_texto).ok_or("Elegí el tipo de reporte.")?;
    let title = texto_acotado(get("title"), TITLE_MAX, "Título")?.trim_matches(es_blanco_js).to_string();
    if utf16(&title) < TITLE_MIN {
        return Err(format!("El título tiene que tener al menos {TITLE_MIN} caracteres."));
    }
    let pasos = get("steps").as_array().filter(|a| a.len() <= STEPS_MAX).ok_or("Pasos inválidos.")?;
    let steps = pasos.iter().map(|s| texto_acotado(s, STEP_MAX, "Paso")).collect::<Result<Vec<_>, _>>()?;
    let vacio = Value::String(String::new());
    let opcional = |k: &str| if get(k).is_null() { vacio.clone() } else { get(k).clone() };
    let what = texto_acotado(&opcional("what"), WHAT_MAX, "¿Qué pasó?")?;
    let expect = texto_acotado(&opcional("expect"), EXPECT_MAX, "¿Qué esperabas?")?;
    Ok(Envio {
        form: Formulario { tipo, title, what, expect, steps },
        con_sistema: get("sys") == &Value::Bool(true),
        con_registro: get("logs") == &Value::Bool(true),
        con_captura: get("shot") == &Value::Bool(true),
    })
}

/// Arma la URL del issue: sanitiza otra vez (lo que llegó de la UI pudo editarse) y respeta los topes.
pub fn armar_url(form: &Formulario, sys: Option<&[String]>, logs: Option<&[String]>, ctx: &ContextoSaneo) -> Result<String, String> {
    let titulo = sanitizar(&format!("[{}] {}", form.tipo.etiqueta(), form.title), ctx);
    if utf16(&titulo) > TITLE_MAX {
        return Err(format!("El título tiene que tener como máximo {TITLE_MAX} caracteres."));
    }
    let body = ajustar_cuerpo(&sanitizar(&armar_cuerpo(form, sys, logs), ctx), BODY_MAX).ok_or_else(|| format!("El texto es demasiado largo: recortalo (máximo {BODY_MAX} caracteres)."))?;
    let url = url_del_issue(&titulo, &body);
    if utf16(&url) > URL_MAX {
        return Err("El texto es demasiado largo para abrirlo en GitHub: recortalo un poco.".into());
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx<'a>(cuentas: &'a [String]) -> ContextoSaneo<'a> {
        ContextoSaneo { home: "C:\\Users\\Maria", username: "maria", hostname: "MAQUINA-7", account_ids: cuentas }
    }

    fn san(s: &str) -> String {
        sanitizar(s, &ctx(&[]))
    }

    #[test]
    fn saneo_de_rutas_y_correos() {
        assert_eq!(san("C:\\Users\\Maria\\Documents\\x.ts"), "%USERPROFILE%\\Documents\\x.ts");
        assert_eq!(san("c:/users/maria/docs"), "%USERPROFILE%/docs");
        assert_eq!(san("C:\\Users\\Pedro\\x.ts"), "C:\\Users\\<usuario>\\x.ts");
        assert_eq!(san("/home/pepe/.cfg y /Users/lola/x"), "/home/<usuario>/.cfg y /Users/<usuario>/x");
        assert_eq!(san("escribile a ana.p+x@sub.dom.com ya"), "escribile a <email> ya");
    }

    #[test]
    fn saneo_de_tokens_y_pares() {
        let gh = format!("gh{}_{}", "p", "A1b2".repeat(6));
        assert_eq!(san(&format!("usé {gh} ayer")), "usé <token> ayer");
        assert_eq!(san("Authorization: Bearer abc.def"), "Authorization: Bearer <token>");
        assert_eq!(san("password=hunter2 usuario=ana"), "password=<token> usuario=ana");
        assert_eq!(san("{\"apiKey\":\"abc123\"}"), "{\"apiKey\":\"<token>\"}");
        assert_eq!(san("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc"), "<token>");
        assert_eq!(san("el token venció"), "el token venció");
    }

    #[test]
    fn saneo_de_cuentas_ids_hex_y_claves() {
        let cuentas = vec!["abcd1234".to_string(), "xy".to_string()];
        let c = ctx(&cuentas);
        assert_eq!(sanitizar("C:\\sloth\\accounts\\zzz\\x y abcd1234 xy", &c), "C:\\sloth\\accounts\\<cuenta>\\x y <cuenta> xy");
        assert_eq!(san("id 123e4567-e89b-12d3-a456-426614174000 fin"), "id <id> fin");
        assert_eq!(san(&format!("sha {} fin", "ab12".repeat(10))), "sha <hex> fin");
        assert_eq!(san("clave Zq8Xw7Ee6Rr5Tt4Yy3Uu2Ii1Oo0Pp9Aa8Ss7Dd6Ff5G fin"), "clave <clave> fin");
        assert_eq!(san("ruta a/muy/larga/pero/sin/digitos/ni/mayusculas/nada/de/nada/mas"), "ruta a/muy/larga/pero/sin/digitos/ni/mayusculas/nada/de/nada/mas");
    }

    #[test]
    fn saneo_de_usuario_pc_e_ips() {
        assert_eq!(san("hola maria, ventana, MAQUINA-7"), "hola <usuario>, ventana, <pc>");
        assert_eq!(san("mariana"), "mariana");
        assert_eq!(san("conectó 192.168.1.20 y 127.0.0.1 y 1.2.3.4.5"), "conectó <ip> y 127.0.0.1 y 1.2.3.4.5");
    }

    fn form() -> Formulario {
        Formulario { tipo: TipoReporte::Error, title: "Se rompe al abrir".into(), what: " pasó algo ".into(), expect: String::new(), steps: vec!["abrir".into(), "  ".into(), "cerrar".into()] }
    }

    #[test]
    fn el_cuerpo_lleva_las_secciones() {
        let sys = lineas_de_sistema(&DatosSistema { sloth: "0.8.1", windows: "10", arch: "x64", electron: "33", daemon: "daemon 1", accounts: 2, workspaces: 3 });
        assert_eq!(sys[1], "Windows 10 · x64");
        let cuerpo = armar_cuerpo(&form(), Some(&sys), Some(&["a".into(), "b".into()]));
        assert_eq!(
            cuerpo,
            "**Tipo:** Error\n\n## Qué pasó\npasó algo\n\n## Qué esperaba\n(sin completar)\n\n## Pasos para reproducirlo\n1. abrir\n2. cerrar\n\n## Sistema\n- Sloth 0.8.1\n- Windows 10 · x64\n- Electron 33\n- Daemon: daemon 1\n- Cuentas: 2 · Espacios: 3\n\n## Registro (últimos 30 minutos)\n```\na\nb\n```\n"
        );
        let vacio = armar_cuerpo(&Formulario { steps: vec![], ..form() }, None, Some(&[]));
        assert!(vacio.contains("(sin pasos)") && vacio.ends_with("(sin registros recientes)\n") && !vacio.contains("## Sistema"));
    }

    #[test]
    fn ajustar_recorta_solo_las_lineas_mas_viejas_del_registro() {
        let logs: Vec<String> = (0..50).map(|i| format!("linea numero {i:02} con relleno")).collect();
        let cuerpo = armar_cuerpo(&form(), None, Some(&logs));
        assert_eq!(ajustar_cuerpo(&cuerpo, 10_000).as_deref(), Some(cuerpo.as_str()));
        let justo = ajustar_cuerpo(&cuerpo, 600).unwrap();
        assert!(utf16(&justo) <= 600 && justo.contains("pasó algo") && justo.contains("linea numero 49") && !justo.contains("linea numero 00"));
        assert!(justo.ends_with("\n```\n"));
        assert_eq!(ajustar_cuerpo(&cuerpo, 100), None);
        assert_eq!(ajustar_cuerpo(&armar_cuerpo(&form(), None, None), 10), None);
    }

    #[test]
    fn la_url_codifica_y_solo_se_acepta_la_propia() {
        assert_eq!(codificar_componente("a b&ñ/(1)!*'~"), "a%20b%26%C3%B1%2F(1)!*'~");
        let u = url_del_issue("t í", "b\n");
        assert_eq!(u, "https://github.com/Toomasmg/sloth/issues/new?title=t%20%C3%AD&body=b%0A");
        assert!(es_url_del_issue(&json!(u)));
        assert!(!es_url_del_issue(&json!("https://evil.test/?https://github.com/Toomasmg/sloth/issues/new?")));
        assert!(!es_url_del_issue(&json!("https://github.com/Toomasmg/sloth/issues/new")));
        assert!(!es_url_del_issue(&json!(5)));
        assert!(!es_url_del_issue(&json!(format!("{REPORT_ISSUE_URL}?{}", "a".repeat(URL_MAX)))));
    }

    #[test]
    fn lineas_recientes_sigue_la_marca_de_cada_bloque() {
        let ahora = marca_de_linea("2026-11-27T12:00:00.000Z ").unwrap();
        let l: Vec<String> = [
            "2026-11-27T11:00:00.000Z vieja",
            "  sigue la vieja",
            "2026-11-27T11:45:00.5Z nueva",
            "  sigue la nueva",
            "2026-13-45T11:50:00Z imposible",
            "  de la imposible",
            "2026-11-27T11:59:59Z\tcon tab",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(lineas_recientes(&l, ahora, 30.0, 40), vec![l[2].clone(), l[3].clone(), l[6].clone()]);
        assert_eq!(lineas_recientes(&l, ahora, 30.0, 1), vec![l[6].clone()]);
        assert_eq!(marca_de_linea("sin marca"), None);
        assert_eq!(marca_de_linea("2026-11-27T11:00:00Zx"), None);
        assert_eq!(marca_de_linea("1970-01-01T00:00:01.250Z a"), Some(1250.0));
    }

    #[test]
    fn la_cola_del_log_lee_desde_el_final() {
        let d = std::env::temp_dir().join(format!("sloth-report-rs-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("daemon.log");
        let texto: String = (0..2000).map(|i| format!("linea {i}\r\n")).collect();
        std::fs::write(&f, &texto).unwrap();
        let cola = leer_cola_del_log(&f, 5, LOG_MAX_BYTES);
        assert_eq!(cola, ["linea 1995", "linea 1996", "linea 1997", "linea 1998", "linea 1999"]);
        std::fs::write(&f, "uno\ndos\n").unwrap();
        assert_eq!(leer_cola_del_log(&f, 400, LOG_MAX_BYTES), ["uno", "dos"]);
        assert!(leer_cola_del_log(&d.join("no-existe"), 5, 100).is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn el_envio_se_valida_en_orden() {
        let ok = json!({ "type": "idea", "title": "  un título largo  ", "steps": ["a"], "what": null, "sys": true, "shot": 1 });
        let e = validar_envio(&ok).unwrap();
        assert_eq!((e.form.tipo, e.form.title.as_str(), e.form.what.as_str()), (TipoReporte::Idea, "un título largo", ""));
        assert_eq!((e.con_sistema, e.con_registro, e.con_captura), (true, false, false));
        let falla = |v: Value| validar_envio(&v).unwrap_err();
        assert_eq!(falla(json!("x")), "Elegí el tipo de reporte.");
        assert_eq!(falla(json!({ "type": "error", "title": 3 })), "Dato inválido: Título.");
        assert_eq!(falla(json!({ "type": "error", "title": "corto", "steps": [] })), "El título tiene que tener al menos 8 caracteres.");
        assert_eq!(falla(json!({ "type": "error", "title": "a".repeat(201), "steps": [] })), "«Título» es demasiado largo (máximo 200 caracteres).");
        assert_eq!(falla(json!({ "type": "error", "title": "un título largo", "steps": "a" })), "Pasos inválidos.");
        assert_eq!(falla(json!({ "type": "error", "title": "un título largo", "steps": vec!["a"; 9] })), "Pasos inválidos.");
        assert_eq!(falla(json!({ "type": "error", "title": "un título largo", "steps": [4] })), "Dato inválido: Paso.");
        assert_eq!(falla(json!({ "type": "error", "title": "un título largo", "steps": [], "what": "a".repeat(1501) })), "«¿Qué pasó?» es demasiado largo (máximo 1500 caracteres).");
        assert_eq!(falla(json!({ "type": "error", "title": "un título largo", "steps": [], "expect": 1 })), "Dato inválido: ¿Qué esperabas?.");
    }

    #[test]
    fn armar_url_sanea_y_respeta_los_topes() {
        let f = Formulario { what: "mi carpeta C:\\Users\\Maria\\x".into(), ..form() };
        let url = armar_url(&f, None, None, &ctx(&[])).unwrap();
        assert!(url.starts_with(REPORT_ISSUE_URL) && !url.contains("Maria"));
        assert!(url.contains("title=%5BError%5D%20Se%20rompe%20al%20abrir"));
        let grande = Formulario { what: "ñ".repeat(1500), expect: "ñ".repeat(800), ..form() };
        assert_eq!(armar_url(&grande, None, None, &ctx(&[])).unwrap_err(), "El texto es demasiado largo para abrirlo en GitHub: recortalo un poco.");
        let largo = Formulario { title: "xy ".repeat(65), ..form() };
        assert_eq!(armar_url(&largo, None, None, &ctx(&[])).unwrap_err(), "El título tiene que tener como máximo 200 caracteres.");
    }
}
