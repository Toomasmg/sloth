use super::*;
use serde_json::json;
use std::sync::atomic::AtomicU32;

const U1: &str = "11111111-2222-3333-4444-555555555555";
const U2: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

struct Temporal(PathBuf);

impl Temporal {
    fn nuevo() -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!("sloth-hist-rs-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        Temporal(d)
    }

    fn escribir(&self, rel: &str, contenido: &str) -> PathBuf {
        let f = self.0.join(rel);
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(&f, contenido).unwrap();
        f
    }
}

impl Drop for Temporal {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn cuenta(t: &Temporal, id: &str) -> CuentaBusqueda {
    CuentaBusqueda { id: id.into(), label: format!("Cuenta {id}"), config_dir: t.0.join(id) }
}

fn msg(tipo: &str, texto: &str, ts: &str) -> String {
    json!({ "type": tipo, "timestamp": ts, "cwd": "C:\\repo\\app", "message": { "role": tipo, "content": texto } }).to_string()
}

fn m(q: &str, texto: &str) -> bool {
    construir_matcher(q, false).unwrap().is_match(texto)
}

fn buscar(files: &[ArchivoSesion], q: &str, opts: OpcionesBusqueda) -> (Vec<ItemHistorial>, EstadisticasBusqueda) {
    let mut todos = Vec::new();
    let st = buscar_sesiones(files, q, &AtomicBool::new(false), &mut |i| todos.extend(i), &opts).unwrap();
    (todos, st)
}

#[test]
fn plegar_saca_acentos_y_mayusculas() {
    assert_eq!(plegar("Canción ÁÉÍÓÚ Ñandú"), "cancion aeiou nandu");
}

#[test]
fn matcher_ignora_mayusculas_y_acentos_en_ambos_sentidos() {
    assert!(m("cancion", "Una CANCIÓN linda"));
    assert!(m("canción", "una cancion linda"));
    assert!(m("ñandu", "el ÑANDÚ corre"));
    assert!(!m("cancion", "cantar"));
}

#[test]
fn matcher_acepta_acento_descompuesto() {
    assert!(m("cancion", "canción"));
}

#[test]
fn matcher_espacios_son_cualquier_blanco() {
    assert!(m("hola   mundo", "hola\n\tmundo"));
    assert!(m("hola mundo", "hola\u{a0}mundo"));
    assert!(!m("hola mundo", "holamundo"));
}

#[test]
fn matcher_escapa_metacaracteres() {
    assert!(m("a.b", "xa.by"));
    assert!(!m("a.b", "axb"));
    assert!(m("(x)+[y]", "(x)+[y]"));
    assert!(m("a-b", "a-b"));
}

#[test]
fn matcher_json_tolera_saltos_y_barras() {
    let re = construir_matcher("hola mundo", true).unwrap();
    assert!(re.is_match(r#"{"text":"hola\nmundo"}"#));
    assert!(re.is_match("hola mundo"));
    let ruta = construir_matcher(r"c:\repo\app", true).unwrap();
    assert!(ruta.is_match(r"C:\\repo\\app"));
    assert!(ruta.is_match(r"c:\repo\app"));
    let comilla = construir_matcher(r#"dijo "hola""#, true).unwrap();
    assert!(comilla.is_match(r#"dijo \"hola\""#));
}

#[test]
fn matcher_con_consulta_larga_compila() {
    let q = "á".repeat(200);
    assert!(construir_matcher(&q, true).is_ok());
}

#[test]
fn texto_mensaje_une_solo_bloques_de_texto() {
    let c = json!([{ "type": "text", "text": "uno" }, { "type": "tool_use", "name": "x" }, { "type": "text", "text": "dos" }]);
    assert_eq!(texto_mensaje(Some(&c)), "uno\ndos");
    assert_eq!(texto_mensaje(Some(&json!("directo"))), "directo");
    assert_eq!(texto_mensaje(Some(&json!(5))), "");
    assert_eq!(texto_mensaje(None), "");
}

fn u16s(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

#[test]
fn recorte_corto_no_agrega_elipsis() {
    let t = "hola mundo cruel";
    let r = recorte(&u16s(t), 5, 5);
    assert_eq!((r.before.as_str(), r.coincidencia.as_str(), r.after.as_str()), ("hola ", "mundo", " cruel"));
}

#[test]
fn recorte_largo_corta_en_palabras() {
    let t = format!("{} MEDIO {}", "palabra ".repeat(30), "otra ".repeat(60));
    let index = t.find("MEDIO").unwrap();
    let r = recorte(&u16s(&t), index, 5);
    assert!(r.before.starts_with('…'));
    assert!(r.after.ends_with('…'));
    assert!(r.after.chars().count() <= DESPUES + 1);
    assert_eq!(r.coincidencia, "MEDIO");
    assert!(!r.before.contains("  "));
}

#[test]
fn recorte_cuenta_utf16_y_no_parte_caracteres() {
    // Cada emoji ocupa 2 unidades UTF-16: el recorte anterior es de 70 unidades, no de 70 caracteres.
    let t = format!("{}X fin", "😀".repeat(60));
    let index = largo16(&t[..t.find('X').unwrap()]);
    let r = recorte(&u16s(&t), index, 1);
    assert_eq!(r.coincidencia, "X");
    assert_eq!(r.before.chars().filter(|c| *c == '😀').count(), 35);
    assert!(!r.before.contains('\u{fffd}'));
}

#[test]
fn recorte_sin_blancos_deja_el_before_entero() {
    let t = format!("{}X", "a".repeat(100));
    let r = recorte(&u16s(&t), 100, 1);
    assert_eq!(r.before, format!("…{}", "a".repeat(70)));
}

fn armar(t: &Temporal, cuenta_id: &str, slug: &str, id: &str, lineas: &[String]) -> PathBuf {
    t.escribir(&format!("{cuenta_id}/projects/{slug}/{id}.jsonl"), &(lineas.join("\n") + "\n"))
}

#[test]
fn listar_filtra_nombres_y_ordena_por_fecha() {
    let t = Temporal::nuevo();
    let a = armar(&t, "c1", "p", U1, &[msg("user", "hola", "2026-01-01T00:00:00Z")]);
    armar(&t, "c1", "p", U2, &[msg("user", "chau", "2026-01-01T00:00:00Z")]);
    t.escribir("c1/projects/p/no-es-uuid.jsonl", "x\n");
    t.escribir(&format!("c1/projects/p/{U1}.txt"), "x\n");
    t.escribir(&format!("c1/projects/p/{}.jsonl", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"), "");
    let viejo = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
    File::options().write(true).open(&a).unwrap().set_modified(viejo).unwrap();
    let r = listar_sesiones(&[cuenta(&t, "c1"), cuenta(&t, "inexistente")]);
    assert_eq!(r.iter().map(|f| f.session_id.as_str()).collect::<Vec<_>>(), vec![U2, U1]);
    let recientes = listar_sesiones_recientes(&[cuenta(&t, "c1")], r[1].mtime_ms + 1);
    assert_eq!(recientes.len(), 1);
}

#[test]
fn busca_y_arma_el_resultado() {
    let t = Temporal::nuevo();
    armar(
        &t,
        "c1",
        "p",
        U1,
        &[
            msg("user", "Necesito una CANCIÓN para dormir", "2026-11-17T10:00:00.500Z"),
            msg("assistant", "Te dejo la canción", "2026-11-17T10:01:00Z"),
            msg("user", "otra cosa", "2026-11-17T10:02:00Z"),
        ],
    );
    let files = listar_sesiones(&[cuenta(&t, "c1")]);
    let (items, st) = buscar(&files, "cancion", OpcionesBusqueda::default());
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].role, Rol::User);
    assert_eq!(items[0].before, "Necesito una ");
    assert_eq!(items[0].coincidencia, "CANCIÓN");
    assert_eq!(items[0].after, " para dormir");
    assert_eq!(items[0].ts, 1_794_909_600_500);
    assert_eq!(items[0].cwd, "C:\\repo\\app");
    assert_eq!(items[1].role, Rol::Assistant);
    assert_eq!((st.files, st.total, st.truncated, st.cancelled), (1, 2, false, false));
    assert!(st.bytes > 0);
}

#[test]
fn ignora_meta_sidechain_y_otros_tipos() {
    let t = Temporal::nuevo();
    let meta = json!({ "type": "user", "isMeta": true, "message": { "content": "secreto meta" } }).to_string();
    let lado = json!({ "type": "user", "isSidechain": true, "message": { "content": "secreto lado" } }).to_string();
    let resumen = json!({ "type": "summary", "summary": "secreto resumen" }).to_string();
    let tool = json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "input": { "x": "secreto tool" } }] } }).to_string();
    armar(&t, "c1", "p", U1, &[meta, lado, resumen, tool, msg("user", "secreto visible", "2026-01-01T00:00:00Z")]);
    let files = listar_sesiones(&[cuenta(&t, "c1")]);
    let (items, _) = buscar(&files, "secreto", OpcionesBusqueda::default());
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].coincidencia, "secreto");
    assert_eq!(items[0].after, " visible");
}

