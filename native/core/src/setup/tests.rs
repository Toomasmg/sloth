use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicU32, Ordering};

struct Entorno {
    raiz: PathBuf,
    home: PathBuf,
    cuenta: PathBuf,
}

impl Entorno {
    fn nuevo() -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let raiz = std::env::temp_dir().join(format!("sloth-setup-rs-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&raiz);
        let (home, cuenta) = (raiz.join("home"), raiz.join("cuenta"));
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::create_dir_all(&cuenta).unwrap();
        Entorno { raiz, home, cuenta }
    }

    fn setup(&self, rel: &str, contenido: &str) {
        let f = self.home.join(".claude").join(rel);
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(f, contenido).unwrap();
    }

    fn cuenta(&self) -> CuentaSetup<'_> {
        CuentaSetup { config_dir: &self.cuenta, share_setup: None }
    }

    fn sincronizar(&self, mcp: bool) -> SetupSyncReport {
        sincronizar_setup_compartido(&self.cuenta(), &self.home, mcp)
    }

    fn mcp_de_usuario(&self, v: &Value) {
        fs::write(self.home.join(".claude.json"), v.to_string()).unwrap();
    }

    fn json_de_cuenta(&self) -> Value {
        serde_json::from_str(&fs::read_to_string(self.cuenta.join(".claude.json")).unwrap()).unwrap()
    }
}

impl Drop for Entorno {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.raiz);
    }
}

fn v(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|s| s.to_string()).collect()
}

#[test]
fn enlaza_las_carpetas_que_existen_y_copia_los_archivos() {
    let e = Entorno::nuevo();
    e.setup("skills/una/SKILL.md", "x");
    e.setup("hooks/h.sh", "y");
    e.setup("CLAUDE.md", "reglas");
    e.setup("statusline.py", "print(1)");
    let r = e.sincronizar(true);
    assert_eq!(r, SetupSyncReport { linked: v(&["skills", "hooks"]), copied: v(&["CLAUDE.md", "statusline.py"]), mcp_servers: vec![], skipped: vec![] });
    assert_eq!(fs::read_to_string(e.cuenta.join("skills/una/SKILL.md")).unwrap(), "x");
    assert_eq!(fs::read_to_string(e.cuenta.join("CLAUDE.md")).unwrap(), "reglas");
    assert!(!e.cuenta.join("agents").exists());
}

#[test]
fn volver_a_sincronizar_reconoce_los_enlaces_y_se_ve_lo_nuevo_al_instante() {
    let e = Entorno::nuevo();
    e.setup("skills/una/SKILL.md", "x");
    e.sincronizar(true);
    e.setup("skills/otra/SKILL.md", "z");
    assert_eq!(e.sincronizar(true).linked, v(&["skills"]));
    assert!(e.cuenta.join("skills/otra/SKILL.md").exists());
}

#[test]
fn no_pisa_una_carpeta_propia_de_la_cuenta() {
    let e = Entorno::nuevo();
    e.setup("agents/a.md", "tuyo");
    fs::create_dir_all(e.cuenta.join("agents")).unwrap();
    fs::write(e.cuenta.join("agents/b.md"), "de la cuenta").unwrap();
    let r = e.sincronizar(true);
    assert_eq!(r.skipped, v(&["agents (la cuenta ya tiene la suya)"]));
    assert!(r.linked.is_empty());
    assert!(e.cuenta.join("agents/b.md").exists() && !e.cuenta.join("agents/a.md").exists());
}

#[test]
fn un_enlace_roto_ocupa_el_nombre_y_no_se_pisa() {
    let e = Entorno::nuevo();
    e.setup("plugins/p.json", "{}");
    let viejo = e.raiz.join("viejo");
    fs::create_dir_all(&viejo).unwrap();
    crear_enlace_carpeta(&viejo, &e.cuenta.join("plugins")).unwrap();
    fs::remove_dir_all(&viejo).unwrap();
    assert_eq!(e.sincronizar(true).skipped, v(&["plugins (la cuenta ya tiene la suya)"]));
}

#[test]
fn sin_compartir_o_sin_carpetas_no_hace_nada() {
    let e = Entorno::nuevo();
    e.setup("skills/una/SKILL.md", "x");
    let sin = CuentaSetup { config_dir: &e.cuenta, share_setup: Some(false) };
    assert_eq!(sincronizar_setup_compartido(&sin, &e.home, true), SetupSyncReport::default());
    assert!(!e.cuenta.join("skills").exists());
    let fantasma = CuentaSetup { config_dir: &e.raiz.join("no-existe"), share_setup: Some(true) };
    assert_eq!(sincronizar_setup_compartido(&fantasma, &e.home, true), SetupSyncReport::default());
    fs::remove_dir_all(e.home.join(".claude")).unwrap();
    assert_eq!(e.sincronizar(true), SetupSyncReport::default());
}

