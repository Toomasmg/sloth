import { EventEmitter } from 'node:events'
import type { ChatNoticeEvent } from './chat-model'

/**
 * Emisor interno del proceso main para el chat. NO es la interfaz: la UI recibe `feat:chat:*` por
 * ctx.emit. Lo usan los módulos de main que reaccionan a mensajes (avisos de Windows, permisos).
 *
 *   chatEvents.on('message', (n: ChatNoticeEvent) => ...)   mensaje nuevo de OTRA persona
 *
 * Se emite en chat-data.ts al llegar un INSERT de messages que no es propio. Nunca lleva el cuerpo
 * completo (solo `preview`, recortado) y nunca tokens.
 */
class ChatEventBus extends EventEmitter {
  emitMessage(n: ChatNoticeEvent): void {
    this.emit('message', n)
  }
  onMessage(cb: (n: ChatNoticeEvent) => void): () => void {
    this.on('message', cb)
    return () => {
      this.off('message', cb)
    }
  }
}

export const chatEvents = new ChatEventBus()
