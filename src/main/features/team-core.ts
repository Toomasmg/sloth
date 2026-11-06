/**
 * Lógica pura de la vista «Equipo»: parseo de `gh pr list`, resumen de CI y review, y cruce de
 * identidades entre GitHub y Gruv. No importa nada (ni electron ni otros archivos) para poder
 * probarlo con Node solo.
 */

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
  /** Cuántos checks pasan / fallan / corren (para el título del chip). */
  checks: { pass: number; fail: number; running: number }
  /** Nombres de los checks que fallan (máx. 5). */
  failing?: string[]
  updatedAt?: number
  createdAt?: number
  url: string
}

export const ACTIVE_ESTADOS = ['en_curso', 'en_revision', 'en_qa', 'bloqueado'] as const
export type ActiveEstado = (typeof ACTIVE_ESTADOS)[number]

export interface TeamTicket {
  id: string
  titulo: string
  estado: ActiveEstado
  responsable?: string
  responsableId?: string
  proyecto?: string
  url?: string
}

export interface GruvPersona {
  id?: string
  nombre: string
}

export interface Person {
  key: string
  nombre: string
  /** Logins de GitHub de esta persona (puede tener más de uno). */
  logins: string[]
  gruvId?: string
  /** Está en Gruv (tiene tickets o salió en el equipo del proyecto). */
  inGruv: boolean
  isBot?: boolean
  /** Cómo se cruzó GitHub con Gruv. */
  matchedBy?: 'manual' | 'auto'
  tickets: TeamTicket[]
  prs: TeamPr[]
}

export interface Summary {
  ciFailing: number
  waitingReview: number
  blocked: number
  prs: number
  tickets: number
}

/** Valor del mapeo a mano que dice «este login no es nadie de Gruv». */
export const NOT_GRUV = '-'

export const TICKET_ID_RE = /^[A-Z][A-Z0-9]*-\d{1,7}$/
export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/
export const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
export const PR_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/pull\/\d{1,9}$/

const str = (v: unknown, max: number): string | undefined => {
  if (typeof v === 'number') v = String(v)
  if (typeof v !== 'string') return undefined
  const s = v.replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, max) : undefined
}

const time = (v: unknown): number | undefined => {
  if (typeof v !== 'string') return undefined
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : undefined
}

// ---------- GitHub ----------

/** `https://github.com/o/r(.git)`, `git@github.com:o/r.git`, `ssh://git@github.com/o/r` → `o/r`. */
export function parseGithubRemote(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  const u = url.trim()
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(u)
  if (!m) return undefined
  const repo = `${m[1]}/${m[2]}`
  return REPO_RE.test(repo) ? repo : undefined
}

const FAIL_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'])

/**
 * Resume `statusCheckRollup`: los CheckRun (Actions) traen status/conclusion y los StatusContext
 * (statuses viejos: Vercel, Prow, Jenkins…) traen state. Si un check se corrió varias veces, vale
 * la última corrida.
 */
export function summarizeChecks(raw: unknown): { ci: CiState; checks: TeamPr['checks']; failing: string[] } {
  const checks = { pass: 0, fail: 0, running: 0 }
  const failing: string[] = []
  if (!Array.isArray(raw)) return { ci: 'none', checks, failing }
  const latest = new Map<string, { state: 'pass' | 'fail' | 'running' | 'skip'; at: number; name: string }>()
  raw.forEach((c, i) => {
    if (!c || typeof c !== 'object') return
    const o = c as Record<string, unknown>
    let state: 'pass' | 'fail' | 'running' | 'skip'
    let name: string
    if (o.__typename === 'StatusContext' || ('state' in o && !('status' in o))) {
      const s = String(o.state ?? '').toUpperCase()
      state = s === 'SUCCESS' ? 'pass' : s === 'FAILURE' || s === 'ERROR' ? 'fail' : 'running'
      name = str(o.context, 120) ?? `status-${i}`
    } else {
      const status = String(o.status ?? '').toUpperCase()
      const concl = String(o.conclusion ?? '').toUpperCase()
      if (status !== 'COMPLETED') state = 'running'
      else if (FAIL_CONCLUSIONS.has(concl)) state = 'fail'
      else if (concl === 'SKIPPED' || concl === 'NEUTRAL') state = 'skip'
      else state = 'pass'
      name = [str(o.workflowName, 80), str(o.name, 120)].filter(Boolean).join(' / ') || `check-${i}`
    }
    const at = time(o.completedAt) ?? time(o.startedAt) ?? 0
    const prev = latest.get(name)
    if (!prev || at >= prev.at) latest.set(name, { state, at, name })
  })
  for (const c of latest.values()) {
    if (c.state === 'skip') continue
    checks[c.state]++
    if (c.state === 'fail' && failing.length < 5) failing.push(c.name)
  }
  const ci: CiState = checks.fail ? 'fail' : checks.running ? 'running' : checks.pass ? 'pass' : latest.size ? 'pass' : 'none'
  return { ci, checks, failing }
}

