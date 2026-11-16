/**
 * Chat (datos): mapeo PURO de filas de Supabase a los tipos de shared/chat.ts y validación de los
 * argumentos que llegan por IPC. Sin Electron ni red: se prueba con Node.
 * Nunca loguea nada: lo que devuelve sí puede llevar contenido de mensajes.
 */
import {
  CHAT_LIMITS,
  CHAT_REACTIONS,
  convKey,
  type ChatConvRef,
  type ChatInvite,
  type ChatMember,
  type ChatMessage,
  type ChatMessageStatus,
  type ChatProfile,
  type ChatReaction,
  type ChatReactionEmoji,
  type ChatReplyRef,
  type ChatRole,
  type ChatTeam,
  type ChatThread,
  type ChatView
} from '../../shared/chat'
import { noticeFromRow, retentionOf } from '../../shared/chat-retention'

export const EX_MEMBER_LOGIN = 'ex-miembro'
export const DEFAULT_PAGE = 50
export const MAX_PAGE = 100
const AVATAR_PREFIX = 'https://avatars.githubusercontent.com/'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LOGIN_RE = /^[a-z0-9-]{1,39}$/
const CODE_RE = /^[0-9a-f]{16}$/

export const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Largo en caracteres como lo cuenta Postgres (code points, no unidades UTF-16). */
export const codepoints = (s: string): number => [...s].length

/** Primeros `n` caracteres (code points), con «…» si se cortó. */
export function firstChars(s: string, n: number): string {
  const cps = [...s]
  return cps.length > n ? `${cps.slice(0, n).join('')}…` : s
}

// ---------- validación de argumentos IPC ----------

export function parseUuid(raw: unknown, what = 'Identificador inválido.'): string {
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) throw new Error(what)
  return raw.toLowerCase()
}

/** clientId de «enviar»: uuid v4, lo genera la UI. */
export function parseClientId(raw: unknown): string {
  if (typeof raw !== 'string' || !UUID_V4_RE.test(raw)) throw new Error('Identificador de envío inválido.')
  return raw.toLowerCase()
}

/** Usuario de GitHub sin @: se normaliza a minúsculas (así se guarda la invitación). */
export function parseLogin(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Escribí un usuario de GitHub.')
  const s = raw.trim().toLowerCase()
  if (!LOGIN_RE.test(s)) throw new Error('Usuario de GitHub no válido. Solo letras, números y guiones, sin @.')
  return s
}

export function parseInviteCode(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Código inválido.')
  const s = raw.trim().toLowerCase()
  if (!CODE_RE.test(s)) throw new Error('Código inválido. Son 16 caracteres hexadecimales.')
  return s
}

export function parseConvRef(raw: unknown): ChatConvRef {
  if (!isObj(raw)) throw new Error('Conversación inválida.')
  const kind = raw.kind
  if (kind !== 'team' && kind !== 'dm') throw new Error('Conversación inválida.')
  return { kind, id: parseUuid(raw.id, 'Conversación inválida.') }
}

export function parseView(raw: unknown): ChatView {
  if (!isObj(raw) || typeof raw.open !== 'boolean') throw new Error('Vista inválida.')
  if (!raw.open) return { open: false }
  if (raw.conv === undefined || raw.conv === null) return { open: true }
  return { open: true, conv: parseConvRef(raw.conv) }
}

/** Id opcional (por ejemplo, el mensaje al que se responde): null o ausente → undefined. */
export function parseOptionalUuid(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  return parseUuid(raw)
}

export const isReactionEmoji = (v: unknown): v is ChatReactionEmoji =>
  typeof v === 'string' && (CHAT_REACTIONS as readonly string[]).includes(v)

export function parseEmoji(raw: unknown): ChatReactionEmoji {
  if (!isReactionEmoji(raw)) throw new Error('Reacción inválida.')
  return raw
}

export function parseSearch(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Escribí al menos 2 letras.')
  const t = raw.trim()
  const n = codepoints(t)
  if (n < 2) throw new Error('Escribí al menos 2 letras.')
  if (n > CHAT_LIMITS.searchQuery) throw new Error(`La búsqueda tiene más de ${CHAT_LIMITS.searchQuery} caracteres.`)
  return t
}

