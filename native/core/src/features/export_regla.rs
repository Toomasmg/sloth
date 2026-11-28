//! Reglas «Permitir siempre» que viajan en el archivo exportado: validarlas (`checkRule`) y reconocer comandos
//! destructivos (`destructivoDe`), de src/shared/permissions-core.ts. Es solo lo que necesita el export/import; el resto
//! de los permisos se porta aparte.
use crate::perfiles_core::es_blanco_js;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::sync::OnceLock;

pub const MAX_RULE_MATCH: usize = 2000;

/// `String.prototype.trim` de JavaScript.
pub fn trim_js(s: &str) -> &str {
    s.trim_matches(es_blanco_js)
}

/// `.length` de JavaScript: unidades UTF-16, no caracteres.
pub fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionKind {
    Cmd,
    Edit,
    Net,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RuleDraft {
    pub kind: PermissionKind,
    pub tool: String,
    #[serde(rename = "match")]
    pub match_: String,
    pub label: String,
}

const FILE_EDIT_TOOLS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const NET_TOOLS: [&str; 2] = ["WebFetch", "WebSearch"];

pub fn es_herramienta_de_edicion(tool: &str) -> bool {
    FILE_EDIT_TOOLS.contains(&tool)
}

pub fn kind_of(tool: &str) -> PermissionKind {
    if tool == "Bash" {
        PermissionKind::Cmd
    } else if es_herramienta_de_edicion(tool) {
        PermissionKind::Edit
    } else if NET_TOOLS.contains(&tool) {
        PermissionKind::Net
    } else {
        PermissionKind::Other
    }
}

/// Nombre corto de una herramienta: en MCP, la herramienta sin el prefijo `mcp__servidor__`.
pub fn other_name(tool: &str) -> String {
    let Some(rest) = tool.strip_prefix("mcp__") else { return tool.to_string() };
    match rest.find("__") {
        None => rest.to_string(),
        Some(i) => {
            let sin = &rest[i + 2..];
            if sin.is_empty() { rest[..i].to_string() } else { sin.to_string() }
        }
    }
}

fn re(cell: &'static OnceLock<Regex>, patron: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(patron).expect("regex fija"))
}

fn tool_name_ok(t: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^[A-Za-z][A-Za-z0-9_.:-]{0,119}$").is_match(t)
}

/// Dominio con puerto opcional; el tope de 253 era un lookahead en el TS.
fn host_ok(h: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    (1..=253).contains(&h.len()) && re(&R, r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]{1,5})?$").is_match(h)
}

