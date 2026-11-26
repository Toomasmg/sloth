import { useSyncExternalStore } from 'react'
import type { PrsSnapshot } from '../../../../shared/prs'
import { contarPendientesPrs, type PendientesPrs } from '../../layout/pendientes'

interface PrsState {
  open: boolean
  nonce: number
}

let returnFocus: HTMLElement | null = null
let state: PrsState = { open: false, nonce: 0 }
const listeners = new Set<() => void>()

function set(next: Partial<PrsState>): void {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

export function openPrs(): void {
  if (!state.open) returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
  set({ open: true, nonce: state.nonce + 1 })
}

export function closePrs(): void {
  set({ open: false })
  const back = returnFocus
  returnFocus = null
  requestAnimationFrame(() => {
    if (back?.isConnected) back.focus()
  })
}

export function usePrs(): PrsState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state
  )
}

const SIN_PENDIENTES: PendientesPrs = { propiosRojos: 0, piden: 0, rojos: 0, sinRevision: 0 }
let pendientes = SIN_PENDIENTES
const pendientesListeners = new Set<() => void>()

/** Lo que ya sabe el último snapshot (guardado o recién llegado); el riel y la barra lo leen sin pedir nada a GitHub. */
export function setPrsSnapshot(s: PrsSnapshot): void {
  const next = contarPendientesPrs(s.repos)
  if (Object.keys(next).every((k) => next[k as keyof PendientesPrs] === pendientes[k as keyof PendientesPrs])) return
  pendientes = next
  for (const l of pendientesListeners) l()
}

export function usePrsPendientes(): PendientesPrs {
  return useSyncExternalStore(
    (cb) => {
      pendientesListeners.add(cb)
      return () => pendientesListeners.delete(cb)
    },
    () => pendientes
  )
}
