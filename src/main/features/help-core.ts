/**
 * Lógica pura de «help» (sin Electron): comparación de versiones x.y.z y filtro de Novedades.
 * Test: S\v5-help\test.mts
 */

const VERSION_RE = /^\d+\.\d+\.\d+$/

export function isVersion(v: unknown): v is string {
  return typeof v === 'string' && VERSION_RE.test(v)
}

/** -1, 0 o 1 según a < b, a = b o a > b. Null si alguna no es x.y.z. */
export function compareVersions(a: unknown, b: unknown): -1 | 0 | 1 | null {
  if (!isVersion(a) || !isVersion(b)) return null
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  return 0
}

/**
 * Entradas con versión mayor que `lastSeen` y menor o igual que `current`, en el mismo orden que
 * llegan. Sin `lastSeen` (primera instalación) no hay novedades.
 */
export function entriesBetween<T extends { version: string }>(entries: readonly T[], lastSeen: string | null, current: string): T[] {
  if (lastSeen === null) return []
  return entries.filter((e) => compareVersions(e.version, lastSeen) === 1 && (compareVersions(e.version, current) ?? 1) <= 0)
}

export interface WhatsNewResult<T> {
  current: string
  lastSeen: string | null
  show: boolean
  entries: T[]
}

export function whatsNewFor<T extends { version: string }>(entries: readonly T[], lastSeen: string | null, current: string): WhatsNewResult<T> {
  const list = entriesBetween(entries, lastSeen, current)
  return { current, lastSeen, show: list.length > 0 && lastSeen !== null, entries: list }
}

/** Lee `lastSeen` de un JSON ya parseado. Si no es una versión válida, null. */
export function parseHelpState(raw: unknown): { lastSeen: string | null } {
  const v = raw && typeof raw === 'object' ? (raw as { lastSeen?: unknown }).lastSeen : undefined
  return { lastSeen: isVersion(v) ? v : null }
}
