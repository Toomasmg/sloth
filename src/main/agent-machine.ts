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

const SECUENCIAS_DE_CONTROL = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001bO./g

/**
 * Si lo que llegó a la terminal lo escribió una persona. El emulador también contesta consultas del programa
 * y avisa de foco o del mouse con secuencias de escape: eso no es entrada.
 */
export function esEntradaDeUsuario(data: string): boolean {
  return data.replace(SECUENCIAS_DE_CONTROL, '').length > 0
}

/**
 * Un agente sin hooks (Codex) solo manda «terminó» (por `notify`); nada lo devuelve a «working» al empezar otro turno
 * y el espacio quedaría en `done` para siempre, sin volver a sonar en el segundo aviso. Lo único honesto que sabemos
 * es que alguien escribió en su terminal: eso libera el `done`, a `idle` (no se inventa `working`).
 */
export function salidaDeDoneSinHooks(prev: AgentState | undefined, tieneHooks: boolean, data: string): boolean {
  return !tieneHooks && prev === 'done' && esEntradaDeUsuario(data)
}
