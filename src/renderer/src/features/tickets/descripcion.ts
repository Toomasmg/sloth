import type { Detalle, Ticket } from '../../../../shared/tickets'

/** Lo que dice la sección «Descripción»: la del detalle, la de la lista, o la verdad sobre por qué no hay. */
export function textoDescripcion(t: Pick<Ticket, 'descripcion'>, det: Pick<Detalle, 'descripcion'> | undefined, cargando: boolean, leeDetalle: boolean, conector: string): string {
  if (det?.descripcion) return det.descripcion
  if (t.descripcion) return t.descripcion
  if (leeDetalle && !det && cargando) return 'Cargando la descripción…'
  return `La descripción se ve en ${conector}.`
}
