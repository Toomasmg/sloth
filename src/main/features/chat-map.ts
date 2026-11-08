/**
 * Chat (datos): mapeo PURO de filas de Supabase a los tipos del chat y validación de los argumentos que
 * llegan por IPC. Sin Electron ni red: se prueba con Node. Las reglas espejan las de la migración
 * (supabase/migrations/0001..0003): si cambian allá, cambian acá.
 * Nunca loguea nada: lo que devuelve sí puede llevar contenido de mensajes.
 */
import {
  CHAT_LIMITS,
  type ChatConvRef,
  type ChatInvite,
  type ChatMember,
  type ChatMessageStatus,
  type ChatProfile,
  type ChatRole,
  type ChatTeam,
  type ChatThread
} from '../../shared/chat'
import {
  CHAT_COLORS,
  CHAT_LIMITS_V2,
  CHAT_MESSAGE_KINDS,
  CHAT_PRESENCE,
  CHAT_REACTIONS,
  type ChatCard,
  type ChatChannel,
  type ChatChannelInput,
  type ChatColor,
  type ChatConv,
  type ChatFile,
  type ChatFileRef,
  type ChatFileUpload,
  type ChatMessageFull,
  type ChatMessageKind,
  type ChatPerson,
  type ChatPresence,
  type ChatProfilePatch,
  type ChatQuote,
  type ChatReaction,
  type ChatReactionKind,
  type ChatSendInput,
  type ChatTeamPerson
} from './chat-model'

export const EX_MEMBER_LOGIN = 'ex-miembro'
export const DEFAULT_PAGE = 50
export const MAX_PAGE = 100
const AVATAR_PREFIX = 'https://avatars.githubusercontent.com/'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LOGIN_RE = /^[a-z0-9-]{1,39}$/
const CODE_RE = /^[0-9a-f]{16}$/
const CHANNEL_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
const HANDLE_RE = /^[a-z0-9-]{3,30}$/
const TZ_RE = /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/
const TICKET_RE = /^TCK-[0-9]{1,10}$/
const PR_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}\/(pull|issues)\/[0-9]{1,9}$/
const PATH_TEAM_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PATH_DM_RE = /^dm\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const MIME_RE = /^[a-z0-9.+-]{1,50}\/[a-z0-9.+-]{1,50}$/i

export const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Largo en caracteres como lo cuenta Postgres (code points, no unidades UTF-16). */
export const codepoints = (s: string): number => [...s].length

/** Primeros `n` caracteres (code points), con «…» si se cortó. */
export function firstChars(s: string, n: number): string {
  const cps = [...s]
  return cps.length > n ? `${cps.slice(0, n).join('')}…` : s
}

/** Primera línea, recortada a n caracteres. */
export const firstLine = (s: string, n = CHAT_LIMITS_V2.quoteChars): string => firstChars((s || '').split('\n')[0], n)

// ---------- validación de argumentos IPC (0.5) ----------

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

/** Conversación de 0.5 (team | dm). Se mantiene para los IPC viejos. */
export function parseConvRef(raw: unknown): ChatConvRef {
  if (!isObj(raw)) throw new Error('Conversación inválida.')
  const kind = raw.kind
  if (kind !== 'team' && kind !== 'dm') throw new Error('Conversación inválida.')
  return { kind, id: parseUuid(raw.id, 'Conversación inválida.') }
}

