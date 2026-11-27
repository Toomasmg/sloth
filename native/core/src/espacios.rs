//! Alta y cambios de espacios y lo que decide el núcleo para abrirlos: las partes puras de los canales `workspaces:*`
//! y `ui:openPanes` de src/main/index.ts. El worktree, el disco y el sistema operativo los pone quien llama.
use crate::features::templates::{normalizar_id_ticket, rama_valida, TEMPLATE_COLOR_KEYS};
use crate::git_run::valid_branch_name;
use crate::initial_prompt::problema_del_primer_mensaje;
use crate::ipc_guard::id_valido;
use crate::perfiles_core::es_blanco_js;
use crate::workspace_patch::CambioEspacio;
use serde_json::{Map, Value};

pub const PEDIDO_INVALIDO: &str = "Pedido inválido.";
pub const ESPACIO_INEXISTENTE: &str = "Ese espacio ya no existe.";
const MAX_PROMPT: usize = 4000;

fn utf16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `String(v ?? '')` de JS para lo que puede llegar en un campo de texto.
fn texto_js(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Array(a)) => a.iter().map(|x| texto_js(Some(x))).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// Verdad de JS para un valor que llegó por IPC.
fn verdadero_js(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(_) => true,
    }
}

/// Un campo opcional de texto: `x?.trim() || undefined`. Algo que no es texto no tiene `trim` y el pedido se rechaza.
fn opcional(v: Option<&Value>) -> Result<Option<String>, String> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.trim_matches(es_blanco_js).to_owned()).filter(|t| !t.is_empty())),
        Some(_) => Err(PEDIDO_INVALIDO.into()),
    }
}

/// `workspaces:add` antes de mirar nada más: un objeto con un `accountId` válido.
pub fn comprobar_pedido_de_alta(input: &Value) -> Result<(), String> {
    match input.get("accountId") {
        Some(id) if input.is_object() && id_valido(id).is_some() => Ok(()),
        _ => Err(PEDIDO_INVALIDO.into()),
    }
}

#[derive(Debug, PartialEq)]
pub struct AltaValidada {
    pub name: String,
    pub repo_path: String,
    pub account_id: String,
    pub ticket: Option<String>,
    pub initial_prompt: Option<String>,
    pub branch: Option<String>,
    pub base_branch: Option<String>,
    pub color: Option<String>,
    pub auto_start_claude: bool,
    pub resume: bool,
}

/// Las reglas de `addWorkspace` en su orden: nombre, carpeta del repo, cuenta, ticket, primer mensaje, ramas y color.
/// `es_directorio` y `cuenta_valida` son lo que mira el disco y el store.
pub fn validar_alta_de_espacio(input: &Value, es_directorio: &dyn Fn(&str) -> bool, cuenta_valida: &dyn Fn(&str) -> Result<(), String>) -> Result<AltaValidada, String> {
    let name = texto_js(input.get("name")).trim_matches(es_blanco_js).to_owned();
    let repo_path = texto_js(input.get("repoPath")).trim_matches(es_blanco_js).to_owned();
    if name.is_empty() {
        return Err("Poné un nombre.".into());
    }
    if repo_path.is_empty() || !es_directorio(&repo_path) {
        return Err("Elegí una carpeta de repo válida.".into());
    }
    let account_id = input.get("accountId").and_then(Value::as_str).ok_or(PEDIDO_INVALIDO)?.to_owned();
    cuenta_valida(&account_id)?;
    let ticket_crudo = opcional(input.get("ticket"))?;
    let ticket = match &ticket_crudo {
        Some(t) => Some(normalizar_id_ticket(t).ok_or("El ticket solo lleva letras, números, guiones, puntos o _ (p. ej. PROJ-123 o 123).")?),
        None => None,
    };
    let initial_prompt = opcional(input.get("initialPrompt"))?;
    if let Some(p) = &initial_prompt {
        if utf16(p) > MAX_PROMPT {
            return Err("El prompt inicial es demasiado largo.".into());
        }
        if let Some(problema) = problema_del_primer_mensaje(p) {
            return Err(problema.into());
        }
    }
    let branch = opcional(input.get("branch"))?;
    if branch.as_deref().is_some_and(|b| !valid_branch_name(b)) {
        return Err("La rama no es un nombre válido.".into());
    }
    let base_branch = opcional(input.get("baseBranch"))?;
    if base_branch.as_deref().is_some_and(|b| !rama_valida(b)) {
        return Err("La rama base no es un nombre válido.".into());
    }
    let color = match input.get("color") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        Some(v) => Some(texto_js(Some(v))),
    };
    if color.as_deref().is_some_and(|c| !TEMPLATE_COLOR_KEYS.contains(&c)) {
        return Err("El color del espacio no es válido.".into());
    }
    let auto_start_claude = verdadero_js(input.get("autoStartClaude")) || initial_prompt.is_some();
    let resume = input.get("resume") != Some(&Value::Bool(false));
    Ok(AltaValidada { name, repo_path, account_id, ticket, initial_prompt, branch, base_branch, color, auto_start_claude, resume })
}

