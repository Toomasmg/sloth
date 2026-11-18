import test from 'node:test'
import assert from 'node:assert/strict'
import { ajusteAncla, alturaTotal, calcularVentana, indiceEnOffset, offsetDeIndice, tramos, type Entrada } from './ventana-virtual'

const base = (over: Partial<Entrada> = {}): Entrada => ({ n: 100, scrollTop: 0, alto: 300, alturas: [], estimada: 50, margen: 0, fijos: [], ...over })

test('lista vacía: nada que dibujar', () => {
  assert.deepEqual(calcularVentana(base({ n: 0 })), { desde: 0, hasta: 0, antes: 0, despues: 0, fijos: [] })
  assert.deepEqual(tramos(calcularVentana(base({ n: 0 })), 0, [], 50), [])
  assert.equal(indiceEnOffset([], 50, 20, 0), 0)
})

test('un solo elemento: se dibuja entero, haya o no scroll', () => {
  for (const scrollTop of [0, 10, 9999]) {
    assert.deepEqual(calcularVentana(base({ n: 1, scrollTop, alturas: [500] })), { desde: 0, hasta: 1, antes: 0, despues: 0, fijos: [] })
  }
})

test('arriba de todo con alturas estimadas', () => {
  const v = calcularVentana(base())
  assert.deepEqual(v, { desde: 0, hasta: 6, antes: 0, despues: 94 * 50, fijos: [] })
})

test('el margen suma filas arriba y abajo', () => {
  const v = calcularVentana(base({ scrollTop: 1000, margen: 100 }))
  assert.equal(v.desde, 18)
  assert.equal(v.hasta, 28)
  assert.equal(v.antes, 18 * 50)
  assert.equal(v.antes + (v.hasta - v.desde) * 50 + v.despues, 5000)
})

test('scroll hasta el final: la última fila entra y no hay espacio de más', () => {
  const v = calcularVentana(base({ scrollTop: 4700 }))
  assert.equal(v.hasta, 100)
  assert.equal(v.despues, 0)
  assert.equal(v.desde, 94)
})

test('scrollTop de más (la lista se achicó) se lleva al final', () => {
  const v = calcularVentana(base({ n: 10, scrollTop: 99_999 }))
  assert.equal(v.hasta, 10)
  assert.equal(v.despues, 0)
  assert.ok(v.desde <= 4)
})

test('alturas distintas y parciales: lo medido manda, lo demás es la estimada', () => {
  const alturas = [200, undefined, 20, 400, undefined]
  assert.equal(offsetDeIndice(alturas, 50, 0), 0)
  assert.equal(offsetDeIndice(alturas, 50, 3), 270)
  assert.equal(offsetDeIndice(alturas, 50, 5), 720)
  assert.equal(alturaTotal(alturas, 50, 7), 820)
  const v = calcularVentana({ n: 5, scrollTop: 250, alto: 100, alturas, estimada: 50, margen: 0, fijos: [] })
  assert.deepEqual(v, { desde: 2, hasta: 4, antes: 250, despues: 50, fijos: [] })
})

test('cambio de tamaño: si una fila de arriba crece, la ventana se corre y el ancla se compensa', () => {
  const antes = [100, 100, 100, 100, 100, 100]
  const despues = [100, 160, 100, 100, 100, 100]
  const e = { n: 6, scrollTop: 250, alto: 100, estimada: 100, margen: 0, fijos: [] as number[] }
  const ancla = indiceEnOffset(antes, 100, e.scrollTop)
  assert.equal(ancla, 2)
  const delta = ajusteAncla(offsetDeIndice(antes, 100, ancla), offsetDeIndice(despues, 100, ancla))
  assert.equal(delta, 60)
  const v = calcularVentana({ ...e, scrollTop: e.scrollTop + delta, alturas: despues })
  assert.equal(v.desde, 2)
})