fn tiene_control(s: &str) -> bool {
    s.chars().any(|c| matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'))
}

/// Valida una regla que llega de afuera. Es la forma que guarda «Permitir siempre»: el tipo sale de la herramienta, el
/// texto es exacto (comando o dominio) y nunca hay comodines, salvo «*» en ediciones y en herramientas completas.
pub fn check_rule(raw: &Value) -> Result<RuleDraft, String> {
    let Some(o) = raw.as_object() else { return Err("formato inválido".into()) };
    let kind = match o.get("kind").and_then(Value::as_str) {
        Some("cmd") => PermissionKind::Cmd,
        Some("edit") => PermissionKind::Edit,
        Some("net") => PermissionKind::Net,
        Some("other") => PermissionKind::Other,
        _ => return Err("tipo de regla desconocido".into()),
    };
    let tool = o.get("tool").and_then(Value::as_str).map_or("", trim_js).to_string();
    let match_ = o.get("match").and_then(Value::as_str).map_or("", trim_js).to_string();
    if !tool_name_ok(&tool) {
        return Err("nombre de herramienta inválido".into());
    }
    if kind_of(&tool) != kind {
        return Err("el tipo no corresponde a la herramienta".into());
    }
    match kind {
        PermissionKind::Cmd => {
            if match_.is_empty() {
                return Err("falta el comando".into());
            }
            if len16(&match_) > MAX_RULE_MATCH || tiene_control(&match_) {
                return Err("comando demasiado largo o con caracteres de control".into());
            }
            if match_.contains('*') {
                return Err("Sloth solo guarda comandos exactos, sin comodines".into());
            }
            if destructivo_de(kind, &serde_json::json!({ "command": match_ })).is_some() {
                return Err("un comando destructivo solo se permite una vez".into());
            }
            Ok(RuleDraft { kind, tool, label: match_.clone(), match_ })
        }
        PermissionKind::Net => {
            if !NET_TOOLS.contains(&tool.as_str()) {
                return Err("herramienta de red no válida".into());
            }
            let host = match_.to_lowercase();
            if !host_ok(&host) {
                return Err("el dominio no es válido".into());
            }
            Ok(RuleDraft { kind, tool, label: format!("Acceder a {host}"), match_: host })
        }
        PermissionKind::Edit => {
            if !es_herramienta_de_edicion(&tool) || match_ != "*" {
                return Err("regla de edición no válida".into());
            }
            Ok(RuleDraft { kind, tool, match_: "*".into(), label: "Editar archivos".into() })
        }
        PermissionKind::Other => {
            if match_ != "*" {
                return Err("Sloth solo guarda herramientas completas, sin patrón".into());
            }
            let label = other_name(&tool);
            Ok(RuleDraft { kind, tool, match_: "*".into(), label })
        }
    }
}

const CLIENTES_SQL: [&str; 8] = ["psql", "sqlite3", "mysql", "mariadb", "sqlcmd", "sqlplus", "usql", "duckdb"];
const COMANDOS: [&str; 11] = ["rm", "del", "erase", "rd", "rmdir", "remove-item", "ri", "git", "dd", "chmod", "chown"];
const ENVOLTORIOS: [&str; 10] = ["sudo", "doas", "env", "nohup", "time", "xargs", "exec", "command", "builtin", "nice"];
const GIT_CON_VALOR: [&str; 5] = ["-C", "-c", "--git-dir", "--work-tree", "--namespace"];

fn es_comando_conocido(p: &str) -> bool {
    COMANDOS.contains(&p) || CLIENTES_SQL.contains(&p)
}

fn es_envoltorio(p: &str) -> bool {
    ENVOLTORIOS.contains(&p)
}

fn limpiar(t: &str) -> &str {
    t.trim_start_matches(['"', '\'', '{']).trim_end_matches(['"', '\'', '}'])
}

fn comando_de(t: &str) -> String {
    let s = limpiar(t);
    let base = &s[s.rfind(['/', '\\']).map_or(0, |i| i + 1)..];
    let m = base.to_lowercase();
    for ext in [".exe", ".cmd", ".bat"] {
        if let Some(sin) = m.strip_suffix(ext) {
            return sin.to_string();
        }
    }
    m
}

fn con_letra(t: &str, letras: &str) -> bool {
    t.len() > 1 && t.starts_with('-') && t[1..].bytes().all(|b| b.is_ascii_alphabetic()) && letras.chars().any(|l| t.contains(l))
}

fn es_recursivo_ps(t: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?i)^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?::|$)").is_match(t)
}

fn es_barra_s(t: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?i)^/(?:[a-z]/)*s(?:/|$)").is_match(t)
}

fn subcomando_git(args: &[&str]) -> Option<(String, Vec<String>)> {
    let mut i = 0;
    while i < args.len() && args[i].starts_with('-') {
        i += if GIT_CON_VALOR.contains(&args[i]) { 2 } else { 1 };
    }
    (i < args.len()).then(|| (args[i].to_string(), args[i + 1..].iter().map(|s| s.to_string()).collect()))
}

fn motivo_de_git(args: &[&str]) -> Option<&'static str> {
    static PUSH: OnceLock<Regex> = OnceLock::new();
    static SIGNO: OnceLock<Regex> = OnceLock::new();
    let (sub, resto) = subcomando_git(args)?;
    let hay = |f: &dyn Fn(&str) -> bool| resto.iter().any(|t| f(t));
    let tiene = |x: &str| resto.iter().any(|t| t == x);
    let push = re(&PUSH, r"^--(?:force(?:-with-lease|-if-includes)?(?:=.*)?|delete|mirror)$");
    let signo = re(&SIGNO, r"^[+:]\S");
    match sub.as_str() {
        "push" if hay(&|t| push.is_match(t) || con_letra(t, "fd") || signo.is_match(t)) => Some("pisa o borra cosas del remoto"),
        "reset" if tiene("--hard") => Some("descarta cambios sin commitear"),
        "restore" | "checkout" if tiene(".") && !(tiene("--staged") && !tiene("--worktree")) => Some("descarta cambios sin commitear"),
        "clean" if hay(&|t| t == "--force" || con_letra(t, "f")) && !hay(&|t| t == "--dry-run" || con_letra(t, "n")) => Some("borra archivos sin seguimiento"),
        "branch" if hay(&|t| con_letra(t, "D")) => Some("borra una rama sin chequear"),
        "stash" if matches!(resto.first().map(String::as_str), Some("drop" | "clear")) => Some("descarta cambios guardados"),
        _ => None,
    }
}

