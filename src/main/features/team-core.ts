/**
 * Lógica pura de la vista «Equipo»: parseo de `gh pr list`, resumen de CI y review, y cruce de
 * identidades entre GitHub y el conector de tickets. Sin electron, para probarlo con Node solo.
 */
import type { Estado, Ticket } from '../../shared/tickets'
import { categoriaDe } from '../../shared/tickets'

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

export type CategoriaActiva = 'en_curso' | 'revision' | 'bloqueado'
export const CATEGORIAS_ACTIVAS: readonly CategoriaActiva[] = ['en_curso', 'revision', 'bloqueado']

export interface TeamTicket {
  id: string
  titulo: string
  estado: string
  estadoNombre: string
  categoria: CategoriaActiva
  responsable?: string
  responsableId?: string
  proyecto?: string
  url?: string
}

export interface PersonaConector {
  id?: string
  nombre: string
}

export interface Person {
  key: string
  nombre: string
  /** Logins de GitHub de esta persona (puede tener más de uno). */
  logins: string[]
  idConector?: string
  /** Está en el conector de tickets (tiene tickets activos). */
  enConector: boolean
  isBot?: boolean
  /** Cómo se cruzó GitHub con el conector. */
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

/** Valor del mapeo a mano que dice «este login no es nadie del conector». */
export const NADIE = '-'

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

/** ¿Este autor de GitHub (login + nombre) parece esta persona del conector? */
export function looksLike(login: string, ghName: string | undefined, nombre: string): boolean {
  const g = tokens(nombre)
  if (!g.length) return false
  if (ghName) {
    const h = tokens(ghName)
    if (h.length && normName(ghName) === normName(nombre)) return true
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

/** La `g` queda por compatibilidad: así siguen valiendo los mapeos guardados. */
export const personaKey = (p: PersonaConector): string => (p.id ? `g:${p.id}` : `n:${normName(p.nombre)}`)

/** Los tickets en curso, en revisión o bloqueados, con el nombre y la categoría de su estado. */
export function ticketsActivos(tickets: readonly Ticket[], estados: readonly Estado[]): TeamTicket[] {
  const activa = (c: string): c is CategoriaActiva => (CATEGORIAS_ACTIVAS as readonly string[]).includes(c)
  // Un conector sin estados activos (gh: abierto/cerrado) no dice quién está trabajando: vale lo abierto que tiene responsable.
  const sinActivos = !estados.some((e) => activa(e.categoria))
  const out: TeamTicket[] = []
  for (const t of tickets) {
    const c = categoriaDe(t.estado, estados)
    let categoria: CategoriaActiva
    if (activa(c)) categoria = c
    else if (sinActivos && c !== 'hecho' && t.responsable) categoria = 'en_curso'
    else continue
    const clave = t.estado ?? ''
    const tt: TeamTicket = { id: t.id, titulo: t.titulo, estado: clave, estadoNombre: estados.find((e) => e.clave === clave)?.nombre ?? clave, categoria }
    if (t.responsable) tt.responsable = t.responsable
    if (t.responsableId) tt.responsableId = t.responsableId
    if (t.proyecto) tt.proyecto = t.proyecto
    if (t.url) tt.url = t.url
    out.push(tt)
  }
  return out
}

/** Las personas responsables de esos tickets, sin repetir (por id o por nombre). */
export function personasDe(tickets: readonly TeamTicket[]): PersonaConector[] {
  const out: PersonaConector[] = []
  const vistos = new Set<string>()
  for (const t of tickets) {
    const nombre = t.responsable?.trim() ?? ''
    if (!nombre && !t.responsableId) continue
    const claves = [t.responsableId ? `g:${t.responsableId}` : '', nombre ? `n:${normName(nombre)}` : ''].filter(Boolean)
    if (claves.some((k) => vistos.has(k))) continue
    claves.forEach((k) => vistos.add(k))
    out.push(t.responsableId ? { id: t.responsableId, nombre } : { nombre })
  }
  return out
}

/**
 * Arma las tarjetas: una por persona del conector (con sus tickets) y les suma los PRs de su login de
 * GitHub (mapeo a mano primero; si no, por nombre cuando hay un solo candidato). Los autores de
 * GitHub sin pareja quedan como tarjeta propia.
 */
export function buildPeople(input: {
  prs: TeamPr[]
  tickets: TeamTicket[]
  personas: PersonaConector[]
  mapping: Record<string, string>
}): { people: Person[]; summary: Summary; unassigned: TeamTicket[] } {
  const people = new Map<string, Person>()
  const byNorm = new Map<string, string>()
  const addPersona = (p: PersonaConector): Person | undefined => {
    if (!p.nombre && !p.id) return undefined
    const norm = normName(p.nombre || '')
    // Si ya existe (por id o por nombre), es la misma.
    const existingKey = (p.id && people.has(`g:${p.id}`) ? `g:${p.id}` : undefined) ?? (norm ? byNorm.get(norm) : undefined)
    if (existingKey) {
      const e = people.get(existingKey)!
      if (p.id && !e.idConector) e.idConector = p.id
      return e
    }
    const key = personaKey(p)
    const person: Person = { key, nombre: p.nombre || p.id!, logins: [], enConector: true, tickets: [], prs: [] }
    if (p.id) person.idConector = p.id
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
  const delConector = [...people.values()]
  // Claves de mapeo en minúscula (los logins de GitHub no distinguen mayúsculas).
  const mapping = new Map(Object.entries(input.mapping).map(([k, v]) => [k.toLowerCase(), v]))
  for (const [lower, prs] of groups) {
    const a: Author = { login: prs[0].login, name: prs[0].authorName, isBot: prs[0].isBot }
    let target: Person | undefined
    let how: Person['matchedBy']
    const manual = mapping.get(lower)
    if (manual && manual !== NADIE && people.has(manual)) {
      target = people.get(manual)
      how = 'manual'
    } else if (!manual && !a.isBot) {
      // Con GitHub como conector el id de la persona ES el login: no hace falta adivinar por nombre.
      const mismoLogin = delConector.find((p) => p.idConector?.toLowerCase() === lower)
      const cands = mismoLogin ? [mismoLogin] : delConector.filter((p) => looksLike(a.login, a.name, p.nombre))
      if (cands.length === 1) {
        target = cands[0]
        how = 'auto'
      }
    }
    if (!target) {
      const key = `gh:${lower}`
      target = { key, nombre: a.name || a.login, logins: [], enConector: false, tickets: [], prs: [] }
      if (a.isBot) target.isBot = true
      people.set(key, target)
    } else if (how && target.matchedBy !== 'manual') target.matchedBy = how
    target.logins.push(a.login)
    target.prs.push(...prs)
  }

  for (const p of people.values()) {
    p.prs.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    p.tickets.sort((a, b) => CATEGORIAS_ACTIVAS.indexOf(a.categoria) - CATEGORIAS_ACTIVAS.indexOf(b.categoria) || a.id.localeCompare(b.id))
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
    blocked: tickets.filter((t) => t.categoria === 'bloqueado').length,
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
    if (v === NADIE || /^(g|n):.+/.test(v)) out[k.toLowerCase()] = v
    if (Object.keys(out).length >= 500) break
  }
  return out
}
