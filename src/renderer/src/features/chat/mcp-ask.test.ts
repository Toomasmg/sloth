import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ordenarGrants, segundosRestantes, vigentes } from './mcp-ask'
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

test('ordenarGrants es estable: por nombre y con ops en orden fijo', () => {
  const g = (id: string, nombre: string, ops: ChatMcpGrant['ops']): ChatMcpGrant => ({ conv: { kind: 'team', id }, nombre, ops, at: 0 })
  const r = ordenarGrants([g('2', 'beta', ['enviar', 'leer']), g('1', 'alfa', ['leer'])])
  assert.deepEqual(r.map((x) => x.nombre), ['alfa', 'beta'])
  assert.deepEqual(r[1].ops, ['leer', 'enviar'])
})