fn poner(o: &mut Map<String, Value>, k: &str, v: &Option<String>) {
    if let Some(v) = v {
        o.insert(k.into(), Value::String(v.clone()));
    }
}

/// El registro del espacio con las claves en el orden de siempre; lo que no se eligió no aparece.
pub fn armar_registro_de_espacio(a: &AltaValidada, id: String, cwd: String, ahora_ms: u64) -> Value {
    let mut o = Map::new();
    o.insert("id".into(), Value::String(id));
    o.insert("name".into(), Value::String(a.name.clone()));
    o.insert("repoPath".into(), Value::String(a.repo_path.clone()));
    o.insert("cwd".into(), Value::String(cwd));
    poner(&mut o, "branch", &a.branch);
    o.insert("accountId".into(), Value::String(a.account_id.clone()));
    o.insert("autoStartClaude".into(), Value::Bool(a.auto_start_claude));
    o.insert("createdAt".into(), Value::from(ahora_ms));
    poner(&mut o, "initialPrompt", &a.initial_prompt);
    o.insert("resume".into(), Value::Bool(a.resume));
    poner(&mut o, "ticket", &a.ticket);
    poner(&mut o, "color", &a.color);
    Value::Object(o)
}

/// Lo que `workspaces:update` le aplica al store: los campos a mezclar y si hay que sacar el ícono.
#[derive(Debug, PartialEq)]
pub struct ParcheDeEspacio {
    pub campos: Map<String, Value>,
    pub quitar_icono: bool,
}

pub fn parche_de_cambio(c: &CambioEspacio) -> ParcheDeEspacio {
    let mut campos = Map::new();
    if let Some(n) = &c.name {
        campos.insert("name".into(), Value::String(n.clone()));
    }
    if let Some(Some(i)) = &c.icon {
        campos.insert("icon".into(), Value::String(i.clone()));
    }
    ParcheDeEspacio { campos, quitar_icono: matches!(c.icon, Some(None)) }
}

/// Aplica el parche a una copia del espacio: lo que el store no sabe borrar se saca acá.
pub fn aplicar_parche(ws: &Value, p: &ParcheDeEspacio) -> Value {
    let mut o = ws.as_object().cloned().unwrap_or_default();
    for (k, v) in &p.campos {
        o.insert(k.clone(), v.clone());
    }
    if p.quitar_icono {
        o.shift_remove("icon");
    }
    Value::Object(o)
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum DestinoReveal {
    Carpeta,
    Editor,
}

pub fn destino_de_reveal(target: &Value) -> Result<DestinoReveal, String> {
    match target.as_str() {
        Some("folder") => Ok(DestinoReveal::Carpeta),
        Some("vscode") => Ok(DestinoReveal::Editor),
        _ => Err("Destino inválido.".into()),
    }
}

/// Editores de «Abrir en editor»: protocolo para abrir una carpeta. Bloc de notas no tiene: usa el Explorador.
pub fn esquema_de_editor(editor: &str) -> Option<&'static str> {
    match editor {
        "VS Code" => Some("vscode"),
        "Cursor" => Some("cursor"),
        "Windsurf" => Some("windsurf"),
        _ => None,
    }
}

