//! Tipos y constantes del chat que comparten main y renderer (src/shared/chat.ts y src/shared/chat-mcp.ts).
use serde::{Deserialize, Serialize};

/// Puertos del servidor loopback del login (el primero libre). Van en «Redirect URLs» de Supabase.
pub const CHAT_CALLBACK_PORTS: [u16; 3] = [53682, 53683, 53684];
pub const CHAT_CALLBACK_PATH: &str = "/auth/callback";

pub const LIMITE_CUERPO: usize = 4000;
pub const LIMITE_NOMBRE_EQUIPO: usize = 60;
pub const LIMITE_DESCRIPCION: usize = 500;
/// Foto del equipo ya recortada, en bytes. Igual al límite del bucket.
pub const LIMITE_FOTO_BYTES: usize = 512 * 1024;
pub const LIMITE_BUSQUEDA: usize = 100;
pub const LIMITE_EXTRACTO: usize = 140;

/// Tienen que coincidir byte a byte con el check de 0004_chat_completo.sql.
pub const CHAT_REACTIONS: [&str; 8] = ["👍", "❤️", "😂", "🎉", "😮", "😢", "🙏", "👀"];
/// Plazos del borrado automático, en horas. Tienen que coincidir con el check de 0004_chat_completo.sql.
pub const CHAT_RETENTION_HOURS: [u32; 4] = [24, 168, 720, 2160];

pub const VIA_CLAUDE_PREFIX: &str = "[vía Claude] ";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TipoConv {
    Team,
    Dm,
}

