/** Abrir «Reportar un problema» desde otra función (help, settings). Lo escucha el Global de report (T4). */
const listeners = new Set<() => void>()
export const onOpenReport = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
export const openReport = (): void => listeners.forEach((l) => l())
