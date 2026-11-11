/**
 * Lectura de team.json. La v1 guardaba además los tickets y la configuración de su propia consulta;
 * desde la v2 los tickets son los del conector de Tickets y acá queda solo GitHub y el mapeo de personas.
 * Módulo puro: lo corre `node --test` con type stripping.
 */
import { cleanMapping, PR_URL_RE, type TeamPr } from './team-core'

export interface TeamState {
  version: 2
  github: { prs: TeamPr[]; repos: string[]; errors: Record<string, string>; fatal?: string; fetchedAt?: number }
  /** Mapeo de antes de que fuera por conector: se pasa al primer conector activo con `adoptarLegado`. */
  mapping: Record<string, string>
  /** id del conector → (login de GitHub en minúscula → clave de persona, o «-» = no es nadie del conector). */
  mappings: Record<string, Record<string, string>>
  /** La v1 traía tickets de Gruv: sirve para avisar que hay que elegir el conector en Tickets. */
  veniaDeGruv?: true
}

export type MotivoSoloLectura = 'futuro' | 'ilegible' | 'sin-respaldo'

export function avisoSoloLectura(m: MotivoSoloLectura): string {
  switch (m) {
    case 'futuro':
      return 'team.json es de una versión más nueva de Sloth: lo que vincules no se guarda.'
    case 'ilegible':
      return 'No se pudo leer team.json (puede tenerlo abierto otro programa): lo que vincules no se guarda.'
    case 'sin-respaldo':
      return 'No se pudo respaldar team.json antes de actualizarlo: lo que vincules no se guarda.'
  }
}

export type CargaTeam =
  | { kind: 'vacio'; state: TeamState }
  | { kind: 'ok'; state: TeamState; migrado: boolean }
  | { kind: 'corrupto'; state: TeamState }
  | { kind: 'futuro'; state: TeamState }

export function estadoTeamVacio(): TeamState {
  return { version: 2, github: { prs: [], repos: [], errors: {} }, mapping: {}, mappings: {} }
}

const objeto = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

function github(raw: unknown): TeamState['github'] {
  const gh = objeto(raw) ?? {}
  const errors: Record<string, string> = {}
  for (const [k, v] of Object.entries(objeto(gh.errors) ?? {})) if (typeof v === 'string') errors[k] = v
  return {
    prs: Array.isArray(gh.prs) ? gh.prs.filter((p): p is TeamPr => Boolean(objeto(p)) && typeof p.url === 'string' && PR_URL_RE.test(p.url)) : [],
    repos: Array.isArray(gh.repos) ? gh.repos.filter((r): r is string => typeof r === 'string') : [],
    errors,
    fatal: typeof gh.fatal === 'string' ? gh.fatal : undefined,
    fetchedAt: typeof gh.fetchedAt === 'number' ? gh.fetchedAt : undefined
  }
}

function mappingsPorConector(raw: unknown): TeamState['mappings'] {
  const out: TeamState['mappings'] = {}
  for (const [id, m] of Object.entries(objeto(raw) ?? {})) {
    if (!id || id.length > 100) continue
    const limpio = cleanMapping(m)
    if (Object.keys(limpio).length) out[id] = limpio
    if (Object.keys(out).length >= 50) break
  }
  return out
}

export function mappingDe(state: TeamState, conectorId: string): Record<string, string> {
  return state.mappings[conectorId] ?? {}
}

/** Devuelve true si movió algo; lo que el conector ya tenía vinculado gana sobre el mapeo viejo. */
export function adoptarLegado(state: TeamState, conectorId: string | null): boolean {
  if (!conectorId || Object.keys(state.mapping).length === 0) return false
  state.mappings[conectorId] = { ...state.mapping, ...mappingDe(state, conectorId) }
  state.mapping = {}
  return true
}

/** `texto` null = el archivo no existe. */
export function cargarTeam(texto: string | null): CargaTeam {
  if (texto === null) return { kind: 'vacio', state: estadoTeamVacio() }
  let datos: unknown
  try {
    datos = JSON.parse(texto.replace(/^﻿/, ''))
  } catch {
    return { kind: 'corrupto', state: estadoTeamVacio() }
  }
  const raw = objeto(datos)
  if (!raw) return { kind: 'corrupto', state: estadoTeamVacio() }
  const version = typeof raw.version === 'number' ? raw.version : 1
  const state: TeamState = { version: 2, github: github(raw.github), mapping: cleanMapping(raw.mapping), mappings: mappingsPorConector(raw.mappings) }
  const gruv = objeto(raw.gruv)
  if (raw.veniaDeGruv === true || (version < 2 && (Boolean(gruv && Array.isArray(gruv.tickets) && gruv.tickets.length) || typeof objeto(raw.config)?.queryAccountId === 'string'))) {
    state.veniaDeGruv = true
  }
  if (version > 2) return { kind: 'futuro', state }
  return { kind: 'ok', state, migrado: version < 2 }
}