impl TipoConv {
    pub fn como_str(self) -> &'static str {
        match self {
            TipoConv::Team => "team",
            TipoConv::Dm => "dm",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ChatConvRef {
    pub kind: TipoConv,
    pub id: String,
}

impl ChatConvRef {
    pub fn equipo(id: &str) -> Self {
        ChatConvRef { kind: TipoConv::Team, id: id.to_string() }
    }
    pub fn directo(id: &str) -> Self {
        ChatConvRef { kind: TipoConv::Dm, id: id.to_string() }
    }
}

pub fn conv_key(c: &ChatConvRef) -> String {
    format!("{}:{}", c.kind.como_str(), c.id)
}

/// Lo que el usuario tiene a la vista: el drawer cerrado, la lista, o una conversación.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatView {
    Cerrado,
    Abierto(Option<ChatConvRef>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatProfile {
    pub id: String,
    pub login: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

impl ChatProfile {
    pub fn simple(id: &str, login: &str) -> Self {
        ChatProfile { id: id.to_string(), login: login.to_string(), name: None, avatar_url: None }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    Owner,
    Admin,
    Member,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTeam {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub photo: Option<String>,
    pub role: ChatRole,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invite_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invite_expires_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invite_uses_left: Option<i64>,
    pub member_count: u32,
    pub unread: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retention_hours: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatThread {
    pub id: String,
    pub other: ChatProfile,
    pub unread: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub other_read_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMember {
    pub profile: ChatProfile,
    pub role: ChatRole,
    pub joined_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatInvite {
    pub id: String,
    pub team_id: String,
    pub team_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invited_by: Option<ChatProfile>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EstadoMensaje {
    Sending,
    Sent,
    Failed,
}

/// Aviso de la conversación que deja el servidor a nombre de quien hizo el cambio.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ChatNotice {
    Retention { hours: Option<u32> },
    Clear,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReaction {
    pub emoji: String,
    pub user_ids: Vec<String>,
    pub logins: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReplyRef {
    pub id: String,
    pub author_login: String,
    pub excerpt: String,
    pub deleted: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub client_id: String,
    pub conv: ChatConvRef,
    pub author: ChatProfile,
    pub body: String,
    pub created_at: i64,
    pub status: EstadoMensaje,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<ChatReplyRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reactions: Option<Vec<ChatReaction>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<ChatNotice>,
    /// Lo mandó Claude por el MCP del chat. Informativa: la pone el cliente del autor.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRemoveResult {
    /// Si el código de invitación del equipo cambió (la invitación vieja ya no sirve).
    pub codigo_nuevo: bool,
    pub aviso: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EstadoCheck {
    Ok,
    Fallo,
    Aviso,
    SinDatos,
}

/// Un chequeo de «Probar conexión». Los textos son fijos del código: nunca traen datos del servidor ni la clave.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatCheck {
    pub id: String,
    pub estado: EstadoCheck,
    pub titulo: String,
    pub detalle: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accion: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatMcpOp {
    Leer,
    Enviar,
}

/// «always» solo vale para leer: enviar se confirma siempre viendo el texto.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatMcpChoice {
    Once,
    Always,
    Deny,
}

/// Permiso permanente de leer una conversación desde una cuenta.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMcpGrant {
    pub account_id: String,
    pub conv: ChatConvRef,
    pub nombre: String,
    #[serde(serialize_with = "numero_js")]
    pub at: f64,
}

/// Un número entero sale como `5`, no `5.0`: así lo escribe `JSON.stringify`.
pub fn numero_js<S: serde::Serializer>(n: &f64, s: S) -> Result<S::Ok, S::Error> {
    if n.fract() == 0.0 && n.abs() < 9e15 {
        s.serialize_i64(*n as i64)
    } else {
        s.serialize_f64(*n)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EstadoRegistro {
    Revisando,
    Ok,
    Pendiente,
    Conflicto,
    SinCli,
    Error,
    NoSoportado,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMcpAccountReg {
    pub account_id: String,
    pub label: String,
    pub state: EstadoRegistro,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMcpLimits {
    pub enviar_por_minuto: u32,
    pub leer_por_minuto: u32,
    pub max_texto: usize,
    pub max_leer: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMcpView {
    pub enabled: bool,
    pub cuentas: Vec<String>,
    pub grants: Vec<ChatMcpGrant>,
    pub limits: ChatMcpLimits,
    pub accounts: Vec<ChatMcpAccountReg>,
    /// El servidor tiene la 0005: la marca va en columna; si no, como prefijo en el texto.
    pub via_column: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ModoRiesgoso {
    BypassPermissions,
    AcceptEdits,
}

impl ModoRiesgoso {
    pub fn como_str(self) -> &'static str {
        match self {
            ModoRiesgoso::BypassPermissions => "bypassPermissions",
            ModoRiesgoso::AcceptEdits => "acceptEdits",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMcpAsk {
    pub id: String,
    pub op: ChatMcpOp,
    pub conv: ChatConvRef,
    pub nombre: String,
    /// Cuenta que pide: sale del token, es lo único verificado del origen.
    pub account: String,
    /// Espacio que dice la terminal (SLOTH_WS): no verificado, y solo si es de esa cuenta.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    /// Solo en 'enviar': el texto que escribió Claude y se mandaría (ya validado).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    /// La cuenta corre sin pedir permisos: no hay «siempre».
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sin_siempre: Option<ModoRiesgoso>,
    pub expires_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn la_clave_de_conversacion_junta_tipo_e_id() {
        assert_eq!(conv_key(&ChatConvRef::equipo("x")), "team:x");
        assert_eq!(conv_key(&ChatConvRef::directo("y")), "dm:y");
    }

    #[test]
    fn el_mensaje_serializa_en_camel_case_y_sin_vacios() {
        let m = ChatMessage {
            id: "i".into(),
            client_id: "c".into(),
            conv: ChatConvRef::equipo("t"),
            author: ChatProfile::simple("a", "ana"),
            body: "hola".into(),
            created_at: 5,
            status: EstadoMensaje::Sent,
            error: None,
            edited_at: None,
            deleted_at: None,
            reply_to: None,
            reactions: None,
            notice: Some(ChatNotice::Retention { hours: None }),
            via: Some("claude"),
        };
        assert_eq!(
            serde_json::to_value(&m).unwrap(),
            json!({"id":"i","clientId":"c","conv":{"kind":"team","id":"t"},"author":{"id":"a","login":"ana"},"body":"hola","createdAt":5,"status":"sent","notice":{"kind":"retention","hours":null},"via":"claude"})
        );
    }

    #[test]
    fn el_aviso_de_vaciar_lleva_solo_el_tipo() {
        assert_eq!(serde_json::to_value(ChatNotice::Clear).unwrap(), json!({"kind":"clear"}));
    }

    #[test]
    fn los_estados_del_registro_usan_los_nombres_de_la_ui() {
        assert_eq!(serde_json::to_value(EstadoRegistro::NoSoportado).unwrap(), json!("no-soportado"));
        assert_eq!(serde_json::to_value(EstadoRegistro::SinCli).unwrap(), json!("sin-cli"));
        assert_eq!(serde_json::to_value(EstadoCheck::SinDatos).unwrap(), json!("sin-datos"));
        assert_eq!(serde_json::to_value(ModoRiesgoso::AcceptEdits).unwrap(), json!("acceptEdits"));
    }
}