#[test]
fn agrega_los_mcp_que_faltan_sin_pisar_los_de_la_cuenta() {
    let e = Entorno::nuevo();
    e.setup("CLAUDE.md", "x");
    e.mcp_de_usuario(&json!({ "mcpServers": { "uno": { "command": "a" }, "dos": { "command": "b" } }, "otra": 1 }));
    fs::write(e.cuenta.join(".claude.json"), r#"{"userID":"u","mcpServers":{"dos":{"command":"propio"}}}"#).unwrap();
    let r = e.sincronizar(true);
    assert_eq!(r.mcp_servers, v(&["dos", "uno"]));
    let j = e.json_de_cuenta();
    assert_eq!(j["mcpServers"]["dos"]["command"], "propio");
    assert_eq!(j["mcpServers"]["uno"]["command"], "a");
    assert_eq!(j["userID"], "u");
    assert!(j.get("otra").is_none());
}

#[test]
fn crea_el_claude_json_de_la_cuenta_si_no_existe() {
    let e = Entorno::nuevo();
    e.mcp_de_usuario(&json!({ "mcpServers": { "uno": { "command": "a" } } }));
    assert_eq!(e.sincronizar(true).mcp_servers, v(&["uno"]));
    assert_eq!(e.json_de_cuenta(), json!({ "mcpServers": { "uno": { "command": "a" } } }));
}

#[test]
fn si_no_falta_ninguno_no_reescribe_el_archivo() {
    let e = Entorno::nuevo();
    e.mcp_de_usuario(&json!({ "mcpServers": { "uno": {} } }));
    let propio = "{\"mcpServers\":{\"uno\":{}}}";
    fs::write(e.cuenta.join(".claude.json"), propio).unwrap();
    assert_eq!(e.sincronizar(true).mcp_servers, v(&["uno"]));
    assert_eq!(fs::read_to_string(e.cuenta.join(".claude.json")).unwrap(), propio);
}

#[test]
fn con_claude_abierto_no_escribe_los_mcp_y_lo_avisa() {
    let e = Entorno::nuevo();
    e.mcp_de_usuario(&json!({ "mcpServers": { "uno": {} } }));
    let r = e.sincronizar(false);
    assert_eq!(r.skipped, v(&["MCP (Claude está abierto con esta cuenta; se sincroniza al próximo arranque)"]));
    assert!(!e.cuenta.join(".claude.json").exists());
}

#[test]
fn un_claude_json_ilegible_de_la_cuenta_no_se_toca() {
    let e = Entorno::nuevo();
    e.mcp_de_usuario(&json!({ "mcpServers": { "uno": {} } }));
    for roto in ["{ roto", "[1]", r#"{"mcpServers":"texto"}"#] {
        fs::write(e.cuenta.join(".claude.json"), roto).unwrap();
        assert_eq!(e.sincronizar(true).skipped, v(&["MCP (.claude.json de la cuenta ilegible)"]), "{roto}");
        assert_eq!(fs::read_to_string(e.cuenta.join(".claude.json")).unwrap(), roto);
    }
}

#[test]
fn el_claude_json_del_usuario_puede_traer_bom_y_sin_mcp_no_se_hace_nada() {
    let e = Entorno::nuevo();
    fs::write(e.home.join(".claude.json"), "\u{feff}{\"mcpServers\":{\"uno\":{}}}").unwrap();
    assert_eq!(e.sincronizar(true).mcp_servers, v(&["uno"]));
    e.mcp_de_usuario(&json!({ "otra": 1 }));
    fs::remove_file(e.cuenta.join(".claude.json")).unwrap();
    assert_eq!(e.sincronizar(true), SetupSyncReport::default());
    assert!(!e.cuenta.join(".claude.json").exists());
}

#[test]
fn dejar_de_compartir_quita_solo_los_enlaces_hacia_el_setup() {
    let e = Entorno::nuevo();
    e.setup("skills/una/SKILL.md", "x");
    e.setup("agents/a.md", "y");
    e.sincronizar(true);
    fs::remove_dir_all(e.cuenta.join("agents")).unwrap();
    fs::create_dir_all(e.cuenta.join("agents")).unwrap();
    fs::write(e.cuenta.join("agents/propio.md"), "mio").unwrap();
    dejar_de_compartir(&e.cuenta(), &e.home).unwrap();
    assert!(!e.cuenta.join("skills").exists());
    assert!(e.cuenta.join("agents/propio.md").exists());
    assert!(e.home.join(".claude/skills/una/SKILL.md").exists(), "el setup original queda");
}

#[test]
fn base_settings_es_el_del_usuario_si_comparte_y_nada_si_no() {
    let e = Entorno::nuevo();
    assert_eq!(base_settings_para(&e.cuenta(), &e.home), Some(Map::new()));
    e.setup("settings.json", "\u{feff}{\"theme\":\"dark\"}");
    assert_eq!(base_settings_para(&e.cuenta(), &e.home).unwrap()["theme"], "dark");
    e.setup("settings.json", "[1]");
    assert_eq!(base_settings_para(&e.cuenta(), &e.home), Some(Map::new()));
    let sin = CuentaSetup { config_dir: &e.cuenta, share_setup: Some(false) };
    assert_eq!(base_settings_para(&sin, &e.home), None);
}
