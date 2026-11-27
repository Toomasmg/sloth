import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zoomFor, type ZoomKey } from './zoom-keys'

const k = (key: string, extra: Partial<ZoomKey> = {}): ZoomKey => ({ type: 'keyDown', key, code: '', control: true, alt: false, meta: false, ...extra })

test('Ctrl + agranda con el «+» del teclado en español, el «=» del inglés y el numérico', () => {
  assert.equal(zoomFor(k('+'), 0), 0.5)
  assert.equal(zoomFor(k('='), 0), 0.5)
  assert.equal(zoomFor(k('+', { code: 'NumpadAdd' }), 1), 1.5)
})

test('Ctrl - achica y Ctrl 0 vuelve al 100 %', () => {
  assert.equal(zoomFor(k('-'), 0), -0.5)
  assert.equal(zoomFor(k('-', { code: 'NumpadSubtract' }), 0), -0.5)
  assert.equal(zoomFor(k('0'), 2), 0)
})

test('el zoom no pasa de los topes', () => {
  assert.equal(zoomFor(k('+'), 3), 3)
  assert.equal(zoomFor(k('-'), -3), -3)
})

test('sin Ctrl, con Alt, al soltar o con otra tecla no hace nada', () => {
  assert.equal(zoomFor(k('+', { control: false }), 0), null)
  assert.equal(zoomFor(k('+', { alt: true }), 0), null)
  assert.equal(zoomFor(k('+', { type: 'keyUp' }), 0), null)
  assert.equal(zoomFor(k('a'), 0), null)
})
