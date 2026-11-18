/**
 * Traduce el JSONL de `codex exec --json` al sobre `{type:'result',...}` que ya leen los parsers de Claude.
 * Todo lo que llega es dato externo y las formas son supuestas (sin confirmar contra un Codex real): se
 * valida cada campo y lo que no encaja se ignora. Módulo puro (lo corre `node --test` con type stripping).
 */

const MAX_STDOUT = 8 * 1024 * 1024
const MAX_LINEA = 1_000_000
const MAX_TEXTO = 200_000
const MAX_ERROR = 300
const MAX_TOKENS = 1e12

export const ERROR_SIN_COMPLETAR = 'Codex terminó sin completar la respuesta'
export const ERROR_COMANDOS = 'Codex intentó correr comandos; se canceló la consulta'
const ERROR_SIN_TEXTO = 'Codex terminó sin devolver ninguna respuesta'

export interface SobreCodex {
  /** Último agent_message completo. */
  texto: string
  /** Llamadas MCP iniciadas: es lo que cuenta el tope de vueltas emulado. */
  vueltas: number
  tokens?: number
  /** Hubo turn.completed. */
  completado: boolean
  error?: string
  /** Comandos que Codex quiso correr (con `-s read-only` y sin herramientas propias no debería haber). */
  comandos: number
}

const esObjeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function mensajeError(v: unknown): string | undefined {
  const crudo = typeof v === 'string' ? v : esObjeto(v) && typeof v.message === 'string' ? v.message : undefined
  if (crudo === undefined) return undefined
  const m = crudo.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR)
  return m || undefined
}

function objetoDe(linea: string): Record<string, unknown> | undefined {
  const t = linea.trim()
  if (t.length > MAX_LINEA || !t.startsWith('{')) return undefined
  let j: unknown
  try {
    j = JSON.parse(t)
  } catch {
    // Avisos de stderr mezclados o una línea cortada por el tope de stdout: no son eventos.
    return undefined
  }
  return esObjeto(j) && typeof j.type === 'string' ? j : undefined
}

function itemDe(evento: Record<string, unknown>): Record<string, unknown> | undefined {
  return esObjeto(evento.item) && typeof evento.item.type === 'string' ? evento.item : undefined
}

export function esLlamadaMcp(linea: string): boolean {
  if (!linea.includes('mcp_tool_call')) return false
  const e = objetoDe(linea)
  return e?.type === 'item.started' && itemDe(e)?.type === 'mcp_tool_call'
}

export function esComando(linea: string): boolean {
  if (!linea.includes('command_execution')) return false
  const e = objetoDe(linea)
  return e?.type === 'item.started' && itemDe(e)?.type === 'command_execution'
}

function tokensDe(usage: unknown): number | undefined {
  if (!esObjeto(usage)) return undefined
  let suma: number | undefined
  for (const k of ['input_tokens', 'output_tokens']) {
    const n = usage[k]
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MAX_TOKENS) suma = (suma ?? 0) + Math.floor(n)
  }
  return suma
}

export function leerSalidaCodex(stdout: string): SobreCodex {
  const s: SobreCodex = { texto: '', vueltas: 0, completado: false, comandos: 0 }
  let fatal: string | undefined
  let aviso: string | undefined
  let fallo: string | undefined
  for (const linea of stdout.slice(0, MAX_STDOUT).split('\n')) {
    const e = objetoDe(linea)
    if (!e) continue
    const item = itemDe(e)
    switch (e.type) {
      case 'turn.completed':
        s.completado = true
        s.tokens = tokensDe(e.usage) ?? s.tokens
        break
      case 'turn.failed':
        fatal = mensajeError(e.error) ?? mensajeError(e.message) ?? 'Codex no pudo completar el turno'
        break
      case 'error':
        // Un error suelto puede ser un aviso que Codex supera (reconexión): solo cuenta si no hubo respuesta.
        aviso = mensajeError(e.message) ?? mensajeError(e.error) ?? aviso
        break
      case 'item.started':
        if (item?.type === 'mcp_tool_call') s.vueltas++
        if (item?.type === 'command_execution') s.comandos++
        break
      case 'item.completed':
        if (item?.type === 'agent_message' && typeof item.text === 'string') s.texto = item.text.slice(0, MAX_TEXTO)
        if (item?.type === 'command_execution') s.comandos++
        if (item && item.type !== 'agent_message' && item.status === 'failed') fallo = mensajeError(item.error) ?? fallo
        break
    }
  }
  if (s.comandos > 0) s.error = ERROR_COMANDOS
  else if (fatal !== undefined) s.error = fatal
  else if (!s.completado) s.error = aviso ?? fallo ?? ERROR_SIN_COMPLETAR
  else if (!s.texto.trim()) s.error = fallo ?? ERROR_SIN_TEXTO
  return s
}

/** JSON de una línea. Sin `total_cost_usd` (Codex no informa costo) ni `duration_ms` (lo mide quien corre). */
export function aSobreComun(s: SobreCodex): string {
  const base = { type: 'result', agente: 'Codex', permission_denials: [] as unknown[] }
  if (s.error !== undefined || !s.completado) {
    return JSON.stringify({
      ...base,
      subtype: 'error_during_execution',
      is_error: true,
      result: s.error ?? ERROR_SIN_COMPLETAR,
      num_turns: s.vueltas
    })
  }
  return JSON.stringify({
    ...base,
    subtype: 'success',
    is_error: false,
    result: s.texto,
    num_turns: s.vueltas,
    ...(s.tokens === undefined ? {} : { usage: { input_tokens: s.tokens } })
  })
}
