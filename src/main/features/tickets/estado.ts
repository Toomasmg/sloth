/**
 * Estado persistido de tickets (tickets.json v2) y la migración desde gruv.json v1. Sin fs: quien
 * llama lee los archivos y hace lo que diga resolverEstado (ver almacen.ts).
 * Módulo puro (lo corre `node --test` con type stripping): sin enums, namespaces ni parameter
 * properties, y los tipos se importan con `type`.
 */
import { MODELOS, SIN_CONECTOR, type Corrida, type EstadoBase, type Modelo, type Ticket, type TicketsConfig, type Yo } from '../../../shared/tickets'
import { ID_CONECTOR_RE, ID_MAX, ID_SEGURO_RE, regexDePersona, type ConectorDef } from './conector'
import { CONECTOR_LEGADO } from './conectores'
import { idValido, normalizeEstados, normEstado, normYo } from './motor'

/** 'error': el archivo está pero no se pudo leer (bloqueado, sin permiso…); no es lo mismo que corrupto. */
export type Lectura = { kind: 'falta' } | { kind: 'corrupto' } | { kind: 'error'; mensaje: string } | { kind: 'ok'; json: unknown; mtimeMs: number }

export interface TicketsState {
  version: 2
  /** Tickets no hechos de todo el equipo, como los devolvió la última consulta. */
  tickets: Ticket[]
  estados?: EstadoBase[]
  me?: Yo
  fetchedAt?: number
  fetchedBy?: string
  lastRun?: Corrida
  lastError?: string
  /** gruvMtimeMs: el mtime del gruv.json migrado; si gruv.json cambia, se vuelve a migrar. */
  migradoDe?: { archivo: 'gruv.json'; en: number; gruvMtimeMs?: number }
  config: TicketsConfig
}

export interface ResultadoCarga {
  state: TicketsState
  origen: 'tickets' | 'gruv' | 'vacio'
  /** Antes de guardar, tickets.json se aparta: ilegible (.corrupt) o válido pero reemplazado (.bak). */
  respaldar: null | 'corrupto' | 'previo'
  guardar: boolean
  /** Si no es null, tickets.json no se toca en toda la sesión: se trabaja en memoria. */
  soloLectura: null | 'ilegible' | 'version-futura' | 'gruv-ilegible'
}

export type Buscar = (id: string) => ConectorDef | undefined
type Obj = Record<string, unknown>

const esObjeto = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const numero = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const noVacio = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

export const ASSIGNEE_MAX = 80
const ASSIGNEE_RE = /^[A-Za-z0-9-]+$/
/** El id de persona va al prompt de la lista: vacío o con la forma que pide el conector (si no pide ninguna, letras, números y guiones). */
export const assigneeValido = (s: string, def?: ConectorDef): boolean =>
  s === '' || (s.length <= ASSIGNEE_MAX && (def?.personaId ? regexDePersona(def) : ASSIGNEE_RE).test(s))

/** Saca las claves undefined: así sanear(sanear(x)) da lo mismo que sanear(x). */
function sinVacios<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k]
  return o
}

export function estadoVacio(conectorId: string = SIN_CONECTOR): TicketsState {
  return { version: 2, tickets: [], config: { conectorId, model: 'haiku', assigneeId: '', projectRepos: {}, confirmRefresh: true } }
}

export function parsearArchivo(texto: string | null, mtimeMs = 0): Lectura {
  if (texto === null) return { kind: 'falta' }
  try {
    return { kind: 'ok', json: JSON.parse(texto.replace(/^﻿/, '')), mtimeMs }
  } catch {
    return { kind: 'corrupto' }
  }
}

const PREVIO_CLAVE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/
const PREVIOS_MAX = 20

