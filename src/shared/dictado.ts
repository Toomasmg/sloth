/** Dictado por voz en la terminal: lo que main le avisa a la UI. */

export type EstadoDictado = 'inactivo' | 'escuchando' | 'transcribiendo'

/** Qué falló, para elegir el mensaje y si hay ajustes de Windows para abrir. */
export type TipoErrorDictado = 'privacidad' | 'microfono' | 'idioma' | 'red' | 'sistema' | 'otro'

export interface ErrorDictado {
  tipo: TipoErrorDictado
  mensaje: string
  /** Hay una pantalla de Configuración de Windows que lo arregla. */
  ajustes: boolean
}

export interface EventoEstadoDictado {
  paneId: string
  estado: EstadoDictado
  error?: ErrorDictado
}

export interface EventoTextoDictado {
  paneId: string
  texto: string
}
