/**
 * Lectura de team.json. La v1 guardaba los tickets de Gruv y su configuración; desde la v2 los
 * tickets son los del conector de Tickets y acá queda solo GitHub y el mapeo de personas.
 * Módulo puro: lo corre `node --test` con type stripping.
 */
import { cleanMapping, PR_URL_RE, type TeamPr } from './team-core'

export interface TeamState {
  version: 2
  github: { prs: TeamPr[]; repos: string[]; errors: Record<string, string>; fatal?: string; fetchedAt?: number }
  /** login de GitHub (minúscula) → clave de persona del conector, o «-» = no es nadie del conector. */
  mapping: Record<string, string>
}

export type CargaTeam =
  | { kind: 'vacio'; state: TeamState }
  | { kind: 'ok'; state: TeamState; migrado: boolean }
  | { kind: 'corrupto'; state: TeamState }
  | { kind: 'futuro'; state: TeamState }

export function estadoTeamVacio(): TeamState {
  return { version: 2, github: { prs: [], repos: [], errors: {} }, mapping: {} }
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
  const state: TeamState = { version: 2, github: github(raw.github), mapping: cleanMapping(raw.mapping) }
  if (version > 2) return { kind: 'futuro', state }
  return { kind: 'ok', state, migrado: version < 2 }
}
