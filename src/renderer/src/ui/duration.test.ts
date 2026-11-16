import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cssMs } from './duration'

test('entiende ms y s', () => {
  assert.equal(cssMs('140ms'), 140)
  assert.equal(cssMs(' 0.2s '), 200)
  assert.equal(cssMs('.5s'), 500)
})

test('lo que no es una duración da null', () => {
  assert.equal(cssMs(''), null)
  assert.equal(cssMs('fast'), null)
  assert.equal(cssMs('12px'), null)
})