export function reviewOf(v: unknown): ReviewState {
  const s = String(v ?? '').toUpperCase()
  if (s === 'APPROVED') return 'approved'
  if (s === 'CHANGES_REQUESTED') return 'changes'
  return 'pending'
}

/** Parsea la salida de `gh pr list --json …` (texto o ya parseada). No confía en la forma. */
export function parsePrList(raw: unknown, repo: string): TeamPr[] {
  const data = typeof raw === 'string' ? JSON.parse(raw.trim() || '[]') : raw
  if (!Array.isArray(data)) throw new Error('gh no devolvió una lista de PRs.')
  const out: TeamPr[] = []
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const number = typeof o.number === 'number' && Number.isInteger(o.number) && o.number > 0 ? o.number : undefined
    const url = str(o.url, 300)
    if (!number || !url || !PR_URL_RE.test(url)) continue
    const a = (o.author && typeof o.author === 'object' ? o.author : {}) as Record<string, unknown>
    const login = str(a.login, 60) ?? 'ghost'
    const { ci, checks, failing } = summarizeChecks(o.statusCheckRollup)
    const pr: TeamPr = {
      repo,
      number,
      title: str(o.title, 300) ?? `#${number}`,
      login: LOGIN_RE.test(login) ? login : 'ghost',
      branch: str(o.headRefName, 200) ?? '',
      isDraft: o.isDraft === true,
      review: reviewOf(o.reviewDecision),
      ci,
      checks,
      url
    }
    const name = str(a.name, 100)
    if (name) pr.authorName = name
    if (a.is_bot === true || /\[bot\]$/.test(login) || /^app\//.test(login)) pr.isBot = true
    if (failing.length) pr.failing = failing
    const up = time(o.updatedAt)
    if (up) pr.updatedAt = up
    const cr = time(o.createdAt)
    if (cr) pr.createdAt = cr
    out.push(pr)
  }
  return out
}

/** Agrupa PRs por login (y deja cada grupo del más nuevo al más viejo). */
export function groupByAuthor(prs: TeamPr[]): Map<string, TeamPr[]> {
  const m = new Map<string, TeamPr[]>()
  for (const p of prs) {
    const k = p.login.toLowerCase()
    const list = m.get(k) ?? []
    list.push(p)
    m.set(k, list)
  }
  for (const list of m.values()) list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return m
}

// ---------- identidades ----------

export function normName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}
const tokens = (s: string): string[] => normName(s).split(' ').filter((t) => t.length > 1)

/** ¿Este autor de GitHub (login + nombre) parece esta persona de Gruv? */
export function looksLike(login: string, ghName: string | undefined, gruvName: string): boolean {
  const g = tokens(gruvName)
  if (!g.length) return false
  if (ghName) {
    const h = tokens(ghName)
    if (h.length && normName(ghName) === normName(gruvName)) return true
    // «Tomás Muñoz» ↔ «Tomás Ignacio Muñoz»: todas las palabras del más corto están en el otro (2 o más).
    const [short, long] = h.length <= g.length ? [h, g] : [g, h]
    if (short.length >= 2 && short.every((t) => long.includes(t))) return true
    // Mismo nombre y mismo apellido final.
    if (h.length >= 2 && g.length >= 2 && h[0] === g[0] && h[h.length - 1] === g[g.length - 1]) return true
  }
  // Login armado con el nombre: tomasmunoz, tmunoz, tomas-munoz, munoztomas.
  const l = login.toLowerCase().replace(/\[bot\]$/, '').replace(/[^a-z0-9]/g, '')
  if (g.length >= 2 && l.length >= 4) {
    const first = g[0]
    const last = g[g.length - 1]
    const opts = [first + last, first[0] + last, last + first, first + last[0]]
    if (opts.some((o) => o.length >= 4 && (l === o || l.startsWith(o)))) return true
  }
  return false
}

export interface Author {
  login: string
  name?: string
  isBot?: boolean
}

export const personaKey = (p: GruvPersona): string => (p.id ? `g:${p.id}` : `n:${normName(p.nombre)}`)

