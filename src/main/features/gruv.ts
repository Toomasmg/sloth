import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Feature, FeatureContext } from './context'
import { accountStatus } from '../accounts'
import { baseEnv } from '../ptys'
import {
  buildArgs,
  buildPrompt,
  normEstado,
  resolveClaudeExe,
  runClaude,
  TICKET_RE,
  NoGruvError,
  type GruvEstado,
  type GruvTicket,
  type GruvYo
} from './gruv-claude'

/**
 * Tickets de Gruv. Gruv es un conector de claude.ai, así que la lista se pide a Claude headless
 * (`claude -p`) con la cuenta elegida, solo cuando el usuario toca «Actualizar». Es de solo lectura:
 * no hay forma de cambiar nada en Gruv desde acá (estado, asignación, comentarios, horas), y la
 * consulta niega explícitamente las herramientas de escritura (ver WRITE_TOOLS en gruv-claude.ts).
 */

/** Estados de Gruv por si `ver_flujo_tickets` no devuelve nada. */
const DEFAULT_ESTADOS: GruvEstado[] = [
  { clave: 'abierto', nombre: 'Abierto' },
  { clave: 'en_curso', nombre: 'En curso' },
  { clave: 'bloqueado', nombre: 'Bloqueado' },
  { clave: 'en_revision', nombre: 'En revisión' },
  { clave: 'pre_rtd', nombre: 'Pre RTD' },
  { clave: 'en_qa', nombre: 'En QA' },
  { clave: 'rechazado', nombre: 'Rechazado' }
]
const MODELS = ['haiku', 'sonnet', 'opus'] as const
/** Vacío = la persona dueña de la cuenta que consulta (Claude la resuelve con ver_mi_inicio). */
const DEFAULT_ASSIGNEE = ''

interface GruvConfig {
  queryAccountId?: string
  model: (typeof MODELS)[number]
  assigneeId: string
  defaultRepo?: string
  projectRepos: Record<string, string>
  confirmRefresh: boolean
}

interface GruvState {
  version: 1
  /** Tickets no cerrados de todo el equipo, como los devolvió la última consulta. */
  tickets: GruvTicket[]
  /** Columnas de `ver_flujo_tickets` de la última consulta. */
  estados?: GruvEstado[]
  /** Quién sos en Gruv (de la última consulta). */
  me?: GruvYo
  fetchedAt?: number
  fetchedBy?: string
  lastRun?: { tokens?: number; costUsd?: number; durationMs?: number }
  lastError?: string
  config: GruvConfig
}

const emptyState = (): GruvState => ({
  version: 1,
  tickets: [],
  config: { model: 'haiku', assigneeId: DEFAULT_ASSIGNEE, projectRepos: {}, confirmRefresh: true }
})

let ctx: FeatureContext
let state: GruvState
let file = ''
let running: AbortController | null = null

function load(): GruvState {
  const base = emptyState()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as Partial<GruvState>
    return {
      ...base,
      version: 1,
      tickets: Array.isArray(raw.tickets) ? raw.tickets : [],
      estados: Array.isArray(raw.estados) ? raw.estados : undefined,
      me: raw.me && typeof raw.me === 'object' && typeof raw.me.nombre === 'string' ? raw.me : undefined,
      fetchedAt: raw.fetchedAt,
      fetchedBy: raw.fetchedBy,
      lastRun: raw.lastRun,
      lastError: raw.lastError,
      config: { ...base.config, ...(raw.config ?? {}), projectRepos: { ...(raw.config?.projectRepos ?? {}) } }
    }
  } catch {
    return base
  }
}

