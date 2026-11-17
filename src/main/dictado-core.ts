import type { ErrorDictado, TipoErrorDictado } from '../shared/dictado'

/**
 * Dictado con Whisper (whisper.cpp) en la PC: la UI graba un WAV de 16 kHz, main lo pasa por
 * whisper-cli y devuelve el texto. El binario viene en el instalador (vendor/whisper); el modelo
 * se baja la primera vez que se dicta, a userData/whisper, y se verifica con SHA-256.
 */

export const WHISPER_MODEL = 'ggml-small-q5_1.bin'
export const MODELO_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin'
/** Es el mismo hash que `X-Linked-ETag` de HuggingFace y el del archivo que traía el instalador. */
export const MODELO_SHA256 = 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb'
/** Tamaño real del archivo; solo sirve para el progreso si la respuesta no trae content-length. */
export const MODELO_BYTES = 190_085_487
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
 * Pista para Whisper: el vocabulario técnico y el voseo salen mejor si el modelo los «espera».
 * No se transcribe: solo orienta.
 */
export const PISTA =
  'Le hablo a Claude Code en español rioplatense sobre programación: commit, branch, staging, main, merge, pull request, release, deploy, tests, TypeScript, React. Revisá, hacé, fijate.'

/** Hilos para whisper-cli: la mitad de los núcleos, entre 2 y 8 (deja aire para la app y las terminales). */
export function hilos(cpus: number): number {
  return Math.max(2, Math.min(8, Math.floor(cpus / 2)))
}

export function whisperArgs(o: { model: string; wav: string; threads: number }): string[] {
  return ['-m', o.model, '-f', o.wav, '-l', 'es', '-t', String(o.threads), '-nt', '-np', '--prompt', PISTA]
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
  if (tipo === 'sin-modelo' && detalle === 'disco') mensaje = 'No hay espacio para bajar el modelo de dictado (190 MB).'
  if (tipo === 'sin-modelo' && detalle === 'servidor') mensaje = 'El servidor del modelo de dictado respondió algo inesperado. Actualizá Sloth o probá más tarde.'
  return { tipo, mensaje, ajustes: tipo in AJUSTES_DICTADO }
}
