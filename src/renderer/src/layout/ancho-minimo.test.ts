import { test } from 'node:test'
import assert from 'node:assert/strict'
import { avisoAncho, capForWidth, PANE_MIN_PX, SIDE_AUTO_BELOW_PX, sideVisible } from './ancho-minimo'

test('bajo el umbral el panel lateral solo se ve si se abrió en esta sesión', () => {
  assert.equal(sideVisible(true, false, 900), false)
  assert.equal(sideVisible(false, true, 900), true)
  assert.equal(sideVisible(true, false, SIDE_AUTO_BELOW_PX - 1), false)
})

test('desde el umbral manda la preferencia guardada', () => {
  assert.equal(sideVisible(true, false, SIDE_AUTO_BELOW_PX), true)
  assert.equal(sideVisible(false, true, 1280), false)
})

test('si no entran dos paneles de ~50 columnas, queda uno a la vista', () => {
  assert.equal(capForWidth(2, 852), 2)
  assert.equal(capForWidth(4, 588), 1)
  assert.equal(capForWidth(3, PANE_MIN_PX * 2 - 1), 1)
  assert.equal(capForWidth(2, PANE_MIN_PX * 2), 2)
})

test('sin medir o con una sola distribución no se toca nada', () => {
  assert.equal(capForWidth(2, 0), 2)
  assert.equal(capForWidth(1, 300), 1)
})

test('avisa solo si el ancho recorta lo elegido y hay paneles para mostrar', () => {
  assert.equal(avisoAncho(2, 1, 2), 'Se ve 1 de 2: falta ancho. Cerrá el panel lateral o agrandá la ventana.')
  assert.equal(avisoAncho(4, 1, 3), 'Se ve 1 de 3: falta ancho. Cerrá el panel lateral o agrandá la ventana.')
  assert.equal(avisoAncho(2, 1, 1), null)
  assert.equal(avisoAncho(2, 2, 5), null)
})
