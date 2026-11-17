/**
 * Chat (entrega rápida): tópicos de Broadcast por conversación, validación de lo que llega por ahí y
 * dedupe entre los dos caminos (broadcast y postgres_changes). Puro: se prueba con Node.
 *
 * Lo que llega por broadcast es dato no confiable aunque lo publique la base: se valida la forma
 * completa y que la conversación de la fila sea la del tópico por el que llegó.
 */
import { CHAT_LIMITS, type ChatConvRef, type ChatReactionEmoji } from '../../shared/chat'
import { codepoints, isObj, isReactionEmoji, type MessageRow } from './chat-map'

/** Nombre del evento que manda el trigger de 0003_realtime_broadcast.sql. */
export const BROADCAST_EVENT = 'message'
/** Eventos de 0004_chat_completo.sql. */
export const UPDATE_EVENT = 'message_update'
export const REACTION_EVENT = 'reaction'
export const TYPING_EVENT = 'typing'
export const READ_EVENT = 'read'
export const MEMBER_REMOVED_EVENT = 'member_removed'
/** Realtime corta en 100 canales por conexión; uno queda para «sloth-inbox» y el resto de margen. */
export const MAX_TOPICS = 90
export const SEEN_MAX = 2000
export const TYPING_MIN_MS = 3000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TOPIC_RE = /^(team|thread):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)
const isDate = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))

export function topicOf(conv: ChatConvRef): string {
  return `${conv.kind === 'team' ? 'team' : 'thread'}:${conv.id.toLowerCase()}`
}

export function convOfTopic(topic: string): ChatConvRef | undefined {
  const m = TOPIC_RE.exec(topic)
  if (!m) return undefined
  return { kind: m[1] === 'team' ? 'team' : 'dm', id: m[2] }
}

interface Conv {
  id: string
  lastMessageAt?: number
}

/** Tópicos a escuchar: equipos y DMs, los más activos primero, hasta `max` (el resto queda con postgres_changes). */
export function wantedTopics(teams: readonly Conv[], threads: readonly Conv[], max = MAX_TOPICS): string[] {
  const all = [
    ...teams.map((t) => ({ topic: topicOf({ kind: 'team', id: t.id }), at: t.lastMessageAt ?? 0 })),
    ...threads.map((t) => ({ topic: topicOf({ kind: 'dm', id: t.id }), at: t.lastMessageAt ?? 0 }))
  ].filter((x) => convOfTopic(x.topic) !== undefined)
  all.sort((a, b) => b.at - a.at)
  return [...new Set(all.map((x) => x.topic))].slice(0, Math.max(0, max))
}

export function diffTopics(current: Iterable<string>, wanted: readonly string[]): { add: string[]; remove: string[] } {
  const cur = new Set(current)
  const want = new Set(wanted)
  return { add: wanted.filter((t) => !cur.has(t)), remove: [...cur].filter((t) => !want.has(t)) }
}

/**
 * Payload de broadcast → fila de `messages`, o undefined si no tiene la forma exacta o si es de
 * otra conversación que la del tópico.
 */
export function rowFromBroadcast(payload: unknown, conv: ChatConvRef): MessageRow | undefined {
  if (!isObj(payload)) return undefined
  const { id, client_id, team_id, thread_id, author_id, body, created_at, edited_at, deleted_at, reply_to, kind, via } = payload
  if (!isUuid(id) || !isUuid(client_id) || !isUuid(author_id)) return undefined
  if (typeof body !== 'string') return undefined
  if (!isDate(created_at)) return undefined
  if (edited_at != null && !isDate(edited_at)) return undefined
  if (deleted_at != null && !isDate(deleted_at)) return undefined
  if (reply_to != null && !isUuid(reply_to)) return undefined
  if (kind != null && kind !== 'text' && kind !== 'retention' && kind !== 'clear') return undefined
  if (deleted_at != null) {
    if (body !== '') return undefined
  } else {
    const n = codepoints(body)
    if (n < 1 || n > CHAT_LIMITS.body) return undefined
  }
  if (conv.kind === 'team' ? team_id !== conv.id || thread_id != null : thread_id !== conv.id || team_id != null) return undefined
  const row: MessageRow = conv.kind === 'team'
    ? { id, client_id, team_id, author_id, body, created_at }
    : { id, client_id, thread_id, author_id, body, created_at }
  if (edited_at != null) row.edited_at = edited_at
  if (deleted_at != null) row.deleted_at = deleted_at
  if (reply_to != null) row.reply_to = reply_to
  if (kind != null && kind !== 'text') row.kind = kind
  if (via === 'claude') row.via = 'claude'
  return row
}

