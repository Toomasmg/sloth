import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { listPermissions, type PermissionsList } from './api'

/** Qué se muestra encima de la app: la revisión de pedidos (con un id inicial) o el panel de decisiones. */
export interface PermissionUiState {
  review: { id: string | null } | null
  decisions: boolean
}

let uiState: PermissionUiState = { review: null, decisions: false }
const uiListeners = new Set<() => void>()

const setUi = (next: PermissionUiState): void => {
  uiState = next
  uiListeners.forEach((l) => l())
}

/** Abre la revisión de pedidos. Con `id`, arranca en ese pedido. */
export const openPermissionReview = (id?: string | null): void => setUi({ review: { id: id ?? null }, decisions: false })
export const openPermissionDecisions = (): void => setUi({ review: null, decisions: true })
export const closePermissionUi = (): void => setUi({ review: null, decisions: false })

export function usePermissionUi(): PermissionUiState {
  return useSyncExternalStore(
    (l) => {
      uiListeners.add(l)
      return () => {
        uiListeners.delete(l)
      }
    },
    () => uiState,
    () => uiState
  )
}

/** Lista de la función (reglas y decisiones de hoy). Se vuelve a leer cuando main avisa un cambio. */
export function usePermissionsList(): { data: PermissionsList | null; refresh: () => void; error: string | null } {
  const [data, setData] = useState<PermissionsList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(() => {
    listPermissions()
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'No se pudo leer.'))
  }, [])
  useEffect(() => {
    refresh()
    return window.sloth.feat.on('feat:permissions:changed', refresh)
  }, [refresh])
  return { data, refresh, error }
}

/** Hora HH:MM en español (local). */
export const hhmm = (ms: number): string => new Date(ms).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
