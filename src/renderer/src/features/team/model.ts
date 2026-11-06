import { useSyncExternalStore } from 'react'

/** Lo que manda main (`feat:team:state` / `feat:team:changed`). Ver src/main/features/team-core.ts. */
export type CiState = 'pass' | 'fail' | 'running' | 'none'
export type ReviewState = 'approved' | 'changes' | 'pending'

export interface TeamPr {
  repo: string
  number: number
  title: string
  login: string
  authorName?: string
  isBot?: boolean
  branch: string
  isDraft: boolean
  review: ReviewState
  ci: CiState
  checks: { pass: number; fail: number; running: number }
  failing?: string[]
  updatedAt?: number
  createdAt?: number
  url: string
}

export interface TeamTicket {
  id: string
  titulo: string
  estado: 'en_curso' | 'en_revision' | 'en_qa' | 'bloqueado'
  responsable?: string
  responsableId?: string
  proyecto?: string
  url?: string
}

export interface Person {
  key: string
  nombre: string
  logins: string[]
  gruvId?: string
  inGruv: boolean
  isBot?: boolean
  matchedBy?: 'manual' | 'auto'
  tickets: TeamTicket[]
  prs: TeamPr[]
}

export interface TeamSnapshot {
  people: Person[]
  summary: { ciFailing: number; waitingReview: number; blocked: number; prs: number; tickets: number }
  unassigned: TeamTicket[]
  gruvPeople: { key: string; nombre: string }[]
  authors: { login: string; name?: string }[]
  mapping: Record<string, string>
  github: { repos: string[]; errors: Record<string, string>; fatal?: string; fetchedAt?: number }
  gruv: {
    fetchedAt?: number
    fetchedBy?: string
    lastRun?: { tokens?: number; costUsd?: number; durationMs?: number }
    lastError?: string
    running: boolean
  }
  githubRunning: boolean
  config: { queryAccountId?: string; model: 'haiku' | 'sonnet'; espacio?: string; proyecto?: string; confirmGruv: boolean }
}

export const NOT_GRUV = '-'
export const PR_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/pull\/\d{1,9}$/
/** GitHub es barato: al volver a la ventana se actualiza si pasaron más de 5 min. */
export const STALE_MS = 5 * 60_000

export const ESTADO_LABEL: Record<TeamTicket['estado'], string> = {
  en_curso: 'En curso',
  en_revision: 'En revisión',
  en_qa: 'En QA',
  bloqueado: 'Bloqueado'
}

const HUES = ['#9FEAF9', '#C4A7FF', '#F9A8D4', '#86EFAC', '#FCD34D', '#7DD3FC', '#FDBA74', '#BEF264', '#F0ABFC', '#A5B4FC']
export function personColor(key: string): string {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return HUES[h % HUES.length]
}

export function initials(name: string): string {
  const parts = name
    .replace(/\[bot\]$/i, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function timeAgo(ts: number, now = Date.now()): string {
  const m = Math.round((now - ts) / 60000)
  if (m < 1) return 'recién'
  if (m < 60) return `hace ${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `hace ${h} h`
  const d = Math.round(h / 24)
  return `hace ${d} ${d === 1 ? 'día' : 'días'}`
}

/** Antigüedad corta para el chip del PR: 3 h, 2 d, 5 sem. */
export function age(ts: number, now = Date.now()): string {
  const h = (now - ts) / 3_600_000
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`
  if (h < 24) return `${Math.round(h)} h`
  const d = h / 24
  if (d < 14) return `${Math.round(d)} d`
  return `${Math.round(d / 7)} sem`
}

// ---------- estado compartido (barra de título, paleta y vista) ----------
let snap: TeamSnapshot | null = null
let open = false
const subs = new Set<() => void>()
const notify = (): void => subs.forEach((s) => s())
const subscribe = (cb: () => void): (() => void) => {
  subs.add(cb)
  return () => subs.delete(cb)
}
export const setTeamSnapshot = (s: TeamSnapshot): void => {
  snap = s
  notify()
}
export const setTeamOpen = (v: boolean): void => {
  open = v
  notify()
}
export const useTeamSnapshot = (): TeamSnapshot | null => useSyncExternalStore(subscribe, () => snap)
export const useTeamOpen = (): boolean => useSyncExternalStore(subscribe, () => open)
