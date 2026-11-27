use super::*;
use std::collections::HashSet;
use std::path::PathBuf;

struct Temporal(PathBuf);

impl Temporal {
    fn nuevo(prefijo: &str) -> Self {
        let d = std::env::temp_dir().join(format!("{prefijo}-{}", sufijo_unico()));
        fs::create_dir_all(&d).unwrap();
        Temporal(d)
    }
}

impl Drop for Temporal {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn v(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

const SEGURO: [&str; 5] = ["-s", "workspace-write", "-a", "on-request", "--no-daemon"];

#[test]
fn rutas_y_textos_de_cada_proveedor() {
    use ProveedorId::*;
    assert_eq!([env_config_dir(Claude), subcarpeta_cuenta(Claude), archivo_meta(Claude), carpeta_historial(Claude)], ["CLAUDE_CONFIG_DIR", "claude", ".claude.json", "projects"]);
    assert_eq!([env_config_dir(Codex), subcarpeta_cuenta(Codex), archivo_meta(Codex), carpeta_historial(Codex)], ["CODEX_HOME", "codex", "config.toml", "sessions"]);
    assert_eq!([env_config_dir(Copilot), subcarpeta_cuenta(Copilot), archivo_meta(Copilot), carpeta_historial(Copilot)], ["COPILOT_HOME", "copilot", "config.json", "session-state"]);
    assert_eq!(como_instalar(Codex), "npm install -g @openai/codex");
}

#[test]
fn argv_de_login_y_env_de_cuenta() {
    use ProveedorId::*;
    assert_eq!(argv_login(Claude), v(&["claude"]));
    assert_eq!(argv_login(Codex), v(&["codex", "login"]));
    assert_eq!(argv_login(Copilot), v(&["copilot", "login", "--device-code"]));
    assert_eq!(env_cuenta(Claude, "C:/x"), vec![("CLAUDE_CONFIG_DIR".to_string(), "C:/x".to_string())]);
    assert_eq!(env_cuenta(Codex, "C:/x"), vec![("CODEX_HOME".to_string(), "C:/x".to_string())]);
    assert_eq!(env_cuenta(Copilot, "C:/x"), vec![("COPILOT_HOME".to_string(), "C:/x".to_string()), ("COPILOT_AUTO_UPDATE".to_string(), "false".to_string())]);
}

#[test]
fn claude_argv_nuevo_continuar_y_con_prompt() {
    use ProveedorId::Claude;
    assert_eq!(argv_interactivo(Claude, false, None), v(&["claude"]));
    assert_eq!(argv_interactivo(Claude, true, None), v(&["claude", "--continue"]));
    assert_eq!(argv_interactivo(Claude, false, Some("--x")), v(&["claude", "--", "--x"]));
    assert_eq!(argv_interactivo(Claude, true, Some("a\nb")), v(&["claude", "--", "a b"]));
    assert_eq!(argv_interactivo(Claude, true, Some("")), v(&["claude", "--continue"]));
}

#[test]
fn codex_argv_nuevo_continuar_y_con_prompt() {
    use ProveedorId::Codex;
    let base: Vec<String> = std::iter::once("codex").chain(SEGURO).map(str::to_owned).collect();
    assert_eq!(argv_interactivo(Codex, false, None), base);
    assert_eq!(argv_interactivo(Codex, true, None), base);
    let mut con = base.clone();
    con.extend(v(&["--", "--x"]));
    assert_eq!(argv_interactivo(Codex, false, Some("--x")), con);
    let mut raro = base.clone();
    raro.extend(v(&["--", "a b \"c\""]));
    assert_eq!(argv_interactivo(Codex, true, Some("a\nb\t\"c\"")), raro);
}

#[test]
fn codex_y_copilot_ningun_argv_salta_permisos_ni_sandbox() {
    for id in [ProveedorId::Codex, ProveedorId::Copilot] {
        for a in [argv_interactivo(id, false, None), argv_interactivo(id, false, Some("hola")), argv_login(id)] {
            assert!(a.iter().all(|x| !x.contains("--dangerously")), "{a:?}");
            assert!(!a.contains(&"danger-full-access".to_string()));
        }
    }
    let a = argv_interactivo(ProveedorId::Copilot, false, Some("--yolo"));
    let flags = &a[..a.iter().position(|x| x == "--").unwrap_or(a.len())];
    for f in ["--allow-all", "--yolo", "--allow-all-tools", "--allow-all-paths", "--allow-all-urls"] {
        assert!(!flags.iter().any(|x| x == f), "{f}");
    }
}

#[test]
fn copilot_argv_nuevo_continuar_y_con_prompt_en_una_linea() {
    use ProveedorId::Copilot;
    assert_eq!(argv_interactivo(Copilot, false, None), v(&["copilot"]));
    assert_eq!(argv_interactivo(Copilot, true, None), v(&["copilot"]));
    assert_eq!(argv_interactivo(Copilot, false, Some("--allow-all")), v(&["copilot", "--", "--allow-all"]));
    assert_eq!(argv_interactivo(Copilot, false, Some("a\nb \"c\" & d")), v(&["copilot", "--", "a b \"c\" & d"]));
}

#[test]
fn quitar_del_entorno_de_claude() {
    use ProveedorId::Claude;
    for k in ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] {
        assert!(quitar_del_entorno(Claude, k), "{k}");
    }
    for k in ["PATH", "OPENAI_API_KEY", "CODEX_HOME", "ANTHROPIC_BASE_URL", "CLAUDE_OTRA"] {
        assert!(!quitar_del_entorno(Claude, k), "{k}");
    }
}

#[test]
fn quitar_del_entorno_de_codex() {
    use ProveedorId::Codex;
    for k in ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "CLAUDECODE", "AZURE_OPENAI_API_KEY", "MISTRAL_API_KEY"] {
        assert!(quitar_del_entorno(Codex, k), "{k}");
    }
    for k in ["PATH", "HOME", "SLOTH_X", "USERPROFILE", "GH_TOKEN"] {
        assert!(!quitar_del_entorno(Codex, k), "{k}");
    }
}

