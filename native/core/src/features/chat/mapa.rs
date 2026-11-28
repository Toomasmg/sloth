//! Chat (datos): mapeo PURO de filas de Supabase a los tipos del chat y validación de los argumentos que llegan por IPC.
//! Equivale a chat-map.ts. Nunca loguea nada: lo que devuelve sí puede llevar contenido de mensajes.
use super::fecha::parsear_ms;
use super::texto::{aviso_de_fila, retencion_de};
use super::tipos::*;
use super::{cortar_utf16, trim_js, Res};
use serde_json::{Map, Value};
use std::cmp::Ordering;
use std::collections::HashMap;
use unicode_normalization::UnicodeNormalization;

pub const EX_MEMBER_LOGIN: &str = "ex-miembro";
pub const DEFAULT_PAGE: u32 = 50;
pub const MAX_PAGE: u32 = 100;
const AVATAR_PREFIX: &str = "https://avatars.githubusercontent.com/";

/// Fila de `messages` tal como llega: las claves ausentes y las `null` valen lo mismo.
pub type FilaMensaje = Map<String, Value>;

pub const MSG_COLS_BASE: &str = "id, client_id, team_id, thread_id, author_id, body, created_at";
/// Solo con la 0004 aplicada: pedir columnas que no existen hace fallar toda la consulta.
pub const MSG_COLS_EXTRAS: &str = "id, client_id, team_id, thread_id, author_id, body, created_at, edited_at, deleted_at, reply_to, kind";

/// Largo en caracteres como lo cuenta Postgres (code points, no unidades UTF-16).
pub fn codepoints(s: &str) -> usize {
    s.chars().count()
}

/// Primeros `n` caracteres (code points), con «…» si se cortó.
pub fn primeros_caracteres(s: &str, n: usize) -> String {
    if codepoints(s) > n {
        format!("{}…", s.chars().take(n).collect::<String>())
    } else {
        s.to_string()
    }
}

pub fn texto(v: Option<&Value>) -> &str {
    v.and_then(Value::as_str).unwrap_or("")
}

/// `8-4-4-4-12` en hexadecimal; con `minusculas` solo a-f.
pub fn es_uuid(s: &str, minusculas: bool) -> bool {
    let partes: Vec<&str> = s.split('-').collect();
    partes.len() == 5
        && partes.iter().zip([8, 4, 4, 4, 12]).all(|(p, n)| {
            p.len() == n && p.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c) || (!minusculas && (b'A'..=b'F').contains(&c)))
        })
}

fn es_uuid_v4(s: &str) -> bool {
    let b = s.as_bytes();
    es_uuid(s, false) && b[14] == b'4' && matches!(b[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
}

// ---------- validación de argumentos IPC ----------

pub fn parsear_uuid(raw: &Value, que: &str) -> Res<String> {
    match raw.as_str() {
        Some(s) if es_uuid(s, false) => Ok(s.to_lowercase()),
        _ => Err(que.to_string()),
    }
}

/// clientId de «enviar»: uuid v4, lo genera la UI.
pub fn parsear_client_id(raw: &Value) -> Res<String> {
    match raw.as_str() {
        Some(s) if es_uuid_v4(s) => Ok(s.to_lowercase()),
        _ => Err("Identificador de envío inválido.".into()),
    }
}

/// Usuario de GitHub sin @: se normaliza a minúsculas (así se guarda la invitación).
pub fn parsear_login(raw: &Value) -> Res<String> {
    let Some(s) = raw.as_str() else { return Err("Escribí un usuario de GitHub.".into()) };
    let s = trim_js(s).to_lowercase();
    let ok = (1..=39).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if ok {
        Ok(s)
    } else {
        Err("Usuario de GitHub no válido. Solo letras, números y guiones, sin @.".into())
    }
}

pub fn parsear_codigo_invitacion(raw: &Value) -> Res<String> {
    let Some(s) = raw.as_str() else { return Err("Código inválido.".into()) };
    let s = trim_js(s).to_lowercase();
    if s.len() == 16 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        Ok(s)
    } else {
        Err("Código inválido. Son 16 caracteres hexadecimales.".into())
    }
}

pub fn parsear_conv(raw: &Value) -> Res<ChatConvRef> {
    let Some(o) = raw.as_object() else { return Err("Conversación inválida.".into()) };
    let kind = match o.get("kind").and_then(Value::as_str) {
        Some("team") => TipoConv::Team,
        Some("dm") => TipoConv::Dm,
        _ => return Err("Conversación inválida.".into()),
    };
    Ok(ChatConvRef { kind, id: parsear_uuid(o.get("id").unwrap_or(&Value::Null), "Conversación inválida.")? })
}

pub fn parsear_vista(raw: &Value) -> Res<ChatView> {
    let abierto = raw.as_object().and_then(|o| o.get("open")).and_then(Value::as_bool);
    let (Some(o), Some(abierto)) = (raw.as_object(), abierto) else { return Err("Vista inválida.".into()) };
    if !abierto {
        return Ok(ChatView::Cerrado);
    }
    match o.get("conv") {
        None | Some(Value::Null) => Ok(ChatView::Abierto(None)),
        Some(c) => Ok(ChatView::Abierto(Some(parsear_conv(c)?))),
    }
}

/// Id opcional (por ejemplo, el mensaje al que se responde): null o ausente → `None`.
pub fn parsear_uuid_opcional(raw: Option<&Value>) -> Res<Option<String>> {
    match raw {
        None | Some(Value::Null) => Ok(None),
        Some(v) => parsear_uuid(v, "Identificador inválido.").map(Some),
    }
}

pub fn es_emoji_de_reaccion(v: &Value) -> bool {
    v.as_str().is_some_and(|s| CHAT_REACTIONS.contains(&s))
}

pub fn parsear_emoji(raw: &Value) -> Res<&'static str> {
    raw.as_str().and_then(|s| CHAT_REACTIONS.iter().find(|&&e| e == s).copied()).ok_or_else(|| "Reacción inválida.".to_string())
}

