import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeWav, rms, unir } from './wav'

test('encodeWav arma un WAV PCM mono de 16 bits', () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 0.5]), 16000)
  const v = new DataView(wav.buffer)
  const tag = (o: number): string => String.fromCharCode(...wav.subarray(o, o + 4))
  assert.equal(tag(0), 'RIFF')
  assert.equal(tag(8), 'WAVE')
  assert.equal(tag(36), 'data')
  assert.equal(v.getUint16(22, true), 1)
  assert.equal(v.getUint32(24, true), 16000)
  assert.equal(v.getUint16(34, true), 16)
  assert.equal(v.getUint32(40, true), 8)
  assert.equal(wav.byteLength, 44 + 8)
  assert.deepEqual([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true)], [0, 32767, -32768])
})

test('encodeWav recorta lo que se pasa de -1..1', () => {
  const v = new DataView(encodeWav(new Float32Array([2, -3]), 16000).buffer)
  assert.deepEqual([v.getInt16(44, true), v.getInt16(46, true)], [32767, -32768])
})

test('rms distingue silencio de voz', () => {
  assert.equal(rms(new Float32Array(0)), 0)
  assert.equal(rms(new Float32Array(100)), 0)
  assert.ok(Math.abs(rms(new Float32Array([0.5, -0.5])) - 0.5) < 1e-9)
})

test('unir junta los pedazos en orden', () => {
  assert.deepEqual([...unir([new Float32Array([1, 2]), new Float32Array([3])])], [1, 2, 3])
})
