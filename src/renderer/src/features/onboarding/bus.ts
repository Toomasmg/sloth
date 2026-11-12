import { useSyncExternalStore } from 'react'

/** La paleta pide abrir «Primeros pasos»; el componente Global escucha acá. */
const listeners = new Set<() => void>()
export const onOpen = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
export const requestOpen = (): void => listeners.forEach((l) => l())

// La tarjeta de «iniciá sesión» tiene que seguir viva aunque «Empecemos» se desmonte al abrirse la terminal de login.
let docked: string | null = null
const dockSubs = new Set<() => void>()
export const setDocked = (id: string | null): void => {
  docked = id
  dockSubs.forEach((l) => l())
}
export const useDocked = (): string | null =>
  useSyncExternalStore(
    (cb) => {
      dockSubs.add(cb)
      return () => dockSubs.delete(cb)
    },
    () => docked
  )
