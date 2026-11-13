import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_WAV_BYTES, errorDictado, hilos, limpiarTexto, textoDeSalida, wavValido, whisperArgs } from './dictado-core'
import { encodeWav } from '../shared/wav'

test('whisperArgs pide español, sin marcas de tiempo y con la pista', () => {
  const a = whisperArgs({ model: 'm.bin', wav: 'a.wav', threads: 4 })
  assert.deepEqual(a.slice(0, 8), ['-m', 'm.bin', '-f', 'a.wav', '-l', 'es', '-t', '4'])
  assert.ok(a.includes('-nt') && a.includes('-np') && a.includes('--prompt'))
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
})
