import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aplicarAgente, aplicarParche, camposQuitados, EspejoTerminales, leerCopia } from './espejo-rust'
import type { AgentStatus } from '../shared/types'

test('la copia del estado se lee con listas aunque falten', () => {
  const c = leerCopia({ estado: { version: 1, accounts: [{ id: 'a' }], openPanes: ['w', 3] }, soloLectura: null, confiable: true })
  assert.ok(c)
  assert.deepEqual(c.estado.workspaces, [])
  assert.deepEqual(c.estado.openPanes, ['w'])
  assert.equal(c.estado.version, 1)
  assert.equal(c.confiable, true)
  assert.equal(leerCopia({ estado: 'x' }), undefined)
  assert.equal(leerCopia(null), undefined)
})

test('lo que queda en undefined en un parche se saca del objeto y se avisa a Rust', () => {
  const ws: Record<string, unknown> = { id: 'w', name: 'a', icon: 'x' }
  const parche = { name: 'b', icon: undefined }
  assert.deepEqual(camposQuitados(parche), ['icon'])
  assert.deepEqual(aplicarParche(ws, parche), { id: 'w', name: 'b' })
})

test('el estado de los agentes sigue a Rust y descarta lo que no entiende', () => {
  const m = new Map<string, AgentStatus>()
  assert.equal(aplicarAgente(m, 'w', { state: 'working', detail: 'Bash', at: 5 }), true)
  assert.deepEqual(m.get('w'), { state: 'working', detail: 'Bash', at: 5 })
  assert.equal(aplicarAgente(m, 'w', { state: 'volando', at: 1 }), false)
  assert.equal(aplicarAgente(m, 7, { state: 'idle', at: 1 }), false)
  assert.equal(aplicarAgente(m, 'w', null), true)
  assert.equal(m.size, 0)
})

test('las terminales: corriendo, permisos, tamaños y los eventos para los oyentes', () => {
  const e = new EspejoTerminales()
  assert.equal(e.aplicar(['sesiones', ['w1', 'w2'], ['ajena']]), undefined)
  assert.deepEqual([...e.corriendo], ['w1', 'w2'])
  assert.deepEqual(e.ajenas, ['ajena'])
  assert.deepEqual(e.aplicar(['data', 'w1', [{ seq: 1, data: 'x' }]]), { nombre: 'data', args: ['w1', [{ seq: 1, data: 'x' }]] })
  assert.deepEqual(e.aplicar(['exit', 'w2', 0]), { nombre: 'exit', args: ['w2', 0] })
  assert.deepEqual([...e.corriendo], ['w1'])
  e.aplicar(['start', 'w3'])
  assert.ok(e.corriendo.has('w3'))
  e.aplicar(['tam', 'w3', 100, 30])
  assert.deepEqual(e.tam.get('w3'), { cols: 100, rows: 30 })
  const r = { id: 'p1', ws: 'w1', tool: 'Bash', input: {}, at: 1, expiresAt: 2 }
  assert.equal(e.aplicar(['permission', r])?.nombre, 'permission')
  assert.equal(e.permisos.size, 1)
  e.aplicar(['permission-resolved', 'p1'])
  assert.equal(e.permisos.size, 0)
  const h = e.aplicar(['hook', { ws: 'w1', event: 'Stop' }])
  assert.equal(h?.nombre, 'hook')
  assert.equal(e.hooks.w1.event, 'Stop')
  assert.deepEqual(e.aplicar(['write', 'w1', 'ls\r']), { nombre: 'write', args: ['w1', 'ls\r'] })
  assert.equal(e.aplicar(['info', { mode: 'daemon', pid: 4 }])?.nombre, 'reconnect')
  assert.equal(e.info.pid, 4)
  assert.equal(e.aplicar(['raro']), undefined)
})
