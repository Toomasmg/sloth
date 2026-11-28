//! Issues de GitHub con `gh` y la sesión de la persona: arma los argumentos y lee la salida, sin pasar por Claude. No corre
//! nada: recibe quién corre `gh` (`GhRun`). Equivale a src/main/features/tickets/gh.ts.
use super::claude_run::{Mirada, Peticion, ProcesoRun, SalidaRun};
use super::conector::{id_normalizado, ConectorGh};
use super::errores::{ErrorTickets, Res};
use super::modelo::{Accion, Detalle, Ticket, Yo};
use super::motor::{norm_comentarios, AccionInput};
use super::texto::{cortar16, num_valor, re, trim_js};
use regex::{Regex, RegexBuilder};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::OnceLock;
use std::time::Duration;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GhOut {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub missing: bool,
    pub timed_out: bool,
}

pub trait GhRun {
    fn run(&self, args: &[String], input: Option<&str>) -> GhOut;
}

const NO_ENTIENDO: &str = "gh devolvió algo que no entiendo.";
/// Lo que `\s` es en JavaScript (el de `regex` es otro conjunto).
const S: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

fn err<T>(m: &str) -> Res<T> {
    Err(ErrorTickets::otro(m))
}

fn parte_de_repo_ok(p: &str) -> bool {
    let n = p.chars().count();
    (1..=100).contains(&n) && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-') && !p.starts_with(['-', '.'])
}

/// `dueño/repo`: sin empezar con guion ni punto, para que nunca parezca una opción de `gh`.
pub fn repo_ok(v: &str) -> bool {
    v.split_once('/').is_some_and(|(a, b)| parte_de_repo_ok(a) && parte_de_repo_ok(b))
}

pub fn num_ok(v: &str) -> bool {
    re(r"^[1-9]\d{0,6}$").is_match(v)
}

pub fn login_ok(v: &str) -> bool {
    re(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$").is_match(v)
}

fn prioridad_ok(n: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| RegexBuilder::new(r"^(p[0-4]|prio(ridad)?[:/ ].+|priority[:/ ].+)$").case_insensitive(true).build().unwrap()).is_match(n)
}

fn es_error_de_sesion(stderr: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| RegexBuilder::new(r"gh auth login|not logged in|authentication required|HTTP 401|Bad credentials|GH_TOKEN").case_insensitive(true).build().unwrap()).is_match(stderr)
}

/// En una línea, sin caracteres de control ni de dirección, cortado a `max`.
fn linea(v: Option<&Value>, max: usize) -> Option<String> {
    static CONTROLES: OnceLock<Regex> = OnceLock::new();
    static BLANCOS: OnceLock<Regex> = OnceLock::new();
    let s = v?.as_str()?;
    let controles = CONTROLES.get_or_init(|| Regex::new(r"[\x00-\x1f\x7f-\x9f\x{200b}-\x{200f}\x{202a}-\x{202e}\x{2066}-\x{2069}]").unwrap());
    let blancos = BLANCOS.get_or_init(|| Regex::new(&format!("[{S}]+")).unwrap());
    let t = controles.replace_all(cortar16(s, max * 4), " ");
    let t = blancos.replace_all(&t, " ");
    let out = cortar16(trim_js(&t), max);
    (!out.is_empty()).then(|| out.to_string())
}

pub fn repo_valido(v: &str) -> Res<&str> {
    if repo_ok(v) {
        Ok(v)
    } else {
        err("El repo de GitHub tiene que ser tipo dueño/repo.")
    }
}

/// El repo guardado al listar el issue: el detalle y las escrituras nunca van a otro.
fn repo_del_issue(proyecto: Option<&str>) -> Res<&str> {
    match proyecto {
        Some(p) if repo_ok(p) => Ok(p),
        _ => err("No sé de qué repo es este issue: actualizá GitHub Issues."),
    }
}

fn numero(v: &str) -> Res<&str> {
    if num_ok(v) {
        Ok(v)
    } else {
        err("El issue tiene que ser un número.")
    }
}

fn login(v: Option<&str>) -> Res<&str> {
    match v {
        Some(l) if login_ok(l) => Ok(l),
        _ => err("Ese usuario de GitHub no es válido."),
    }
}