function save(): void {
  mkdirSync(join(app.getPath('userData'), 'features'), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** Columnas del flujo de Gruv (siempre con al menos los conocidos). */
const estados = (): GruvEstado[] => (state.estados?.length ? [...state.estados] : [...DEFAULT_ESTADOS])

function snapshot(): unknown {
  return {
    tickets: state.tickets,
    estados: estados(),
    me: state.me,
    fetchedAt: state.fetchedAt,
    fetchedBy: state.fetchedBy,
    lastRun: state.lastRun,
    lastError: state.lastError,
    config: state.config,
    running: Boolean(running),
    lastRepo: lastRepo()
  }
}

function changed(): void {
  save()
  ctx.emit('changed', snapshot())
}

// ---------- validación ----------
function ticketId(v: unknown): string {
  const id = typeof v === 'string' ? v.trim().toUpperCase() : ''
  if (!TICKET_RE.test(id)) throw new Error('El ticket tiene que ser tipo TCK-1234.')
  return id
}
function text(v: unknown, max: number, name: string, required = false): string | undefined {
  if (v === undefined || v === null || v === '') {
    if (required) throw new Error(`Falta ${name}.`)
    return undefined
  }
  if (typeof v !== 'string') throw new Error(`${name} no es válido.`)
  const s = v.replace(/\s+/g, ' ').trim()
  if (required && !s) throw new Error(`Falta ${name}.`)
  if (s.length > max) throw new Error(`${name} es demasiado largo (máx. ${max}).`)
  return s || undefined
}
function dir(v: unknown, name: string): string | undefined {
  const s = text(v, 400, name)
  if (!s) return undefined
  if (!existsSync(s) || !statSync(s).isDirectory()) throw new Error(`${name}: la carpeta no existe.`)
  return s
}

// ---------- espacios ----------
function lastRepo(): string | undefined {
  const ws = [...ctx.store.workspaces].sort((a, b) => b.createdAt - a.createdAt)
  return ws.find((w) => existsSync(w.repoPath))?.repoPath
}

function repoFor(t: GruvTicket | undefined): string | undefined {
  const byProject = t?.proyecto ? state.config.projectRepos[t.proyecto] : undefined
  for (const p of [byProject, state.config.defaultRepo, lastRepo()]) {
    if (p && existsSync(p)) return p
  }
  return undefined
}

const tot = (u?: { input: number; output: number; cacheWrite: number; cacheRead: number }): number =>
  u ? u.input + u.output + u.cacheWrite + u.cacheRead : 0

/** Cuenta con sesión iniciada y menos uso en las últimas 5 h. */
async function pickAccount(): Promise<string> {
  const logged = ctx.store.accounts.filter((a) => accountStatus(a).loggedIn)
  if (!logged.length) throw new Error('No hay ninguna cuenta con sesión iniciada.')
  let usage = ctx.usage.latest
  if (!Object.keys(usage).length) usage = await ctx.usage.scan(ctx.store.accounts)
  return [...logged].sort((a, b) => tot(usage[a.id]?.last5h) - tot(usage[b.id]?.last5h))[0].id
}

/** ¿Hay una carpeta de repo para crear el espacio de este ticket? (sin crear nada). */
function hasRepo(rawId: unknown): boolean {
  const id = ticketId(rawId)
  return Boolean(repoFor(state.tickets.find((t) => t.id === id)))
}

/** «Empezar en Sloth»: crea el espacio del ticket con `/ticket <id>`. */
async function start(rawId: unknown, rawAccount?: unknown): Promise<{ id: string; created: boolean }> {
  const id = ticketId(rawId)
  const existing = ctx.store.workspaces.find((w) => w.ticket?.toUpperCase() === id)
  if (existing) {
    ctx.ui({ type: 'open-pane', id: existing.id })
    return { id: existing.id, created: false }
  }
  const repoPath = repoFor(state.tickets.find((t) => t.id === id))
  if (!repoPath) throw new Error('No hay carpeta de repo para este ticket. Creá el espacio desde Nuevo espacio y elegí la carpeta.')
  let accountId: string
  if (typeof rawAccount === 'string' && rawAccount) {
    const acc = ctx.store.account(rawAccount)
    if (!acc || !accountStatus(acc).loggedIn) throw new Error('Esa cuenta no tiene sesión iniciada.')
    accountId = acc.id
  } else accountId = await pickAccount()
  const ws = await ctx.addWorkspace({
    name: id,
    repoPath,
    accountId,
    autoStartClaude: true,
    ticket: id,
    initialPrompt: `/ticket ${id}`,
    resume: true
  })
  ctx.ui({ type: 'open-pane', id: ws.id })
  return { id: ws.id, created: true }
}

// ---------- consulta a Gruv ----------
async function refresh(rawAccount: unknown): Promise<unknown> {
  if (running) throw new Error('Ya hay una consulta en curso.')
  const requested = typeof rawAccount === 'string' && rawAccount ? rawAccount : undefined
  const accountId = requested ?? state.config.queryAccountId ?? (await pickAccount())
  const acc = ctx.store.account(accountId)
  if (!acc) throw new Error('La cuenta para consultar Gruv ya no existe. Elegí otra en Configuración.')
  if (!accountStatus(acc).loggedIn) throw new Error(`La cuenta «${acc.label}» no tiene sesión iniciada.`)
  const exe = resolveClaudeExe()
  if (!exe) throw new Error('No encontré el ejecutable de Claude Code (claude.exe) en el PATH.')
  const cwd = join(app.getPath('userData'), 'features', 'gruv-run')
  mkdirSync(cwd, { recursive: true })
  const ac = new AbortController()
  running = ac
  ctx.emit('changed', snapshot())
  try {
    const r = await runClaude({
      exe,
      args: buildArgs(state.config.model),
      prompt: buildPrompt(state.config.assigneeId),
      cwd,
      env: { ...baseEnv(), CLAUDE_CONFIG_DIR: acc.configDir },
      signal: ac.signal
    })
    state.tickets = r.tickets
    if (r.estados?.length) state.estados = r.estados
    if (r.me) state.me = r.me
    state.fetchedAt = Date.now()
    state.fetchedBy = acc.id
    state.lastRun = { tokens: r.tokens, costUsd: r.costUsd, durationMs: r.durationMs }
    state.lastError = undefined
    state.config.queryAccountId = acc.id
    return { count: r.tickets.length, tokens: r.tokens }
  } catch (e) {
    const msg = e instanceof NoGruvError ? `«${acc.label}»: ${e.message}` : (e as Error).message
    state.lastError = msg
    throw new Error(msg)
  } finally {
    running = null
    changed()
  }
}

function setConfig(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') throw new Error('Configuración inválida.')
  const p = raw as Record<string, unknown>
  const c = state.config
  if ('queryAccountId' in p) {
    const id = p.queryAccountId
    if (id !== undefined && id !== null && id !== '' && (typeof id !== 'string' || !ctx.store.account(id)))
      throw new Error('Esa cuenta no existe.')
    c.queryAccountId = (id as string) || undefined
  }
  if ('model' in p) {
    if (!MODELS.includes(p.model as (typeof MODELS)[number])) throw new Error('Modelo inválido.')
    c.model = p.model as (typeof MODELS)[number]
  }
  if ('assigneeId' in p) {
    const s = text(p.assigneeId, 80, 'El id de persona') ?? ''
    if (s && !/^[A-Za-z0-9-]+$/.test(s)) throw new Error('El id de persona solo lleva letras, números y guiones.')
    c.assigneeId = s
  }
  if ('defaultRepo' in p) c.defaultRepo = dir(p.defaultRepo, 'Repo por defecto')
  if ('projectRepo' in p) {
    const pr = p.projectRepo as { project?: unknown; repo?: unknown }
    const project = text(pr?.project, 80, 'El proyecto', true)!
    const repo = dir(pr?.repo, `Repo de ${project}`)
    if (repo) c.projectRepos[project] = repo
    else delete c.projectRepos[project]
  }
  if ('confirmRefresh' in p) c.confirmRefresh = p.confirmRefresh !== false
  changed()
  return snapshot()
}

const feature: Feature = {
  name: 'gruv',
  register(c) {
    ctx = c
    file = join(app.getPath('userData'), 'features', 'gruv.json')
    state = load()
    // Limpieza por si el archivo se editó a mano.
    state.tickets = state.tickets.filter((t) => t && TICKET_RE.test(String(t.id)))
    for (const t of state.tickets) t.estado = normEstado(t.estado)
    c.handle('state', () => snapshot())
    c.handle('refresh', (acc: unknown) => refresh(acc))
    c.handle('cancel', () => {
      running?.abort()
      return true
    })
    c.handle('setConfig', (p: unknown) => setConfig(p))
    c.handle('hasRepo', (id: unknown) => hasRepo(id))
    c.handle('start', (id: unknown, acc: unknown) => start(id, acc))
  },
  dispose() {
    running?.abort()
  }
}

export default feature
