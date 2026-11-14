import type { ChatConvRef } from '../../../../shared/chat'
import { convKey } from '../../../../shared/chat'

export interface ChatAlertSettings {
  sounds: boolean
  noMolestar: boolean
  notify: { team: boolean; soundIn: boolean; soundOut: boolean }
}

export interface ChatAlertPlan {
  sound: 'receive' | 'send' | null
  toast: boolean
}

const NONE: ChatAlertPlan = { sound: null, toast: false }

export interface IncomingInput {
  mine: boolean
  /** Ya se avisó de este mensaje (llegó por broadcast y por postgres_changes). */
  alreadySeen: boolean
  windowFocused: boolean
  /** El usuario tiene abierta justo esa conversación. */
  viewing: boolean
  settings: ChatAlertSettings
}

/**
 * Qué hacer con un mensaje que llega por el evento «message». Los propios no avisan ni suenan acá
 * (el sonido de enviar sale del envío). El toast es solo con la ventana en foco: sin foco avisa el sistema.
 */
export function planIncoming(i: IncomingInput): ChatAlertPlan {
  if (i.mine || i.alreadySeen) return NONE
  const quiet = i.settings.noMolestar
  const sound = !quiet && i.settings.sounds && i.settings.notify.soundIn ? 'receive' : null
  const toast = !quiet && i.settings.notify.team && i.windowFocused && !i.viewing
  return { sound, toast }
}

export function planSent(settings: ChatAlertSettings, alreadySeen: boolean): ChatAlertPlan {
  if (alreadySeen || settings.noMolestar || !settings.sounds || !settings.notify.soundOut) return NONE
  return { sound: 'send', toast: false }
}

/** Recuerda los últimos ids vistos (tope fijo) para no avisar dos veces del mismo mensaje. */
export class RecentIds {
  private readonly ids = new Set<string>()
  private readonly max: number
  constructor(max = 500) {
    this.max = max
  }
  /** true si el id ya estaba; si no, lo registra. */
  seen(id: string): boolean {
    if (this.ids.has(id)) return true
    this.ids.add(id)
    if (this.ids.size > this.max) this.ids.delete(this.ids.values().next().value as string)
    return false
  }
}

const TOAST_BODY_CHARS = 80

/** Primeras palabras del mensaje en una línea, cortadas en límite de palabra. */
export function firstWords(body: string, max = TOAST_BODY_CHARS): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > max / 2 ? cut.slice(0, sp) : cut).trimEnd()}…`
}

/** «autor · conversación: primeras palabras». En un directo la conversación es el autor, así que no se repite. */
export function toastText(author: string, convName: string | undefined, body: string): string {
  const head = convName ? `${author} · ${convName}` : author
  return `${head}: ${firstWords(body)}`
}

export function sameConv(a: ChatConvRef | undefined, b: ChatConvRef): boolean {
  return !!a && convKey(a) === convKey(b)
}

/** Texto de «99+» como lo muestra el Badge. */
export function unreadShown(n: number, max = 99): string {
  return n > max ? `${max}+` : String(n)
}

export function chatButtonLabel(n: number): string {
  if (n <= 0) return 'Chat del equipo'
  return `Chat, ${n} ${n === 1 ? 'mensaje sin leer' : 'mensajes sin leer'}`
}
