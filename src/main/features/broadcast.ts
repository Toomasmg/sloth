import type { Feature } from './context'

/**
 * Función «broadcast» (lado main). No necesita nada propio: la interfaz escribe el prompt en cada
 * terminal con `ptyWrite` (canal del núcleo). Queda registrada por si más adelante hace falta.
 */
const feature: Feature = {
  name: 'broadcast',
  register() {}
}

export default feature
