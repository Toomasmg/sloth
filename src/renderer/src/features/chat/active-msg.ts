export type ActiveAction = { type: 'toggle'; id: string } | { type: 'close' }

/** Una sola barra abierta: tocar otro mensaje la mueve, tocar el mismo la cierra. */
export function activeReduce(active: string | null, a: ActiveAction): string | null {
  if (a.type === 'close') return null
  return active === a.id ? null : a.id
}

/** Un click abre la barra salvo que sea sobre un control propio del mensaje o el final de una selección de texto. */
export function opensBar(target: { interactive: boolean }, hasSelection: boolean): boolean {
  return !target.interactive && !hasSelection
}

/** Un scroll corto (el que acomoda mensajes nuevos) no cierra la barra; uno fuerte sí. */
export function scrolledFar(from: number, to: number, threshold = 48): boolean {
  return Math.abs(to - from) > threshold
}

/** Si arriba de la burbuja no entra la barra dentro del área visible, va abajo. */
export function barPlacement(bubbleTop: number, viewTop: number, barHeight: number): 'above' | 'below' {
  return bubbleTop - barHeight < viewTop ? 'below' : 'above'
}
