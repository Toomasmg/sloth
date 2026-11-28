//! Chat (entrega rápida): tópicos de Broadcast por conversación, validación de lo que llega por ahí y dedupe entre los dos
//! caminos (broadcast y postgres_changes). Equivale a chat-topics.ts.
//!
//! Lo que llega por broadcast es dato no confiable aunque lo publique la base: se valida la forma completa y que la
//! conversación de la fila sea la del tópico por el que llegó.
use super::fecha::parsear_ms;
use super::mapa::{codepoints, es_emoji_de_reaccion, es_uuid, texto, FilaMensaje};
use super::tipos::{ChatConvRef, TipoConv, LIMITE_CUERPO};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};

/// Nombre del evento que manda el trigger de 0003_realtime_broadcast.sql.
pub const BROADCAST_EVENT: &str = "message";
/// Eventos de 0004_chat_completo.sql.
pub const UPDATE_EVENT: &str = "message_update";
pub const REACTION_EVENT: &str = "reaction";
pub const TYPING_EVENT: &str = "typing";
pub const READ_EVENT: &str = "read";
pub const MEMBER_REMOVED_EVENT: &str = "member_removed";
/// Realtime corta en 100 canales por conexión; uno queda para «sloth-inbox» y el resto de margen.
pub const MAX_TOPICS: usize = 90;
pub const SEEN_MAX: usize = 2000;
pub const TYPING_MIN_MS: i64 = 3000;

fn es_id(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| es_uuid(s, true))
}

fn es_fecha(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).is_some_and(|s| parsear_ms(s).is_some())
}

/// Ausente y `null` son lo mismo.
fn presente(v: Option<&Value>) -> Option<&Value> {
    v.filter(|x| !x.is_null())
}

pub fn topico_de(conv: &ChatConvRef) -> String {
    format!("{}:{}", if conv.kind == TipoConv::Team { "team" } else { "thread" }, conv.id.to_lowercase())
}

pub fn conv_del_topico(topic: &str) -> Option<ChatConvRef> {
    let (kind, id) = if let Some(r) = topic.strip_prefix("team:") {
        (TipoConv::Team, r)
    } else {
        (TipoConv::Dm, topic.strip_prefix("thread:")?)
    };
    es_uuid(id, true).then(|| ChatConvRef { kind, id: id.to_string() })
}

pub struct ConvActiva<'a> {
    pub id: &'a str,
    pub last_message_at: Option<i64>,
}

