import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MODELOS, type Accion, type Detalle, type EstadoBase, type Modelo, type Ticket, type TicketsConfig, type TicketsSnapshot } from '../../../shared/tickets'
import type { Feature, FeatureContext } from '../context'
import { accountStatus } from '../../accounts'
import { baseEnv } from '../../ptys'
import { aplicarAccion, entradaDeAccion, esAccion, texto, textoObligatorio, ticketId } from './acciones'
import { resolveClaudeExe, runClaude } from './claude-run'
import type { ConectorDef, ConectorGh } from './conector'
import { crearAlmacen, type Almacen, type FsTickets } from './almacen'
import { CONECTOR_POR_DEFECTO, CONECTORES, conectorPorId } from './conectores'
import { ASSIGNEE_MAX, assigneeValido, conConector, type TicketsState } from './estado'
import { ghAccion, ghDetalle, ghLista, ghYo, repoValido, type GhRun } from './gh'
import { GitError, run as correr } from '../git-run'
import { githubRepoOf } from '../team-github'
import {
  accionesSoportadas,
  buildAccionArgs,
  buildAccionPrompt,
  buildDetalleArgs,
  buildDetallePrompt,
  buildListaArgs,
  buildPrompt,
  conCategoria,
  ConectorFaltaError,
  estadosPorDefecto,
  HerramientaFaltaError,
  info,
  leeDetalle,
  mismaHerramienta,
  parseAccion,
  parseClaudeOutput,
  parseDetalle
} from './motor'

/**
 * Tickets del conector elegido. Los de vía mcp son conectores de claude.ai, así que todo se pide a
 * Claude headless (`claude -p`) con la cuenta que consultó la última vez; los de vía gh van directo
 * con GitHub CLI y la sesión de la persona, sin Claude. En los dos casos:
 * - La lista se lee solo cuando el usuario toca «Actualizar» (solo lectura).
 * - El detalle de un ticket (criterios, comentarios, horas) se lee al abrirlo.
 * - Cada escritura (estado, tomar, soltar, comentar, tildar criterio, sumar horas) es UNA llamada
 *   separada que habilita solo la herramienta de esa acción, disparada por un clic del usuario sobre
 *   un ticket concreto. Nunca en automático ni en lote. Ver accion() más abajo.
 */

const DETALLE_TIMEOUT_MS = 90_000

let ctx: FeatureContext
let state: TicketsState
let almacen: Almacen
let running: AbortController | null = null
/** Detalle de la última lectura por ticket (criterios con id, comentarios, horas). Solo en memoria. */
const detalles = new Map<string, Detalle>()
/** Tickets con una escritura en curso: una por ticket. */
const escribiendo = new Set<string>()
/** Acciones que esta cuenta no puede hacer (herramienta inexistente o sin conector), con el motivo. */
let noDisponible: Partial<Record<Accion, string>> = {}

const carpeta = (): string => join(app.getPath('userData'), 'features')
const noEsta = (id: string): string => `El conector «${id}» no está en esta versión de Sloth.`
const sinConector = (def: ConectorDef): string => `Esta cuenta no tiene el conector de ${def.nombre}. Hacelo desde ${def.nombre}.`

const fsReal: FsTickets = {
  leer: (f) => readFileSync(f, 'utf8'),
  mtimeMs: (f) => statSync(f).mtimeMs,
  renombrar: (de, a) => renameSync(de, a),
  escribir: (f, datos) => writeFileSync(f, datos, 'utf8'),
  crearCarpeta: (d) => mkdirSync(d, { recursive: true })
}

const save = (): void => void almacen.guardar(state)

function activo(): ConectorDef {
  const def = conectorPorId(state.config.conectorId)
  if (!def) throw new Error(noEsta(state.config.conectorId))
  return def
}

/** El conector por defecto, para volver a él si el elegido no está en esta versión. */
function alternativa(): { id: string; nombre: string } | undefined {
  const def = conectorPorId(CONECTOR_POR_DEFECTO)
  return def && { id: def.id, nombre: def.nombre }
}

/** Para crear espacios (también desde Equipo, que es de Gruv): el activo o, si no está, el por defecto. */
function paraEspacios(): ConectorDef {
  return conectorPorId(state.config.conectorId) ?? conectorPorId(CONECTOR_POR_DEFECTO) ?? activo()
}

/** Columnas del flujo (si la última consulta no trajo, las del conector). */
const estados = (def: ConectorDef): EstadoBase[] => (state.estados?.length ? [...state.estados] : estadosPorDefecto(def))