/** Tamaño de página: por defecto 50, entre 1 y 100. */
export function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_PAGE
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error('Límite inválido.')
  return Math.min(MAX_PAGE, Math.max(1, Math.floor(raw)))
}

/** Cuerpo de mensaje: se recorta espacios y tiene que quedar entre 1 y CHAT_LIMITS.body caracteres. */
export function parseBody(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('El mensaje tiene que ser texto.')
  const t = raw.trim()
  const n = codepoints(t)
  if (n < 1) throw new Error('El mensaje está vacío.')
  if (n > CHAT_LIMITS.body) throw new Error(`El mensaje tiene más de ${CHAT_LIMITS.body} caracteres.`)
  return t
}

export interface TeamFieldsRaw {
  name?: string
  description?: string
  /** undefined = no tocar; null = quitar foto; string = base64 sin prefijo (se decodifica en chat-photos). */
  photoBase64?: string | null
}

/**
 * Valida el alta o la edición de un equipo. `create` exige nombre; `update` acepta un parche.
 * No deja pasar claves desconocidas.
 */
export function parseTeamFields(raw: unknown, mode: 'create' | 'update'): TeamFieldsRaw {
  if (!isObj(raw)) throw new Error('Datos del equipo inválidos.')
  const allowed = new Set(['name', 'description', 'photoBase64'])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error(`Campo no válido en el equipo: «${k}».`)
  const out: TeamFieldsRaw = {}
  if (raw.name !== undefined || mode === 'create') {
    if (typeof raw.name !== 'string') throw new Error('El nombre del equipo tiene que ser texto.')
    const n = raw.name.trim()
    const len = codepoints(n)
    if (len < 1 || len > CHAT_LIMITS.teamName) throw new Error(`El nombre tiene que tener entre 1 y ${CHAT_LIMITS.teamName} caracteres.`)
    out.name = n
  }
  if (raw.description !== undefined || mode === 'create') {
    const d = raw.description === undefined ? '' : raw.description
    if (typeof d !== 'string') throw new Error('La descripción tiene que ser texto.')
    const t = d.trim()
    if (codepoints(t) > CHAT_LIMITS.teamDescription)
      throw new Error(`La descripción tiene más de ${CHAT_LIMITS.teamDescription} caracteres.`)
    out.description = t
  }
  if (raw.photoBase64 !== undefined) {
    if (raw.photoBase64 !== null && typeof raw.photoBase64 !== 'string') throw new Error('La foto tiene que venir en base64.')
    out.photoBase64 = raw.photoBase64
  }
  return out
}

// ---------- filas → tipos de shared/chat.ts ----------

/** Perfil de GitHub. Si el perfil no se puede leer (ex miembro), se usa `exMemberProfile`. */
export function profileFromRow(row: unknown): ChatProfile | undefined {
  if (!isObj(row) || typeof row.id !== 'string' || !row.id) return undefined
  if (typeof row.login !== 'string' || !row.login) return undefined
  const name = typeof row.name === 'string' && row.name ? row.name.slice(0, 255) : undefined
  const avatarUrl = avatarOf(row.avatar_url)
  return {
    id: row.id,
    login: row.login,
    ...(name ? { name } : {}),
    ...(avatarUrl ? { avatarUrl } : {})
  }
}

export const exMemberProfile = (id: string): ChatProfile => ({ id, login: EX_MEMBER_LOGIN })

/** Solo avatares de GitHub: la CSP de la UI lo permite y no hay otra URL. */
export function avatarOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.startsWith(AVATAR_PREFIX) && v.length < 500 ? v : undefined
}

/** ISO de Postgres (con microsegundos) → ms epoch. undefined si no se puede leer. */
export function toMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? undefined : ms
}

export const roleOf = (v: unknown): ChatRole | undefined => (v === 'owner' || v === 'admin' || v === 'member' ? v : undefined)

export interface MessageRow {
  id: unknown
  client_id: unknown
  team_id?: unknown
  thread_id?: unknown
  author_id: unknown
  body: unknown
  created_at: unknown
  edited_at?: unknown
  deleted_at?: unknown
  reply_to?: unknown
  kind?: unknown
  via?: unknown
}

export const MSG_COLS_BASE = 'id, client_id, team_id, thread_id, author_id, body, created_at'
/** Solo con la 0004 aplicada: pedir columnas que no existen hace fallar toda la consulta. */
export const MSG_COLS_EXTRAS = `${MSG_COLS_BASE}, edited_at, deleted_at, reply_to, kind`

