import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentState } from '../../../shared/types'
import { resumenCuenta } from './cuenta-resumen'

const estados: Record<string, AgentState> = { a: 'waiting', b: 'working', c: 'working', d: 'idle', e: 'done' }
const permisos: Record<string, number> = { c: 1, f: 2 }
const estado = (id: string): AgentState | undefined => estados[id]
const perm = (id: string): number => permisos[id] ?? 0

test('sin espacios o sin nada para mirar, el resumen queda vacío', () => {
  assert.deepEqual(resumenCuenta([], estado, perm), { esperan: 0, trabajando: 0, texto: '' })
  assert.equal(resumenCuenta(['d', 'e', 'zzz'], estado, perm).texto, '')
})

test('cuenta los que esperan y los que trabajan', () => {
  assert.deepEqual(resumenCuenta(['a', 'b', 'd'], estado, perm), { esperan: 1, trabajando: 1, texto: '1 te espera, 1 trabajando' })
})

test('un permiso pendiente cuenta como espera, también sin estado, y no se repite como trabajando', () => {
  const r = resumenCuenta(['a', 'b', 'c', 'f'], estado, perm)
  assert.equal(r.esperan, 3)
  assert.equal(r.trabajando, 1)
  assert.equal(r.texto, '3 te esperan, 1 trabajando')
})

test('solo trabajando no menciona a los que esperan', () => {
  assert.equal(resumenCuenta(['b', 'b'], estado, perm).texto, '2 trabajando')
})