function snapshot(): TicketsSnapshot {
  const id = state.config.conectorId
  const def = conectorPorId(id)
  return {
    conector: info(def, id),
    conectores: CONECTORES.map((c) => ({ id: c.id, nombre: c.nombre, verificado: c.verificado, via: c.via })),
    tickets: def ? state.tickets : [],
    estados: def ? conCategoria(def, estados(def)) : [],
    me: state.me,
    fetchedAt: state.fetchedAt,
    fetchedBy: state.fetchedBy,
    lastRun: state.lastRun,
    lastError: def ? state.lastError : noEsta(id),
    aviso: almacen.aviso(),
    config: state.config,
    running: Boolean(running),
    noDisponible,
    lastRepo: lastRepo(),
    porDefecto: def ? undefined : alternativa()
  }
}

function changed(): void {
  save()
  ctx.emit('changed', snapshot())
}

function dir(v: unknown, name: string): string | undefined {
  const s = texto(v, 400, name)
  if (!s) return undefined
  if (!existsSync(s) || !statSync(s).isDirectory()) throw new Error(`${name}: la carpeta no existe.`)
  return s
}

function lastRepo(): string | undefined {
  const ws = [...ctx.store.workspaces].sort((a, b) => b.createdAt - a.createdAt)
  return ws.find((w) => existsSync(w.repoPath))?.repoPath
}

function repoFor(t: Ticket | undefined): string | undefined {
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
  const id = ticketId(paraEspacios(), rawId)
  return Boolean(repoFor(state.tickets.find((t) => t.id === id)))
}

