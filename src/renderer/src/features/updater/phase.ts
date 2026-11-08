import { useSyncExternalStore } from 'react'

/**
 * Qué diálogo de actualización está abierto (estado solo de la interfaz). `notes` = novedades,
 * `dl` = descarga / listo para reiniciar / error. `restarting` = se pidió reiniciar.
 */
export type UpdatePhase = 'notes' | 'dl' | null
interface PhaseState {
  phase: UpdatePhase
  restarting: boolean
}

let state: PhaseState = { phase: null, restarting: false }
const subs = new Set<() => void>()
const emit = (): void => subs.forEach((s) => s())

export function setPhase(phase: UpdatePhase): void {
  state = { phase, restarting: phase ? state.restarting : false }
  emit()
}

export function setRestarting(restarting: boolean): void {
  state = { ...state, restarting }
  emit()
}

const subscribe = (cb: () => void): (() => void) => {
  subs.add(cb)
  return () => subs.delete(cb)
}

export function usePhase(): PhaseState {
  return useSyncExternalStore(subscribe, () => state)
}
