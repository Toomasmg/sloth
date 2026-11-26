import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PrRow } from '../../../shared/prs'
import { checkQueFalla, chipsDePr, estadoDeRow, type EstadoPr } from './pr-chips'

const base: EstadoPr = { ci: 'pass', review: 'approved', isDraft: false, conflicto: false, failing: [] }

test('chipsDePr: tabla', () => {
  const casos: [string, Partial<EstadoPr>, string[]][] = [
    ['todo bien', {}, ['CI pasa', 'aprobado']],
    ['CI rojo', { ci: 'fail', review: 'pending' }, ['CI falla', 'review pendiente']],
    ['corriendo', { ci: 'running', review: 'changes' }, ['CI corriendo', 'cambios pedidos']],
    ['sin CI ni review', { ci: 'none', review: 'none' }, ['sin CI']],
    ['borrador tapa la review', { isDraft: true, review: 'pending' }, ['CI pasa', 'borrador']],
    ['conflictos', { conflicto: true }, ['CI pasa', 'aprobado', 'conflictos']]
  ]
  for (const [nombre, o, esperado] of casos) {
    assert.deepEqual(chipsDePr({ ...base, ...o }).map((c) => c.texto), esperado, nombre)
  }
})

test('CI rojo y conflictos son de tono malo', () => {
  const chips = chipsDePr({ ...base, ci: 'fail', conflicto: true })
  assert.deepEqual(chips.map((c) => c.tono), ['bad', 'ok', 'bad'])
})

test('checkQueFalla', () => {
  assert.equal(checkQueFalla([]), null)
  assert.equal(checkQueFalla(['  ']), null)
  assert.equal(checkQueFalla(['build']), 'build')
  assert.equal(checkQueFalla(['build', 'lint', 'test']), 'build y 2 más')
})

test('estadoDeRow traduce el vocabulario de PRs al de Equipo', () => {
  const row = { checks: 'pending', review: 'required', isDraft: false, mergeable: 'conflict', failing: [{ name: 'lint', url: null }] } as unknown as PrRow
  assert.deepEqual(estadoDeRow(row), { ci: 'running', review: 'pending', isDraft: false, conflicto: true, failing: ['lint'] })
  assert.equal(estadoDeRow({ ...row, checks: 'ok' } as PrRow).ci, 'pass')
  assert.equal(estadoDeRow({ ...row, checks: 'none', review: 'none' } as PrRow).review, 'none')
})