#[test]
fn encuentra_texto_con_salto_de_linea_escapado() {
    let t = Temporal::nuevo();
    armar(&t, "c1", "p", U1, &[msg("user", "primera parte\nsegunda parte", "2026-01-01T00:00:00Z")]);
    let files = listar_sesiones(&[cuenta(&t, "c1")]);
    let (items, _) = buscar(&files, "parte segunda", OpcionesBusqueda::default());
    assert_eq!(items.len(), 1);
    let (items, _) = buscar(&files, "segunda primera", OpcionesBusqueda::default());
    assert_eq!(items.len(), 0);
    let (items, _) = buscar(&files, "primera parte segunda", OpcionesBusqueda::default());
    assert_eq!(items.len(), 1);
}

#[test]
fn tope_por_sesion_y_total() {
    let t = Temporal::nuevo();
    let lineas: Vec<String> = (0..40).map(|i| msg("user", &format!("clave {i}"), "2026-01-01T00:00:00Z")).collect();
    armar(&t, "c1", "p", U1, &lineas);
    armar(&t, "c1", "p", U2, &lineas);
    let files = listar_sesiones(&[cuenta(&t, "c1")]);
    let (items, st) = buscar(&files, "clave", OpcionesBusqueda::default());
    assert_eq!(items.len(), 2 * MAX_POR_SESION);
    assert!(!st.truncated);
    let (items, st) = buscar(&files, "clave", OpcionesBusqueda { max: Some(30), ..Default::default() });
    assert_eq!(items.len(), 30);
    assert!(st.truncated);
}

