import { CHAT_RETENTION_HOURS, type ChatNotice, type ChatRetentionHours, type ChatRole } from './chat'

const HOUR_MS = 3_600_000

export const isRetentionHours = (v: unknown): v is ChatRetentionHours =>
  typeof v === 'number' && (CHAT_RETENTION_HOURS as readonly number[]).includes(v)

/** Plazo que llega por IPC: uno de los permitidos o null (apagado). */
export function parseRetention(raw: unknown): ChatRetentionHours | null {
  if (raw === null) return null
  if (!isRetentionHours(raw)) throw new Error('Plazo inválido.')
  return raw
}

/** Columna `retention_hours` → plazo; lo que no es un plazo permitido cuenta como apagado. */
export const retentionOf = (v: unknown): ChatRetentionHours | undefined => (isRetentionHours(v) ? v : undefined)

export function isExpired(createdAt: number, hours: ChatRetentionHours | undefined, now: number): boolean {
  return hours !== undefined && createdAt <= now - hours * HOUR_MS
}

export function dropExpired<T extends { createdAt: number }>(list: T[], hours: ChatRetentionHours | undefined, now: number): T[] {
  if (hours === undefined) return list
  const kept = list.filter((m) => !isExpired(m.createdAt, hours, now))
  return kept.length === list.length ? list : kept
}

export function retentionLabel(hours: ChatRetentionHours | null | undefined): string {
  if (hours === 24) return '24 horas'
  if (hours === 168) return '7 días'
  if (hours === 720) return '30 días'
  if (hours === 2160) return '90 días'
  return 'Nunca'
}

/** Quién puede cambiar el borrado automático o vaciar: owner o admin en un equipo; en un DM, cualquiera. */
export function canManageConv(kind: 'team' | 'dm', role: ChatRole | undefined): boolean {
  return kind === 'dm' || role === 'owner' || role === 'admin'
}

/** Columnas `kind` y `body` de un aviso → aviso; undefined si es un mensaje común o no se reconoce. */
export function noticeFromRow(kind: unknown, body: unknown): ChatNotice | undefined {
  if (kind === 'clear') return { kind: 'clear' }
  if (kind !== 'retention' || typeof body !== 'string' || !/^\d{1,4}$/.test(body)) return undefined
  const hours = Number(body)
  if (hours === 0) return { kind: 'retention', hours: null }
  return isRetentionHours(hours) ? { kind: 'retention', hours } : undefined
}

export function noticeText(notice: ChatNotice, login: string): string {
  if (notice.kind === 'clear') return `${login} vació la conversación`
  if (notice.hours === null) return `${login} desactivó el borrado automático`
  return `${login} activó el borrado automático: ${retentionLabel(notice.hours)}`
}