#[test]
fn quitar_del_entorno_de_copilot() {
    use ProveedorId::Copilot;
    for k in ["COPILOT_GITHUB_TOKEN", "COPILOT_HOME", "COPILOT_ALLOW_ALL", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "OPENAI_API_KEY", "CODEX_HOME"] {
        assert!(quitar_del_entorno(Copilot, k), "{k}");
    }
    for k in ["PATH", "GITHUB_ACTIONS", "GITHUB_WORKSPACE", "HOME", "USERPROFILE", "SLOTH_X", "GH_TOKEN_X"] {
        assert!(!quitar_del_entorno(Copilot, k), "{k}");
    }
}

#[test]
fn claude_y_codex_no_quitan_las_variables_de_github() {
    for id in [ProveedorId::Claude, ProveedorId::Codex] {
        for k in ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN"] {
            assert!(!quitar_del_entorno(id, k), "{id:?} {k}");
        }
    }
}

#[test]
fn login_de_claude_lee_email_o_uuid_y_quita_el_bom() {
    let t = Temporal::nuevo("sloth-fs-claude");
    let meta = t.0.join(".claude.json");
    assert_eq!(estado_login(ProveedorId::Claude, &t.0).estado, EstadoLogin::default());
    fs::write(&meta, "\u{feff}{\"oauthAccount\":{\"emailAddress\":\"a@b.c\"}}").unwrap();
    assert_eq!(estado_login(ProveedorId::Claude, &t.0).estado, EstadoLogin { logged_in: true, email: Some("a@b.c".into()) });
    fs::write(&meta, "{\"oauthAccount\":{\"accountUuid\":\"u-1\"}}").unwrap();
    assert_eq!(estado_login(ProveedorId::Claude, &t.0).estado, EstadoLogin { logged_in: true, email: None });
    for malo in ["{\"oauthAccount\":{}}", "{}", "{roto", "[]", "null"] {
        fs::write(&meta, malo).unwrap();
        assert_eq!(estado_login(ProveedorId::Claude, &t.0).estado, EstadoLogin::default(), "{malo}");
    }
    assert!(estado_login(ProveedorId::Claude, &t.0).aviso.is_none());
}

