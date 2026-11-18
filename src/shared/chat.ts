/**
 * Chat del equipo (personas, no agentes) sobre el Supabase PROPIO del equipo. v0.5.
 *
 * Arquitectura (ver docs/chat-equipo.md y el PLAN):
 *  - TODO lo de Supabase (cliente, sesión, realtime) vive en el proceso MAIN
 *    (src/main/features/chat*.ts). El renderer nunca ve tokens: solo estos tipos por `feat:chat:*`.
 *  - Login con GitHub vía Supabase Auth, flujo PKCE: navegador del sistema + callback en un
 *    servidor loopback http://127.0.0.1:<CHAT_CALLBACK_PORTS>/auth/callback del proceso main.
 *  - Sesión cifrada con safeStorage. Una sola conexión realtime mientras la ventana exista.
 *
 * Canales (feat:chat:<op>) — todos devuelven Promise; los errores son Error con mensaje para mostrar:
 *   state()                                 → ChatSnapshot
 *   getConfig()                             → ChatConfigView
 *   setConfig(input: ChatConfigInput|null)  → ChatConfigView      (null = borrar la de Configuración)
 *   acceptTeamConfig(repo: string)          → ChatConfigView      (el usuario confirma usar la de .sloth/team.json)
 *   signIn()                                → void                (abre el navegador; el resultado llega por «snapshot»)
 *   cancelSignIn()                          → void
 *   signOut()                               → void
 *   setView(view: ChatView)                 → void                (qué está mirando el usuario: para no leídos y avisos)
 *   messages(conv: ChatConvRef, before?: string /* id de mensaje *\/, limit?: number /* 1..100, def. 50 *\/) → ChatMessage[] (viejo→nuevo)
 *   send(conv: ChatConvRef, body: string, clientId: string /* uuid v4 *\/, replyTo?: string /* id de mensaje *\/) → ChatMessage (status 'sent')
 *   edit(conv: ChatConvRef, messageId: string, body: string) → ChatMessage
 *   remove(conv: ChatConvRef, messageId: string) → ChatMessage  (borrado blando: queda con deletedAt y body '')
 *   react(conv: ChatConvRef, messageId: string, emoji: ChatReactionEmoji, on: boolean) → void
 *   search(conv: ChatConvRef, query: string) → ChatMessage[]     (nuevo→viejo, hasta 50)
 *   typing(conv: ChatConvRef)               → void                («escribiendo…» para los demás)
 *   markRead(conv: ChatConvRef)             → void
 *   clear(conv: ChatConvRef)                → void                (vacía la conversación para todos; owner/admin en equipos)
 *   setRetention(teamId: string, hours: ChatRetentionHours | null) → ChatTeam  (borrado automático; null = apagado)
 *   createTeam(input: ChatTeamInput)        → ChatTeam
 *   updateTeam(teamId: string, patch: Partial<ChatTeamInput>) → ChatTeam
 *   members(teamId: string)                 → ChatMember[]
 *   inviteByLogin(teamId: string, githubLogin: string) → ChatInviteSent
 *   regenerateCode(teamId: string)          → string              (código nuevo; el viejo deja de andar)
 *   joinByCode(code: string)                → ChatTeam
 *   acceptInvite(inviteId: string)          → ChatTeam
 *   declineInvite(inviteId: string)         → void
 *   leaveTeam(teamId: string)               → void
 *   removeMember(teamId: string, userId: string) → ChatRemoveResult (también cambia el código de invitación)
 *   openDm(userId: string)                  → ChatThread           (solo con gente con la que compartís un equipo)
 *   inviteText(teamId: string, code?: string) → string              (invitación completa: servidor + clave publicable + código)
 *   previewInvite(text: string)             → ChatInvitePreview   (valida y dice qué va a pasar; no cambia nada)
 *   joinInvite(text: string, confirmed?: 'confirmNew'|'confirmReplace') → ChatInviteJoin
 *   clipboardInvite()                       → string | null       (el portapapeles, solo si parece una invitación)
 *
 * Eventos (main → UI):
 *   feat:chat:snapshot (ChatSnapshot)       cada vez que cambia algo de la lista/estado
 *   feat:chat:message  (ChatMessage)        mensaje nuevo, editado o borrado (mismo id) en cualquier conversación
 *   feat:chat:reaction (ChatReactionEvent)  alguien puso o sacó una reacción
 *   feat:chat:typing   (ChatTypingEvent)    alguien está escribiendo
 *   feat:chat:read     (ChatReadEvent)      el otro participante de un DM leyó hasta `at`
 *   feat:chat:open     (ChatConvRef)        el usuario tocó una notificación: abrir el drawer en esa conversación
 *   feat:chat:invite   (ChatInviteResult)   terminó de canjearse una invitación que esperaba el login
 */

