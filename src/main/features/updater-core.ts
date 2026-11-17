export type UpdateChannel = 'estable' | 'beta'

export interface Postponed {
  version: string
  day: string
}

export interface ReleaseNote {
  note?: string | null
}

export const EVERY_MS = 6 * 60 * 60 * 1000

export function localDay(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function parsePostponed(raw: unknown): Postponed | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<Postponed>
  return typeof r.version === 'string' && typeof r.day === 'string' ? { version: r.version, day: r.day } : null
}

export const isPostponedOn = (p: Postponed | null, version: string, day: string): boolean => !!p && p.version === version && p.day === day

export function parseChannel(raw: unknown): UpdateChannel {
  const r = raw as Record<string, unknown> | null | undefined
  return r?.updateChannel === 'beta' ? 'beta' : 'estable'
}

export function friendly(e: unknown): string {
  const msg = String((e as Error)?.message ?? e ?? '')
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|net::/i.test(msg)) return 'No hay conexión con GitHub.'
  if (/404|No published versions|Cannot find latest/i.test(msg)) return 'Todavía no hay versiones publicadas.'
  if (/sha512 checksum mismatch/i.test(msg)) return 'La descarga llegó dañada; se reintenta en el próximo chequeo.'
  return msg.split('\n')[0].slice(0, 200) || 'Error desconocido.'
}

export const notesText = (releaseNotes: string | ReleaseNote[] | null | undefined): string => {
  if (typeof releaseNotes === 'string') return releaseNotes
  if (Array.isArray(releaseNotes)) return releaseNotes.map((x) => x.note ?? '').filter(Boolean).join('\n\n')
  return ''
}

export const nextCheckDelay = (lightMode: boolean): number => (lightMode ? EVERY_MS * 2 : EVERY_MS)
