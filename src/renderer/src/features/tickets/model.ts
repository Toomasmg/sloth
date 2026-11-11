import { useSyncExternalStore } from 'react'
import { esMio, type Detalle, type TicketsSnapshot as Snapshot, type Ticket } from '../../../../shared/tickets'

export type { Accion, Categoria, ConectorInfo, Detalle, Estado, EstadoBase, Ticket, TicketsSnapshot as Snapshot } from '../../../../shared/tickets'

/** Lo que se muestra del detalle: datos, carga o error. */
export interface DetView {
  data?: Detalle
  loading?: boolean
  error?: string
}

/**
 * Cambio optimista de una escritura: el ticket (campos) y/o el detalle se muestran ya y se
 * revierten si el conector no lo acepta.
 */
export interface WriteOpt {
  ticket?: Partial<Ticket>
  det?: (d: Detalle) => Detalle
}

/** Sin tildes y en minúsculas: para buscar «revision» y encontrar «Revisión». */
export const norm = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

/** «Míos»: el responsable es la persona dueña de la cuenta que consulta (`me`). Misma regla que main. */
export const isMine = (t: Pick<Ticket, 'responsable' | 'responsableId'>, me?: Snapshot['me']): boolean => esMio(me, t)

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

/** Las cinco tintas del diseño para avatares (fondo y texto). */
const AVATAR_TINTS: { fg: string; bg: string }[] = [
  { fg: '#a9c7ff', bg: 'rgba(138,180,255,0.18)' },
  { fg: '#c9b8ff', bg: 'rgba(181,156,255,0.18)' },
  { fg: '#7fe0b9', bg: 'rgba(95,212,166,0.16)' },
  { fg: '#f5c77e', bg: 'rgba(240,180,90,0.16)' },
  { fg: '#c9cdd6', bg: '#262b37' }
]

/** Color estable por persona: hash del nombre a una de las cinco tintas. */
export function tintFor(name: string): { fg: string; bg: string } {
  let h = 0
  for (const ch of norm(name.trim())) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_TINTS[h % AVATAR_TINTS.length]
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
export const getSnapshot = (): Snapshot | null => snap
export const useSnapshot = (): Snapshot | null => useSyncExternalStore(subscribe, () => snap)
export const useBoardOpen = (): boolean => useSyncExternalStore(subscribe, () => open)

/** «Tickets de Jira»; sin conector, sin snapshot o con uno que esta versión no tiene, solo «Tickets». */
export const etiquetaTablero = (s: Snapshot | null): string => (s?.conector.disponible ? `Tickets de ${s.conector.nombre}` : 'Tickets')

export function timeAgo(ts: number, now = Date.now()): string {
  const m = Math.round((now - ts) / 60000)
  if (m < 1) return 'recién'
  if (m < 60) return `hace ${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `hace ${h} h`
  const d = Math.round(h / 24)
  return `hace ${d} ${d === 1 ? 'día' : 'días'}`
}

/** Minutos como horas para mostrar: «2 h 30 min», «3 h», «45 min». */
export function fmtHoras(min: number): string {
  if (!min) return 'Sin horas cargadas'
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h && m) return `${h} h ${m} min`
  return h ? `${h} h` : `${m} min`
}