export function convOfRow(row: { team_id?: unknown; thread_id?: unknown }): ChatConvRef | undefined {
  if (typeof row.team_id === 'string' && row.team_id) return { kind: 'team', id: row.team_id }
  if (typeof row.thread_id === 'string' && row.thread_id) return { kind: 'dm', id: row.thread_id }
  return undefined
}

export function messageFromRow(row: MessageRow, author: ChatProfile, status: ChatMessageStatus = 'sent'): ChatMessage | undefined {
  const conv = convOfRow(row)
  const id = str(row.id)
  if (!conv || !id) return undefined
  const deletedAt = toMs(row.deleted_at)
  const editedAt = toMs(row.edited_at)
  const msg: ChatMessage = {
    id,
    clientId: str(row.client_id),
    conv,
    author,
    body: deletedAt === undefined ? str(row.body) : '',
    createdAt: toMs(row.created_at) ?? 0,
    status
  }
  if (editedAt !== undefined) msg.editedAt = editedAt
  if (deletedAt !== undefined) msg.deletedAt = deletedAt
  const notice = noticeFromRow(row.kind, row.body)
  if (notice) msg.notice = notice
  if (row.via === 'claude') msg.via = 'claude'
  return msg
}

/** Referencia al mensaje respondido: un extracto de una línea, vacío si se borró. */
export function replyRefFrom(
  row: { id: unknown; author_id: unknown; body: unknown; deleted_at?: unknown },
  login: string
): ChatReplyRef | undefined {
  const id = str(row.id)
  if (!id) return undefined
  const deleted = toMs(row.deleted_at) !== undefined
  const flat = str(row.body).replace(/\s+/g, ' ').trim()
  return { id, authorLogin: login, excerpt: deleted ? '' : firstChars(flat, CHAT_LIMITS.replyExcerpt), deleted }
}

/** Filas de message_reactions → reacciones por mensaje, en el orden de CHAT_REACTIONS. */
export function reactionsByMessage(
  rows: ReadonlyArray<{ message_id: unknown; user_id: unknown; emoji: unknown }>,
  loginOf: (id: string) => string
): Map<string, ChatReaction[]> {
  const grouped = new Map<string, Map<ChatReactionEmoji, string[]>>()
  for (const r of rows) {
    const mid = str(r.message_id)
    const uid = str(r.user_id)
    if (!mid || !uid || !isReactionEmoji(r.emoji)) continue
    let byEmoji = grouped.get(mid)
    if (!byEmoji) {
      byEmoji = new Map()
      grouped.set(mid, byEmoji)
    }
    const users = byEmoji.get(r.emoji) ?? []
    if (!users.includes(uid)) users.push(uid)
    byEmoji.set(r.emoji, users)
  }
  const out = new Map<string, ChatReaction[]>()
  for (const [mid, byEmoji] of grouped) {
    const list: ChatReaction[] = []
    for (const emoji of CHAT_REACTIONS) {
      const userIds = byEmoji.get(emoji)
      if (userIds) list.push({ emoji, userIds, logins: userIds.map(loginOf) })
    }
    out.set(mid, list)
  }
  return out
}

/** Postgres devuelve «más nuevo primero» (order desc + limit). La UI quiere viejo → nuevo. */
export function oldestFirst<T>(rowsDesc: readonly T[]): T[] {
  return rowsDesc.slice().reverse()
}

export interface TeamRow {
  id: unknown
  name: unknown
  description?: unknown
  photo_path?: unknown
  retention_hours?: unknown
}

export interface TeamInfo {
  role: ChatRole
  memberCount: number
  unread: number
  lastMessageAt?: number
  /** Solo para owner/admin (la RLS ya lo filtra). */
  inviteCode?: string
}

export function teamFromRow(row: TeamRow, info: TeamInfo): ChatTeam | undefined {
  const id = str(row.id)
  const name = str(row.name)
  if (!id || !name) return undefined
  const team: ChatTeam = {
    id,
    name,
    description: str(row.description),
    role: info.role,
    memberCount: info.memberCount,
    unread: info.unread
  }
  if (info.lastMessageAt !== undefined) team.lastMessageAt = info.lastMessageAt
  const retention = retentionOf(row.retention_hours)
  if (retention !== undefined) team.retentionHours = retention
  if (info.inviteCode && (info.role === 'owner' || info.role === 'admin')) team.inviteCode = info.inviteCode
  return team
}

