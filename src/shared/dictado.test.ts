import { test } from 'node:test'
import assert from 'node:assert/strict'
import { porcentajeModelo } from './dictado'

test('porcentajeModelo: redondea hacia abajo y topa en 100', () => {
  assert.equal(porcentajeModelo({ recibidos: 0, total: 200 }), 0)
  assert.equal(porcentajeModelo({ recibidos: 199, total: 200 }), 99)
  assert.equal(porcentajeModelo({ recibidos: 200, total: 200 }), 100)
  assert.equal(porcentajeModelo({ recibidos: 300, total: 200 }), 100)
})

test('porcentajeModelo: lo que no es un avance válido da null', () => {
  for (const malo of [null, undefined, 5, 'x', {}, { recibidos: 1 }, { recibidos: '1', total: 2 }, { recibidos: 1, total: 0 }, { recibidos: -1, total: 10 }, { recibidos: NaN, total: 10 }]) {
    assert.equal(porcentajeModelo(malo), null)
  }
})
