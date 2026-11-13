import type { ErrorDictado, TipoErrorDictado } from '../shared/dictado'

/**
 * Dictado con Whisper (whisper.cpp) en la PC: la UI graba un WAV de 16 kHz, main lo pasa por
 * whisper-cli y devuelve el texto. El binario y el modelo vienen en el instalador (vendor/whisper).
 */

export const WHISPER_MODEL = 'ggml-small-q5_1.bin'
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
  sistema: 'El dictado por ahora funciona solo en Windows.',
  otro: 'No se pudo dictar.'
}

/** Pantallas de Configuración de Windows que arreglan cada error (lista cerrada: es lo único que se abre). */
export const AJUSTES_DICTADO: Partial<Record<TipoErrorDictado, string>> = {
  microfono: 'ms-settings:privacy-microphone',
  'sin-microfono': 'ms-settings:sound'
}

export function errorDictado(tipo: TipoErrorDictado, detalle?: string): ErrorDictado {
  const mensaje = tipo === 'otro' && detalle ? `${MENSAJES.otro} (${detalle.slice(0, 80)})` : MENSAJES[tipo]
  return { tipo, mensaje, ajustes: tipo in AJUSTES_DICTADO }
}
