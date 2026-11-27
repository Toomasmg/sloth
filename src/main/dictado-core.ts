import type { ErrorDictado, TipoErrorDictado } from '../shared/dictado'

/**
 * Dictado con Whisper (whisper.cpp) en la PC: la UI graba un WAV de 16 kHz, main lo pasa por
 * whisper-cli y devuelve el texto. El binario viene en el instalador (vendor/whisper); el modelo
 * se baja la primera vez que se dicta, a userData/whisper, y se verifica con SHA-256.
 */

export interface ModeloWhisper {
  archivo: string
  url: string
  /** Es el mismo hash que `X-Linked-ETag` de HuggingFace. */
  sha256: string
  /** Tamaño real del archivo: para el progreso si la respuesta no trae content-length y para el tope. */
  bytes: number
}

const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'

/** El de siempre (también lo traía el instalador): anda en cualquier PC, pero se equivoca bastante. */
export const MODELO_CHICO: ModeloWhisper = {
  archivo: 'ggml-small-q5_1.bin',
  url: `${HF}ggml-small-q5_1.bin`,
  sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
  bytes: 190_085_487
}

/**
 * Mucho más preciso en español, pero el encoder procesa siempre 30 s de audio: en una Core Ultra 5 tarda
 * ~15 s por parte (el chico, ~7). Por eso es opcional («Dictado más preciso»).
 */
export const MODELO_TURBO: ModeloWhisper = {
  archivo: 'ggml-large-v3-turbo-q5_0.bin',
  url: `${HF}ggml-large-v3-turbo-q5_0.bin`,
  sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
  bytes: 574_041_195
}
/** HuggingFace redirige a su CDN: solo estos hosts, y solo por https. */
export const MODELO_HOSTS: readonly string[] = [
  'huggingface.co',
  'cdn-lfs.hf.co',
  'cdn-lfs-us-1.hf.co',
  'cdn-lfs-eu-1.hf.co',
  'us.aws.cdn.hf.co',
  'eu.aws.cdn.hf.co',
  'cas-bridge.xethub.hf.co'
]
/** WAV mono de 16 bits a 16 kHz: 5 minutos son ~9,6 MB. */
export const MAX_WAV_BYTES = 12 * 1024 * 1024

/**
 * Pista para Whisper: el vocabulario técnico y el voseo salen mejor si el modelo los «espera». No se
 * transcribe: solo orienta. Es una frase en castellano con las palabras técnicas adentro: una lista de
 * palabras en inglés hacía que las partes cortas salieran en inglés.
 */
export const PISTA =
  'Bueno, che, te cuento lo que quiero que hagas en el proyecto. Fijate el commit en la branch de staging, hacé el merge y revisá el pull request antes del deploy. Dale, avisame.'

/** De lo ya dictado, cuánto se le pasa a la parte siguiente para que siga la oración (caracteres). */
const MAX_PREVIO = 220

/** Lo último ya transcripto, limpio y cortado en una palabra entera: el contexto de la parte siguiente. */
export function previoDe(texto: unknown): string {
  if (typeof texto !== 'string') return ''
  // Primero la cola: limpiarTexto corta a MAX_TEXTO desde el principio.
  const t = limpiarTexto(texto.slice(-MAX_PREVIO * 2))
  if (t.length <= MAX_PREVIO) return t
  const cola = t.slice(-MAX_PREVIO)
  const espacio = cola.indexOf(' ')
  return espacio >= 0 ? cola.slice(espacio + 1) : cola
}

/** Hilos para whisper-cli: la mitad de los núcleos, entre 2 y 8 (deja aire para la app y las terminales). */
export function hilos(cpus: number): number {
  return Math.max(2, Math.min(8, Math.floor(cpus / 2)))
}

