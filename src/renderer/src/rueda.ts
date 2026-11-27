/**
 * Scroll del historial con el touchpad y la rueda, a 60 cuadros. xterm solo dibuja líneas enteras: lo que
 * falta para la próxima se hace corriendo la pantalla con un transform, y en cada cuadro la posición se
 * acerca a donde llevaron los dedos (así una muesca de rueda también se desliza en vez de saltar).
 *
 * El scroll de VS Code que trae xterm 6 tomaba a veces el touchpad de Windows por una rueda y, con la
 * inercia al soltar, subir un poco volaba cientos de líneas: por eso ningún evento mueve más de MAX_LINEAS.
 */

export const MAX_LINEAS = 3
/** Sin eventos por este tiempo, el gesto terminó y la pantalla se acomoda en la línea más cercana. */
export const PAUSA_MS = 150
/** Constante de tiempo del acercamiento: sigue a los dedos sin sentirse pegajoso. */
const TAU_MS = 45
const DOM_DELTA_LINE = 1
const DOM_DELTA_PAGE = 2

/** Cuántos px de historial pide un evento wheel, con el tope por evento. */
export function deltaEnPx(deltaY: number, deltaMode: number, altoCelda: number): number {
  const px = deltaMode === DOM_DELTA_LINE ? deltaY * altoCelda : deltaMode === DOM_DELTA_PAGE ? Math.sign(deltaY) * MAX_LINEAS * altoCelda : deltaY
  const tope = MAX_LINEAS * altoCelda
  return Math.max(-tope, Math.min(tope, px))
}

/** Un cuadro de animación: independiente de los fps, con medio px de margen para terminar. */
export function acercar(pos: number, objetivo: number, dtMs: number): number {
  const falta = objetivo - pos
  if (Math.abs(falta) < 0.5) return objetivo
  return pos + falta * (1 - Math.exp(-Math.max(dtMs, 0) / TAU_MS))
}

/** Línea de arriba que dibuja xterm y cuántos px se corre la pantalla hacia arriba. */
export function partir(pos: number, altoCelda: number): { linea: number; fraccion: number } {
  const linea = Math.floor(pos / altoCelda + 1e-6)
  return { linea, fraccion: Math.max(0, pos - linea * altoCelda) }
}

export const alinear = (pos: number, altoCelda: number): number => Math.round(pos / altoCelda) * altoCelda