/** Conversación v2: canal, DM o el alias «team» (general del equipo). */
export function parseConv(raw: unknown): ChatConv {
  if (!isObj(raw)) throw new Error('Conversación inválida.')
  const kind = raw.kind
  if (kind !== 'channel' && kind !== 'team' && kind !== 'dm') throw new Error('Conversación inválida.')
  return { kind, id: parseUuid(raw.id, 'Conversación inválida.') }
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

// ---------- validación de argumentos IPC (v2) ----------

/** Nombre de canal: minúsculas, números y guiones; 1 a 40. */
export function parseChannelName(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('El nombre del canal tiene que ser texto.')
  const s = raw.trim().toLowerCase()
  if (!CHANNEL_RE.test(s)) throw new Error('Nombre de canal no válido: minúsculas, números y guiones (1 a 40).')
  return s
}

function textField(o: Record<string, unknown>, k: string, max: number, what: string): string | undefined {
  if (o[k] === undefined) return undefined
  if (typeof o[k] !== 'string') throw new Error(`${what} tiene que ser texto.`)
  const t = (o[k] as string).trim()
  if (codepoints(t) > max) throw new Error(`${what} tiene más de ${max} caracteres.`)
  return t
}

/** Alta (name obligatorio) o edición (parche) de un canal. */
export function parseChannelInput(raw: unknown, mode: 'create' | 'update'): Partial<ChatChannelInput> {
  if (!isObj(raw)) throw new Error('Datos del canal inválidos.')
  const allowed = new Set(['name', 'topic', 'description'])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error(`Campo no válido en el canal: «${k}».`)
  const out: Partial<ChatChannelInput> = {}
  if (raw.name !== undefined || mode === 'create') out.name = parseChannelName(raw.name)
  const topic = textField(raw, 'topic', CHAT_LIMITS_V2.channelTopic, 'El tema')
  if (topic !== undefined) out.topic = topic
  const desc = textField(raw, 'description', CHAT_LIMITS_V2.channelDescription, 'La descripción')
  if (desc !== undefined) out.description = desc
  return out
}

/** Tarjeta: ticket, espacio, PR o código. Espeja valid_chat_payload() de la base. */
export function parseCard(raw: unknown): ChatCard {
  if (!isObj(raw)) throw new Error('La tarjeta no es válida.')
  const kind = raw.kind
  const pick = (allowed: string[]): void => {
    for (const k of Object.keys(raw)) if (k !== 'kind' && !allowed.includes(k)) throw new Error(`La tarjeta tiene un campo no válido: «${k}».`)
  }
  const req = (k: string, max: number): string => {
    const v = raw[k]
    if (typeof v !== 'string') throw new Error(`La tarjeta necesita «${k}» como texto.`)
    const t = v.trim()
    if (codepoints(t) < 1 || codepoints(t) > max) throw new Error(`«${k}» tiene que tener entre 1 y ${max} caracteres.`)
    return t
  }
  const opt = (k: string, max: number): string | undefined => {
    if (raw[k] === undefined) return undefined
    if (typeof raw[k] !== 'string') throw new Error(`«${k}» tiene que ser texto.`)
    const t = (raw[k] as string).trim()
    if (codepoints(t) > max) throw new Error(`«${k}» tiene más de ${max} caracteres.`)
    return t
  }
  if (kind === 'code') {
    pick(['code', 'lang'])
    const lang = opt('lang', 20)
    return { kind, code: req('code', 4000), ...(lang ? { lang } : {}) }
  }
  if (kind === 'ticket') {
    pick(['id', 'title', 'state'])
    const id = req('id', 16)
    if (!TICKET_RE.test(id)) throw new Error('El ticket tiene que tener la forma TCK-1234.')
    const state = opt('state', 40)
    return { kind, id, title: req('title', 200), ...(state ? { state } : {}) }
  }
  if (kind === 'space') {
    pick(['name', 'sub', 'st'])
    const sub = opt('sub', 200)
    const st = opt('st', 40)
    return { kind, name: req('name', 120), ...(sub ? { sub } : {}), ...(st ? { st } : {}) }
  }
  if (kind === 'pr') {
    pick(['url', 'repo', 'prKind', 'num', 'title', 'st', 'chk'])
    const url = req('url', 300)
    if (!PR_URL_RE.test(url)) throw new Error('El link tiene que ser de un PR o issue de GitHub.')
    const out: ChatCard = { kind, url }
    const repo = opt('repo', 200)
    const prKind = opt('prKind', 40)
    const num = opt('num', 12)
    const title = opt('title', 200)
    const st = opt('st', 40)
    const chk = opt('chk', 80)
    return Object.assign(out, {
      ...(repo ? { repo } : {}),
      ...(prKind ? { prKind } : {}),
      ...(num ? { num } : {}),
      ...(title ? { title } : {}),
      ...(st ? { st } : {}),
      ...(chk ? { chk } : {})
    })
  }
  throw new Error('Tipo de tarjeta desconocido.')
}

/** Tarjeta → columnas de messages (kind + payload). El PR guarda `kind` dentro del payload como prKind. */
export function cardToRow(card: ChatCard): { kind: ChatMessageKind; payload: Record<string, string> } {
  const { kind, ...rest } = card as ChatCard & { prKind?: string }
  const payload: Record<string, string> = {}
  for (const [k, v] of Object.entries(rest)) {
    if (typeof v !== 'string') continue
    payload[k === 'prKind' ? 'kind' : k] = v
  }
  return { kind: kind as ChatMessageKind, payload }
}

/** payload de messages → tarjeta (undefined si el tipo no es de tarjeta o el payload está vacío). */
export function cardFromRow(kind: unknown, payload: unknown): ChatCard | undefined {
  if (!isObj(payload)) return undefined
  const p: Record<string, string> = {}
  for (const [k, v] of Object.entries(payload)) if (typeof v === 'string') p[k] = v
  if (kind === 'code' && p.code) return { kind, code: p.code, ...(p.lang ? { lang: p.lang } : {}) }
  if (kind === 'ticket' && p.id) return { kind, id: p.id, title: p.title ?? '', ...(p.state ? { state: p.state } : {}) }
  if (kind === 'space' && p.name) return { kind, name: p.name, ...(p.sub ? { sub: p.sub } : {}), ...(p.st ? { st: p.st } : {}) }
  if (kind === 'pr' && p.url) {
    return {
      kind,
      url: p.url,
      ...(p.repo ? { repo: p.repo } : {}),
      ...(p.kind ? { prKind: p.kind } : {}),
      ...(p.num ? { num: p.num } : {}),
      ...(p.title ? { title: p.title } : {}),
      ...(p.st ? { st: p.st } : {}),
      ...(p.chk ? { chk: p.chk } : {})
    }
  }
  return undefined
}

/** Referencia a un adjunto ya subido (ruta del bucket + metadatos). */
export function parseFileRef(raw: unknown): ChatFileRef {
  if (!isObj(raw)) throw new Error('El adjunto no es válido.')
  const path = str(raw.path)
  if (!PATH_TEAM_RE.test(path) && !PATH_DM_RE.test(path)) throw new Error('La ruta del adjunto no es válida.')
  const name = parseFileName(raw.name)
  const size = raw.size
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0 || size > CHAT_LIMITS_V2.fileBytes)
    throw new Error('El adjunto pesa más de 10 MB.')
  return { path: path.toLowerCase(), name, size, mime: parseMime(raw.mime) }
}

