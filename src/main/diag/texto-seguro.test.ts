import { test } from 'node:test'
import assert from 'node:assert/strict'
import { textoSeguro } from './texto-seguro'

test('convierte valores comunes', () => {
  assert.equal(textoSeguro('a'), 'a')
  assert.equal(textoSeguro(3), '3')
  assert.equal(textoSeguro(undefined), 'undefined')
})

test('no lanza con objetos sin prototipo ni toString roto', () => {
  assert.equal(textoSeguro(Object.create(null)), '(sin detalle)')
  assert.equal(
    textoSeguro({
      toString() {
        throw new Error('x')
      }
    }),
    '(sin detalle)'
  )
})
