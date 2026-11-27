import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_LINEAS, acercar, alinear, deltaEnPx, partir } from './rueda'

const H = 17

test('el touchpad pide un px por px de dedos y la rueda 3 líneas por muesca', () => {
  assert.equal(deltaEnPx(-4, 0, H), -4)
  assert.equal(deltaEnPx(100, 0, H), MAX_LINEAS * H)
  assert.equal(deltaEnPx(-3, 1, H), -3 * H)
})

test('la inercia de un deslizamiento rápido tiene tope por evento', () => {
  const total = Array.from({ length: 60 }, (_, i) => deltaEnPx(-400 * 0.93 ** i, 0, H)).reduce((a, b) => a + b, 0)
  // Sin tope serían ~340 líneas.
  assert.ok(total / H > -150, `movió ${total / H} líneas`)
})

test('la animación llega en unos cuadros y no depende de los fps', () => {
  let pos = 0
  let cuadros = 0
  while (pos !== 51 && cuadros < 100) {
    pos = acercar(pos, 51, 16.7)
    cuadros++
  }
  assert.equal(pos, 51)
  assert.ok(cuadros <= 20, `${cuadros} cuadros`)
  const a60 = acercar(acercar(0, 51, 16.7), 51, 16.7)
  const a30 = acercar(0, 51, 33.4)
  assert.ok(Math.abs(a60 - a30) < 0.01)
})

test('cada cuadro se mueve menos de una línea: se ve deslizarse, no saltar', () => {
  let pos = 0
  let antes = 0
  for (let i = 0; i < 30; i++) {
    pos = acercar(pos, 51, 16.7)
    assert.ok(pos - antes < H)
    antes = pos
  }
})

test('partir separa la línea de xterm y el corrimiento de la pantalla', () => {
  assert.deepEqual(partir(10 * H, H), { linea: 10, fraccion: 0 })
  assert.deepEqual(partir(10 * H - 5, H), { linea: 9, fraccion: H - 5 })
  assert.equal(alinear(10 * H - 5, H), 10 * H)
  assert.equal(alinear(10 * H - 12, H), 9 * H)
})
