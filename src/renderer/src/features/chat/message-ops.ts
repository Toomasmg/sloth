import type { ChatMessage, ChatReactionEvent, ChatReplyRef } from '../../../../shared/chat'
import { CHAT_REACTIONS } from '../../../../shared/chat'

const emojiOrder = (e: string): number => CHAT_REACTIONS.indexOf(e as (typeof CHAT_REACTIONS)[number])

/** Un mensaje que llega de nuevo (edición, borrado) conserva lo que el evento no trae: reacciones y cita. */
export function mergeUpdate(prev: ChatMessage | undefined, next: ChatMessage): ChatMessage {
  if (next.deletedAt !== undefined) return { ...next, reactions: [] }
  if (!prev) return next
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
    if (m.author.id === meId && m.status === 'sent' && m.deletedAt === undefined) return m
  }
  return undefined
}

/** Id del último mensaje propio que el otro ya leyó (el «Visto» va debajo de ese). */
export function seenUpTo(list: readonly ChatMessage[], meId: string, otherReadAt?: number): string | undefined {
  if (otherReadAt === undefined) return undefined
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m.author.id === meId && m.status === 'sent' && m.deletedAt === undefined && m.createdAt <= otherReadAt) return m.id
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
