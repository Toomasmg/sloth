export const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/** A dónde va el foco con Tab / Shift+Tab dentro de un contenedor de `count` elementos; -1 si no hay nada que enfocar. */
export function nextFocusIndex(count: number, current: number, shift: boolean): number {
  if (count <= 0) return -1
  if (current < 0 || current >= count) return shift ? count - 1 : 0
  if (shift) return current === 0 ? count - 1 : current - 1
  return current === count - 1 ? 0 : current + 1
}