test('ancla al prepender k filas: la fila ancla queda en el mismo lugar de la pantalla', () => {
  const alturas = Array.from({ length: 20 }, (_, i) => 40 + (i % 3) * 10)
  const scrollTop = 333
  const ancla = indiceEnOffset(alturas, 50, scrollTop)
  const dentro = scrollTop - offsetDeIndice(alturas, 50, ancla)
  const nuevas = [70, 80, 90]
  const tras = [...nuevas, ...alturas]
  const delta = ajusteAncla(offsetDeIndice(alturas, 50, ancla), offsetDeIndice(tras, 50, ancla + nuevas.length))
  assert.equal(delta, 240)
  assert.equal(indiceEnOffset(tras, 50, scrollTop + delta), ancla + nuevas.length)
  assert.equal(scrollTop + delta - offsetDeIndice(tras, 50, ancla + nuevas.length), dentro)
})

test('indiceEnOffset: bordes, antes del principio y pasado el final', () => {
  const alturas = [10, 20, 30]
  assert.equal(indiceEnOffset(alturas, 50, -5), 0)
  assert.equal(indiceEnOffset(alturas, 50, 0), 0)
  assert.equal(indiceEnOffset(alturas, 50, 9), 0)
  assert.equal(indiceEnOffset(alturas, 50, 10), 1)
  assert.equal(indiceEnOffset(alturas, 50, 59), 2)
  assert.equal(indiceEnOffset(alturas, 50, 60), 2)
  assert.equal(indiceEnOffset(alturas, 50, 5000), 2)
})

test('fijos: los de adentro no se duplican, los de afuera se conservan y los inválidos se ignoran', () => {
  const v = calcularVentana(base({ scrollTop: 2000, fijos: [3, 41, 41, 80, -1, 100, 1.5, NaN] }))
  assert.equal(v.desde, 40)
  assert.deepEqual(v.fijos, [3, 80])
})

test('tramos: espaciadores y filas suman la altura total y respetan el orden', () => {
  const alturas = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 30 : 70))
  const v = calcularVentana({ n: 100, scrollTop: 2000, alto: 300, alturas, estimada: 50, margen: 0, fijos: [3, 80] })
  const t = tramos(v, 100, alturas, 50)
  const filas = t.flatMap((x) => (x.tipo === 'fila' ? [x.i] : []))
  assert.deepEqual(filas, [3, ...Array.from({ length: v.hasta - v.desde }, (_, k) => v.desde + k), 80])
  const alto = t.reduce((s, x) => s + (x.tipo === 'espacio' ? x.alto : alturas[x.i] ?? 50), 0)
  assert.equal(alto, alturaTotal(alturas, 50, 100))
  assert.ok(t.every((x, i) => x.tipo !== 'espacio' || t[i + 1]?.tipo !== 'espacio'))
})

test('tramos sin fijos: espacio, ventana, espacio', () => {
  const v = calcularVentana(base({ scrollTop: 1000 }))
  const t = tramos(v, 100, [], 50)
  assert.deepEqual(t[0], { tipo: 'espacio', alto: v.antes })
  assert.deepEqual(t[t.length - 1], { tipo: 'espacio', alto: v.despues })
  assert.equal(t.length, v.hasta - v.desde + 2)
})

test('tramos arriba de todo no mete espacio de cero', () => {
  const t = tramos(calcularVentana(base({ n: 3, alto: 1000 })), 3, [], 50)
  assert.deepEqual(t, [{ tipo: 'fila', i: 0 }, { tipo: 'fila', i: 1 }, { tipo: 'fila', i: 2 }])
})

test('10000 filas con alturas mezcladas se calculan en menos de 50 ms', () => {
  const alturas = Array.from({ length: 10_000 }, (_, i) => (i % 4 === 0 ? undefined : 30 + (i % 7) * 11))
  const t0 = performance.now()
  for (let k = 0; k < 20; k++) {
    const v = calcularVentana({ n: 10_000, scrollTop: k * 20_000, alto: 600, alturas, estimada: 60, margen: 400, fijos: [5, 9000] })
    tramos(v, 10_000, alturas, 60)
  }
  assert.ok(performance.now() - t0 < 50, `tardó ${performance.now() - t0} ms`)
})