export function memberRemovedFromBroadcast(p: unknown, teamId: string): { userId: string } | undefined {
  if (!isObj(p)) return undefined
  const { team_id, user_id } = p
  if (!isUuid(user_id) || team_id !== teamId) return undefined
  return { userId: user_id }
}

/** Clave de versión para el dedupe: una edición o un borrado del mismo mensaje cuentan como nuevos. */
export const versionKey = (row: MessageRow): string =>
  `${String(row.id)}:${typeof row.edited_at === 'string' ? row.edited_at : ''}:${typeof row.deleted_at === 'string' ? row.deleted_at : ''}`

export function reactionFromBroadcast(
  p: unknown
): { messageId: string; userId: string; emoji: ChatReactionEmoji; op: 'add' | 'remove' } | undefined {
  if (!isObj(p)) return undefined
  const { message_id, user_id, emoji, op } = p
  if (!isUuid(message_id) || !isUuid(user_id) || !isReactionEmoji(emoji)) return undefined
  if (op !== 'add' && op !== 'remove') return undefined
  return { messageId: message_id, userId: user_id, emoji, op }
}

export function typingFromBroadcast(p: unknown): { userId: string } | undefined {
  if (!isObj(p) || !isUuid(p.user_id)) return undefined
  return { userId: p.user_id }
}

export function readFromBroadcast(p: unknown): { userId: string; at: number } | undefined {
  if (!isObj(p) || !isUuid(p.user_id) || !isDate(p.at)) return undefined
  return { userId: p.user_id, at: Date.parse(p.at) }
}

/** Ids ya procesados (el mismo mensaje llega por broadcast y por postgres_changes). Acotado: olvida los más viejos. */
export class SeenIds {
  private ids = new Set<string>()
  private max: number

  constructor(max = SEEN_MAX) {
    this.max = Math.max(1, max)
  }

  /** true si es la primera vez que se ve el id (y lo anota). */
  first(id: string): boolean {
    if (this.ids.has(id)) return false
    this.ids.add(id)
    while (this.ids.size > this.max) {
      const old = this.ids.values().next()
      if (old.done) break
      this.ids.delete(old.value)
    }
    return true
  }

  clear(): void {
    this.ids.clear()
  }
}

/** Limita un aviso por clave: `ok` es true si pasaron al menos `minMs` desde el último que dejó pasar. */
export class Throttle {
  private last = new Map<string, number>()
  private minMs: number

  constructor(minMs = TYPING_MIN_MS) {
    this.minMs = minMs
  }

  ok(key: string, at: number): boolean {
    const prev = this.last.get(key)
    if (prev !== undefined && at - prev < this.minMs) return false
    this.last.set(key, at)
    return true
  }

  clear(): void {
    this.last.clear()
  }
}

/**
 * Como Throttle, pero lo que no pasa no se pierde: queda uno pendiente por clave para el final de la
 * ventana. `ask` da 'now' (mandalo ya), los ms que faltan (programalo y llamá a `fired` al mandarlo)
 * o null (ya hay uno programado, que cubre este).
 */
export class TrailingThrottle {
  private last = new Map<string, number>()
  private pending = new Set<string>()
  private minMs: number

  constructor(minMs: number) {
    this.minMs = minMs
  }

  ask(key: string, at: number): 'now' | number | null {
    if (this.pending.has(key)) return null
    const prev = this.last.get(key)
    if (prev === undefined || at - prev >= this.minMs) {
      this.last.set(key, at)
      return 'now'
    }
    this.pending.add(key)
    return this.minMs - (at - prev)
  }

  fired(key: string, at: number): void {
    this.pending.delete(key)
    this.last.set(key, at)
  }

  clear(): void {
    this.last.clear()
    this.pending.clear()
  }
}