#[test]
fn filtra_por_cuenta() {
    let t = Temporal::nuevo();
    armar(&t, "c1", "p", U1, &[msg("user", "foo uno", "2026-01-01T00:00:00Z")]);
    armar(&t, "c2", "p", U2, &[msg("user", "foo dos", "2026-01-01T00:00:00Z")]);
    let files = listar_sesiones(&[cuenta(&t, "c1"), cuenta(&t, "c2")]);
    let (items, st) = buscar(&files, "foo", OpcionesBusqueda { account_id: Some("c2".into()), ..Default::default() });
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].account_id, "c2");
    assert_eq!(st.files, 1);
}

#[test]
fn cancelacion_corta_antes_de_emitir() {
    let t = Temporal::nuevo();
    armar(&t, "c1", "p", U1, &[msg("user", "foo", "2026-01-01T00:00:00Z")]);
    let files = listar_sesiones(&[cuenta(&t, "c1")]);
    let cancelado = AtomicBool::new(true);
    let mut n = 0;
    let st = buscar_sesiones(&files, "foo", &cancelado, &mut |_| n += 1, &OpcionesBusqueda::default()).unwrap();
    assert_eq!((n, st.files, st.cancelled), (0, 0, true));
}

#[test]
fn cancelacion_durante_la_busqueda_no_emite_ese_archivo() {
    let t = Temporal::nuevo();
    armar(&t, "c1", "p", U1, &[msg("user", "foo", "2026-01-01T00:00:00Z")]);
    armar(&t, "c1", "p", U2, &[msg("user", "foo", "2026-01-01T00:00:00Z")]);
    let files = listar_sesiones(&[cuenta(&t, "c1")]);
    let cancelado = AtomicBool::new(false);
    let mut tandas = 0;
    let st = buscar_sesiones(
        &files,
        "foo",
        &cancelado,
        &mut |_| {
            tandas += 1;
            cancelado.store(true, Ordering::Relaxed);
        },
        &OpcionesBusqueda::default(),
    )
    .unwrap();
    assert_eq!(tandas, 1);
    assert!(st.cancelled);
    assert_eq!(st.files, 1);
}

