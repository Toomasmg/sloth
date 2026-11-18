import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { UsoPorDia } from '../../../shared/tickets'
import { costoValido, diaLocal, lastRunTrasError, leerUso, limitesEfectivos, sanearUso, sumarUso, textoFlagViejo, textoTope, TopeVueltasError, vueltasValidas } from './uso'

test('vueltasValidas acepta enteros de 1 a 200 y nada más', () => {
  for (const v of [1, 40, 200]) assert.equal(vueltasValidas(v), v)
  for (const v of [0, 201, 1.5, '40', NaN, Infinity, -1, null, undefined, {}]) assert.equal(vueltasValidas(v), undefined, String(v))
})

test('costoValido acepta de 0,01 a 100 y redondea a 2 decimales', () => {
  assert.equal(costoValido(0.01), 0.01)
  assert.equal(costoValido(2.345), 2.35)
  assert.equal(costoValido(100), 100)
  for (const v of [0, 0.004, 100.01, -1, NaN, Infinity, '2', null]) assert.equal(costoValido(v), undefined, String(v))
})

const RESULTADO = { type: 'result', subtype: 'success', total_cost_usd: 0.12, duration_ms: 3400, num_turns: 6, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 } }

test('leerUso lee un objeto, un arreglo y líneas con basura antes', () => {
  const esperado = { costUsd: 0.12, durationMs: 3400, numTurns: 6, tokens: 115 }
  assert.deepEqual(leerUso(JSON.stringify(RESULTADO)), esperado)
  assert.deepEqual(leerUso(JSON.stringify([{ type: 'system' }, RESULTADO, { type: 'otro' }])), esperado)
  assert.deepEqual(leerUso(`aviso raro\n${JSON.stringify({ type: 'system' })}\n${JSON.stringify(RESULTADO)}\n`), esperado)
})

test('leerUso marca el tope según el subtype', () => {
  assert.equal(leerUso(JSON.stringify({ ...RESULTADO, subtype: 'error_max_turns' }))?.tope, 'vueltas')
  assert.equal(leerUso(JSON.stringify({ ...RESULTADO, subtype: 'error_max_budget_usd' }))?.tope, 'costo')
  assert.equal(leerUso(JSON.stringify(RESULTADO))?.tope, undefined)
})

test('leerUso ignora lo no numérico y no tira con salidas raras', () => {
  assert.deepEqual(leerUso(JSON.stringify({ type: 'result', total_cost_usd: '1', num_turns: null, usage: { input_tokens: 'x', output_tokens: 4 } })), { tokens: 4 })
  for (const s of ['', '   ', 'no es json', '[]', '{"type":"system"}', '[1,null,"x"]', 'null', '7']) assert.equal(leerUso(s), undefined, s)
})

test('TopeVueltasError conserva el tope y el uso', () => {
  const e = new TopeVueltasError('cortada', 'vueltas', { numTurns: 40 })
  assert.ok(e instanceof Error)
  assert.equal(e.message, 'cortada')
  assert.equal(e.tope, 'vueltas')
  assert.deepEqual(e.uso, { numTurns: 40 })
})

test('textoTope dice cuál fue el tope y avisa si una acción pudo quedar a medias', () => {
  assert.equal(textoTope('vueltas', 40), 'La consulta se cortó por tope de vueltas (40). Podés continuar con más vueltas o subir el tope en los ajustes.')
  assert.match(textoTope('vueltas', 40, true), /Revisá el ticket: el cambio pudo quedar a medias\.$/)
  assert.match(textoTope('costo', 2.5), /tope de costo \(US\$ 2,5\)/)
  assert.ok(!textoTope('costo', 2.5).includes('a medias'))
})

test('sumarUso acumula por día y conector sin mutar lo anterior', () => {
  const a = sumarUso(undefined, '2026-11-17', 'gruv', { costUsd: 0.1, numTurns: 4, durationMs: 1000 })
  const copia = structuredClone(a)
  const b = sumarUso(a, '2026-11-17', 'gruv', { costUsd: 0.2, numTurns: 6 })
  const c = sumarUso(b, '2026-11-17', 'github', {})
  assert.deepEqual(a, copia)
  assert.deepEqual(b['2026-11-17'].gruv, { corridas: 2, costUsd: 0.1 + 0.2, vueltas: 10, durationMs: 1000 })
  assert.deepEqual(c['2026-11-17'].github, { corridas: 1, costUsd: 0, vueltas: 0, durationMs: 0 })
  assert.equal(c['2026-11-17'].gruv, b['2026-11-17'].gruv)
})

test('sumarUso conserva solo los 60 días más nuevos', () => {
  let uso: UsoPorDia | undefined
  for (let i = 0; i < 65; i++) uso = sumarUso(uso, diaLocal(Date.UTC(2026, 0, 1 + i, 12)), 'gruv', { costUsd: 1 })
  const dias = Object.keys(uso ?? {})
  assert.equal(dias.length, 60)
  assert.equal(dias[0], diaLocal(Date.UTC(2026, 0, 6, 12)))
  assert.equal(dias[59], diaLocal(Date.UTC(2026, 0, 65, 12)))
})

