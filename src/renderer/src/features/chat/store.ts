import { useEffect, useSyncExternalStore } from 'react'
import type {
  ChatConvRef,
  ChatMessage,
  ChatSnapshot,
  ChatTeam,
  ChatThread,
  ChatView
} from '../../../../shared/chat'
import { convKey } from '../../../../shared/chat'
import type { UiCtx } from '../host'

/**
 * Estado del chat en la interfaz: espejo del snapshot de main, caché de mensajes por conversación,
 * envío optimista y estado del drawer. Sin timers ni polling: todo llega por eventos de main.
 */

/** Máximo de mensajes en caché por conversación. */
export const MAX_CACHED = 300
/** Tamaño de página de «messages». */
export const PAGE = 50
/** Texto que se anuncia en la región aria-live al llegar un mensaje ajeno a la conversación abierta. */
const ANNOUNCE_CHARS = 200

interface DrawerState {
  open: boolean
  conv?: ChatConvRef
}

interface ConvMeta {
  /** Hay mensajes más viejos sin cargar (se pide con «Cargar anteriores»). */
  more: boolean
}

let api: UiCtx | null = null
let wired = false
let snap: ChatSnapshot | null = null
let drawer: DrawerState = { open: false }
let announcement = ''
const msgs = new Map<string, ChatMessage[]>()
const meta = new Map<string, ConvMeta>()
const drafts = new Map<string, string>()
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

function setSnap(next: ChatSnapshot): void {
  const prev = snap
  snap = next
  notify()
  // Al reconectar (pasa a «live») se piden de nuevo los mensajes de la conversación abierta.
  if (prev?.connection !== 'live' && next.connection === 'live' && drawer.open && drawer.conv) {
    void loadMessages(drawer.conv)
  }
}

function meId(): string | undefined {
  return snap?.auth.status === 'signedIn' ? snap.auth.me.id : undefined
}

function onRealtime(m: ChatMessage): void {
  mergeInto(m.conv, [m], 'oldest')
  if (m.author.id === meId()) return
  if (drawer.open && drawer.conv && convKey(drawer.conv) === convKey(m.conv)) {
    announcement = `${m.author.login}: ${m.body.slice(0, ANNOUNCE_CHARS)}`
    notify()
  }
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
  ui.on('feat:chat:open', (conv: ChatConvRef) => openChat(conv))
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
  return useSyncExternalStore(subscribe, () => drawer)
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

/** Abre el drawer. Sin `conv`, abre la lista. */
export function openChat(conv?: ChatConvRef): void {
  drawer = { open: true, conv }
  notify()
}

export function closeChat(): void {
  if (!drawer.open) return
  drawer = { open: false }
  notify()
}

export function showChatList(): void {
  drawer = { open: true }
  notify()
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
    const sent = await call<ChatMessage>('send', m.conv, m.body, m.clientId)
    mergeInto(m.conv, [{ ...sent, status: 'sent' }], 'oldest')
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
export async function sendMessage(conv: ChatConvRef, rawBody: string): Promise<void> {
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
    status: 'sending'
  })
}

export async function retrySend(m: ChatMessage): Promise<void> {
  await transmit({ ...m, status: 'sending', error: undefined })
}

// ---------- helpers de vista ----------

export function teamOf(s: ChatSnapshot | null, id: string): ChatTeam | undefined {
  return s?.teams.find((t) => t.id === id)
}

export function threadOf(s: ChatSnapshot | null, id: string): ChatThread | undefined {
  return s?.threads.find((t) => t.id === id)
}
