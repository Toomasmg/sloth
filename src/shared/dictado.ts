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

/** Porcentaje (0-100) de un evento `feat:dictado:modelo`; `null` si no hay bajada en curso o el dato no es válido. */
export function porcentajeModelo(p: unknown): number | null {
  if (typeof p !== 'object' || p === null) return null
  const { recibidos, total } = p as Partial<ProgresoModelo>
  if (typeof recibidos !== 'number' || typeof total !== 'number' || !(total > 0) || !(recibidos >= 0)) return null
  return Math.min(100, Math.floor((100 * recibidos) / total))
}

/** Respuesta de `feat:dictado:transcribir`. */
export type ResultadoDictado = { ok: true; texto: string } | { ok: false; error: ErrorDictado }
