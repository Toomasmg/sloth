//! Canales `feat:team:*` en Rust: la vista «Equipo», en qué anda cada uno. GitHub (gh, solo lectura) se pide al abrir la vista
//! o con «Actualizar»; los tickets son los del conector activo de Tickets, que Equipo lee en memoria (`Tickets::para_equipo`) y
//! no guarda ni consulta por su cuenta. Lo puro (cruce de personas, team.json) está en `sloth_core::features::team*`.
use super::tickets::Tickets;
use super::arg;
use super::comun::{ahora_ms, espacios, texto};
use crate::entorno::Entorno;
use crate::router::Router;
use serde_json::{json, Map, Value};
use sloth_core::features::proceso::Ejecutor;
use sloth_core::features::team::{
    armar_personas, comparar_es, personas_de, personas_elegidas_equipo, tickets_activos, url_de_pr_valida, Categoria, EntradaPersonas, Estado, Mapeo, PersonaConector, TeamTicket, Ticket, NADIE,
};
use sloth_core::features::team_estado::{aviso_solo_lectura, Almacen, Github, Registro};
use sloth_core::features::team_github::traer_github;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

pub const NOMBRE: &str = "team";

fn tomar<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn volcar(registro: Registro) {
    for m in registro {
        sloth_core::logger_global::aviso(NOMBRE, &m);
    }
}

/// Lo que trajo Tickets, tipado para el cruce de personas.
struct DelConector {
    tp: Value,
    tickets: Vec<TeamTicket>,
}