/** Puertos del servidor loopback del login (el primero libre). Van en «Redirect URLs» de Supabase. */
export const CHAT_CALLBACK_PORTS = [53682, 53683, 53684] as const
export const CHAT_CALLBACK_PATH = '/auth/callback'

export const CHAT_LIMITS = {
  body: 4000,
  teamName: 60,
  teamDescription: 500,
  /** Foto del equipo ya recortada (webp/png/jpeg), en bytes. Igual al límite del bucket. */
  photoBytes: 512 * 1024,
  photoSide: 256,
  githubLogin: 39,
  inviteCode: 32,
  searchQuery: 100,
  replyExcerpt: 140
} as const

/** Reacciones permitidas. Tienen que coincidir byte a byte con el check de 0004_chat_completo.sql. */
export const CHAT_REACTIONS = ['👍', '❤️', '😂', '🎉', '😮', '😢', '🙏', '👀'] as const
export type ChatReactionEmoji = (typeof CHAT_REACTIONS)[number]

/** Plazos del borrado automático, en horas. Tienen que coincidir con el check de 0004_chat_completo.sql. */
export const CHAT_RETENTION_HOURS = [24, 168, 720, 2160] as const
export type ChatRetentionHours = (typeof CHAT_RETENTION_HOURS)[number]

/** Aviso de la conversación que deja el servidor a nombre de quien hizo el cambio. */
export type ChatNotice = { kind: 'retention'; hours: ChatRetentionHours | null } | { kind: 'clear' }

export type ChatConvRef = { kind: 'team'; id: string } | { kind: 'dm'; id: string }

export const convKey = (c: ChatConvRef): string => `${c.kind}:${c.id}`

/** Lo que el usuario tiene a la vista: el drawer cerrado, la lista, o una conversación. */
export type ChatView = { open: false } | { open: true; conv?: ChatConvRef }

export interface ChatProfile {
  id: string
  /** Usuario de GitHub (tal cual, sin @). */
  login: string
  name?: string
  /** https://avatars.githubusercontent.com/... (la CSP de index.html lo permite) */
  avatarUrl?: string
}

export type ChatRole = 'owner' | 'admin' | 'member'

export interface ChatTeam {
  id: string
  name: string
  description: string
  /** data:image/webp;base64,... ya descargada por main (el bucket es privado). */
  photo?: string
  role: ChatRole
  /** Solo para owner/admin. */
  inviteCode?: string
  /** Solo con la 0008. */
  inviteExpiresAt?: number
  inviteUsesLeft?: number
  memberCount: number
  unread: number
  lastMessageAt?: number
  /** Borrado automático de los mensajes, en horas. Sin definir = apagado. */
  retentionHours?: ChatRetentionHours
}

export interface ChatThread {
  id: string
  other: ChatProfile
  unread: number
  lastMessageAt?: number
  /** Hasta cuándo leyó el otro (ms epoch), para «Visto». */
  otherReadAt?: number
}

export interface ChatMember {
  profile: ChatProfile
  role: ChatRole
  joinedAt: number
}

export interface ChatInvite {
  id: string
  teamId: string
  teamName: string
  invitedBy?: ChatProfile
  createdAt: number
}

export interface ChatInviteSent {
  id: string
  githubLogin: string
}

export type ChatMessageStatus = 'sending' | 'sent' | 'failed'

