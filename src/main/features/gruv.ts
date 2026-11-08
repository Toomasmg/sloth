import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Feature, FeatureContext } from './context'
import { accountStatus } from '../accounts'
import { baseEnv } from '../ptys'
import {
  buildAccionArgs,
  buildAccionPrompt,
  buildArgs,
  buildDetalleArgs,
  buildDetallePrompt,
  buildPrompt,
  normEstado,
  parseAccion,
  parseDetalle,
  resolveClaudeExe,
  runClaude,
  sameTool,
  TICKET_RE,
  NoGruvError,
  ToolMissingError,
  type AccionInput,
  type GruvAccion,
  type GruvDetalle,
  type GruvEstado,
  type GruvTicket,
  type GruvYo
} from './gruv-claude'

/**
 * Tickets de Gruv. Gruv es un conector de claude.ai, así que todo se pide a Claude headless
 * (`claude -p`) con la cuenta que consultó Gruv la última vez:
 * - La lista se lee solo cuando el usuario toca «Actualizar» (solo lectura, ver READ_TOOLS).
 * - El detalle de un ticket (criterios, comentarios, horas) se lee al abrirlo.
 * - Cada escritura (estado, tomar, soltar, comentar, tildar criterio, sumar horas) es UNA llamada
 *   separada que habilita solo la herramienta de esa acción, disparada por un clic del usuario sobre
 *   un ticket concreto. Nunca en automático ni en lote. Ver accion() más abajo.
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
    noDisponible,
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
    noDisponible = {}
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

// ---------- detalle y escrituras (un clic = una llamada con una sola herramienta) ----------
const ACCIONES: GruvAccion[] = ['estado', 'tomar', 'soltar', 'comentar', 'criterio', 'horas']
const MAX_HORAS = 12
const SIN_CONECTOR = 'Esta cuenta no tiene el conector de Gruv. Hacelo desde Gruv.'
/** Detalle de la última lectura por ticket (criterios con id, comentarios, horas). Solo en memoria. */
const detalles = new Map<string, GruvDetalle>()
/** Tickets con una escritura en curso: una por ticket. */
const escribiendo = new Set<string>()
/** Acciones que esta cuenta no puede hacer (herramienta inexistente o sin conector), con el motivo. */
let noDisponible: Partial<Record<GruvAccion, string>> = {}

function ticketEnLista(id: string): GruvTicket {
  const t = state.tickets.find((x) => x.id === id)
  if (!t) throw new Error('Ese ticket ya no está en la lista. Actualizá Gruv.')
  return t
}

/** Cuenta con la que se leen y escriben tickets: la que consultó Gruv la última vez. */
function cuentaGruv(): { exe: string; cwd: string; env: Record<string, string> } {
  const id = state.config.queryAccountId
  if (!id) throw new Error('Actualizá Gruv primero para elegir la cuenta que lo conecta.')
  const acc = ctx.store.account(id)
  if (!acc) throw new Error('La cuenta para consultar Gruv ya no existe. Elegí otra en Configuración.')
  if (!accountStatus(acc).loggedIn) throw new Error(`La cuenta «${acc.label}» no tiene sesión iniciada.`)
  const exe = resolveClaudeExe()
  if (!exe) throw new Error('No encontré el ejecutable de Claude Code (claude.exe) en el PATH.')
  const cwd = join(app.getPath('userData'), 'features', 'gruv-run')
  mkdirSync(cwd, { recursive: true })
  return { exe, cwd, env: { ...baseEnv(), CLAUDE_CONFIG_DIR: acc.configDir } }
}

/** Lectura del detalle al abrir un ticket (criterios con id, comentarios, horas cargadas). */
async function detalle(rawId: unknown): Promise<GruvDetalle> {
  const id = ticketId(rawId)
  ticketEnLista(id)
  const c = cuentaGruv()
  try {
    const d = await runClaude<GruvDetalle>({
      exe: c.exe,
      args: buildDetalleArgs(state.config.model),
      prompt: buildDetallePrompt(id),
      cwd: c.cwd,
      env: c.env,
      timeoutMs: 90_000,
      parse: parseDetalle
    })
    detalles.set(id, d)
    return d
  } catch (e) {
    if (e instanceof NoGruvError) throw new Error(`No pudimos leer el detalle: ${SIN_CONECTOR}`)
    throw e
  }
}

const esMio = (t: GruvTicket): boolean => {
  const me = state.me
  if (!me || !t.responsable) return false
  if (me.id && t.responsableId) return t.responsableId === me.id
  return t.responsable.trim().toLowerCase() === me.nombre.trim().toLowerCase()
}

/**
 * Valida una acción pedida con un clic y la hace con Claude: una llamada, una herramienta.
 * Devuelve el detalle actualizado (si estaba cargado) para que la UI reemplace lo optimista.
 */
