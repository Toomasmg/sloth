import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VENTANA_5H_MS, calcularCupo, nivelDe, textoRenovacion, tokensCupo, topeDePlan, topeEfectivo, ventanaActiva } from './cupo'

const H = 60 * 60 * 1000
const t0 = Date.UTC(2026, 10, 26, 12, 0, 0)

test('tokensCupo: no suma la caché leída', () => {
  assert.equal(tokensCupo({ input: 10, output: 20, cacheWrite: 5 }), 35)
})

test('topeDePlan: tabla de planes', () => {
  const casos: [string | undefined, number | undefined][] = [
    ['Pro', 2_000_000],
    [' pro ', 2_000_000],
    ['Team', 4_000_000],
    ['Max', 10_000_000],
    ['Max 5x', 10_000_000],
    ['Max 20x', 20_000_000],
    ['20x Max', 20_000_000],
    ['Enterprise', undefined],
    ['', undefined],
    [undefined, undefined]
  ]
  for (const [plan, esperado] of casos) assert.equal(topeDePlan(plan), esperado, String(plan))
})

test('topeEfectivo: el tope propio pisa al del plan; 0, negativo o NaN se ignoran', () => {
  assert.equal(topeEfectivo('Pro', 500_000), 500_000)
  assert.equal(topeEfectivo('Pro', 0), 2_000_000)
  assert.equal(topeEfectivo('Pro', -5), 2_000_000)
  assert.equal(topeEfectivo('Pro', Number.NaN), 2_000_000)
  assert.equal(topeEfectivo(undefined, undefined), undefined)
  assert.equal(topeEfectivo(undefined, 1_000), 1_000)
  assert.equal(topeEfectivo('Pro', 5e12), 1_000_000_000)
})

test('ventanaActiva: sin mensajes no hay ventana', () => {
  assert.equal(ventanaActiva([], t0), undefined)
})

test('ventanaActiva: la ventana arranca en el primer mensaje y dura 5 h exactas', () => {
  const v = ventanaActiva([{ ts: t0 - 2 * H, tokens: 100 }, { ts: t0 - H, tokens: 50 }], t0)
  assert.deepEqual(v, { inicio: t0 - 2 * H, fin: t0 + 3 * H, tokens: 150 })
})

test('ventanaActiva: una ventana vencida no cuenta', () => {
  assert.equal(ventanaActiva([{ ts: t0 - 6 * H, tokens: 100 }], t0), undefined)
})

test('ventanaActiva: el mensaje posterior al fin abre otra ventana y no arrastra lo anterior', () => {
  const eventos = [
    { ts: t0 - 6 * H, tokens: 10 },
    { ts: t0 - 4 * H, tokens: 20 },
    { ts: t0 - H, tokens: 30 }
  ]
  // La primera ventana cubre -6 h..-1 h; el mensaje de -1 h cae justo en el fin y abre la segunda.
  assert.deepEqual(ventanaActiva(eventos, t0), { inicio: t0 - H, fin: t0 + 4 * H, tokens: 30 })
})

test('ventanaActiva: ignora mensajes del futuro, desordenados y con tokens raros', () => {
  const v = ventanaActiva(
    [
      { ts: t0 + H, tokens: 999 },
      { ts: t0 - H, tokens: -4 },
      { ts: t0 - 2 * H, tokens: 7 },
      { ts: Number.NaN, tokens: 1 }
    ],
    t0
  )
  assert.deepEqual(v, { inicio: t0 - 2 * H, fin: t0 - 2 * H + VENTANA_5H_MS, tokens: 7 })
})

test('nivelDe: umbrales', () => {
  assert.deepEqual([0, 69, 70, 89, 90, 99, 100, 250].map(nivelDe), ['ok', 'ok', 'atencion', 'atencion', 'alto', 'alto', 'lleno', 'lleno'])
})

test('calcularCupo: sin uso, con tope', () => {
  assert.deepEqual(calcularCupo(undefined, 1000, t0), { usados: 0, tope: 1000, pct: 0, nivel: 'ok', renueva: undefined })
})

test('calcularCupo: porcentaje y renovación', () => {
  const c = calcularCupo({ inicio: t0 - H, fin: t0 + 4 * H, tokens: 820 }, 1000, t0)
  assert.deepEqual(c, { usados: 820, tope: 1000, pct: 82, nivel: 'atencion', renueva: t0 + 4 * H })
})

test('calcularCupo: tope 0, ausente o inválido no divide por cero', () => {
  const v = { inicio: t0 - H, fin: t0 + 4 * H, tokens: 820 }
  for (const tope of [0, undefined, -1, Number.NaN]) {
    const c = calcularCupo(v, tope, t0)
    assert.equal(c.nivel, 'sin-tope')
    assert.equal(c.pct, undefined)
    assert.equal(c.usados, 820)
  }
})

test('calcularCupo: pasado el tope queda lleno y el porcentaje se acota', () => {
  const c = calcularCupo({ inicio: t0, fin: t0 + 5 * H, tokens: 5_000_000 }, 1000, t0)
  assert.equal(c.pct, 999)
  assert.equal(c.nivel, 'lleno')
})

test('calcularCupo: una ventana ya vencida cuenta como sin uso', () => {
  const c = calcularCupo({ inicio: t0 - 6 * H, fin: t0 - H, tokens: 900 }, 1000, t0)
  assert.deepEqual(c, { usados: 0, tope: 1000, pct: 0, nivel: 'ok', renueva: undefined })
})

test('textoRenovacion: mismo día, sin cruzar medianoche', () => {
  const ahora = Date.UTC(2026, 10, 26, 15, 0)
  assert.equal(textoRenovacion(Date.UTC(2026, 10, 26, 17, 10), ahora, 'UTC'), '17:10')
})

test('textoRenovacion: la ventana cruza la medianoche', () => {
  const ahora = Date.UTC(2026, 10, 26, 21, 0)
  assert.equal(textoRenovacion(Date.UTC(2026, 10, 27, 1, 10), ahora, 'UTC'), 'mañana 01:10')
})

test('textoRenovacion: la zona horaria cambia el día y la hora', () => {
  // 02:30 UTC del 27 es 23:30 del 26 en Buenos Aires: para quien está allá sigue siendo «hoy».
  const ahora = Date.UTC(2026, 10, 26, 20, 0)
  const renueva = Date.UTC(2026, 10, 27, 2, 30)
  assert.equal(textoRenovacion(renueva, ahora, 'America/Argentina/Buenos_Aires'), '23:30')
  assert.equal(textoRenovacion(renueva, ahora, 'UTC'), 'mañana 02:30')
})

test('textoRenovacion: medianoche exacta se escribe 00:00, no 24:00', () => {
  const ahora = Date.UTC(2026, 10, 26, 20, 0)
  assert.equal(textoRenovacion(Date.UTC(2026, 10, 27, 0, 0), ahora, 'UTC'), 'mañana 00:00')
})