/// Como `encodeURIComponent`: deja pasar letras, números y `-_.!~*'()`.
pub fn codificar_componente(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `vscode://file/<ruta>/` con cada tramo codificado (rutas con #, ?, espacios o acentos); la letra de unidad queda como está.
pub fn url_de_editor(esquema: &str, cwd: &str) -> String {
    let partes: Vec<String> = cwd
        .split(['\\', '/'])
        .filter(|s| !s.is_empty())
        .enumerate()
        .map(|(k, seg)| {
            let unidad = k == 0 && seg.len() == 2 && seg.as_bytes()[0].is_ascii_alphabetic() && seg.as_bytes()[1] == b':';
            if unidad { seg.to_owned() } else { codificar_componente(seg) }
        })
        .collect();
    format!("{esquema}://file/{}/", partes.join("/"))
}

pub fn error_al_abrir_editor(editor: &str) -> String {
    format!("No se pudo abrir {editor}. ¿Está instalado?")
}

pub fn error_sin_carpeta(cwd: &str) -> String {
    format!("No existe la carpeta {cwd}")
}

/// `ui:openPanes`: de lo que llegue solo se guardan los textos; si no es una lista no se toca nada.
pub fn paneles_a_guardar(v: &Value) -> Option<Vec<String>> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
}

/// `state:get`: sin «Reabrir los espacios» solo vuelven los paneles cuyas terminales siguen vivas en el daemon.
/// `vivo` es `None` si el backend no arrancó.
pub fn paneles_al_abrir(guardados: &[String], reabrir: bool, vivo: Option<&dyn Fn(&str) -> bool>) -> Vec<String> {
    if reabrir {
        return guardados.to_vec();
    }
    match vivo {
        Some(f) => guardados.iter().filter(|id| f(id)).cloned().collect(),
        None => vec![],
    }
}

/// Qué argv de Claude arranca en la terminal de un espacio.
#[derive(Debug, PartialEq, Eq)]
pub enum ComandoDeAgente {
    /// Un reemplazo (p. ej. retomar tras mover de cuenta): ya viene armado.
    Reemplazo(Vec<String>),
    /// El espacio no arranca el agente solo.
    Ninguno,
    ConPrompt(String),
    Interactivo { continuar: bool },
}

pub struct EntradaComando<'a> {
    pub override_claude: bool,
    pub reemplazos: &'a [Option<String>],
    pub auto_start: bool,
    pub initial_prompt: Option<&'a str>,
    pub prompt_usado: bool,
    pub resume: Option<bool>,
}

/// `hay_conversacion_previa` se consulta solo cuando hace falta (toca el disco).
pub fn decidir_comando(e: &EntradaComando, hay_conversacion_previa: &mut dyn FnMut() -> bool) -> ComandoDeAgente {
    if e.override_claude {
        if let Some(cmd) = e.reemplazos.iter().flatten().find(|c| !c.is_empty()) {
            return ComandoDeAgente::Reemplazo(cmd.split_whitespace().map(str::to_owned).collect());
        }
    }
    if !e.auto_start {
        return ComandoDeAgente::Ninguno;
    }
    // Un «!» inicial Claude Code lo correría como comando de la terminal: ese prompt no se manda.
    if let Some(p) = e.initial_prompt.filter(|p| !p.is_empty()) {
        if !e.prompt_usado && problema_del_primer_mensaje(p).is_none() {
            return ComandoDeAgente::ConPrompt(p.to_owned());
        }
    }
    ComandoDeAgente::Interactivo { continuar: e.resume != Some(false) && hay_conversacion_previa() }
}

/// Con Claude, un exe que no se encuentra sigue como siempre (la shell lo busca). Con otro agente es un error claro.
pub fn error_exe_no_encontrado(nombre: &str, como_instalar: &str) -> String {
    format!("No encontré {nombre} en el PATH. Instalalo con: {como_instalar}")
}

/// Primer mensaje que no se pudo pasar como argumento: se pega en el primer SessionStart del espacio.
pub const VIGENCIA_PEGADO_MS: u64 = 2 * 60 * 1000;
pub const ESPERA_PEGADO_MS: u64 = 1500;

#[derive(Debug, PartialEq, Eq)]
pub enum DecisionPegado {
    Vencido(String),
    Pegar,
}

