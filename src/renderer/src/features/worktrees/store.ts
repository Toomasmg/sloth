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
  /** Carpeta del repo para filtrar al abrir (menú «más» de un espacio). null = todos los repos. */
  repoPath: string | null
}

/** Lo que tenía el foco al abrir: vuelve a tenerlo al cerrar. */
let returnFocus: HTMLElement | null = null
let state: RamasState = { open: false, dialog: null, nonce: 0, candidates: null, repoPath: null }
const listeners = new Set<() => void>()

function set(next: Partial<RamasState>): void {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

/** Abre el panel. `repoPath` (carpeta de un espacio) deja filtrado el repo de ese espacio. */
export function openRamas(dialog: RamasDialog = null, repoPath: string | null = null): void {
  if (!state.open) returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
  set({ open: true, dialog, nonce: state.nonce + 1, repoPath })
}

export function closeRamas(): void {
  set({ open: false, dialog: null })
  const back = returnFocus
  returnFocus = null
  requestAnimationFrame(() => {
    if (back?.isConnected) back.focus()
  })
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
