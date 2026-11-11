import type { AccountUsage, AgentState, UsageTotals } from '../../shared/types'

export const fmtTok = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`

export const totalTok = (t: UsageTotals): number => t.input + t.output + t.cacheWrite + t.cacheRead

export const emptyTotals: UsageTotals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0 }

export function usageTitle(u: AccountUsage): string {
  const line = (label: string, t: UsageTotals): string =>
    `${label}: ${t.messages} respuestas · entrada ${fmtTok(t.input)} · salida ${fmtTok(t.output)} · caché ${fmtTok(t.cacheWrite)} escrita / ${fmtTok(t.cacheRead)} leída`
  return [line('Últimas 5 h', u.last5h), line('Hoy', u.today), line('7 días', u.last7d), 'Leído de los transcripts de esta cuenta.'].join('\n')
}

export const STATE_LABEL: Record<AgentState, string> = {
  idle: 'Listo',
  working: 'Trabajando',
  waiting: 'Te necesita',
  done: 'Terminó',
  exited: 'Cerrado',
  sleeping: 'Dormido'
}

/** Color de identidad por cuenta: así se distingue de un vistazo qué terminal usa qué cuenta. */
const ACCOUNT_HUES = ['#9FEAF9', '#C4A7FF', '#F9A8D4', '#86EFAC', '#FCD34D', '#7DD3FC', '#FDBA74', '#BEF264']
export const accountColor = (index: number): string => ACCOUNT_HUES[((index % ACCOUNT_HUES.length) + ACCOUNT_HUES.length) % ACCOUNT_HUES.length]

export function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? p : `…\\${parts.slice(-2).join('\\')}`
}

export function cleanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