/** «Empezar en Sloth»: crea el espacio del ticket con `/ticket <id>`. */
async function start(rawId: unknown, rawAccount?: unknown): Promise<{ id: string; created: boolean }> {
  const id = ticketId(paraEspacios(), rawId)
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

interface Ejecucion {
  accountId: string
  label: string
  exe: string
  cwd: string
  env: Record<string, string>
}

function ejecucion(def: ConectorDef, accountId: string): Ejecucion {
  const acc = ctx.store.account(accountId)
  if (!acc) throw new Error(`La cuenta para consultar ${def.nombre} ya no existe. Elegí otra en Configuración.`)
  if (!accountStatus(acc).loggedIn) throw new Error(`La cuenta «${acc.label}» no tiene sesión iniciada.`)
  const exe = resolveClaudeExe()
  if (!exe) throw new Error('No encontré el ejecutable de Claude Code (claude.exe) en el PATH.')
  const cwd = join(carpeta(), 'tickets-run')
  mkdirSync(cwd, { recursive: true })
  return { accountId: acc.id, label: acc.label, exe, cwd, env: { ...baseEnv(), CLAUDE_CONFIG_DIR: acc.configDir } }
}

/** Cuenta con la que se leen y escriben tickets: la que consultó la última vez. */
function cuenta(def: ConectorDef): Ejecucion {
  const id = state.config.queryAccountId
  if (!id) throw new Error(`Actualizá ${def.nombre} primero para elegir la cuenta que lo conecta.`)
  return ejecucion(def, id)
}

const ghRun: GhRun = async (args, input) => {
  try {
    return await correr('gh', args, { input, timeoutMs: 30_000 })
  } catch (e) {
    if (e instanceof GitError && e.motivo === 'falta') return { code: -1, stdout: '', stderr: '', missing: true }
    if (e instanceof GitError && e.motivo === 'tiempo') return { code: -1, stdout: '', stderr: '', timedOut: true }
    throw e
  }
}

/** `dueño/repo` del remoto de la carpeta elegida en los ajustes o, si no hay, la del último espacio. */
async function repoGh(): Promise<string> {
  for (const p of [state.config.defaultRepo, lastRepo()]) {
    const repo = p ? await githubRepoOf(p) : undefined
    if (repo) return repoValido(repo)
  }
  throw new Error('Elegí la carpeta de un repo de GitHub en los ajustes de Tickets.')
}

async function refreshGh(def: ConectorGh): Promise<{ count: number }> {
  const ac = new AbortController()
  running = ac
  ctx.emit('changed', snapshot())
  const inicio = Date.now()
  try {
    const repo = await repoGh()
    const me = await ghYo(ghRun)
    const tickets = await ghLista(ghRun, def, repo)
    // gh no se puede cortar a mitad de camino: si cancelaron, se descarta lo leído.
    if (ac.signal.aborted) throw new Error('Consulta cancelada.')
    state.tickets = tickets
    delete state.estados
    state.me = me
    state.fetchedAt = Date.now()
    delete state.fetchedBy
    state.lastRun = { durationMs: Date.now() - inicio }
    delete state.lastError
    noDisponible = {}
    return { count: tickets.length }
  } catch (e) {
    state.lastError = (e as Error).message
    throw e
  } finally {
    running = null
    changed()
  }
}

async function refresh(rawAccount: unknown): Promise<{ count: number; tokens?: number }> {
  if (running) throw new Error('Ya hay una consulta en curso.')
  const def = activo()
  if (def.via === 'gh') return refreshGh(def)
  const requested = typeof rawAccount === 'string' && rawAccount ? rawAccount : undefined
  const run = ejecucion(def, requested ?? state.config.queryAccountId ?? (await pickAccount()))
  const ac = new AbortController()
  running = ac
  ctx.emit('changed', snapshot())
  try {
    const r = await runClaude({
      exe: run.exe,
      args: buildListaArgs(def, state.config.model),
      prompt: buildPrompt(def, state.config.assigneeId),
      cwd: run.cwd,
      env: run.env,
      quien: def.nombre,
      signal: ac.signal,
      parse: (s) => parseClaudeOutput(def, s)
    })
    state.tickets = r.tickets
    if (r.estados?.length) state.estados = r.estados
    if (r.me) state.me = r.me
    state.fetchedAt = Date.now()
    state.fetchedBy = run.accountId
    state.lastRun = { tokens: r.tokens, costUsd: r.costUsd, durationMs: r.durationMs }
    delete state.lastError
    noDisponible = {}
    state.config.queryAccountId = run.accountId
    return { count: r.tickets.length, tokens: r.tokens }
  } catch (e) {
    const msg = e instanceof ConectorFaltaError ? `«${run.label}»: ${e.message}` : (e as Error).message
    state.lastError = msg
    throw new Error(msg)
  } finally {
    running = null
    changed()
  }
}

/** El conector al que se pasa, o undefined si es el mismo. No cambia nada. */
function conectorNuevo(v: unknown): ConectorDef | undefined {
  const def = typeof v === 'string' ? conectorPorId(v) : undefined
  if (!def) throw new Error('Ese conector no está en esta versión de Sloth.')
  if (def.id === state.config.conectorId) return undefined
  if (running || escribiendo.size) throw new Error('Esperá a que termine lo que está en curso para cambiar de conector.')
  return def
}

/** Todo se valida sobre una copia: si algo falla, no queda nada aplicado a medias. */
function setConfig(raw: unknown): TicketsSnapshot {
  if (!raw || typeof raw !== 'object') throw new Error('Configuración inválida.')
  const p = raw as Record<string, unknown>
  const nuevo = 'conectorId' in p ? conectorNuevo(p.conectorId) : undefined
  const c: TicketsConfig = { ...state.config, projectRepos: { ...state.config.projectRepos } }
  if ('queryAccountId' in p) {
    const id = p.queryAccountId
    if (id === undefined || id === null || id === '') delete c.queryAccountId
    else if (typeof id !== 'string' || !ctx.store.account(id)) throw new Error('Esa cuenta no existe.')
    else c.queryAccountId = id
  }
  if ('model' in p) {
    if (!MODELOS.includes(p.model as Modelo)) throw new Error('Modelo inválido.')
    c.model = p.model as Modelo
  }
  if ('assigneeId' in p) {
    const s = texto(p.assigneeId, ASSIGNEE_MAX, 'El id de persona') ?? ''
    const def = conectorPorId(nuevo?.id ?? state.config.conectorId)
    if (!assigneeValido(s, def))
      throw new Error(def ? `Ese id de persona no tiene el formato de ${def.nombre}.` : 'El id de persona solo lleva letras, números y guiones.')
    c.assigneeId = s
  }
  if ('defaultRepo' in p) c.defaultRepo = dir(p.defaultRepo, 'Repo por defecto')
  if ('projectRepo' in p) {
    const pr = (p.projectRepo && typeof p.projectRepo === 'object' ? p.projectRepo : {}) as Record<string, unknown>
    const project = textoObligatorio(pr.project, 80, 'El proyecto')
    const repo = dir(pr.repo, `Repo de ${project}`)
    if (repo) c.projectRepos[project] = repo
    else delete c.projectRepos[project]
  }
  if ('confirmRefresh' in p) c.confirmRefresh = p.confirmRefresh !== false
  if (nuevo) {
    // Pasar a otro conector deja de lado lo leído con el anterior.
    state = conConector(state, nuevo.id)
    noDisponible = {}
    detalles.clear()
    c.conectorId = nuevo.id
    if (!('assigneeId' in p)) c.assigneeId = ''
  }
  state.config = c
  changed()
  return snapshot()
}

function ticketEnLista(def: ConectorDef, id: string): Ticket {
  const t = state.tickets.find((x) => x.id === id)
  if (!t) throw new Error(`Ese ticket ya no está en la lista. Actualizá ${def.nombre}.`)
  return t
}

/** Lectura del detalle al abrir un ticket (criterios con id, comentarios, horas cargadas). */
async function detalle(rawId: unknown): Promise<Detalle> {
  const def = activo()
  if (!leeDetalle(def)) throw new Error(`${def.nombre} no tiene detalle de tickets en Sloth.`)
  const id = ticketId(def, rawId)
  const t = ticketEnLista(def, id)
  if (def.via === 'gh') {
    const d = await ghDetalle(ghRun, t)
    if (state.config.conectorId === def.id) detalles.set(id, d)
    return d
  }
  const c = cuenta(def)
  try {
    const d = await runClaude({
      exe: c.exe,
      args: buildDetalleArgs(def, state.config.model),
      prompt: buildDetallePrompt(def, id),
      cwd: c.cwd,
      env: c.env,
      quien: def.nombre,
      timeoutMs: DETALLE_TIMEOUT_MS,
      parse: (s) => parseDetalle(def, s)
    })
    // Si mientras tanto se cambió de conector, este detalle ya no es de la lista.
    if (state.config.conectorId === def.id) detalles.set(id, d)
    return d
  } catch (e) {
    if (e instanceof ConectorFaltaError) throw new Error(`No pudimos leer el detalle: ${sinConector(def)}`)
    throw e
  }
}

/**
 * Valida una acción pedida con un clic y la hace con Claude (una llamada, una herramienta) o con gh.
 * Devuelve el detalle actualizado (si estaba cargado) para que la UI reemplace lo optimista.
 */
async function accion(rawA: unknown, rawId: unknown, rawIn: unknown): Promise<{ detail: Detalle | null }> {
  if (!esAccion(rawA)) throw new Error('Acción inválida.')
  const a = rawA
  const def = activo()
  if (!accionesSoportadas(def).includes(a)) throw new Error(`${def.nombre} no permite esa acción desde Sloth.`)
  const id = ticketId(def, rawId)
  const t = ticketEnLista(def, id)
  if (escribiendo.has(id)) throw new Error('Ya hay un cambio en curso en este ticket.')
  const no = noDisponible[a]
  if (no) throw new Error(no)
  const input = entradaDeAccion(def, a, t, rawIn, { estados: estados(def), me: state.me, detalle: detalles.get(id) })
  if (!input) return { detail: detalles.get(id) ?? null }

  const c = def.via === 'mcp' ? cuenta(def) : undefined
  escribiendo.add(id)
  try {
    let minutosTotal: number | undefined
    if (def.via === 'gh') await ghAccion(ghRun, t, a, input, state.me)
    else if (c) {
      const r = await runClaude({
        exe: c.exe,
        args: buildAccionArgs(def, state.config.model, a),
        prompt: buildAccionPrompt(def, a, input),
        cwd: c.cwd,
        env: c.env,
        quien: def.nombre,
        timeoutMs: DETALLE_TIMEOUT_MS,
        parse: (s) => parseAccion(def, s, a)
      })
      minutosTotal = r.minutosTotal
    }
    aplicarAccion(a, t, input, { me: state.me, detalle: detalles.get(id), minutosTotal, fecha: new Date().toISOString() })
    ctx.log(`tickets(${def.id}): accion ${a} en ${id}: ok`)
    return { detail: detalles.get(id) ?? null }
  } catch (e) {
    if (e instanceof HerramientaFaltaError) for (const k of mismaHerramienta(def, a)) noDisponible[k] = e.message
    else if (e instanceof ConectorFaltaError) for (const k of accionesSoportadas(def)) noDisponible[k] = sinConector(def)
    ctx.log(`tickets(${def.id}): accion ${a} en ${id}: error`)
    throw e
  } finally {
    escribiendo.delete(id)
    changed()
  }
}

const feature: Feature = {
  name: 'tickets',
  register(c) {
    ctx = c
    almacen = crearAlmacen({ fs: fsReal, carpeta: carpeta(), buscar: conectorPorId, log: (m) => c.log(m), ahora: Date.now })
    state = almacen.cargar()
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
