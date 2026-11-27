import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_WAV_BYTES, PISTA, errorDictado, hilos, previoDe, limpiarTexto, textoDeSalida, timeoutMs, wavValido, whisperArgs } from './dictado-core'
import { encodeWav } from '../shared/wav'

test('whisperArgs pide español, sin marcas de tiempo y con la pista', () => {
  const a = whisperArgs({ model: 'm.bin', wav: 'a.wav', threads: 4 })
  assert.deepEqual(a.slice(0, 8), ['-m', 'm.bin', '-f', 'a.wav', '-l', 'es', '-t', '4'])
  assert.ok(a.includes('-nt') && a.includes('-np') && a.includes('--prompt'))
})

test('whisperArgs repite la pista en cada ventana y acota el contexto', () => {
  const a = whisperArgs({ model: 'm.bin', wav: 'a.wav', threads: 4 })
  assert.ok(a.includes('--carry-initial-prompt'))
  assert.equal(a[a.indexOf('-mc') + 1], '64')
})

test('whisperArgs suma lo ya dictado a la pista', () => {
  const a = whisperArgs({ model: 'm.bin', wav: 'a.wav', threads: 4, previo: 'y después revisá' })
  assert.equal(a[a.indexOf('--prompt') + 1], `${PISTA} y después revisá`)
  const b = whisperArgs({ model: 'm.bin', wav: 'a.wav', threads: 4, previo: '' })
  assert.equal(b[b.indexOf('--prompt') + 1], PISTA)
})

test('previoDe: la cola de lo dictado, limpia y en una palabra entera', () => {
  assert.equal(previoDe(undefined), '')
  assert.equal(previoDe(42), '')
  assert.equal(previoDe('hola\r\nche'), 'hola che')
  const largo = 'palabra '.repeat(1000) + 'final'
  const p = previoDe(largo)
  assert.ok(p.length <= 220 && p.endsWith('final') && p.startsWith('palabra'))
})

test('timeoutMs crece con lo que dura el audio', () => {
  assert.equal(timeoutMs(44), 30_000)
  assert.equal(timeoutMs(44 + 32_000 * 25), 130_000)
  assert.equal(timeoutMs(44 + 32_000 * 300), 1_230_000)
})

test('hilos: la mitad de los núcleos, entre 2 y 8', () => {
  assert.equal(hilos(1), 2)
  assert.equal(hilos(4), 2)
  assert.equal(hilos(14), 7)
  assert.equal(hilos(64), 8)
})

test('textoDeSalida limpia la salida de whisper-cli', () => {
  assert.equal(textoDeSalida('\n Hacé el commit en staging.\n Revisá los tests.\n'), 'Hacé el commit en staging. Revisá los tests.')
})

test('textoDeSalida saca lo que Whisper inventa con silencio o ruido', () => {
  assert.equal(textoDeSalida(' [BLANK_AUDIO]\n'), '')
  assert.equal(textoDeSalida(' (música)'), '')
  assert.equal(textoDeSalida(' Subtítulos realizados por la comunidad de Amara.org'), '')
  assert.equal(textoDeSalida(' ¡Gracias por ver el video!'), '')
  assert.equal(textoDeSalida(' ...'), '')
  assert.equal(textoDeSalida(' [risas] Abrí el PR.'), 'Abrí el PR.')
})

test('el texto dictado no lleva caracteres de control: un \\r mandaría el mensaje', () => {
  assert.equal(limpiarTexto('hacé el\r\nticket\x1b[2J  ya '), 'hacé el ticket [2J ya')
})

test('wavValido acepta un WAV de verdad y rechaza lo demás', () => {
  assert.equal(wavValido(encodeWav(new Float32Array(1600), 16000)), true)
  assert.equal(wavValido(new Uint8Array(100)), false)
  assert.equal(wavValido(new Uint8Array(10)), false)
  const grande = new Uint8Array(MAX_WAV_BYTES + 1)
  grande.set(encodeWav(new Float32Array(1), 16000).subarray(0, 12))
  assert.equal(wavValido(grande), false)
})

test('errorDictado arma el mensaje y dice si hay ajustes para abrir', () => {
  assert.equal(errorDictado('microfono').ajustes, true)
  assert.equal(errorDictado('sin-motor').ajustes, false)
  assert.match(errorDictado('otro', 'tardó demasiado').mensaje, /tardó demasiado/)
  assert.equal(errorDictado('sin-modelo').ajustes, false)
  assert.match(errorDictado('sin-modelo').mensaje, /sin conexión/)
  assert.match(errorDictado('sin-modelo', 'disco').mensaje, /espacio/)
  assert.doesNotMatch(errorDictado('sin-modelo', 'servidor').mensaje, /sin conexión/)
})
