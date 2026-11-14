/**
 * Reproductor del sonido suave. Sintetiza con WebAudio (sin archivos).
 * - Un solo AudioContext, creado recién en el primer sonido.
 * - Se cierra (ctx.close) IDLE_CLOSE_MS después de que termina el último sonido, para no dejar vivo el audio.
 * - El timer solo existe mientras hay un sonido reciente: no hay timers permanentes.
 */
import { SOUND_VARIANTS, chatChimeSpec, type ChatChime, type Chime, type ChimeSpec, type SoundName } from './logic'

/** Tiempo sin sonar (desde que termina el último sonido) antes de cerrar el AudioContext. */
export const IDLE_CLOSE_MS = 3000

type AudioCtor = new () => AudioContext

let ctx: AudioContext | null = null
let closeTimer: ReturnType<typeof setTimeout> | undefined

/** Para pruebas: cuántas veces se creó y se cerró el AudioContext. */
export const audioStats = { created: 0, closed: 0 }

function getContext(): AudioContext | null {
  if (ctx && ctx.state !== 'closed') return ctx
  const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext) as
    | AudioCtor
    | undefined
  if (!Ctor) return null
  ctx = new Ctor()
  audioStats.created++
  return ctx
}

function closeContext(): void {
  clearTimeout(closeTimer)
  closeTimer = undefined
  const c = ctx
  ctx = null
  if (c && c.state !== 'closed') {
    audioStats.closed++
    void c.close().catch(() => undefined)
  }
}

/** Suena «done» o «attention» con el sonido elegido. No comprueba el ajuste ni el intervalo mínimo (eso lo decide quien llama). */
export function playChime(kind: Chime, name: SoundName = 'Gota'): void {
  playSpec(SOUND_VARIANTS[name][kind])
}

/** Sonido de un mensaje del chat: «receive» al llegar uno ajeno, «send» (más suave y corto) al mandar el propio. */
export function playChatChime(kind: ChatChime, name: SoundName = 'Gota'): void {
  playSpec(chatChimeSpec(name, kind))
}

function playSpec(spec: ChimeSpec): void {
  const c = getContext()
  if (!c) return
  clearTimeout(closeTimer)
  if (c.state === 'suspended') void c.resume().catch(() => undefined)

  const t0 = c.currentTime + 0.02
  for (const n of spec.notes) {
    const osc = c.createOscillator()
    const gain = c.createGain()
    const start = t0 + n.start
    const end = start + n.dur
    osc.type = 'sine'
    osc.frequency.setValueAtTime(n.freq, start)
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.linearRampToValueAtTime(spec.peak, start + spec.attack)
    gain.gain.linearRampToValueAtTime(0.0001, end)
    osc.connect(gain).connect(c.destination)
    osc.start(start)
    osc.stop(end + 0.01)
  }

  closeTimer = setTimeout(closeContext, Math.round((t0 - c.currentTime + spec.total) * 1000) + IDLE_CLOSE_MS)
}

/** Cierra el contexto ya (p. ej. al desmontar). */
export function disposeSound(): void {
  closeContext()
}
