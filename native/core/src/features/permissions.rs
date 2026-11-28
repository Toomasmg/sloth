//! Pedidos de permiso: tipos, reglas «Permitir siempre», clasificación de comandos destructivos, decisión para el
//! daemon y cuándo avisar. Equivale a src/shared/permissions-core.ts. Es una ayuda para la persona, no un control:
//! un comando que no figura como destructivo no es por eso seguro.
use crate::perfiles_core::es_blanco_js;
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tipo {
    Cmd,
    Edit,
    Net,
    Other,
}

impl Tipo {
    pub fn desde_texto(t: &str) -> Option<Self> {
        Some(match t {
            "cmd" => Self::Cmd,
            "edit" => Self::Edit,
            "net" => Self::Net,
            "other" => Self::Other,
            _ => return None,
        })
    }
}

/// Lo que elige la persona. `Terminal` deja que Claude pregunte en la terminal, como antes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Eleccion {
    Allow,
    AllowAlways,
    Deny,
    Terminal,
}

pub type Entrada = Map<String, Value>;

/// Forma mínima de un pedido (la de PendingPermission del daemon).
#[derive(Debug, Clone)]
pub struct Pedido {
    pub id: String,
    pub ws: String,
    pub tool: String,
    pub input: Entrada,
    pub at: f64,
    pub expires_at: f64,
}

/// Regla «Permitir siempre» de un espacio. Coincide solo con pedidos iguales (no por prefijo).
#[derive(Debug, Clone, PartialEq)]
pub struct Regla {
    pub id: String,
    pub workspace_id: String,
    pub kind: Tipo,
    pub tool: String,
    /// cmd: comando exacto, net: dominio, edit/other: «*».
    pub match_: String,
    pub label: String,
    pub on: bool,
    pub created_at: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BorradorRegla {
    pub kind: Tipo,
    pub tool: String,
    pub match_: String,
    pub label: String,
}

pub const FILE_EDIT_TOOLS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
pub const NET_TOOLS: [&str; 2] = ["WebFetch", "WebSearch"];
pub const MAX_RULE_MATCH: usize = 2000;

fn utf16(s: &str) -> usize {
    s.encode_utf16().count()
}

pub fn texto(v: Option<&Value>) -> Option<String> {
    let t = v?.as_str()?.trim_matches(es_blanco_js);
    (!t.is_empty()).then(|| t.to_string())
}

pub fn tipo_de(tool: &str) -> Tipo {
    if tool == "Bash" {
        Tipo::Cmd
    } else if FILE_EDIT_TOOLS.contains(&tool) {
        Tipo::Edit
    } else if NET_TOOLS.contains(&tool) {
        Tipo::Net
    } else {
        Tipo::Other
    }
}

/// Dominio (host) de un WebFetch como lo da `new URL(url).host`: minúsculas, sin el puerto por defecto; '' si no se puede leer.
pub fn host_de(input: &Entrada) -> String {
    let Some(url) = texto(input.get("url")) else { return String::new() };
    let Some((esquema, resto)) = url.split_once(':') else { return String::new() };
    if esquema.is_empty() || !esquema.starts_with(|c: char| c.is_ascii_alphabetic()) || !esquema.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')) {
        return String::new();
    }
    let esquema = esquema.to_ascii_lowercase();
    let especial = matches!(esquema.as_str(), "http" | "https" | "ws" | "wss" | "ftp" | "file");
    let sin_barras = resto.trim_start_matches(if especial { &['/', '\\'][..] } else { &['/'][..] });
    if !especial && resto.len() - sin_barras.len() < 2 {
        return String::new();
    }
    let autoridad = sin_barras.split(['/', '\\', '?', '#']).next().unwrap_or("");
    let autoridad = autoridad.rsplit_once('@').map_or(autoridad, |(_, h)| h);
    let (host, puerto) = if let Some(fin) = autoridad.strip_prefix('[').and_then(|a| a.find(']')) {
        (&autoridad[..fin + 2], autoridad[fin + 2..].strip_prefix(':'))
    } else {
        match autoridad.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (autoridad, None),
        }
    };
    if host.is_empty() && esquema != "file" {
        return String::new();
    }
    let por_defecto = match esquema.as_str() {
        "http" | "ws" => "80",
        "https" | "wss" => "443",
        "ftp" => "21",
        _ => "",
    };
    let mut salida = host.to_lowercase();
    if let Some(p) = puerto {
        if !p.bytes().all(|b| b.is_ascii_digit()) {
            return String::new();
        }
        let p = p.trim_start_matches('0');
        if !p.is_empty() && p != por_defecto {
            salida = format!("{salida}:{p}");
        } else if p.is_empty() && por_defecto != "0" && !por_defecto.is_empty() {
            salida = format!("{salida}:0");
        }
    }
    salida
}