#[test]
fn lineas_mas_largas_que_el_bloque_se_acumulan() {
    let t = Temporal::nuevo();
    let largo = msg("user", &format!("{} aguja {}", "relleno ".repeat(40), "relleno ".repeat(40)), "2026-01-01T00:00:00Z");
    assert!(largo.len() > 400);
    armar(&t, "c1", "p", U1, &[msg("user", "antes", "2026-01-01T00:00:00Z"), largo, msg("user", "despues aguja", "2026-01-01T00:00:00Z")]);
    let files = listar_sesiones(&[cuenta(&t, "c1")]);
    let mut todos = Vec::new();
    // Bloque de 64 bytes: ninguna línea entra en uno solo.
    let st = buscar_con_bloque(&files, "aguja", &AtomicBool::new(false), &mut |i| todos.extend(i), &OpcionesBusqueda::default(), 64).unwrap();
    assert_eq!(todos.len(), 2);
    assert_eq!(st.total, 2);
    assert_eq!(todos[1].after, "");
}

#[test]
fn archivo_sin_salto_final_y_cwd_del_bloque() {
    let t = Temporal::nuevo();
    let sin_cwd = json!({ "type": "user", "message": { "content": "hallazgo" } }).to_string();
    let con_cwd = json!({ "type": "system", "cwd": "D:\\otra", "message": {} }).to_string();
    t.escribir(&format!("c1/projects/p/{U1}.jsonl"), &format!("{con_cwd}\n{sin_cwd}"));
    let files = listar_sesiones(&[cuenta(&t, "c1")]);
    let (items, _) = buscar(&files, "hallazgo", OpcionesBusqueda::default());
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].cwd, "D:\\otra");
    assert_eq!(items[0].ts, files[0].mtime_ms);
}

fn transcript() -> String {
    let l = [
        json!({ "type": "summary", "summary": "  Arreglar\nel login  " }),
        json!({ "type": "user", "timestamp": "2026-11-17T10:00:00Z", "cwd": "C:\\repo", "gitBranch": "feat/x", "message": { "content": "<command-name>x</command-name>" } }),
        json!({ "type": "user", "timestamp": "2026-11-17T10:00:01Z", "message": { "content": "Arreglá el login" } }),
        json!({ "type": "user", "isMeta": true, "timestamp": "2026-11-17T10:00:02Z", "message": { "content": "meta" } }),
        json!({ "type": "assistant", "timestamp": "2026-11-17T10:01:00Z", "message": { "content": [
            { "type": "text", "text": "  Voy a mirar  " },
            { "type": "tool_use", "id": "t1", "name": "Read", "input": { "file_path": "C:\\repo\\src\\a.ts" } },
            { "type": "tool_use", "id": "t2", "name": "Edit", "input": { "file_path": "C:\\repo\\src\\a.ts", "old_string": "a\nb", "new_string": "a\nb\nc" } },
            { "type": "tool_use", "id": "t3", "name": "Bash", "input": { "command": "npm test", "description": "Corre   los tests" } }
        ] } }),
        json!({ "type": "user", "timestamp": "2026-11-17T10:02:00Z", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "t3", "is_error": true, "content": [{ "type": "text", "text": "falló\n\nlínea 2" }] },
            { "type": "tool_result", "tool_use_id": "t1", "content": "contenido" }
        ] } }),
        json!({ "type": "assistant", "isSidechain": true, "timestamp": "2026-11-17T10:03:00Z", "message": { "content": "ruido" } }),
        json!({ "type": "assistant", "timestamp": "2026-11-17T10:05:00Z", "message": { "content": "Listo, quedó." } }),
    ];
    l.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")
}

