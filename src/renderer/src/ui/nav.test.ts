import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keyToMove, moveIndex, typeaheadIndex } from './nav'

test('keyToMove respeta la orientación', () => {
  assert.equal(keyToMove('ArrowRight', 'horizontal'), 'next')
  assert.equal(keyToMove('ArrowDown', 'horizontal'), null)
  assert.equal(keyToMove('ArrowUp', 'vertical'), 'prev')
  assert.equal(keyToMove('Home', 'vertical'), 'first')
  assert.equal(keyToMove('a', 'vertical'), null)
})

test('moveIndex da la vuelta y salta deshabilitados', () => {
  const dis = (i: number): boolean => i === 1
  assert.equal(moveIndex(4, 0, 'next', dis), 2)
  assert.equal(moveIndex(4, 3, 'next', dis), 0)
  assert.equal(moveIndex(4, 0, 'prev', dis), 3)
  assert.equal(moveIndex(4, 2, 'first', (i) => i === 0), 1)
  assert.equal(moveIndex(4, 2, 'last', (i) => i === 3), 2)
})

test('moveIndex sin habilitados o sin ítems devuelve -1', () => {
  assert.equal(moveIndex(0, 0, 'next'), -1)
  assert.equal(moveIndex(3, 0, 'next', () => true), -1)
  assert.equal(moveIndex(3, 0, 'last', () => true), -1)
})

test('typeaheadIndex busca desde el siguiente con una letra y desde el actual con varias', () => {
  const labels = ['Abrir', 'Archivar', 'Borrar', 'Archivo']
  assert.equal(typeaheadIndex(labels, 0, 'a'), 1)
  assert.equal(typeaheadIndex(labels, 1, 'a'), 3)
  assert.equal(typeaheadIndex(labels, 3, 'a'), 0)
  assert.equal(typeaheadIndex(labels, 0, 'arch'), 1)
  assert.equal(typeaheadIndex(labels, 0, 'z'), -1)
  assert.equal(typeaheadIndex(labels, 0, ' '), -1)
  assert.equal(typeaheadIndex(labels, 0, 'b', (i) => i === 2), -1)
})