/// Tópicos a escuchar: equipos y DMs, los más activos primero, hasta `max` (el resto queda con postgres_changes).
pub fn topicos_deseados(teams: &[ConvActiva], threads: &[ConvActiva], max: usize) -> Vec<String> {
    let mut todos: Vec<(String, i64)> = teams
        .iter()
        .map(|t| (topico_de(&ChatConvRef::equipo(t.id)), t.last_message_at.unwrap_or(0)))
        .chain(threads.iter().map(|t| (topico_de(&ChatConvRef::directo(t.id)), t.last_message_at.unwrap_or(0))))
        .filter(|(t, _)| conv_del_topico(t).is_some())
        .collect();
    todos.sort_by(|a, b| b.1.cmp(&a.1));
    let mut vistos = HashSet::new();
    todos.into_iter().filter(|(t, _)| vistos.insert(t.clone())).map(|(t, _)| t).take(max).collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CambioDeTopicos {
    pub add: Vec<String>,
    pub remove: Vec<String>,
}

pub fn diferencia_de_topicos(actuales: &[String], deseados: &[String]) -> CambioDeTopicos {
    let cur: HashSet<&String> = actuales.iter().collect();
    let want: HashSet<&String> = deseados.iter().collect();
    CambioDeTopicos {
        add: deseados.iter().filter(|t| !cur.contains(t)).cloned().collect(),
        remove: actuales.iter().filter(|t| !want.contains(t)).cloned().collect(),
    }
}

/// Payload de broadcast → fila de `messages`, o `None` si no tiene la forma exacta o si es de otra conversación que la del tópico.
pub fn fila_de_broadcast(payload: &Value, conv: &ChatConvRef) -> Option<FilaMensaje> {
    let p = payload.as_object()?;
    let (id, client_id, author_id) = (es_id(p.get("id"))?, es_id(p.get("client_id"))?, es_id(p.get("author_id"))?);
    let body = p.get("body")?.as_str()?;
    if !es_fecha(p.get("created_at")) {
        return None;
    }
    let (edited, deleted, reply) = (presente(p.get("edited_at")), presente(p.get("deleted_at")), presente(p.get("reply_to")));
    if edited.is_some() && !es_fecha(edited) || deleted.is_some() && !es_fecha(deleted) || reply.is_some() && es_id(reply).is_none() {
        return None;
    }
    let kind = presente(p.get("kind"));
    if kind.is_some_and(|k| !matches!(k.as_str(), Some("text" | "retention" | "clear"))) {
        return None;
    }
    if deleted.is_some() {
        if !body.is_empty() {
            return None;
        }
    } else {
        let n = codepoints(body);
        if !(1..=LIMITE_CUERPO).contains(&n) {
            return None;
        }
    }
    let (team, thread) = (presente(p.get("team_id")), presente(p.get("thread_id")));
    let (propio, ajeno, clave) = match conv.kind {
        TipoConv::Team => (team, thread, "team_id"),
        TipoConv::Dm => (thread, team, "thread_id"),
    };
    if propio.and_then(Value::as_str) != Some(conv.id.as_str()) || ajeno.is_some() {
        return None;
    }
    let mut row = FilaMensaje::new();
    row.insert("id".into(), Value::from(id));
    row.insert("client_id".into(), Value::from(client_id));
    row.insert(clave.into(), Value::from(conv.id.as_str()));
    row.insert("author_id".into(), Value::from(author_id));
    row.insert("body".into(), Value::from(body));
    row.insert("created_at".into(), p["created_at"].clone());
    if let Some(v) = edited {
        row.insert("edited_at".into(), v.clone());
    }
    if let Some(v) = deleted {
        row.insert("deleted_at".into(), v.clone());
    }
    if let Some(v) = reply {
        row.insert("reply_to".into(), v.clone());
    }
    if let Some(k) = kind.filter(|k| k.as_str() != Some("text")) {
        row.insert("kind".into(), k.clone());
    }
    if p.get("via").and_then(Value::as_str) == Some("claude") {
        row.insert("via".into(), Value::from("claude"));
    }
    Some(row)
}

pub fn miembro_sacado_de_broadcast(p: &Value, team_id: &str) -> Option<String> {
    let o = p.as_object()?;
    let user = es_id(o.get("user_id"))?;
    (o.get("team_id").and_then(Value::as_str) == Some(team_id)).then(|| user.to_string())
}

/// Clave de versión para el dedupe: una edición o un borrado del mismo mensaje cuentan como nuevos.
pub fn clave_de_version(row: &FilaMensaje) -> String {
    format!("{}:{}:{}", texto(row.get("id")), texto(row.get("edited_at")), texto(row.get("deleted_at")))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReaccionDeBroadcast {
    pub message_id: String,
    pub user_id: String,
    pub emoji: String,
    pub agregar: bool,
}

pub fn reaccion_de_broadcast(p: &Value) -> Option<ReaccionDeBroadcast> {
    let o = p.as_object()?;
    let (m, u) = (es_id(o.get("message_id"))?, es_id(o.get("user_id"))?);
    let emoji = o.get("emoji").filter(|e| es_emoji_de_reaccion(e))?.as_str()?;
    let agregar = match o.get("op").and_then(Value::as_str)? {
        "add" => true,
        "remove" => false,
        _ => return None,
    };
    Some(ReaccionDeBroadcast { message_id: m.into(), user_id: u.into(), emoji: emoji.into(), agregar })
}

pub fn escribiendo_de_broadcast(p: &Value) -> Option<String> {
    es_id(p.as_object()?.get("user_id")).map(String::from)
}

pub fn lectura_de_broadcast(p: &Value) -> Option<(String, i64)> {
    let o = p.as_object()?;
    let user = es_id(o.get("user_id"))?;
    Some((user.into(), parsear_ms(o.get("at")?.as_str()?)?))
}

/// Ids ya procesados (el mismo mensaje llega por broadcast y por postgres_changes). Acotado: olvida los más viejos.
pub struct IdsVistos {
    orden: VecDeque<String>,
    set: HashSet<String>,
    max: usize,
}

impl IdsVistos {
    pub fn nuevo(max: usize) -> Self {
        IdsVistos { orden: VecDeque::new(), set: HashSet::new(), max: max.max(1) }
    }

    /// `true` si es la primera vez que se ve el id (y lo anota).
    pub fn primera_vez(&mut self, id: &str) -> bool {
        if self.set.contains(id) {
            return false;
        }
        self.set.insert(id.to_string());
        self.orden.push_back(id.to_string());
        while self.set.len() > self.max {
            match self.orden.pop_front() {
                Some(viejo) => {
                    self.set.remove(&viejo);
                }
                None => break,
            }
        }
        true
    }

    pub fn vaciar(&mut self) {
        self.orden.clear();
        self.set.clear();
    }
}

impl Default for IdsVistos {
    fn default() -> Self {
        Self::nuevo(SEEN_MAX)
    }
}

/// Limita un aviso por clave: pasa si pasó al menos `min_ms` desde el último que dejó pasar.
pub struct Limitador {
    ultimo: HashMap<String, i64>,
    min_ms: i64,
}

impl Limitador {
    pub fn nuevo(min_ms: i64) -> Self {
        Limitador { ultimo: HashMap::new(), min_ms }
    }

    pub fn pasa(&mut self, clave: &str, en: i64) -> bool {
        if self.ultimo.get(clave).is_some_and(|&p| en - p < self.min_ms) {
            return false;
        }
        self.ultimo.insert(clave.to_string(), en);
        true
    }

    pub fn vaciar(&mut self) {
        self.ultimo.clear();
    }
}

impl Default for Limitador {
    fn default() -> Self {
        Self::nuevo(TYPING_MIN_MS)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Turno {
    Ahora,
    /// Programalo dentro de tantos ms y llamá a `disparado` al mandarlo.
    En(i64),
    /// Ya hay uno programado, que cubre este.
    Cubierto,
}

/// Como `Limitador`, pero lo que no pasa no se pierde: queda uno pendiente por clave para el final de la ventana.
pub struct LimitadorConCola {
    ultimo: HashMap<String, i64>,
    pendientes: HashSet<String>,
    min_ms: i64,
}

impl LimitadorConCola {
    pub fn nuevo(min_ms: i64) -> Self {
        LimitadorConCola { ultimo: HashMap::new(), pendientes: HashSet::new(), min_ms }
    }

    pub fn pedir(&mut self, clave: &str, en: i64) -> Turno {
        if self.pendientes.contains(clave) {
            return Turno::Cubierto;
        }
        match self.ultimo.get(clave) {
            Some(&prev) if en - prev < self.min_ms => {
                self.pendientes.insert(clave.to_string());
                Turno::En(self.min_ms - (en - prev))
            }
            _ => {
                self.ultimo.insert(clave.to_string(), en);
                Turno::Ahora
            }
        }
    }

    pub fn disparado(&mut self, clave: &str, en: i64) {
        self.pendientes.remove(clave);
        self.ultimo.insert(clave.to_string(), en);
    }

    pub fn vaciar(&mut self) {
        self.ultimo.clear();
        self.pendientes.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Map};

    const T: &str = "11111111-1111-4111-8111-111111111111";
    const D: &str = "22222222-2222-4222-8222-222222222222";
    const ID: &str = "33333333-3333-4333-8333-333333333333";
    const CID: &str = "44444444-4444-4444-8444-444444444444";
    const AUTH: &str = "55555555-5555-4555-8555-555555555555";
    const AT: &str = "2026-11-12T10:05:00.000001+00:00";

    fn team_row() -> Value {
        json!({"id": ID, "client_id": CID, "team_id": T, "thread_id": null, "author_id": AUTH, "body": "hola", "created_at": "2026-11-12T10:00:00.123456+00:00"})
    }

    fn con(extra: Value) -> Value {
        let mut v = team_row();
        for (k, x) in extra.as_object().unwrap() {
            v[k] = x.clone();
        }
        v
    }

    fn equipo() -> ChatConvRef {
        ChatConvRef::equipo(T)
    }

    #[test]
    fn topico_por_conversacion_ida_y_vuelta() {
        assert_eq!(topico_de(&equipo()), format!("team:{T}"));
        assert_eq!(topico_de(&ChatConvRef::directo(D)), format!("thread:{D}"));
        assert_eq!(conv_del_topico(&format!("team:{T}")), Some(equipo()));
        assert_eq!(conv_del_topico(&format!("thread:{D}")), Some(ChatConvRef::directo(D)));
        for malo in ["team:", &format!("dm:{D}"), &format!("team:{T}:x"), &format!("realtime:team:{T}"), "team:no-uuid", ""] {
            assert_eq!(conv_del_topico(malo), None, "{malo}");
        }
    }

    #[test]
    fn topicos_deseados_mas_activos_primero_con_tope_sin_repetidos() {
        let teams = [ConvActiva { id: T, last_message_at: Some(10) }, ConvActiva { id: "basura", last_message_at: None }];
        let threads = [ConvActiva { id: D, last_message_at: Some(20) }];
        assert_eq!(topicos_deseados(&teams, &threads, MAX_TOPICS), vec![format!("thread:{D}"), format!("team:{T}")]);
        assert_eq!(topicos_deseados(&teams, &threads, 1), vec![format!("thread:{D}")]);
        let repetidos = [ConvActiva { id: T, last_message_at: None }, ConvActiva { id: T, last_message_at: None }];
        assert_eq!(topicos_deseados(&repetidos, &[], MAX_TOPICS), vec![format!("team:{T}")]);
        assert_eq!(topicos_deseados(&teams, &threads, 0), Vec::<String>::new());
    }

    #[test]
    fn diff_de_suscripciones_al_cambiar_las_listas() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(diferencia_de_topicos(&s(&["a", "b"]), &s(&["b", "c"])), CambioDeTopicos { add: s(&["c"]), remove: s(&["a"]) });
        assert_eq!(diferencia_de_topicos(&[], &[]), CambioDeTopicos { add: vec![], remove: vec![] });
    }

    #[test]
    fn payload_valido_del_topico_suscripto() {
        let r = fila_de_broadcast(&team_row(), &equipo()).unwrap();
        let esperado = json!({"id": ID, "client_id": CID, "team_id": T, "author_id": AUTH, "body": "hola", "created_at": "2026-11-12T10:00:00.123456+00:00"});
        assert_eq!(Value::Object(r), esperado);
        let dm = con(json!({"team_id": null, "thread_id": D}));
        assert_eq!(fila_de_broadcast(&dm, &ChatConvRef::directo(D)).unwrap()["thread_id"], json!(D));
    }

    #[test]
    fn payload_de_otra_conversacion_o_con_forma_rara_se_descarta() {
        let r = team_row();
        assert_eq!(fila_de_broadcast(&r, &ChatConvRef::equipo(D)), None, "otro equipo");
        assert_eq!(fila_de_broadcast(&r, &ChatConvRef::directo(T)), None, "mismo id pero DM");
        assert_eq!(fila_de_broadcast(&con(json!({"thread_id": D})), &equipo()), None, "las dos conversaciones");
        for malo in [json!(null), json!("x"), json!([team_row()]), json!({})] {
            assert_eq!(fila_de_broadcast(&malo, &equipo()), None);
        }
        for extra in [
            json!({"id": "x"}),
            json!({"client_id": 1}),
            json!({"author_id": null}),
            json!({"body": ""}),
            json!({"body": "x".repeat(4001)}),
            json!({"body": {"toString": "x"}}),
            json!({"created_at": "ayer"}),
        ] {
            assert_eq!(fila_de_broadcast(&con(extra.clone()), &equipo()), None, "{extra}");
        }
    }

    #[test]
    fn payload_tipo_de_mensaje() {
        assert_eq!(fila_de_broadcast(&con(json!({"body": "clear", "kind": "clear"})), &equipo()).unwrap()["kind"], json!("clear"));
        assert_eq!(fila_de_broadcast(&con(json!({"body": "168", "kind": "retention"})), &equipo()).unwrap()["kind"], json!("retention"));
        assert!(!fila_de_broadcast(&con(json!({"kind": "text"})), &equipo()).unwrap().contains_key("kind"));
        assert_eq!(fila_de_broadcast(&con(json!({"kind": "admin"})), &equipo()), None);
    }

    #[test]
    fn payload_no_se_copian_claves_de_mas() {
        let r = fila_de_broadcast(&con(json!({"extra": "<script>", "__proto__x": 1})), &equipo()).unwrap();
        let mut claves: Vec<&str> = r.keys().map(String::as_str).collect();
        claves.sort_unstable();
        assert_eq!(claves, ["author_id", "body", "client_id", "created_at", "id", "team_id"]);
    }

    #[test]
    fn dedupe_el_mismo_id_por_los_dos_caminos_cuenta_una_sola_vez() {
        let mut seen = IdsVistos::nuevo(2);
        assert!(seen.primera_vez("a"));
        assert!(!seen.primera_vez("a"));
        assert!(seen.primera_vez("b"));
        assert!(seen.primera_vez("c"));
        assert!(seen.primera_vez("a"), "el más viejo se olvida al pasar el tope");
        seen.vaciar();
        assert!(seen.primera_vez("c"));
    }

    #[test]
    fn edicion_borrado_y_respuesta_por_broadcast() {
        let e = fila_de_broadcast(&con(json!({"body": "hola!", "edited_at": AT, "deleted_at": null, "reply_to": ID})), &equipo()).unwrap();
        assert_eq!(e["edited_at"], json!(AT));
        assert_eq!(e["reply_to"], json!(ID));
        assert!(!e.contains_key("deleted_at"));
        let borrado = fila_de_broadcast(&con(json!({"body": "", "deleted_at": AT})), &equipo()).unwrap();
        assert_eq!(borrado["deleted_at"], json!(AT));
        assert_eq!(borrado["body"], json!(""));
    }

    #[test]
    fn borrado_con_cuerpo_cuerpo_vacio_sin_borrar_o_respuesta_rara_se_descarta() {
        for extra in [
            json!({"deleted_at": AT}),
            json!({"body": "", "deleted_at": null}),
            json!({"reply_to": "x"}),
            json!({"edited_at": "ayer"}),
            json!({"deleted_at": 5, "body": ""}),
        ] {
            assert_eq!(fila_de_broadcast(&con(extra.clone()), &equipo()), None, "{extra}");
        }
    }

    #[test]
    fn payload_viejo_sin_los_campos_nuevos_sigue_andando() {
        let r = fila_de_broadcast(&team_row(), &equipo()).unwrap();
        assert_eq!(r["body"], json!("hola"));
        assert!(!r.contains_key("edited_at"));
    }

    #[test]
    fn reaccion_por_broadcast() {
        let ok = json!({"message_id": ID, "user_id": AUTH, "emoji": "❤️", "op": "add"});
        let esperado = ReaccionDeBroadcast { message_id: ID.into(), user_id: AUTH.into(), emoji: "❤️".into(), agregar: true };
        assert_eq!(reaccion_de_broadcast(&ok), Some(esperado.clone()));
        let cambia = |k: &str, v: Value| {
            let mut o = ok.clone();
            o[k] = v;
            o
        };
        assert_eq!(reaccion_de_broadcast(&cambia("emoji", json!("💩"))), None);
        assert_eq!(reaccion_de_broadcast(&cambia("emoji", json!("❤"))), None, "sin el selector de variación");
        assert_eq!(reaccion_de_broadcast(&cambia("op", json!("toggle"))), None);
        assert_eq!(reaccion_de_broadcast(&cambia("user_id", json!("x"))), None);
        assert_eq!(reaccion_de_broadcast(&cambia("extra", json!(1))), Some(esperado), "una clave nueva del servidor no la rompe");
    }

    #[test]
    fn escribiendo_y_visto_por_broadcast() {
        assert_eq!(escribiendo_de_broadcast(&json!({"user_id": AUTH})), Some(AUTH.into()));
        assert_eq!(escribiendo_de_broadcast(&json!({"user_id": "x"})), None);
        assert_eq!(escribiendo_de_broadcast(&json!(null)), None);
        assert_eq!(escribiendo_de_broadcast(&json!({"user_id": AUTH, "id": 1})), Some(AUTH.into()));
        assert_eq!(lectura_de_broadcast(&json!({"user_id": AUTH, "at": AT})), Some((AUTH.into(), parsear_ms(AT).unwrap())));
        assert_eq!(lectura_de_broadcast(&json!({"user_id": AUTH, "at": "ayer"})), None);
        assert_eq!(lectura_de_broadcast(&json!({"user_id": AUTH})), None);
    }

    #[test]
    fn clave_de_version_cambia_al_editar_o_borrar() {
        let obj = |v: Value| -> FilaMensaje { v.as_object().cloned().unwrap_or_else(Map::new) };
        let base = clave_de_version(&obj(team_row()));
        assert_ne!(clave_de_version(&obj(con(json!({"edited_at": AT})))), base);
        assert_ne!(clave_de_version(&obj(con(json!({"deleted_at": AT})))), clave_de_version(&obj(con(json!({"edited_at": AT})))));
        assert_eq!(clave_de_version(&obj(team_row())), base);
    }

    #[test]
    fn limitador_repite_recien_a_los_3_s_y_por_clave() {
        let mut th = Limitador::default();
        assert!(th.pasa("a", 1000));
        assert!(!th.pasa("a", 3999));
        assert!(th.pasa("b", 3999));
        assert!(th.pasa("a", 4000));
    }

    #[test]
    fn limitador_con_cola_junta_en_uno_al_final_lo_que_llega_dentro_de_la_ventana() {
        let mut th = LimitadorConCola::nuevo(2000);
        assert_eq!(th.pedir("a", 1000), Turno::Ahora);
        assert_eq!(th.pedir("a", 1500), Turno::En(1500));
        assert_eq!(th.pedir("a", 1800), Turno::Cubierto);
        assert_eq!(th.pedir("b", 1800), Turno::Ahora);
        th.disparado("a", 3000);
        assert_eq!(th.pedir("a", 3500), Turno::En(1500));
        th.disparado("a", 5000);
        assert_eq!(th.pedir("a", 7000), Turno::Ahora);
        th.vaciar();
        assert_eq!(th.pedir("a", 7001), Turno::Ahora);
    }

    #[test]
    fn la_marca_via_claude_llega_por_broadcast_solo_si_es_exacta() {
        assert_eq!(fila_de_broadcast(&con(json!({"via": "claude"})), &equipo()).unwrap()["via"], json!("claude"));
        for via in [json!("x"), json!(null), json!(1)] {
            let r = fila_de_broadcast(&con(json!({"via": via})), &equipo()).unwrap();
            assert!(!r.contains_key("via"));
        }
        assert!(!fila_de_broadcast(&team_row(), &equipo()).unwrap().contains_key("via"));
    }

    #[test]
    fn member_removed_solo_del_mismo_equipo_y_con_user_id_valido() {
        assert_eq!(miembro_sacado_de_broadcast(&json!({"team_id": T, "user_id": D}), T), Some(D.into()));
        assert_eq!(miembro_sacado_de_broadcast(&json!({"team_id": D, "user_id": D}), T), None);
        assert_eq!(miembro_sacado_de_broadcast(&json!({"team_id": T, "user_id": "x"}), T), None);
        assert_eq!(miembro_sacado_de_broadcast(&json!("x"), T), None);
    }
}
