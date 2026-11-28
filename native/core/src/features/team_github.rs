//! GitHub para la vista «Equipo», solo lectura: `git remote get-url origin` de cada repo y `gh pr list` por repo. Sin
//! shell (lista de argumentos), oculto y con timeout. Equivale a src/main/features/team-github.ts.
use super::proceso::{Ejecutor, Salida};
use super::team::{parsear_lista_de_prs, remoto_de_github, repo_valido, TeamPr};
use regex::Regex;
use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

pub const PR_FIELDS: &str = "number,title,author,headRefName,isDraft,reviewDecision,statusCheckRollup,updatedAt,createdAt,url";
const GH_TIMEOUT: Duration = Duration::from_secs(30);
const GIT_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_REPOS: usize = 20;
const MAX_CARPETAS: usize = 60;
const PARALELO: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorGh {
    Falta,
    Sesion,
    Otro(String),
}

impl ErrorGh {
    pub fn mensaje(&self) -> String {
        match self {
            ErrorGh::Falta => "No encontré «gh» (GitHub CLI). Instalalo desde https://cli.github.com y corré «gh auth login» en una terminal.".into(),
            ErrorGh::Sesion => "gh no tiene sesión iniciada: corré «gh auth login» en una terminal y tocá «Actualizar».".into(),
            ErrorGh::Otro(m) => m.clone(),
        }
    }

    fn general(&self) -> bool {
        !matches!(self, ErrorGh::Otro(_))
    }
}

pub fn es_error_de_sesion(stderr: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)gh auth login|not logged in|authentication required|HTTP 401|Bad credentials|GH_TOKEN").unwrap()).is_match(stderr)
}

/// Las dos últimas líneas con texto del stderr, en una sola, acotadas.
pub fn stderr_corto(s: &str) -> String {
    let lineas: Vec<&str> = s.split('\n').map(|l| l.trim_end_matches('\r').trim()).filter(|l| !l.is_empty()).collect();
    let linea = lineas[lineas.len().saturating_sub(2)..].join(" ");
    let corta = super::team::recortar_utf16(&linea, 240);
    if corta.is_empty() {
        "error desconocido".into()
    } else {
        corta
    }
}

/// `owner/repo` de GitHub del remoto origin de una carpeta, o None.
pub fn repo_de_carpeta(ejecutor: &dyn Ejecutor, dir: &str) -> Option<String> {
    if !Path::new(dir).is_dir() {
        return None;
    }
    let args: Vec<String> = ["remote", "get-url", "origin"].iter().map(|s| s.to_string()).collect();
    let r = ejecutor.ejecutar("git", &args, Some(Path::new(dir)), GIT_TIMEOUT);
    if r.falta || r.code != 0 {
        return None;
    }
    remoto_de_github(Some(r.stdout.trim()))
}

pub fn args_de_lista(repo: &str) -> Result<Vec<String>, String> {
    if !repo_valido(repo) {
        return Err("Repo inválido.".into());
    }
    Ok(["pr", "list", "--repo", repo, "--state", "open", "--json", PR_FIELDS, "--limit", "50"].iter().map(|s| s.to_string()).collect())
}

/// Qué le pasó a un `gh pr list` que no salió bien.
pub fn error_de_salida(r: &Salida) -> Option<ErrorGh> {
    if r.falta {
        return Some(ErrorGh::Falta);
    }
    if r.vencio {
        return Some(ErrorGh::Otro(format!("gh tardó más de {} s.", GH_TIMEOUT.as_secs())));
    }
    if r.code != 0 {
        return Some(if es_error_de_sesion(&r.stderr) { ErrorGh::Sesion } else { ErrorGh::Otro(stderr_corto(&r.stderr)) });
    }
    None
}