function sanearPrevios(raw: unknown, buscar: Buscar): Record<string, string> | undefined {
  if (!esObjeto(raw)) return undefined
  const out: Record<string, string> = {}
  let n = 0
  for (const [k, v] of Object.entries(raw)) {
    if (n >= PREVIOS_MAX) break
    if (!PREVIO_CLAVE_RE.test(k) || typeof v !== 'string' || !v || v.length > ASSIGNEE_MAX) continue
    const def = buscar(k)
    if (def && !assigneeValido(v, def)) continue
    out[k] = v
    n++
  }
  return n ? out : undefined
}

function sanearConfig(raw: unknown, buscar: Buscar): TicketsConfig {
  const c = esObjeto(raw) ? raw : {}
  const repos = esObjeto(c.projectRepos) ? c.projectRepos : {}
  const conectorId =
    c.conectorId === SIN_CONECTOR ? SIN_CONECTOR : typeof c.conectorId === 'string' && ID_CONECTOR_RE.test(c.conectorId) ? c.conectorId : CONECTOR_LEGADO
  return sinVacios({
    conectorId,
    queryAccountId: noVacio(c.queryAccountId),
    model: MODELOS.includes(c.model as Modelo) ? (c.model as Modelo) : 'haiku',
    assigneeId: typeof c.assigneeId === 'string' && assigneeValido(c.assigneeId, buscar(conectorId)) ? c.assigneeId : '',
    assigneePrevios: sanearPrevios(c.assigneePrevios, buscar),
    defaultRepo: noVacio(c.defaultRepo),
    projectRepos: Object.fromEntries(Object.entries(repos).filter((e): e is [string, string] => typeof e[1] === 'string')),
    confirmRefresh: c.confirmRefresh !== false
  })
}

function sanearTickets(raw: unknown, def: ConectorDef | undefined): Ticket[] {
  if (!Array.isArray(raw)) return []
  const out: Ticket[] = []
  for (const t of raw) {
    if (!esObjeto(t)) continue
    // Con un conector que no está en esta versión no se sabe validar el id: solo se acota.
    const id = def ? idValido(def, t.id) : typeof t.id === 'string' && t.id.length <= ID_MAX && ID_SEGURO_RE.test(t.id) ? t.id : null
    if (!id) continue
    out.push(sinVacios({ ...(t as unknown as Ticket), id, estado: normEstado(t.estado) }))
  }
  return out
}

function sanearCorrida(raw: unknown): Corrida | undefined {
  if (!esObjeto(raw)) return undefined
  return sinVacios({ tokens: numero(raw.tokens), costUsd: numero(raw.costUsd), durationMs: numero(raw.durationMs) })
}

function armar(o: Obj, config: TicketsConfig, buscar: Buscar, migradoDe: unknown): TicketsState {
  const def = buscar(config.conectorId)
  const m = esObjeto(migradoDe) && migradoDe.archivo === 'gruv.json' ? numero(migradoDe.en) : undefined
  const gruvMtimeMs = esObjeto(migradoDe) ? numero(migradoDe.gruvMtimeMs) : undefined
  return sinVacios({
    version: 2,
    tickets: sanearTickets(o.tickets, def),
    estados: normalizeEstados(def, o.estados),
    me: normYo(def, o.me),
    fetchedAt: numero(o.fetchedAt),
    fetchedBy: noVacio(o.fetchedBy),
    lastRun: sanearCorrida(o.lastRun),
    lastError: noVacio(o.lastError),
    migradoDe: m === undefined ? undefined : sinVacios({ archivo: 'gruv.json' as const, en: m, gruvMtimeMs }),
    config
  })
}

/** Limpia un tickets.json v2 (puede venir editado a mano). null si no es un v2. */
export function sanearEstado(raw: unknown, buscar: Buscar): TicketsState | null {
  if (!esObjeto(raw) || raw.version !== 2) return null
  return armar(raw, sanearConfig(raw.config, buscar), buscar, raw.migradoDe)
}

