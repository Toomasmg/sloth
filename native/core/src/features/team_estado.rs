//! Lectura de team.json (en la carpeta de features de userData). La v1 guardaba además los tickets y la configuración de su
//! propia consulta; desde la v2 los tickets son los del conector de Tickets y acá queda solo GitHub y el mapeo de personas.
//! Equivale a src/main/features/team-estado.ts y a la parte de carga, guardado y vínculos de team.ts.
use super::team::{limpiar_mapeo, login_valido, ordenar_como_js, url_de_pr_valida, Mapeo, TeamPr, NADIE};
use serde_json::{json, Map, Value};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

pub const VERSION: u32 = 2;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Github {
    pub prs: Vec<TeamPr>,
    pub repos: Vec<String>,
    pub errors: Mapeo,
    pub fatal: Option<String>,
    pub fetched_at: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EstadoTeam {
    pub github: Github,
    /// Mapeo de antes de que fuera por conector: se pasa al primer conector activo con `adoptar_legado`.
    pub mapping: Mapeo,
    /// id del conector → (login de GitHub en minúscula → clave de persona, o «-» = no es nadie del conector).
    pub mappings: Vec<(String, Mapeo)>,
    /// La v1 traía tickets de Gruv: sirve para avisar que hay que elegir el conector en Tickets.
    pub venia_de_gruv: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MotivoSoloLectura {
    Futuro,
    Ilegible,
    SinRespaldo,
}

pub fn aviso_solo_lectura(m: MotivoSoloLectura) -> &'static str {
    match m {
        MotivoSoloLectura::Futuro => "team.json es de una versión más nueva de Sloth: lo que vincules no se guarda.",
        MotivoSoloLectura::Ilegible => "No se pudo leer team.json (puede tenerlo abierto otro programa): lo que vincules no se guarda.",
        MotivoSoloLectura::SinRespaldo => "No se pudo respaldar team.json antes de actualizarlo: lo que vincules no se guarda.",
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum CargaTeam {
    Vacio(EstadoTeam),
    Ok { estado: EstadoTeam, migrado: bool },
    Corrupto(EstadoTeam),
    Futuro(EstadoTeam),
}

impl CargaTeam {
    pub fn estado(&self) -> &EstadoTeam {
        match self {
            CargaTeam::Vacio(s) | CargaTeam::Corrupto(s) | CargaTeam::Futuro(s) => s,
            CargaTeam::Ok { estado, .. } => estado,
        }
    }
}

impl EstadoTeam {
    pub fn vacio() -> Self {
        EstadoTeam { github: Github::default(), mapping: Mapeo::nuevo(), mappings: Vec::new(), venia_de_gruv: false }
    }

    pub fn mapeo_de(&self, conector_id: &str) -> Mapeo {
        self.mappings.iter().find(|(id, _)| id == conector_id).map(|(_, m)| m.clone()).unwrap_or_default()
    }

    pub fn poner_mapeo(&mut self, conector_id: &str, m: Mapeo) {
        match self.mappings.iter_mut().find(|(id, _)| id == conector_id) {
            Some(e) => e.1 = m,
            None => {
                self.mappings.push((conector_id.to_string(), m));
                ordenar_como_js(&mut self.mappings);
            }
        }
    }

    /// Devuelve true si movió algo; lo que el conector ya tenía vinculado gana sobre el mapeo viejo.
    pub fn adoptar_legado(&mut self, conector_id: Option<&str>) -> bool {
        let Some(id) = conector_id.filter(|i| !i.is_empty()) else { return false };
        if self.mapping.is_empty() {
            return false;
        }
        let mut nuevo = self.mapping.clone();
        for (k, v) in self.mapeo_de(id).iter() {
            nuevo.insertar(k, v);
        }
        self.poner_mapeo(id, nuevo);
        self.mapping = Mapeo::nuevo();
        true
    }

    /// El JSON que se guarda: mismas claves y mismo orden que `JSON.stringify(state)` en la app de Node.
    pub fn a_json(&self) -> Value {
        let mut github = Map::new();
        github.insert("prs".into(), serde_json::to_value(&self.github.prs).unwrap_or(Value::Array(vec![])));
        github.insert("repos".into(), json!(self.github.repos));
        github.insert("errors".into(), self.github.errors.a_valor());
        if let Some(f) = &self.github.fatal {
            github.insert("fatal".into(), json!(f));
        }
        if let Some(t) = self.github.fetched_at {
            github.insert("fetchedAt".into(), numero_js(t));
        }
        let mut mappings = Map::new();
        for (id, m) in &self.mappings {
            mappings.insert(id.clone(), m.a_valor());
        }
        let mut raiz = Map::new();
        raiz.insert("version".into(), json!(VERSION));
        raiz.insert("github".into(), Value::Object(github));
        raiz.insert("mapping".into(), self.mapping.a_valor());
        raiz.insert("mappings".into(), Value::Object(mappings));
        if self.venia_de_gruv {
            raiz.insert("veniaDeGruv".into(), Value::Bool(true));
        }
        Value::Object(raiz)
    }
}

fn numero_js(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        json!(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

fn objeto(v: Option<&Value>) -> Option<&Map<String, Value>> {
    v.and_then(Value::as_object)
}

fn github(raw: Option<&Value>) -> Github {
    let vacio = Map::new();
    let gh = objeto(raw).unwrap_or(&vacio);
    let mut errors = Mapeo::nuevo();
    for (k, v) in objeto(gh.get("errors")).unwrap_or(&vacio) {
        if let Some(s) = v.as_str() {
            errors.insertar(k, s);
        }
    }
    Github {
        prs: gh
            .get("prs")
            .and_then(Value::as_array)
            .map(|l| {
                l.iter()
                    .filter(|p| p.get("url").and_then(Value::as_str).is_some_and(url_de_pr_valida))
                    .filter(|p| p.is_object())
                    .filter_map(|p| serde_json::from_value::<TeamPr>(p.clone()).ok())
                    .collect()
            })
            .unwrap_or_default(),
        repos: gh.get("repos").and_then(Value::as_array).map(|l| l.iter().filter_map(|r| r.as_str().map(String::from)).collect()).unwrap_or_default(),
        errors,
        fatal: gh.get("fatal").and_then(Value::as_str).map(String::from),
        fetched_at: gh.get("fetchedAt").and_then(Value::as_f64),
    }
}

fn mapeos_por_conector(raw: Option<&Value>) -> Vec<(String, Mapeo)> {
    let mut out: Vec<(String, Mapeo)> = Vec::new();
    for (id, m) in objeto(raw).into_iter().flatten() {
        if id.is_empty() || super::team::largo_utf16(id) > 100 {
            continue;
        }
        let limpio = limpiar_mapeo(m);
        if !limpio.is_empty() {
            out.push((id.clone(), limpio));
        }
        if out.len() >= 50 {
            break;
        }
    }
    out
}

/// `texto` None = el archivo no existe.
pub fn cargar_team(texto: Option<&str>) -> CargaTeam {
    let Some(texto) = texto else { return CargaTeam::Vacio(EstadoTeam::vacio()) };
    let datos: Value = match serde_json::from_str(texto.strip_prefix('\u{feff}').unwrap_or(texto)) {
        Ok(d) => d,
        Err(_) => return CargaTeam::Corrupto(EstadoTeam::vacio()),
    };
    let Some(raw) = datos.as_object() else { return CargaTeam::Corrupto(EstadoTeam::vacio()) };
    let version = raw.get("version").and_then(Value::as_f64).unwrap_or(1.0);
    let mut estado = EstadoTeam {
        github: github(raw.get("github")),
        mapping: limpiar_mapeo(raw.get("mapping").unwrap_or(&Value::Null)),
        mappings: mapeos_por_conector(raw.get("mappings")),
        venia_de_gruv: false,
    };
    let con_tickets = objeto(raw.get("gruv")).and_then(|g| g.get("tickets")).and_then(Value::as_array).is_some_and(|t| !t.is_empty());
    let con_cuenta = objeto(raw.get("config")).and_then(|c| c.get("queryAccountId")).is_some_and(Value::is_string);
    if raw.get("veniaDeGruv") == Some(&Value::Bool(true)) || (version < 2.0 && (con_tickets || con_cuenta)) {
        estado.venia_de_gruv = true;
    }
    if version > 2.0 {
        return CargaTeam::Futuro(estado);
    }
    CargaTeam::Ok { estado, migrado: version < 2.0 }
}

fn escribir(destino: &Path, texto: &str) -> std::io::Result<()> {
    let tmp = PathBuf::from(format!("{}.tmp", destino.display()));
    fs::write(&tmp, texto)?;
    fs::rename(&tmp, destino)
}

fn con_sufijo(p: &Path, sufijo: &str) -> PathBuf {
    PathBuf::from(format!("{}{sufijo}", p.display()))
}

/// Lo que se hizo al cargar o guardar y la persona tiene que poder ver en el log.
pub type Registro = Vec<String>;

/// team.json en disco con su estado. No pisa un archivo que no pudo leer ni uno de una versión más nueva.
pub struct Almacen {
    pub archivo: PathBuf,
    pub estado: EstadoTeam,
    pub solo_lectura: Option<MotivoSoloLectura>,
}

impl Almacen {
    /// Si el archivo está dañado lo aparta como `team.json.corrupto-<ts>`; si migra, deja antes `team.json.v1.bak`.
    pub fn cargar(archivo: PathBuf, ahora_ms: u128, registro: &mut Registro) -> Self {
        let mut a = Almacen { archivo, estado: EstadoTeam::vacio(), solo_lectura: None };
        let mut texto: Option<String> = None;
        match fs::read(&a.archivo) {
            Ok(b) => texto = Some(String::from_utf8_lossy(&b).into_owned()),
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => {
                a.solo_lectura = Some(MotivoSoloLectura::Ilegible);
                registro.push(format!("team: no pude leer team.json, no lo voy a pisar: {e}"));
            }
        }
        let carga = cargar_team(texto.as_deref());
        a.estado = carga.estado().clone();
        match &carga {
            CargaTeam::Corrupto(_) => {
                let aparte = con_sufijo(&a.archivo, &format!(".corrupto-{ahora_ms}"));
                match fs::rename(&a.archivo, &aparte) {
                    Ok(()) => registro.push(format!("team: team.json dañado, lo guardé en {}", aparte.display())),
                    Err(e) => {
                        a.solo_lectura = Some(MotivoSoloLectura::SinRespaldo);
                        registro.push(format!("team: team.json dañado y no pude respaldarlo: {e}"));
                    }
                }
            }
            CargaTeam::Futuro(_) => {
                a.solo_lectura = Some(MotivoSoloLectura::Futuro);
                registro.push("team: team.json es de una versión más nueva de Sloth, no lo voy a pisar".into());
            }
            CargaTeam::Ok { migrado: true, .. } if texto.is_some() => {
                let bak = con_sufijo(&a.archivo, ".v1.bak");
                let hecho = (|| -> std::io::Result<()> {
                    if !bak.exists() {
                        escribir(&bak, texto.as_deref().unwrap_or_default())?;
                    }
                    a.guardar()
                })();
                if let Err(e) = hecho {
                    a.solo_lectura = Some(MotivoSoloLectura::SinRespaldo);
                    registro.push(format!("team: no pude respaldar team.json antes de migrarlo: {e}"));
                }
            }
            _ => {}
        }
        a
    }

    pub fn guardar(&self) -> std::io::Result<()> {
        if self.solo_lectura.is_some() {
            return Ok(());
        }
        if let Some(dir) = self.archivo.parent() {
            fs::create_dir_all(dir)?;
        }
        escribir(&self.archivo, &serde_json::to_string_pretty(&self.estado.a_json()).map_err(std::io::Error::other)?)
    }

    /// Mapeo del conector activo; la primera vez que hay uno se le pasa el mapeo de antes, con respaldo (`team.json.v2.bak`).
    pub fn mapeo_activo(&mut self, conector_id: Option<&str>, registro: &mut Registro) -> Mapeo {
        let Some(id) = conector_id.filter(|i| !i.is_empty()) else { return Mapeo::nuevo() };
        if self.solo_lectura.is_none() && !self.estado.mapping.is_empty() {
            let bak = con_sufijo(&self.archivo, ".v2.bak");
            let hecho = (|| -> std::io::Result<()> {
                if !bak.exists() {
                    escribir(&bak, &fs::read_to_string(&self.archivo)?)?;
                }
                if self.estado.adoptar_legado(Some(id)) {
                    self.guardar()?;
                }
                Ok(())
            })();
            if let Err(e) = hecho {
                registro.push(format!("team: no pude respaldar team.json antes de pasar el mapeo al conector: {e}"));
            }
        }
        self.estado.mapeo_de(id)
    }

    /// Vincula un login de GitHub con una persona del conector (nada = automático, «-» = no es del conector).
    /// `existe_persona` dice si esa clave está entre las personas de lo último que trajo el conector.
    pub fn vincular(&mut self, login: &Value, clave: &Value, conector_id: Option<&str>, existe_persona: &dyn Fn(&str) -> bool, registro: &mut Registro) -> Result<Mapeo, String> {
        let Some(login) = login.as_str().filter(|l| login_valido(l)) else { return Err("Login de GitHub inválido.".into()) };
        let login = login.to_lowercase();
        if let Some(m) = self.solo_lectura {
            return Err(aviso_solo_lectura(m).into());
        }
        let Some(conector_id) = conector_id.filter(|i| !i.is_empty()) else { return Err("Elegí un conector en Tickets para vincular personas.".into()) };
        let mut mapeo = self.mapeo_activo(Some(conector_id), registro);
        match clave {
            Value::Null => mapeo.quitar(&login),
            Value::String(s) if s.is_empty() => mapeo.quitar(&login),
            Value::String(s) if super::team::largo_utf16(s) <= 200 => {
                if s != NADIE && !existe_persona(s) {
                    return Err("Esa persona no está en lo último que trajo el conector.".into());
                }
                mapeo.insertar(&login, s);
            }
            _ => return Err("Persona inválida.".into()),
        }
        self.estado.poner_mapeo(conector_id, mapeo.clone());
        self.guardar().map_err(|e| e.to_string())?;
        Ok(mapeo)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pr_json() -> Value {
        json!({ "repo": "org/app", "number": 7, "title": "Algo", "login": "ana", "branch": "b", "isDraft": false, "review": "pending", "ci": "pass",
                "checks": { "pass": 1, "fail": 0, "running": 0 }, "url": "https://github.com/org/app/pull/7" })
    }

    fn pr() -> TeamPr {
        serde_json::from_value(pr_json()).unwrap()
    }

    fn ok(c: &CargaTeam) -> (&EstadoTeam, bool) {
        match c {
            CargaTeam::Ok { estado, migrado } => (estado, *migrado),
            otro => panic!("esperaba Ok y fue {otro:?}"),
        }
    }

    #[test]
    fn sin_archivo_arranca_vacio() {
        assert_eq!(cargar_team(None), CargaTeam::Vacio(EstadoTeam::vacio()));
    }

    #[test]
    fn v1_conserva_github_y_el_mapeo_y_deja_gruv_y_config_afuera() {
        let v1 = json!({
            "version": 1,
            "github": { "prs": [pr_json()], "repos": ["org/app"], "errors": {}, "fetchedAt": 5 },
            "gruv": { "tickets": [{ "id": "TCK-1" }], "personas": [{ "id": "12", "nombre": "Ana" }] },
            "mapping": { "ana": "g:12", "bot": "-" },
            "config": { "model": "haiku", "confirmGruv": false }
        });
        let c = cargar_team(Some(&format!("\u{feff}{v1}")));
        let (e, migrado) = ok(&c);
        assert!(migrado);
        assert_eq!(e.mapping, Mapeo::desde(&[("ana", "g:12"), ("bot", "-")]));
        assert_eq!(e.github, Github { prs: vec![pr()], repos: vec!["org/app".into()], errors: Mapeo::nuevo(), fatal: None, fetched_at: Some(5.0) });
        let guardado = e.a_json();
        assert_eq!(guardado["version"], 2);
        assert!(guardado.get("gruv").is_none() && guardado.get("config").is_none());
    }

    #[test]
    fn sin_version_se_trata_como_v1() {
        let c = cargar_team(Some(&json!({ "mapping": { "ana": "n:ana" } }).to_string()));
        let (e, migrado) = ok(&c);
        assert!(migrado);
        assert_eq!(e.mapping, Mapeo::desde(&[("ana", "n:ana")]));
    }

    #[test]
    fn v2_carga_sin_migrar() {
        let c = cargar_team(Some(&json!({ "version": 2, "github": { "prs": [], "repos": [], "errors": {} }, "mapping": { "ana": "g:12" } }).to_string()));
        let (e, migrado) = ok(&c);
        assert!(!migrado);
        assert_eq!(e.mapping, Mapeo::desde(&[("ana", "g:12")]));
    }

    #[test]
    fn json_roto_o_que_no_es_objeto_es_corrupto() {
        for t in ["{", "[1]", "null", ""] {
            assert!(matches!(cargar_team(Some(t)), CargaTeam::Corrupto(_)), "{t:?}");
        }
    }

    #[test]
    fn version_mas_nueva_es_futuro_con_lo_que_se_entiende() {
        let c = cargar_team(Some(&json!({ "version": 3, "mapping": { "ana": "g:12" } }).to_string()));
        assert!(matches!(&c, CargaTeam::Futuro(e) if e.mapping == Mapeo::desde(&[("ana", "g:12")])));
    }

    #[test]
    fn descarta_prs_que_no_son_de_github_y_mapeos_invalidos() {
        let mut ajeno = pr_json();
        ajeno["url"] = json!("https://evil.example/pull/1");
        let c = cargar_team(Some(&json!({ "version": 2, "github": { "prs": [pr_json(), ajeno], "repos": ["org/app", 3], "errors": [], "fatal": 4 }, "mapping": { "ana": "x", "beto": "g:3" } }).to_string()));
        let (e, _) = ok(&c);
        assert_eq!(e.github.prs, vec![pr()]);
        assert_eq!(e.github.repos, vec!["org/app"]);
        assert!(e.github.errors.is_empty());
        assert_eq!(e.github.fatal, None);
        assert_eq!(e.mapping, Mapeo::desde(&[("beto", "g:3")]));
    }

    #[test]
    fn v1_con_tickets_o_cuenta_de_gruv_queda_marcado_y_la_marca_sobrevive_en_v2() {
        let con_tickets = cargar_team(Some(&json!({ "version": 1, "gruv": { "tickets": [{ "id": "TCK-1" }] } }).to_string()));
        assert!(ok(&con_tickets).0.venia_de_gruv);
        let con_cuenta = cargar_team(Some(&json!({ "config": { "queryAccountId": "acc1" } }).to_string()));
        assert!(ok(&con_cuenta).0.venia_de_gruv);
        let sin_nada = cargar_team(Some(&json!({ "version": 1, "gruv": { "tickets": [] }, "mapping": {} }).to_string()));
        assert!(!ok(&sin_nada).0.venia_de_gruv);
        let v2 = cargar_team(Some(&json!({ "version": 2, "veniaDeGruv": true }).to_string()));
        assert!(ok(&v2).0.venia_de_gruv);
        let v2_con_gruv_viejo = cargar_team(Some(&json!({ "version": 2, "gruv": { "tickets": [{ "id": "x" }] } }).to_string()));
        assert!(!ok(&v2_con_gruv_viejo).0.venia_de_gruv);
    }

    #[test]
    fn aviso_solo_lectura_explica_cada_motivo() {
        for m in [MotivoSoloLectura::Futuro, MotivoSoloLectura::Ilegible, MotivoSoloLectura::SinRespaldo] {
            assert!(aviso_solo_lectura(m).to_lowercase().contains("no se guarda"));
        }
        assert!(aviso_solo_lectura(MotivoSoloLectura::Futuro).contains("más nueva"));
    }

    #[test]
    fn mapeo_por_conector_se_carga_limpio_y_no_se_mezcla_entre_conectores() {
        let c = cargar_team(Some(&json!({ "version": 2, "mappings": { "gruv": { "ana": "g:1", "mala": "x" }, "gh": { "ana": "-" }, "": { "ana": "g:2" }, "roto": 4 } }).to_string()));
        let (e, migrado) = ok(&c);
        assert!(!migrado);
        assert_eq!(e.mappings, vec![("gruv".to_string(), Mapeo::desde(&[("ana", "g:1")])), ("gh".to_string(), Mapeo::desde(&[("ana", "-")]))]);
        assert_eq!(e.mapeo_de("gruv"), Mapeo::desde(&[("ana", "g:1")]));
        assert!(e.mapeo_de("otro").is_empty());
    }

    #[test]
    fn adoptar_legado_pasa_el_mapeo_viejo_al_conector_activo_sin_pisar_lo_que_ya_tenia() {
        let mut s = EstadoTeam::vacio();
        s.mapping = Mapeo::desde(&[("ana", "g:1"), ("beto", "g:2")]);
        s.mappings = vec![("gruv".into(), Mapeo::desde(&[("beto", "-")]))];
        assert!(s.adoptar_legado(Some("gruv")));
        assert_eq!(s.mappings, vec![("gruv".to_string(), Mapeo::desde(&[("ana", "g:1"), ("beto", "-")]))]);
        assert!(s.mapping.is_empty());
        assert!(!s.adoptar_legado(Some("gruv")));
    }

    #[test]
    fn adoptar_legado_sin_conector_activo_o_sin_mapeo_viejo_no_toca_nada() {
        let mut s = EstadoTeam::vacio();
        s.mapping = Mapeo::desde(&[("ana", "g:1")]);
        assert!(!s.adoptar_legado(None));
        assert_eq!(s.mapping, Mapeo::desde(&[("ana", "g:1")]));
        assert!(!EstadoTeam::vacio().adoptar_legado(Some("gh")));
    }

    #[test]
    fn el_json_guardado_tiene_el_orden_de_claves_del_ts() {
        let mut s = EstadoTeam::vacio();
        s.github = Github { prs: vec![pr()], repos: vec!["org/app".into()], errors: Mapeo::desde(&[("org/x", "sin acceso")]), fatal: Some("x".into()), fetched_at: Some(1_700_000_000_123.0) };
        s.venia_de_gruv = true;
        let v = s.a_json();
        assert_eq!(v.as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(), ["version", "github", "mapping", "mappings", "veniaDeGruv"]);
        assert_eq!(v["github"].as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(), ["prs", "repos", "errors", "fatal", "fetchedAt"]);
        assert_eq!(v["github"]["fetchedAt"], json!(1_700_000_000_123_i64));
        assert!(EstadoTeam::vacio().a_json().get("veniaDeGruv").is_none());
        assert_eq!(EstadoTeam::vacio().a_json()["github"], json!({ "prs": [], "repos": [], "errors": {} }));
    }

    #[test]
    fn un_pr_con_campos_que_no_conocemos_los_conserva_al_guardar() {
        let mut p = pr_json();
        p["campoNuevo"] = json!({ "a": 1 });
        let c = cargar_team(Some(&json!({ "version": 2, "github": { "prs": [p] } }).to_string()));
        assert_eq!(ok(&c).0.a_json()["github"]["prs"][0]["campoNuevo"], json!({ "a": 1 }));
    }

    fn carpeta(nombre: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sloth-team-rs-{}-{nombre}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn almacen_sin_archivo_arranca_vacio_y_guarda_al_vincular() {
        let d = carpeta("vincular");
        let mut reg = vec![];
        let mut a = Almacen::cargar(d.join("team.json"), 1, &mut reg);
        assert!(a.solo_lectura.is_none() && reg.is_empty());
        let m = a.vincular(&json!("Ana"), &json!("g:12"), Some("gruv"), &|c| c == "g:12", &mut reg).unwrap();
        assert_eq!(m, Mapeo::desde(&[("ana", "g:12")]));
        let guardado: Value = serde_json::from_str(&fs::read_to_string(d.join("team.json")).unwrap()).unwrap();
        assert_eq!(guardado["mappings"], json!({ "gruv": { "ana": "g:12" } }));
        a.vincular(&json!("ana"), &Value::Null, Some("gruv"), &|_| false, &mut reg).unwrap();
        assert!(a.estado.mapeo_de("gruv").is_empty());
        assert!(!d.join("team.json.tmp").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn vincular_valida_login_persona_y_conector() {
        let d = carpeta("validar");
        let mut reg = vec![];
        let mut a = Almacen::cargar(d.join("team.json"), 1, &mut reg);
        let existe = |c: &str| c == "g:1";
        assert_eq!(a.vincular(&json!("-x"), &json!("g:1"), Some("gh"), &existe, &mut reg).unwrap_err(), "Login de GitHub inválido.");
        assert_eq!(a.vincular(&json!("ana"), &json!("g:1"), None, &existe, &mut reg).unwrap_err(), "Elegí un conector en Tickets para vincular personas.");
        assert_eq!(a.vincular(&json!("ana"), &json!("g:9"), Some("gh"), &existe, &mut reg).unwrap_err(), "Esa persona no está en lo último que trajo el conector.");
        assert_eq!(a.vincular(&json!("ana"), &json!(5), Some("gh"), &existe, &mut reg).unwrap_err(), "Persona inválida.");
        assert_eq!(a.vincular(&json!("ana"), &json!("x".repeat(201)), Some("gh"), &existe, &mut reg).unwrap_err(), "Persona inválida.");
        assert!(a.vincular(&json!("ana"), &json!("-"), Some("gh"), &existe, &mut reg).is_ok());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn almacen_migra_la_v1_dejando_un_respaldo_con_el_texto_original() {
        let d = carpeta("migrar");
        let original = json!({ "version": 1, "gruv": { "tickets": [{ "id": "T" }] }, "mapping": { "ana": "g:1" } }).to_string();
        fs::write(d.join("team.json"), &original).unwrap();
        let mut reg = vec![];
        let a = Almacen::cargar(d.join("team.json"), 1, &mut reg);
        assert!(a.solo_lectura.is_none());
        assert_eq!(fs::read_to_string(d.join("team.json.v1.bak")).unwrap(), original);
        let nuevo: Value = serde_json::from_str(&fs::read_to_string(d.join("team.json")).unwrap()).unwrap();
        assert_eq!(nuevo["version"], 2);
        assert_eq!(nuevo["veniaDeGruv"], true);
        assert!(nuevo.get("gruv").is_none());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn almacen_no_pisa_el_respaldo_que_ya_existe() {
        let d = carpeta("bak-previo");
        fs::write(d.join("team.json.v1.bak"), "el primero").unwrap();
        fs::write(d.join("team.json"), json!({ "mapping": {} }).to_string()).unwrap();
        let mut reg = vec![];
        Almacen::cargar(d.join("team.json"), 1, &mut reg);
        assert_eq!(fs::read_to_string(d.join("team.json.v1.bak")).unwrap(), "el primero");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn almacen_con_version_futura_queda_en_solo_lectura_y_no_reescribe() {
        let d = carpeta("futuro");
        let original = json!({ "version": 9, "mapping": { "ana": "g:1" } }).to_string();
        fs::write(d.join("team.json"), &original).unwrap();
        let mut reg = vec![];
        let mut a = Almacen::cargar(d.join("team.json"), 1, &mut reg);
        assert_eq!(a.solo_lectura, Some(MotivoSoloLectura::Futuro));
        a.guardar().unwrap();
        assert_eq!(fs::read_to_string(d.join("team.json")).unwrap(), original);
        let e = a.vincular(&json!("ana"), &json!("-"), Some("gh"), &|_| true, &mut reg).unwrap_err();
        assert_eq!(e, aviso_solo_lectura(MotivoSoloLectura::Futuro));
        assert!(!d.join("team.json.v1.bak").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn almacen_aparta_un_archivo_danado_y_arranca_vacio() {
        let d = carpeta("corrupto");
        fs::write(d.join("team.json"), "{ esto no es json").unwrap();
        let mut reg = vec![];
        let a = Almacen::cargar(d.join("team.json"), 42, &mut reg);
        assert_eq!(a.estado, EstadoTeam::vacio());
        assert!(a.solo_lectura.is_none());
        assert_eq!(fs::read_to_string(d.join("team.json.corrupto-42")).unwrap(), "{ esto no es json");
        assert!(!d.join("team.json").exists());
        assert!(reg[0].contains("dañado"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn mapeo_activo_pasa_el_mapeo_viejo_al_conector_con_respaldo_v2() {
        let d = carpeta("legado");
        let original = json!({ "version": 2, "mapping": { "ana": "g:1" }, "mappings": { "gh": { "beto": "-" } } });
        fs::write(d.join("team.json"), original.to_string()).unwrap();
        let mut reg = vec![];
        let mut a = Almacen::cargar(d.join("team.json"), 1, &mut reg);
        assert_eq!(a.mapeo_activo(None, &mut reg), Mapeo::nuevo());
        assert_eq!(a.mapeo_activo(Some("gh"), &mut reg), Mapeo::desde(&[("ana", "g:1"), ("beto", "-")]));
        assert_eq!(serde_json::from_str::<Value>(&fs::read_to_string(d.join("team.json.v2.bak")).unwrap()).unwrap(), original);
        let guardado: Value = serde_json::from_str(&fs::read_to_string(d.join("team.json")).unwrap()).unwrap();
        assert_eq!(guardado["mapping"], json!({}));
        assert_eq!(guardado["mappings"]["gh"], json!({ "ana": "g:1", "beto": "-" }));
        let _ = fs::remove_dir_all(&d);
    }
}