pub fn listar_prs(ejecutor: &dyn Ejecutor, repo: &str) -> Result<Vec<TeamPr>, ErrorGh> {
    let args = args_de_lista(repo).map_err(ErrorGh::Otro)?;
    let r = ejecutor.ejecutar("gh", &args, None, GH_TIMEOUT);
    if let Some(e) = error_de_salida(&r) {
        return Err(e);
    }
    parsear_lista_de_prs(&r.stdout, repo).map_err(ErrorGh::Otro)
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct TraidoDeGithub {
    pub repos: Vec<String>,
    pub prs: Vec<TeamPr>,
    /// Errores por repo (sin acceso, no existe…), en el orden de los repos.
    pub errores: Vec<(String, String)>,
    /// Error general (gh no está o no tiene sesión): no hay datos.
    pub fatal: Option<String>,
}

/// Repos distintos de GitHub entre las carpetas dadas, y sus PRs abiertos.
pub fn traer_github(ejecutor: &dyn Ejecutor, carpetas: &[String]) -> TraidoDeGithub {
    let mut vistas = HashSet::new();
    let unicas: Vec<&str> = carpetas.iter().map(|d| d.trim()).filter(|d| !d.is_empty() && vistas.insert(*d)).take(MAX_CARPETAS).collect();
    let por_carpeta: Vec<Option<String>> = std::thread::scope(|s| {
        let hilos: Vec<_> = unicas.iter().map(|d| s.spawn(|| repo_de_carpeta(ejecutor, d))).collect();
        hilos.into_iter().map(|h| h.join().ok().flatten()).collect()
    });
    let mut repos: Vec<String> = Vec::new();
    for r in por_carpeta.into_iter().flatten() {
        if !repos.iter().any(|v| v.eq_ignore_ascii_case(&r)) {
            repos.push(r);
        }
    }
    repos.truncate(MAX_REPOS);
    let mut out = TraidoDeGithub { repos, ..TraidoDeGithub::default() };
    if out.repos.is_empty() {
        return out;
    }
    let siguiente = AtomicUsize::new(0);
    let resultados: Mutex<Vec<Option<Result<Vec<TeamPr>, ErrorGh>>>> = Mutex::new(vec![None; out.repos.len()]);
    let fatal: Mutex<Option<String>> = Mutex::new(None);
    std::thread::scope(|s| {
        for _ in 0..PARALELO.min(out.repos.len()) {
            s.spawn(|| loop {
                if fatal.lock().unwrap_or_else(|e| e.into_inner()).is_some() {
                    break;
                }
                let i = siguiente.fetch_add(1, Ordering::SeqCst);
                let Some(repo) = out.repos.get(i) else { break };
                let r = listar_prs(ejecutor, repo);
                if let Err(e) = &r {
                    if e.general() {
                        fatal.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert(e.mensaje());
                    }
                }
                resultados.lock().unwrap_or_else(|e| e.into_inner())[i] = Some(r);
            });
        }
    });
    out.fatal = fatal.into_inner().unwrap_or_else(|e| e.into_inner());
    for (repo, r) in out.repos.iter().zip(resultados.into_inner().unwrap_or_else(|e| e.into_inner())) {
        match r {
            Some(Ok(prs)) => out.prs.extend(prs),
            Some(Err(e)) if !e.general() => out.errores.push((repo.clone(), e.mensaje())),
            _ => {}
        }
    }
    if out.fatal.is_some() {
        out.prs.clear();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Responde según el comando y, para gh, según el repo del argumento `--repo`.
    struct Guion {
        remotos: Vec<(String, Salida)>,
        gh: Vec<(String, Salida)>,
        llamadas: Mutex<Vec<String>>,
    }

    impl Ejecutor for Guion {
        fn ejecutar(&self, cmd: &str, args: &[String], cwd: Option<&Path>, _t: Duration) -> Salida {
            self.llamadas.lock().unwrap().push(format!("{cmd} {}", args.join(" ")));
            if cmd == "git" {
                let d = cwd.unwrap().to_string_lossy().into_owned();
                return self.remotos.iter().find(|(c, _)| *c == d).map(|(_, s)| s.clone()).unwrap_or_else(|| Salida::error(128, "fatal: no remote"));
            }
            let repo = &args[args.iter().position(|a| a == "--repo").unwrap() + 1];
            self.gh.iter().find(|(r, _)| r == repo).map(|(_, s)| s.clone()).unwrap_or_else(|| Salida::ok("[]"))
        }
    }

    fn lista_de(repo: &str, n: u32) -> String {
        format!(r#"[{{"number": {n}, "title": "T", "author": {{"login": "ana"}}, "url": "https://github.com/{repo}/pull/{n}"}}]"#)
    }

    fn carpeta(nombre: &str) -> String {
        let d = std::env::temp_dir().join(format!("sloth-teamgh-{}-{nombre}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d.to_string_lossy().into_owned()
    }

    #[test]
    fn los_errores_de_sesion_se_reconocen() {
        for s in ["To get started with GitHub CLI, please run:  gh auth login", "You are not logged in", "HTTP 401: Bad credentials (https://api.github.com/graphql)", "set GH_TOKEN", "authentication required"] {
            assert!(es_error_de_sesion(s), "{s}");
        }
        assert!(!es_error_de_sesion("Could not resolve to a Repository"));
    }

    #[test]
    fn stderr_corto_se_queda_con_las_ultimas_dos_lineas() {
        assert_eq!(stderr_corto("uno\r\n\r\ndos\ntres\n"), "dos tres");
        assert_eq!(stderr_corto(""), "error desconocido");
        assert_eq!(stderr_corto(&"x".repeat(500)).len(), 240);
    }

    #[test]
    fn los_args_de_lista_validan_el_repo() {
        let a = args_de_lista("o/r").unwrap();
        assert_eq!(&a[..4], ["pr", "list", "--repo", "o/r"]);
        assert_eq!(&a[a.len() - 2..], ["--limit", "50"]);
        assert!(a.contains(&PR_FIELDS.to_string()));
        assert_eq!(args_de_lista("o/r;rm").unwrap_err(), "Repo inválido.");
    }

    #[test]
    fn error_de_salida_distingue_falta_tiempo_sesion_y_otros() {
        assert_eq!(error_de_salida(&Salida { falta: true, code: -1, ..Salida::default() }), Some(ErrorGh::Falta));
        assert_eq!(error_de_salida(&Salida { vencio: true, code: -1, ..Salida::default() }), Some(ErrorGh::Otro("gh tardó más de 30 s.".into())));
        assert_eq!(error_de_salida(&Salida::error(4, "gh auth login")), Some(ErrorGh::Sesion));
        assert_eq!(error_de_salida(&Salida::error(1, "GraphQL: Could not resolve\n")), Some(ErrorGh::Otro("GraphQL: Could not resolve".into())));
        assert_eq!(error_de_salida(&Salida::ok("[]")), None);
        assert!(ErrorGh::Falta.mensaje().contains("cli.github.com"));
        assert!(ErrorGh::Sesion.mensaje().contains("Actualizar"));
    }

    #[test]
    fn repo_de_carpeta_lee_el_remoto_origin() {
        let d = carpeta("a");
        let g = Guion { remotos: vec![(d.clone(), Salida::ok("git@github.com:org/app.git\n"))], gh: vec![], llamadas: Mutex::new(vec![]) };
        assert_eq!(repo_de_carpeta(&g, &d).as_deref(), Some("org/app"));
        assert_eq!(g.llamadas.lock().unwrap()[0], "git remote get-url origin");
        assert_eq!(repo_de_carpeta(&g, "C:/no/existe/jamas"), None);
        let g2 = Guion { remotos: vec![(d.clone(), Salida::ok("https://gitlab.com/o/r\n"))], gh: vec![], llamadas: Mutex::new(vec![]) };
        assert_eq!(repo_de_carpeta(&g2, &d), None);
        let g3 = Guion { remotos: vec![(d.clone(), Salida { falta: true, code: -1, ..Salida::default() })], gh: vec![], llamadas: Mutex::new(vec![]) };
        assert_eq!(repo_de_carpeta(&g3, &d), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn traer_github_junta_prs_sin_repetir_repos_aunque_cambien_las_mayusculas() {
        let (a, b, c) = (carpeta("t1"), carpeta("t2"), carpeta("t3"));
        let g = Guion {
            remotos: vec![(a.clone(), Salida::ok("https://github.com/Org/App.git")), (b.clone(), Salida::ok("https://github.com/org/app")), (c.clone(), Salida::ok("git@github.com:org/otra.git"))],
            gh: vec![("Org/App".into(), Salida::ok(&lista_de("Org/App", 1))), ("org/otra".into(), Salida::ok(&lista_de("org/otra", 2)))],
            llamadas: Mutex::new(vec![]),
        };
        let r = traer_github(&g, &[a.clone(), format!(" {b} "), c.clone(), a.clone(), "  ".into()]);
        assert_eq!(r.repos, vec!["Org/App", "org/otra"]);
        assert_eq!(r.prs.iter().map(|p| (p.repo.as_str(), p.number)).collect::<Vec<_>>(), vec![("Org/App", 1), ("org/otra", 2)]);
        assert!(r.errores.is_empty() && r.fatal.is_none());
        for d in [a, b, c] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    #[test]
    fn traer_github_guarda_el_error_de_un_repo_sin_tirar_los_demas() {
        let (a, b) = (carpeta("e1"), carpeta("e2"));
        let g = Guion {
            remotos: vec![(a.clone(), Salida::ok("https://github.com/o/uno")), (b.clone(), Salida::ok("https://github.com/o/dos"))],
            gh: vec![("o/uno".into(), Salida::error(1, "GraphQL: Could not resolve to a Repository")), ("o/dos".into(), Salida::ok(&lista_de("o/dos", 5)))],
            llamadas: Mutex::new(vec![]),
        };
        let r = traer_github(&g, &[a.clone(), b.clone()]);
        assert_eq!(r.errores, vec![("o/uno".to_string(), "GraphQL: Could not resolve to a Repository".to_string())]);
        assert_eq!(r.prs.len(), 1);
        assert!(r.fatal.is_none());
        for d in [a, b] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    #[test]
    fn traer_github_sin_sesion_es_fatal_y_no_deja_prs() {
        let (a, b) = (carpeta("f1"), carpeta("f2"));
        let g = Guion {
            remotos: vec![(a.clone(), Salida::ok("https://github.com/o/uno")), (b.clone(), Salida::ok("https://github.com/o/dos"))],
            gh: vec![("o/uno".into(), Salida::ok(&lista_de("o/uno", 1))), ("o/dos".into(), Salida::error(4, "gh auth login"))],
            llamadas: Mutex::new(vec![]),
        };
        let r = traer_github(&g, &[a.clone(), b.clone()]);
        assert_eq!(r.fatal, Some(ErrorGh::Sesion.mensaje()));
        assert!(r.prs.is_empty());
        for d in [a, b] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    #[test]
    fn traer_github_sin_repos_de_github_no_llama_a_gh() {
        let a = carpeta("n1");
        let g = Guion { remotos: vec![], gh: vec![], llamadas: Mutex::new(vec![]) };
        let r = traer_github(&g, &[a.clone()]);
        assert_eq!(r, TraidoDeGithub::default());
        assert!(g.llamadas.lock().unwrap().iter().all(|l| l.starts_with("git ")));
        let _ = std::fs::remove_dir_all(a);
    }
}