async function accion(rawA: unknown, rawId: unknown, rawIn: unknown): Promise<{ detail: GruvDetalle | null }> {
  if (typeof rawA !== 'string' || !ACCIONES.includes(rawA as GruvAccion)) throw new Error('Acción inválida.')
  const a = rawA as GruvAccion
  const id = ticketId(rawId)
  const t = ticketEnLista(id)
  const p = (rawIn && typeof rawIn === 'object' ? rawIn : {}) as Record<string, unknown>
  if (escribiendo.has(id)) throw new Error('Ya hay un cambio en curso en este ticket.')
  const no = noDisponible[a]
  if (no) throw new Error(no)
  const me = state.me

  let input: AccionInput
  switch (a) {
    case 'estado': {
      const estado = typeof p.estado === 'string' ? p.estado : ''
      if (estado === 'cerrado' || !estados().some((e) => e.clave === estado)) throw new Error('Ese estado no está en el flujo de Gruv.')
      if (t.estado === estado) return { detail: detalles.get(id) ?? null }
      input = { ticket: id, estado }
      break
    }
    case 'tomar': {
      if (t.responsable) throw new Error(`Ya lo tiene ${t.responsable}.`)
      if (!me?.id) throw new Error('Falta tu id de Gruv: actualizá la lista para cargarlo.')
      input = { ticket: id, persona: me.id }
      break
    }
    case 'soltar': {
      if (!esMio(t)) throw new Error('Solo podés soltar un ticket que tenés asignado.')
      input = { ticket: id, persona: null }
      break
    }
    case 'comentar': {
      input = { ticket: id, cuerpo: text(p.cuerpo, 2000, 'El comentario', true)! }
      break
    }
    case 'criterio': {
      const cid = typeof p.criterioId === 'string' ? p.criterioId : ''
      if (!detalles.get(id)?.criterios.some((c) => c.id === cid)) throw new Error('Abrí el ticket de nuevo: no encuentro ese criterio.')
      input = { ticket: id, criterioId: cid, hecho: p.hecho === true }
      break
    }
    case 'horas': {
      const h = typeof p.horas === 'number' ? p.horas : NaN
      const minutos = Math.round(h * 60)
      if (!Number.isFinite(h) || h <= 0 || h > MAX_HORAS || minutos < 1)
        throw new Error(`Las horas tienen que ser más de 0 y hasta ${MAX_HORAS}.`)
      input = { ticket: id, horas: minutos, motivo: 'Horas cargadas desde Sloth' }
      break
    }
  }

  const c = cuentaGruv()
  escribiendo.add(id)
  try {
    const r = await runClaude<{ minutosTotal?: number }>({
      exe: c.exe,
      args: buildAccionArgs(state.config.model, a),
      prompt: buildAccionPrompt(a, input),
      cwd: c.cwd,
      env: c.env,
      timeoutMs: 90_000,
      parse: (s) => parseAccion(s, a)
    })
    // Aplicamos al estado local lo que se pidió (y el total de horas que devolvió Gruv, si lo dio).
    switch (a) {
      case 'estado':
        t.estado = input.estado
        break
      case 'tomar':
        t.responsable = me!.nombre
        t.responsableId = me!.id
        break
      case 'soltar':
        delete t.responsable
        delete t.responsableId
        break
      case 'comentar': {
        const d = detalles.get(id)
        if (d) d.comentarios.push({ autor: me?.nombre ?? 'Vos', cuerpo: input.cuerpo!, fecha: new Date().toISOString() })
        break
      }
      case 'criterio': {
        const d = detalles.get(id)!
        const crit = d.criterios.find((x) => x.id === input.criterioId)
        if (crit) crit.hecho = input.hecho!
        t.criterios = d.criterios.map((x) => ({ ...x }))
        break
      }
      case 'horas': {
        const d = detalles.get(id)
        if (d) d.minutos = r.minutosTotal ?? (d.minutos ?? 0) + input.horas!
        break
      }
    }
    ctx.log(`gruv: accion ${a} en ${id}: ok`)
    return { detail: detalles.get(id) ?? null }
  } catch (e) {
    if (e instanceof ToolMissingError) for (const k of sameTool(a)) noDisponible[k] = e.message
    else if (e instanceof NoGruvError) for (const k of ACCIONES) noDisponible[k] = SIN_CONECTOR
    ctx.log(`gruv: accion ${a} en ${id}: error`)
    throw e
  } finally {
    escribiendo.delete(id)
    changed()
  }
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
    c.handle('detail', (id: unknown) => detalle(id))
    c.handle('accion', (a: unknown, id: unknown, p: unknown) => accion(a, id, p))
  },
  dispose() {
    running?.abort()
  }
}

export default feature