function parseFileName(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('El nombre del archivo tiene que ser texto.')
  const base = raw.split(/[\\/]/).pop()?.trim() ?? ''
  if (!base || codepoints(base) > CHAT_LIMITS_V2.fileName) throw new Error('El nombre del archivo no es válido.')
  return base
}

function parseMime(raw: unknown): string {
  return typeof raw === 'string' && MIME_RE.test(raw) ? raw.toLowerCase() : 'application/octet-stream'
}

/** Subida de adjunto: nombre saneado, base64 y tope de tamaño (antes de tocar la red). */
export function parseFileUpload(raw: unknown): { name: string; mime: string; bytes: Buffer } {
  if (!isObj(raw)) throw new Error('El adjunto no es válido.')
  const name = parseFileName(raw.name)
  const b64 = raw.base64
  if (typeof b64 !== 'string' || b64.length === 0 || b64.length % 4 !== 0 || !B64_RE.test(b64))
    throw new Error('El adjunto no es válido.')
  if (b64.length > Math.ceil(CHAT_LIMITS_V2.fileBytes / 3) * 4) throw new Error('El adjunto pesa más de 10 MB.')
  const bytes = Buffer.from(b64, 'base64')
  if (bytes.length === 0) throw new Error('El adjunto está vacío.')
  if (bytes.length > CHAT_LIMITS_V2.fileBytes) throw new Error('El adjunto pesa más de 10 MB.')
  return { name, mime: parseMime(raw.mime), bytes }
}