test('sanearUso descarta claves malas, negativos y no números', () => {
  const bueno = { corridas: 2, costUsd: 0.5, vueltas: 9, durationMs: 100 }
  const raw = {
    '2026-11-17': { gruv: bueno, 'Mal Id': bueno, github: { ...bueno, costUsd: -1 }, asana: { ...bueno, vueltas: '3' }, jira: 'x' },
    '17/11/2026': { gruv: bueno },
    '2026-11-16': { gruv: { corridas: NaN, costUsd: 0, vueltas: 0, durationMs: 0 } }
  }
  assert.deepEqual(sanearUso(raw), { '2026-11-17': { gruv: bueno } })
  for (const v of [undefined, null, 'x', [], {}, { '2026-11-17': {} }]) assert.equal(sanearUso(v), undefined)
})

test('sanearUso acota días y conectores y es idempotente', () => {
  const acum = { corridas: 1, costUsd: 0, vueltas: 0, durationMs: 0 }
  const dias = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [diaLocal(Date.UTC(2026, 0, 1 + i, 12)), { gruv: acum }]))
  const una = sanearUso(dias)
  assert.equal(Object.keys(una ?? {}).length, 60)
  assert.deepEqual(sanearUso(una), una)
  const muchos = { '2026-11-17': Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`con-${String(i).padStart(2, '0')}`, acum])) }
  assert.equal(Object.keys(sanearUso(muchos)?.['2026-11-17'] ?? {}).length, 50)
})

test('diaLocal arma YYYY-MM-DD con ceros', () => {
  assert.match(diaLocal(Date.now()), /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(diaLocal(new Date(2026, 0, 5, 10).getTime()), '2026-01-05')
})

test('textoTope con el máximo de vueltas no invita a continuar', () => {
  const t = textoTope('vueltas', 200)
  assert.match(t, /tope de vueltas \(200\)/)
  assert.ok(!t.includes('continuar'))
  assert.match(textoTope('vueltas', 199), /continuar/)
})

test('lastRunTrasError conserva el tope solo si el error es el corte', () => {
  const cortada = { numTurns: 40, maxTurns: 40, tope: 'vueltas' as const }
  const corte = new TopeVueltasError('cortada', 'costo', { costUsd: 1, tope: 'costo' })
  assert.deepEqual(lastRunTrasError(undefined, corte, 20), { costUsd: 1, tope: 'costo', maxTurns: 20 })
  for (const e of [new Error('Consulta cancelada.'), new Error('timeout'), 'raro', undefined]) {
    assert.deepEqual(lastRunTrasError(cortada, e, 40), { numTurns: 40, maxTurns: 40 })
  }
  assert.equal(lastRunTrasError(undefined, new Error('x'), 40), undefined)
  const sana = { numTurns: 3 }
  assert.equal(lastRunTrasError(sana, undefined, 40), sana)
  assert.ok(!('tope' in (lastRunTrasError(cortada, undefined, 40) ?? {})))
})

test('limitesEfectivos toma los topes válidos o los de defecto', () => {
  assert.deepEqual(limitesEfectivos({ maxTurns: 10, maxCostUsd: 2.5 }), { vueltas: 10, costo: 2.5 })
  assert.deepEqual(limitesEfectivos({ maxTurns: 999, maxCostUsd: 0 }), { vueltas: 40 })
  assert.deepEqual(limitesEfectivos({}), { vueltas: 40 })
})

test('textoFlagViejo reconoce el rechazo de --max-budget-usd', () => {
  assert.match(textoFlagViejo("No se pudo leer (salió con código 1: error: unknown option '--max-budget-usd')") ?? '', /actualizala o borrá el tope/)
  assert.equal(textoFlagViejo("unknown option '--otra'"), undefined)
  assert.equal(textoFlagViejo('Consulta cancelada.'), undefined)
})

test('sumarUso trata negativos, NaN e infinitos como 0 y no desborda', () => {
  const a = sumarUso(undefined, '2026-11-17', 'gruv', { costUsd: 0.5, numTurns: 2, durationMs: 10 })
  const b = sumarUso(a, '2026-11-17', 'gruv', { costUsd: -3, numTurns: NaN, durationMs: Infinity })
  assert.deepEqual(b['2026-11-17'].gruv, { corridas: 2, costUsd: 0.5, vueltas: 2, durationMs: 10 })
  const grande = sumarUso(sumarUso(undefined, '2026-11-17', 'gruv', { costUsd: 1e308 }), '2026-11-17', 'gruv', { costUsd: 1e308 })
  assert.equal(grande['2026-11-17'].gruv.costUsd, 1e308)
  assert.deepEqual(sanearUso(grande), grande)
})

test('sanearUso descarta días imposibles', () => {
  const bueno = { corridas: 1, costUsd: 0, vueltas: 0, durationMs: 0 }
  assert.deepEqual(sanearUso({ '2026-13-45': { gruv: bueno }, '2026-02-30': { gruv: bueno }, '2026-02-28': { gruv: bueno } }), { '2026-02-28': { gruv: bueno } })
})
