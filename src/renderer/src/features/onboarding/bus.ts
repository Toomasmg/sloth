/** La paleta pide abrir el asistente; el componente Global escucha acá. */
const listeners = new Set<() => void>()
export const onOpen = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
export const requestOpen = (): void => listeners.forEach((l) => l())
