import test from 'node:test'
import assert from 'node:assert/strict'
import { availableConv, loadLastConv, navReduce, parseConv, restoreTarget, saveLastConv, type KeyValueStore } from './nav'

const team = { kind: 'team', id: 't1' } as const
const dm = { kind: 'dm', id: 'd1' } as const

const memory = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k)
  }
}

test('entrar a una conversación la deja guardada aunque se cierre el panel', () => {
  let s = navReduce({ open: false }, { type: 'open', conv: team })
  s = navReduce(s, { type: 'close' })
  assert.deepEqual(s, { open: false, conv: team })
  assert.deepEqual(navReduce(s, { type: 'open' }), { open: true, conv: team })
})

test('abrir otra conversación (una notificación) reemplaza la anterior', () => {
  assert.deepEqual(navReduce({ open: true, conv: team }, { type: 'open', conv: dm }), { open: true, conv: dm })
})

test('solo volver saca de la conversación', () => {
  const s = navReduce({ open: true, conv: team }, { type: 'back' })
  assert.deepEqual(s, { open: true })
  assert.deepEqual(navReduce(navReduce(s, { type: 'close' }), { type: 'open' }), { open: true, conv: undefined })
})

test('availableConv cae a la lista si el equipo o el directo ya no están', () => {
  assert.deepEqual(availableConv(team, ['t1'], []), team)
  assert.equal(availableConv(team, ['t2'], ['t1']), undefined)
  assert.equal(availableConv(dm, [], ['d1']) && 'ok', 'ok')
  assert.equal(availableConv(undefined, ['t1'], []), undefined)
})

test('la última conversación se guarda por usuario', () => {
  const st = memory()
  saveLastConv(st, 'u1', team)
  saveLastConv(st, 'u2', dm)
  assert.deepEqual(loadLastConv(st, 'u1'), team)
  assert.deepEqual(loadLastConv(st, 'u2'), dm)
  saveLastConv(st, 'u1', undefined)
  assert.equal(loadLastConv(st, 'u1'), undefined)
  assert.deepEqual(loadLastConv(st, 'u2'), dm)
})

test('parseConv rechaza lo que no es una conversación', () => {
  assert.equal(parseConv(null), undefined)
  assert.equal(parseConv('no es json'), undefined)
  assert.equal(parseConv('{"kind":"otro","id":"x"}'), undefined)
  assert.equal(parseConv('{"kind":"team","id":"../x"}'), undefined)
  assert.equal(parseConv('{"kind":"team","id":5}'), undefined)
  assert.deepEqual(parseConv('{"kind":"dm","id":"abc-1","extra":1}'), { kind: 'dm', id: 'abc-1' })
})

test('restoreTarget espera las listas antes de decidir que la conversación ya no está', () => {
  const saved = { kind: 'team' as const, id: 't1' }
  assert.deepEqual(restoreTarget(saved, { loaded: false, teamIds: [], threadIds: [] }), { ready: false })
  assert.deepEqual(restoreTarget(saved, { loaded: true, teamIds: ['t1'], threadIds: [] }), { ready: true, conv: saved })
  assert.deepEqual(restoreTarget(saved, { loaded: true, teamIds: [], threadIds: [] }), { ready: true, conv: undefined })
})
