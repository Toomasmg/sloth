import type { AgentState } from '../shared/types'

/**
 * Ciclo de vida del agente de un espacio, en un solo lugar. Puro: se prueba con Node.
 *
 *   (sin estado) ──start──▶ idle ◀──hook──▶ working / waiting / done
 *   cualquiera   ──exit───▶ exited ──start──▶ idle
 *   cualquiera   ──sleep──▶ sleeping ──wake o start──▶ idle
 *
 * Dos reglas que antes estaban repartidas (o faltaban) entre index.ts y sleep.ts:
 * - Una terminal cerrada o dormida no cambia de estado por un hook: Claude manda Stop o SessionEnd
 *   mientras lo cierran, y ese aviso tardío dejaba como «listo» un espacio sin terminal.
 * - Dormido gana sobre cerrado: la terminal de un espacio dormido se cerró a propósito.
 */
export type AgentInput = 'start' | 'exit' | 'sleep' | 'wake' | { hook: AgentState }

/** Estado siguiente, o null si esa entrada no cambia nada desde el estado actual. */
export function nextAgentState(prev: AgentState | undefined, input: AgentInput): AgentState | null {
  if (typeof input === 'object') return prev === 'exited' || prev === 'sleeping' ? null : input.hook
  switch (input) {
    case 'start':
      // Reconectarse a una terminal que seguía viva no pisa lo que Claude estaba haciendo.
      return prev === undefined || prev === 'exited' || prev === 'sleeping' ? 'idle' : null
    case 'exit':
      return prev === 'sleeping' ? null : 'exited'
    case 'sleep':
      return 'sleeping'
    case 'wake':
      return prev === 'sleeping' ? 'idle' : null
  }
}
