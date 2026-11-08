import { useSyncExternalStore } from 'react'
import { cleanError } from '../../format'
import { buildPayload } from './payload'
import type { SpaceStatus } from './state'

/**
 * Envíos de esta sesión y cola de mensajes para espacios que están trabajando. La cola vive acá
 * (en el renderer) y se vacía con el estado real de cada terminal: cuando el espacio pasa a
 * «te espera» o «listo» (ver `releaseQueued`, que llama Global con `agents` y `permissions`).
 */

export type TargetStatus = 'sent' | 'queued' | 'failed'

export interface BatchTarget {
  wsId: string
  name: string
  /** Mensaje ya con {espacio} y {rama} resueltos para este destino. */
  message: string
  status: TargetStatus
  error?: string
}

export interface Batch {
  id: string
  /** Texto tal como lo escribió la persona (sin resolver variables). */
  text: string
  time: number
  targets: BatchTarget[]
}

/** Pausa entre el texto y el Enter: deja que Claude Code termine de procesar el pegado. */
const SUBMIT_DELAY = 150
const MAX_BATCHES = 5

let batches: Batch[] = []
const subs = new Set<() => void>()
const emit = (): void => subs.forEach((f) => f())
const setBatches = (next: Batch[]): void => {
  batches = next
  emit()
}

const subscribe = (cb: () => void): (() => void) => {
  subs.add(cb)
  return () => {
    subs.delete(cb)
  }
}
export const useBatches = (): Batch[] => useSyncExternalStore(subscribe, () => batches)

/** Escribe el mensaje y el Enter en la terminal. Lanza si la terminal ya no existe. */
function writeTo(wsId: string, message: string): void {
  const p = buildPayload(message)
  if (!p) throw new Error('El mensaje está vacío.')
  window.sloth.ptyWrite(wsId, p.body)
  setTimeout(() => {
    try {
      window.sloth.ptyWrite(wsId, p.submit)
    } catch {
      /* la terminal se cerró justo después: el texto ya quedó escrito */
    }
  }, SUBMIT_DELAY)
}

export interface PlanItem {
  wsId: string
  name: string
  message: string
  /** Si es true se escribe ya; si no, queda en cola hasta que el espacio esté libre. */
  now: boolean
}

/** Manda (o encola) un envío a varios espacios y lo deja en la lista de esta sesión. */
export function startBatch(id: string, text: string, items: PlanItem[]): Batch {
  const targets: BatchTarget[] = items.map((i) => {
    if (!i.now) return { wsId: i.wsId, name: i.name, message: i.message, status: 'queued' as const }
    try {
      writeTo(i.wsId, i.message)
      return { wsId: i.wsId, name: i.name, message: i.message, status: 'sent' as const }
    } catch (e) {
      return { wsId: i.wsId, name: i.name, message: i.message, status: 'failed' as const, error: cleanError(e) }
    }
  })
  const batch: Batch = { id, text, time: Date.now(), targets }
  setBatches([batch, ...batches].slice(0, MAX_BATCHES))
  return batch
}

/**
 * Manda lo que estaba en cola si el espacio ya no está trabajando. `statusOf` da el estado real
 * de cada espacio, o `gone` si ya no existe. Devuelve los nombres que se mandaron ahora.
 */
export function releaseQueued(statusOf: (wsId: string) => SpaceStatus | 'gone'): string[] {
  const released: string[] = []
  let changed = false
  const next = batches.map((b) => ({
    ...b,
    targets: b.targets.map((t) => {
      if (t.status !== 'queued') return t
      const s = statusOf(t.wsId)
      if (s === 'working' || s === 'perm') return t
      changed = true
      if (s === 'gone') return { ...t, status: 'failed' as const, error: 'El espacio ya no existe.' }
      if (s === 'closed') return { ...t, status: 'failed' as const, error: 'La terminal se cerró antes de mandarlo.' }
      try {
        writeTo(t.wsId, t.message)
        released.push(t.name)
        return { ...t, status: 'sent' as const }
      } catch (e) {
        return { ...t, status: 'failed' as const, error: cleanError(e) }
      }
    })
  }))
  if (changed) setBatches(next)
  return released
}

/** Saca un destino de la cola (no se manda). */
export function cancelQueued(batchId: string, wsId: string): void {
  setBatches(
    batches.map((b) =>
      b.id !== batchId
        ? b
        : {
            ...b,
            targets: b.targets.map((t) =>
              t.wsId === wsId && t.status === 'queued' ? { ...t, status: 'failed' as const, error: 'Quitado de la cola.' } : t
            )
          }
    )
  )
}