/** Ruta de la foto dentro del bucket (sin validar el formato: lo hace chat-photos). */
export function photoPathOf(row: TeamRow): string | undefined {
  const p = str(row.photo_path)
  return p ? p : undefined
}

export interface ThreadRow {
  id: unknown
  user_a: unknown
  user_b: unknown
  last_read_a?: unknown
  last_read_b?: unknown
}

/** Hasta cuándo leyó el otro participante del DM. */
export function otherReadAt(row: ThreadRow, meId: string): number | undefined {
  if (str(row.user_a) === meId) return toMs(row.last_read_b)
  if (str(row.user_b) === meId) return toMs(row.last_read_a)
  return undefined
}

/** El otro participante de un DM, o undefined si el usuario no es participante. */
export function otherOf(row: ThreadRow, meId: string): string | undefined {
  const a = str(row.user_a)
  const b = str(row.user_b)
  if (a === meId) return b || undefined
  if (b === meId) return a || undefined
  return undefined
}

export function threadFromRow(row: ThreadRow, other: ChatProfile, info: { unread: number; lastMessageAt?: number; otherReadAt?: number }): ChatThread | undefined {
  const id = str(row.id)
  if (!id) return undefined
  const t: ChatThread = { id, other, unread: info.unread }
  if (info.lastMessageAt !== undefined) t.lastMessageAt = info.lastMessageAt
  if (info.otherReadAt !== undefined) t.otherReadAt = info.otherReadAt
  return t
}

export interface InviteRow {
  id: unknown
  team_id: unknown
  invited_by?: unknown
  created_at: unknown
}

export function inviteFromRow(row: InviteRow, teamName: string, invitedBy?: ChatProfile): ChatInvite | undefined {
  const id = str(row.id)
  const teamId = str(row.team_id)
  if (!id || !teamId || !teamName) return undefined
  const inv: ChatInvite = { id, teamId, teamName, createdAt: toMs(row.created_at) ?? 0 }
  if (invitedBy) inv.invitedBy = invitedBy
  return inv
}

export function memberFromRow(row: { user_id: unknown; role: unknown; joined_at: unknown }, profile: ChatProfile): ChatMember | undefined {
  const role = roleOf(row.role)
  if (!role) return undefined
  return { profile, role, joinedAt: toMs(row.joined_at) ?? 0 }
}

const RANK: Record<ChatRole, number> = { owner: 0, admin: 1, member: 2 }

/** Owner primero, después admins, después miembros; dentro de cada rol, por usuario. */
export function compareMembers(a: ChatMember, b: ChatMember): number {
  return RANK[a.role] - RANK[b.role] || a.profile.login.toLowerCase().localeCompare(b.profile.login.toLowerCase())
}

/** Orden de las listas: lo último con actividad arriba; sin actividad, por nombre. */
export function sortByActivity<T extends { lastMessageAt?: number }>(list: T[], label: (t: T) => string): T[] {
  return list.sort((a, b) => {
    const la = a.lastMessageAt ?? -Infinity
    const lb = b.lastMessageAt ?? -Infinity
    if (la !== lb) return lb > la ? 1 : -1
    return label(a).localeCompare(label(b), 'es')
  })
}

export interface UnreadInfo {
  unread: number
  lastMessageAt?: number
}

/** Filas de unread_counts() → índice por convKey. */
export function unreadIndex(rows: readonly unknown[]): Map<string, UnreadInfo> {
  const out = new Map<string, UnreadInfo>()
  for (const r of rows) {
    if (!isObj(r)) continue
    const kind = r.kind
    const id = str(r.id)
    if ((kind !== 'team' && kind !== 'dm') || !id) continue
    const unread = typeof r.unread === 'number' && r.unread > 0 ? Math.min(99, Math.floor(r.unread)) : 0
    const info: UnreadInfo = { unread }
    const last = toMs(r.last_at)
    if (last !== undefined) info.lastMessageAt = last
    out.set(convKey({ kind, id }), info)
  }
  return out
}

export function sameConv(a: ChatConvRef, b: ChatConvRef): boolean {
  return a.kind === b.kind && a.id === b.id
}
