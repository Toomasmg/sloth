import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FIN_GESTO_MS, UMBRAL_SWIPE, direccionDe, pasoSwipe, swipeInicial, type EstadoSwipe } from './swipe'

/** Manda una tanda de eventos con 16 ms entre cada uno y devuelve los cambios que hubo. */
function gesto(deltas: [number, number][], desde: EstadoSwipe = swipeInicial(), t0 = 1000): { cambios: (1 | -1)[]; estado: EstadoSwipe; arrastres: number[] } {
  let s = desde
  const cambios: (1 | -1)[] = []
  const arrastres: number[] = []
  deltas.forEach(([dx, dy], i) => {
    const r = pasoSwipe(s, dx, dy, t0 + i * 16)
    s = r.estado
    arrastres.push(r.arrastre)
    if (r.cambio) cambios.push(r.cambio)
  })
  return { cambios, estado: s, arrastres }
}

test('dedos a la izquierda (deltaX positivo) pasan al siguiente; a la derecha, al anterior', () => {
  assert.deepEqual(gesto(Array(10).fill([15, 0])).cambios, [1])
  assert.deepEqual(gesto(Array(10).fill([-15, 0])).cambios, [-1])
})

test('un gesto cambia una sola vez aunque siga (inercia incluida)', () => {
  assert.deepEqual(gesto(Array(60).fill([20, 0])).cambios, [1])
})

test('después de una pausa empieza otro gesto y puede volver a cambiar', () => {
  const a = gesto(Array(10).fill([20, 0]))
  const b = gesto(Array(10).fill([20, 0]), a.estado, 1000 + 10 * 16 + FIN_GESTO_MS + 1)
  assert.deepEqual(b.cambios, [1])
})

test('lo vertical no cambia de panel ni mueve el panel', () => {
  const r = gesto(Array(40).fill([8, 30]))
  assert.deepEqual(r.cambios, [])
  assert.ok(r.arrastres.every((x) => x === 0))
})

test('un movimiento corto acompaña a los dedos sin cambiar, con tope', () => {
  const corto = gesto([[UMBRAL_SWIPE / 3, 0]])
  assert.deepEqual(corto.cambios, [])
  assert.ok(corto.arrastres[0] < 0)
  const casi = gesto([[UMBRAL_SWIPE - 1, 0]])
  assert.ok(casi.arrastres[0] >= -56)
})

test('ir y volver sin llegar al umbral no cambia', () => {
  assert.deepEqual(gesto([[60, 0], [-60, 0], [60, 0], [-60, 0]]).cambios, [])
})

test('direccionDe usa la pedida o, si no, el orden de las pestañas', () => {
  const l = ['a', 'b', 'c']
  assert.equal(direccionDe(l, 'a', 'c'), 1)
  assert.equal(direccionDe(l, 'c', 'a'), -1)
  assert.equal(direccionDe(l, 'c', 'a', 1), 1)
  assert.equal(direccionDe(l, null, 'b'), 1)
})

/** La inercia de Windows: después de soltar, eventos que se van achicando, todos para el mismo lado. */
const inercia = (desde: number, signo = 1): [number, number][] => {
  const r: [number, number][] = []
  for (let d = desde; d >= 1; d = Math.floor(d * 0.85)) r.push([signo * d, 0])
  return r
}

test('un segundo deslizamiento encima de la inercia del primero también cambia (sin tocar el pad)', () => {
  const r = gesto([...Array(8).fill([20, 0]), ...inercia(20), ...Array(8).fill([6, 0]), ...Array(8).fill([20, 0])])
  assert.deepEqual(r.cambios, [1, 1])
})

test('al revés encima de la inercia también vale', () => {
  assert.deepEqual(gesto([...Array(8).fill([20, 0]), ...inercia(20), ...Array(8).fill([-20, 0])]).cambios, [1, -1])
})

test('la inercia sola, con algún salto chico, no cambia de nuevo', () => {
  const ruido = inercia(30).map(([dx], i): [number, number] => [dx + (i % 3 === 0 ? 2 : 0), 0])
  assert.deepEqual(gesto([...Array(6).fill([20, 0]), ...ruido]).cambios, [1])
})

test('un deslizamiento largo que acelera sin frenarse cambia una sola vez', () => {
  assert.deepEqual(gesto([[10, 0], [20, 0], [30, 0], [40, 0], [50, 0], [60, 0], [70, 0], [80, 0], [90, 0]]).cambios, [1])
})

test('los dedos que frenan un poco y vuelven a acelerar en el mismo gesto no saltan dos paneles', () => {
  assert.deepEqual(gesto([...Array(6).fill([20, 0]), [30, 0], [8, 0], [25, 0], ...Array(8).fill([20, 0])]).cambios, [1])
  assert.deepEqual(gesto([...Array(6).fill([20, 0]), [35, 0], [10, 0], [6, 0], [30, 0], [35, 0], ...Array(10).fill([25, 0])]).cambios, [1])
})
