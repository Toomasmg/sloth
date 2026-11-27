/**
 * Deslizar con dos dedos en el touchpad para pasar de panel en la vista de uno. El touchpad llega como
 * eventos `wheel` con deltaX; un gesto es una tanda de eventos seguidos. Cada gesto cambia de panel una
 * sola vez, aunque los dedos sigan moviéndose (también la inercia que agrega Windows al soltar).
 */

/** Recorrido horizontal (px de deltaX acumulados) para cambiar de panel. */
export const UMBRAL_SWIPE = 110
/** Sin eventos por este tiempo, el gesto terminó. */
export const FIN_GESTO_MS = 220
/** Sin eventos por este tiempo, el panel que acompañaba a los dedos vuelve a su lugar. */
export const SOLTAR_MS = 120
/** Cuánto acompaña el panel a los dedos antes de cambiar (px, a cada lado). */
const MAX_ARRASTRE = 56
/**
 * Al soltar (o cuando la inercia se apaga) pasado este tanto del umbral, cambia igual. Antes el gesto que
 * quedaba entre medio dejaba el panel corrido, «casi cambiando», hasta que volvía.
 */
const SOLTAR_CAMBIA = 0.7
/**
 * Tras un cambio, volver a acelerar para el mismo lado cuenta como dedos nuevos recién pasado este tiempo:
 * a mitad de un deslizamiento los dedos frenan y aceleran solos, y eso saltaba dos paneles (de la 1 a la 3).
 */
const ENTRE_CAMBIOS_MS = 300

export interface EstadoSwipe {
  acumulado: number
  /** Ya cambió de panel en este gesto: lo que sigue se ignora hasta que termine. */
  usado: boolean
  ultimo: number
  /** Desde el cambio: sentido del gesto, el |deltaX| más alto y el más bajo después. Así se ve la inercia. */
  signo: number
  pico: number
  piso: number
  cambioEn: number
}

export const swipeInicial = (): EstadoSwipe => ({ acumulado: 0, usado: false, ultimo: -Infinity, signo: 0, pico: 0, piso: 0, cambioEn: -Infinity })

/**
 * La inercia de Windows sigue mandando eventos un buen rato después de soltar, cada vez más chicos y
 * siempre para el mismo lado: sin esto, un segundo deslizamiento que arranca encima de ella se tomaba
 * como el mismo gesto (y había que tocar el pad para cortarla). Si los eventos ya se frenaron y vuelven
 * a acelerar, o cambian de sentido, son dedos nuevos.
 */
function dedosNuevos(s: EstadoSwipe, dx: number, ahora: number): boolean {
  const m = Math.abs(dx)
  if (m >= 4 && Math.sign(dx) !== s.signo) return true
  return ahora - s.cambioEn >= ENTRE_CAMBIOS_MS && s.piso < s.pico * 0.25 && m > s.piso * 2 + 4
}

export interface PasoSwipe {
  estado: EstadoSwipe
  /** 1 = siguiente panel (dedos hacia la izquierda), -1 = anterior. */
  cambio: 1 | -1 | null
  /** Corrimiento del panel mientras se arrastra, en px (negativo = hacia la izquierda). */
  arrastre: number
}

export function pasoSwipe(s: EstadoSwipe, dx: number, dy: number, ahora: number): PasoSwipe {
  const horizontal = Math.abs(dx) > Math.abs(dy)
  const nuevo = ahora - s.ultimo > FIN_GESTO_MS || (s.usado && horizontal && dedosNuevos(s, dx, ahora))
  let base: EstadoSwipe = nuevo ? { ...swipeInicial(), ultimo: ahora } : { ...s, ultimo: ahora }
  if (base.usado && horizontal) base = { ...base, pico: Math.max(base.pico, Math.abs(dx)), piso: Math.min(base.piso, Math.abs(dx)) }
  // Un gesto vertical (subir el historial) nunca cambia de panel, aunque se desvíe un poco.
  if (base.usado || !horizontal) return { estado: base, cambio: null, arrastre: base.usado ? 0 : arrastreDe(base.acumulado) }
  const acumulado = base.acumulado + dx
  if (Math.abs(acumulado) >= UMBRAL_SWIPE) {
    const m = Math.abs(dx)
    return { estado: { ...base, acumulado: 0, usado: true, signo: Math.sign(dx), pico: m, piso: m, cambioEn: ahora }, cambio: acumulado > 0 ? 1 : -1, arrastre: 0 }
  }
  return { estado: { ...base, acumulado }, cambio: null, arrastre: arrastreDe(acumulado) }
}

// Llega al tope justo en el umbral: no queda un tramo con el panel quieto en el borde sin cambiar.
const arrastreDe = (acumulado: number): number => -Math.max(-MAX_ARRASTRE, Math.min(MAX_ARRASTRE, (acumulado * MAX_ARRASTRE) / UMBRAL_SWIPE))

/** Los dedos se quedaron quietos SOLTAR_MS: si el gesto iba casi por el umbral, cambia; si no, vuelve. */
export function soltarSwipe(s: EstadoSwipe, ahora: number): { estado: EstadoSwipe; cambio: 1 | -1 | null } {
  if (s.usado || Math.abs(s.acumulado) < UMBRAL_SWIPE * SOLTAR_CAMBIA) return { estado: { ...s, acumulado: s.usado ? s.acumulado : 0 }, cambio: null }
  const signo = Math.sign(s.acumulado)
  return { estado: { ...s, acumulado: 0, usado: true, signo, pico: 0, piso: 0, cambioEn: ahora }, cambio: signo > 0 ? 1 : -1 }
}

/** Hacia dónde entra el panel nuevo: por su posición en las pestañas, o por el gesto si se dio la vuelta. */
export function direccionDe(lista: readonly string[], desde: string | null, hacia: string, pedida?: 1 | -1): 1 | -1 {
  if (pedida) return pedida
  const a = desde ? lista.indexOf(desde) : -1
  const b = lista.indexOf(hacia)
  return a >= 0 && b < a ? -1 : 1
}
