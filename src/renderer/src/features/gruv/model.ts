import { useSyncExternalStore } from 'react'

/** Columna = clave de estado de Gruv (`abierto`, `en_curso`, `en_revision`…). */
export type ColumnKey = string
export interface Column {
  clave: string
  nombre: string
}
/** Soltar acá crea el espacio del ticket. */
export const DOING = 'en_curso'

export interface Ticket {
  id: string
  titulo: string
  estado?: string
  prioridad?: string
  proyecto?: string
  url?: string
  manual?: boolean
}

export interface Snapshot {
  tickets: Ticket[]
  manual: Ticket[]
  overrides: Record<string, { col: ColumnKey; gruvEstado?: string }>
  /** Columnas en el orden del tablero de Gruv (de `ver_flujo_tickets`, o las conocidas). */
  columns: Column[]
  fetchedAt?: number
  fetchedBy?: string
  lastRun?: { tokens?: number; costUsd?: number; durationMs?: number }
  lastError?: string
  config: {
    queryAccountId?: string
    model: 'haiku' | 'sonnet' | 'opus'
    assigneeId: string
    defaultRepo?: string
    projectRepos: Record<string, string>
    confirmRefresh: boolean
  }
  running: boolean
  lastRepo?: string
}

/** Columna donde va un ticket: la que eligió el usuario en Sloth o la de su estado en Gruv. */
export function columnFor(
  t: { id: string; estado?: string },
  snap: Pick<Snapshot, 'columns' | 'overrides'>,
  hasWorkspace: boolean
): ColumnKey {
  const has = (k?: string): k is string => Boolean(k) && snap.columns.some((c) => c.clave === k)
  const o = snap.overrides[t.id]?.col
  if (has(o)) return o
  if (has(t.estado)) return t.estado
  return hasWorkspace && has(DOING) ? DOING : (snap.columns[0]?.clave ?? DOING)
}

/** Texto corto del estado de Gruv para la tarjeta. */
export const estadoLabel = (estado: string): string => estado.replace(/_/g, ' ')

// ---------- estado compartido entre la barra de título y el tablero ----------
let snap: Snapshot | null = null
let open = false
const subs = new Set<() => void>()
const notify = (): void => subs.forEach((s) => s())
const subscribe = (cb: () => void): (() => void) => {
  subs.add(cb)
  return () => subs.delete(cb)
}

export const setSnapshot = (s: Snapshot): void => {
  snap = s
  notify()
}
export const setBoardOpen = (v: boolean): void => {
  open = v
  notify()
}
export const useSnapshot = (): Snapshot | null => useSyncExternalStore(subscribe, () => snap)
export const useBoardOpen = (): boolean => useSyncExternalStore(subscribe, () => open)

export function timeAgo(ts: number, now = Date.now()): string {
  const m = Math.round((now - ts) / 60000)
  if (m < 1) return 'recién'
  if (m < 60) return `hace ${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `hace ${h} h`
  const d = Math.round(h / 24)
  return `hace ${d} ${d === 1 ? 'día' : 'días'}`
}
