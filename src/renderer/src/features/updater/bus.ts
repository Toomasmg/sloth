/** Para abrir «Acerca de Sloth» desde la paleta o el chip (fuera del árbol de React). */
const listeners = new Set<() => void>()
export const onOpenAbout = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
export const openAbout = (): void => listeners.forEach((l) => l())
