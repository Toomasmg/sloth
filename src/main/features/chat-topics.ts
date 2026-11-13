/**
 * Chat (entrega rápida): tópicos de Broadcast por conversación, validación de lo que llega por ahí y
 * dedupe entre los dos caminos (broadcast y postgres_changes). Puro: se prueba con Node.
 *
 * Lo que llega por broadcast es dato no confiable aunque lo publique la base: se valida la forma
 * completa y que la conversación de la fila sea la del tópico por el que llegó.
 */
import { CHAT_LIMITS, type ChatConvRef } from '../../shared/chat'
import { codepoints, isObj, type MessageRow } from './chat-map'

/** Nombre del evento que manda el trigger de 0003_realtime_broadcast.sql. */
export const BROADCAST_EVENT = 'message'
/** Realtime corta en 100 canales por conexión; uno queda para «sloth-inbox» y el resto de margen. */
export const MAX_TOPICS = 90
export const SEEN_MAX = 2000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TOPIC_RE = /^(team|thread):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

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
  const { id, client_id, team_id, thread_id, author_id, body, created_at } = payload
  if (!isUuid(id) || !isUuid(client_id) || !isUuid(author_id)) return undefined
  if (typeof body !== 'string') return undefined
  const n = codepoints(body)
  if (n < 1 || n > CHAT_LIMITS.body) return undefined
  if (typeof created_at !== 'string' || Number.isNaN(Date.parse(created_at))) return undefined
  if (conv.kind === 'team' ? team_id !== conv.id || thread_id != null : thread_id !== conv.id || team_id != null) return undefined
  return conv.kind === 'team'
    ? { id, client_id, team_id, author_id, body, created_at }
    : { id, client_id, thread_id, author_id, body, created_at }
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
