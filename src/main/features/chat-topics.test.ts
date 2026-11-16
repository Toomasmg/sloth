import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  convOfTopic,
  diffTopics,
  reactionFromBroadcast,
  readFromBroadcast,
  rowFromBroadcast,
  SeenIds,
  Throttle,
  topicOf,
  typingFromBroadcast,
  versionKey,
  wantedTopics
} from './chat-topics'

const T = '11111111-1111-4111-8111-111111111111'
const D = '22222222-2222-4222-8222-222222222222'
const ID = '33333333-3333-4333-8333-333333333333'
const CID = '44444444-4444-4444-8444-444444444444'
const AUTH = '55555555-5555-4555-8555-555555555555'

const teamRow = { id: ID, client_id: CID, team_id: T, thread_id: null, author_id: AUTH, body: 'hola', created_at: '2026-11-12T10:00:00.123456+00:00' }

test('tópico por conversación, ida y vuelta', () => {
  assert.equal(topicOf({ kind: 'team', id: T }), `team:${T}`)
  assert.equal(topicOf({ kind: 'dm', id: D }), `thread:${D}`)
  assert.deepEqual(convOfTopic(`team:${T}`), { kind: 'team', id: T })
  assert.deepEqual(convOfTopic(`thread:${D}`), { kind: 'dm', id: D })
  for (const bad of ['team:', `dm:${D}`, `team:${T}:x`, `realtime:team:${T}`, 'team:no-uuid', ''])
    assert.equal(convOfTopic(bad), undefined, bad)
})

test('tópicos deseados: más activos primero, con tope, sin repetidos', () => {
  const teams = [{ id: T, lastMessageAt: 10 }, { id: 'basura' }]
  const threads = [{ id: D, lastMessageAt: 20 }]
  assert.deepEqual(wantedTopics(teams, threads), [`thread:${D}`, `team:${T}`])
  assert.deepEqual(wantedTopics(teams, threads, 1), [`thread:${D}`])
  assert.deepEqual(wantedTopics([{ id: T }, { id: T }], []), [`team:${T}`])
  assert.deepEqual(wantedTopics(teams, threads, 0), [])
})

test('diff de suscripciones al cambiar las listas', () => {
  assert.deepEqual(diffTopics(['a', 'b'], ['b', 'c']), { add: ['c'], remove: ['a'] })
  assert.deepEqual(diffTopics([], []), { add: [], remove: [] })
})

test('payload válido del tópico suscripto', () => {
  const r = rowFromBroadcast(teamRow, { kind: 'team', id: T })
  assert.deepEqual(r, { id: ID, client_id: CID, team_id: T, author_id: AUTH, body: 'hola', created_at: teamRow.created_at })
  const dm = { ...teamRow, team_id: null, thread_id: D }
  assert.equal(rowFromBroadcast(dm, { kind: 'dm', id: D })?.thread_id, D)
})

test('payload de otra conversación o con forma rara: se descarta', () => {
  const team = { kind: 'team' as const, id: T }
  assert.equal(rowFromBroadcast(teamRow, { kind: 'team', id: D }), undefined, 'otro equipo')
  assert.equal(rowFromBroadcast(teamRow, { kind: 'dm', id: T }), undefined, 'mismo id pero DM')
  assert.equal(rowFromBroadcast({ ...teamRow, thread_id: D }, team), undefined, 'las dos conversaciones')
  for (const bad of [null, 'x', [teamRow], {}]) assert.equal(rowFromBroadcast(bad, team), undefined)
  assert.equal(rowFromBroadcast({ ...teamRow, id: 'x' }, team), undefined)
  assert.equal(rowFromBroadcast({ ...teamRow, client_id: 1 }, team), undefined)
  assert.equal(rowFromBroadcast({ ...teamRow, author_id: undefined }, team), undefined)
  assert.equal(rowFromBroadcast({ ...teamRow, body: '' }, team), undefined)
  assert.equal(rowFromBroadcast({ ...teamRow, body: 'x'.repeat(4001) }, team), undefined)
  assert.equal(rowFromBroadcast({ ...teamRow, body: { toString: 'x' } }, team), undefined)
  assert.equal(rowFromBroadcast({ ...teamRow, created_at: 'ayer' }, team), undefined)
})

