import { useEffect, useSyncExternalStore } from 'react'
import type {
  ChatConvRef,
  ChatInviteResult,
  ChatMember,
  ChatMessage,
  ChatProfile,
  ChatReactionEmoji,
  ChatReactionEvent,
  ChatReplyRef,
  ChatSnapshot,
  ChatTeam,
  ChatThread,
  ChatTypingEvent,
  ChatView
} from '../../../../shared/chat'
import { convKey } from '../../../../shared/chat'
import { mentionsLogin } from '../../../../shared/chat-text'
import type { UiCtx } from '../host'
import { toast } from '../../ui/Toast'
import { getSettings } from '../settings/store'
import { playChatChime } from '../sound/audio'
import { planIncoming, planSent, RecentIds, sameConv, toastText } from './alerts'
import { applyReaction, mergeUpdate } from './message-ops'
import { availableConv, loadLastConv, navReduce, saveLastConv, type KeyValueStore, type NavAction, type NavState } from './nav'

/**
 * Estado del chat en la interfaz: espejo del snapshot de main, caché de mensajes por conversación,
 * envío optimista y estado del drawer. Sin polling: todo llega por eventos de main (el único timer
 * vence los «escribiendo…»).
 */

/** Máximo de mensajes en caché por conversación. */
export const MAX_CACHED = 300
/** Tamaño de página de «messages». */
export const PAGE = 50
/** Texto que se anuncia en la región aria-live al llegar un mensaje ajeno a la conversación abierta. */
const ANNOUNCE_CHARS = 200

/** Cuánto dura «escribiendo…» sin que llegue otro aviso del mismo usuario. */
const TYPING_MS = 6000
/** Mínimo entre dos avisos de «estoy escribiendo». */
const TYPING_PING_MS = 3000

interface ConvMeta {
  /** Hay mensajes más viejos sin cargar (se pide con «Cargar anteriores»). */
  more: boolean
}

let api: UiCtx | null = null
let wired = false
let snap: ChatSnapshot | null = null
let nav: NavState = { open: false }
/** Usuario de la sesión: la última conversación se guarda por usuario. */
let navUser: string | undefined
/** El usuario ya eligió dónde estar en esta sesión: no se le pisa con lo guardado. */
let navTouched = false
let announcement = ''
let joinOpen = false
/** Error de una invitación que esperaba el login, para mostrarlo en el diálogo si sigue abierto. */
let inviteError: string | null = null
const msgs = new Map<string, ChatMessage[]>()
const meta = new Map<string, ConvMeta>()
const drafts = new Map<string, string>()
const typingBy = new Map<string, Map<string, { login: string; until: number }>>()
const typingLogins = new Map<string, string[]>()
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>()
const lastPing = new Map<string, number>()
const listeners = new Set<() => void>()