#[test]
fn transcript_resumen() {
    let r = parsear_texto(&transcript(), false);
    let s = &r.sesion;
    assert_eq!(s.title, "Arreglar el login");
    assert_eq!(s.cwd, "C:\\repo");
    assert_eq!(s.branch, "feat/x");
    assert_eq!(s.start, 1_794_909_600_000);
    assert_eq!(s.end, 1_794_909_600_000 + 5 * 60_000);
    assert_eq!(s.messages, 4);
    assert_eq!(s.tools, 3);
    assert_eq!(s.status, Estado::Ok);
    assert_eq!(s.last_answer, "Listo, quedó.");
    assert_eq!(s.files, vec![ArchivoTocado { path: "C:\\repo\\src\\a.ts".into(), add: 3, del: 2 }]);
    assert!(r.items.is_empty());
}

#[test]
fn transcript_detalle_enlaza_resultados() {
    let r = parsear_texto(&transcript(), true);
    let tools: Vec<&ItemDetalle> = r.items.iter().filter(|i| matches!(i, ItemDetalle::Tool { .. })).collect();
    assert_eq!(tools.len(), 3);
    assert_eq!(
        tools[0],
        &ItemDetalle::Tool {
            kind: TipoHerramienta::Read,
            title: "Leyó a.ts".into(),
            cmd: String::new(),
            meta: "solo lectura".into(),
            err: false,
            lines: vec!["contenido".into()]
        }
    );
    assert_eq!(
        tools[2],
        &ItemDetalle::Tool {
            kind: TipoHerramienta::Run,
            title: "Ejecutó Corre los tests".into(),
            cmd: "npm test".into(),
            meta: "con errores".into(),
            err: true,
            lines: vec!["falló".into(), "línea 2".into()]
        }
    );
    assert_eq!(r.items.first(), Some(&ItemDetalle::Msg { role: Rol::User, text: "<command-name>x</command-name>".into() }));
}

#[test]
fn transcript_sin_respuesta_final_es_interrumpido() {
    let l = [
        json!({ "type": "user", "message": { "content": "hola" } }),
        json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "ok" }, { "type": "tool_use", "id": "a", "name": "Bash", "input": {} }] } }),
    ];
    let txt = l.iter().map(Value::to_string).collect::<Vec<_>>().join("\r\n");
    let r = parsear_texto(&txt, false);
    assert_eq!(r.sesion.status, Estado::Int);
    assert_eq!(r.sesion.title, "hola");
    assert_eq!(r.sesion.end, r.sesion.start);
}

#[test]
fn transcript_vacio_se_llama_sin_titulo() {
    let r = parsear_texto("basura\n{no json\n", false);
    assert_eq!(r.sesion.title, "Sin título");
    assert_eq!(r.sesion.status, Estado::Int);
}

#[test]
fn transcript_salta_lineas_enormes_y_lee_de_disco() {
    let t = Temporal::nuevo();
    let f = t.escribir("x.jsonl", &format!("{}\n{}\n", msg("user", "chica", "2026-01-01T00:00:00Z"), msg("user", &"z".repeat(500), "2026-01-01T00:00:00Z")));
    let r = parsear_transcript(&f, false, 300).unwrap();
    assert_eq!(r.sesion.messages, 1);
    assert!(parsear_transcript(&t.0.join("no-existe.jsonl"), false, 300).is_err());
}

#[test]
fn transcript_limita_los_items() {
    let lineas: Vec<String> = (0..MAX_ITEMS_DETALLE + 10).map(|i| msg("user", &format!("m{i}"), "2026-01-01T00:00:00Z")).collect();
    let r = parsear_texto(&lineas.join("\n"), true);
    assert_eq!(r.items.len(), MAX_ITEMS_DETALLE);
    assert_eq!(r.sesion.messages, MAX_ITEMS_DETALLE + 10);
}