test('payload: no se copian claves de más', () => {
  const r = rowFromBroadcast({ ...teamRow, extra: '<script>', __proto__x: 1 }, { kind: 'team', id: T })
  assert.deepEqual(Object.keys(r ?? {}).sort(), ['author_id', 'body', 'client_id', 'created_at', 'id', 'team_id'])
})

test('dedupe: el mismo id por los dos caminos cuenta una sola vez', () => {
  const seen = new SeenIds(2)
  assert.equal(seen.first('a'), true)
  assert.equal(seen.first('a'), false)
  assert.equal(seen.first('b'), true)
  assert.equal(seen.first('c'), true)
  assert.equal(seen.first('a'), true, 'el más viejo se olvida al pasar el tope')
  seen.clear()
  assert.equal(seen.first('c'), true)
})

const team = { kind: 'team' as const, id: T }
const AT = '2026-11-12T10:05:00.000001+00:00'

test('edición, borrado y respuesta por broadcast', () => {
  const edited = rowFromBroadcast({ ...teamRow, body: 'hola!', edited_at: AT, deleted_at: null, reply_to: ID }, team)
  assert.equal(edited?.edited_at, AT)
  assert.equal(edited?.reply_to, ID)
  assert.equal(edited?.deleted_at, undefined)
  const gone = rowFromBroadcast({ ...teamRow, body: '', deleted_at: AT }, team)
  assert.equal(gone?.deleted_at, AT)
  assert.equal(gone?.body, '')
})

test('borrado con cuerpo, cuerpo vacío sin borrar o respuesta rara: se descarta', () => {
  assert.equal(rowFromBroadcast({ ...teamRow, deleted_at: AT }, team), undefined)
  assert.equal(rowFromBroadcast({ ...teamRow, body: '', deleted_at: null }, team), undefined)
  assert.equal(rowFromBroadcast({ ...teamRow, reply_to: 'x' }, team), undefined)
  assert.equal(rowFromBroadcast({ ...teamRow, edited_at: 'ayer' }, team), undefined)
  assert.equal(rowFromBroadcast({ ...teamRow, deleted_at: 5, body: '' }, team), undefined)
})

test('payload viejo sin los campos nuevos sigue andando', () => {
  const r = rowFromBroadcast(teamRow, team)
  assert.equal(r?.body, 'hola')
  assert.equal(r?.edited_at, undefined)
})

test('reacción por broadcast', () => {
  const ok = { message_id: ID, user_id: AUTH, emoji: '❤️', op: 'add' }
  assert.deepEqual(reactionFromBroadcast(ok), { messageId: ID, userId: AUTH, emoji: '❤️', op: 'add' })
  assert.equal(reactionFromBroadcast({ ...ok, emoji: '💩' }), undefined)
  assert.equal(reactionFromBroadcast({ ...ok, emoji: '❤' }), undefined, 'sin el selector de variación')
  assert.equal(reactionFromBroadcast({ ...ok, op: 'toggle' }), undefined)
  assert.equal(reactionFromBroadcast({ ...ok, user_id: 'x' }), undefined)
  assert.equal(reactionFromBroadcast({ ...ok, extra: 1 }), undefined)
})

test('escribiendo y visto por broadcast', () => {
  assert.deepEqual(typingFromBroadcast({ user_id: AUTH }), { userId: AUTH })
  assert.equal(typingFromBroadcast({ user_id: 'x' }), undefined)
  assert.equal(typingFromBroadcast(null), undefined)
  assert.deepEqual(readFromBroadcast({ user_id: AUTH, at: AT }), { userId: AUTH, at: Date.parse(AT) })
  assert.equal(readFromBroadcast({ user_id: AUTH, at: 'ayer' }), undefined)
  assert.equal(readFromBroadcast({ user_id: AUTH }), undefined)
})

test('versionKey cambia al editar o borrar', () => {
  const base = versionKey(teamRow)
  assert.notEqual(versionKey({ ...teamRow, edited_at: AT }), base)
  assert.notEqual(versionKey({ ...teamRow, deleted_at: AT }), versionKey({ ...teamRow, edited_at: AT }))
  assert.equal(versionKey({ ...teamRow }), base)
})

test('Throttle: repite recién a los 3 s y por clave', () => {
  const th = new Throttle()
  assert.equal(th.ok('a', 1000), true)
  assert.equal(th.ok('a', 3999), false)
  assert.equal(th.ok('b', 3999), true)
  assert.equal(th.ok('a', 4000), true)
})
