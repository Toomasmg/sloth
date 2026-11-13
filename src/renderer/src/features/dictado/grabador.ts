import { encodeWav, rms, unir } from '../../../../shared/wav'

/** Whisper trabaja a 16 kHz: se graba directo a esa frecuencia y no hay que convertir. */
const RATE = 16000
/** Tope de una grabación: después se corta sola. */
export const MAX_SEGUNDOS = 300
/** Por debajo de esto es silencio (o un micrófono muteado): no se transcribe. */
const SILENCIO = 0.004

export interface Grabacion {
  /** Termina y devuelve el WAV, o null si no se escuchó nada. */
  terminar(): Promise<Uint8Array | null>
  /** Corta sin devolver nada. */
  descartar(): void
}

/**
 * Graba del micrófono por defecto. `onTope` se llama si se llega a MAX_SEGUNDOS.
 * Lanza el error de getUserMedia (NotAllowedError, NotFoundError) tal cual.
 */
export async function grabar(onTope: () => void): Promise<Grabacion> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  })
  const ctx = new AudioContext({ sampleRate: RATE })
  const src = ctx.createMediaStreamSource(stream)
  // ScriptProcessor está deprecado pero no necesita un módulo aparte (AudioWorklet) y alcanza para voz.
  const proc = ctx.createScriptProcessor(4096, 1, 1)
  const chunks: Float32Array[] = []
  let muestras = 0
  let cerrado = false
  proc.onaudioprocess = (e) => {
    if (cerrado) return
    const data = new Float32Array(e.inputBuffer.getChannelData(0))
    chunks.push(data)
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
      const audio = unir(chunks)
      if (audio.length < RATE * 0.3 || rms(audio) < SILENCIO) return null
      return encodeWav(audio, RATE)
    },
    descartar: cerrar
  }
}