/** Envío v2. Tiene que traer texto, tarjeta o adjuntos; tarjeta y adjuntos no van juntos. */
export function parseSendInput(raw: unknown): {
  conv: ChatConv
  clientId: string
  body: string
  card?: ChatCard
  replyTo?: string
  threadRoot?: string
  files: ChatFileRef[]
} {
  if (!isObj(raw)) throw new Error('El mensaje no es válido.')
  const allowed = new Set(['conv', 'clientId', 'body', 'card', 'replyTo', 'threadRoot', 'files'])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error(`Campo no válido en el mensaje: «${k}».`)
  const conv = parseConv(raw.conv)
  const clientId = parseClientId(raw.clientId)
  let body = ''
  if (raw.body !== undefined && raw.body !== null) {
    if (typeof raw.body !== 'string') throw new Error('El mensaje tiene que ser texto.')
    body = raw.body.trim()
    if (codepoints(body) > CHAT_LIMITS.body) throw new Error(`El mensaje tiene más de ${CHAT_LIMITS.body} caracteres.`)
  }
  const card = raw.card === undefined || raw.card === null ? undefined : parseCard(raw.card)
  let files: ChatFileRef[] = []
  if (raw.files !== undefined && raw.files !== null) {
    if (!Array.isArray(raw.files) || raw.files.length > 10) throw new Error('Podés adjuntar hasta 10 archivos.')
    files = raw.files.map(parseFileRef)
  }
  if (card && files.length) throw new Error('Una tarjeta no puede llevar adjuntos.')
  if (!body && !card && files.length === 0) throw new Error('El mensaje está vacío.')
  return {
    conv,
    clientId,
    body,
    ...(card ? { card } : {}),
    ...(raw.replyTo !== undefined && raw.replyTo !== null ? { replyTo: parseUuid(raw.replyTo, 'Mensaje citado inválido.') } : {}),
    ...(raw.threadRoot !== undefined && raw.threadRoot !== null ? { threadRoot: parseUuid(raw.threadRoot, 'Hilo inválido.') } : {}),
    files
  }
}

/** Tipo de mensaje que va a la columna `kind` según lo que trae. */
export function messageKindOf(input: { card?: ChatCard; files: ChatFileRef[] }): ChatMessageKind {
  if (input.card) return input.card.kind
  return input.files.length ? 'file' : 'text'
}

export function parseReaction(raw: unknown): ChatReactionKind {
  if (typeof raw !== 'string' || !(CHAT_REACTIONS as readonly string[]).includes(raw)) throw new Error('Reacción no válida.')
  return raw as ChatReactionKind
}

export function parseBool(raw: unknown, what = 'Valor inválido.'): boolean {
  if (typeof raw !== 'boolean') throw new Error(what)
  return raw
}

/**
 * Parche de perfil → objeto para update_profile(p_patch jsonb). Solo viene lo que se cambia.
 * Validación igual a la de la base (que también valida).
 */
export function parseProfilePatch(raw: unknown): Record<string, unknown> {
  if (!isObj(raw)) throw new Error('Datos de perfil inválidos.')
  const out: Record<string, unknown> = {}
  const has = (k: string): boolean => raw[k] !== undefined
  if (has('displayName')) {
    const v = raw.displayName
    if (typeof v !== 'string') throw new Error('El nombre tiene que ser texto.')
    const t = v.trim()
    if (codepoints(t) < 1 || codepoints(t) > CHAT_LIMITS_V2.displayName) throw new Error(`El nombre tiene entre 1 y ${CHAT_LIMITS_V2.displayName} caracteres.`)
    out.display_name = t
  }
  if (has('handle')) {
    const v = raw.handle
    if (typeof v !== 'string' || !HANDLE_RE.test(v)) throw new Error('El usuario tiene entre 3 y 30 caracteres: minúsculas, números y guiones.')
    out.handle = v
  }
  if (has('color')) {
    if (typeof raw.color !== 'string' || !(CHAT_COLORS as readonly string[]).includes(raw.color)) throw new Error('Color no válido.')
    out.color = raw.color
  }
  if (has('presence')) {
    if (typeof raw.presence !== 'string' || !(CHAT_PRESENCE as readonly string[]).includes(raw.presence)) throw new Error('Estado no válido.')
    out.presence = raw.presence
  }
  if (has('statusText')) {
    if (typeof raw.statusText !== 'string') throw new Error('El texto de estado tiene que ser texto.')
    const t = raw.statusText.trim()
    if (codepoints(t) > CHAT_LIMITS_V2.statusText) throw new Error(`El texto de estado tiene más de ${CHAT_LIMITS_V2.statusText} caracteres.`)
    out.status_text = t
  }
  if (has('statusUntil')) {
    const v = raw.statusUntil
    if (v === null) out.status_until = null
    else if (typeof v === 'number' && Number.isFinite(v)) out.status_until = new Date(v).toISOString()
    else throw new Error('El vencimiento del estado no es válido.')
  }
  if (has('roleTitle')) {
    if (typeof raw.roleTitle !== 'string') throw new Error('El puesto tiene que ser texto.')
    const t = raw.roleTitle.trim()
    if (codepoints(t) > CHAT_LIMITS_V2.roleTitle) throw new Error(`El puesto tiene más de ${CHAT_LIMITS_V2.roleTitle} caracteres.`)
    out.role_title = t
  }
  if (has('timezone')) {
    const v = raw.timezone
    if (typeof v !== 'string' || v.length > CHAT_LIMITS_V2.timezone || !TZ_RE.test(v)) throw new Error('Zona horaria no válida.')
    out.timezone = v
  }
  for (const k of Object.keys(raw)) {
    if (!['displayName', 'handle', 'color', 'presence', 'statusText', 'statusUntil', 'roleTitle', 'timezone'].includes(k))
      throw new Error(`Campo de perfil no válido: «${k}».`)
  }
  return out
}