export interface ChatMessage {
  id: string
  /** uuid que genera la UI al enviar: sirve para casar el «enviando…» con el mensaje que vuelve. */
  clientId: string
  conv: ChatConvRef
  author: ChatProfile
  body: string
  /** ms epoch */
  createdAt: number
  status: ChatMessageStatus
  /** Si falló, por qué (para mostrar y reintentar). */
  error?: string
  editedAt?: number
  /** Borrado ⇔ deletedAt definido; en ese caso body es ''. */
  deletedAt?: number
  replyTo?: ChatReplyRef
  reactions?: ChatReaction[]
  /** Si viene, no es un mensaje sino un aviso (body no se muestra). */
  notice?: ChatNotice
  /** Lo mandó Claude por el MCP del chat. Informativa: la pone el cliente del autor. */
  via?: 'claude'
}

export interface ChatReaction {
  emoji: ChatReactionEmoji
  userIds: string[]
  logins: string[]
}

export interface ChatReplyRef {
  id: string
  authorLogin: string
  excerpt: string
  deleted: boolean
}

export interface ChatReactionEvent {
  conv: ChatConvRef
  messageId: string
  emoji: ChatReactionEmoji
  userId: string
  login: string
  op: 'add' | 'remove'
}

export interface ChatTypingEvent {
  conv: ChatConvRef
  userId: string
  login: string
}

export interface ChatReadEvent {
  conv: ChatConvRef
  userId: string
  at: number
}

export interface ChatTeamInput {
  name: string
  description: string
  /** base64 SIN prefijo data:, de una imagen ya recortada a CHAT_LIMITS.photoSide (webp preferido). null = quitar. */
  photoBase64?: string | null
}

export type ChatAuth =
  | { status: 'unconfigured' }
  | { status: 'signedOut' }
  | { status: 'signingIn'; startedAt: number; aviso?: string }
  | { status: 'signedIn'; me: ChatProfile }
  | { status: 'error'; message: string }

export type ChatConnection = 'off' | 'connecting' | 'live' | 'retrying'

export interface ChatSnapshot {
  auth: ChatAuth
  connection: ChatConnection
  teams: ChatTeam[]
  threads: ChatThread[]
  invites: ChatInvite[]
  unreadTotal: number
  /** El servidor tiene la 0004: editar, borrar, responder, reaccionar, «escribiendo…», «visto», borrado automático y vaciar. */
  extras: boolean
  /** El servidor tiene la 0008: vaciar un DM lo oculta solo para quien vacía. Sin ella se borra para los dos. */
  dmClearForMe: boolean
  /** Ya llegaron las listas del servidor al menos una vez en esta sesión (hasta entonces vienen vacías). */
  listsLoaded: boolean
}

export interface ChatConfigInput {
  /** https://<ref>.supabase.co (o un dominio propio https). */
  supabaseUrl: string
  /** La anon / publishable key. NUNCA la service_role / secret (main la rechaza). */
  anonKey: string
}

export interface ChatConfigView {
  /** Qué config se está usando, si hay. La key se muestra recortada (no es secreta, pero no hace falta). */
  active?: { supabaseUrl: string; keyPreview: string; source: 'settings' | 'team.json'; repo?: string }
  /** Config ofrecida por un .sloth/team.json que el usuario todavía no aceptó. */
  offered?: { supabaseUrl: string; repo: string; teamName: string }
}

export type ChatInviteDecision = 'confirmNew' | 'confirmReplace' | 'signIn' | 'redeem'

export interface ChatRemoveResult {
  /** Si el código de invitación del equipo cambió (la invitación vieja ya no sirve). */
  codigoNuevo: boolean
  /** Qué hacer ahora: reenviar invitaciones y, sin la migración 0007, aplicarla. */
  aviso: string
}

/** Lo que se muestra antes de usar una invitación. Nunca trae la clave. */
export interface ChatInvitePreview {
  /** Host del servidor al que se va a conectar. */
  host: string
  teamName?: string
  decision: ChatInviteDecision
  /** Host de la configuración que se reemplazaría (solo con confirmReplace). */
  currentHost?: string
}

export type ChatInviteJoin = { kind: 'joined'; team: ChatTeam } | { kind: 'signingIn' }

export type ChatInviteResult = { ok: true; team: ChatTeam } | { ok: false; message: string }