fn correr(run: &dyn GhRun, falta_conector: &str, args: &[&str], input: Option<&str>) -> Res<String> {
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    let r = run.run(&args, input);
    if r.missing {
        return err(falta_conector);
    }
    if r.timed_out {
        return err("gh tardó demasiado.");
    }
    if r.code != 0 {
        if es_error_de_sesion(&r.stderr) {
            return err("gh no tiene sesión iniciada: corré `gh auth login`.");
        }
        let primera = r.stderr.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).find_map(|l| linea(Some(&Value::String(l.to_string())), 200));
        return Err(ErrorTickets::otro(primera.unwrap_or_else(|| format!("gh terminó con código {}.", r.code))));
    }
    Ok(r.stdout)
}

fn json_de(s: &str) -> Res<Value> {
    serde_json::from_str(s).or_else(|_| err(NO_ENTIENDO))
}

fn url_de_github(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?;
    if s.chars().count() > 500 || !s.starts_with("https://github.com/") {
        return None;
    }
    let u = url::Url::parse(s).ok()?;
    (u.scheme() == "https" && u.host_str() == Some("github.com")).then(|| u.to_string())
}

fn prioridad_de(labels: Option<&Value>) -> Option<String> {
    for l in labels?.as_array()? {
        let Some(n) = l.as_object().and_then(|o| o.get("name")).and_then(Value::as_str) else { continue };
        if n.chars().map(char::len_utf16).sum::<usize>() <= 20 && linea(Some(&Value::String(n.to_string())), 20).as_deref() == Some(n) && prioridad_ok(n) {
            return Some(n.to_string());
        }
    }
    None
}

fn asignado_de(assignees: Option<&Value>) -> Option<String> {
    for a in assignees?.as_array()? {
        if let Some(l) = a.as_object().and_then(|o| o.get("login")).and_then(Value::as_str) {
            if login_ok(l) {
                return Some(l.to_string());
            }
        }
    }
    None
}

pub fn gh_yo(run: &dyn GhRun, def: &ConectorGh) -> Res<Yo> {
    let salida = correr(run, &def.base.falta_conector.mensaje, &["api", "user", "--jq", ".login"], None)?;
    let l = trim_js(&salida);
    if !login_ok(l) {
        return err(NO_ENTIENDO);
    }
    Ok(Yo { id: Some(l.to_string()), nombre: l.to_string() })
}

pub fn gh_lista(run: &dyn GhRun, def: &ConectorGh, repo: &str) -> Res<Vec<Ticket>> {
    let r = repo_valido(repo)?;
    let data = json_de(&correr(run, &def.base.falta_conector.mensaje, &["issue", "list", "--repo", r, "--state", "open", "--limit", "200", "--json", "number,title,assignees,labels,url,body"], None)?)?;
    let Some(xs) = data.as_array() else { return err(NO_ENTIENDO) };
    let mut out = Vec::new();
    for x in xs {
        let Some(o) = x.as_object() else { continue };
        let Some(Value::Number(n)) = o.get("number") else { continue };
        let numero = num_valor(n.as_f64().unwrap_or(f64::NAN)).to_string();
        let Some(id) = id_normalizado(&def.base.id_regex, def.base.id_mayusculas, &Value::String(numero)) else { continue };
        let mut t = Ticket::nuevo(id.clone(), linea(o.get("title"), 300).unwrap_or(id));
        t.estado = Some("abierto".into());
        t.proyecto = Some(r.to_string());
        t.url = url_de_github(o.get("url"));
        if let Some(a) = asignado_de(o.get("assignees")) {
            t.responsable = Some(a.clone());
            t.responsable_id = Some(a);
        }
        t.prioridad = prioridad_de(o.get("labels"));
        t.descripcion = linea(o.get("body"), 200);
        out.push(t);
    }
    Ok(out)
}

