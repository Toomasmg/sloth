import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ID_INICIALIZAR, ID_LIMITES, leerRespuesta, limitesDeResultado, lineaInicializar, lineasDePedido, lineasTrasInicializar } from './codex-limites-core'

const AHORA = 1_700_000_000_000
const EN_UNA_HORA = Math.floor((AHORA + 3_600_000) / 1000)
const EN_UN_DIA = Math.floor((AHORA + 86_400_000) / 1000)

const cinco = { usedPercent: 37, windowDurationMins: 300, resetsAt: EN_UNA_HORA }
const semana = { usedPercent: 12, windowDurationMins: 10080, resetsAt: EN_UN_DIA }

test('los pedidos son una línea JSON cada uno, con ids fijos y sin jsonrpc', () => {
  const lineas = lineasDePedido()
  assert.equal(lineas.length, 3)
  const [init, inicializado, limites] = lineas.map((l) => JSON.parse(l) as Record<string, unknown>)
  assert.equal(init.method, 'initialize')
  assert.equal(init.id, ID_INICIALIZAR)
  assert.deepEqual(init.params, { clientInfo: { name: 'sloth', version: '1' } })
  assert.deepEqual(inicializado, { method: 'initialized' })
  assert.equal(limites.method, 'account/rateLimits/read')
  assert.equal(limites.id, ID_LIMITES)
  assert.equal(lineas.some((l) => l.includes('\n') || l.includes('jsonrpc')), false)
  assert.equal(lineaInicializar(), lineas[0])
  assert.deepEqual(lineasTrasInicializar(), lineas.slice(1))
})

test('las dos ventanas, con el reinicio en ms', () => {
  const r = limitesDeResultado({ rateLimits: { primary: cinco, secondary: semana } }, AHORA)
  assert.deepEqual(r, {
    cincoHoras: { pct: 37, reiniciaEn: EN_UNA_HORA * 1000 },
    semana: { pct: 12, reiniciaEn: EN_UN_DIA * 1000 },
    at: AHORA
  })
})

test('se asigna por duración, no por posición', () => {
  const r = limitesDeResultado({ rateLimits: { primary: semana, secondary: cinco } }, AHORA)
  assert.equal(r.cincoHoras?.pct, 37)
  assert.equal(r.semana?.pct, 12)
})

test('solo semanal: la de cinco horas queda en null, sin ceros', () => {
  const r = limitesDeResultado({ rateLimits: { primary: semana, secondary: null } }, AHORA)
  assert.equal(r.cincoHoras, null)
  assert.equal(r.semana?.pct, 12)
})

test('tolera snake_case', () => {
  const r = limitesDeResultado(
    { rate_limits: { primary: { used_percent: 20, window_duration_mins: 300, resets_at: EN_UNA_HORA }, secondary: null } },
    AHORA
  )
  assert.deepEqual(r.cincoHoras, { pct: 20, reiniciaEn: EN_UNA_HORA * 1000 })
})

test('un reinicio en ms se respeta y uno ausente da reiniciaEn null', () => {
  const r = limitesDeResultado(
    { rateLimits: { primary: { ...cinco, resetsAt: AHORA + 60_000 }, secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: null } } },
    AHORA
  )
  assert.equal(r.cincoHoras?.reiniciaEn, AHORA + 60_000)
  assert.deepEqual(r.semana, { pct: 5, reiniciaEn: null })
})

test('una ventana de otra duración se descarta, sin adivinar', () => {
  const r = limitesDeResultado({ rateLimits: { primary: { usedPercent: 50, windowDurationMins: 60, resetsAt: EN_UNA_HORA }, secondary: semana } }, AHORA)
  assert.equal(r.cincoHoras, null)
  assert.equal(r.semana?.pct, 12)
  const sinDuracion = limitesDeResultado({ rateLimits: { primary: { usedPercent: 50, windowDurationMins: null }, secondary: null } }, AHORA)
  assert.deepEqual(sinDuracion, { cincoHoras: null, semana: null, at: AHORA })
})

test('la duración admite la tolerancia y no más', () => {
  const dentro = limitesDeResultado({ rateLimits: { primary: { usedPercent: 1, windowDurationMins: 303 }, secondary: null } }, AHORA)
  assert.equal(dentro.cincoHoras?.pct, 1)
  const fuera = limitesDeResultado({ rateLimits: { primary: { usedPercent: 1, windowDurationMins: 320 }, secondary: null } }, AHORA)
  assert.equal(fuera.cincoHoras, null)
})

test('el porcentaje se acota a 0-100 y uno no finito descarta la ventana', () => {
  const r = limitesDeResultado(
    { rateLimits: { primary: { ...cinco, usedPercent: 150 }, secondary: { ...semana, usedPercent: -3 } } },
    AHORA
  )
  assert.equal(r.cincoHoras?.pct, 100)
  assert.equal(r.semana?.pct, 0)
  for (const malo of [Number.NaN, Infinity, '40', null, undefined]) {
    const x = limitesDeResultado({ rateLimits: { primary: { ...cinco, usedPercent: malo }, secondary: null } }, AHORA)
    assert.equal(x.cincoHoras, null)
  }
})

test('una ventana con el reinicio vencido es null', () => {
  const vencido = Math.floor((AHORA - 1000) / 1000)
  const r = limitesDeResultado({ rateLimits: { primary: { ...cinco, resetsAt: vencido }, secondary: semana } }, AHORA)
  assert.equal(r.cincoHoras, null)
  assert.equal(r.semana?.pct, 12)
})

test('si rateLimits no sirve, prueba el bucket codex de rateLimitsByLimitId', () => {
  const r = limitesDeResultado({ rateLimits: { primary: null, secondary: null }, rateLimitsByLimitId: { codex: { primary: cinco }, otro: { primary: semana } } }, AHORA)
  assert.equal(r.cincoHoras?.pct, 37)
  assert.equal(r.semana, null)
})

test('formas inesperadas dan todo null y nunca tiran', () => {
  const vacio = { cincoHoras: null, semana: null, at: AHORA }
  for (const x of [null, undefined, [], 'x', 5, {}, { rateLimits: 5 }, { rateLimits: [] }, { rateLimits: { primary: 'x', secondary: [1] } }, { rateLimitsByLimitId: 'x' }]) {
    assert.deepEqual(limitesDeResultado(x, AHORA), vacio)
  }
})

test('leerRespuesta: resultado, error y lo que no es una respuesta', () => {
  assert.deepEqual(leerRespuesta('{"id":2,"result":{"a":1}}'), { id: 2, result: { a: 1 }, error: false })
  assert.deepEqual(leerRespuesta('  {"id":2,"result":null}\r'), { id: 2, result: null, error: false })
  assert.deepEqual(leerRespuesta('{"id":2,"error":{"code":-32600,"message":"x"}}'), { id: 2, error: true })
  assert.equal(leerRespuesta('Starting server...'), undefined)
  assert.equal(leerRespuesta(''), undefined)
  assert.equal(leerRespuesta('{roto'), undefined)
  assert.equal(leerRespuesta('[1]'), undefined)
  assert.equal(leerRespuesta('{"method":"account/rateLimits/updated","params":{}}'), undefined)
  assert.equal(leerRespuesta('{"id":3,"method":"item/tool/requestApproval","params":{}}'), undefined)
  assert.equal(leerRespuesta('{"id":"2","result":{}}'), undefined)
  assert.equal(leerRespuesta('{"id":2}'), undefined)
})