/// Archivos que toca un pedido de edición.
pub fn archivos_de(input: &Entrada) -> Vec<String> {
    texto(input.get("file_path")).or_else(|| texto(input.get("notebook_path"))).into_iter().collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct LineaDiff {
    pub mas: bool,
    pub texto: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CambioArchivo {
    pub path: String,
    pub add: usize,
    pub del: usize,
    pub is_new: bool,
    pub lines: Vec<LineaDiff>,
}

fn lineas_de(v: Option<&Value>) -> Vec<String> {
    match v.and_then(Value::as_str) {
        Some(s) if !s.is_empty() => s.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).collect(),
        _ => vec![],
    }
}

fn nulo_a_none(v: Option<&Value>) -> Option<&Value> {
    v.filter(|x| !x.is_null())
}

/// Cambios que trae el pedido, tal como los manda el hook. Si el hook no los trae, la lista queda vacía: no se inventa un diff.
pub fn cambios_de(tool: &str, input: &Entrada) -> Vec<CambioArchivo> {
    let path = archivos_de(input).into_iter().next().unwrap_or_default();
    let armar = |pares: Vec<(Option<&Value>, Option<&Value>)>| {
        let mut lines = vec![];
        for (viejo, nuevo) in pares {
            lines.extend(lineas_de(viejo).into_iter().map(|texto| LineaDiff { mas: false, texto }));
            lines.extend(lineas_de(nuevo).into_iter().map(|texto| LineaDiff { mas: true, texto }));
        }
        let add = lines.iter().filter(|l| l.mas).count();
        CambioArchivo { path: path.clone(), add, del: lines.len() - add, is_new: false, lines }
    };
    match tool {
        "Edit" | "NotebookEdit" if !path.is_empty() => vec![armar(vec![(input.get("old_string"), nulo_a_none(input.get("new_string")).or(input.get("new_source")))])],
        "MultiEdit" => {
            let pares: Vec<_> = input.get("edits").and_then(Value::as_array).map(|e| e.iter().map(|x| (x.get("old_string"), x.get("new_string"))).collect()).unwrap_or_default();
            if path.is_empty() || pares.is_empty() { vec![] } else { vec![armar(pares)] }
        }
        "Write" if !path.is_empty() => vec![armar(vec![(None, input.get("content"))])],
        _ => vec![],
    }
}

pub fn explicacion_de(input: &Entrada) -> Option<String> {
    texto(input.get("description"))
}

/// Nombre corto de una herramienta: en MCP, la herramienta sin el prefijo `mcp__servidor__`.
pub fn nombre_corto(tool: &str) -> String {
    let Some(resto) = tool.strip_prefix("mcp__") else { return tool.to_string() };
    match resto.find("__") {
        None => resto.to_string(),
        Some(i) => {
            let cola = &resto[i + 2..];
            if cola.is_empty() { resto[..i].to_string() } else { cola.to_string() }
        }
    }
}

pub fn titulo_de(kind: Tipo, tool: &str, input: &Entrada) -> String {
    match kind {
        Tipo::Cmd => "Claude quiere ejecutar un comando".into(),
        Tipo::Edit => match archivos_de(input).len().max(1) {
            1 => "Claude quiere editar un archivo".into(),
            n => format!("Claude quiere editar {n} archivos"),
        },
        Tipo::Net => "Claude quiere acceder a internet".into(),
        Tipo::Other => format!("Claude quiere usar {}", nombre_corto(tool)),
    }
}

/// Texto corto del pedido (para listas, avisos e historial).
pub fn etiqueta_de(kind: Tipo, tool: &str, input: &Entrada) -> String {
    match kind {
        Tipo::Cmd => texto(input.get("command")).unwrap_or_else(|| "comando".into()),
        Tipo::Edit => match archivos_de(input).as_slice() {
            [f] => format!("Editar {f}"),
            _ => "Editar archivos".into(),
        },
        Tipo::Net => match host_de(input) {
            h if h.is_empty() => "Acceder a internet".into(),
            h => format!("Acceder a {h}"),
        },
        Tipo::Other => nombre_corto(tool),
    }
}

/// `\p{Cc}`, `\p{Cf}`, `\p{Zl}` y `\p{Zp}`: hacen que el aviso muestre algo distinto de lo que corre.
fn es_invisible(c: char) -> bool {
    c.is_control()
        || matches!(c as u32,
            0xAD | 0x600..=0x605 | 0x61C | 0x6DD | 0x70F | 0x890..=0x891 | 0x8E2 | 0x180E | 0x200B..=0x200F | 0x2028..=0x202E | 0x2060..=0x2064
            | 0x2066..=0x206F | 0xFEFF | 0xFFF9..=0xFFFB | 0x110BD | 0x110CD | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3 | 0x1D173..=0x1D17A | 0xE0001 | 0xE0020..=0xE007F)
}

/// El aviso de Windows corta el texto: «Permitir» ahí solo es honesto si lo que se aprueba se ve entero. Solo un comando corto lo cumple.
pub fn permitir_desde_aviso(kind: Tipo, input: &Entrada) -> bool {
    if kind != Tipo::Cmd {
        return false;
    }
    texto(input.get("command")).is_some_and(|c| utf16(&c) <= 80 && !c.chars().any(es_invisible) && destructivo_de(kind, input).is_none())
}

const CLIENTES_SQL: [&str; 8] = ["psql", "sqlite3", "mysql", "mariadb", "sqlcmd", "sqlplus", "usql", "duckdb"];
const OTROS_COMANDOS: [&str; 9] = ["rm", "del", "erase", "rd", "rmdir", "remove-item", "ri", "git", "dd"];
const ENVOLTORIOS: [&str; 10] = ["sudo", "doas", "env", "nohup", "time", "xargs", "exec", "command", "builtin", "nice"];
const GIT_CON_VALOR: [&str; 5] = ["-C", "-c", "--git-dir", "--work-tree", "--namespace"];

fn es_comando_conocido(p: &str) -> bool {
    OTROS_COMANDOS.contains(&p) || matches!(p, "chmod" | "chown") || CLIENTES_SQL.contains(&p)
}

fn limpiar(t: &str) -> &str {
    t.trim_start_matches(['"', '\'', '{']).trim_end_matches(['"', '\'', '}'])
}

fn comando_de(t: &str) -> String {
    let s = limpiar(t);
    let base = s.rsplit(['/', '\\']).next().unwrap_or(s).to_lowercase();
    for ext in [".exe", ".cmd", ".bat"] {
        if let Some(b) = base.strip_suffix(ext) {
            return b.to_string();
        }
    }
    base
}

/// Opción corta (-rf, -D…) que trae alguna de esas letras.
fn con_letra(t: &str, letras: &str) -> bool {
    t.len() > 1 && t.starts_with('-') && t[1..].bytes().all(|b| b.is_ascii_alphabetic()) && letras.chars().any(|l| t.contains(l))
}

fn es_recursivo_ps(t: &str) -> bool {
    let l = t.to_ascii_lowercase();
    let Some(resto) = l.strip_prefix("-r") else { return false };
    let prefijo = resto.split(':').next().unwrap_or("");
    "ecurse".starts_with(prefijo) && (resto.len() == prefijo.len() || resto[prefijo.len()..].starts_with(':'))
}

fn es_barra_s(t: &str) -> bool {
    fn desde(s: &[u8]) -> bool {
        (s.first() == Some(&b's') && (s.len() == 1 || s[1] == b'/')) || (s.len() >= 2 && s[0].is_ascii_lowercase() && s[1] == b'/' && desde(&s[2..]))
    }
    let l = t.to_ascii_lowercase();
    l.starts_with('/') && desde(&l.as_bytes()[1..])
}

fn subcomando_git(args: &[String]) -> Option<(&str, &[String])> {
    let mut i = 0;
    while i < args.len() && args[i].starts_with('-') {
        i += if GIT_CON_VALOR.contains(&args[i].as_str()) { 2 } else { 1 };
    }
    args.get(i).map(|s| (s.as_str(), &args[i + 1..]))
}

fn es_push_destructivo(t: &str) -> bool {
    if let Some(r) = t.strip_prefix("--") {
        let fuerza = r.strip_prefix("force").is_some_and(|c| {
            let c = c.strip_prefix("-with-lease").or_else(|| c.strip_prefix("-if-includes")).unwrap_or(c);
            c.is_empty() || c.starts_with('=')
        });
        if fuerza || r == "delete" || r == "mirror" {
            return true;
        }
    }
    con_letra(t, "fd") || (t.starts_with(['+', ':']) && t.chars().nth(1).is_some_and(|c| !es_blanco_js(c)))
}

fn motivo_de_git(args: &[String]) -> Option<&'static str> {
    let (sub, r) = subcomando_git(args)?;
    let tiene = |x: &str| r.iter().any(|t| t == x);
    let alguno = |f: &dyn Fn(&str) -> bool| r.iter().any(|t| f(t));
    if sub == "push" && alguno(&es_push_destructivo) {
        return Some("pisa o borra cosas del remoto");
    }
    if sub == "reset" && tiene("--hard") {
        return Some("descarta cambios sin commitear");
    }
    if (sub == "restore" || sub == "checkout") && tiene(".") && !(tiene("--staged") && !tiene("--worktree")) {
        return Some("descarta cambios sin commitear");
    }
    if sub == "clean" && alguno(&|t| t == "--force" || con_letra(t, "f")) && !alguno(&|t| t == "--dry-run" || con_letra(t, "n")) {
        return Some("borra archivos sin seguimiento");
    }
    if sub == "branch" && alguno(&|t| con_letra(t, "D")) {
        return Some("borra una rama sin chequear");
    }
    if sub == "stash" && matches!(r.first().map(String::as_str), Some("drop" | "clear")) {
        return Some("descarta cambios guardados");
    }
    None
}