#[test]
fn login_de_codex_solo_mira_si_auth_json_existe() {
    let t = Temporal::nuevo("sloth-fs-codex");
    assert_eq!(estado_login(ProveedorId::Codex, &t.0).estado, EstadoLogin::default());
    fs::write(t.0.join("auth.json"), "").unwrap();
    assert!(estado_login(ProveedorId::Codex, &t.0).estado.logged_in);
    assert!(t.0.join("auth.json").exists());
}

#[test]
fn login_de_config_copilot_exige_un_usuario_en_logged_in_users() {
    use serde_json::json;
    assert!(login_de_config_copilot(&json!({ "loggedInUsers": [{ "host": "https://github.com", "login": "x" }] })));
    for j in [
        json!({ "loggedInUsers": [] }),
        json!({ "loggedInUsers": "x" }),
        json!({ "lastLoggedInUser": { "login": "x" } }),
        json!({ "loggedInUsers": [], "lastLoggedInUser": { "login": "x" } }),
        json!({}),
        json!([]),
        json!(null),
        json!("x"),
        json!(3),
    ] {
        assert!(!login_de_config_copilot(&j), "{j}");
    }
}

#[test]
fn login_de_copilot_sin_archivo_vacio_roto_o_con_bom() {
    let t = Temporal::nuevo("sloth-fs-copilot");
    let cfg = t.0.join("config.json");
    let login = |d: &Path| estado_login(ProveedorId::Copilot, d);
    assert_eq!(login(&t.0), ResultadoLogin { estado: EstadoLogin::default(), aviso: None });
    fs::write(&cfg, "{\"loggedInUsers\":[{\"login\":\"x\"}]}").unwrap();
    assert!(login(&t.0).estado.logged_in);
    fs::write(&cfg, "{\"loggedInUsers\":[]}").unwrap();
    assert!(!login(&t.0).estado.logged_in);
    fs::write(&cfg, "{roto").unwrap();
    assert_eq!(login(&t.0), ResultadoLogin { estado: EstadoLogin::default(), aviso: None });
    fs::write(&cfg, "\u{feff}{\"loggedInUsers\":[{\"login\":\"x\"}]}").unwrap();
    assert!(login(&t.0).estado.logged_in);
    fs::write(&cfg, "{\"lastLoggedInUser\":{\"login\":\"x\"}}").unwrap();
    assert!(!login(&t.0).estado.logged_in);
    assert_eq!(login(&t.0.join("no-existe")), ResultadoLogin { estado: EstadoLogin::default(), aviso: None });
}

#[test]
fn login_de_copilot_no_lee_lo_que_no_es_archivo_regular_ni_lo_enorme_y_avisa() {
    let t = Temporal::nuevo("sloth-fs-copilot-raro");
    let cfg = t.0.join("config.json");
    fs::create_dir(&cfg).unwrap();
    let r = estado_login(ProveedorId::Copilot, &t.0);
    assert!(!r.estado.logged_in);
    let aviso = r.aviso.expect("un directorio da aviso");
    assert_eq!(aviso.origen, "copilot");
    assert!(aviso.texto.starts_with("no pude leer el login de Copilot en "), "{}", aviso.texto);
    assert!(aviso.texto.ends_with("no es un archivo regular o es demasiado grande"));
    fs::remove_dir(&cfg).unwrap();
    let relleno = "a".repeat(1024 * 1024);
    fs::write(&cfg, format!("{{\"loggedInUsers\":[{{\"login\":\"x\"}}],\"relleno\":\"{relleno}\"}}")).unwrap();
    let r = estado_login(ProveedorId::Copilot, &t.0);
    assert!(!r.estado.logged_in);
    assert!(r.aviso.is_some());
}

