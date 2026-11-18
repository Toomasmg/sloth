import { capacidadesDe } from '../../../shared/proveedores'
import { motorDe } from './motores'

/**
 * Para qué se elige la cuenta. `trabajo` abre una terminal interactiva con el agente y sigue siendo solo de
 * Claude: que una cuenta pueda consultar tickets (`consulta`) no quiere decir que pueda trabajar por ticket.
 */
export type ParaQue = 'consulta' | 'trabajo' | 'descubrir'

export function sirveParaTickets(cuenta: { proveedor?: unknown }, para: ParaQue): boolean {
  const c = capacidadesDe(cuenta)
  if (para === 'trabajo') return c?.tickets === true
  if (para === 'descubrir') return c?.ticketsHeadless === true && motorDe(cuenta)?.leeInit === true
  return c?.ticketsHeadless === true
}

export interface Candidata {
  id: string
  /** Tiene el conector y anda. */
  conConector: boolean
  /** El agente informa su uso: sin dato una cuenta cuenta 0 y ganaría siempre. */
  conUso: boolean
  consumo: number
}

/** Entre las que tienen el conector (si se sabe de alguna), las que informan uso, la de menos consumo. */
export function elegirCuenta(cuentas: readonly Candidata[]): string | undefined {
  const conConector = cuentas.filter((c) => c.conConector)
  const entre = conConector.length ? conConector : cuentas
  const conUso = entre.filter((c) => c.conUso)
  return [...(conUso.length ? conUso : entre)].sort((a, b) => a.consumo - b.consumo)[0]?.id
}