pub fn gh_detalle(run: &dyn GhRun, def: &ConectorGh, id: &str, proyecto: Option<&str>) -> Res<Detalle> {
    let r = repo_del_issue(proyecto)?;
    let data = json_de(&correr(run, &def.base.falta_conector.mensaje, &["issue", "view", numero(id)?, "--repo", r, "--json", "comments"], None)?)?;
    let Some(o) = data.as_object() else { return err(NO_ENTIENDO) };
    let comentarios: Vec<Value> = o
        .get("comments")
        .and_then(Value::as_array)
        .map(|cs| {
            cs.iter()
                .filter_map(Value::as_object)
                .map(|c| {
                    let autor = c.get("author").and_then(Value::as_object).and_then(|a| linea(a.get("login"), 80));
                    json!({ "autor": autor, "cuerpo": c.get("body"), "fecha": c.get("createdAt") })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Detalle { criterios: vec![], comentarios: norm_comentarios(&Value::Array(comentarios)), minutos: None, descripcion: None })
}

pub fn gh_accion(run: &dyn GhRun, def: &ConectorGh, proyecto: Option<&str>, a: Accion, i: &AccionInput, me: Option<&Yo>) -> Res<()> {
    let r = repo_del_issue(proyecto)?;
    let id = numero(&i.ticket)?;
    let falta = def.base.falta_conector.mensaje.as_str();
    match a {
        Accion::Estado => match i.estado.as_deref() {
            Some("cerrado") => correr(run, falta, &["issue", "close", id, "--repo", r], None).map(|_| ()),
            Some("abierto") => correr(run, falta, &["issue", "reopen", id, "--repo", r], None).map(|_| ()),
            _ => err("Ese estado no está en el flujo de GitHub Issues."),
        },
        Accion::Tomar => {
            let quien = login(i.persona.as_ref().and_then(|p| p.as_deref()))?;
            correr(run, falta, &["issue", "edit", id, "--repo", r, "--add-assignee", quien], None).map(|_| ())
        }
        Accion::Soltar => {
            let quien = login(me.and_then(|m| m.id.as_deref()))?;
            correr(run, falta, &["issue", "edit", id, "--repo", r, "--remove-assignee", quien], None).map(|_| ())
        }
        Accion::Comentar => match i.cuerpo.as_deref() {
            // El cuerpo va por stdin: nunca como argumento.
            Some(c) if !trim_js(c).is_empty() => correr(run, falta, &["issue", "comment", id, "--repo", r, "--body-file", "-"], Some(c)).map(|_| ()),
            _ => err("El comentario está vacío."),
        },
        _ => err("GitHub no permite esa acción desde Sloth."),
    }
}

/// `gh` sobre el `ProcesoRun` común: oculto en Windows, con timeout, con el cuerpo por stdin y, si hay, la cancelación de
/// «Actualizar».
pub struct GhConProceso<'a> {
    pub proceso: &'a dyn ProcesoRun,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub timeout: Duration,
    pub cancelado: Option<&'a AtomicBool>,
}

impl GhRun for GhConProceso<'_> {
    fn run(&self, args: &[String], input: Option<&str>) -> GhOut {
        let p = Peticion { exe: "gh".into(), args: args.to_vec(), prompt: input.unwrap_or("").to_string(), cwd: self.cwd.clone(), env: self.env.clone(), timeout: self.timeout, verbatim: false, arbol: false, stdin_abierto: false };
        match self.proceso.correr(&p, self.cancelado, &mut |_| Mirada::Seguir) {
            SalidaRun::Termino { code, stdout, stderr } => GhOut { code: code.unwrap_or(-1), stdout, stderr, ..GhOut::default() },
            SalidaRun::Plazo => GhOut { code: -1, timed_out: true, ..GhOut::default() },
            SalidaRun::NoAbrio(_) => GhOut { code: -1, missing: true, ..GhOut::default() },
            SalidaRun::Cortada | SalidaRun::Cancelada => GhOut { code: -1, stderr: "Consulta cancelada.".into(), ..GhOut::default() },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::tickets::conectores::conector_por_id;
    use crate::features::tickets::conector::ConectorDef;
    use std::cell::RefCell;

    fn gh() -> &'static ConectorGh {
        match conector_por_id("github").unwrap() {
            ConectorDef::Gh(g) => g,
            ConectorDef::Mcp(_) => panic!("github no es gh"),
        }
    }

    fn me() -> Yo {
        Yo { id: Some("tomy".into()), nombre: "tomy".into() }
    }

    struct Falso {
        out: GhOut,
        llamadas: RefCell<Vec<(Vec<String>, Option<String>)>>,
    }

    impl GhRun for Falso {
        fn run(&self, args: &[String], input: Option<&str>) -> GhOut {
            self.llamadas.borrow_mut().push((args.to_vec(), input.map(str::to_string)));
            self.out.clone()
        }
    }

    fn falso(out: GhOut) -> Falso {
        Falso { out, llamadas: RefCell::new(vec![]) }
    }

    fn sale(stdout: &str) -> GhOut {
        GhOut { stdout: stdout.into(), ..GhOut::default() }
    }

    fn args(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|x| x.to_string()).collect()
    }

    fn accion(a: Accion, i: AccionInput, yo: Option<&Yo>) -> (Res<()>, Vec<(Vec<String>, Option<String>)>) {
        let f = falso(GhOut::default());
        let r = gh_accion(&f, gh(), Some("octo-1/repo.x"), a, &i, yo);
        let l = f.llamadas.borrow().clone();
        (r, l)
    }

    fn input(ticket: &str) -> AccionInput {
        AccionInput::nuevo(ticket)
    }

    #[test]
    fn repo_valido_solo_acepta_dueno_repo() {
        assert_eq!(repo_valido("octo/hola.mundo").unwrap(), "octo/hola.mundo");
        for malo in ["-x/y", "a/b c", "a/b/c", ".a/b", "a/-b", "", "a", "a/\n"] {
            assert!(repo_valido(malo).unwrap_err().mensaje().contains("dueño/repo"), "{malo}");
        }
    }

    #[test]
    fn gh_yo_lee_el_login() {
        let f = falso(sale("tomy\n"));
        assert_eq!(gh_yo(&f, gh()).unwrap(), me());
        assert_eq!(*f.llamadas.borrow(), vec![(args(&["api", "user", "--jq", ".login"]), None)]);
        assert!(gh_yo(&falso(sale("--admin")), gh()).unwrap_err().mensaje().contains("no entiendo"));
    }

    #[test]
    fn gh_lista_pide_los_issues_abiertos_y_los_valida() {
        let issues = json!([
            { "number": 7, "title": "Arreglar\nel login", "url": "https://github.com/o/r/issues/7",
              "assignees": [{ "login": "--admin" }, { "login": "tomy" }], "labels": [{ "name": "bug" }, { "name": "P1" }],
              "body": "Línea uno\r\nLínea dos\u{202e}" },
            { "number": 8, "title": "Sin url de GitHub", "url": "https://evil.com/github.com/x", "assignees": [], "labels": [], "body": "" },
            { "number": 0, "title": "id cero" },
            { "number": 1.5, "title": "id con coma" },
            { "number": "9", "title": "id texto" },
            { "number": 12345678, "title": "id largo" },
            null
        ]);
        let f = falso(sale(&issues.to_string()));
        let tickets = gh_lista(&f, gh(), "o/r").unwrap();
        assert_eq!(*f.llamadas.borrow(), vec![(args(&["issue", "list", "--repo", "o/r", "--state", "open", "--limit", "200", "--json", "number,title,assignees,labels,url,body"]), None)]);
        assert_eq!(
            serde_json::to_value(&tickets).unwrap(),
            json!([
                { "id": "7", "titulo": "Arreglar el login", "estado": "abierto", "proyecto": "o/r", "url": "https://github.com/o/r/issues/7",
                  "responsable": "tomy", "responsableId": "tomy", "prioridad": "P1", "descripcion": "Línea uno Línea dos" },
                { "id": "8", "titulo": "Sin url de GitHub", "estado": "abierto", "proyecto": "o/r" }
            ])
        );
    }

    #[test]
    fn gh_lista_no_corre_gh_con_un_repo_invalido_y_no_acepta_cualquier_salida() {
        let f = falso(GhOut::default());
        assert!(gh_lista(&f, gh(), "-x/y").unwrap_err().mensaje().contains("dueño/repo"));
        assert!(f.llamadas.borrow().is_empty());
        for s in ["no es json", "{}"] {
            assert_eq!(gh_lista(&falso(sale(s)), gh(), "o/r").unwrap_err().mensaje(), "gh devolvió algo que no entiendo.");
        }
    }

    #[test]
    fn gh_detalle_trae_los_comentarios() {
        let comments = json!([
            { "author": { "login": "ana" }, "body": "Hola", "createdAt": "2026-11-10T10:00:00Z" },
            { "author": null, "body": "Sin autor" },
            { "author": { "login": "x" }, "body": "" }
        ]);
        let f = falso(sale(&json!({ "comments": comments }).to_string()));
        let d = gh_detalle(&f, gh(), "7", Some("o/r")).unwrap();
        assert_eq!(
            serde_json::to_value(&d.comentarios).unwrap(),
            json!([{ "autor": "ana", "cuerpo": "Hola", "fecha": "2026-11-10T10:00:00Z" }, { "autor": "Sin nombre", "cuerpo": "Sin autor" }])
        );
        assert!(d.criterios.is_empty() && d.minutos.is_none());
        assert_eq!(*f.llamadas.borrow(), vec![(args(&["issue", "view", "7", "--repo", "o/r", "--json", "comments"]), None)]);
        assert!(gh_detalle(&falso(GhOut::default()), gh(), "1;x", Some("o/r")).unwrap_err().mensaje().contains("número"));
    }

    #[test]
    fn gh_accion_arma_los_argumentos_exactos_de_cada_accion() {
        let base = ["--repo", "octo-1/repo.x"];
        let con = |xs: &[&str], mas: &[&str]| args(&[xs, &base[..], mas].concat());
        let mut i = input("42");
        i.estado = Some("cerrado".into());
        assert_eq!(accion(Accion::Estado, i.clone(), Some(&me())).1, vec![(con(&["issue", "close", "42"], &[]), None)]);
        i.estado = Some("abierto".into());
        assert_eq!(accion(Accion::Estado, i, Some(&me())).1, vec![(con(&["issue", "reopen", "42"], &[]), None)]);
        let mut t = input("42");
        t.persona = Some(Some("tomy".into()));
        assert_eq!(accion(Accion::Tomar, t, Some(&me())).1, vec![(con(&["issue", "edit", "42"], &["--add-assignee", "tomy"]), None)]);
        let mut s = input("42");
        s.persona = Some(None);
        assert_eq!(accion(Accion::Soltar, s, Some(&me())).1, vec![(con(&["issue", "edit", "42"], &["--remove-assignee", "tomy"]), None)]);
        let mut c = input("42");
        c.cuerpo = Some("Listo".into());
        assert_eq!(accion(Accion::Comentar, c, Some(&me())).1, vec![(con(&["issue", "comment", "42"], &["--body-file", "-"]), Some("Listo".into()))]);
    }

    #[test]
    fn el_cuerpo_del_comentario_va_solo_por_stdin() {
        let mut c = input("42");
        c.cuerpo = Some("--foo; rm -rf /".into());
        let (_, l) = accion(Accion::Comentar, c, Some(&me()));
        assert_eq!(l[0].1.as_deref(), Some("--foo; rm -rf /"));
        assert!(l[0].0.iter().all(|a| !a.contains("--foo") && !a.contains("rm -rf")));
    }

    #[test]
    fn gh_accion_valida_todo_antes_de_correr_gh() {
        let con = |f: &dyn Fn(&mut AccionInput)| {
            let mut i = input("42");
            f(&mut i);
            i
        };
        let casos: Vec<(&str, Accion, AccionInput, Option<Yo>, &str)> = vec![
            ("id con punto y coma", Accion::Estado, con(&|i| { i.ticket = "1;x".into(); i.estado = Some("cerrado".into()) }), Some(me()), "número"),
            ("id cero", Accion::Estado, con(&|i| { i.ticket = "0".into(); i.estado = Some("cerrado".into()) }), Some(me()), "número"),
            ("id negativo", Accion::Estado, con(&|i| { i.ticket = "-1".into(); i.estado = Some("cerrado".into()) }), Some(me()), "número"),
            ("otro estado", Accion::Estado, con(&|i| i.estado = Some("en_curso".into())), Some(me()), "flujo de GitHub Issues"),
            ("login que es una opción", Accion::Tomar, con(&|i| i.persona = Some(Some("--admin".into()))), Some(me()), "usuario de GitHub"),
            ("soltar sin saber quién soy", Accion::Soltar, con(&|i| i.persona = Some(None)), None, "usuario de GitHub"),
            ("soltar con un login raro", Accion::Soltar, con(&|i| i.persona = Some(None)), Some(Yo { id: Some("--admin".into()), nombre: "x".into() }), "usuario de GitHub"),
            ("comentario vacío", Accion::Comentar, con(&|i| i.cuerpo = Some("  ".into())), Some(me()), "vacío"),
            ("criterio", Accion::Criterio, con(&|i| { i.criterio_id = Some("x".into()); i.hecho = Some(true) }), Some(me()), "GitHub no permite esa acción desde Sloth."),
            ("horas", Accion::Horas, con(&|i| i.minutos = Some(30)), Some(me()), "GitHub no permite esa acción desde Sloth."),
        ];
        for (nombre, a, i, yo, motivo) in casos {
            let f = falso(GhOut::default());
            let e = gh_accion(&f, gh(), Some("o/r"), a, &i, yo.as_ref()).unwrap_err().mensaje();
            assert!(e.contains(motivo), "{nombre}: {e}");
            assert!(f.llamadas.borrow().is_empty(), "{nombre}");
        }
        let f = falso(GhOut::default());
        for proyecto in [Some("a/b c"), None, Some("--repo=x/y")] {
            let mut i = input("42");
            i.estado = Some("cerrado".into());
            assert!(gh_accion(&f, gh(), proyecto, Accion::Estado, &i, Some(&me())).unwrap_err().mensaje().contains("de qué repo"), "{proyecto:?}");
            assert!(gh_detalle(&f, gh(), "42", proyecto).unwrap_err().mensaje().contains("de qué repo"), "{proyecto:?}");
        }
        assert!(f.llamadas.borrow().is_empty());
    }

    #[test]
    fn el_detalle_y_las_escrituras_van_al_repo_de_donde_salio_el_issue() {
        let f = falso(sale("{\"comments\":[]}"));
        gh_detalle(&f, gh(), "7", Some("dueno/repo-a")).unwrap();
        let mut e = input("7");
        e.estado = Some("cerrado".into());
        gh_accion(&f, gh(), Some("dueno/repo-a"), Accion::Estado, &e, Some(&me())).unwrap();
        let mut c = input("7");
        c.cuerpo = Some("Hola".into());
        gh_accion(&f, gh(), Some("dueno/repo-a"), Accion::Comentar, &c, Some(&me())).unwrap();
        let l = f.llamadas.borrow();
        assert_eq!(l.len(), 3);
        for (a, _) in l.iter() {
            assert_eq!(a[a.iter().position(|x| x == "--repo").unwrap() + 1], "dueno/repo-a");
        }
    }

    #[test]
    fn los_errores_de_gh_se_explican() {
        let falta = gh().base.falta_conector.mensaje.clone();
        let casos: Vec<(GhOut, String)> = vec![
            (GhOut { missing: true, code: -1, ..GhOut::default() }, falta),
            (GhOut { code: 1, stderr: "To get started with GitHub CLI, please run:  gh auth login".into(), ..GhOut::default() }, "gh no tiene sesión iniciada: corré `gh auth login`.".into()),
            (GhOut { code: 4, stderr: "HTTP 401: Bad credentials".into(), ..GhOut::default() }, "gh no tiene sesión iniciada: corré `gh auth login`.".into()),
            (GhOut { timed_out: true, code: -1, ..GhOut::default() }, "gh tardó demasiado.".into()),
            (GhOut { code: 1, stderr: "\n\u{1b}[31mGraphQL: Could not resolve to an issue\u{1b}[0m\nmás".into(), ..GhOut::default() }, "[31mGraphQL: Could not resolve to an issue [0m".into()),
            (GhOut { code: 2, ..GhOut::default() }, "gh terminó con código 2.".into()),
        ];
        for (out, msg) in casos {
            assert_eq!(gh_yo(&falso(out), gh()).unwrap_err().mensaje(), msg);
        }
        let largo = gh_yo(&falso(GhOut { code: 1, stderr: "x".repeat(500), ..GhOut::default() }), gh()).unwrap_err().mensaje();
        assert_eq!(largo.chars().count(), 200);
    }
}
