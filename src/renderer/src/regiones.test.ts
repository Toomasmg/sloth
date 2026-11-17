import { test } from 'node:test'
import assert from 'node:assert/strict'
import { siguienteRegion } from './regiones'

test('sin zonas no hay a dónde ir', () => {
  assert.equal(siguienteRegion(0, -1, false), -1)
  assert.equal(siguienteRegion(0, 0, true), -1)
})

test('F6 cicla hacia adelante', () => {
  assert.equal(siguienteRegion(3, 0, false), 1)
  assert.equal(siguienteRegion(3, 1, false), 2)
  assert.equal(siguienteRegion(3, 2, false), 0)
})

test('Shift+F6 desde la primera da la vuelta a la última', () => {
  assert.equal(siguienteRegion(3, 0, true), 2)
})

test('con el foco fuera de toda zona, adelante va a la primera y atrás a la última', () => {
  assert.equal(siguienteRegion(3, -1, false), 0)
  assert.equal(siguienteRegion(3, -1, true), 2)
})
