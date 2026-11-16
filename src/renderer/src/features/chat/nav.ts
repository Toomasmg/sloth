import type { ChatConvRef } from '../../../../shared/chat'

/** Dónde está el chat: abierto o no, y la conversación en la que se quedó (sigue guardada con el panel cerrado). */
export interface NavState {
  open: boolean
  conv?: ChatConvRef
}

export type NavAction = { type: 'open'; conv?: ChatConvRef } | { type: 'close' } | { type: 'back' }

/** Solo la flecha de volver («back») deja la conversación; abrir y cerrar el panel no la tocan. */
export function navReduce(s: NavState, a: NavAction): NavState {
  switch (a.type) {
    case 'open':
      return { open: true, conv: a.conv ?? s.conv }
    case 'close':
      return { open: false, conv: s.conv }
    case 'back':
      return { open: s.open }
  }
}

/** La conversación, si todavía existe y el usuario la ve; si no, undefined (cae a la lista). */
export function availableConv(conv: ChatConvRef | undefined, teamIds: readonly string[], threadIds: readonly string[]): ChatConvRef | undefined {
  if (!conv) return undefined
  return (conv.kind === 'team' ? teamIds : threadIds).includes(conv.id) ? conv : undefined
}

export type RestoreTarget = { ready: false } | { ready: true; conv?: ChatConvRef }

/** Adónde volver al abrir la app. Hasta que lleguen las listas no se sabe si la conversación sigue existiendo. */
export function restoreTarget(
  saved: ChatConvRef | undefined,
  lists: { loaded: boolean; teamIds: readonly string[]; threadIds: readonly string[] }
): RestoreTarget {
  if (!lists.loaded) return { ready: false }
  return { ready: true, conv: availableConv(saved, lists.teamIds, lists.threadIds) }
}

export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const keyFor = (userId: string): string => `sloth.chat.last.${userId}`
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export function parseConv(raw: string | null): ChatConvRef | undefined {
  if (!raw) return undefined
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v !== 'object' || v === null) return undefined
    const { kind, id } = v as { kind?: unknown; id?: unknown }
    if ((kind !== 'team' && kind !== 'dm') || typeof id !== 'string' || !ID_RE.test(id)) return undefined
    return { kind, id }
  } catch {
    return undefined
  }
}

export function loadLastConv(store: KeyValueStore, userId: string): ChatConvRef | undefined {
  return parseConv(store.getItem(keyFor(userId)))
}

export function saveLastConv(store: KeyValueStore, userId: string, conv: ChatConvRef | undefined): void {
  if (conv) store.setItem(keyFor(userId), JSON.stringify({ kind: conv.kind, id: conv.id }))
  else store.removeItem(keyFor(userId))
}