#[test]
fn preparar_carpeta_codex_crea_config_toml_no_pisa_uno_existente_y_no_deja_tmp() {
    let t = Temporal::nuevo("sloth-fs-prep-codex");
    let cuenta = t.0.join("a").join("codex");
    assert!(preparar_carpeta(ProveedorId::Codex, &cuenta).unwrap().is_empty());
    assert_eq!(fs::read_to_string(cuenta.join("config.toml")).unwrap(), CONFIG_INICIAL);
    let nombres = |d: &Path| -> Vec<String> { fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect() };
    assert_eq!(nombres(&cuenta), v(&["config.toml"]));

    let propia = t.0.join("b");
    fs::create_dir(&propia).unwrap();
    fs::write(propia.join("config.toml"), "model = \"x\"\n").unwrap();
    let avisos = preparar_carpeta(ProveedorId::Codex, &propia).unwrap();
    assert_eq!(fs::read_to_string(propia.join("config.toml")).unwrap(), "model = \"x\"\n");
    assert_eq!(nombres(&propia), v(&["config.toml"]));
    assert_eq!(avisos.len(), 1);
    assert_eq!(avisos[0].origen, "codex");
    assert!(avisos[0].texto.contains(CLAVE_ALMACEN));
}

#[test]
fn preparar_carpeta_codex_con_la_clave_ya_fijada_no_avisa() {
    let t = Temporal::nuevo("sloth-fs-prep-codex-ok");
    fs::write(t.0.join("config.toml"), "# propio\ncli_auth_credentials_store = \"file\"\n").unwrap();
    assert!(preparar_carpeta_codex(&t.0).unwrap().is_empty());
}

#[test]
fn preparar_carpeta_codex_tolera_un_tmp_viejo_y_corre_dos_veces() {
    let t = Temporal::nuevo("sloth-fs-prep-codex-tmp");
    let viejo = t.0.join(format!("config.toml.tmp-{}", std::process::id()));
    fs::write(&viejo, "resto").unwrap();
    preparar_carpeta_codex(&t.0).unwrap();
    preparar_carpeta_codex(&t.0).unwrap();
    assert_eq!(fs::read_to_string(t.0.join("config.toml")).unwrap(), CONFIG_INICIAL);
    let nombres: HashSet<String> = fs::read_dir(&t.0).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(nombres, HashSet::from(["config.toml".to_string(), viejo.file_name().unwrap().to_string_lossy().into_owned()]));
}

#[test]
fn preparar_carpeta_copilot_crea_la_carpeta_y_puede_correr_dos_veces() {
    let t = Temporal::nuevo("sloth-fs-prep-copilot");
    let cuenta = t.0.join("a").join("copilot");
    assert!(preparar_carpeta(ProveedorId::Copilot, &cuenta).unwrap().is_empty());
    preparar_carpeta(ProveedorId::Copilot, &cuenta).unwrap();
    assert!(cuenta.is_dir());
}

#[test]
fn preparar_carpeta_de_claude_no_hace_nada() {
    let t = Temporal::nuevo("sloth-fs-prep-claude");
    let cuenta = t.0.join("no-se-crea");
    assert!(preparar_carpeta(ProveedorId::Claude, &cuenta).unwrap().is_empty());
    assert!(!cuenta.exists());
}

#[test]
fn nombre_de_carpeta_de_proyecto_cambia_todo_lo_no_alfanumerico() {
    assert_eq!(nombre_carpeta_proyecto("C:\\Users\\TOMY\\Documents\\Sloth"), "C--Users-TOMY-Documents-Sloth");
    assert_eq!(nombre_carpeta_proyecto("/home/a.b/c d"), "-home-a-b-c-d");
    assert_eq!(nombre_carpeta_proyecto("Tomás"), "Tom-s");
    assert_eq!(nombre_carpeta_proyecto("a😀b"), "a--b");
}

#[test]
fn conversacion_previa_de_claude_pide_algun_jsonl_en_la_carpeta_del_cwd() {
    let t = Temporal::nuevo("sloth-fs-conv");
    let cwd = "C:\\repos\\app";
    assert!(!hay_conversacion_previa(ProveedorId::Claude, &t.0, cwd));
    let dir = t.0.join("projects").join("C--repos-app");
    fs::create_dir_all(&dir).unwrap();
    assert!(!hay_conversacion_previa(ProveedorId::Claude, &t.0, cwd));
    fs::write(dir.join("notas.txt"), "").unwrap();
    assert!(!hay_conversacion_previa(ProveedorId::Claude, &t.0, cwd));
    fs::write(dir.join("0b9f.jsonl"), "").unwrap();
    assert!(hay_conversacion_previa(ProveedorId::Claude, &t.0, cwd));
    assert!(!hay_conversacion_previa(ProveedorId::Claude, &t.0, "C:\\repos\\otra"));
}

