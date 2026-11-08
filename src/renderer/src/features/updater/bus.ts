/** Para abrir «Acerca de Sloth» desde la paleta o el chip (fuera del árbol de React). */
const listeners = new Set<() => void>()
export const onOpenAbout = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
export const openAbout = (): void => listeners.forEach((l) => l())

/** Aviso chico abajo a la derecha (lo pinta el Global de updater, que sobrevive al cierre del diálogo). */
const toastListeners = new Set<(m: string) => void>()
export const onUpdateToast = (cb: (m: string) => void): (() => void) => {
  toastListeners.add(cb)
  return () => toastListeners.delete(cb)
}
export const showUpdateToast = (m: string): void => toastListeners.forEach((l) => l(m))
