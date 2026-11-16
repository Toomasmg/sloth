import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alternarCuenta, ordenarGrants, segundosRestantes, vigentes } from './mcp-ask'
import type { ChatMcpAsk, ChatMcpGrant } from '../../../../shared/chat-mcp'

test('segundosRestantes no baja de 0 y redondea hacia arriba', () => {
  assert.equal(segundosRestantes(10_000, 0), 10)
  assert.equal(segundosRestantes(10_000, 9_001), 1)
  assert.equal(segundosRestantes(10_000, 10_000), 0)
  assert.equal(segundosRestantes(10_000, 50_000), 0)
})

test('vigentes saca los vencidos', () => {
  const a = { id: 'a', expiresAt: 5 } as ChatMcpAsk
  const b = { id: 'b', expiresAt: 20 } as ChatMcpAsk
  assert.deepEqual(vigentes([a, b], 10).map((x) => x.id), ['b'])
})

test('ordenarGrants es estable: por nombre y después por cuenta, sin mutar la lista', () => {
  const g = (accountId: string, id: string, nombre: string): ChatMcpGrant => ({ accountId, conv: { kind: 'team', id }, nombre, at: 0 })
  const lista = [g('b', '2', 'beta'), g('b', '1', 'alfa'), g('a', '1', 'alfa')]
  const r = ordenarGrants(lista)
  assert.deepEqual(r.map((x) => `${x.nombre}/${x.accountId}`), ['alfa/a', 'alfa/b', 'beta/b'])
  assert.equal(lista[0].nombre, 'beta')
})

test('alternarCuenta suma sin repetir y saca', () => {
  assert.deepEqual(alternarCuenta(['a'], 'b', true), ['a', 'b'])
  assert.deepEqual(alternarCuenta(['a'], 'a', true), ['a'])
  assert.deepEqual(alternarCuenta(['a', 'b'], 'a', false), ['b'])
  assert.deepEqual(alternarCuenta([], 'a', false), [])
})
