import { useSyncExternalStore } from 'react'

/** Lo que manda main (`feat:gruv:state` / `feat:gruv:changed`). Ver src/main/features/gruv.ts. */
export interface GruvCriterio {
  texto: string
  hecho: boolean
}

export interface Ticket {
  id: string
  titulo: string
  /** Clave de estado de Gruv (`abierto`, `en_curso`, `en_revision`…). */
  estado?: string
  prioridad?: string
  proyecto?: string
  url?: string
  responsable?: string
  responsableId?: string
  descripcion?: string
  criterios?: GruvCriterio[]
}

export interface GruvEstado {
  clave: string
  nombre: string
}

export interface Snapshot {
  tickets: Ticket[]
  /** Estados en el orden del flujo de Gruv. */
  estados: GruvEstado[]
  me?: { id?: string; nombre: string }
  fetchedAt?: number
  fetchedBy?: string
  lastRun?: { tokens?: number; costUsd?: number; durationMs?: number }
  lastError?: string
  config: {
    queryAccountId?: string
    model: 'haiku' | 'sonnet' | 'opus'
    assigneeId: string
    confirmRefresh: boolean
  }
  running: boolean
}

/** Sin tildes y en minúsculas: para buscar «revision» y encontrar «Revisión». */
export const norm = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

/** «Míos»: el responsable es la persona dueña de la cuenta que consulta (`me`). */
export function isMine(t: Pick<Ticket, 'responsable' | 'responsableId'>, me?: Snapshot['me']): boolean {
  if (!me || !t.responsable) return false
  if (me.id && t.responsableId) return t.responsableId === me.id
  return norm(t.responsable) === norm(me.nombre)
}

/** Orden de prioridad conocido; lo que no se reconoce va al final. */
export function prioRank(p?: string): number {
  if (!p) return 9
  const s = norm(p)
  if (/crit|urg|bloq/.test(s)) return 0
  if (/alta|high/.test(s)) return 1
  if (/media|mid|normal/.test(s)) return 2
  if (/baja|low/.test(s)) return 3
  return 4
}

// ---------- estado compartido entre la barra de título y la pantalla ----------
let snap: Snapshot | null = null
let open = false
const subs = new Set<() => void>()
const notify = (): void => subs.forEach((s) => s())
const subscribe = (cb: () => void): (() => void) => {
  subs.add(cb)
  return () => {
    subs.delete(cb)
  }
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
