/**
 * Lógica pura del sonido suave (sin WebAudio ni React): qué transiciones suenan y con qué tono.
 * Lo prueba un script Node suelto (ver scratchpad v4-t11).
 */
import type { AgentState } from '../../../../shared/types'

/** «done»: terminó el trabajo. «attention»: te pide permiso (o queda esperando). */
export type Chime = 'done' | 'attention'

export interface AgentLike {
  state: AgentState
}

/** Separación mínima entre dos sonidos, para que no se pisen. */
export const MIN_GAP_MS = 1500

/**
 * Compara el estado anterior con el nuevo y devuelve los sonidos que corresponden.
 * - Suena solo en TRANSICIONES a `done` o `waiting` (un agente que ya estaba así no suena).
 * - Un agente que aparece por primera vez (sin entrada previa) no suena.
 * - Con `prevPermIds` undefined (primera carga) no suena por permisos.
 * - Permisos nuevos (ids que no estaban antes) suenan como «attention».
 * - Devuelve como mucho un sonido de cada tipo; «attention» primero (pide acción).
 */
export function chimesFor(
  prevAgents: Record<string, AgentLike> | undefined,
  nextAgents: Record<string, AgentLike>,
  prevPermIds: readonly string[] | undefined,
  nextPermIds: readonly string[]
): Chime[] {
  let attention = false
  let done = false

  if (prevAgents) {
    for (const [id, next] of Object.entries(nextAgents)) {
      const prev = prevAgents[id]
      if (!prev || prev.state === next.state) continue
      if (next.state === 'done') done = true
      else if (next.state === 'waiting') attention = true
    }
  }

  if (prevPermIds) {
    const before = new Set(prevPermIds)
    if (nextPermIds.some((id) => !before.has(id))) attention = true
  }

  const out: Chime[] = []
  if (attention) out.push('attention')
  if (done) out.push('done')
  return out
}

/** true si pasó el mínimo desde el último sonido (`lastAt` 0 = nunca sonó). */
export function canPlay(lastAt: number, now: number, minGap: number = MIN_GAP_MS): boolean {
  return lastAt === 0 || now - lastAt >= minGap
}

export interface ChimeNote {
  /** Frecuencia en Hz (seno). */
  freq: number
  /** Inicio y duración en segundos, desde el inicio del sonido. */
  start: number
  dur: number
}

export interface ChimeSpec {
  notes: readonly ChimeNote[]
  /** Duración total del sonido en segundos. */
  total: number
  /** Ganancia pico de cada nota (suave). */
  peak: number
  /** Subida de la envolvente en segundos (sin clics). */
  attack: number
}

const NOTE_DUR = 0.2
const NOTE_GAP = 0.15

/** done: dos notas ascendentes (G5 → C6). attention: dos notas descendentes (C6 → G5). ~350 ms. */
export const CHIME_SPEC: Record<Chime, ChimeSpec> = {
  done: {
    notes: [
      { freq: 783.99, start: 0, dur: NOTE_DUR },
      { freq: 1046.5, start: NOTE_GAP, dur: NOTE_DUR }
    ],
    total: NOTE_GAP + NOTE_DUR,
    peak: 0.12,
    attack: 0.02
  },
  attention: {
    notes: [
      { freq: 1046.5, start: 0, dur: NOTE_DUR },
      { freq: 783.99, start: NOTE_GAP, dur: NOTE_DUR }
    ],
    total: NOTE_GAP + NOTE_DUR,
    peak: 0.12,
    attack: 0.02
  }
}

/** Sonidos elegibles en Configuración. «Gota» es el de siempre (CHIME_SPEC). */
export type SoundName = 'Gota' | 'Campana suave' | 'Clic'

const BELL_NOTE = 0.5
const BELL_GAP = 0.12
const CLICK_NOTE = 0.045

/** Variantes del sonido: misma forma (dos notas), distinto timbre y duración. */
export const SOUND_VARIANTS: Record<SoundName, Record<Chime, ChimeSpec>> = {
  Gota: CHIME_SPEC,
  'Campana suave': {
    done: {
      notes: [
        { freq: 659.25, start: 0, dur: BELL_NOTE },
        { freq: 880, start: BELL_GAP, dur: BELL_NOTE }
      ],
      total: BELL_GAP + BELL_NOTE,
      peak: 0.08,
      attack: 0.04
    },
    attention: {
      notes: [
        { freq: 880, start: 0, dur: BELL_NOTE },
        { freq: 659.25, start: BELL_GAP, dur: BELL_NOTE }
      ],
      total: BELL_GAP + BELL_NOTE,
      peak: 0.08,
      attack: 0.04
    }
  },
  Clic: {
    done: {
      notes: [
        { freq: 1800, start: 0, dur: CLICK_NOTE },
        { freq: 1400, start: 0.06, dur: CLICK_NOTE }
      ],
      total: 0.06 + CLICK_NOTE,
      peak: 0.1,
      attack: 0.005
    },
    attention: {
      notes: [
        { freq: 1400, start: 0, dur: CLICK_NOTE },
        { freq: 1800, start: 0.06, dur: CLICK_NOTE }
      ],
      total: 0.06 + CLICK_NOTE,
      peak: 0.1,
      attack: 0.005
    }
  }
}

/** Sonidos del chat: «receive» es el de «done» de la variante; «send» es su primera nota, más corta y baja. */
export type ChatChime = 'receive' | 'send'

export function chatChimeSpec(name: SoundName, kind: ChatChime): ChimeSpec {
  const base = SOUND_VARIANTS[name].done
  if (kind === 'receive') return base
  const note = base.notes[0]
  const dur = Math.min(note.dur, 0.12)
  return { notes: [{ ...note, dur }], total: dur, peak: base.peak * 0.6, attack: Math.min(base.attack, dur / 2) }
}