fn motivo_de_comando(cmd: &str, args: &[String]) -> Option<&'static str> {
    let alguno = |f: &dyn Fn(&str) -> bool| args.iter().any(|t| f(t));
    match cmd {
        "rm" => alguno(&|t| con_letra(t, "rR") || t == "--recursive" || es_recursivo_ps(t)).then_some("borra carpetas enteras"),
        "del" | "erase" => alguno(&|t| es_barra_s(t) || es_recursivo_ps(t)).then_some("borra archivos de forma recursiva"),
        "rd" | "rmdir" | "remove-item" | "ri" => alguno(&|t| es_barra_s(t) || es_recursivo_ps(t)).then_some("borra carpetas enteras"),
        "git" => motivo_de_git(args),
        "dd" => alguno(&|t| t.starts_with("of=/dev/") && t != "of=/dev/null").then_some("escribe sobre un dispositivo"),
        "chmod" | "chown" => alguno(&|t| con_letra(t, "R") || t == "--recursive").then_some("cambia permisos de forma recursiva"),
        _ => None,
    }
}

fn es_palabra(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// `\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b` sin distinguir mayúsculas.
fn tiene_sql_destructivo(c: &str) -> bool {
    let l = c.to_ascii_lowercase();
    let b = l.as_bytes();
    let tras_blancos = |desde: usize| -> usize { l[desde..].chars().take_while(|ch| es_blanco_js(*ch)).map(char::len_utf8).sum() };
    for (inicio, clave, nexos) in [("drop", 4, &["table", "database", "schema"][..]), ("truncate", 8, &["table"][..])] {
        for (i, _) in l.match_indices(inicio) {
            if i > 0 && es_palabra(b[i - 1]) {
                continue;
            }
            let ws = tras_blancos(i + clave);
            if ws == 0 {
                continue;
            }
            let resto = &l[i + clave + ws..];
            if nexos.iter().any(|n| resto.starts_with(n) && resto.as_bytes().get(n.len()).map_or(true, |x| !es_palabra(*x))) {
                return true;
            }
        }
    }
    false
}

fn es_mkfs(p: &str) -> bool {
    p.strip_prefix("mkfs").is_some_and(|r| r.is_empty() || r.strip_prefix('.').is_some_and(|x| !x.is_empty() && x.bytes().all(es_palabra)))
}

fn es_asignacion(t: &str) -> bool {
    t.split_once('=').is_some_and(|(n, _)| n.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') && n.bytes().all(es_palabra))
}

/// Por qué un comando se marca «Destructivo» (None si no). Costo lineal: une las continuaciones de línea, parte en
/// tramos por `;`, `&`, `|` y saltos, y en cada tramo mira solo las palabras de la lista de comandos conocidos, con
/// sus argumentos hasta el siguiente. Un falso positivo (el texto aparece en un echo) es el lado seguro del error.
pub fn destructivo_de(kind: Tipo, input: &Entrada) -> Option<&'static str> {
    if kind != Tipo::Cmd {
        return None;
    }
    let c = texto(input.get("command"))?;
    let c = unir_continuaciones(&c).replace("${IFS}", " ").replace("$IFS", " ");
    let mut hay_cliente_sql = false;
    for tramo in c.split(|ch: char| matches!(ch, ';' | '&' | '|' | '\n' | '\r' | '`' | '(' | ')')) {
        let toks: Vec<&str> = tramo.split(es_blanco_js).filter(|t| !t.is_empty()).collect();
        let palabras: Vec<String> = toks.iter().map(|t| comando_de(t)).collect();
        let inicio = palabras.iter().enumerate().position(|(i, p)| !ENVOLTORIOS.contains(&p.as_str()) && !toks[i].starts_with('-') && !es_asignacion(toks[i]));
        let marcas: Vec<usize> = palabras.iter().enumerate().filter(|(i, p)| es_comando_conocido(p) || (Some(*i) == inicio && es_mkfs(p))).map(|(i, _)| i).collect();
        for (k, &i) in marcas.iter().enumerate() {
            let p = palabras[i].as_str();
            if CLIENTES_SQL.contains(&p) {
                hay_cliente_sql = true;
            }
            if Some(i) == inicio && p.starts_with("mkfs") {
                return Some("formatea un disco");
            }
            let fin = marcas.get(k + 1).copied().unwrap_or(toks.len());
            let args: Vec<String> = toks[i + 1..fin].iter().map(|t| limpiar(t).to_string()).collect();
            if let Some(m) = motivo_de_comando(p, &args) {
                return Some(m);
            }
        }
    }
    (hay_cliente_sql && tiene_sql_destructivo(&c)).then_some("borra datos de una base")
}

/// `\\\r?\n` y `` `\r?\n `` pasan a un espacio.
fn unir_continuaciones(c: &str) -> String {
    let mut out = String::with_capacity(c.len());
    let b: Vec<char> = c.chars().collect();
    let mut i = 0;
    while i < b.len() {
        if b[i] == '\\' || b[i] == '`' {
            let j = if b.get(i + 1) == Some(&'\r') { i + 2 } else { i + 1 };
            if b.get(j) == Some(&'\n') {
                out.push(' ');
                i = j + 1;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

pub fn etiqueta_siempre(kind: Tipo) -> &'static str {
    match kind {
        Tipo::Edit => "Permitir siempre ediciones en este repo",
        Tipo::Net => "Permitir siempre este dominio aquí",
        _ => "Permitir siempre aquí",
    }
}

/// «Permitir siempre» sobre un comando destructivo se degrada a «una vez»: nunca queda una regla que lo apruebe solo.
pub fn respuesta_efectiva(e: Eleccion, req: &Pedido) -> Eleccion {
    if e == Eleccion::AllowAlways && destructivo_de(tipo_de(&req.tool), &req.input).is_some() {
        Eleccion::Allow
    } else {
        e
    }
}

/// Regla que se guarda al elegir «Permitir siempre» para este pedido.
pub fn regla_para(req: &Pedido) -> (String, Tipo, String, String, String) {
    let kind = tipo_de(&req.tool);
    let label = etiqueta_de(kind, &req.tool, &req.input);
    let m = match kind {
        Tipo::Cmd => texto(req.input.get("command")).unwrap_or_default(),
        Tipo::Net => host_de(&req.input),
        _ => "*".into(),
    };
    (req.ws.clone(), kind, req.tool.clone(), m, label)
}

pub fn regla_desde_pedido(req: &Pedido, id: &str, created_at: f64) -> Regla {
    let (workspace_id, kind, tool, match_, label) = regla_para(req);
    Regla { id: id.into(), workspace_id, kind, tool, match_, label, on: true, created_at }
}

// Carpetas del repo donde un archivo escrito termina ejecutándose solo (hooks de git, de Claude, tareas del editor, contenedores, CI).
const CARPETAS_SENSIBLES: [&str; 9] = [".git", ".claude", ".vscode", ".husky", ".githooks", ".idea", ".devcontainer", ".github", ".sloth"];

/// Forma de un nombre corto 8.3 («git~1», «vscode~1», «claude~1.jso»); «informe~2.docx» no.
fn es_nombre_corto(s: &str) -> bool {
    let (nombre, ext) = match s.split_once('.') {
        Some((n, e)) if !e.contains('.') => (n, Some(e)),
        Some(_) => return false,
        None => (s, None),
    };
    if ext.is_some_and(|e| utf16(e) > 3) {
        return false;
    }
    nombre.match_indices('~').any(|(p, _)| {
        let (pre, dig) = (&nombre[..p], &nombre[p + 1..]);
        (1..=6).contains(&utf16(pre)) && !dig.is_empty() && dig.bytes().all(|b| b.is_ascii_digit())
    })
}

/// Segmentos de una ruta absoluta, con «.» y «..» resueltos; None si no es absoluta o sale de la raíz.
fn segmentos(ruta: &str) -> Option<Vec<String>> {
    let norm = ruta.replace('\\', "/");
    let mut partes = norm.split('/');
    let raiz = partes.next()?;
    let es_unidad = raiz.len() == 2 && raiz.as_bytes()[0].is_ascii_alphabetic() && raiz.as_bytes()[1] == b':';
    if !raiz.is_empty() && !es_unidad {
        return None;
    }
    let mut out = vec![raiz.to_lowercase()];
    for p in partes {
        if p.is_empty() || p == "." {
            continue;
        }
        if p == ".." {
            if out.len() == 1 {
                return None;
            }
            out.pop();
        } else {
            // Windows ignora los puntos y espacios finales: «.git.» y «.git » son .git.
            out.push(p.to_lowercase().trim_end_matches(['.', ' ']).to_string());
        }
    }
    Some(out)
}

/// ¿El archivo cae dentro de la carpeta del espacio y fuera de sus carpetas sensibles? Es lo único que cubre
/// «Permitir siempre ediciones».
pub fn dentro_del_repo(archivo: &str, cwd: &str) -> bool {
    let Some(base) = segmentos(cwd) else { return false };
    let b = archivo.as_bytes();
    let absoluta = matches!(b.first(), Some(b'/' | b'\\')) || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'/' | b'\\'));
    let Some(ruta) = segmentos(&if absoluta { archivo.to_string() } else { format!("{cwd}/{archivo}") }) else { return false };
    if ruta.len() <= base.len() || base.iter().zip(&ruta).any(|(a, b)| a != b) {
        return false;
    }
    // «:» abre un flujo alterno de NTFS y un nombre corto («git~1», «vscode~1») puede ser una carpeta sensible.
    ruta[base.len()..].iter().all(|s| !s.is_empty() && !CARPETAS_SENSIBLES.contains(&s.as_str()) && !s.contains(':') && !es_nombre_corto(s))
}

/// ¿La regla cubre este pedido? Mismo espacio, mismo tipo y, según el tipo, mismo comando o dominio. Las ediciones
/// además necesitan `cwd`: fuera de ella vuelve a preguntar.
pub fn regla_coincide(regla: &Regla, req: &Pedido, cwd: Option<&str>, dentro: &dyn Fn(&str, &str) -> bool) -> bool {
    if !regla.on || regla.workspace_id != req.ws {
        return false;
    }
    let kind = tipo_de(&req.tool);
    if regla.kind != kind {
        return false;
    }
    match kind {
        Tipo::Cmd => !regla.match_.is_empty() && texto(req.input.get("command")).unwrap_or_default() == regla.match_ && destructivo_de(kind, &req.input).is_none(),
        Tipo::Net => !regla.match_.is_empty() && host_de(&req.input) == regla.match_,
        Tipo::Edit => {
            let Some(cwd) = cwd.filter(|c| !c.is_empty()) else { return false };
            let archivos = archivos_de(&req.input);
            FILE_EDIT_TOOLS.contains(&req.tool.as_str()) && regla.match_ == "*" && !archivos.is_empty() && archivos.iter().all(|f| dentro(f, cwd))
        }
        Tipo::Other => regla.tool == req.tool,
    }
}

pub fn buscar_regla<'a>(reglas: &'a [Regla], req: &Pedido, cwd: Option<&str>, dentro: &dyn Fn(&str, &str) -> bool) -> Option<&'a Regla> {
    reglas.iter().find(|r| regla_coincide(r, req, cwd, dentro))
}

