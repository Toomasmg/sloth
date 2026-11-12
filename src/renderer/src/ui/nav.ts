export type Move = 'next' | 'prev' | 'first' | 'last'
export type Orientation = 'horizontal' | 'vertical'

export function keyToMove(key: string, orientation: Orientation): Move | null {
  if (key === 'Home') return 'first'
  if (key === 'End') return 'last'
  if (orientation === 'horizontal') {
    if (key === 'ArrowRight') return 'next'
    if (key === 'ArrowLeft') return 'prev'
  } else {
    if (key === 'ArrowDown') return 'next'
    if (key === 'ArrowUp') return 'prev'
  }
  return null
}

/** Índice al que va el foco al moverse; salta los deshabilitados y da la vuelta. -1 si no hay ninguno habilitado. */
export function moveIndex(count: number, current: number, move: Move, isDisabled: (i: number) => boolean = () => false): number {
  if (count <= 0) return -1
  if (move === 'first' || move === 'last') {
    const order = Array.from({ length: count }, (_, i) => (move === 'first' ? i : count - 1 - i))
    return order.find((i) => !isDisabled(i)) ?? -1
  }
  const step = move === 'next' ? 1 : -1
  let i = current
  for (let n = 0; n < count; n++) {
    i = (i + step + count) % count
    if (!isDisabled(i)) return i
  }
  return -1
}

/** Búsqueda por tecleo en menús: el primer ítem habilitado, después de `current`, que empiece con el texto. */
export function typeaheadIndex(labels: string[], current: number, text: string, isDisabled: (i: number) => boolean = () => false): number {
  const q = text.trim().toLocaleLowerCase('es')
  if (!q) return -1
  const n = labels.length
  const start = q.length === 1 ? current + 1 : current
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n
    if (!isDisabled(i) && labels[i].toLocaleLowerCase('es').startsWith(q)) return i
  }
  return -1
}