fn inp(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}

#[test]
fn describir_herramientas() {
    let d = describir_herramienta("Grep", &inp(json!({ "pattern": "a   b" })));
    assert_eq!((d.title.as_str(), d.meta.as_str(), d.kind), ("Buscó «a b»", "solo lectura", TipoHerramienta::Read));
    let d = describir_herramienta("Glob", &inp(json!({ "pattern": "**/*.rs" })));
    assert_eq!(d.title, "Buscó archivos «**/*.rs»");
    let d = describir_herramienta("Write", &inp(json!({ "file_path": "/a/b/c.md", "content": "1\n2\n3" })));
    assert_eq!((d.title.as_str(), d.meta.as_str(), d.add), ("Creó c.md", "+3 −0", 3));
    let d = describir_herramienta("MultiEdit", &inp(json!({ "file_path": "x", "edits": [
        { "old_string": "a", "new_string": "a\nb" }, { "new_string": "z" }] })));
    assert_eq!((d.add, d.del, d.title.as_str()), (3, 1, "Editó x"));
    let d = describir_herramienta("NotebookEdit", &inp(json!({ "notebook_path": "n.ipynb", "new_source": "x\ny" })));
    assert_eq!((d.file.as_str(), d.add), ("n.ipynb", 2));
    let d = describir_herramienta("Edit", &inp(json!({})));
    assert_eq!(d.title, "Editó un archivo");
    assert!(d.lines.is_empty());
    let d = describir_herramienta("Read", &inp(json!({})));
    assert_eq!(d.title, "Leyó un archivo");
    let d = describir_herramienta("Bash", &inp(json!({ "command": format!("  {}  ", "x".repeat(500)) })));
    assert_eq!(largo16(&d.cmd), 400);
    assert!(d.cmd.ends_with('…'));
    assert!(d.title.starts_with("Ejecutó xxx"));
    let d = describir_herramienta("TodoWrite", &inp(json!({})));
    assert_eq!((d.title.as_str(), d.kind), ("TodoWrite", TipoHerramienta::Other));
    assert_eq!(tipo_herramienta("BashOutput"), TipoHerramienta::Run);
}

#[test]
fn clip_cuenta_utf16() {
    assert_eq!(clip("abcdef", 6), "abcdef");
    assert_eq!(clip("abcdef", 5), "abcd…");
    assert_eq!(clip("ab   cdef", 5), "ab…");
    assert_eq!(clip("😀😀😀", 6), "😀😀😀");
    assert_eq!(clip("😀😀😀😀", 6), "😀😀\u{fffd}…");
}

fn info(items: Vec<ItemDetalle>) -> InfoSesion {
    InfoSesion {
        fila: FilaSesion {
            key: format!("c1:{U1}"),
            account_id: "c1".into(),
            account_label: "Personal".into(),
            session_id: U1.into(),
            cwd: "C:\\repo".into(),
            space_id: None,
            space_key: "cwd:c:\\repo".into(),
            space_name: "repo".into(),
            branch: "main".into(),
            title: "Título".into(),
            start: 1_794_909_600_000,
            end: 1_794_909_600_000 + 75 * 60_000,
            messages: 2,
            tools: 1,
            files: vec![ArchivoTocado { path: "a|b".into(), add: 1, del: 2 }],
            status: Estado::Int,
        },
        last_answer: "Última".into(),
        items,
    }
}

