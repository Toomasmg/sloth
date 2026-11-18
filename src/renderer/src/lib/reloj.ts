import { useCallback, useSyncExternalStore } from 'react'
import { crearReloj } from './reloj-core'

const reloj = crearReloj(
  () => performance.now(),
  () => Date.now(),
  (fn, ms) => setTimeout(fn, ms),
  (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  () => document.visibilityState === 'visible'
)

document.addEventListener('visibilitychange', () => reloj.reanudar())

/** Hora actual refrescada cada `cadaMs`, con un solo timer para todo el renderer y en pausa con la ventana oculta. Con `null` no se suscribe. */
export function useAhora(cadaMs: number | null): number {
  const suscribir = useCallback((cb: () => void) => (cadaMs === null ? () => {} : reloj.suscribir(cb, cadaMs)), [cadaMs])
  return useSyncExternalStore(suscribir, reloj.marca)
}
