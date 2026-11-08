import { useSyncExternalStore } from 'react'

/** Estado compartido entre la sección del sidebar, la paleta y el panel «Ramas aparte». */
export type RamasDialog = null | 'nueva' | 'limpiar'

interface RamasState {
  open: boolean
  /** Diálogo que se abre encima del panel (Nueva rama aparte / Limpiar). */
  dialog: RamasDialog
  /** Sube cada vez que se abre: el panel vuelve a escanear. */
  nonce: number
  /** Ramas aparte que se pueden limpiar, según el último escaneo. null = todavía no hubo escaneo. */
  candidates: number | null
}

let state: RamasState = { open: false, dialog: null, nonce: 0, candidates: null }
const listeners = new Set<() => void>()

function set(next: Partial<RamasState>): void {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

export function openRamas(dialog: RamasDialog = null): void {
  set({ open: true, dialog, nonce: state.nonce + 1 })
}

export function closeRamas(): void {
  set({ open: false, dialog: null })
}

export function setRamasDialog(dialog: RamasDialog): void {
  set({ dialog })
}

/** Lo publica el panel al terminar cada escaneo; la barra lateral muestra el número como badge. */
export function setRamasCandidates(candidates: number): void {
  if (state.candidates !== candidates) set({ candidates })
}

export function useRamas(): RamasState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state
  )
}
