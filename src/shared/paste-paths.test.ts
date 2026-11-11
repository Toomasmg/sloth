import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinPaths, quotePath } from './paste-paths'

test('quotePath pone comillas solo si hay espacios', () => {
  assert.equal(quotePath('C:\\a\\proyecto.zip'), 'C:\\a\\proyecto.zip')
  assert.equal(quotePath('C:\\a\\mi foto.png'), '"C:\\a\\mi foto.png"')
})

test('joinPaths separa con espacios y descarta vacías', () => {
  assert.equal(joinPaths(['/a/b.zip', '', '/a/mi foto.png']), '/a/b.zip "/a/mi foto.png"')
  assert.equal(joinPaths([]), '')
})