export function whisperArgs(o: { model: string; wav: string; threads: number; previo?: string }): string[] {
  const prompt = o.previo ? `${PISTA} ${o.previo}` : PISTA
  // --carry-initial-prompt: sin él la pista solo vale para los primeros 30 s y después vuelve el castellano
  // de España («vosotros sabéis»). -mc acota lo que arrastra de una ventana a otra, para que un error no
  // contagie a lo que sigue.
  return ['-m', o.model, '-f', o.wav, '-l', 'es', '-t', String(o.threads), '-nt', '-np', '--prompt', prompt, '--carry-initial-prompt', '-mc', '64']
}

/** Tiempo para transcribir un WAV de 16 kHz mono: 30 s fijos más 4 veces lo que dura (una PC lenta tarda más que el audio). */
export function timeoutMs(wavBytes: number): number {
  return 30_000 + 4 * Math.max(0, (wavBytes - 44) / 32)
}

const MAX_TEXTO = 4000

/** El texto va a la terminal: sin caracteres de control (un \r mandaría el mensaje) ni espacios de más. */
export function limpiarTexto(t: string): string {
  return t.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXTO)
}

/**
 * Lo que Whisper «escucha» en el silencio o el ruido: marcas entre corchetes o paréntesis
 * ([BLANK_AUDIO], (música)) y las frases de subtítulos con las que fue entrenado.
 */
const ALUCINACIONES = [
  /\[[^\]]*\]/g,
  /\([^)]*\)/g,
  /subt[ií]tulos (realizados|hechos|creados) por [^\n]*/gi,
  /amara\.org/gi,
  /¡?gracias por (ver|mirar)( el v[ií]deo)?!?\.?/gi
]

/** Salida de whisper-cli (stdout con -nt -np) → texto para la terminal. Vacío si no se dijo nada. */
export function textoDeSalida(stdout: string): string {
  let t = stdout
  for (const re of ALUCINACIONES) t = t.replace(re, ' ')
  t = limpiarTexto(t)
  // Si solo quedó puntuación, no se dijo nada.
  return /[\p{L}\p{N}]/u.test(t) ? t : ''
}

/** ¿Es un WAV de verdad (cabecera RIFF/WAVE) y de un tamaño razonable? */
export function wavValido(b: Uint8Array): boolean {
  if (b.byteLength < 44 || b.byteLength > MAX_WAV_BYTES) return false
  const tag = (o: number): string => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3])
  return tag(0) === 'RIFF' && tag(8) === 'WAVE'
}

const MENSAJES: Record<TipoErrorDictado, string> = {
  microfono: 'No hay acceso al micrófono. Revisá que esté conectado y que Windows deje usarlo a las apps de escritorio.',
  'sin-microfono': 'No encontramos un micrófono. Conectá uno y probá de nuevo.',
  'sin-motor': 'Falta el motor de dictado. Reinstalá Sloth con la última versión.',
  'sin-modelo': 'No pudimos bajar el modelo de dictado (sin conexión). Probá de nuevo cuando tengas internet.',
  sistema: 'El dictado por ahora funciona solo en Windows.',
  otro: 'No se pudo dictar.'
}

/** Pantallas de Configuración de Windows que arreglan cada error (lista cerrada: es lo único que se abre). */
export const AJUSTES_DICTADO: Partial<Record<TipoErrorDictado, string>> = {
  microfono: 'ms-settings:privacy-microphone',
  'sin-microfono': 'ms-settings:sound'
}

export function errorDictado(tipo: TipoErrorDictado, detalle?: string): ErrorDictado {
  let mensaje = MENSAJES[tipo]
  if (tipo === 'otro' && detalle) mensaje = `${MENSAJES.otro} (${detalle.slice(0, 80)})`
  if (tipo === 'sin-modelo' && detalle === 'disco') mensaje = 'No hay espacio para bajar el modelo de dictado.'
  if (tipo === 'sin-modelo' && detalle === 'servidor') mensaje = 'El servidor del modelo de dictado respondió algo inesperado. Actualizá Sloth o probá más tarde.'
  return { tipo, mensaje, ajustes: tipo in AJUSTES_DICTADO }
}