/** Avatares de GitHub solamente (la CSP de la UI lo permite y no hay otra URL). */
export function avatarOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.startsWith(AVATAR_PREFIX) && v.length < 500 ? v : undefined
}

/** Ruta de foto de perfil: <uuid>/<uuid>.(webp|png|jpg) dentro del bucket profile-photos. */
export const PROFILE_PHOTO_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|png|jpg)$/i

// ---------- filas → tipos ----------

/** Perfil de GitHub (0.5). Si el perfil no se puede leer (ex miembro), se usa `exMemberProfile`. */
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

/** Persona con perfil v2. `photoPath` queda para que chat-data baje la foto (no va en el objeto). */
export interface PersonRow {
  person: ChatPerson
  photoPath?: string
}

export function personFromRow(row: unknown): PersonRow | undefined {
  if (!isObj(row) || typeof row.id !== 'string' || !row.id) return undefined
  if (typeof row.login !== 'string' || !row.login) return undefined
  const color = (CHAT_COLORS as readonly string[]).includes(str(row.color)) ? (row.color as ChatColor) : 'blue'
  const presence = (CHAT_PRESENCE as readonly string[]).includes(str(row.presence)) ? (row.presence as ChatPresence) : 'disponible'
  const displayName = str(row.display_name) || undefined
  const name = str(row.name) || undefined
  const statusText = str(row.status_text) || undefined
  const until = toMs(row.status_until)
  const roleTitle = str(row.role_title) || undefined
  const photoPath = str(row.photo_path) || undefined
  const avatarUrl = avatarOf(row.avatar_url)
  const person: ChatPerson = {
    id: row.id,
    login: row.login,
    handle: str(row.handle) || row.login.toLowerCase(),
    color,
    presence,
    timezone: str(row.timezone) || 'America/Argentina/Buenos_Aires',
    ...(displayName ? { displayName } : {}),
    ...(name ? { name } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(statusText ? { statusText } : {}),
    ...(until !== undefined ? { statusUntil: until } : {}),
    ...(roleTitle ? { roleTitle } : {})
  }
  return photoPath ? { person, photoPath } : { person }
}

/** Perfil de 0.5 (para los campos de ChatProfile del contrato viejo). */
export function profileOfPerson(p: ChatPerson): ChatProfile {
  const name = p.displayName ?? p.name
  return { id: p.id, login: p.login, ...(name ? { name } : {}), ...(p.avatarUrl ? { avatarUrl: p.avatarUrl } : {}) }
}

/** ISO de Postgres (con microsegundos) → ms epoch. undefined si no se puede leer. */
export function toMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? undefined : ms
}

export const roleOf = (v: unknown): ChatRole | undefined => (v === 'owner' || v === 'admin' || v === 'member' ? v : undefined)

/** Fila de messages (con las columnas de 0.5 y de v2). */
export interface MessageRow {
  id: unknown
  client_id: unknown
  team_id?: unknown
  thread_id?: unknown
  channel_id?: unknown
  author_id: unknown
  body: unknown
  created_at: unknown
  kind?: unknown
  payload?: unknown
  reply_to?: unknown
  thread_root?: unknown
  reply_count?: unknown
  last_reply_at?: unknown
  edited_at?: unknown
  deleted_at?: unknown
  pinned_at?: unknown
  pinned_by?: unknown
}

/** Columnas que se piden de messages (lista única para todas las consultas). */
export const MSG_COLS =
  'id, client_id, team_id, thread_id, channel_id, author_id, body, created_at, kind, payload, reply_to, thread_root, reply_count, last_reply_at, edited_at, deleted_at, pinned_at, pinned_by'

