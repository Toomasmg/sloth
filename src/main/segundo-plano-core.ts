import type { HookEventPayload } from '../shared/daemon-protocol'

/**
 * Lleva la cuenta de los shells que Claude dejó corriendo en segundo plano (run_in_background).
 * Claude Code no avisa por hook cuando uno termina: vuelve a despertar a Claude con un turno nuevo
 * que no escribió el usuario. Cada turno así descuenta un shell.
 */
export interface Fondo {
  /** Cuándo se lanzó cada shell que sigue pendiente, del más viejo al más nuevo. */
  lanzados: number[]
  /** El último turno terminó (Stop) y todavía no arrancó otro. */
  turnoCerrado: boolean
}

/** Si un shell no avisó en este tiempo, se da por perdido para no quedar «trabajando» para siempre. */
export const VENCE_MS = 30 * 60_000

const vigentes = (f: Fondo, ahora: number): number[] => f.lanzados.filter((t) => ahora - t < VENCE_MS)

/** Actualiza la cuenta con un evento de hook. */
export function registrar(m: Map<string, Fondo>, p: HookEventPayload, ahora: number): void {
  if (p.event === 'SessionStart' || p.event === 'SessionEnd') {
    m.delete(p.ws)
    return
  }
  const f = m.get(p.ws) ?? { lanzados: [], turnoCerrado: false }
  f.lanzados = vigentes(f, ahora)
  const turnoNuevo = f.turnoCerrado && (p.event === 'PreToolUse' || p.event === 'Stop' || p.event === 'UserPromptSubmit')
  if (turnoNuevo) {
    f.turnoCerrado = false
    // El usuario escribió: el turno no lo despertó un shell.
    if (p.event !== 'UserPromptSubmit' || p.avisoDeTarea) f.lanzados.shift()
  }
  if (p.event === 'PreToolUse' && p.enSegundoPlano) f.lanzados.push(ahora)
  if (p.event === 'Stop') f.turnoCerrado = true
  if (f.lanzados.length === 0 && !f.turnoCerrado) m.delete(p.ws)
  else m.set(p.ws, f)
}

/** Shells que siguen corriendo en ese espacio. */
export function pendientes(m: Map<string, Fondo>, ws: string, ahora: number): number {
  const f = m.get(ws)
  return f ? vigentes(f, ahora).length : 0
}

/** Cuándo vence el shell más nuevo, para revisar el estado si nunca llega su aviso. */
export function venceEn(m: Map<string, Fondo>, ws: string, ahora: number): number | null {
  const v = m.get(ws) ? vigentes(m.get(ws) as Fondo, ahora) : []
  return v.length ? v[v.length - 1] + VENCE_MS : null
}

/**
 * El evento diría «terminó» o «te espera» pero en realidad sigue corriendo algo: Stop, o el aviso de
 * inactividad que Claude Code manda al rato de terminar el turno.
 */
export function esFalsoFinal(p: HookEventPayload, enFondo: number): boolean {
  if (enFondo <= 0) return false
  return p.event === 'Stop' || (p.event === 'Notification' && p.notificationType === 'idle_prompt')
}
