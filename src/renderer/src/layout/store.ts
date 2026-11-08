import { useSyncExternalStore } from 'react'
import { loadMode, saveMode, type KV, type ViewMode } from './logic'

/** localStorage si está disponible (puede tirar en modos restringidos). */
export function safeStorage(): KV | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * Estado del layout compartido fuera de React: así la paleta (comandos) y App leen y cambian
 * el mismo modo de vista sin pasar por el contexto de las funciones.
 */
let mode: ViewMode = loadMode(safeStorage())
const modeSubs = new Set<() => void>()
const equalizeSubs = new Set<() => void>()

export function getViewMode(): ViewMode {
  return mode
}

export function setViewMode(next: ViewMode): void {
  if (next === mode) return
  mode = next
  saveMode(safeStorage(), next)
  for (const cb of modeSubs) cb()
}

function subscribe(cb: () => void): () => void {
  modeSubs.add(cb)
  return () => modeSubs.delete(cb)
}

export function useViewMode(): ViewMode {
  return useSyncExternalStore(subscribe, getViewMode)
}

/** Evento de ventana: las terminales visibles re-ajustan su tamaño (una sola vez, tras un cambio grande). */
export const PANES_FIT_EVENT = 'sloth:panes-fit'

export function requestPanesFit(): void {
  window.dispatchEvent(new Event(PANES_FIT_EVENT))
}

/** Pide repartir por igual las proporciones del layout actual. */
export function requestEqualize(): void {
  for (const cb of equalizeSubs) cb()
}

export function onEqualize(cb: () => void): () => void {
  equalizeSubs.add(cb)
  return () => equalizeSubs.delete(cb)
}
