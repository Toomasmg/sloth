/**
 * Límites de una corrida de `claude -p` y lo que gastó. Módulo puro (lo corre `node --test` con type
 * stripping): sin enums, namespaces ni parameter properties, y los tipos se importan con `type`.
 */
import type { Corrida, UsoAcum, UsoPorDia } from '../../../shared/tickets'
import { diaLocal, VUELTAS_DEFECTO, VUELTAS_MAX } from '../../../shared/tickets-uso'
import { ID_CONECTOR_RE } from './conector'

export { diaLocal, VUELTAS_DEFECTO, VUELTAS_MAX }
export const VUELTAS_MIN = 1
export const COSTO_MIN = 0.01
export const COSTO_MAX = 100
const DIAS_MAX = 60
const CONECTORES_MAX = 50
const DIA_RE = /^(\d{4})-(\d{2})-(\d{2})$/

const diaReal = (d: string): boolean => {
  const m = DIA_RE.exec(d)
  if (!m) return false
  const f = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return f.getFullYear() === Number(m[1]) && f.getMonth() === Number(m[2]) - 1 && f.getDate() === Number(m[3])
}

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

export interface LimitesEfectivos {
  vueltas: number
  costo?: number
}

/** Los topes que de verdad llevan los args de la consulta; se toman antes de correrla, porque la config puede cambiar mientras tanto. */
export function limitesEfectivos(l: { maxTurns?: unknown; maxCostUsd?: unknown }): LimitesEfectivos {
  const costo = costoValido(l.maxCostUsd)
  return { vueltas: vueltasValidas(l.maxTurns) ?? VUELTAS_DEFECTO, ...(costo === undefined ? {} : { costo }) }
}

export function textoTope(tope: Tope, limite: number, accion?: boolean): string {
  const base =
    tope === 'vueltas'
      ? limite >= VUELTAS_MAX
        ? `La consulta se cortó por tope de vueltas (${limite}), el máximo. Probá con algo más acotado.`
        : `La consulta se cortó por tope de vueltas (${limite}). Podés continuar con más vueltas o subir el tope en los ajustes.`
      : `La consulta se cortó por tope de costo (US$ ${String(limite).replace('.', ',')}). Podés subir el tope en los ajustes.`
  return accion ? `${base} Revisá el ticket: el cambio pudo quedar a medias.` : base
}

/** Qué queda en `lastRun` tras un intento fallido: solo el corte por tope conserva su `tope`; cualquier otro error lo limpia. */
export function lastRunTrasError(previo: Corrida | undefined, e: unknown, maxTurns: number): Corrida | undefined {
  if (e instanceof TopeVueltasError) return { ...e.uso, maxTurns, tope: e.tope }
  if (!previo || previo.tope === undefined) return previo
  const resto = { ...previo }
  delete resto.tope
  return resto
}

const FLAG_VIEJO_RE = /unknown option.*--max-budget-usd|--max-budget-usd.*unknown option/is

/** Un claude que no conoce --max-budget-usd sale con error y stdout vacío: se explica en vez de mostrar el parse genérico. */
export function textoFlagViejo(msg: string): string | undefined {
  return FLAG_VIEJO_RE.test(msg) ? 'Tu versión de Claude Code no soporta el tope de costo: actualizala o borrá el tope en los ajustes de Tickets.' : undefined
}

const cero = (): UsoAcum => ({ corridas: 0, costUsd: 0, vueltas: 0, durationMs: 0 })

const sumaSana = (previo: number, nuevo: number | undefined): number => {
  const r = previo + (nuevo !== undefined && nuevo >= 0 ? nuevo : 0)
  return Number.isFinite(r) ? r : previo
}

export function sumarUso(uso: UsoPorDia | undefined, dia: string, conectorId: string, u: UsoCorrida): UsoPorDia {
  const previo = uso?.[dia]?.[conectorId] ?? cero()
  const nuevo: UsoAcum = {
    corridas: previo.corridas + 1,
    costUsd: sumaSana(previo.costUsd, u.costUsd),
    vueltas: sumaSana(previo.vueltas, u.numTurns),
    durationMs: sumaSana(previo.durationMs, u.durationMs)
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
    .filter(diaReal)
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
