export const ESPERA_MIN_MS = 1000
/** Tope de cada espera: tras una suspensión el timer puede seguir contando como si nada, así que el atraso máximo es este. */
export const ESPERA_MAX_MS = 60_000

export interface Vigilia {
  /** Para cuando vuelve la ventana a visible o a foco: si ya pasó el vencimiento, avisa en el acto. */
  revisar(): void
  parar(): void
}

export function esperaHasta(vence: number, ahora: number): number {
  return Math.min(Math.max(vence - ahora, ESPERA_MIN_MS), ESPERA_MAX_MS)
}

/**
 * Avisa una vez cuando el reloj de pared llega a `vence`. Espera de a tramos de hasta 60 s y compara
 * contra la hora de pared, no contra lo que dura el timer: un setTimeout largo no cuenta el tiempo de
 * suspensión de la PC (el de 2^31 ms tampoco entra), y la retención es una promesa de privacidad.
 */
export function vigilarVencimiento(
  vence: number,
  ahora: () => number,
  programar: (fn: () => void, ms: number) => unknown,
  cancelar: (handle: unknown) => void,
  alVencer: () => void
): Vigilia {
  let timer: unknown = null
  let vivo = true

  const parar = (): void => {
    vivo = false
    if (timer === null) return
    cancelar(timer)
    timer = null
  }

  const revisar = (): void => {
    if (!vivo) return
    if (timer !== null) {
      cancelar(timer)
      timer = null
    }
    const n = ahora()
    if (n >= vence) {
      vivo = false
      alVencer()
      return
    }
    timer = programar(revisar, esperaHasta(vence, n))
  }

  timer = programar(revisar, esperaHasta(vence, ahora()))
  return { revisar, parar }
}
