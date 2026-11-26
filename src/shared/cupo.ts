import type { UsageTotals } from './types'

export const VENTANA_5H_MS = 5 * 60 * 60 * 1000

/** Desde acá el cupo avisa; desde el siguiente umbral es casi seguro que Claude se frene pronto. */
export const UMBRAL_ATENCION = 70
export const UMBRAL_ALTO = 90

/** Tope máximo que acepta Configuración, en tokens (evita un cero de más que deje la barra siempre vacía). */
export const TOPE_MAX = 1_000_000_000

export type NivelCupo = 'sin-tope' | 'ok' | 'atencion' | 'alto' | 'lleno'

export interface EventoUso {
  ts: number
  tokens: number
}

export interface VentanaUso {
  inicio: number
  fin: number
  tokens: number
}

export interface Cupo {
  usados: number
  /** Ausente: sin tope conocido (plan sin valor por defecto y sin tope propio). */
  tope?: number
  /** Redondeado y sin pasar de 999. Ausente si no hay tope. */
  pct?: number
  nivel: NivelCupo
  /** Fin de la ventana activa. Ausente si no hay ventana (sin uso en las últimas 5 h). */
  renueva?: number
}

/**
 * Lo que cuenta para el cupo: entrada, salida y caché escrita. La caché leída queda afuera porque
 * pesa muy poco contra el límite y, sumada, haría parecer que cualquier sesión larga se pasó.
 */
export function tokensCupo(t: Pick<UsageTotals, 'input' | 'output' | 'cacheWrite'>): number {
  return t.input + t.output + t.cacheWrite
}

/**
 * Topes por defecto de la ventana de 5 h, en tokens de `tokensCupo`. Son una estimación nuestra:
 * Anthropic no publica el límite ni lo deja en los logs, y cambia según la carga. Por eso el usuario
 * puede pisarlos por cuenta.
 */
const TOPES_POR_PLAN: readonly { patron: RegExp; tope: number }[] = [
  { patron: /\bmax\b.*\b20\s*x\b|\b20\s*x\b.*\bmax\b/, tope: 20_000_000 },
  { patron: /\bmax\b/, tope: 10_000_000 },
  { patron: /\bteam\b|\bequipo\b/, tope: 4_000_000 },
  { patron: /\bpro\b/, tope: 2_000_000 }
]

export function topeDePlan(plan: string | undefined): number | undefined {
  const p = (plan ?? '').trim().toLowerCase()
  if (!p) return undefined
  return TOPES_POR_PLAN.find((t) => t.patron.test(p))?.tope
}

/** El tope propio manda si es un número positivo; 0, negativo o NaN cuentan como «sin tope propio». */
export function topeEfectivo(plan: string | undefined, propio: number | undefined): number | undefined {
  if (typeof propio === 'number' && Number.isFinite(propio) && propio > 0) return Math.min(Math.round(propio), TOPE_MAX)
  return topeDePlan(plan)
}

/**
 * La ventana de 5 h en curso. Claude abre una ventana con el primer mensaje y dura 5 h exactas; el
 * mensaje siguiente a esa hora abre otra. Se recorre el historial en orden para encontrar la actual.
 * Sin mensajes, o con la última ventana ya vencida, no hay ventana activa.
 */
export function ventanaActiva(eventos: readonly EventoUso[], ahora: number): VentanaUso | undefined {
  const orden = eventos.filter((e) => Number.isFinite(e.ts) && e.ts <= ahora).sort((a, b) => a.ts - b.ts)
  let actual: VentanaUso | undefined
  for (const e of orden) {
    if (!actual || e.ts >= actual.fin) actual = { inicio: e.ts, fin: e.ts + VENTANA_5H_MS, tokens: 0 }
    actual.tokens += Math.max(0, e.tokens)
  }
  return actual && actual.fin > ahora ? actual : undefined
}

export function nivelDe(pct: number): Exclude<NivelCupo, 'sin-tope'> {
  if (pct >= 100) return 'lleno'
  if (pct >= UMBRAL_ALTO) return 'alto'
  if (pct >= UMBRAL_ATENCION) return 'atencion'
  return 'ok'
}

/** Una ventana vencida cuenta como sin uso: el dato guardado puede tener hasta un minuto de atraso. */
export function calcularCupo(ventana: VentanaUso | undefined, tope: number | undefined, ahora: number): Cupo {
  const vigente = ventana && ventana.fin > ahora ? ventana : undefined
  const usados = vigente?.tokens ?? 0
  const renueva = vigente?.fin
  if (tope === undefined || !Number.isFinite(tope) || tope <= 0) return { usados, nivel: 'sin-tope', renueva }
  const pct = Math.min(999, Math.round((usados / tope) * 100))
  return { usados, tope, pct, nivel: nivelDe((usados / tope) * 100), renueva }
}

const fmtHora = (ms: number, zona: string | undefined): string =>
  new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zona }).format(ms)
const fmtDia = (ms: number, zona: string | undefined): string =>
  new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: zona }).format(ms)

/** «17:10», o «mañana 01:10» si la ventana cruza la medianoche (en la zona dada; sin zona, la del equipo). */
export function textoRenovacion(renueva: number, ahora: number, zona?: string): string {
  const hora = fmtHora(renueva, zona)
  return fmtDia(renueva, zona) === fmtDia(ahora, zona) ? hora : `mañana ${hora}`
}
