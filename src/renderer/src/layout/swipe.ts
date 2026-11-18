/**
 * Deslizar con dos dedos en el touchpad para pasar de panel en la vista de uno. El touchpad llega como
 * eventos `wheel` con deltaX; un gesto es una tanda de eventos seguidos. Cada gesto cambia de panel una
 * sola vez, aunque los dedos sigan moviéndose (también la inercia que agrega Windows al soltar).
 */

/** Recorrido horizontal (px de deltaX acumulados) para cambiar de panel. */
export const UMBRAL_SWIPE = 90
/** Sin eventos por este tiempo, el gesto terminó. */
export const FIN_GESTO_MS = 220
/** Sin eventos por este tiempo, el panel que acompañaba a los dedos vuelve a su lugar. */
export const SOLTAR_MS = 120
/** Cuánto acompaña el panel a los dedos antes de cambiar (px, a cada lado). */
const MAX_ARRASTRE = 56

export interface EstadoSwipe {
  acumulado: number
  /** Ya cambió de panel en este gesto: lo que sigue se ignora hasta que termine. */
  usado: boolean
  ultimo: number
}

export const swipeInicial = (): EstadoSwipe => ({ acumulado: 0, usado: false, ultimo: -Infinity })

export interface PasoSwipe {
  estado: EstadoSwipe
  /** 1 = siguiente panel (dedos hacia la izquierda), -1 = anterior. */
  cambio: 1 | -1 | null
  /** Corrimiento del panel mientras se arrastra, en px (negativo = hacia la izquierda). */
  arrastre: number
}

export function pasoSwipe(s: EstadoSwipe, dx: number, dy: number, ahora: number): PasoSwipe {
  const nuevo = ahora - s.ultimo > FIN_GESTO_MS
  const base: EstadoSwipe = nuevo ? { acumulado: 0, usado: false, ultimo: ahora } : { ...s, ultimo: ahora }
  // Un gesto vertical (subir el historial) nunca cambia de panel, aunque se desvíe un poco.
  if (base.usado || Math.abs(dx) <= Math.abs(dy)) return { estado: base, cambio: null, arrastre: base.usado ? 0 : arrastreDe(base.acumulado) }
  const acumulado = base.acumulado + dx
  if (Math.abs(acumulado) >= UMBRAL_SWIPE) return { estado: { ...base, acumulado: 0, usado: true }, cambio: acumulado > 0 ? 1 : -1, arrastre: 0 }
  return { estado: { ...base, acumulado }, cambio: null, arrastre: arrastreDe(acumulado) }
}

const arrastreDe = (acumulado: number): number => -Math.max(-MAX_ARRASTRE, Math.min(MAX_ARRASTRE, acumulado * 0.6))

/** Hacia dónde entra el panel nuevo: por su posición en las pestañas, o por el gesto si se dio la vuelta. */
export function direccionDe(lista: readonly string[], desde: string | null, hacia: string, pedida?: 1 | -1): 1 | -1 {
  if (pedida) return pedida
  const a = desde ? lista.indexOf(desde) : -1
  const b = lista.indexOf(hacia)
  return a >= 0 && b < a ? -1 : 1
}
