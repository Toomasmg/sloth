import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_LINEAS, pasoRueda, ruedaInicial, type EstadoRueda } from './rueda'

/** Eventos de touchpad cada 16 ms con celdas de 17 px; devuelve las líneas movidas en total. */
function gesto(deltas: number[], modo = 0, desde: EstadoRueda = ruedaInicial(), t0 = 1000): { lineas: number; estado: EstadoRueda } {
  let s = desde
  let lineas = 0
  deltas.forEach((d, i) => {
    const r = pasoRueda(s, d, modo, 17, t0 + i * 16)
    s = r.estado
    lineas += r.lineas
  })
  return { lineas, estado: s }
}

test('el touchpad mueve un px de historial por px de dedos', () => {
  assert.equal(gesto(Array(17).fill(-4)).lineas, -4)
})

test('una muesca de rueda mueve 3 líneas', () => {
  assert.equal(pasoRueda(ruedaInicial(), 100, 0, 17, 0).lineas, 3)
  assert.equal(pasoRueda(ruedaInicial(), -3, 1, 17, 0).lineas, -3)
})

test('la inercia de un deslizamiento rápido no vuela: tope por evento', () => {
  const inercia = Array.from({ length: 60 }, (_, i) => -400 * 0.93 ** i)
  const { lineas } = gesto(inercia)
  assert.ok(lineas >= -60 * MAX_LINEAS)
  // Sin tope serían ~340 líneas.
  assert.ok(lineas > -150, `movió ${lineas}`)
})

test('cambiar de sentido o frenar descarta la fracción guardada', () => {
  const medio = gesto([-10]).estado
  assert.equal(pasoRueda(medio, 10, 0, 17, 1016).lineas, 0)
  assert.equal(pasoRueda(medio, -10, 0, 17, 5000).lineas, 0)
  assert.equal(pasoRueda(medio, -10, 0, 17, 1016).lineas, -1)
})
