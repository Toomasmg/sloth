import test from 'node:test'
import assert from 'node:assert/strict'
import { activeReduce, barPlacement, opensBar, scrolledFar } from './active-msg'

test('abrir otro mensaje cierra el anterior', () => {
  assert.equal(activeReduce('a', { type: 'toggle', id: 'b' }), 'b')
})

test('tocar el mismo mensaje lo cierra', () => {
  assert.equal(activeReduce('a', { type: 'toggle', id: 'a' }), null)
})

test('desde cerrado, tocar abre; cerrar deja null', () => {
  assert.equal(activeReduce(null, { type: 'toggle', id: 'a' }), 'a')
  assert.equal(activeReduce('a', { type: 'close' }), null)
})

test('seleccionar texto o tocar un control no abre la barra', () => {
  assert.equal(opensBar({ interactive: false }, false), true)
  assert.equal(opensBar({ interactive: false }, true), false)
  assert.equal(opensBar({ interactive: true }, false), false)
})

test('el scroll corto no cierra y el fuerte sí', () => {
  assert.equal(scrolledFar(100, 120), false)
  assert.equal(scrolledFar(100, 40), true)
  assert.equal(scrolledFar(100, 150), true)
})

test('la barra va abajo si arriba no entra', () => {
  assert.equal(barPlacement(10, 0, 30), 'below')
  assert.equal(barPlacement(200, 0, 30), 'above')
})