impl DelConector {
    fn de(tp: Value) -> DelConector {
        let estados: Vec<Estado> = tp
            .get("estados")
            .and_then(Value::as_array)
            .map(|xs| {
                xs.iter()
                    .filter_map(|e| {
                        let categoria: Categoria = serde_json::from_value(e.get("categoria")?.clone()).ok()?;
                        Some(Estado { clave: texto(e, "clave")?, nombre: texto(e, "nombre").unwrap_or_default(), categoria })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let crudos: Vec<Ticket> = tp
            .get("tickets")
            .and_then(Value::as_array)
            .map(|xs| {
                xs.iter()
                    .filter_map(|t| {
                        Some(Ticket {
                            id: texto(t, "id")?,
                            titulo: texto(t, "titulo").unwrap_or_default(),
                            estado: texto(t, "estado"),
                            proyecto: texto(t, "proyecto"),
                            url: texto(t, "url"),
                            responsable: texto(t, "responsable"),
                            responsable_id: texto(t, "responsableId"),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let tickets = if tp.get("conector").is_some_and(|c| !c.is_null()) { tickets_activos(&crudos, &estados) } else { Vec::new() };
        DelConector { tp, tickets }
    }

    fn conector_id(&self) -> Option<String> {
        self.tp.get("conector").and_then(|c| texto(c, "id"))
    }

    fn personas(&self) -> Vec<PersonaConector> {
        let elegidas: Vec<String> = self.tp.pointer("/filtro/personasElegidas").and_then(Value::as_array).map(|xs| xs.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
        let conocidas: Option<Vec<(String, String)>> = self.tp.get("personas").and_then(Value::as_array).map(|xs| xs.iter().filter_map(|p| Some((texto(p, "id")?, texto(p, "nombre").unwrap_or_default()))).collect());
        let mut out = personas_de(&self.tickets);
        out.extend(personas_elegidas_equipo(&elegidas, conocidas.as_deref()));
        out
    }
}

pub struct Team {
    entorno: Arc<Entorno>,
    ejecutor: Arc<dyn Ejecutor>,
    tickets: Arc<Tickets>,
    almacen: Mutex<Option<(PathBuf, Almacen)>>,
    en_curso: Mutex<bool>,
    termino: Condvar,
}

impl Team {
    fn con<T>(&self, f: impl FnOnce(&mut Almacen) -> T) -> Result<T, String> {
        let archivo = self.entorno.carpeta_features()?.join("team.json");
        let mut g = tomar(&self.almacen);
        if g.as_ref().is_none_or(|(a, _)| *a != archivo) {
            let mut registro = Registro::new();
            let a = Almacen::cargar(archivo.clone(), u128::from(ahora_ms()), &mut registro);
            volcar(registro);
            *g = Some((archivo, a));
        }
        Ok(f(&mut g.as_mut().expect("recién cargado").1))
    }

    fn snapshot(&self) -> Result<Value, String> {
        let dc = DelConector::de(self.tickets.para_equipo());
        let gh_corriendo = *tomar(&self.en_curso);
        self.con(|a| {
            let mut registro = Registro::new();
            let mapping = a.mapeo_activo(dc.conector_id().as_deref(), &mut registro);
            volcar(registro);
            let personas = dc.personas();
            let gh = &a.estado.github;
            let vista = armar_personas(&EntradaPersonas { prs: &gh.prs, tickets: &dc.tickets, personas: &personas, mapping: &mapping });
            // Personas del conector para el selector de «vincular».
            let personas_conector: Vec<Value> = vista.people.iter().filter(|p| p.en_conector).map(|p| json!({ "key": p.key, "nombre": p.nombre })).collect();
            let mut autores: Vec<(String, Value)> = Vec::new();
            for p in gh.prs.iter().filter(|p| p.is_bot != Some(true)) {
                let mut o = Map::new();
                o.insert("login".into(), json!(p.login));
                if let Some(n) = &p.author_name {
                    o.insert("name".into(), json!(n));
                }
                let k = p.login.to_lowercase();
                match autores.iter_mut().find(|(x, _)| *x == k) {
                    Some(e) => e.1 = Value::Object(o),
                    None => autores.push((k, Value::Object(o))),
                }
            }
            let mut autores: Vec<Value> = autores.into_iter().map(|(_, v)| v).collect();
            autores.sort_by(|x, y| comparar_es(x["login"].as_str().unwrap_or(""), y["login"].as_str().unwrap_or("")));
            let mut o = Map::new();
            o.insert("people".into(), serde_json::to_value(&vista.people).unwrap_or(Value::Null));
            o.insert("summary".into(), serde_json::to_value(vista.summary).unwrap_or(Value::Null));
            o.insert("unassigned".into(), serde_json::to_value(&vista.unassigned).unwrap_or(Value::Null));
            o.insert("personasConector".into(), Value::Array(personas_conector));
            o.insert("authors".into(), Value::Array(autores));
            o.insert("mapping".into(), mapping.a_valor());
            o.insert("github".into(), github_vista(gh));
            o.insert("tickets".into(), tickets_vista(&dc.tp));
            o.insert("githubRunning".into(), json!(gh_corriendo));
            if let Some(m) = a.solo_lectura {
                o.insert("aviso".into(), json!(aviso_solo_lectura(m)));
            }
            if a.estado.venia_de_gruv {
                o.insert("veniaDeGruv".into(), json!(true));
            }
            Value::Object(o)
        })
    }

    fn emitir(&self) {
        match self.snapshot() {
            Ok(s) => self.entorno.emitir(NOMBRE, "changed", &[s]),
            Err(e) => sloth_core::logger_global::aviso(NOMBRE, &format!("team: no pude armar la vista: {e}")),
        }
    }

    fn cambio(&self) {
        if let Ok(Err(e)) = self.con(|a| a.guardar()) {
            sloth_core::logger_global::aviso(NOMBRE, &format!("team: no pude guardar team.json: {e}"));
        }
        self.emitir();
    }

    /// Un pedido en curso se espera y se reusa su resultado, como la promesa compartida del TS.
    fn refresh_github(&self) -> Result<Value, String> {
        {
            let mut c = tomar(&self.en_curso);
            if *c {
                while *c {
                    c = self.termino.wait(c).unwrap_or_else(|e| e.into_inner());
                }
                drop(c);
                return self.snapshot();
            }
            *c = true;
        }
        struct Fin<'a>(&'a Team);
        impl Drop for Fin<'_> {
            fn drop(&mut self) {
                *tomar(&self.0.en_curso) = false;
                self.0.termino.notify_all();
            }
        }
        let fin = Fin(self);
        self.emitir();
        let carpetas: Vec<String> = espacios(&self.entorno).iter().filter_map(|w| texto(w, "repoPath")).collect();
        let r = traer_github(self.ejecutor.as_ref(), &carpetas);
        let mut errores = Mapeo::nuevo();
        for (repo, e) in &r.errores {
            errores.insertar(repo, e);
        }
        self.con(|a| a.estado.github = Github { prs: r.prs, repos: r.repos, errors: errores, fatal: r.fatal, fetched_at: Some(ahora_ms() as f64) })?;
        drop(fin);
        self.cambio();
        self.snapshot()
    }

    /// Vincula un login de GitHub con una persona del conector (nada = automático, «-» = no es del conector).
    fn set_mapping(&self, login: &Value, clave: &Value) -> Result<Value, String> {
        let dc = DelConector::de(self.tickets.para_equipo());
        let personas = dc.personas();
        let existe = |k: &str| {
            let vista = armar_personas(&EntradaPersonas { prs: &[], tickets: &dc.tickets, personas: &personas, mapping: &Mapeo::nuevo() });
            k == NADIE || vista.people.iter().any(|p| p.key == k)
        };
        let mut registro = Registro::new();
        let r = self.con(|a| a.vincular(login, clave, dc.conector_id().as_deref(), &existe, &mut registro))?;
        volcar(registro);
        r?;
        self.emitir();
        self.snapshot()
    }

    fn open_pr(&self, url: &Value) -> Result<Value, String> {
        let Some(u) = url.as_str().filter(|u| url_de_pr_valida(u)) else { return Err("Ese link no es de un PR de GitHub.".into()) };
        self.entorno.plataforma.abrir_enlace_externo(u)?;
        Ok(json!(true))
    }
}

fn github_vista(gh: &Github) -> Value {
    let mut o = Map::new();
    o.insert("repos".into(), json!(gh.repos));
    o.insert("errors".into(), gh.errors.a_valor());
    if let Some(f) = &gh.fatal {
        o.insert("fatal".into(), json!(f));
    }
    if let Some(t) = gh.fetched_at {
        o.insert("fetchedAt".into(), json!(t as u64));
    }
    Value::Object(o)
}

fn tickets_vista(tp: &Value) -> Value {
    let mut o = Map::new();
    for k in ["conector", "fetchedAt", "fetchedBy", "lastRun", "lastError", "running", "model", "confirmar", "carpetas"] {
        if let Some(v) = tp.get(k) {
            o.insert(k.into(), v.clone());
        }
    }
    if let Some(f) = tp.get("filtro").filter(|f| f.is_object()) {
        let mut filtro = Map::new();
        filtro.insert("personasElegidas".into(), json!(f.get("personasElegidas").and_then(Value::as_array).map_or(0, Vec::len)));
        for k in ["incluirSinAsignar", "ventanaDias"] {
            if let Some(v) = f.get(k) {
                filtro.insert(k.into(), v.clone());
            }
        }
        filtro.insert("sinTraer".into(), tp.pointer("/pendientes/personas").cloned().unwrap_or_else(|| json!([])));
        filtro.insert("faltaTodo".into(), json!(tp.pointer("/pendientes/todo") == Some(&Value::Bool(true))));
        o.insert("filtro".into(), Value::Object(filtro));
    }
    Value::Object(o)
}

pub fn armar(entorno: Arc<Entorno>, ejecutor: Arc<dyn Ejecutor>, tickets: Arc<Tickets>) -> Arc<Team> {
    let t = Arc::new(Team { entorno, ejecutor, tickets: tickets.clone(), almacen: Mutex::new(None), en_curso: Mutex::new(false), termino: Condvar::new() });
    let debil = Arc::downgrade(&t);
    tickets.al_cambiar(Arc::new(move || {
        if let Some(t) = debil.upgrade() {
            t.emitir();
        }
    }));
    t
}

pub fn registrar(router: &mut Router, entorno: Arc<Entorno>, tickets: Arc<Tickets>) {
    registrar_con(router, armar(entorno, Arc::new(sloth_core::features::proceso::Real), tickets));
}

pub(crate) fn registrar_con(router: &mut Router, t: Arc<Team>) {
    macro_rules! canal {
        ($op:literal, |$f:ident, $a:ident| $cuerpo:expr) => {{
            let $f = t.clone();
            router.registrar(concat!("feat:team:", $op), move |$a: Vec<Value>| {
                let _ = &$a;
                $cuerpo
            });
        }};
    }
    canal!("state", |f, a| f.snapshot());
    canal!("refreshGithub", |f, a| f.refresh_github());
    canal!("setMapping", |f, a| f.set_mapping(arg(&a, 0), arg(&a, 1)));
    canal!("openPr", |f, a| f.open_pr(arg(&a, 0)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handlers::tickets::{self, Sistema};
    use crate::tests_comunes::{EntornoDePrueba, ReenvioNulo};
    use sloth_core::features::proceso::Salida;
    use sloth_core::features::tickets::claude_run::{Mirada, Peticion, ProcesoRun, SalidaRun};
    use std::path::Path;
    use std::sync::atomic::AtomicBool;
    use std::time::Duration;

    struct SinProcesos;

    impl ProcesoRun for SinProcesos {
        fn correr(&self, _: &Peticion, _: Option<&AtomicBool>, _: &mut dyn FnMut(&str) -> Mirada) -> SalidaRun {
            SalidaRun::NoAbrio("sin procesos en esta prueba".into())
        }
    }

    /// git y gh de mentira: el repo de los espacios es github.com/o/r y tiene un PR abierto de «ana».
    struct Github(Mutex<usize>);

    impl Ejecutor for Github {
        fn ejecutar(&self, cmd: &str, args: &[String], _: Option<&Path>, _: Duration) -> Salida {
            let l = args.join(" ");
            match cmd {
                "git" if l.ends_with("remote get-url origin") => Salida::ok("https://github.com/o/r.git\n"),
                "gh" if l.starts_with("pr list") => {
                    *self.0.lock().unwrap() += 1;
                    Salida::ok(
                        &json!([{ "number": 7, "title": "Arreglo", "author": { "login": "ana", "name": "Ana" }, "headRefName": "fix", "isDraft": false, "reviewDecision": "",
                            "statusCheckRollup": [], "url": "https://github.com/o/r/pull/7", "updatedAt": "2026-11-16T10:00:00Z", "createdAt": "2026-11-15T10:00:00Z" }])
                        .to_string(),
                    )
                }
                _ => Salida::error(1, "no simulado"),
            }
        }
    }

    struct Prueba {
        t: EntornoDePrueba,
        router: Router,
        gh: Arc<Github>,
        tickets: Arc<Tickets>,
    }

    fn armar(nombre: &str) -> Prueba {
        let t = EntornoDePrueba::nuevo(nombre);
        let repo = t.carpeta.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        t.fijar_estado(&json!({ "version": 1, "accounts": [], "workspaces": [{ "id": "w1", "repoPath": repo.to_string_lossy(), "accountId": "c1" }] }));
        let gh = Arc::new(Github(Mutex::new(0)));
        let sis = Sistema { proceso: Arc::new(SinProcesos), git: gh.clone(), exe: Arc::new(|_| None) };
        let tk = tickets::Tickets::nuevo(t.entorno.clone(), sis);
        let mut router = Router::nuevo(Arc::new(ReenvioNulo));
        tickets::registrar_con(&mut router, tk.clone());
        registrar_con(&mut router, armar_team(&t, gh.clone(), tk.clone()));
        Prueba { t, router, gh, tickets: tk }
    }

    fn armar_team(t: &EntornoDePrueba, gh: Arc<Github>, tk: Arc<Tickets>) -> Arc<Team> {
        super::armar(t.entorno.clone(), gh, tk)
    }

    impl Prueba {
        async fn ok(&self, canal: &str, args: Vec<Value>) -> Value {
            self.router.invocar(canal.into(), args).await.unwrap_or_else(|e| panic!("{canal}: {e}"))
        }
        async fn err(&self, canal: &str, args: Vec<Value>) -> String {
            self.router.invocar(canal.into(), args).await.unwrap_err()
        }
    }

    #[test]
    fn registra_los_cuatro_canales_de_equipo() {
        let p = armar("team-canales");
        for op in ["state", "refreshGithub", "setMapping", "openPr"] {
            assert!(p.router.atiende(&format!("feat:team:{op}")), "{op}");
        }
    }

    #[tokio::test]
    async fn sin_conector_la_vista_viene_vacia_y_vincular_pide_elegir_uno() {
        let p = armar("team-vacio");
        let s = p.ok("feat:team:state", vec![]).await;
        assert_eq!((s["people"].clone(), s["tickets"]["conector"].clone(), s["githubRunning"].clone()), (json!([]), Value::Null, json!(false)));
        assert_eq!(p.err("feat:team:setMapping", vec![json!("-mal-"), Value::Null]).await, "Login de GitHub inválido.");
        assert_eq!(p.err("feat:team:setMapping", vec![json!("ana"), json!("g:1")]).await, "Elegí un conector en Tickets para vincular personas.");
        assert_eq!(p.err("feat:team:openPr", vec![json!("https://evil.example/pull/1")]).await, "Ese link no es de un PR de GitHub.");
        assert_eq!(p.ok("feat:team:openPr", vec![json!("https://github.com/o/r/pull/7")]).await, json!(true));
        assert_eq!(*p.t.plataforma.abiertos.lock().unwrap(), vec!["https://github.com/o/r/pull/7".to_string()]);
    }

    #[tokio::test]
    async fn actualizar_github_trae_los_pr_de_los_repos_de_los_espacios_y_los_guarda_en_team_json() {
        let p = armar("team-gh");
        let s = p.ok("feat:team:refreshGithub", vec![]).await;
        assert_eq!(s["github"]["repos"], json!(["o/r"]));
        assert_eq!(s["authors"], json!([{ "login": "ana", "name": "Ana" }]));
        assert_eq!(s["people"][0]["prs"][0]["number"], json!(7));
        assert_eq!(*p.gh.0.lock().unwrap(), 1);
        let guardado: Value = serde_json::from_str(&std::fs::read_to_string(p.t.carpeta.join("perfil/features/team.json")).unwrap()).unwrap();
        assert_eq!(guardado["version"], json!(2));
        assert_eq!(guardado["github"]["prs"][0]["url"], json!("https://github.com/o/r/pull/7"));
        let ev: Vec<Value> = p.t.eventos().into_iter().filter(|(c, _)| c == "feat:team:changed").map(|(_, a)| a[0].clone()).collect();
        assert_eq!((ev.first().unwrap()["githubRunning"].clone(), ev.last().unwrap()["githubRunning"].clone()), (json!(true), json!(false)));
    }

    #[tokio::test]
    async fn cada_cambio_de_tickets_rearma_la_vista_de_equipo() {
        let p = armar("team-oyente");
        p.ok("feat:tickets:setConfig", vec![json!({ "conectorId": "github" })]).await;
        let ev: Vec<Value> = p.t.eventos().into_iter().filter(|(c, _)| c == "feat:team:changed").map(|(_, a)| a[0].clone()).collect();
        assert_eq!(ev.last().unwrap()["tickets"]["conector"]["id"], json!("github"));
        assert_eq!(p.tickets.para_equipo()["conector"]["via"], json!("gh"));
        assert_eq!(p.err("feat:team:setMapping", vec![json!("ana"), json!("g:nadie")]).await, "Esa persona no está en lo último que trajo el conector.");
        let s = p.ok("feat:team:setMapping", vec![json!("ana"), json!("-")]).await;
        assert_eq!(s["mapping"], json!({ "ana": "-" }));
    }
}
