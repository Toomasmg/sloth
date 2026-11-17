import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hookTokenDe, KEY_RE, mismaPrueba, NONCE_RE, nuevoNonce, pruebaCliente, pruebaDaemon } from './auth'

const KEY = 'a'.repeat(64)

test('nuevoNonce cumple NONCE_RE y no se repite', () => {
  const a = nuevoNonce()
  assert.match(a, NONCE_RE)
  assert.notEqual(a, nuevoNonce())
  assert.ok(KEY_RE.test(KEY.toUpperCase()))
  assert.ok(!NONCE_RE.test(a.toUpperCase()))
})

test('la prueba del daemon y la del cliente difieren con los mismos nonces', () => {
  const nc = nuevoNonce()
  const nd = nuevoNonce()
  assert.notEqual(pruebaDaemon(KEY, nc, nd), pruebaCliente(KEY, nc, nd))
})

test('cambiar un nonce o la clave cambia la prueba', () => {
  const nc = nuevoNonce()
  const nd = nuevoNonce()
  const base = pruebaDaemon(KEY, nc, nd)
  assert.equal(pruebaDaemon(KEY, nc, nd), base)
  assert.notEqual(pruebaDaemon(KEY, nuevoNonce(), nd), base)
  assert.notEqual(pruebaDaemon(KEY, nc, nuevoNonce()), base)
  assert.notEqual(pruebaDaemon('b'.repeat(64), nc, nd), base)
  assert.notEqual(pruebaCliente(KEY, nc, nd), pruebaCliente(KEY, nd, nc))
})

test('mismaPrueba rechaza no-strings, otro largo y un carácter cambiado', () => {
  const p = pruebaCliente(KEY, nuevoNonce(), nuevoNonce())
  assert.ok(mismaPrueba(p, p))
  assert.ok(!mismaPrueba(undefined, p))
  assert.ok(!mismaPrueba(123, p))
  assert.ok(!mismaPrueba(p.slice(1), p))
  assert.ok(!mismaPrueba(`${p}0`, p))
  const otra = (p[0] === '0' ? '1' : '0') + p.slice(1)
  assert.ok(!mismaPrueba(otra, p))
})

test('hookTokenDe es estable por espacio y el token de A no vale para B', () => {
  const ht = 'c'.repeat(64)
  const a = hookTokenDe(ht, 'ws-a')
  assert.equal(hookTokenDe(ht, 'ws-a'), a)
  assert.match(a, NONCE_RE)
  assert.notEqual(hookTokenDe(ht, 'ws-b'), a)
  assert.ok(!mismaPrueba(a, hookTokenDe(ht, 'ws-b')))
  assert.notEqual(hookTokenDe('d'.repeat(64), 'ws-a'), a)
})
