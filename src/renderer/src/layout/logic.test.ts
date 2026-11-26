import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modoReal } from './logic'

test('con menos paneles abiertos que la distribución elegida, se marca la que se ve', () => {
  assert.equal(modoReal('cuatro', 4, 2), 'dos')
  assert.equal(modoReal('tres', 3, 1), 'uno')
})

test('el ancho también recorta lo que se ve', () => {
  assert.equal(modoReal('cuatro', 1, 6), 'uno')
  assert.equal(modoReal('dos', 2, 5), 'dos')
})

test('sin paneles abiertos o con de sobra queda la elegida', () => {
  assert.equal(modoReal('cuatro', 4, 0), 'cuatro')
  assert.equal(modoReal('tres', 3, 9), 'tres')
})