fn es_host(h: &str) -> bool {
    if h.is_empty() || utf16(h) > 253 {
        return false;
    }
    let (nombre, puerto) = match h.rsplit_once(':') {
        Some((n, p)) => (n, Some(p)),
        None => (h, None),
    };
    if puerto.is_some_and(|p| p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit())) {
        return false;
    }
    nombre.split('.').all(|l| {
        let b = l.as_bytes();
        let ok = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
        !b.is_empty() && ok(b[0]) && ok(b[b.len() - 1]) && b.iter().all(|c| ok(*c) || *c == b'-')
    })
}

fn es_nombre_de_herramienta(t: &str) -> bool {
    let mut c = t.chars();
    utf16(t) <= 120 && c.next().is_some_and(|p| p.is_ascii_alphabetic()) && c.all(|x| x.is_ascii_alphanumeric() || matches!(x, '_' | '.' | ':' | '-'))
}

/// Valida una regla que llega de afuera (archivo importado, pedido de la interfaz). Es la misma forma que guarda
/// «Permitir siempre»: el tipo sale de la herramienta, el texto es exacto y nunca hay comodines, salvo «*» en ediciones y herramientas completas.
pub fn revisar_regla(raw: &Value) -> Result<BorradorRegla, String> {
    let o = raw.as_object().ok_or("formato inválido")?;
    let kind = o.get("kind").and_then(Value::as_str).and_then(Tipo::desde_texto).ok_or("tipo de regla desconocido")?;
    let tool = o.get("tool").and_then(Value::as_str).unwrap_or("").trim_matches(es_blanco_js);
    let m = o.get("match").and_then(Value::as_str).unwrap_or("").trim_matches(es_blanco_js);
    if !es_nombre_de_herramienta(tool) {
        return Err("nombre de herramienta inválido".into());
    }
    if tipo_de(tool) != kind {
        return Err("el tipo no corresponde a la herramienta".into());
    }
    let borrador = |match_: &str, label: String| BorradorRegla { kind, tool: tool.to_string(), match_: match_.to_string(), label };
    match kind {
        Tipo::Cmd => {
            if m.is_empty() {
                return Err("falta el comando".into());
            }
            if utf16(m) > MAX_RULE_MATCH || m.chars().any(|c| matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}')) {
                return Err("comando demasiado largo o con caracteres de control".into());
            }
            if m.contains('*') {
                return Err("Sloth solo guarda comandos exactos, sin comodines".into());
            }
            let mut input = Entrada::new();
            input.insert("command".into(), json!(m));
            if destructivo_de(Tipo::Cmd, &input).is_some() {
                return Err("un comando destructivo solo se permite una vez".into());
            }
            Ok(borrador(m, m.to_string()))
        }
        Tipo::Net => {
            if !NET_TOOLS.contains(&tool) {
                return Err("herramienta de red no válida".into());
            }
            let host = m.to_lowercase();
            if !es_host(&host) {
                return Err("el dominio no es válido".into());
            }
            Ok(borrador(&host, format!("Acceder a {host}")))
        }
        Tipo::Edit => {
            if !FILE_EDIT_TOOLS.contains(&tool) || m != "*" {
                return Err("regla de edición no válida".into());
            }
            Ok(borrador("*", "Editar archivos".into()))
        }
        Tipo::Other => {
            if m != "*" {
                return Err("Sloth solo guarda herramientas completas, sin patrón".into());
            }
            Ok(borrador("*", nombre_corto(tool)))
        }
    }
}

