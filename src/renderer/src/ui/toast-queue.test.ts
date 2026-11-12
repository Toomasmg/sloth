import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addToast, dismissToast, MAX_TOASTS, ERROR_DURATION, DEFAULT_DURATION } from './toast-queue'

test('los errores duran más que el resto', () => {
  const [a] = addToast([], { tone: 'danger', message: 'x' }, 1)
  const [b] = addToast([], { tone: 'info', message: 'x' }, 2)
  assert.equal(a.duration, ERROR_DURATION)
  assert.equal(b.duration, DEFAULT_DURATION)
})

test('un aviso repetido se reemplaza en vez de apilarse', () => {
  let l = addToast([], { tone: 'info', message: 'Copiado' }, 1)
  l = addToast(l, { tone: 'info', message: 'Copiado' }, 2)
  assert.deepEqual(l.map((t) => t.id), [2])
})

test('la cola se corta en el máximo y se queda con los más nuevos', () => {
  let l = addToast([], { tone: 'info', message: '0' }, 0)
  for (let i = 1; i <= MAX_TOASTS; i++) l = addToast(l, { tone: 'info', message: String(i) }, i)
  assert.equal(l.length, MAX_TOASTS)
  assert.equal(l[0].message, '1')
})

test('dismissToast saca solo el pedido', () => {
  const l = addToast(addToast([], { tone: 'info', message: 'a' }, 1), { tone: 'info', message: 'b' }, 2)
  assert.deepEqual(dismissToast(l, 1).map((t) => t.id), [2])
})
