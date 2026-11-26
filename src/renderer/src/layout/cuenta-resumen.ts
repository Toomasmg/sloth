import type { AgentState } from '../../../shared/types'

export interface ResumenCuenta {
  esperan: number
  trabajando: number
  /** Para el lector de pantalla: «1 te espera, 2 trabajando». Vacío si no hay nada que contar. */
  texto: string
}

/**
 * Lo que mira de un vistazo el encabezado de cada cuenta. Un espacio con un permiso pendiente cuenta
 * como que te espera aunque Claude figure trabajando: no se cuenta dos veces.
 */
export function resumenCuenta(ids: readonly string[], estado: (id: string) => AgentState | undefined, permisos: (id: string) => number): ResumenCuenta {
  let esperan = 0
  let trabajando = 0
  for (const id of ids) {
    const s = estado(id)
    if (s === 'waiting' || permisos(id) > 0) esperan++
    else if (s === 'working') trabajando++
  }
  const partes = [esperan > 0 ? `${esperan} te ${esperan === 1 ? 'espera' : 'esperan'}` : '', trabajando > 0 ? `${trabajando} trabajando` : ''].filter(Boolean)
  return { esperan, trabajando, texto: partes.join(', ') }
}