/// Decisión para el daemon (lo que espera el hook de PermissionRequest). `AllowAlways` se resuelve como una aprobación:
/// la regla de Sloth la guarda main aparte, por espacio.
pub fn decision_para(e: Eleccion, mensaje: Option<&str>) -> Option<Value> {
    match e {
        Eleccion::Allow | Eleccion::AllowAlways => Some(json!({ "behavior": "allow" })),
        Eleccion::Deny => {
            let m = mensaje.unwrap_or("").trim_matches(es_blanco_js);
            Some(json!({ "behavior": "deny", "message": if m.is_empty() { "Rechazado desde Sloth." } else { m } }))
        }
        Eleccion::Terminal => None,
    }
}

/// Avisos de Windows: no se avisa con «No molestar» ni si la ventana está en ese espacio.
pub fn debe_avisar(dnd: bool, ventana_enfocada: bool, espacio_enfocado: Option<&str>, ws_id: &str) -> bool {
    !dnd && !(ventana_enfocada && espacio_enfocado == Some(ws_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CWD: &str = "C:\\dev\\repo";

    fn entrada(v: Value) -> Entrada {
        v.as_object().cloned().unwrap_or_default()
    }

    fn pedido(tool: &str, input: Value) -> Pedido {
        Pedido { id: "p1".into(), ws: "w1".into(), tool: tool.into(), input: entrada(input), at: 0.0, expires_at: 0.0 }
    }

    fn regla(req: &Pedido) -> Regla {
        regla_desde_pedido(req, "r1", 0.0)
    }

    fn dentro(a: &str, c: &str) -> bool {
        dentro_del_repo(a, c)
    }

    fn cmd(c: &str) -> Option<&'static str> {
        destructivo_de(Tipo::Cmd, &entrada(json!({ "command": c })))
    }

    #[test]
    fn dentro_del_repo_acepta_archivos_del_repo_con_cualquier_barra_y_mayusculas() {
        assert!(dentro_del_repo("C:\\dev\\repo\\README.md", CWD));
        assert!(dentro_del_repo("c:/DEV/repo/src/a.ts", CWD));
        assert!(dentro_del_repo("src\\a.ts", CWD));
        assert!(dentro_del_repo("/home/ana/repo/a.ts", "/home/ana/repo"));
    }

    #[test]
    fn dentro_del_repo_rechaza_lo_que_cae_fuera() {
        for f in [
            "C:\\Users\\ana\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.cmd",
            "C:\\dev\\repo\\..\\otro\\a.ts",
            "..\\..\\Users\\ana\\.claude\\settings.json",
            "C:\\dev\\repo-vecino\\a.ts",
            "D:\\dev\\repo\\a.ts",
            "C:\\dev\\repo",
            "\\\\servidor\\dev\\repo\\a.ts",
        ] {
            assert!(!dentro_del_repo(f, CWD), "{f}");
        }
    }

    #[test]
    fn dentro_del_repo_rechaza_las_carpetas_que_ejecutan_lo_que_se_escribe() {
        for f in [".git\\hooks\\pre-commit", ".claude\\settings.json", ".vscode\\tasks.json", ".husky\\pre-push", "paquete\\.git\\config", ".GIT.\\config", ".git \\config", "GIT~1\\config", "a.ts:oculto"] {
            assert!(!dentro_del_repo(&format!("{CWD}\\{f}"), CWD), "{f}");
        }
        assert!(dentro_del_repo(&format!("{CWD}\\.gitignore"), CWD));
        for f in [".github\\workflows\\ci.yml", ".idea\\workspace.xml", ".devcontainer\\devcontainer.json", ".sloth\\team.json", ".githooks\\pre-commit", "VSCODE~1\\tasks.json", "CLAUDE~1\\settings.json"] {
            assert!(!dentro_del_repo(&format!("{CWD}\\{f}"), CWD), "{f}");
        }
        for f in ["informe~2.docx", "notas-viejas~1.md", "backup~1.txt.bak"] {
            assert!(dentro_del_repo(&format!("{CWD}\\{f}"), CWD), "{f}");
        }
    }

    #[test]
    fn la_regla_de_ediciones_solo_aprueba_dentro_de_la_carpeta_del_espacio() {
        let r = regla(&pedido("Edit", json!({ "file_path": format!("{CWD}\\README.md") })));
        let ok = |p: Pedido, cwd| regla_coincide(&r, &p, cwd, &dentro);
        assert!(ok(pedido("Write", json!({ "file_path": format!("{CWD}\\src\\b.ts") })), Some(CWD)));
        assert!(!ok(pedido("Write", json!({ "file_path": "C:\\Users\\ana\\Documents\\WindowsPowerShell\\profile.ps1" })), Some(CWD)));
        assert!(!ok(pedido("Write", json!({ "file_path": format!("{CWD}\\.git\\hooks\\pre-commit") })), Some(CWD)));
        assert!(ok(pedido("NotebookEdit", json!({ "notebook_path": format!("{CWD}\\n.ipynb") })), Some(CWD)));
        assert!(!ok(pedido("Edit", json!({ "file_path": format!("{CWD}\\README.md") })), None));
        assert!(!ok(pedido("Edit", json!({})), Some(CWD)));
    }

    #[test]
    fn las_reglas_de_comando_y_de_dominio_siguen_siendo_exactas() {
        let c = regla(&pedido("Bash", json!({ "command": "npm test" })));
        let reglas = [c];
        assert!(buscar_regla(&reglas, &pedido("Bash", json!({ "command": "npm test" })), Some(CWD), &dentro).is_some());
        assert!(buscar_regla(&reglas, &pedido("Bash", json!({ "command": "npm test; rm -rf x" })), Some(CWD), &dentro).is_none());
        let mut otro = pedido("Bash", json!({ "command": "npm test" }));
        otro.ws = "otro".into();
        assert!(buscar_regla(&reglas, &otro, Some(CWD), &dentro).is_none());
        let net = [regla(&pedido("WebFetch", json!({ "url": "https://example.com/a" })))];
        assert!(buscar_regla(&net, &pedido("WebFetch", json!({ "url": "https://example.com/b" })), None, &dentro).is_some());
        assert!(buscar_regla(&net, &pedido("WebFetch", json!({ "url": "https://example.org/" })), None, &dentro).is_none());
    }

    #[test]
    fn permitir_desde_aviso_solo_comandos_cortos_que_se_ven_enteros() {
        let c = |t: &str| permitir_desde_aviso(Tipo::Cmd, &entrada(json!({ "command": t })));
        assert!(c("npm test") && c(&"x".repeat(80)) && c("git commit -m \"acción\""));
        assert!(!c(&"x".repeat(81)) && !c("ls\nrm -rf /") && !c("ls\rrm") && !c("ls\trm") && !c("echo \u{202e}gnp.exe") && !c("rm\u{200b} -rf x") && !c("ls\u{1b}[2K"));
        assert!(!permitir_desde_aviso(Tipo::Cmd, &entrada(json!({}))));
        assert!(!permitir_desde_aviso(Tipo::Edit, &entrada(json!({ "file_path": "a.ts" }))));
        assert!(!permitir_desde_aviso(Tipo::Net, &entrada(json!({ "url": "https://a.com" }))));
        assert!(!permitir_desde_aviso(Tipo::Other, &entrada(json!({}))));
    }

    #[test]
    fn destructivo_de_marca_los_comandos_destructivos_conocidos() {
        let largo = format!("{}rm x -rf", "a ".repeat(60));
        let si = [
            "rm -rf node_modules && npm ci", "rm -fr build", "rm -r dist", "rm -f -r dist", "rm --recursive dist", "sudo rm -rf /var/x", "cd x; rm -rf .",
            "git push origin HEAD --force-with-lease", "git push --force", "git push -f origin main", "git push origin main --force-if-includes", "git reset --hard HEAD~3",
            "git clean -fdx", "git -C ../x push --force", "git -C x reset --hard", "git -c core.x=1 push origin main -f", "git clean --force -d", "/bin/rm -rf x", "\\rm -rf x",
            "rm x -rf", "rm${IFS}-rf x", "find . -name a -exec rm -rf {} \\;", "rmdir -Recurse x", "Remove-Item -r x", "git push origin +main", "rd /s/q build", "del /s/q x",
            "Remove-Item -Path x -Recurse:$true", "git push \\\n  --force", "git push origin main `\n  --force", "rm \\\n  -rf x", "git reset \\\n  --hard", "git clean \\\n  -fd",
            "Remove-Item x `\n  -Recurse", "git --git-dir x push -f", "git push --delete origin rama", "git push origin :main", "git push --mirror", "git branch -D vieja",
            "git stash drop", "git restore .", "git checkout -- .", "chmod -R 777 .", "echo a | psql -c \"drop table x\"", "psql <<EOF\nDROP TABLE x\nEOF", &largo,
            "sudo mkfs.ext4 /dev/sdb1", "psql -c \"DROP TABLE usuarios\"", "sqlite3 a.db \"drop database x\"", "psql -c \"TRUNCATE TABLE logs\"", "del /s /q C:\\temp\\*",
            "rmdir /s /q build", "Remove-Item -Recurse -Force .\\out", "mkfs.ext4 /dev/sdb1", "dd if=/dev/zero of=/dev/sda",
        ];
        for c in si {
            assert!(cmd(c).is_some(), "{c}");
        }
    }

    #[test]
    fn destructivo_de_no_marca_comandos_comunes_ni_parecidos() {
        let no = [
            "rm archivo.txt", "rm -i viejo.log", "git push origin feat/x", "git push -u origin feat/x", "git push --follow-tags", "git reset --soft HEAD~1", "git reset HEAD archivo",
            "git clean -n", "git clean -n -f", "git clean -fn", "git clean --dry-run -fd", "dd if=a of=/dev/null bs=1M", "git -C x push origin feat/y", "git -C x reset --soft HEAD~1",
            "git status", "npm run format", "npm run build -- --force", "ls -la", "man mkfs", "echo drop table", "git commit -m \"drop table usuarios\"", "git push origin feat/drop-table",
            "git branch -d mergeada", "git stash pop", "git restore --staged .", "git checkout main", "chmod 644 a.txt", "psql -c \"SELECT * FROM tabla_drop\"", "echo dropbox sync", "firm -rf x",
        ];
        for c in no {
            assert_eq!(cmd(c), None, "{c}");
        }
    }

    #[test]
    fn destructivo_de_solo_mira_comandos_y_los_vacios_o_raros_no_rompen() {
        assert_eq!(destructivo_de(Tipo::Edit, &entrada(json!({ "command": "rm -rf /" }))), None);
        assert_eq!(destructivo_de(Tipo::Net, &entrada(json!({ "url": "https://x.com/rm -rf" }))), None);
        assert_eq!(destructivo_de(Tipo::Cmd, &entrada(json!({}))), None);
        assert_eq!(destructivo_de(Tipo::Cmd, &entrada(json!({ "command": 42 }))), None);
        assert_eq!(destructivo_de(Tipo::Cmd, &entrada(json!({ "command": "   " }))), None);
    }

    #[test]
    fn destructivo_de_limites_conocidos() {
        assert!(cmd("echo \"rm -rf /\"").is_some());
        assert!(cmd("git commit -m \"no hagas git reset --hard\"").is_some());
        assert!(cmd("git rm -r src/viejo").is_some());
        for c in ["r\\m -rf x", "$(echo cm0gLXJmIHg= | base64 -d | sh)", "X=rm; $X -rf x", "find . -delete", "bash borrar.sh", "psql -c \"DELETE FROM usuarios\"", "shred -u secreto.txt"] {
            assert_eq!(cmd(c), None, "{c}");
        }
        assert_eq!(destructivo_de(Tipo::Other, &entrada(json!({ "command": "rm -rf /" }))), None);
    }

    #[test]
    fn destructivo_de_es_lineal() {
        let casos = [
            format!("rm -{}1", "r".repeat(249_000)),
            "del ".repeat(60_000),
            "git push ".repeat(28_000),
            "Remove-Item ".repeat(20_000),
            "a ".repeat(1900),
            "rm x ".repeat(50_000),
            "rm -r1 ".repeat(30_000),
            "}".repeat(249_000),
            "\"".repeat(249_000),
            format!("{}drop {}", "x ".repeat(124_000), " ".repeat(100_000)),
            format!("psql {}", "drop ".repeat(40_000)),
        ];
        for c in &casos {
            let t0 = std::time::Instant::now();
            cmd(c);
            assert!(t0.elapsed().as_millis() < 2000, "tardó {} ms con {}", t0.elapsed().as_millis(), &c[..20]);
        }
        assert_eq!(cmd(&"x ".repeat(100_000)), None);
        assert!(cmd(&format!("{}rm -rf y", "x ".repeat(100_000))).is_some());
        assert!(cmd(&format!("rm {}-rf", "x ".repeat(100_000))).is_some());
    }

    #[test]
    fn un_destructivo_no_se_aprueba_desde_el_aviso_ni_con_regla_ni_con_siempre() {
        let rm = pedido("Bash", json!({ "command": "rm -rf x" }));
        let ok = pedido("Bash", json!({ "command": "npm test" }));
        assert!(!permitir_desde_aviso(Tipo::Cmd, &rm.input));
        assert_eq!(respuesta_efectiva(Eleccion::AllowAlways, &rm), Eleccion::Allow);
        assert_eq!(respuesta_efectiva(Eleccion::AllowAlways, &ok), Eleccion::AllowAlways);
        assert_eq!(respuesta_efectiva(Eleccion::Deny, &rm), Eleccion::Deny);
        assert_eq!(respuesta_efectiva(Eleccion::AllowAlways, &pedido("Edit", json!({ "file_path": "a.ts" }))), Eleccion::AllowAlways);
        assert_eq!(respuesta_efectiva(Eleccion::AllowAlways, &pedido("WebFetch", json!({ "url": "https://a.com" }))), Eleccion::AllowAlways);
        assert_eq!(respuesta_efectiva(Eleccion::Terminal, &rm), Eleccion::Terminal);
        assert!(revisar_regla(&json!({ "kind": "cmd", "tool": "Bash", "match": "rm -rf x" })).is_err());
        assert!(revisar_regla(&json!({ "kind": "cmd", "tool": "Bash", "match": "npm test" })).is_ok());
        assert!(buscar_regla(&[regla(&rm)], &rm, None, &dentro).is_none());
        assert!(buscar_regla(&[regla(&ok)], &ok, None, &dentro).is_some());
    }

    #[test]
    fn revisar_regla_valida_cada_tipo() {
        let r = |v: Value| revisar_regla(&v);
        assert_eq!(r(json!({ "kind": "net", "tool": "WebFetch", "match": " Example.COM:8080 " })).unwrap().label, "Acceder a example.com:8080");
        for malo in ["", "a b", "-a.com", "a..com", "a.com:", "a.com:123456", "a.com/x"] {
            assert!(r(json!({ "kind": "net", "tool": "WebFetch", "match": malo })).is_err(), "{malo}");
        }
        assert_eq!(r(json!({ "kind": "edit", "tool": "Write", "match": "*" })).unwrap().label, "Editar archivos");
        assert!(r(json!({ "kind": "edit", "tool": "Write", "match": "a" })).is_err());
        assert!(r(json!({ "kind": "edit", "tool": "Bash", "match": "*" })).is_err());
        assert_eq!(r(json!({ "kind": "other", "tool": "mcp__sloth__chat_leer", "match": "*" })).unwrap().label, "chat_leer");
        assert!(r(json!({ "kind": "other", "tool": "Foo", "match": "x" })).is_err());
        assert!(r(json!({ "kind": "cmd", "tool": "Bash", "match": "ls *" })).is_err());
        assert!(r(json!({ "kind": "cmd", "tool": "Bash", "match": "ls\u{1}" })).is_err());
        assert!(r(json!({ "kind": "cmd", "tool": "Bash", "match": "" })).is_err());
        assert!(r(json!({ "kind": "cmd", "tool": "Bash", "match": "a".repeat(2001) })).is_err());
        assert!(r(json!({ "kind": "zzz", "tool": "Bash" })).is_err() && r(json!([])).is_err() && r(json!({ "kind": "cmd", "tool": "9x" })).is_err());
    }

    #[test]
    fn etiquetas_titulos_y_hosts() {
        let i = |v: Value| entrada(v);
        assert_eq!(etiqueta_de(Tipo::Cmd, "Bash", &i(json!({}))), "comando");
        assert_eq!(etiqueta_de(Tipo::Edit, "Edit", &i(json!({ "file_path": "a.ts" }))), "Editar a.ts");
        assert_eq!(etiqueta_de(Tipo::Net, "WebFetch", &i(json!({ "url": "https://Ex.com:443/x" }))), "Acceder a ex.com");
        assert_eq!(etiqueta_de(Tipo::Net, "WebFetch", &i(json!({ "url": "nada" }))), "Acceder a internet");
        assert_eq!(host_de(&i(json!({ "url": "http://u:p@Host.io:8080/a?b#c" }))), "host.io:8080");
        assert_eq!(host_de(&i(json!({ "url": "http://host.io:80" }))), "host.io");
        assert_eq!(titulo_de(Tipo::Edit, "Edit", &i(json!({}))), "Claude quiere editar un archivo");
        assert_eq!(titulo_de(Tipo::Other, "mcp__srv__hacer", &i(json!({}))), "Claude quiere usar hacer");
        assert_eq!(nombre_corto("mcp__srv"), "srv");
        assert_eq!(nombre_corto("mcp__srv__"), "srv");
        assert_eq!(nombre_corto("Read"), "Read");
        assert_eq!(etiqueta_siempre(Tipo::Edit), "Permitir siempre ediciones en este repo");
    }

    #[test]
    fn cambios_del_pedido() {
        let i = |v: Value| entrada(v);
        let c = cambios_de("Edit", &i(json!({ "file_path": "a.ts", "old_string": "x\r\ny", "new_string": "z" })));
        assert_eq!((c[0].add, c[0].del, c[0].is_new), (1, 2, false));
        assert_eq!(c[0].lines[0], LineaDiff { mas: false, texto: "x".into() });
        let c = cambios_de("MultiEdit", &i(json!({ "file_path": "a", "edits": [{ "old_string": "a", "new_string": "b\nc" }] })));
        assert_eq!((c[0].add, c[0].del), (2, 1));
        assert_eq!(cambios_de("Write", &i(json!({ "file_path": "a", "content": "uno\ndos" })))[0].add, 2);
        assert!(cambios_de("Edit", &i(json!({ "old_string": "x" }))).is_empty());
        assert!(cambios_de("Bash", &i(json!({ "command": "x" }))).is_empty());
        assert_eq!(cambios_de("NotebookEdit", &i(json!({ "notebook_path": "n", "new_source": "s" })))[0].add, 1);
    }

    #[test]
    fn decision_y_aviso() {
        assert_eq!(decision_para(Eleccion::AllowAlways, None), Some(json!({ "behavior": "allow" })));
        assert_eq!(decision_para(Eleccion::Deny, Some("  ")), Some(json!({ "behavior": "deny", "message": "Rechazado desde Sloth." })));
        assert_eq!(decision_para(Eleccion::Deny, Some(" no ")), Some(json!({ "behavior": "deny", "message": "no" })));
        assert_eq!(decision_para(Eleccion::Terminal, None), None);
        assert!(!debe_avisar(true, false, None, "w"));
        assert!(!debe_avisar(false, true, Some("w"), "w"));
        assert!(debe_avisar(false, true, Some("x"), "w") && debe_avisar(false, false, Some("w"), "w"));
    }
}
