import { test } from 'node:test'
import assert from 'node:assert/strict'
import { destOf, navDestForKey } from './nav-model'

const key = (code: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({
  code,
  ctrlKey: true,
  shiftKey: true,
  altKey: false,
  metaKey: false,
  ...mods
})

test('Ctrl+Shift+1…5 lleva a cada destino del riel, en orden', () => {
  assert.deepEqual(
    ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'].map((c) => navDestForKey(key(c))),
    ['espacios', 'tickets', 'equipo', 'historial', 'ramas']
  )
  // Ctrl+Shift+Numpad2 con NumLock es Ctrl+Shift+↓, que la terminal tiene que recibir.
  assert.equal(navDestForKey(key('Numpad2')), null)
})

test('no pisa Ctrl+1…4 (ir al panel) ni Ctrl+Alt+1…4 (distribución)', () => {
  assert.equal(navDestForKey(key('Digit1', { shiftKey: false })), null)
  assert.equal(navDestForKey(key('Digit1', { altKey: true })), null)
  assert.equal(navDestForKey(key('Digit6')), null)
  assert.equal(navDestForKey(key('Digit1', { metaKey: true })), null)
})

test('la Vista de arriba define el destino; Reportar y Exportar marcan a su madre', () => {
  assert.equal(destOf(null), 'espacios')
  assert.equal(destOf('f-tickets-view-title'), 'tickets')
  assert.equal(destOf('rp-view-title'), 'ayuda')
  assert.equal(destOf('fr-view-title'), 'ayuda')
  assert.equal(destOf('f-ei-view-title'), 'ajustes')
  assert.equal(destOf('otra-cosa'), 'espacios')
})
