import test from 'node:test'
import assert from 'node:assert/strict'
import { composeIntent, type ComposeKey } from './type-to-compose'

const base: ComposeKey = {
  key: 'a',
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  isComposing: false,
  target: { tag: 'div', editable: false, popup: false }
}

test('una letra con el foco fuera de un campo escribe en la caja', () => {
  assert.equal(composeIntent(base), 'type')
  assert.equal(composeIntent({ ...base, key: 'ñ' }), 'type')
  assert.equal(composeIntent({ ...base, key: '?', target: { tag: 'button', editable: false, popup: false } }), 'type')
})

test('con el foco en un campo no hace nada', () => {
  assert.equal(composeIntent({ ...base, target: { tag: 'input', editable: true, popup: false } }), null)
})

test('dentro de un menú o una lista no hace nada', () => {
  assert.equal(composeIntent({ ...base, target: { tag: 'button', editable: false, popup: true } }), null)
})

test('Ctrl y Alt y Meta no escriben, salvo Ctrl+V que pega', () => {
  assert.equal(composeIntent({ ...base, ctrlKey: true }), null)
  assert.equal(composeIntent({ ...base, altKey: true }), null)
  assert.equal(composeIntent({ ...base, metaKey: true }), null)
  assert.equal(composeIntent({ ...base, ctrlKey: true, key: 'v' }), 'paste')
  assert.equal(composeIntent({ ...base, ctrlKey: true, key: 'V' }), 'paste')
  assert.equal(composeIntent({ ...base, ctrlKey: true, altKey: true, key: 'v' }), null)
})

test('teclas que no imprimen ni se mueven al escribir', () => {
  for (const key of ['Enter', 'Tab', 'Escape', 'ArrowUp', 'Shift', 'F5', ' ']) assert.equal(composeIntent({ ...base, key }), null)
})

test('con composición IME no hace nada', () => {
  assert.equal(composeIntent({ ...base, isComposing: true }), null)
})