#[test]
fn markdown_completo() {
    let items = vec![
        ItemDetalle::Msg { role: Rol::User, text: "Hola".into() },
        ItemDetalle::Tool {
            kind: TipoHerramienta::Run,
            title: "Ejecutó tests".into(),
            cmd: "npm test".into(),
            meta: "salió bien".into(),
            err: false,
            lines: vec!["ok".into()],
        },
        ItemDetalle::Msg { role: Rol::Assistant, text: "Listo".into() },
    ];
    let md = sesion_markdown(&info(items), "Mi espacio", &|ms| fecha_es_ar(ms, -180));
    let esperado = "# Título\n\n- **Espacio:** Mi espacio\n- **Cuenta:** Personal\n- **Carpeta:** C:\\repo\n- **Rama:** main\n\
- **Inicio:** 17/11/2026, 07:00 · **Duración:** 1 h 15 min · **Mensajes:** 2\n- **Estado:** Interrumpida\n\
- **Id de la conversación:** 11111111-2222-3333-4444-555555555555\n\n## Última respuesta de Claude\n\nÚltima\n\n## Conversación\n\n\
**Vos:**\n\nHola\n\n> Ejecutó tests · salió bien\n\n```bash\n$ npm test\n```\n\n```text\nok\n```\n\n**Claude:**\n\nListo\n\n\
## Archivos tocados\n\n| Archivo | + | − |\n| --- | ---: | ---: |\n| a\\|b | 1 | 2 |\n";
    assert_eq!(md, esperado);
}

#[test]
fn markdown_minimo() {
    let mut i = info(vec![]);
    i.fila.branch.clear();
    i.fila.files.clear();
    i.last_answer.clear();
    i.fila.status = Estado::Ok;
    i.fila.end = i.fila.start;
    let md = sesion_markdown(&i, "X", &|_| "hoy".into());
    assert!(!md.contains("Rama"));
    assert!(!md.contains("Archivos tocados"));
    assert!(!md.contains("Última respuesta"));
    assert!(md.contains("**Duración:** 1 min"));
    assert!(md.contains("Terminada"));
    assert!(md.ends_with("## Conversación\n"));
}

#[test]
fn duracion_redondea_y_minimo_uno() {
    assert_eq!(duracion_min(0, 0), 1);
    assert_eq!(duracion_min(0, 89_999), 1);
    assert_eq!(duracion_min(0, 90_000), 2);
    assert_eq!(duracion_min(0, 3_600_000), 60);
}

#[test]
fn fecha_es_ar_formato() {
    assert_eq!(fecha_es_ar(0, 0), "01/01/1970, 00:00");
    assert_eq!(fecha_es_ar(1_794_909_600_000, 0), "17/11/2026, 10:00");
    assert_eq!(fecha_es_ar(1_794_909_600_000, -180), "17/11/2026, 07:00");
    assert_eq!(fecha_es_ar(1_709_164_800_000 + 23 * 3_600_000 + 59 * 60_000, 0), "29/02/2024, 23:59");
}

#[test]
fn claves_de_sesion() {
    assert!(es_clave_sesion(&format!("c1:{U1}")));
    assert!(es_clave_sesion(&format!("{}:{U1}", "a".repeat(64))));
    assert!(es_clave_sesion(&format!("cuenta-1:{}", U2.to_uppercase())));
    assert!(!es_clave_sesion(&format!("{}:{U1}", "a".repeat(65))));
    assert!(!es_clave_sesion(&format!(":{U1}")));
    assert!(!es_clave_sesion(&format!("c_1:{U1}")));
    assert!(!es_clave_sesion("c1:no-uuid"));
    assert!(!es_clave_sesion(U1));
    assert!(!es_clave_sesion(&format!("a:b:{U1}")));
}

#[test]
fn prefs_se_filtran_y_deduplican() {
    let k1 = format!("c1:{U1}");
    let k2 = format!("c2:{U2}");
    let p = parsear_prefs(&json!({ "pinned": [k1, k2, k1, 5, "mala"], "hidden": "no es lista" }));
    assert_eq!(p.pinned, vec![k1.clone(), k2]);
    assert!(p.hidden.is_empty());
    assert_eq!(parsear_prefs(&json!(null)), PrefsHistorial::default());
    assert_eq!(parsear_prefs(&json!([1])), PrefsHistorial::default());
}

#[test]
fn prefs_tope_de_claves() {
    let claves: Vec<String> = (0..MAX_CLAVES + 5).map(|i| format!("c{i}:{U1}")).collect();
    let p = parsear_prefs(&json!({ "pinned": claves }));
    assert_eq!(p.pinned.len(), MAX_CLAVES);
    assert_eq!(p.pinned[0], format!("c0:{U1}"));
}