/** Canal o DM de la fila. Un mensaje de equipo sin canal (no debería existir tras 0003) cae en «team». */
export function convOfRow(row: { team_id?: unknown; thread_id?: unknown; channel_id?: unknown }): ChatConv | undefined {
  if (typeof row.channel_id === 'string' && row.channel_id) return { kind: 'channel', id: row.channel_id }
  if (typeof row.team_id === 'string' && row.team_id) return { kind: 'team', id: row.team_id }
  if (typeof row.thread_id === 'string' && row.thread_id) return { kind: 'dm', id: row.thread_id }
  return undefined
}

export interface MessageExtras {
  status?: ChatMessageStatus
  reactions?: ChatReaction[]
  files?: ChatFile[]
  replyTo?: ChatQuote
}

/** Mensaje completo. Sin extras, reacciones y adjuntos vienen vacíos (lo que trae el INSERT en Realtime). */
export function messageFromRow(row: MessageRow, author: ChatProfile, extras: MessageExtras = {}): ChatMessageFull | undefined {
  const conv = convOfRow(row)
  const id = str(row.id)
  if (!conv || !id) return undefined
  const deleted = row.deleted_at !== undefined && row.deleted_at !== null
  const kind = (CHAT_MESSAGE_KINDS as readonly string[]).includes(str(row.kind)) ? (str(row.kind) as ChatMessageKind) : 'text'
  const card = deleted ? undefined : cardFromRow(kind, row.payload)
  const threadRoot = str(row.thread_root) || undefined
  const replyTo = extras.replyTo
  const lastReply = toMs(row.last_reply_at)
  const edited = toMs(row.edited_at)
  const deletedAt = toMs(row.deleted_at)
  const pinned = toMs(row.pinned_at)
  const pinnedBy = str(row.pinned_by) || undefined
  return {
    id,
    clientId: str(row.client_id),
    conv,
    author,
    authorId: str(row.author_id),
    body: deleted ? '' : str(row.body),
    createdAt: toMs(row.created_at) ?? 0,
    status: extras.status ?? 'sent',
    kind,
    ...(card ? { card } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(threadRoot ? { threadRoot } : {}),
    replyCount: typeof row.reply_count === 'number' ? row.reply_count : 0,
    ...(lastReply !== undefined ? { lastReplyAt: lastReply } : {}),
    ...(edited !== undefined ? { editedAt: edited } : {}),
    ...(deletedAt !== undefined ? { deletedAt } : {}),
    ...(pinned !== undefined ? { pinnedAt: pinned } : {}),
    ...(pinnedBy ? { pinnedBy } : {}),
    reactions: deleted ? [] : (extras.reactions ?? []),
    files: deleted ? [] : (extras.files ?? [])
  }
}

/** Cita: primera línea del mensaje citado. Si está borrado, lo dice. */
export function quoteFromRow(row: MessageRow): ChatQuote | undefined {
  const id = str(row.id)
  if (!id) return undefined
  const deleted = row.deleted_at !== undefined && row.deleted_at !== null
  return { id, authorId: str(row.author_id), text: deleted ? '' : firstLine(str(row.body)), deleted }
}

/** Reacciones de varios mensajes → índice por message_id (en el orden del contrato). */
export function reactionsByMessage(rows: readonly unknown[]): Map<string, ChatReaction[]> {
  const acc = new Map<string, Map<ChatReactionKind, string[]>>()
  for (const r of rows) {
    if (!isObj(r)) continue
    const mid = str(r.message_id)
    const uid = str(r.user_id)
    const kind = r.kind
    if (!mid || !uid || typeof kind !== 'string' || !(CHAT_REACTIONS as readonly string[]).includes(kind)) continue
    const per = acc.get(mid) ?? new Map<ChatReactionKind, string[]>()
    const list = per.get(kind as ChatReactionKind) ?? []
    list.push(uid)
    per.set(kind as ChatReactionKind, list)
    acc.set(mid, per)
  }
  const out = new Map<string, ChatReaction[]>()
  for (const [mid, per] of acc) {
    out.set(
      mid,
      CHAT_REACTIONS.filter((k) => per.has(k)).map((k) => ({ kind: k, userIds: per.get(k) ?? [] }))
    )
  }
  return out
}

/** Fila de message_files → adjunto. */
export function fileFromRow(row: unknown): ChatFile | undefined {
  if (!isObj(row)) return undefined
  const id = str(row.id)
  const messageId = str(row.message_id)
  const path = str(row.path)
  if (!id || !messageId || !path) return undefined
  const size = typeof row.size_bytes === 'number' ? row.size_bytes : 0
  return {
    id,
    messageId,
    name: str(row.name) || 'archivo',
    size,
    mime: parseMime(row.mime),
    path,
    createdAt: toMs(row.created_at) ?? 0
  }
}

export function filesByMessage(rows: readonly unknown[]): Map<string, ChatFile[]> {
  const out = new Map<string, ChatFile[]>()
  for (const r of rows) {
    const f = fileFromRow(r)
    if (!f) continue
    out.set(f.messageId, [...(out.get(f.messageId) ?? []), f])
  }
  return out
}

export interface ChannelRow {
  id: unknown
  team_id: unknown
  name: unknown
  topic?: unknown
  description?: unknown
  is_default?: unknown
  created_at?: unknown
}

export interface ChannelInfo {
  unread: number
  muted: boolean
  lastMessageAt?: number
}

export function channelFromRow(row: ChannelRow, info: ChannelInfo): ChatChannel | undefined {
  const id = str(row.id)
  const teamId = str(row.team_id)
  const name = str(row.name)
  if (!id || !teamId || !name) return undefined
  return {
    id,
    teamId,
    name,
    topic: str(row.topic),
    description: str(row.description),
    isDefault: row.is_default === true,
    unread: info.unread,
    muted: info.muted,
    ...(info.lastMessageAt !== undefined ? { lastMessageAt: info.lastMessageAt } : {}),
    createdAt: toMs(row.created_at) ?? 0
  }
}

export interface TeamRow {
  id: unknown
  name: unknown
  description?: unknown
  photo_path?: unknown
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
  created_at?: unknown
}

/** El otro participante de un DM, o undefined si el usuario no es participante. */
export function otherOf(row: ThreadRow, meId: string): string | undefined {
  const a = str(row.user_a)
  const b = str(row.user_b)
  if (a === meId) return b || undefined
  if (b === meId) return a || undefined
  return undefined
}

export function threadFromRow(row: ThreadRow, other: ChatProfile, info: { unread: number; lastMessageAt?: number }): ChatThread | undefined {
  const id = str(row.id)
  if (!id) return undefined
  const t: ChatThread = { id, other, unread: info.unread }
  if (info.lastMessageAt !== undefined) t.lastMessageAt = info.lastMessageAt
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

export function teamPersonOf(person: ChatPerson, role: ChatRole, joinedAt: number): ChatTeamPerson {
  return { ...person, role, joinedAt }
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
  muted: boolean
  lastMessageAt?: number
}

/** Filas de chat_unread() → índice por «kind:id» (canal o DM). Cuenta hasta 99. */
export function unreadIndex(rows: readonly unknown[]): Map<string, UnreadInfo> {
  const out = new Map<string, UnreadInfo>()
  for (const r of rows) {
    if (!isObj(r)) continue
    const kind = r.kind
    const id = str(r.id)
    if ((kind !== 'channel' && kind !== 'dm') || !id) continue
    const unread = typeof r.unread === 'number' && r.unread > 0 ? Math.min(99, Math.floor(r.unread)) : 0
    const info: UnreadInfo = { unread, muted: r.muted === true }
    const last = toMs(r.last_at)
    if (last !== undefined) info.lastMessageAt = last
    out.set(`${kind}:${id}`, info)
  }
  return out
}

/** Orden viejo → nuevo a partir de filas en orden desc (order desc + limit). */
export function oldestFirst<T>(rowsDesc: readonly T[]): T[] {
  return rowsDesc.slice().reverse()
}

export function sameConv(a: ChatConv, b: ChatConv): boolean {
  return a.kind === b.kind && a.id === b.id
}

/** Conversación normalizada: «team» pasa a ser el canal general (lo resuelve el llamador). */
export function isChannelConv(c: ChatConv): boolean {
  return c.kind === 'channel' || c.kind === 'team'
}

/** Vista de la interfaz: qué conversación tiene abierta (para no leídos y avisos). */
export type ChatViewV2 = { open: false } | { open: true; conv?: ChatConv }

export function parseViewV2(raw: unknown): ChatViewV2 {
  if (!isObj(raw) || typeof raw.open !== 'boolean') throw new Error('Vista inválida.')
  if (!raw.open) return { open: false }
  if (raw.conv === undefined || raw.conv === null) return { open: true }
  return { open: true, conv: parseConv(raw.conv) }
}