fn motivo_de_comando(cmd: &str, args: &[&str]) -> Option<&'static str> {
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

fn es_asignacion(t: &str) -> bool {
    let Some((nombre, _)) = t.split_once('=') else { return false };
    let mut cs = nombre.chars();
    cs.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && cs.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn es_mkfs(p: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^mkfs(?:\.[A-Za-z0-9_]+)?$").is_match(p)
}

/// Por qué un comando se marca «Destructivo» (None si no). Es una ayuda, no un control: nunca bloquea un pedido, y un
/// comando que no figure no quiere decir que sea seguro. Un falso positivo es el lado seguro del error.
pub fn destructivo_de(kind: PermissionKind, input: &Value) -> Option<&'static str> {
    static CONT: OnceLock<Regex> = OnceLock::new();
    static IFS: OnceLock<Regex> = OnceLock::new();
    static TRAMOS: OnceLock<Regex> = OnceLock::new();
    static SQL: OnceLock<Regex> = OnceLock::new();
    static BLANCOS: OnceLock<Regex> = OnceLock::new();
    if kind != PermissionKind::Cmd {
        return None;
    }
    let c = trim_js(input.get("command").and_then(Value::as_str)?);
    if c.is_empty() {
        return None;
    }
    let unido = re(&CONT, r"\\\r?\n|`\r?\n").replace_all(c, " ");
    let unido = re(&IFS, r"\$\{IFS\}|\$IFS").replace_all(&unido, " ");
    let mut hay_cliente_sql = false;
    for tramo in re(&TRAMOS, r"[;&|\n\r`()]+").split(&unido) {
        let toks: Vec<&str> = re(&BLANCOS, r"\s+").split(tramo).filter(|t| !t.is_empty()).collect();
        let palabras: Vec<String> = toks.iter().map(|t| comando_de(t)).collect();
        let inicio = palabras.iter().enumerate().position(|(i, p)| !es_envoltorio(p) && !toks[i].starts_with('-') && !es_asignacion(toks[i]));
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
            let args: Vec<&str> = toks[i + 1..fin].iter().map(|t| limpiar(t)).collect();
            if let Some(m) = motivo_de_comando(p, &args) {
                return Some(m);
            }
        }
    }
    (hay_cliente_sql && re(&SQL, r"(?i)(?-u:\b)(?:drop\s+(?:table|database|schema)|truncate\s+table)(?-u:\b)").is_match(c)).then_some("borra datos de una base")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cmd(c: &str) -> Option<&'static str> {
        destructivo_de(PermissionKind::Cmd, &json!({ "command": c }))
    }

    #[test]
    fn acepta_las_reglas_validas_de_cada_tipo() {
        let r = check_rule(&json!({ "kind": "cmd", "tool": "Bash", "match": " npm test " })).unwrap();
        assert_eq!((r.match_.as_str(), r.label.as_str()), ("npm test", "npm test"));
        let n = check_rule(&json!({ "kind": "net", "tool": "WebFetch", "match": "Example.com" })).unwrap();
        assert_eq!((n.match_.as_str(), n.label.as_str()), ("example.com", "Acceder a example.com"));
        assert_eq!(check_rule(&json!({ "kind": "edit", "tool": "Edit", "match": "*" })).unwrap().label, "Editar archivos");
        assert_eq!(check_rule(&json!({ "kind": "other", "tool": "mcp__s__t", "match": "*" })).unwrap().label, "t");
    }

    #[test]
    fn rechaza_las_que_amplian_el_permiso_o_estan_mal_formadas() {
        let malas = [
            json!({ "kind": "cmd", "tool": "Bash", "match": "npm *" }),
            json!({ "kind": "edit", "tool": "Edit", "match": "src/**" }),
            json!({ "kind": "otro", "tool": "Bash", "match": "x" }),
            json!({ "kind": "cmd", "tool": "Bash", "match": "" }),
            json!({ "kind": "cmd", "tool": "Bash", "match": "a\u{1}b" }),
            json!({ "kind": "cmd", "tool": "Bash", "match": "x".repeat(2001) }),
            json!({ "kind": "cmd", "tool": "Edit", "match": "x" }),
            json!({ "kind": "net", "tool": "WebFetch", "match": "https://x.com" }),
            json!({ "kind": "other", "tool": "mcp__s__t", "match": "x" }),
            json!({ "kind": "other", "tool": "1x", "match": "*" }),
            json!({ "kind": "cmd", "tool": "Bash", "match": "rm -rf build" }),
            Value::Null,
            json!(7),
            json!([]),
        ];
        for m in malas {
            assert!(check_rule(&m).is_err(), "{m}");
        }
    }

    #[test]
    fn el_largo_del_comando_cuenta_unidades_utf16() {
        let justo = "😀".repeat(1000);
        let pasado = "😀".repeat(1001);
        assert!(check_rule(&json!({ "kind": "cmd", "tool": "Bash", "match": justo })).is_ok());
        assert!(check_rule(&json!({ "kind": "cmd", "tool": "Bash", "match": pasado })).is_err());
    }

    #[test]
    fn nombre_corto_de_herramientas_mcp() {
        assert_eq!(other_name("Task"), "Task");
        assert_eq!(other_name("mcp__srv__tool"), "tool");
        assert_eq!(other_name("mcp__srv"), "srv");
        assert_eq!(other_name("mcp__srv__"), "srv");
    }

    #[test]
    fn marca_los_comandos_destructivos_de_siempre() {
        assert_eq!(cmd("rm -rf node_modules"), Some("borra carpetas enteras"));
        assert_eq!(cmd("git push --force origin main"), Some("pisa o borra cosas del remoto"));
        assert_eq!(cmd("git -C repo reset --hard HEAD~1"), Some("descarta cambios sin commitear"));
        assert_eq!(cmd("git clean -fd"), Some("borra archivos sin seguimiento"));
        assert_eq!(cmd("git clean -fdn"), None);
        assert_eq!(cmd("git branch -D x"), Some("borra una rama sin chequear"));
        assert_eq!(cmd("git stash drop"), Some("descarta cambios guardados"));
        assert_eq!(cmd("del /s /q carpeta"), Some("borra archivos de forma recursiva"));
        assert_eq!(cmd("Remove-Item -Recurse x"), Some("borra carpetas enteras"));
        assert_eq!(cmd("dd if=a of=/dev/sda"), Some("escribe sobre un dispositivo"));
        assert_eq!(cmd("dd if=a of=/dev/null"), None);
        assert_eq!(cmd("chmod -R 777 ."), Some("cambia permisos de forma recursiva"));
        assert_eq!(cmd("sudo mkfs.ext4 /dev/sda1"), Some("formatea un disco"));
        assert_eq!(cmd("psql -c 'DROP TABLE x'"), Some("borra datos de una base"));
    }

    #[test]
    fn no_marca_lo_que_es_inofensivo_ni_mira_otras_herramientas() {
        assert_eq!(cmd("npm test"), None);
        assert_eq!(cmd("git push origin main"), None);
        assert_eq!(cmd("rm archivo.txt"), None);
        assert_eq!(cmd("echo drop table x"), None);
        assert_eq!(destructivo_de(PermissionKind::Edit, &json!({ "command": "rm -rf /" })), None);
        assert_eq!(destructivo_de(PermissionKind::Cmd, &json!({})), None);
    }

    #[test]
    fn ve_el_comando_en_tramos_continuaciones_y_rutas() {
        assert_eq!(cmd("cd x && rm -rf y"), Some("borra carpetas enteras"));
        assert_eq!(cmd("echo a; git reset --hard"), Some("descarta cambios sin commitear"));
        assert_eq!(cmd("rm \\\n -rf y"), Some("borra carpetas enteras"));
        assert_eq!(cmd("/usr/bin/rm -rf y"), Some("borra carpetas enteras"));
        assert_eq!(cmd("C:\\Git\\bin\\git.exe push -f"), Some("pisa o borra cosas del remoto"));
        assert_eq!(cmd("A=1 nohup rm -R y"), Some("borra carpetas enteras"));
    }

    #[test]
    fn un_comando_enorme_no_se_cuelga() {
        let enorme = format!("{}rm -rf x", "a ".repeat(200_000));
        assert_eq!(cmd(&enorme), Some("borra carpetas enteras"));
    }
}
