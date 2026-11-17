import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crearLimite } from './limite'

test('deja pasar hasta el máximo dentro de la ventana y después corta', () => {
  const pasa = crearLimite(3, 60_000, () => 1000)
  assert.deepEqual([pasa(), pasa(), pasa(), pasa(), pasa()], [true, true, true, false, false])
})

test('los intentos rechazados no cuentan y la ventana se libera con el tiempo', () => {
  let t = 0
  const pasa = crearLimite(2, 1000, () => t)
  assert.equal(pasa(), true)
  t = 400
  assert.equal(pasa(), true)
  t = 900
  assert.equal(pasa(), false)
  t = 1000
  assert.equal(pasa(), true)
  t = 1100
  assert.equal(pasa(), false)
  t = 1400
  assert.equal(pasa(), true)
})

test('con máximo 0 no deja pasar nada', () => {
  assert.equal(crearLimite(0, 1000, () => 0)(), false)
})