#[test]
fn codex_y_copilot_nunca_deducen_conversacion_previa() {
    let t = Temporal::nuevo("sloth-fs-conv-otros");
    let dia = t.0.join("sessions").join("2026").join("11").join("17");
    fs::create_dir_all(&dia).unwrap();
    fs::write(dia.join("rollout-2026-11-17T10-00-00-0b9f6b1e-3c7a-4d2e-9a51-6f1c2d3e4f50.jsonl"), "").unwrap();
    assert!(!hay_conversacion_previa(ProveedorId::Codex, &t.0, "C:/otro-repo"));
    assert!(!hay_conversacion_previa(ProveedorId::Copilot, Path::new("C:/x"), "C:/repo"));
    assert_eq!(argv_interactivo(ProveedorId::Codex, true, None).iter().filter(|a| *a == "resume").count(), 0);
}

fn existentes(rutas: &'static [&'static str]) -> impl Fn(&str) -> bool {
    move |p| rutas.contains(&p)
}

fn sin_archivos(_: &str) -> Option<String> {
    None
}

#[test]
fn claude_exe_en_el_path_gana_sobre_local_bin() {
    let e = existentes(&["C:\\bin\\claude.exe", "C:\\Users\\t\\.local\\bin\\claude.exe"]);
    assert_eq!(resolver_exe_claude("C:\\x;C:\\bin", "C:\\Users\\t", &e, &sin_archivos, true), Some("C:\\bin\\claude.exe".into()));
}

#[test]
fn claude_exe_cae_a_local_bin_del_home() {
    let e = existentes(&["C:\\Users\\t\\.local\\bin\\claude.exe"]);
    assert_eq!(resolver_exe_claude("C:\\x", "C:\\Users\\t", &e, &sin_archivos, true), Some("C:\\Users\\t\\.local\\bin\\claude.exe".into()));
    let e = existentes(&["/home/t/.local/bin/claude.exe"]);
    assert_eq!(resolver_exe_claude("/usr/bin:/bin", "/home/t", &e, &sin_archivos, false), Some("/home/t/.local/bin/claude.exe".into()));
}

#[test]
fn claude_exe_sigue_el_shim_de_npm_a_un_exe() {
    let e = existentes(&["C:\\npm\\claude.cmd", "C:\\npm\\node_modules\\x\\claude.EXE"]);
    let leer = |p: &str| (p == "C:\\npm\\claude.cmd").then(|| "@ECHO off\r\n\"%dp0%\\node_modules\\x\\claude.EXE\"   %*".to_string());
    assert_eq!(resolver_exe_claude("C:\\npm", "C:\\h", &e, &leer, true), Some("C:\\npm\\node_modules\\x\\claude.EXE".into()));
}

#[test]
fn claude_exe_con_shim_de_js_busca_el_exe_del_paquete() {
    let e = existentes(&["C:\\npm\\claude.cmd", "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"]);
    let leer = |_: &str| Some("\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*".to_string());
    assert_eq!(resolver_exe_claude("C:\\npm", "C:\\h", &e, &leer, true), Some("C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe".into()));
}

#[test]
fn claude_exe_sin_nada_o_con_shim_ilegible_da_none() {
    let e = existentes(&["C:\\npm\\claude.cmd"]);
    assert_eq!(resolver_exe_claude("C:\\npm", "C:\\h", &e, &sin_archivos, true), None);
    let leer = |_: &str| Some("echo nada".to_string());
    assert_eq!(resolver_exe_claude("C:\\npm", "C:\\h", &e, &leer, true), None);
    assert_eq!(resolver_exe_claude("", "C:\\h", &existentes(&[]), &sin_archivos, true), None);
}

#[test]
fn claude_exe_un_shim_a_un_exe_que_no_existe_cae_al_paquete_de_js_o_a_none() {
    let e = existentes(&["C:\\npm\\claude.cmd"]);
    let leer = |_: &str| Some("\"%dp0%\\falta\\claude.exe\" %*".to_string());
    assert_eq!(resolver_exe_claude("C:\\npm", "C:\\h", &e, &leer, true), None);
}
