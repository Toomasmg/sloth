import type { Feature } from './context'
import { alAvisar, tomarAvisos } from '../avisos'

/**
 * Avisos del arranque para la persona (un archivo de configuración roto que se apartó, entradas
 * descartadas). La UI los pide al montar y otra vez cada vez que llega `feat:avisos:nuevos`.
 */
const feature: Feature = {
  name: 'avisos',
  register(ctx) {
    ctx.handle('tomar', () => tomarAvisos())
    alAvisar(() => ctx.emit('nuevos'))
  }
}

export default feature
