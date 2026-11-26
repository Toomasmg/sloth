/**
 * Reglas de ventana angosta (el mínimo de la ventana es 900×560): cuándo el panel lateral se pliega solo
 * y cuántos paneles de terminal entran sin quedar por debajo de ~50 columnas. Sin DOM ni React.
 */

/** Bajo este ancho de ventana el panel lateral arranca plegado; se abre a pedido y vuelve a plegarse. */
export const SIDE_AUTO_BELOW_PX = 1000
/** Ancho mínimo de un panel de terminal: unas 45 a 50 columnas (PSReadLine apaga sus predicciones por debajo de 50). */
export const PANE_MIN_PX = 400

/** Con ventana angosta, la preferencia guardada no manda: solo lo que se abrió en esta sesión. */
export function sideVisible(shown: boolean, narrowOpen: boolean, winW: number): boolean {
  return winW < SIDE_AUTO_BELOW_PX ? narrowOpen : shown
}

/** Cantidad de paneles a la vista que entran en `areaW` px de grilla (0 = todavía sin medir: sin tope). */
export function capForWidth(cap: number, areaW: number): number {
  if (!(areaW > 0) || cap <= 1) return cap
  return areaW < PANE_MIN_PX * 2 ? 1 : cap
}

/** Aviso cuando el ancho deja ver menos paneles que los elegidos (y hay paneles abiertos de sobra); null si no falta nada. */
export function avisoAncho(elegidos: number, cap: number, abiertos: number): string | null {
  if (cap >= elegidos || abiertos <= cap) return null
  const quiere = Math.min(elegidos, abiertos)
  return `Se ve ${cap} de ${quiere}: falta ancho. Cerrá el panel lateral o agrandá la ventana.`
}
