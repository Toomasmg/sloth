import { nextFocusIndex } from './focus-trap'

export function siguienteRegion(total: number, actual: number, atras: boolean): number {
  return nextFocusIndex(total, actual, atras)
}