#[test]
fn fijar_pref_agrega_mueve_y_quita() {
    let k1 = format!("c1:{U1}");
    let k2 = format!("c1:{U2}");
    let p = PrefsHistorial::default();
    let p = fijar_pref(&p, Lista::Fijadas, &k1, true).unwrap();
    let p = fijar_pref(&p, Lista::Fijadas, &k2, true).unwrap();
    let p = fijar_pref(&p, Lista::Fijadas, &k1, true).unwrap();
    assert_eq!(p.pinned, vec![k2.clone(), k1.clone()]);
    assert!(p.hidden.is_empty());
    let p = fijar_pref(&p, Lista::Ocultas, &k1, true).unwrap();
    assert_eq!(p.hidden, vec![k1.clone()]);
    let p = fijar_pref(&p, Lista::Fijadas, &k2, false).unwrap();
    assert_eq!(p.pinned, vec![k1]);
    assert!(fijar_pref(&p, Lista::Fijadas, "mala", true).is_none());
}

#[test]
fn fijar_pref_conserva_las_ultimas() {
    let mut p = PrefsHistorial::default();
    p.hidden = (0..MAX_CLAVES).map(|i| format!("c{i}:{U1}")).collect();
    let n = fijar_pref(&p, Lista::Ocultas, &format!("nueva:{U1}"), true).unwrap();
    assert_eq!(n.hidden.len(), MAX_CLAVES);
    assert_eq!(n.hidden[0], format!("c1:{U1}"));
    assert_eq!(n.hidden.last().unwrap(), &format!("nueva:{U1}"));
}

#[test]
fn dentro_de_projects() {
    let cfg = Path::new("/home/u/.claude");
    assert!(esta_dentro_de_projects(cfg, Path::new("/home/u/.claude/projects/slug/x.jsonl")));
    assert!(esta_dentro_de_projects(cfg, Path::new("/home/u/.claude/projects/slug/x/sub/y")));
    assert!(!esta_dentro_de_projects(cfg, Path::new("/home/u/.claude/projects")));
    assert!(!esta_dentro_de_projects(cfg, Path::new("/home/u/.claude/projects/slug")));
    assert!(!esta_dentro_de_projects(cfg, Path::new("/home/u/.claude/projects/../x/y")));
    assert!(!esta_dentro_de_projects(cfg, Path::new("/home/u/.claude/projects-otro/a/b")));
    assert!(!esta_dentro_de_projects(cfg, Path::new("/home/u/.claude/projects/slug/../../otro")));
    assert!(esta_dentro_de_projects(cfg, Path::new("/home/u/.claude/projects/./slug/./x")));
    assert!(esta_dentro_de_projects(cfg, Path::new("/home/u/.claude/projects/a/../slug/x")));
}

#[test]
#[cfg(windows)]
fn dentro_de_projects_ignora_mayusculas_en_windows() {
    assert!(esta_dentro_de_projects(Path::new(r"C:\Users\U\.claude"), Path::new(r"c:\users\u\.CLAUDE\Projects\slug\x.jsonl")));
    assert!(!esta_dentro_de_projects(Path::new(r"C:\Users\U\.claude"), Path::new(r"D:\Users\U\.claude\projects\slug\x.jsonl")));
}

#[test]
fn rutas_de_papelera() {
    let cfg = Path::new("/home/u/.claude");
    let r = rutas_papelera(cfg, "C--repo", U1).unwrap();
    assert_eq!(r.file, cfg.join("projects").join("C--repo").join(format!("{U1}.jsonl")));
    assert_eq!(r.dir, cfg.join("projects").join("C--repo").join(U1));
    assert!(rutas_papelera(cfg, "C--repo", "no-uuid").is_none());
    for malo in ["", ".", "..", "a/b", "a\\b", "../x"] {
        assert!(rutas_papelera(cfg, malo, U1).is_none(), "{malo}");
    }
}
