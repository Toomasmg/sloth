import { test } from 'node:test'
import assert from 'node:assert/strict'
import { leerErrorRenderer } from './error-renderer'

test('rechaza lo que no es un objeto o no trae mensaje', () => {
  for (const p of [undefined, null, 'x', 5, [], {}, { mensaje: '' }, { mensaje: 3 }, { stack: 'a' }]) {
    assert.equal(leerErrorRenderer(p), undefined)
  }
})

test('mensaje solo, o con stack', () => {
  assert.equal(leerErrorRenderer({ mensaje: 'roto' }), 'roto')
  assert.equal(leerErrorRenderer({ mensaje: 'roto', stack: 'at a' }), 'roto\nat a')
})

test('ignora un stack que no es string o está vacío', () => {
  assert.equal(leerErrorRenderer({ mensaje: 'm', stack: 5 }), 'm')
  assert.equal(leerErrorRenderer({ mensaje: 'm', stack: '' }), 'm')
})

test('acota los largos', () => {
  const t = leerErrorRenderer({ mensaje: 'a'.repeat(50_000), stack: 'b'.repeat(50_000) })
  assert.equal(t?.length, 20_000 + 1 + 20_000)
})
