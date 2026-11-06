import { useEffect, useState } from 'react'
import { useUi } from '../host'

export type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
export interface UpdateStatus {
  state: UpdateState
  version?: string
  percent?: number
  error?: string
  checkedAt?: number
  upToDate?: boolean
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
