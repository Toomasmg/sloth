import { useSyncExternalStore } from 'react'

/** Estado compartido entre el botón del header, el panel lateral y la paleta. */
export interface DrawerState {
  wsId: string | null
  /** Con qué abrir: los cambios o directo el formulario de PR. */
  view: 'changes' | 'pr'
  /** Sube cada vez que se pide abrir (para reabrir en la misma vista). */
  nonce: number
}

let state: DrawerState = { wsId: null, view: 'changes', nonce: 0 }
const listeners = new Set<() => void>()
const refreshListeners = new Set<(wsId: string) => void>()

function set(next: DrawerState): void {
  state = next
  for (const l of listeners) l()
}

export function openDrawer(wsId: string, view: DrawerState['view'] = 'changes'): void {
  set({ wsId, view, nonce: state.nonce + 1 })
}

export function closeDrawer(): void {
  set({ ...state, wsId: null })
}

export function useDrawer(): DrawerState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state
  )
}

/** Pide a los contadores que se actualicen (después de un commit, por ejemplo). */
export function requestRefresh(wsId: string): void {
  for (const l of refreshListeners) l(wsId)
}

export function onRefresh(cb: (wsId: string) => void): () => void {
  refreshListeners.add(cb)
  return () => refreshListeners.delete(cb)
}
