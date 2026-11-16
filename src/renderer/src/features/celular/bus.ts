/** Abrir el panel «Celular» desde la paleta o desde un aviso. Lo escucha el Global de «celular». */
const listeners = new Set<() => void>()
export const onOpenCelular = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
export const openCelular = (): void => listeners.forEach((l) => l())
