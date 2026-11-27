/**
 * Scroll del historial con el touchpad y la rueda. xterm 6 usa el scroll de VS Code, que a veces toma el
 * touchpad de Windows por una rueda y anima cada evento sobre la posición futura: con la inercia que
 * Windows sigue mandando al soltar, subir un poco volaba cientos de líneas. Acá cada px de los dedos es un
 * px de historial y ningún evento mueve más de MAX_LINEAS: una muesca de rueda (100 px) da 3 líneas y la
 * inercia frena sola en vez de acumularse.
 */

export const MAX_LINEAS = 3
/** Sin eventos por este tiempo, lo que sobró de una línea se descarta. */
const PAUSA_MS = 200
const DOM_DELTA_LINE = 1
const DOM_DELTA_PAGE = 2

export interface EstadoRueda {
  /** Fracción de línea acumulada, con signo. */
  resto: number
  ultimo: number
}

export const ruedaInicial = (): EstadoRueda => ({ resto: 0, ultimo: -Infinity })

export function pasoRueda(s: EstadoRueda, deltaY: number, deltaMode: number, altoCelda: number, t: number): { lineas: number; estado: EstadoRueda } {
  const enLineas = deltaMode === DOM_DELTA_LINE ? deltaY : deltaMode === DOM_DELTA_PAGE ? Math.sign(deltaY) * MAX_LINEAS : deltaY / Math.max(altoCelda, 1)
  const sigue = t - s.ultimo < PAUSA_MS && Math.sign(s.resto) !== -Math.sign(enLineas)
  const total = (sigue ? s.resto : 0) + enLineas
  const enteras = Math.trunc(total) || 0
  const lineas = Math.max(-MAX_LINEAS, Math.min(MAX_LINEAS, enteras))
  // Lo que pasó del tope no se guarda: si no, la inercia lo devolvería después.
  const resto = lineas === enteras ? total - enteras : 0
  return { lineas, estado: { resto, ultimo: t } }
}
