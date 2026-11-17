import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentState } from '../shared/types'
import { nextAgentState } from './agent-machine'

const VIVOS: AgentState[] = ['idle', 'working', 'waiting', 'done']

test('con la terminal viva, cada hook lleva a su estado', () => {
  for (const prev of [undefined, ...VIVOS])
    for (const hook of VIVOS) assert.equal(nextAgentState(prev, { hook }), hook, `${prev} + ${hook}`)
})

test('un hook tardío no revive un espacio cerrado ni uno dormido', () => {
  for (const hook of VIVOS) {
    assert.equal(nextAgentState('exited', { hook }), null)
    assert.equal(nextAgentState('sleeping', { hook }), null)
  }
})

test('abrir la terminal deja el espacio listo si no había estado, estaba cerrado o dormido', () => {
  assert.equal(nextAgentState(undefined, 'start'), 'idle')
  assert.equal(nextAgentState('exited', 'start'), 'idle')
  assert.equal(nextAgentState('sleeping', 'start'), 'idle')
})

test('reconectarse a una terminal viva no pisa lo que Claude estaba haciendo', () => {
  for (const prev of VIVOS) assert.equal(nextAgentState(prev, 'start'), null)
})

test('la salida de la terminal cierra el espacio, salvo que esté dormido', () => {
  for (const prev of [undefined, ...VIVOS, 'exited' as const]) assert.equal(nextAgentState(prev, 'exit'), 'exited')
  assert.equal(nextAgentState('sleeping', 'exit'), null)
})

test('dormir vale desde cualquier estado y despertar solo desde dormido', () => {
  for (const prev of [undefined, ...VIVOS, 'exited' as const, 'sleeping' as const]) assert.equal(nextAgentState(prev, 'sleep'), 'sleeping')
  assert.equal(nextAgentState('sleeping', 'wake'), 'idle')
  for (const prev of [undefined, ...VIVOS, 'exited' as const]) assert.equal(nextAgentState(prev, 'wake'), null)
})
