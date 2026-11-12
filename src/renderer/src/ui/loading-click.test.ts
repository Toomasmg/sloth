import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadingClick } from './loading-click'

const ev = (): { prevented: boolean; preventDefault: () => void } => {
  const e = { prevented: false, preventDefault: () => (e.prevented = true) }
  return e
}

test('sin cargar, pasa el clic al onClick', () => {
  let n = 0
  const e = ev()
  loadingClick(false, () => n++)?.(e)
  assert.equal(n, 1)
  assert.equal(e.prevented, false)
})

test('cargando, no llama al onClick y cancela el clic (también el submit por Enter)', () => {
  let n = 0
  const e = ev()
  loadingClick(true, () => n++)?.(e)
  assert.equal(n, 0)
  assert.equal(e.prevented, true)
})

test('cargando y sin onClick (botón submit), igual cancela el envío', () => {
  const e = ev()
  loadingClick(true, undefined)?.(e)
  assert.equal(e.prevented, true)
})
