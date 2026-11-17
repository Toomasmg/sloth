/** Dictado por voz en la terminal: tipos que comparten main y la UI. */

export type EstadoDictado = 'inactivo' | 'escuchando' | 'transcribiendo'

/** Qué falló, para elegir el mensaje y si hay ajustes de Windows para abrir. */
export type TipoErrorDictado = 'microfono' | 'sin-microfono' | 'sin-motor' | 'sin-modelo' | 'sistema' | 'otro'

export interface ErrorDictado {
  tipo: TipoErrorDictado
  mensaje: string
  /** Hay una pantalla de Configuración de Windows que lo arregla. */
  ajustes: boolean
}

/** Avance de la bajada del modelo: llega por `feat:dictado:modelo` (o `null` al terminar). */
export interface ProgresoModelo {
  recibidos: number
  total: number
}

/** Respuesta de `feat:dictado:transcribir`. */
export type ResultadoDictado = { ok: true; texto: string } | { ok: false; error: ErrorDictado }
