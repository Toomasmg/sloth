import { crearCortador } from '../../../../shared/partes-dictado'
import { encodeWav } from '../../../../shared/wav'

/** Whisper trabaja a 16 kHz: se graba directo a esa frecuencia y no hay que convertir. */
const RATE = 16000
/** Tope de una grabación: después se corta sola. */
export const MAX_SEGUNDOS = 300

export interface Grabacion {
  /** Termina y devuelve el WAV de lo que quedó sin mandar, o null si es silencio. */
  terminar(): Promise<Uint8Array | null>
  /** Corta sin devolver nada. */
  descartar(): void
}

/**
 * Graba del micrófono por defecto y entrega a `onParte` cada parte (WAV) apenas se cierra en una pausa,
 * para transcribirla mientras se sigue hablando. `onTope` se llama si se llega a MAX_SEGUNDOS.
 * Lanza el error de getUserMedia (NotAllowedError, NotFoundError) tal cual.
 */
export async function grabar(onTope: () => void, onParte: (wav: Uint8Array) => void): Promise<Grabacion> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  })
  const ctx = new AudioContext({ sampleRate: RATE })
  const src = ctx.createMediaStreamSource(stream)
  // ScriptProcessor está deprecado; migrar a AudioWorklet queda pendiente (pide un módulo aparte empaquetado y probar el micrófono real). Alcanza para voz.
  const proc = ctx.createScriptProcessor(4096, 1, 1)
  const cortador = crearCortador({ rate: RATE })
  let muestras = 0
  let cerrado = false
  proc.onaudioprocess = (e) => {
    if (cerrado) return
    const data = new Float32Array(e.inputBuffer.getChannelData(0))
    for (const parte of cortador.agregar(data)) onParte(encodeWav(parte, RATE))
    muestras += data.length
    if (muestras >= MAX_SEGUNDOS * RATE) onTope()
  }
  src.connect(proc)
  proc.connect(ctx.destination)

  const cerrar = (): void => {
    if (cerrado) return
    cerrado = true
    proc.disconnect()
    src.disconnect()
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close()
  }
  return {
    async terminar() {
      cerrar()
      const resto = cortador.cerrar()
      return resto ? encodeWav(resto, RATE) : null
    },
    descartar: cerrar
  }
}