const notify = (): void => {
  listeners.forEach((l) => l())
}
const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Mensaje de error sin el prefijo que agrega Electron al invocar. */
export function errText(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Invoca `feat:chat:<op>` en main. */
const call = <T,>(op: string, ...args: unknown[]): Promise<T> => {
  if (!api) return Promise.reject(new Error('El chat todavía no está listo.'))
  return api.invoke<T>(`feat:chat:${op}`, ...args)
}

const isLocal = (m: ChatMessage): boolean => m.id.startsWith('local:')
const byTime = (a: ChatMessage, b: ChatMessage): number => a.createdAt - b.createdAt

/**
 * Mezcla mensajes en la caché de una conversación. Reemplaza por id o por clientId (así el «enviando…»
 * se reemplaza por el mensaje real y el mismo mensaje nunca aparece dos veces).
 * `side`: qué se descarta si pasa el tope. 'oldest' para mensajes nuevos; 'newest' al cargar anteriores.
 */
function mergeInto(conv: ChatConvRef, incoming: ChatMessage[], side: 'oldest' | 'newest'): void {
  if (incoming.length === 0) return
  const key = convKey(conv)
  const ids = new Set(incoming.map((m) => m.id))
  const cids = new Set(incoming.map((m) => m.clientId))
  const kept = (msgs.get(key) ?? []).filter((m) => !ids.has(m.id) && !cids.has(m.clientId))
  let next = [...kept, ...incoming].sort(byTime)
  if (next.length > MAX_CACHED) {
    if (side === 'oldest') {
      next = next.slice(next.length - MAX_CACHED)
    } else {
      // Al paginar hacia atrás se descartan los más nuevos (los envíos en curso se conservan).
      const pending = next.filter(isLocal)
      const rest = next.filter((m) => !isLocal(m)).slice(0, MAX_CACHED - pending.length)
      next = [...rest, ...pending].sort(byTime)
    }
  }
  msgs.set(key, next)
  notify()
}

// ---------- snapshot y eventos de main ----------

const storage = (): KeyValueStore | null => {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function setNav(a: NavAction): void {
  nav = navReduce(nav, a)
  if (a.type !== 'close') navTouched = true
  const store = storage()
  if (navUser && store && a.type !== 'close') {
    try {
      saveLastConv(store, navUser, nav.conv)
    } catch (e) {
      api?.notifyError(`No se pudo recordar la conversación: ${errText(e)}`)
    }
  }
  notify()
}

/** Al conocer al usuario, vuelve a la conversación en la que se había quedado (si sigue existiendo). */
function syncNavUser(next: ChatSnapshot): void {
  const id = next.auth.status === 'signedIn' ? next.auth.me.id : undefined
  if (id === navUser) return
  navUser = id
  if (!id) {
    nav = { open: nav.open }
    return
  }
  const store = storage()
  if (!store || navTouched) return
  try {
    const last = availableConv(
      loadLastConv(store, id),
      next.teams.map((t) => t.id),
      next.threads.map((t) => t.id)
    )
    nav = { open: nav.open, conv: last }
    if (!last) saveLastConv(store, id, undefined)
  } catch {
    nav = { open: nav.open }
  }
}

function setSnap(next: ChatSnapshot): void {
  const prev = snap
  snap = next
  syncNavUser(next)
  notify()
  // Al reconectar (pasa a «live») se piden de nuevo los mensajes de la conversación abierta.
  if (prev?.connection !== 'live' && next.connection === 'live' && nav.open && nav.conv) {
    void loadMessages(nav.conv)
  }
}

function meId(): string | undefined {
  return snap?.auth.status === 'signedIn' ? snap.auth.me.id : undefined
}

const alerted = new RecentIds()

function alertIncoming(m: ChatMessage): void {
  const { settings } = getSettings()
  const me = snap?.auth.status === 'signedIn' ? snap.auth.me : undefined
  const mention = !!me && mentionsLogin(m.body, me.login)
  const plan = planIncoming({
    mine: m.author.id === meId(),
    alreadySeen: alerted.seen(m.id),
    windowFocused: document.hasFocus(),
    viewing: nav.open && sameConv(nav.conv, m.conv),
    mention,
    settings
  })
  if (plan.sound) playChatChime(plan.sound, settings.soundName)
  if (!plan.toast) return
  const convName = m.conv.kind === 'team' ? teamOf(snap, m.conv.id)?.name : undefined
  toast({
    tone: 'info',
    message: toastText(mention ? `${m.author.login} te mencionó` : m.author.login, convName, m.body),
    actionLabel: 'Abrir',
    onAction: () => openChat(m.conv)
  })
}

function onRealtime(m: ChatMessage): void {
  const key = convKey(m.conv)
  const prev = (msgs.get(key) ?? []).find((x) => x.id === m.id)
  if (prev) {
    // El evento no trae las reacciones: las que ya tenía el mensaje se conservan.
    mergeInto(m.conv, [mergeUpdate(prev, { ...m, reactions: undefined })], 'oldest')
    return
  }
  mergeInto(m.conv, [mergeUpdate(undefined, m)], 'oldest')
  clearTyping(key, m.author.id)
  if (m.deletedAt !== undefined) return
  alertIncoming(m)
  if (m.author.id === meId()) return
  if (nav.open && nav.conv && convKey(nav.conv) === key) {
    announcement = `${m.author.login}: ${m.body.slice(0, ANNOUNCE_CHARS)}`
    notify()
  }
}

function onReaction(ev: ChatReactionEvent): void {
  patchMessage(ev.conv, ev.messageId, (m) => applyReaction(m, ev))
}

function patchMessage(conv: ChatConvRef, id: string, fn: (m: ChatMessage) => ChatMessage): void {
  const key = convKey(conv)
  const list = msgs.get(key)
  const at = list?.findIndex((m) => m.id === id) ?? -1
  if (!list || at < 0) return
  const next = list.slice()
  next[at] = fn(list[at])
  msgs.set(key, next)
  notify()
}

/** Recalcula quién está escribiendo en una conversación y programa el próximo vencimiento. */
function refreshTyping(key: string): void {
  const room = typingBy.get(key)
  const now = Date.now()
  room?.forEach((t, id) => {
    if (t.until <= now) room.delete(id)
  })
  const logins = room ? [...room.values()].map((t) => t.login) : []
  const before = typingLogins.get(key) ?? NO_LOGINS
  if (logins.length !== before.length || logins.some((l, i) => l !== before[i])) {
    if (logins.length) typingLogins.set(key, logins)
    else typingLogins.delete(key)
    notify()
  }
  const timer = typingTimers.get(key)
  if (timer) clearTimeout(timer)
  if (room && room.size > 0) {
    const soonest = Math.min(...[...room.values()].map((t) => t.until))
    typingTimers.set(key, setTimeout(() => refreshTyping(key), Math.max(50, soonest - now)))
  } else typingTimers.delete(key)
}

function clearTyping(key: string, userId: string): void {
  if (typingBy.get(key)?.delete(userId)) refreshTyping(key)
}

function onTyping(ev: ChatTypingEvent): void {
  if (ev.userId === meId()) return
  const key = convKey(ev.conv)
  const room = typingBy.get(key) ?? new Map<string, { login: string; until: number }>()
  room.set(ev.userId, { login: ev.login, until: Date.now() + TYPING_MS })
  typingBy.set(key, room)
  refreshTyping(key)
}

/**
 * Conecta la caché con main una sola vez (los eventos no se vuelven a suscribir en cada render).
 * Se llama desde los componentes del chat; `ui` puede cambiar de identidad, así que se guarda el último.
 */
export function attachChat(ui: UiCtx): void {
  api = ui
  if (wired) return
  wired = true
  ui.on('feat:chat:snapshot', (s: ChatSnapshot) => setSnap(s))
  ui.on('feat:chat:message', (m: ChatMessage) => onRealtime(m))
  ui.on('feat:chat:reaction', (ev: ChatReactionEvent) => onReaction(ev))
  ui.on('feat:chat:typing', (ev: ChatTypingEvent) => onTyping(ev))
  ui.on('feat:chat:open', (conv: ChatConvRef) => openChat(conv))
  ui.on('feat:chat:invite', (r: ChatInviteResult) => onInviteResult(r))
  void call<ChatSnapshot>('state')
    .then(setSnap)
    .catch(() => undefined)
}

/** Para los componentes: conecta con main (idempotente) mientras se montan. */
export function useChatAttach(ui: UiCtx): void {
  useEffect(() => attachChat(ui), [ui])
}

// ---------- hooks de lectura ----------

export function useChatSnapshot(): ChatSnapshot | null {
  return useSyncExternalStore(subscribe, () => snap)
}

export interface DrawerView {
  open: boolean
  conv?: ChatConvRef
}

export function useDrawer(): DrawerView {
  return useSyncExternalStore(subscribe, () => nav)
}

const NO_LOGINS: string[] = []
/** Logins de quienes están escribiendo en la conversación. */
export function useTyping(conv: ChatConvRef): string[] {
  const key = convKey(conv)
  return useSyncExternalStore(subscribe, () => typingLogins.get(key) ?? NO_LOGINS)
}

/** El servidor tiene la actualización 0004: editar, borrar, responder, reaccionar, «escribiendo…» y «Visto». */
export function useExtras(): boolean {
  return useSyncExternalStore(subscribe, () => snap?.extras === true)
}

/** Hay snapshot y el servidor no tiene la 0004. */
export function useExtrasMissing(): boolean {
  return useSyncExternalStore(subscribe, () => !!snap && snap.auth.status === 'signedIn' && !snap.extras)
}

const NO_MSGS: ChatMessage[] = []
export function useConvMessages(conv: ChatConvRef): ChatMessage[] {
  const key = convKey(conv)
  return useSyncExternalStore(subscribe, () => msgs.get(key) ?? NO_MSGS)
}

/** undefined mientras no hay respuesta de main para la conversación. */
export function useConvMeta(conv: ChatConvRef): ConvMeta | undefined {
  const key = convKey(conv)
  return useSyncExternalStore(subscribe, () => meta.get(key))
}

export function useAnnouncement(): string {
  return useSyncExternalStore(subscribe, () => announcement)
}

// ---------- drawer ----------

/** Abre el drawer. Sin `conv`, vuelve a donde estaba (la lista, si todavía no entró a ninguna). */
export function openChat(conv?: ChatConvRef): void {
  setNav({ type: 'open', conv })
}

export function closeChat(): void {
  if (nav.open) setNav({ type: 'close' })
}

/** La flecha de volver: lo único que saca al usuario de su conversación. */
export function showChatList(): void {
  setNav({ type: 'back' })
}

export function openJoinInvite(): void {
  closeChat()
  joinOpen = true
  inviteError = null
  notify()
}

export function closeJoinInvite(): void {
  if (!joinOpen) return
  joinOpen = false
  inviteError = null
  notify()
}

export function useJoinInviteOpen(): boolean {
  return useSyncExternalStore(subscribe, () => joinOpen)
}

export function useInviteError(): string | null {
  return useSyncExternalStore(subscribe, () => inviteError)
}

export function clearInviteError(): void {
  if (inviteError === null) return
  inviteError = null
  notify()
}

/** Entró al equipo: se abre su conversación. */
export function joinedTeam(team: ChatTeam): void {
  closeJoinInvite()
  openChat({ kind: 'team', id: team.id })
  toast({ tone: 'success', message: `Entraste a «${team.name}».` })
}

/** El canje que esperaba el login terminó. Con el diálogo cerrado, el error va como aviso. */
function onInviteResult(r: ChatInviteResult): void {
  if (r.ok) return joinedTeam(r.team)
  if (joinOpen) {
    inviteError = r.message
    notify()
  } else api?.notifyError(r.message)
}

export function getDraft(conv: ChatConvRef): string {
  return drafts.get(convKey(conv)) ?? ''
}

export function setDraft(conv: ChatConvRef, text: string): void {
  if (text) drafts.set(convKey(conv), text)
  else drafts.delete(convKey(conv))
}

// ---------- mensajes ----------

/** Pide la última página (o la anterior a la más vieja cargada). Errores: los devuelve para mostrarlos. */
export async function loadMessages(conv: ChatConvRef, older = false): Promise<string | undefined> {
  const key = convKey(conv)
  const cur = msgs.get(key) ?? []
  const oldest = older ? cur.find((m) => !isLocal(m)) : undefined
  if (older && !oldest) return undefined
  try {
    const list = await call<ChatMessage[]>('messages', conv, oldest ? oldest.id : null, PAGE)
    mergeInto(conv, list, older ? 'newest' : 'oldest')
    if (older) meta.set(key, { more: list.length >= PAGE })
    else if (!meta.has(key)) meta.set(key, { more: list.length >= PAGE })
    notify()
    return undefined
  } catch (e) {
    return errText(e)
  }
}

/** Marca leído la conversación (RPC en main). */
export function markRead(conv: ChatConvRef): void {
  call('markRead', conv).catch(() => undefined)
}

/** Vista que mira el usuario (drawer abierto y conversación, o cerrado): para no leídos y avisos en main. */
export function sendView(view: ChatView): void {
  call('setView', view).catch(() => undefined)
}

async function transmit(m: ChatMessage): Promise<void> {
  mergeInto(m.conv, [{ ...m, status: 'sending', error: undefined }], 'oldest')
  try {
    const sent = await call<ChatMessage>('send', m.conv, m.body, m.clientId, m.replyTo?.id)
    mergeInto(m.conv, [{ ...sent, replyTo: sent.replyTo ?? m.replyTo, status: 'sent' }], 'oldest')
    const { settings } = getSettings()
    const plan = planSent(settings, alerted.seen(`sent:${m.clientId}`))
    if (plan.sound) playChatChime(plan.sound, settings.soundName)
  } catch (e) {
    // Si el mensaje ya llegó por realtime, no se lo marca como fallido.
    const cur = msgs.get(convKey(m.conv)) ?? []
    if (cur.some((x) => x.clientId === m.clientId && x.status === 'sent')) return
    mergeInto(m.conv, [{ ...m, status: 'failed', error: errText(e) }], 'oldest')
  }
}

/**
 * Envía con estado optimista: aparece «enviando…» al instante; si main no responde bien queda
 * «failed» con «Reintentar» (mismo clientId, así que no se duplica).
 */
export async function sendMessage(conv: ChatConvRef, rawBody: string, replyTo?: ChatReplyRef): Promise<void> {
  const me = snap?.auth.status === 'signedIn' ? snap.auth.me : undefined
  const body = rawBody.trim()
  if (!me) throw new Error('Iniciá sesión en el chat.')
  if (!body) return
  const clientId = crypto.randomUUID()
  await transmit({
    id: `local:${clientId}`,
    clientId,
    conv,
    author: me,
    body,
    createdAt: Date.now(),
    status: 'sending',
    ...(replyTo && { replyTo })
  })
}

export async function retrySend(m: ChatMessage): Promise<void> {
  await transmit({ ...m, status: 'sending', error: undefined })
}

function putUpdate(m: ChatMessage): void {
  const prev = (msgs.get(convKey(m.conv)) ?? []).find((x) => x.id === m.id)
  mergeInto(m.conv, [mergeUpdate(prev, m)], 'oldest')
}

/** Edita el cuerpo de un mensaje propio. Los errores los muestra quien llama. */
export async function editMessage(conv: ChatConvRef, id: string, body: string): Promise<void> {
  putUpdate(await call<ChatMessage>('edit', conv, id, body))
}

/** Borra un mensaje: los que no llegaron a salir solo se sacan de la caché. */
export async function removeMessage(m: ChatMessage): Promise<void> {
  if (isLocal(m) || m.status === 'failed') {
    const key = convKey(m.conv)
    msgs.set(key, (msgs.get(key) ?? []).filter((x) => x.clientId !== m.clientId))
    notify()
    return
  }
  putUpdate(await call<ChatMessage>('remove', m.conv, m.id))
}

/** Pone o saca la reacción al instante; si main la rechaza, vuelve atrás y avisa. */
export function toggleReaction(m: ChatMessage, emoji: ChatReactionEmoji, me: { id: string; login: string }): void {
  const on = !(m.reactions ?? []).some((r) => r.emoji === emoji && r.userIds.includes(me.id))
  const ev = (op: 'add' | 'remove'): ChatReactionEvent => ({ conv: m.conv, messageId: m.id, emoji, userId: me.id, login: me.login, op })
  patchMessage(m.conv, m.id, (x) => applyReaction(x, ev(on ? 'add' : 'remove')))
  call('react', m.conv, m.id, emoji, on).catch((e: unknown) => {
    patchMessage(m.conv, m.id, (x) => applyReaction(x, ev(on ? 'remove' : 'add')))
    toast({ tone: 'danger', message: errText(e) })
  })
}

const membersCache = new Map<string, ChatProfile[]>()

/** A quién se puede mencionar en la conversación (sin vos): los miembros del equipo, o el otro en un directo. */
export async function mentionCandidates(conv: ChatConvRef): Promise<ChatProfile[]> {
  const key = convKey(conv)
  const hit = membersCache.get(key)
  if (hit) return hit
  const me = meId()
  let list: ChatProfile[]
  if (conv.kind === 'dm') {
    const other = threadOf(snap, conv.id)?.other
    list = other ? [other] : []
  } else {
    list = (await call<ChatMember[]>('members', conv.id)).map((m) => m.profile)
  }
  const out = list.filter((p) => p.id !== me)
  membersCache.set(key, out)
  return out
}

export function searchMessages(conv: ChatConvRef, query: string): Promise<ChatMessage[]> {
  return call<ChatMessage[]>('search', conv, query)
}

/** Avisa a los demás que estás escribiendo, a lo sumo cada 3 segundos. */
export function pingTyping(conv: ChatConvRef): void {
  if (snap?.extras !== true) return
  const key = convKey(conv)
  const now = Date.now()
  if (now - (lastPing.get(key) ?? 0) < TYPING_PING_MS) return
  lastPing.set(key, now)
  call('typing', conv).catch(() => undefined)
}

// ---------- helpers de vista ----------

export function teamOf(s: ChatSnapshot | null, id: string): ChatTeam | undefined {
  return s?.teams.find((t) => t.id === id)
}

export function threadOf(s: ChatSnapshot | null, id: string): ChatThread | undefined {
  return s?.threads.find((t) => t.id === id)
}