pub fn decidir_pegado(ahora: u64, hasta: u64, nombre_espacio: Option<&str>) -> DecisionPegado {
    if ahora > hasta {
        return DecisionPegado::Vencido(format!("Claude tardó en arrancar en «{}» y no le pegué el primer mensaje: escribilo a mano.", nombre_espacio.unwrap_or("un espacio")));
    }
    DecisionPegado::Pegar
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn alta(input: Value) -> Result<AltaValidada, String> {
        validar_alta_de_espacio(&input, &|_| true, &|_| Ok(()))
    }

    #[test]
    fn el_pedido_de_alta_necesita_un_objeto_con_cuenta() {
        assert!(comprobar_pedido_de_alta(&json!({ "accountId": "a" })).is_ok());
        for malo in [json!(null), json!("x"), json!({}), json!({ "accountId": "" }), json!({ "accountId": 3 })] {
            assert_eq!(comprobar_pedido_de_alta(&malo), Err(PEDIDO_INVALIDO.into()), "{malo}");
        }
    }

    #[test]
    fn el_alta_minima_arma_el_registro_en_orden() {
        let a = alta(json!({ "name": "  api ", "repoPath": " C:/repo ", "accountId": "a" })).unwrap();
        let ws = armar_registro_de_espacio(&a, "w1".into(), "C:/repo".into(), 5);
        assert_eq!(ws, json!({ "id": "w1", "name": "api", "repoPath": "C:/repo", "cwd": "C:/repo", "accountId": "a", "autoStartClaude": false, "createdAt": 5, "resume": true }));
        assert_eq!(ws.as_object().unwrap().keys().collect::<Vec<_>>(), ["id", "name", "repoPath", "cwd", "accountId", "autoStartClaude", "createdAt", "resume"]);
    }

    #[test]
    fn el_alta_completa_conserva_el_orden_de_claves() {
        let a = alta(json!({ "name": "x", "repoPath": "r", "accountId": "a", "branch": "feat/x", "baseBranch": "main", "ticket": "proj-12", "initialPrompt": " hola ", "color": "lila", "resume": false })).unwrap();
        assert_eq!(a.ticket.as_deref(), Some("PROJ-12"));
        assert_eq!(a.initial_prompt.as_deref(), Some("hola"));
        assert!(a.auto_start_claude && !a.resume);
        let ws = armar_registro_de_espacio(&a, "w".into(), "C:/wt".into(), 1);
        assert_eq!(ws.as_object().unwrap().keys().collect::<Vec<_>>(), ["id", "name", "repoPath", "cwd", "branch", "accountId", "autoStartClaude", "createdAt", "initialPrompt", "resume", "ticket", "color"]);
    }

    #[test]
    fn el_nombre_y_el_repo_se_piden_en_ese_orden() {
        assert_eq!(alta(json!({ "name": "  ", "repoPath": "" })).unwrap_err(), "Poné un nombre.");
        assert_eq!(alta(json!({ "name": "x", "repoPath": "  " })).unwrap_err(), "Elegí una carpeta de repo válida.");
        let r = validar_alta_de_espacio(&json!({ "name": "x", "repoPath": "r", "accountId": "a" }), &|_| false, &|_| Ok(()));
        assert_eq!(r.unwrap_err(), "Elegí una carpeta de repo válida.");
    }

    #[test]
    fn la_cuenta_se_comprueba_despues_del_repo_y_antes_del_ticket() {
        let r = validar_alta_de_espacio(&json!({ "name": "x", "repoPath": "r", "accountId": "a", "ticket": "!!" }), &|_| true, &|_| Err("sin cuenta".into()));
        assert_eq!(r.unwrap_err(), "sin cuenta");
    }

    #[test]
    fn ticket_prompt_ramas_y_color_se_validan() {
        let base = |extra: Value| {
            let mut v = json!({ "name": "x", "repoPath": "r", "accountId": "a" });
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            alta(v)
        };
        assert!(base(json!({ "ticket": "a b" })).unwrap_err().contains("El ticket solo lleva"));
        assert_eq!(base(json!({ "ticket": "   " })).unwrap().ticket, None);
        assert_eq!(base(json!({ "ticket": "123" })).unwrap().ticket.as_deref(), Some("123"));
        assert_eq!(base(json!({ "initialPrompt": "a".repeat(4001) })).unwrap_err(), "El prompt inicial es demasiado largo.");
        assert!(base(json!({ "initialPrompt": "a".repeat(4000) })).is_ok());
        assert!(base(json!({ "initialPrompt": " !ls" })).unwrap_err().contains("«!»"));
        assert_eq!(base(json!({ "branch": "-x" })).unwrap_err(), "La rama no es un nombre válido.");
        assert_eq!(base(json!({ "baseBranch": "a..b" })).unwrap_err(), "La rama base no es un nombre válido.");
        assert_eq!(base(json!({ "color": "rojo" })).unwrap_err(), "El color del espacio no es válido.");
        assert_eq!(base(json!({ "color": "" })).unwrap().color, None);
        assert_eq!(base(json!({ "color": null })).unwrap().color, None);
        assert_eq!(base(json!({ "color": "coral" })).unwrap().color.as_deref(), Some("coral"));
        assert_eq!(base(json!({ "color": 3 })).unwrap_err(), "El color del espacio no es válido.");
    }

    #[test]
    fn un_campo_de_texto_que_no_es_texto_se_rechaza() {
        for campo in ["ticket", "initialPrompt", "branch", "baseBranch"] {
            let r = alta(json!({ "name": "x", "repoPath": "r", "accountId": "a", campo: 5 }));
            assert_eq!(r.unwrap_err(), PEDIDO_INVALIDO, "{campo}");
        }
    }

    #[test]
    fn nombre_y_repo_numericos_se_pasan_a_texto_como_en_js() {
        let a = alta(json!({ "name": 12, "repoPath": 3.5, "accountId": "a" })).unwrap();
        assert_eq!((a.name.as_str(), a.repo_path.as_str()), ("12", "3.5"));
    }

    #[test]
    fn autostart_sale_de_la_verdad_de_js_o_de_un_prompt() {
        for (v, esperado) in [(json!(true), true), (json!(false), false), (json!(1), true), (json!(0), false), (json!("x"), true), (json!(""), false), (json!(null), false)] {
            let a = alta(json!({ "name": "x", "repoPath": "r", "accountId": "a", "autoStartClaude": v })).unwrap();
            assert_eq!(a.auto_start_claude, esperado, "{v}");
        }
        assert!(alta(json!({ "name": "x", "repoPath": "r", "accountId": "a", "initialPrompt": "hola" })).unwrap().auto_start_claude);
    }

    #[test]
    fn resume_solo_es_falso_con_false() {
        for (v, esperado) in [(json!(false), false), (json!(0), true), (json!(null), true), (json!("no"), true)] {
            assert_eq!(alta(json!({ "name": "x", "repoPath": "r", "accountId": "a", "resume": v })).unwrap().resume, esperado, "{v}");
        }
    }

    #[test]
    fn el_cambio_de_espacio_se_traduce_a_parche_y_el_icono_se_saca_aparte() {
        let c = CambioEspacio { name: Some("nuevo".into()), icon: Some(Some("🚀".into())) };
        let p = parche_de_cambio(&c);
        assert_eq!(p.campos.get("name"), Some(&json!("nuevo")));
        assert!(!p.quitar_icono);
        let q = parche_de_cambio(&CambioEspacio { name: None, icon: Some(None) });
        assert!(q.campos.is_empty() && q.quitar_icono);
        let ws = json!({ "id": "w", "name": "a", "icon": "x", "cwd": "c" });
        assert_eq!(aplicar_parche(&ws, &q), json!({ "id": "w", "name": "a", "cwd": "c" }));
        assert_eq!(aplicar_parche(&ws, &p)["icon"], "🚀");
        assert!(parche_de_cambio(&CambioEspacio::default()).campos.is_empty());
    }

    #[test]
    fn destino_de_reveal_acepta_carpeta_y_editor() {
        assert_eq!(destino_de_reveal(&json!("folder")), Ok(DestinoReveal::Carpeta));
        assert_eq!(destino_de_reveal(&json!("vscode")), Ok(DestinoReveal::Editor));
        assert_eq!(destino_de_reveal(&json!("otro")), Err("Destino inválido.".into()));
        assert_eq!(destino_de_reveal(&json!(null)), Err("Destino inválido.".into()));
    }

    #[test]
    fn los_editores_con_protocolo_y_el_bloc_de_notas_sin_el() {
        assert_eq!(esquema_de_editor("VS Code"), Some("vscode"));
        assert_eq!(esquema_de_editor("Cursor"), Some("cursor"));
        assert_eq!(esquema_de_editor("Windsurf"), Some("windsurf"));
        assert_eq!(esquema_de_editor("Bloc de notas"), None);
    }

    #[test]
    fn la_url_del_editor_codifica_cada_tramo_y_deja_la_unidad() {
        assert_eq!(url_de_editor("vscode", "C:\\Users\\Tomás\\mi repo#1"), "vscode://file/C:/Users/Tom%C3%A1s/mi%20repo%231/");
        assert_eq!(url_de_editor("cursor", "/home/x/y"), "cursor://file/home/x/y/");
        assert_eq!(url_de_editor("vscode", "D:/a//b"), "vscode://file/D:/a/b/");
        assert_eq!(codificar_componente("a-b_c.d!~*'()?"), "a-b_c.d!~*'()%3F");
    }

    #[test]
    fn los_paneles_abiertos_solo_guardan_textos() {
        assert_eq!(paneles_a_guardar(&json!(["a", 3, "b", null])), Some(vec!["a".into(), "b".into()]));
        assert_eq!(paneles_a_guardar(&json!("a")), None);
    }

    #[test]
    fn sin_reabrir_solo_vuelven_los_paneles_con_terminal_viva() {
        let g = vec!["a".to_owned(), "b".to_owned()];
        assert_eq!(paneles_al_abrir(&g, true, None), g);
        assert_eq!(paneles_al_abrir(&g, false, None), Vec::<String>::new());
        assert_eq!(paneles_al_abrir(&g, false, Some(&|id: &str| id == "b")), vec!["b".to_owned()]);
    }

    fn entrada<'a>(reemplazos: &'a [Option<String>]) -> EntradaComando<'a> {
        EntradaComando { override_claude: true, reemplazos, auto_start: true, initial_prompt: None, prompt_usado: false, resume: None }
    }

    #[test]
    fn el_primer_reemplazo_con_comando_gana_y_se_parte_en_palabras() {
        let r = [None, Some(String::new()), Some("claude --resume  abc".into()), Some("otro".into())];
        assert_eq!(decidir_comando(&entrada(&r), &mut || panic!("no hace falta")), ComandoDeAgente::Reemplazo(vec!["claude".into(), "--resume".into(), "abc".into()]));
    }

    #[test]
    fn los_reemplazos_no_corren_con_agentes_que_no_los_tienen() {
        let r = [Some("claude x".into())];
        let e = EntradaComando { override_claude: false, auto_start: false, ..entrada(&r) };
        assert_eq!(decidir_comando(&e, &mut || true), ComandoDeAgente::Ninguno);
    }

    #[test]
    fn con_prompt_sin_usar_va_el_prompt_y_si_ya_se_uso_se_retoma() {
        let e = EntradaComando { initial_prompt: Some("/ticket X-1"), ..entrada(&[]) };
        assert_eq!(decidir_comando(&e, &mut || panic!("no hace falta")), ComandoDeAgente::ConPrompt("/ticket X-1".into()));
        let e = EntradaComando { prompt_usado: true, ..e };
        assert_eq!(decidir_comando(&e, &mut || true), ComandoDeAgente::Interactivo { continuar: true });
        let e = EntradaComando { initial_prompt: Some("!ls"), prompt_usado: false, ..e };
        assert_eq!(decidir_comando(&e, &mut || false), ComandoDeAgente::Interactivo { continuar: false });
    }

    #[test]
    fn retomar_depende_de_resume_y_de_que_haya_conversacion() {
        assert_eq!(decidir_comando(&entrada(&[]), &mut || true), ComandoDeAgente::Interactivo { continuar: true });
        let e = EntradaComando { resume: Some(false), ..entrada(&[]) };
        assert_eq!(decidir_comando(&e, &mut || panic!("no hace falta")), ComandoDeAgente::Interactivo { continuar: false });
    }

    #[test]
    fn los_textos_de_error_nombran_lo_que_falta() {
        assert_eq!(error_exe_no_encontrado("Codex", "npm i -g @openai/codex"), "No encontré Codex en el PATH. Instalalo con: npm i -g @openai/codex");
        assert_eq!(error_al_abrir_editor("Cursor"), "No se pudo abrir Cursor. ¿Está instalado?");
        assert_eq!(error_sin_carpeta("C:/x"), "No existe la carpeta C:/x");
    }

    #[test]
    fn el_pegado_vence_a_los_dos_minutos() {
        assert_eq!(decidir_pegado(100, 100, Some("api")), DecisionPegado::Pegar);
        assert_eq!(decidir_pegado(101, 100, Some("api")), DecisionPegado::Vencido("Claude tardó en arrancar en «api» y no le pegué el primer mensaje: escribilo a mano.".into()));
        assert_eq!(decidir_pegado(101, 100, None), DecisionPegado::Vencido("Claude tardó en arrancar en «un espacio» y no le pegué el primer mensaje: escribilo a mano.".into()));
        assert_eq!(VIGENCIA_PEGADO_MS, 120_000);
    }
}
