import type { ChatMessage, ChatReactionEvent, ChatReplyRef } from '../../../../shared/chat'
import { CHAT_REACTIONS } from '../../../../shared/chat'

const emojiOrder = (e: string): number => CHAT_REACTIONS.indexOf(e as (typeof CHAT_REACTIONS)[number])

/**
 * Un mensaje que llega de nuevo (edición, borrado) conserva lo que el evento no trae: reacciones y cita.
 * Las versiones llegan por HTTP y por realtime sin orden garantizado: una vieja no pisa a una nueva.
 */
export function mergeUpdate(prev: ChatMessage | undefined, next: ChatMessage): ChatMessage {
  if (prev?.deletedAt !== undefined && next.deletedAt === undefined) return prev
  if (next.deletedAt !== undefined) return { ...next, reactions: [] }
  if (!prev) return next
  if (prev.editedAt !== undefined && (next.editedAt === undefined || next.editedAt < prev.editedAt)) return prev
  return {
    ...next,
    reactions: next.reactions ?? prev.reactions,
    replyTo: next.replyTo ?? prev.replyTo
  }
}

export function applyReaction(m: ChatMessage, ev: ChatReactionEvent): ChatMessage {
  const rest = (m.reactions ?? []).filter((r) => r.emoji !== ev.emoji)
  const cur = (m.reactions ?? []).find((r) => r.emoji === ev.emoji)
  const had = cur?.userIds.includes(ev.userId) ?? false
  let next = cur
  if (ev.op === 'add') {
    if (!had) {
      next = {
        emoji: ev.emoji,
        userIds: [...(cur?.userIds ?? []), ev.userId],
        logins: [...(cur?.logins ?? []), ev.login]
      }
    }
  } else if (cur && had) {
    const at = cur.userIds.indexOf(ev.userId)
    next = {
      ...cur,
      userIds: cur.userIds.filter((_, i) => i !== at),
      logins: cur.logins.filter((_, i) => i !== at)
    }
  }
  const all = next && next.userIds.length > 0 ? [...rest, next] : rest
  return { ...m, reactions: all.sort((a, b) => emojiOrder(a.emoji) - emojiOrder(b.emoji)) }
}

export function lastEditable(list: readonly ChatMessage[], meId: string): ChatMessage | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m.author.id === meId && m.status === 'sent' && m.deletedAt === undefined && !m.notice) return m
  }
  return undefined
}

/** Id del último mensaje propio que el otro ya leyó (el «Visto» va debajo de ese). */
export function seenUpTo(list: readonly ChatMessage[], meId: string, otherReadAt?: number): string | undefined {
  if (otherReadAt === undefined) return undefined
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m.author.id === meId && m.status === 'sent' && m.deletedAt === undefined && !m.notice && m.createdAt <= otherReadAt) return m.id
  }
  return undefined
}

export type ComposerMode = { kind: 'new' } | { kind: 'reply'; to: ChatReplyRef } | { kind: 'edit'; id: string; original: string }

export function composerKey(
  key: string,
  mods: { shift: boolean; composing: boolean },
  text: string,
  mode: ComposerMode
): 'send' | 'editLast' | 'cancel' | null {
  if (mods.composing) return null
  if (key === 'Enter' && !mods.shift) return 'send'
  if (key === 'ArrowUp' && text === '' && mode.kind === 'new') return 'editLast'
  if (key === 'Escape' && mode.kind !== 'new') return 'cancel'
  return null
}

const GROUP_GAP_MS = 5 * 60_000

/** Un mensaje abre grupo (con avatar y nombre) si cambia el autor, pasan más de 5 minutos o cambia el día. */
export function startsGroup(prev: ChatMessage | undefined, m: ChatMessage): boolean {
  if (!prev || prev.deletedAt !== undefined || m.deletedAt !== undefined || prev.notice) return true
  if (prev.author.id !== m.author.id || m.replyTo) return true
  if (m.createdAt - prev.createdAt > GROUP_GAP_MS) return true
  return new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString()
}

export function typingText(logins: readonly string[]): string {
  if (logins.length === 0) return ''
  if (logins.length === 1) return `${logins[0]} está escribiendo…`
  if (logins.length === 2) return `${logins[0]} y ${logins[1]} están escribiendo…`
  return 'Varios están escribiendo…'
}

export interface MatchPart {
  text: string
  hit: boolean
}

/** Parte el texto en tramos que coinciden con la búsqueda (sin distinguir mayúsculas) y tramos que no. */
export function matchParts(text: string, query: string): MatchPart[] {
  const q = query.trim().toLowerCase()
  if (!q) return [{ text, hit: false }]
  const low = text.toLowerCase()
  const out: MatchPart[] = []
  let at = 0
  for (let i = low.indexOf(q); i >= 0; i = low.indexOf(q, at)) {
    if (i > at) out.push({ text: text.slice(at, i), hit: false })
    out.push({ text: text.slice(i, i + q.length), hit: true })
    at = i + q.length
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false })
  return out
}

/** Un tramo corto del texto alrededor de la primera coincidencia, con «…» donde se cortó. */
export function snippet(text: string, query: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const i = flat.toLowerCase().indexOf(query.trim().toLowerCase())
  const start = Math.max(0, Math.min(i < 0 ? 0 : i - 30, flat.length - max))
  const end = Math.min(flat.length, start + max)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/** Aviso de «vació la conversación»: se van los mensajes anteriores; quedan los envíos que no salieron. */
export function clearBefore(list: ChatMessage[], clear: ChatMessage): ChatMessage[] {
  return list.filter((m) => m.id === clear.id || m.createdAt > clear.createdAt || m.status !== 'sent')
}
