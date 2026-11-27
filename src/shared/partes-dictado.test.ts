import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crearCortador } from './partes-dictado'

const RATE = 16000
/** Lo que entrega el ScriptProcessor: 4096 muestras (256 ms). */
const CUADRO = 4096

/** Cuadros de voz (una senoidal de nivel ~0,07) o de silencio con un poco de ruido. */
const voz = (segundos: number): Float32Array[] =>
  Array.from({ length: Math.round((segundos * RATE) / CUADRO) }, () => Float32Array.from({ length: CUADRO }, (_, i) => 0.1 * Math.sin(i / 5)))
const silencio = (segundos: number, nivel = 0.001): Float32Array[] =>
  Array.from({ length: Math.round((segundos * RATE) / CUADRO) }, () => Float32Array.from({ length: CUADRO }, (_, i) => (i % 2 ? nivel : -nivel)))

function pasar(cuadros: Float32Array[]): { partes: number[]; resto: number | null } {
  const c = crearCortador({ rate: RATE })
  const partes = cuadros.flatMap((q) => c.agregar(q)).map((p) => p.length / RATE)
  const resto = c.cerrar()
  return { partes, resto: resto ? resto.length / RATE : null }
}

test('corta en las pausas y deja lo último para el cierre', () => {
  const r = pasar([...voz(16), ...silencio(1), ...voz(17), ...silencio(1), ...voz(3)])
  assert.equal(r.partes.length, 2)
  assert.ok(r.resto !== null && r.resto > 2.5)
})

test('una pausa antes de los 15 s no corta: con poco audio Whisper se equivoca más', () => {
  const r = pasar([...voz(6), ...silencio(1), ...voz(5), ...silencio(1), ...voz(2)])
  assert.equal(r.partes.length, 0)
  assert.ok(r.resto !== null)
})

test('sin pausas, ninguna parte pasa de 28 s', () => {
  const r = pasar(voz(90))
  assert.ok(r.partes.length >= 3)
  assert.ok(r.partes.every((s) => s <= 28.1))
})

test('sin pausa, corta en el momento más callado de los últimos segundos', () => {
  const r = pasar([...voz(24), ...silencio(0.5), ...voz(10)])
  assert.equal(r.partes.length, 1)
  assert.ok(r.partes[0] > 24 && r.partes[0] < 25.5)
})

test('el silencio solo no se manda a transcribir', () => {
  const r = pasar([...silencio(20), ...silencio(20)])
  assert.deepEqual(r.partes, [])
  assert.equal(r.resto, null)
})

test('con ruido de fondo alto, la pausa se sigue viendo', () => {
  const r = pasar([...silencio(2, 0.01), ...voz(16), ...silencio(1, 0.01), ...voz(3)])
  assert.equal(r.partes.length, 1)
})
