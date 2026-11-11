import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextFocusIndex } from './focus-trap'

test('Tab avanza y da la vuelta al final', () => {
  assert.equal(nextFocusIndex(3, 0, false), 1)
  assert.equal(nextFocusIndex(3, 2, false), 0)
})

test('Shift+Tab retrocede y da la vuelta al principio', () => {
  assert.equal(nextFocusIndex(3, 1, true), 0)
  assert.equal(nextFocusIndex(3, 0, true), 2)
})

test('con el foco afuera entra por el primero o el último', () => {
  assert.equal(nextFocusIndex(3, -1, false), 0)
  assert.equal(nextFocusIndex(3, -1, true), 2)
})

test('sin elementos no hay destino', () => {
  assert.equal(nextFocusIndex(0, -1, false), -1)
})
