import { proveedorIdDe, type ProveedorId } from '../../../shared/proveedores'
import { motorClaude } from './motor-claude'
import { motorCodex } from './motor-codex'
import type { MotorTickets } from './motor-tickets'

// Un proveedor nuevo (Gemini, Copilot) se suma con una entrada acá y la capacidad `ticketsHeadless`.
export const MOTORES: Partial<Record<ProveedorId, MotorTickets>> = { claude: motorClaude, codex: motorCodex }

export function motorDe(cuenta: { proveedor?: unknown }): MotorTickets | undefined {
  const id = proveedorIdDe(cuenta)
  return id === undefined ? undefined : MOTORES[id]
}