/** gruv.json v1 → v2 con el conector de Gruv. gruv.json no se toca. */
export function migrarDeGruv(raw: unknown, buscar: Buscar, ahora: number, gruvMtimeMs: number): TicketsState | null {
  if (!esObjeto(raw)) return null
  const config = sanearConfig({ ...(esObjeto(raw.config) ? raw.config : {}), conectorId: CONECTOR_LEGADO }, buscar)
  return armar(raw, config, buscar, { archivo: 'gruv.json', en: ahora, gruvMtimeMs })
}

/** Lo leído (tickets, columnas, quién sos, la última consulta) fuera; la config queda igual. */
export function sinLista(s: TicketsState): TicketsState {
  return sinVacios({ version: 2, tickets: [], migradoDe: s.migradoDe, config: s.config })
}

/**
 * El estado al pasar a otro conector: lo leído con el anterior no sirve. Se conservan la cuenta, el
 * modelo y los repos, y el id de persona de cada conector queda guardado para cuando se vuelva a él.
 */
export function conConector(s: TicketsState, conectorId: string): TicketsState {
  if (s.config.conectorId === conectorId) return s
  const previos = { ...s.config.assigneePrevios }
  if (s.config.assigneeId && s.config.conectorId !== SIN_CONECTOR) previos[s.config.conectorId] = s.config.assigneeId
  const assigneeId = previos[conectorId] ?? ''
  delete previos[conectorId]
  const config = sinVacios({
    ...s.config,
    conectorId,
    assigneeId,
    assigneePrevios: Object.keys(previos).length ? previos : undefined,
    projectRepos: { ...s.config.projectRepos }
  })
  return { ...sinLista(s), config }
}

export function resolverEstado(e: { tickets: Lectura; gruv: Lectura }, buscar: Buscar, ahora: number): ResultadoCarga {
  const { tickets, gruv } = e
  // Quien tiene gruv.json (aunque esté dañado o no se pueda leer) ya usaba Gruv: no queda sin conector.
  const vacioSegunGruv = (): TicketsState => estadoVacio(gruv.kind === 'falta' ? SIN_CONECTOR : CONECTOR_LEGADO)
  const migrar = (): TicketsState | null => (gruv.kind === 'ok' ? migrarDeGruv(gruv.json, buscar, ahora, gruv.mtimeMs) : null)
  const enMemoria = (soloLectura: NonNullable<ResultadoCarga['soloLectura']>): ResultadoCarga => {
    const m = migrar()
    return { state: m ?? vacioSegunGruv(), origen: m ? 'gruv' : 'vacio', respaldar: null, guardar: false, soloLectura }
  }

  if (tickets.kind === 'error') return enMemoria('ilegible')
  let respaldar: ResultadoCarga['respaldar'] = tickets.kind === 'corrupto' ? 'corrupto' : null
  if (tickets.kind === 'ok') {
    const v = esObjeto(tickets.json) ? tickets.json.version : undefined
    if (typeof v === 'number' && v > 2) return enMemoria('version-futura')
    const state = sanearEstado(tickets.json, buscar)
    if (state) {
      // gruv.json cambió desde que se migró: se volvió a usar una versión vieja de Sloth y manda gruv.json.
      const m = gruv.kind === 'ok' && gruv.mtimeMs !== state.migradoDe?.gruvMtimeMs ? migrar() : null
      if (m) return { state: m, origen: 'gruv', respaldar: 'previo', guardar: true, soloLectura: null }
      return { state, origen: 'tickets', respaldar: null, guardar: false, soloLectura: null }
    }
    respaldar = 'corrupto'
  }

  // Sin tickets.json válido, guardar dejaría uno sin migradoDe y el próximo arranque lo pisaría con gruv.json.
  if (gruv.kind === 'error') return enMemoria('gruv-ilegible')
  const m = migrar()
  if (m) return { state: m, origen: 'gruv', respaldar, guardar: true, soloLectura: null }
  return { state: vacioSegunGruv(), origen: 'vacio', respaldar, guardar: false, soloLectura: null }
}