/**
 * Arma las tarjetas: una por persona de Gruv (con sus tickets) y les suma los PRs de su login de
 * GitHub (mapeo a mano primero; si no, por nombre cuando hay un solo candidato). Los autores de
 * GitHub sin pareja quedan como tarjeta propia.
 */
export function buildPeople(input: {
  prs: TeamPr[]
  tickets: TeamTicket[]
  personas: GruvPersona[]
  mapping: Record<string, string>
}): { people: Person[]; summary: Summary; unassigned: TeamTicket[] } {
  const people = new Map<string, Person>()
  const byNorm = new Map<string, string>()
  const addPersona = (p: GruvPersona): Person | undefined => {
    if (!p.nombre && !p.id) return undefined
    const norm = normName(p.nombre || '')
    // Si ya existe (por id o por nombre), es la misma.
    const existingKey = (p.id && people.has(`g:${p.id}`) ? `g:${p.id}` : undefined) ?? (norm ? byNorm.get(norm) : undefined)
    if (existingKey) {
      const e = people.get(existingKey)!
      if (p.id && !e.gruvId) e.gruvId = p.id
      return e
    }
    const key = personaKey(p)
    const person: Person = { key, nombre: p.nombre || p.id!, logins: [], inGruv: true, tickets: [], prs: [] }
    if (p.id) person.gruvId = p.id
    people.set(key, person)
    if (norm) byNorm.set(norm, key)
    return person
  }
  for (const p of input.personas) addPersona(p)
  const unassigned: TeamTicket[] = []
  for (const t of input.tickets) {
    if (!t.responsable && !t.responsableId) {
      unassigned.push(t)
      continue
    }
    const person = addPersona({ id: t.responsableId, nombre: t.responsable ?? '' })
    if (person) person.tickets.push(t)
    else unassigned.push(t)
  }

  const groups = groupByAuthor(input.prs)
  const gruvPeople = [...people.values()]
  // Claves de mapeo en minúscula (los logins de GitHub no distinguen mayúsculas).
  const mapping = new Map(Object.entries(input.mapping).map(([k, v]) => [k.toLowerCase(), v]))
  for (const [lower, prs] of groups) {
    const a: Author = { login: prs[0].login, name: prs[0].authorName, isBot: prs[0].isBot }
    let target: Person | undefined
    let how: Person['matchedBy']
    const manual = mapping.get(lower)
    if (manual && manual !== NOT_GRUV && people.has(manual)) {
      target = people.get(manual)
      how = 'manual'
    } else if (!manual && !a.isBot) {
      const cands = gruvPeople.filter((p) => looksLike(a.login, a.name, p.nombre))
      if (cands.length === 1) {
        target = cands[0]
        how = 'auto'
      }
    }
    if (!target) {
      const key = `gh:${lower}`
      target = { key, nombre: a.name || a.login, logins: [], inGruv: false, tickets: [], prs: [] }
      if (a.isBot) target.isBot = true
      people.set(key, target)
    } else if (how && target.matchedBy !== 'manual') target.matchedBy = how
    target.logins.push(a.login)
    target.prs.push(...prs)
  }

  for (const p of people.values()) {
    p.prs.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    p.tickets.sort((a, b) => ACTIVE_ESTADOS.indexOf(a.estado) - ACTIVE_ESTADOS.indexOf(b.estado) || a.id.localeCompare(b.id))
  }
  const list = [...people.values()].sort((a, b) => {
    if (Boolean(a.isBot) !== Boolean(b.isBot)) return a.isBot ? 1 : -1
    const wa = a.tickets.length + a.prs.length
    const wb = b.tickets.length + b.prs.length
    if ((wa > 0) !== (wb > 0)) return wa > 0 ? -1 : 1
    return a.nombre.localeCompare(b.nombre, 'es')
  })
  return { people: list, summary: summarize(input.prs, input.tickets), unassigned }
}

export function summarize(prs: TeamPr[], tickets: TeamTicket[]): Summary {
  return {
    ciFailing: prs.filter((p) => p.ci === 'fail').length,
    waitingReview: prs.filter((p) => !p.isDraft && p.review === 'pending').length,
    blocked: tickets.filter((t) => t.estado === 'bloqueado').length,
    prs: prs.length,
    tickets: tickets.length
  }
}

/** Valida el mapeo guardado (por si se editó el JSON a mano). */
export function cleanMapping(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!LOGIN_RE.test(k) || typeof v !== 'string' || v.length > 200) continue
    if (v === NOT_GRUV || /^(g|n):.+/.test(v)) out[k.toLowerCase()] = v
    if (Object.keys(out).length >= 500) break
  }
  return out
}
