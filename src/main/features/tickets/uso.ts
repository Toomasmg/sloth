/**
 * Límites de una corrida de `claude -p` y lo que gastó. Módulo puro (lo corre `node --test` con type
 * stripping): sin enums, namespaces ni parameter properties, y los tipos se importan con `type`.
 */
import type { UsoAcum, UsoPorDia } from '../../../shared/tickets'
import { ID_CONECTOR_RE } from './conector'

export const VUELTAS_DEFECTO = 40
export const VUELTAS_MIN = 1
export const VUELTAS_MAX = 200
export const COSTO_MIN = 0.01
export const COSTO_MAX = 100
const DIAS_MAX = 60
const CONECTORES_MAX = 50
const DIA_RE = /^\d{4}-\d{2}-\d{2}$/

export type Tope = 'vueltas' | 'costo'

export interface UsoCorrida {
  costUsd?: number
  durationMs?: number
  numTurns?: number
  tokens?: number
  tope?: Tope
}

export function vueltasValidas(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= VUELTAS_MIN && v <= VUELTAS_MAX ? v : undefined
}

export function costoValido(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  const r = Math.round(v * 100) / 100
  return r >= COSTO_MIN && r <= COSTO_MAX ? r : undefined
}

const numero = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const esObjeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const TOKENS_CLAVES = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']

function resultadoDe(stdout: string): Record<string, unknown> | undefined {
  const t = stdout.trim()
  if (!t) return undefined
  const esResultado = (m: unknown): m is Record<string, unknown> => esObjeto(m) && m.type === 'result'
  try {
    const j: unknown = JSON.parse(t)
    if (Array.isArray(j)) return j.findLast(esResultado)
    return esResultado(j) ? j : undefined
  } catch {
    for (const l of t.split(/\r?\n/).reverse()) {
      try {
        const j: unknown = JSON.parse(l)
        if (esResultado(j)) return j
      } catch {
        continue
      }
    }
    return undefined
  }
}

export function leerUso(stdout: string): UsoCorrida | undefined {
  const env = resultadoDe(stdout)
  if (!env) return undefined
  const usage = esObjeto(env.usage) ? env.usage : undefined
  const sumas = usage ? TOKENS_CLAVES.map((k) => numero(usage[k])).filter((n): n is number => n !== undefined) : []
  const tope: Tope | undefined = env.subtype === 'error_max_turns' ? 'vueltas' : env.subtype === 'error_max_budget_usd' ? 'costo' : undefined
  const uso: UsoCorrida = {
    costUsd: numero(env.total_cost_usd),
    durationMs: numero(env.duration_ms),
    numTurns: numero(env.num_turns),
    tokens: sumas.length ? sumas.reduce((a, b) => a + b, 0) : undefined,
    tope
  }
  for (const k of Object.keys(uso) as (keyof UsoCorrida)[]) if (uso[k] === undefined) delete uso[k]
  return uso
}

export class TopeVueltasError extends Error {
  tope: Tope
  uso: UsoCorrida
  constructor(mensaje: string, tope: Tope, uso: UsoCorrida) {
    super(mensaje)
    this.name = 'TopeVueltasError'
    this.tope = tope
    this.uso = uso
  }
}

export function textoTope(tope: Tope, limite: number, accion?: boolean): string {
  const base =
    tope === 'vueltas'
      ? `La consulta se cortó por tope de vueltas (${limite}). Podés continuar con más vueltas o subir el tope en los ajustes.`
      : `La consulta se cortó por tope de costo (US$ ${limite}). Podés subir el tope en los ajustes.`
  return accion ? `${base} Revisá el ticket: el cambio pudo quedar a medias.` : base
}

const cero = (): UsoAcum => ({ corridas: 0, costUsd: 0, vueltas: 0, durationMs: 0 })

export function sumarUso(uso: UsoPorDia | undefined, dia: string, conectorId: string, u: UsoCorrida): UsoPorDia {
  const previo = uso?.[dia]?.[conectorId] ?? cero()
  const nuevo: UsoAcum = {
    corridas: previo.corridas + 1,
    costUsd: previo.costUsd + (u.costUsd ?? 0),
    vueltas: previo.vueltas + (u.numTurns ?? 0),
    durationMs: previo.durationMs + (u.durationMs ?? 0)
  }
  const todo: UsoPorDia = { ...uso, [dia]: { ...uso?.[dia], [conectorId]: nuevo } }
  const dias = Object.keys(todo).sort().slice(-DIAS_MAX)
  return Object.fromEntries(dias.map((d) => [d, todo[d]]))
}

const acumNoNegativo = (v: unknown): number | undefined => {
  const n = numero(v)
  return n !== undefined && n >= 0 ? n : undefined
}

export function sanearUso(raw: unknown): UsoPorDia | undefined {
  if (!esObjeto(raw)) return undefined
  const dias = Object.keys(raw)
    .filter((d) => DIA_RE.test(d))
    .sort()
    .slice(-DIAS_MAX)
  const out: UsoPorDia = {}
  for (const d of dias) {
    const porConector = raw[d]
    if (!esObjeto(porConector)) continue
    const dia: Record<string, UsoAcum> = {}
    for (const [id, a] of Object.entries(porConector)) {
      if (Object.keys(dia).length >= CONECTORES_MAX) break
      if (!ID_CONECTOR_RE.test(id) || !esObjeto(a)) continue
      const corridas = acumNoNegativo(a.corridas)
      const costUsd = acumNoNegativo(a.costUsd)
      const vueltas = acumNoNegativo(a.vueltas)
      const durationMs = acumNoNegativo(a.durationMs)
      if (corridas === undefined || costUsd === undefined || vueltas === undefined || durationMs === undefined) continue
      dia[id] = { corridas, costUsd, vueltas, durationMs }
    }
    if (Object.keys(dia).length) out[d] = dia
  }
  return Object.keys(out).length ? out : undefined
}

export const diaLocal = (ms: number): string => {
  const f = new Date(ms)
  const dos = (n: number): string => String(n).padStart(2, '0')
  return `${f.getFullYear()}-${dos(f.getMonth() + 1)}-${dos(f.getDate())}`
}