pub fn parsear_busqueda(raw: &Value) -> Res<String> {
    let Some(s) = raw.as_str() else { return Err("Escribí al menos 2 letras.".into()) };
    let t = trim_js(s);
    let n = codepoints(t);
    if n < 2 {
        return Err("Escribí al menos 2 letras.".into());
    }
    if n > LIMITE_BUSQUEDA {
        return Err(format!("La búsqueda tiene más de {LIMITE_BUSQUEDA} caracteres."));
    }
    Ok(t.to_string())
}

/// Tamaño de página: por defecto 50, entre 1 y 100.
pub fn parsear_limite(raw: Option<&Value>) -> Res<u32> {
    match raw {
        None | Some(Value::Null) => Ok(DEFAULT_PAGE),
        Some(v) => match v.as_f64() {
            Some(n) if n.is_finite() => Ok(n.floor().clamp(1.0, f64::from(MAX_PAGE)) as u32),
            _ => Err("Límite inválido.".into()),
        },
    }
}

/// Cuerpo de mensaje: se recortan espacios y tiene que quedar entre 1 y 4000 caracteres.
pub fn parsear_cuerpo(raw: &Value) -> Res<String> {
    let Some(s) = raw.as_str() else { return Err("El mensaje tiene que ser texto.".into()) };
    let t = trim_js(s);
    let n = codepoints(t);
    if n < 1 {
        return Err("El mensaje está vacío.".into());
    }
    if n > LIMITE_CUERPO {
        return Err(format!("El mensaje tiene más de {LIMITE_CUERPO} caracteres."));
    }
    Ok(t.to_string())
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CamposEquipo {
    pub name: Option<String>,
    pub description: Option<String>,
    /// `None` = no tocar; `Some(None)` = quitar la foto; `Some(Some(_))` = base64 sin prefijo.
    pub photo_base64: Option<Option<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModoEquipo {
    Crear,
    Editar,
}

/// Valida el alta o la edición de un equipo. `Crear` exige nombre; `Editar` acepta un parche. No deja pasar claves desconocidas.
pub fn parsear_campos_equipo(raw: &Value, modo: ModoEquipo) -> Res<CamposEquipo> {
    let Some(o) = raw.as_object() else { return Err("Datos del equipo inválidos.".into()) };
    for k in o.keys() {
        if !matches!(k.as_str(), "name" | "description" | "photoBase64") {
            return Err(format!("Campo no válido en el equipo: «{k}»."));
        }
    }
    let mut out = CamposEquipo::default();
    if o.contains_key("name") || modo == ModoEquipo::Crear {
        let Some(nombre) = o.get("name").and_then(Value::as_str) else { return Err("El nombre del equipo tiene que ser texto.".into()) };
        let n = trim_js(nombre);
        let len = codepoints(n);
        if len < 1 || len > LIMITE_NOMBRE_EQUIPO {
            return Err(format!("El nombre tiene que tener entre 1 y {LIMITE_NOMBRE_EQUIPO} caracteres."));
        }
        out.name = Some(n.to_string());
    }
    if o.contains_key("description") || modo == ModoEquipo::Crear {
        let d = match o.get("description") {
            None => "",
            Some(v) => v.as_str().ok_or_else(|| "La descripción tiene que ser texto.".to_string())?,
        };
        let t = trim_js(d);
        if codepoints(t) > LIMITE_DESCRIPCION {
            return Err(format!("La descripción tiene más de {LIMITE_DESCRIPCION} caracteres."));
        }
        out.description = Some(t.to_string());
    }
    if let Some(f) = o.get("photoBase64") {
        out.photo_base64 = Some(match f {
            Value::Null => None,
            Value::String(s) => Some(s.clone()),
            _ => return Err("La foto tiene que venir en base64.".into()),
        });
    }
    Ok(out)
}

// ---------- filas → tipos del chat ----------

/// Solo avatares de GitHub: la CSP de la UI lo permite y no hay otra URL.
pub fn avatar_de(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?;
    (s.starts_with(AVATAR_PREFIX) && s.encode_utf16().count() < 500).then(|| s.to_string())
}

/// Perfil de GitHub. Si el perfil no se puede leer (ex miembro) se usa `perfil_ex_miembro`.
pub fn perfil_de_fila(row: &Value) -> Option<ChatProfile> {
    let o = row.as_object()?;
    let id = o.get("id")?.as_str().filter(|s| !s.is_empty())?;
    let login = o.get("login")?.as_str().filter(|s| !s.is_empty())?;
    let name = o.get("name").and_then(Value::as_str).filter(|s| !s.is_empty()).map(|s| cortar_utf16(s, 255));
    Some(ChatProfile { id: id.into(), login: login.into(), name, avatar_url: avatar_de(o.get("avatar_url")) })
}

pub fn perfil_ex_miembro(id: &str) -> ChatProfile {
    ChatProfile::simple(id, EX_MEMBER_LOGIN)
}

/// ISO de Postgres (con microsegundos) → ms epoch. `None` si no se puede leer.
pub fn a_ms(v: Option<&Value>) -> Option<i64> {
    parsear_ms(v?.as_str()?)
}

pub fn rol_de(v: Option<&Value>) -> Option<ChatRole> {
    match v?.as_str()? {
        "owner" => Some(ChatRole::Owner),
        "admin" => Some(ChatRole::Admin),
        "member" => Some(ChatRole::Member),
        _ => None,
    }
}

pub fn conv_de_fila(row: &FilaMensaje) -> Option<ChatConvRef> {
    if let Some(t) = row.get("team_id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        return Some(ChatConvRef::equipo(t));
    }
    row.get("thread_id").and_then(Value::as_str).filter(|s| !s.is_empty()).map(ChatConvRef::directo)
}

pub fn mensaje_de_fila(row: &FilaMensaje, author: ChatProfile, status: EstadoMensaje) -> Option<ChatMessage> {
    let conv = conv_de_fila(row)?;
    let id = texto(row.get("id"));
    if id.is_empty() {
        return None;
    }
    let deleted_at = a_ms(row.get("deleted_at"));
    let nulo = Value::Null;
    Some(ChatMessage {
        id: id.into(),
        client_id: texto(row.get("client_id")).into(),
        conv,
        author,
        body: if deleted_at.is_none() { texto(row.get("body")).into() } else { String::new() },
        created_at: a_ms(row.get("created_at")).unwrap_or(0),
        status,
        error: None,
        edited_at: a_ms(row.get("edited_at")),
        deleted_at,
        reply_to: None,
        reactions: None,
        notice: aviso_de_fila(row.get("kind").unwrap_or(&nulo), row.get("body").unwrap_or(&nulo)),
        via: (row.get("via").and_then(Value::as_str) == Some("claude")).then_some("claude"),
    })
}

/// Referencia al mensaje respondido: un extracto de una línea, vacío si se borró.
pub fn referencia_de_respuesta(row: &Value, login: &str) -> Option<ChatReplyRef> {
    let o = row.as_object()?;
    let id = texto(o.get("id"));
    if id.is_empty() {
        return None;
    }
    let deleted = a_ms(o.get("deleted_at")).is_some();
    let plano = trim_js(&colapsar_blancos(texto(o.get("body")))).to_string();
    Some(ChatReplyRef {
        id: id.into(),
        author_login: login.into(),
        excerpt: if deleted { String::new() } else { primeros_caracteres(&plano, LIMITE_EXTRACTO) },
        deleted,
    })
}

/// `replace(/\s+/g, ' ')`.
fn colapsar_blancos(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut en_blanco = false;
    for c in s.chars() {
        if crate::perfiles_core::es_blanco_js(c) {
            if !en_blanco {
                out.push(' ');
            }
            en_blanco = true;
        } else {
            out.push(c);
            en_blanco = false;
        }
    }
    out
}

/// Filas de message_reactions → reacciones por mensaje, en el orden de CHAT_REACTIONS.
pub fn reacciones_por_mensaje(rows: &[Value], login_de: impl Fn(&str) -> String) -> HashMap<String, Vec<ChatReaction>> {
    let mut agrupado: Vec<(String, HashMap<&'static str, Vec<String>>)> = Vec::new();
    for r in rows {
        let mid = texto(r.get("message_id"));
        let uid = texto(r.get("user_id"));
        let emoji = r.get("emoji").and_then(Value::as_str).and_then(|e| CHAT_REACTIONS.iter().find(|&&x| x == e).copied());
        let (false, false, Some(emoji)) = (mid.is_empty(), uid.is_empty(), emoji) else { continue };
        let pos = match agrupado.iter().position(|(m, _)| m == mid) {
            Some(p) => p,
            None => {
                agrupado.push((mid.to_string(), HashMap::new()));
                agrupado.len() - 1
            }
        };
        let usuarios = agrupado[pos].1.entry(emoji).or_default();
        if !usuarios.iter().any(|u| u == uid) {
            usuarios.push(uid.to_string());
        }
    }
    agrupado
        .into_iter()
        .map(|(mid, por_emoji)| {
            let lista = CHAT_REACTIONS
                .iter()
                .filter_map(|&emoji| {
                    let user_ids = por_emoji.get(emoji)?.clone();
                    let logins = user_ids.iter().map(|u| login_de(u)).collect();
                    Some(ChatReaction { emoji: emoji.into(), user_ids, logins })
                })
                .collect();
            (mid, lista)
        })
        .collect()
}

/// Postgres devuelve «más nuevo primero» (order desc + limit). La UI quiere viejo → nuevo.
pub fn mas_viejo_primero<T: Clone>(filas_desc: &[T]) -> Vec<T> {
    filas_desc.iter().rev().cloned().collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct InfoEquipo {
    pub role: ChatRole,
    pub member_count: u32,
    pub unread: u32,
    pub last_message_at: Option<i64>,
    /// Solo para owner/admin (la RLS ya lo filtra).
    pub invite_code: Option<String>,
    /// Solo con la 0008.
    pub invite_expires_at: Option<f64>,
    pub invite_uses_left: Option<f64>,
}

impl InfoEquipo {
    pub fn nueva(role: ChatRole, member_count: u32, unread: u32) -> Self {
        InfoEquipo { role, member_count, unread, last_message_at: None, invite_code: None, invite_expires_at: None, invite_uses_left: None }
    }
}

pub fn equipo_de_fila(row: &Value, info: &InfoEquipo) -> Option<ChatTeam> {
    let id = texto(row.get("id"));
    let name = texto(row.get("name"));
    if id.is_empty() || name.is_empty() {
        return None;
    }
    let mut team = ChatTeam {
        id: id.into(),
        name: name.into(),
        description: texto(row.get("description")).into(),
        photo: None,
        role: info.role,
        invite_code: None,
        invite_expires_at: None,
        invite_uses_left: None,
        member_count: info.member_count,
        unread: info.unread,
        last_message_at: info.last_message_at,
        retention_hours: row.get("retention_hours").and_then(retencion_de),
    };
    if let Some(code) = info.invite_code.as_ref().filter(|c| !c.is_empty()) {
        if matches!(info.role, ChatRole::Owner | ChatRole::Admin) {
            team.invite_code = Some(code.clone());
            team.invite_expires_at = info.invite_expires_at.filter(|n| n.is_finite()).map(|n| n as i64);
            team.invite_uses_left = info.invite_uses_left.filter(|n| n.fract() == 0.0 && *n >= 0.0).map(|n| n as i64);
        }
    }
    Some(team)
}

/// Ruta de la foto dentro del bucket (sin validar el formato: lo hace `fotos`).
pub fn ruta_de_foto(row: &Value) -> Option<String> {
    let p = texto(row.get("photo_path"));
    (!p.is_empty()).then(|| p.to_string())
}

/// Hasta cuándo leyó el otro participante del DM.
pub fn lectura_del_otro(row: &Value, me: &str) -> Option<i64> {
    if texto(row.get("user_a")) == me {
        return a_ms(row.get("last_read_b"));
    }
    if texto(row.get("user_b")) == me {
        return a_ms(row.get("last_read_a"));
    }
    None
}

/// El otro participante de un DM, o `None` si el usuario no es participante.
pub fn otro_de(row: &Value, me: &str) -> Option<String> {
    let a = texto(row.get("user_a"));
    let b = texto(row.get("user_b"));
    if a == me {
        return (!b.is_empty()).then(|| b.to_string());
    }
    if b == me {
        return (!a.is_empty()).then(|| a.to_string());
    }
    None
}

pub struct InfoHilo {
    pub unread: u32,
    pub last_message_at: Option<i64>,
    pub other_read_at: Option<i64>,
}

pub fn hilo_de_fila(row: &Value, other: ChatProfile, info: &InfoHilo) -> Option<ChatThread> {
    let id = texto(row.get("id"));
    (!id.is_empty()).then(|| ChatThread { id: id.into(), other, unread: info.unread, last_message_at: info.last_message_at, other_read_at: info.other_read_at })
}

pub fn invitacion_de_fila(row: &Value, team_name: &str, invited_by: Option<ChatProfile>) -> Option<ChatInvite> {
    let id = texto(row.get("id"));
    let team_id = texto(row.get("team_id"));
    if id.is_empty() || team_id.is_empty() || team_name.is_empty() {
        return None;
    }
    Some(ChatInvite { id: id.into(), team_id: team_id.into(), team_name: team_name.into(), invited_by, created_at: a_ms(row.get("created_at")).unwrap_or(0) })
}

pub fn miembro_de_fila(row: &Value, profile: ChatProfile) -> Option<ChatMember> {
    let role = rol_de(row.get("role"))?;
    Some(ChatMember { profile, role, joined_at: a_ms(row.get("joined_at")).unwrap_or(0) })
}

fn rango(r: ChatRole) -> u8 {
    match r {
        ChatRole::Owner => 0,
        ChatRole::Admin => 1,
        ChatRole::Member => 2,
    }
}

/// Aproximación de `localeCompare(b, 'es')` de ICU: primero letras sin tilde ni mayúsculas (la ñ va entre la n y la o),
/// después las tildes y al final minúscula antes que mayúscula. Espacios y signos van antes que los dígitos y estos antes
/// que las letras.
pub fn comparar_es(a: &str, b: &str) -> Ordering {
    fn clave(s: &str) -> Vec<(u8, u32)> {
        let nfd: Vec<char> = s.to_lowercase().nfd().collect();
        let mut out = Vec::new();
        let mut i = 0;
        while i < nfd.len() {
            let c = nfd[i];
            i += 1;
            if matches!(c, '\u{300}'..='\u{36f}') {
                if c == '\u{303}' && matches!(out.last(), Some(&(2, 0x6e0))) {
                    out.pop();
                    out.push((2, 0x6e1));
                }
                continue;
            }
            let clase = if c.is_alphabetic() {
                2
            } else if c.is_numeric() {
                1
            } else {
                0
            };
            out.push((clase, if clase == 2 { (c as u32) * 16 } else { c as u32 }));
        }
        out
    }
    clave(a)
        .cmp(&clave(b))
        .then_with(|| a.to_lowercase().nfd().collect::<String>().cmp(&b.to_lowercase().nfd().collect::<String>()))
        .then_with(|| b.cmp(a))
}

/// Owner primero, después admins, después miembros; dentro de cada rol, por usuario.
pub fn comparar_miembros(a: &ChatMember, b: &ChatMember) -> Ordering {
    rango(a.role).cmp(&rango(b.role)).then_with(|| comparar_es(&a.profile.login.to_lowercase(), &b.profile.login.to_lowercase()))
}

/// Orden de las listas: lo último con actividad arriba; sin actividad, por nombre.
pub fn ordenar_por_actividad<T>(lista: &mut [T], ultimo: impl Fn(&T) -> Option<i64>, etiqueta: impl Fn(&T) -> String) {
    lista.sort_by(|a, b| match (ultimo(a), ultimo(b)) {
        (Some(x), Some(y)) if x != y => y.cmp(&x),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        _ => comparar_es(&etiqueta(a), &etiqueta(b)),
    });
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NoLeidos {
    pub unread: u32,
    pub last_message_at: Option<i64>,
}

/// Filas de unread_counts() → índice por clave de conversación.
pub fn indice_de_no_leidos(rows: &[Value]) -> HashMap<String, NoLeidos> {
    let mut out = HashMap::new();
    for r in rows {
        let Some(o) = r.as_object() else { continue };
        let id = texto(o.get("id"));
        let kind = match o.get("kind").and_then(Value::as_str) {
            Some("team") => TipoConv::Team,
            Some("dm") => TipoConv::Dm,
            _ => continue,
        };
        if id.is_empty() {
            continue;
        }
        let unread = match o.get("unread").and_then(Value::as_f64) {
            Some(n) if n > 0.0 => n.floor().min(99.0) as u32,
            _ => 0,
        };
        out.insert(conv_key(&ChatConvRef { kind, id: id.into() }), NoLeidos { unread, last_message_at: a_ms(o.get("last_at")) });
    }
    out
}

pub fn misma_conv(a: &ChatConvRef, b: &ChatConvRef) -> bool {
    a == b
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const T: &str = "11111111-1111-4111-8111-111111111111";
    const ID: &str = "33333333-3333-4333-8333-333333333333";
    const A: &str = "55555555-5555-4555-8555-555555555555";
    const B: &str = "66666666-6666-4666-8666-666666666666";
    const AT: &str = "2026-11-12T10:05:00+00:00";

    fn fila(extra: Value) -> FilaMensaje {
        let mut m = json!({"id": ID, "client_id": ID, "team_id": T, "author_id": A, "body": "hola", "created_at": AT});
        for (k, v) in extra.as_object().unwrap() {
            m[k] = v.clone();
        }
        m.as_object().unwrap().clone()
    }

    fn autor() -> ChatProfile {
        ChatProfile::simple(A, "ana")
    }

    fn msg(extra: Value) -> ChatMessage {
        mensaje_de_fila(&fila(extra), autor(), EstadoMensaje::Sent).unwrap()
    }

    #[test]
    fn mensaje_editado_y_borrado() {
        let at = parsear_ms(AT).unwrap();
        let e = msg(json!({"edited_at": AT}));
        assert_eq!(e.edited_at, Some(at));
        assert_eq!(e.deleted_at, None);
        let d = msg(json!({"body": "quedó", "deleted_at": AT}));
        assert_eq!(d.deleted_at, Some(at));
        assert_eq!(d.body, "");
        assert_eq!(msg(json!({})).edited_at, None);
    }

    #[test]
    fn mensaje_via_claude_solo_con_via_igual_a_claude() {
        assert_eq!(msg(json!({"via": "claude"})).via, Some("claude"));
        assert_eq!(msg(json!({"via": "otro"})).via, None);
        assert_eq!(msg(json!({})).via, None);
    }

    fn info_dueno() -> InfoEquipo {
        InfoEquipo { invite_code: Some("a".repeat(16)), ..InfoEquipo::nueva(ChatRole::Owner, 2, 0) }
    }

    #[test]
    fn el_vencimiento_del_codigo_solo_va_con_codigo_y_rol_de_gestion() {
        let row = json!({"id": T, "name": "Equipo"});
        let t = equipo_de_fila(&row, &InfoEquipo { invite_expires_at: Some(1000.0), invite_uses_left: Some(3.0), ..info_dueno() }).unwrap();
        assert_eq!(t.invite_expires_at, Some(1000));
        assert_eq!(t.invite_uses_left, Some(3));
        let mala = equipo_de_fila(&row, &InfoEquipo { invite_expires_at: Some(f64::NAN), invite_uses_left: Some(-1.0), ..info_dueno() }).unwrap();
        assert_eq!((mala.invite_expires_at, mala.invite_uses_left), (None, None));
        assert_eq!(equipo_de_fila(&row, &InfoEquipo { invite_uses_left: Some(1.5), ..info_dueno() }).unwrap().invite_uses_left, None);
        let miembro = equipo_de_fila(&row, &InfoEquipo { role: ChatRole::Member, invite_expires_at: Some(1000.0), ..info_dueno() }).unwrap();
        assert_eq!((miembro.invite_code, miembro.invite_expires_at), (None, None));
        assert_eq!(equipo_de_fila(&row, &InfoEquipo { invite_code: None, invite_expires_at: Some(1000.0), ..info_dueno() }).unwrap().invite_expires_at, None);
    }

    #[test]
    fn avisos_de_la_conversacion_y_borrado_automatico_del_equipo() {
        assert_eq!(msg(json!({"body": "clear", "kind": "clear"})).notice, Some(ChatNotice::Clear));
        assert_eq!(msg(json!({"body": "720", "kind": "retention"})).notice, Some(ChatNotice::Retention { hours: Some(720) }));
        assert_eq!(msg(json!({"kind": "text"})).notice, None);
        let info = InfoEquipo::nueva(ChatRole::Member, 2, 0);
        assert_eq!(equipo_de_fila(&json!({"id": T, "name": "Equipo", "retention_hours": 168}), &info).unwrap().retention_hours, Some(168));
        assert_eq!(equipo_de_fila(&json!({"id": T, "name": "Equipo", "retention_hours": null}), &info).unwrap().retention_hours, None);
        assert_eq!(equipo_de_fila(&json!({"id": T, "name": "Equipo", "retention_hours": 5}), &info).unwrap().retention_hours, None);
    }

    #[test]
    fn validacion_de_reaccion_busqueda_e_id_opcional() {
        assert_eq!(parsear_emoji(&json!("👍")), Ok("👍"));
        assert_eq!(parsear_emoji(&json!("💩")), Err("Reacción inválida.".into()));
        assert_eq!(parsear_emoji(&json!(1)), Err("Reacción inválida.".into()));
        assert_eq!(parsear_busqueda(&json!("  hola ")), Ok("hola".into()));
        assert!(parsear_busqueda(&json!(" a ")).unwrap_err().contains("al menos 2"));
        assert!(parsear_busqueda(&json!("x".repeat(101))).unwrap_err().contains("más de 100"));
        assert!(parsear_busqueda(&json!(null)).unwrap_err().contains("al menos 2"));
        assert_eq!(parsear_uuid_opcional(None), Ok(None));
        assert_eq!(parsear_uuid_opcional(Some(&json!(null))), Ok(None));
        assert_eq!(parsear_uuid_opcional(Some(&json!(ID.to_uppercase()))), Ok(Some(ID.into())));
        assert!(parsear_uuid_opcional(Some(&json!("x"))).is_err());
    }

    #[test]
    fn referencia_de_respuesta_una_linea_y_recortada_vacia_si_se_borro() {
        assert_eq!(
            referencia_de_respuesta(&json!({"id": ID, "author_id": A, "body": "hola\n  che"}), "ana"),
            Some(ChatReplyRef { id: ID.into(), author_login: "ana".into(), excerpt: "hola che".into(), deleted: false })
        );
        assert_eq!(referencia_de_respuesta(&json!({"id": ID, "author_id": A, "body": "x".repeat(200)}), "ana").unwrap().excerpt.chars().count(), 141);
        assert_eq!(
            referencia_de_respuesta(&json!({"id": ID, "author_id": A, "body": "", "deleted_at": AT}), "ana"),
            Some(ChatReplyRef { id: ID.into(), author_login: "ana".into(), excerpt: String::new(), deleted: true })
        );
        assert_eq!(referencia_de_respuesta(&json!({"id": null, "author_id": A, "body": "x"}), "ana"), None);
    }

    #[test]
    fn reacciones_agrupadas_por_mensaje_en_el_orden_de_la_lista() {
        let rows = vec![
            json!({"message_id": ID, "user_id": A, "emoji": "👀"}),
            json!({"message_id": ID, "user_id": B, "emoji": "👍"}),
            json!({"message_id": ID, "user_id": A, "emoji": "👍"}),
            json!({"message_id": ID, "user_id": A, "emoji": "👍"}),
            json!({"message_id": ID, "user_id": A, "emoji": "💩"}),
            json!({"message_id": null, "user_id": A, "emoji": "👍"}),
        ];
        let m = reacciones_por_mensaje(&rows, |id| if id == A { "ana".into() } else { "beto".into() });
        assert_eq!(
            m[ID],
            vec![
                ChatReaction { emoji: "👍".into(), user_ids: vec![B.into(), A.into()], logins: vec!["beto".into(), "ana".into()] },
                ChatReaction { emoji: "👀".into(), user_ids: vec![A.into()], logins: vec!["ana".into()] },
            ]
        );
        assert_eq!(m.len(), 1);
    }

    #[test]
    fn lectura_del_otro_en_un_dm() {
        let t = json!({"id": ID, "user_a": A, "user_b": B, "last_read_a": AT, "last_read_b": "2026-11-12T11:00:00+00:00"});
        assert_eq!(lectura_del_otro(&t, A), parsear_ms("2026-11-12T11:00:00+00:00"));
        assert_eq!(lectura_del_otro(&t, B), parsear_ms(AT));
        assert_eq!(lectura_del_otro(&t, T), None);
        assert_eq!(lectura_del_otro(&json!({"id": ID, "user_a": A, "user_b": B}), A), None);
    }

    #[test]
    fn argumentos_de_ipc() {
        assert_eq!(parsear_uuid(&json!(ID.to_uppercase()), "x"), Ok(ID.into()));
        assert_eq!(parsear_uuid(&json!("no"), "Identificador inválido."), Err("Identificador inválido.".into()));
        assert!(parsear_client_id(&json!("44444444-4444-4444-8444-444444444444")).is_ok());
        assert!(parsear_client_id(&json!("44444444-4444-1444-8444-444444444444")).is_err());
        assert!(parsear_client_id(&json!("44444444-4444-4444-c444-444444444444")).is_err());
        assert_eq!(parsear_login(&json!("  Tomy-1 ")), Ok("tomy-1".into()));
        assert!(parsear_login(&json!("@tomy")).is_err());
        assert!(parsear_login(&json!("a".repeat(40))).is_err());
        assert_eq!(parsear_codigo_invitacion(&json!(" 0123456789ABCDEF ")), Ok("0123456789abcdef".into()));
        assert!(parsear_codigo_invitacion(&json!("0123456789abcde")).is_err());
        assert_eq!(parsear_conv(&json!({"kind": "dm", "id": ID})), Ok(ChatConvRef::directo(ID)));
        assert!(parsear_conv(&json!({"kind": "otro", "id": ID})).is_err());
        assert_eq!(parsear_vista(&json!({"open": false})), Ok(ChatView::Cerrado));
        assert_eq!(parsear_vista(&json!({"open": true})), Ok(ChatView::Abierto(None)));
        assert_eq!(parsear_vista(&json!({"open": true, "conv": {"kind": "team", "id": T}})), Ok(ChatView::Abierto(Some(ChatConvRef::equipo(T)))));
        assert!(parsear_vista(&json!({"open": "si"})).is_err());
        assert_eq!(parsear_limite(None), Ok(50));
        assert_eq!(parsear_limite(Some(&json!(500))), Ok(100));
        assert_eq!(parsear_limite(Some(&json!(0.4))), Ok(1));
        assert!(parsear_limite(Some(&json!("x"))).is_err());
        assert_eq!(parsear_cuerpo(&json!("  hola ")), Ok("hola".into()));
        assert_eq!(parsear_cuerpo(&json!("   ")), Err("El mensaje está vacío.".into()));
        assert!(parsear_cuerpo(&json!("x".repeat(4001))).is_err());
        assert!(parsear_cuerpo(&json!("é".repeat(4000))).is_ok());
    }

    #[test]
    fn campos_de_equipo() {
        let c = parsear_campos_equipo(&json!({"name": " Equipo ", "photoBase64": null}), ModoEquipo::Crear).unwrap();
        assert_eq!(c, CamposEquipo { name: Some("Equipo".into()), description: Some(String::new()), photo_base64: Some(None) });
        assert_eq!(parsear_campos_equipo(&json!({"description": "x"}), ModoEquipo::Editar).unwrap().name, None);
        assert!(parsear_campos_equipo(&json!({}), ModoEquipo::Crear).is_err());
        assert!(parsear_campos_equipo(&json!({"name": "a", "rol": 1}), ModoEquipo::Crear).unwrap_err().contains("«rol»"));
        assert!(parsear_campos_equipo(&json!({"name": "a".repeat(61)}), ModoEquipo::Crear).is_err());
        assert!(parsear_campos_equipo(&json!({"name": "a", "photoBase64": 5}), ModoEquipo::Crear).is_err());
    }

    #[test]
    fn perfiles_y_avatares() {
        let p = perfil_de_fila(&json!({"id": A, "login": "ana", "name": "Ana", "avatar_url": "https://avatars.githubusercontent.com/u/1"})).unwrap();
        assert_eq!(p.avatar_url.as_deref(), Some("https://avatars.githubusercontent.com/u/1"));
        assert_eq!(perfil_de_fila(&json!({"id": A, "login": "ana", "avatar_url": "https://evil.example/x.png"})).unwrap().avatar_url, None);
        assert_eq!(perfil_de_fila(&json!({"id": A, "login": ""})), None);
        assert_eq!(perfil_ex_miembro(A).login, "ex-miembro");
    }

    #[test]
    fn no_leidos_con_tope_de_99() {
        let i = indice_de_no_leidos(&[json!({"kind": "team", "id": T, "unread": 250, "last_at": AT}), json!({"kind": "otro", "id": T}), json!({"kind": "dm", "id": ID, "unread": -3})]);
        assert_eq!(i[&format!("team:{T}")], NoLeidos { unread: 99, last_message_at: parsear_ms(AT) });
        assert_eq!(i[&format!("dm:{ID}")].unread, 0);
        assert_eq!(i.len(), 2);
    }

    #[test]
    fn listas_por_actividad_y_miembros_por_rol() {
        let mut v = vec![("b", None), ("a", None), ("z", Some(5)), ("y", Some(9))];
        ordenar_por_actividad(&mut v, |x| x.1, |x| x.0.to_string());
        assert_eq!(v.iter().map(|x| x.0).collect::<Vec<_>>(), ["y", "z", "a", "b"]);
        let m = |login: &str, role| ChatMember { profile: ChatProfile::simple("i", login), role, joined_at: 0 };
        let mut miembros = vec![m("zeta", ChatRole::Member), m("beto", ChatRole::Member), m("ana", ChatRole::Admin), m("zz", ChatRole::Owner)];
        miembros.sort_by(comparar_miembros);
        assert_eq!(miembros.iter().map(|x| x.profile.login.as_str()).collect::<Vec<_>>(), ["zz", "ana", "beto", "zeta"]);
    }

    #[test]
    fn el_orden_alfabetico_sigue_el_del_espanol() {
        assert_eq!(comparar_es("Ñandú", "Oso"), Ordering::Less);
        assert_eq!(comparar_es("Ñandú", "Nube"), Ordering::Greater);
        assert_eq!(comparar_es("alfa", "Beta"), Ordering::Less);
        assert_eq!(comparar_es("árbol", "arbol"), Ordering::Greater);
        assert_eq!(comparar_es("Equipo 2", "Equipo A"), Ordering::Less);
    }

    #[test]
    fn mas_viejo_primero_invierte() {
        assert_eq!(mas_viejo_primero(&[3, 2, 1]), vec![1, 2, 3]);
    }
}
