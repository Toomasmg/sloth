import type { LimitesCodex, VentanaLimite } from '../shared/celular'

// Confirmado con `codex app-server --help` y `generate-json-schema` (codex-cli 0.164), sin arrancar el servidor:
// habla por stdio por defecto; el pedido es `initialize` (params.clientInfo con name y version), la notificación
// `initialized` y `account/rateLimits/read`; los mensajes no llevan `jsonrpc`. La respuesta trae `rateLimits`
// con `primary` y `secondary` ({ usedPercent, windowDurationMins, resetsAt }, los dos últimos pueden ser null)
// y `rateLimitsByLimitId`. El esquema no dice el framing por líneas ni la unidad de `resetsAt`: se asume una línea
// JSON por mensaje y que un número menor a 1e12 son segundos. Si algo no cierra, el resultado es «sin dato».
export const ID_INICIALIZAR = 1
export const ID_LIMITES = 2

const CINCO_HORAS_MIN = 300
const SEMANA_MIN = 10080
const TOLERANCIA_CINCO_HORAS = 5
const TOLERANCIA_SEMANA = 60

export function lineaInicializar(): string {
  return JSON.stringify({ id: ID_INICIALIZAR, method: 'initialize', params: { clientInfo: { name: 'sloth', version: '1' } } })
}

export function lineasTrasInicializar(): string[] {
  return [
    JSON.stringify({ method: 'initialized' }),
    JSON.stringify({ id: ID_LIMITES, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } })
  ]
}

export function lineasDePedido(): string[] {
  return [lineaInicializar(), ...lineasTrasInicializar()]
}

type Obj = Record<string, unknown>
const esObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** undefined: no es una respuesta a un pedido nuestro (texto suelto, notificación o pedido del servidor). */
export function leerRespuesta(linea: string): { id: number; result?: unknown; error: boolean } | undefined {
  const t = linea.trim()
  if (!t.startsWith('{')) return undefined
  let j: unknown
  try {
    j = JSON.parse(t)
  } catch {
    return undefined
  }
  if (!esObj(j) || typeof j.id !== 'number' || 'method' in j) return undefined
  if ('error' in j && j.error !== undefined && j.error !== null) return { id: j.id, error: true }
  if (!('result' in j)) return undefined
  return { id: j.id, result: j.result, error: false }
}

const primero = (o: Obj, ...claves: string[]): unknown => {
  for (const c of claves) if (c in o) return o[c]
  return undefined
}

function aMs(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null
  return v < 1e12 ? v * 1000 : v
}

interface Ventana {
  minutos: number
  ventana: VentanaLimite
}

function leerVentana(raw: unknown, ahora: number): Ventana | null {
  if (!esObj(raw)) return null
  const usado = primero(raw, 'usedPercent', 'used_percent')
  const minutos = primero(raw, 'windowDurationMins', 'window_duration_mins')
  if (typeof usado !== 'number' || !Number.isFinite(usado)) return null
  if (typeof minutos !== 'number' || !Number.isFinite(minutos)) return null
  const reiniciaEn = aMs(primero(raw, 'resetsAt', 'resets_at'))
  // Con el reinicio vencido el porcentaje es de la ventana anterior: mejor «sin dato» que un número viejo.
  if (reiniciaEn !== null && reiniciaEn <= ahora) return null
  return { minutos, ventana: { pct: Math.max(0, Math.min(100, usado)), reiniciaEn } }
}

function ventanasDe(snapshot: unknown, ahora: number): { cincoHoras: VentanaLimite | null; semana: VentanaLimite | null } {
  const salida = { cincoHoras: null as VentanaLimite | null, semana: null as VentanaLimite | null }
  if (!esObj(snapshot)) return salida
  // Se asigna por duración, nunca por posición: primary/secondary cambian según el plan.
  for (const crudo of [snapshot.primary, snapshot.secondary]) {
    const v = leerVentana(crudo, ahora)
    if (!v) continue
    if (Math.abs(v.minutos - CINCO_HORAS_MIN) <= TOLERANCIA_CINCO_HORAS) salida.cincoHoras ??= v.ventana
    else if (Math.abs(v.minutos - SEMANA_MIN) <= TOLERANCIA_SEMANA) salida.semana ??= v.ventana
  }
  return salida
}

/** Nunca tira: lo que no se entiende queda en null. */
export function limitesDeResultado(result: unknown, ahora: number): LimitesCodex {
  const vacio: LimitesCodex = { cincoHoras: null, semana: null, at: ahora }
  if (!esObj(result)) return vacio
  const candidatos: unknown[] = [primero(result, 'rateLimits', 'rate_limits')]
  const porId = primero(result, 'rateLimitsByLimitId', 'rate_limits_by_limit_id')
  if (esObj(porId)) candidatos.push(porId.codex)
  for (const c of candidatos) {
    const v = ventanasDe(c, ahora)
    if (v.cincoHoras || v.semana) return { ...v, at: ahora }
  }
  return vacio
}
