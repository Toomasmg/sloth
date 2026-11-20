import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crearConexiones } from './celular-conexiones'

test('cada cliente tiene su tope: uno que lo llena no le saca lugar a otro', () => {
  const c = crearConexiones(3)
  for (let i = 0; i < 3; i++) assert.equal(c.abrir('malo'), true)
  assert.equal(c.abrir('malo'), false)
  assert.equal(c.abrir('celu'), true)
  assert.equal(c.abrir('celu'), true)
})

test('al cerrar una vuelve el lugar, y cerrar de más no deja cuentas negativas ni claves colgadas', () => {
  const c = crearConexiones(1)
  assert.equal(c.abrir('a'), true)
  assert.equal(c.abrir('a'), false)
  c.cerrar('a')
  assert.equal(c.abrir('a'), true)
  c.cerrar('a')
  c.cerrar('a')
  c.cerrar('nunca-abrió')
  assert.equal(c.abrir('a'), true)
  assert.equal(c.abrir('a'), false, 'el cierre de más no regaló un lugar')
})
