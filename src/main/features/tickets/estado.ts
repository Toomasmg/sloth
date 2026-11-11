/**
 * Estado persistido de tickets (tickets.json v2) y la migración desde gruv.json v1. Sin fs: quien
 * llama lee los archivos y hace lo que diga resolverEstado.
 * Módulo puro (lo corre `node --test` con type stripping): sin enums, namespaces ni parameter
 * properties, y los tipos se importan con `type`.
 */
import { MODELOS, type Corrida, type EstadoBase, type Modelo, type Ticket, type TicketsConfig, type Yo } from '../../../shared/tickets'
import { ID_CONECTOR_RE, ID_MAX, ID_SEGURO_RE, type ConectorDef } from './conector'
import { CONECTOR_POR_DEFECTO } from './conectores'
import { idValido, normalizeEstados, normEstado, normYo } from './motor'

export type Lectura = { kind: 'falta' } | { kind: 'corrupto' } | { kind: 'ok'; json: unknown; mtimeMs: number }

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
  migradoDe?: { archivo: 'gruv.json'; en: number }
  config: TicketsConfig
}

export interface ResultadoCarga {
  state: TicketsState
  origen: 'tickets' | 'gruv' | 'vacio'
  respaldar: null | 'corrupto' | 'version-futura'
  guardar: boolean
}

type Buscar = (id: string) => ConectorDef | undefined
type Obj = Record<string, unknown>

const esObjeto = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const numero = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const noVacio = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** Saca las claves undefined: así sanear(sanear(x)) da lo mismo que sanear(x). */
function sinVacios<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k]
  return o
}

export function estadoVacio(conectorId = CONECTOR_POR_DEFECTO): TicketsState {
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

function sanearConfig(raw: unknown): TicketsConfig {
  const c = esObjeto(raw) ? raw : {}
  const repos = esObjeto(c.projectRepos) ? c.projectRepos : {}
  return sinVacios({
    conectorId: typeof c.conectorId === 'string' && ID_CONECTOR_RE.test(c.conectorId) ? c.conectorId : CONECTOR_POR_DEFECTO,
    queryAccountId: noVacio(c.queryAccountId),
    model: MODELOS.includes(c.model as Modelo) ? (c.model as Modelo) : 'haiku',
    assigneeId: typeof c.assigneeId === 'string' ? c.assigneeId : '',
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
  return sinVacios({
    version: 2,
    tickets: sanearTickets(o.tickets, def),
    estados: normalizeEstados(def, o.estados),
    me: normYo(o.me),
    fetchedAt: numero(o.fetchedAt),
    fetchedBy: noVacio(o.fetchedBy),
    lastRun: sanearCorrida(o.lastRun),
    lastError: noVacio(o.lastError),
    migradoDe: m === undefined ? undefined : { archivo: 'gruv.json', en: m },
    config
  })
}

/** Limpia un tickets.json v2 (puede venir editado a mano). null si no es un v2. */
export function sanearEstado(raw: unknown, buscar: Buscar): TicketsState | null {
  if (!esObjeto(raw) || raw.version !== 2) return null
  return armar(raw, sanearConfig(raw.config), buscar, raw.migradoDe)
}

/** gruv.json v1 → v2 con el conector de Gruv. gruv.json no se toca. */
export function migrarDeGruv(raw: unknown, buscar: Buscar, ahora: number): TicketsState | null {
  if (!esObjeto(raw)) return null
  const config = sanearConfig({ ...(esObjeto(raw.config) ? raw.config : {}), conectorId: 'gruv' })
  return armar(raw, config, buscar, { archivo: 'gruv.json', en: ahora })
}

/**
 * El estado al pasar a otro conector: lo leído con el anterior (tickets, columnas, quién sos, la
 * última consulta) no sirve. Se conservan la cuenta, el modelo y los repos.
 */
export function conConector(s: TicketsState, conectorId: string): TicketsState {
  if (s.config.conectorId === conectorId) return s
  return sinVacios({
    version: 2,
    tickets: [],
    migradoDe: s.migradoDe,
    config: { ...s.config, conectorId, assigneeId: '', projectRepos: { ...s.config.projectRepos } }
  })
}

export function resolverEstado(e: { tickets: Lectura; gruv: Lectura }, buscar: Buscar, ahora: number): ResultadoCarga {
  const { tickets, gruv } = e
  let respaldar: ResultadoCarga['respaldar'] = null
  if (tickets.kind === 'ok') {
    const v = esObjeto(tickets.json) ? tickets.json.version : undefined
    if (v === 2) {
      // Si gruv.json es más nuevo, se volvió a usar una versión vieja de Sloth: manda gruv.json.
      const state = sanearEstado(tickets.json, buscar)
      if (state && !(gruv.kind === 'ok' && gruv.mtimeMs > tickets.mtimeMs)) return { state, origen: 'tickets', respaldar, guardar: false }
    } else respaldar = typeof v === 'number' && v > 2 ? 'version-futura' : 'corrupto'
  } else if (tickets.kind === 'corrupto') respaldar = 'corrupto'

  const migrado = gruv.kind === 'ok' ? migrarDeGruv(gruv.json, buscar, ahora) : null
  if (migrado) return { state: migrado, origen: 'gruv', respaldar, guardar: true }
  return { state: estadoVacio(), origen: 'vacio', respaldar, guardar: false }
}
