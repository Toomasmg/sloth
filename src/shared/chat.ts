/**
 * Chat del equipo (personas, no agentes) sobre el Supabase PROPIO del equipo. v0.5.
 *
 * Arquitectura (ver docs/chat-supabase.md y el PLAN):
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
 *   send(conv: ChatConvRef, body: string, clientId: string /* uuid v4 *\/) → ChatMessage (status 'sent')
 *   markRead(conv: ChatConvRef)             → void
 *   createTeam(input: ChatTeamInput)        → ChatTeam
 *   updateTeam(teamId: string, patch: Partial<ChatTeamInput>) → ChatTeam
 *   members(teamId: string)                 → ChatMember[]
 *   inviteByLogin(teamId: string, githubLogin: string) → ChatInviteSent
 *   regenerateCode(teamId: string)          → string              (código nuevo; el viejo deja de andar)
 *   joinByCode(code: string)                → ChatTeam
 *   acceptInvite(inviteId: string)          → ChatTeam
 *   declineInvite(inviteId: string)         → void
 *   leaveTeam(teamId: string)               → void
 *   removeMember(teamId: string, userId: string) → void
 *   openDm(userId: string)                  → ChatThread           (solo con gente con la que compartís un equipo)
 *   inviteText(teamId: string)              → string              (invitación completa: servidor + clave publicable + código)
 *   previewInvite(text: string)             → ChatInvitePreview   (valida y dice qué va a pasar; no cambia nada)
 *   joinInvite(text: string, confirmed?: 'confirmNew'|'confirmReplace') → ChatInviteJoin
 *   clipboardInvite()                       → string | null       (el portapapeles, solo si parece una invitación)
 *
 * Eventos (main → UI):
 *   feat:chat:snapshot (ChatSnapshot)       cada vez que cambia algo de la lista/estado
 *   feat:chat:message  (ChatMessage)        mensaje nuevo (propio o ajeno) en cualquier conversación
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
  inviteCode: 32
} as const

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
  memberCount: number
  unread: number
  lastMessageAt?: number
}

export interface ChatThread {
  id: string
  other: ChatProfile
  unread: number
  lastMessageAt?: number
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
  | { status: 'signingIn'; startedAt: number }
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
