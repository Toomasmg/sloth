import { useEffect, useState } from 'react'
import { useUi } from '../host'

export type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
export interface NoteGroup {
  id: string
  label: string
  items: string[]
}
export interface UpdateStatus {
  state: UpdateState
  version?: string
  releaseDate?: string
  notes?: NoteGroup[]
  percent?: number
  transferred?: number
  total?: number
  error?: string
  checkedAt?: number
  upToDate?: boolean
  later?: boolean
  queued?: boolean
  channel: 'estable' | 'beta'
  enabled: boolean
  current: string
}

/** Estado del updater: se pide una vez al montar y después llega por eventos (sin polling). */
export function useUpdateStatus(): UpdateStatus | null {
  const ui = useUi()
  const [st, setSt] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    let alive = true
    ui.invoke<UpdateStatus>('feat:updater:status').then((s) => alive && setSt(s), () => {})
    const off = ui.on('feat:updater:status', (s: UpdateStatus) => setSt(s))
    return () => {
      alive = false
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return st
}

/**
 * Punto del acceso a Configuración: «Más tarde» dejó una versión pendiente. Lo usa quien monta la
 * barra superior (el integrador): `<UpdateDot />` o este hook para pintarlo donde corresponda.
 */
export function useUpdateDot(): boolean {
  const st = useUpdateStatus()
  return !!st && !!st.later && (st.state === 'available' || st.state === 'downloading' || st.state === 'ready')
}
