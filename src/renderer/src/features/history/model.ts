import type { SessionInfo, SessionRow } from './types'
import { matchesAll, wordsOf } from '../help/text'

export type Range = 'hoy' | '7' | '30'
export const RANGES: { id: Range; name: string; maxDay: number }[] = [
  { id: 'hoy', name: 'Hoy', maxDay: 0 },
  { id: '7', name: '7 días', maxDay: 6 },
  { id: '30', name: '30 días', maxDay: 29 }
]

const DAY_MS = 86_400_000
const startOfDay = (ms: number): number => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 0 = hoy, 1 = ayer, … */
export const dayIndex = (ms: number, now = Date.now()): number => Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS)

export function dayLabel(ms: number, now = Date.now()): string {
  const i = dayIndex(ms, now)
  if (i === 0) return 'Hoy'
  if (i === 1) return 'Ayer'
  const s = new Date(ms).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' })
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export const fmtTime = (ms: number): string => new Date(ms).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false })

export function durLabel(start: number, end: number): string {
  const m = Math.max(1, Math.round((end - start) / 60_000))
  return m >= 60 ? (m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 60)} h`) : `${m} min`
}

export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** Color estable por espacio (tokens del tema, nunca solo color: el nombre va al lado). */
const PALETTE = ['var(--accent)', 'var(--success)', 'var(--warn)', 'var(--info)', 'var(--team)', 'var(--fg-muted)']
export function spaceColor(key: string): string {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

/** Texto plano para «Copiar resumen». */
export function plainSummary(s: SessionInfo): string {
  const head = `${s.title}\n${fmtDay(s.start)} · ${fmtTime(s.start)} · ${s.spaceName} · ${s.accountLabel}`
  return s.lastAnswer ? `${head}\n\n${s.lastAnswer}` : head
}

const fmtDay = (ms: number): string => new Date(ms).toLocaleDateString('es-AR')

export interface Filters {
  q: string
  space: string
  acc: string
  range: Range
  showHidden: boolean
}

/** Qué sesiones entran con los filtros (la búsqueda de texto es aparte: `textKeys`). */
export function filterRows(
  rows: SessionRow[],
  f: Filters,
  hidden: Set<string>,
  textKeys: Set<string>,
  now = Date.now()
): SessionRow[] {
  const words = wordsOf(f.q)
  const maxDay = RANGES.find((r) => r.id === f.range)?.maxDay ?? 29
  return rows.filter((r) => {
    if (f.acc !== 'todas' && r.accountId !== f.acc) return false
    if (f.space !== 'todos' && r.spaceKey !== f.space) return false
    if (dayIndex(r.start, now) > maxDay) return false
    const isHidden = hidden.has(r.key)
    if (isHidden && !f.showHidden) return false
    if (words.length === 0) return true
    if (textKeys.has(r.key)) return true
    return matchesAll([r.title, r.spaceName, r.accountLabel, r.branch, ...r.files.map((x) => x.path)].join(' '), words)
  })
}

/** Espacios que aparecen en la lista (para el filtro), con cuántas conversaciones tienen. */
export function spaceOptions(rows: SessionRow[], f: Pick<Filters, 'acc' | 'range' | 'showHidden'>, hidden: Set<string>, now = Date.now()) {
  const maxDay = RANGES.find((r) => r.id === f.range)?.maxDay ?? 29
  const map = new Map<string, { key: string; name: string; n: number; color: string }>()
  for (const r of rows) {
    if (f.acc !== 'todas' && r.accountId !== f.acc) continue
    if (dayIndex(r.start, now) > maxDay) continue
    if (hidden.has(r.key) && !f.showHidden) continue
    const cur = map.get(r.spaceKey) ?? { key: r.spaceKey, name: r.spaceName, n: 0, color: spaceColor(r.spaceKey) }
    cur.n++
    map.set(r.spaceKey, cur)
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'))
}

/** Clave para pedir/recordar el detalle de una fila. */
export const rowKey = (r: { accountId: string; sessionId: string }): string => `${r.accountId}:${r.sessionId}`

export function groupRows(rows: SessionRow[], pinned: Set<string>, now = Date.now()) {
  const pins = rows.filter((r) => pinned.has(r.key)).sort((a, b) => b.start - a.start)
  const rest = rows.filter((r) => !pinned.has(r.key)).sort((a, b) => b.start - a.start)
  const days: { label: string; n: number; items: SessionRow[] }[] = []
  for (const r of rest) {
    const label = dayLabel(r.start, now)
    const last = days[days.length - 1]
    if (last && last.label === label) {
      last.items.push(r)
      last.n++
    } else days.push({ label, n: 1, items: [r] })
  }
  return { pins, days }
}

export function statusOf(r: SessionRow, livePermissionSpaces: Set<string>): 'perm' | 'ok' | 'int' {
  if (r.spaceId && livePermissionSpaces.has(r.spaceId)) return 'perm'
  return r.status
}

export const STATUS_LABEL = { perm: 'Esperando permiso', ok: 'Terminada', int: 'Interrumpida' } as const
