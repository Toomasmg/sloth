import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  messageFromRow,
  otherReadAt,
  parseEmoji,
  parseOptionalUuid,
  parseSearch,
  reactionsByMessage,
  replyRefFrom,
  teamFromRow
} from './chat-map'

const T = '11111111-1111-4111-8111-111111111111'
const ID = '33333333-3333-4333-8333-333333333333'
const A = '55555555-5555-4555-8555-555555555555'
const B = '66666666-6666-4666-8666-666666666666'
const AT = '2026-11-12T10:05:00+00:00'
const row = { id: ID, client_id: ID, team_id: T, author_id: A, body: 'hola', created_at: AT }
const author = { id: A, login: 'ana' }

test('mensaje editado y borrado', () => {
  const e = messageFromRow({ ...row, edited_at: AT }, author)
  assert.equal(e?.editedAt, Date.parse(AT))
  assert.equal(e?.deletedAt, undefined)
  const d = messageFromRow({ ...row, body: 'quedó', deleted_at: AT }, author)
  assert.equal(d?.deletedAt, Date.parse(AT))
  assert.equal(d?.body, '')
  assert.equal('editedAt' in (messageFromRow(row, author) ?? {}), false)
})

test('mensaje vía Claude: solo con via = claude', () => {
  assert.equal(messageFromRow({ ...row, via: 'claude' }, author)?.via, 'claude')
  assert.equal('via' in (messageFromRow({ ...row, via: 'otro' }, author) ?? {}), false)
  assert.equal('via' in (messageFromRow(row, author) ?? {}), false)
})

test('avisos de la conversación y borrado automático del equipo', () => {
  assert.deepEqual(messageFromRow({ ...row, body: 'clear', kind: 'clear' }, author)?.notice, { kind: 'clear' })
  assert.deepEqual(messageFromRow({ ...row, body: '720', kind: 'retention' }, author)?.notice, { kind: 'retention', hours: 720 })
  assert.equal('notice' in (messageFromRow({ ...row, kind: 'text' }, author) ?? {}), false)
  const info = { role: 'member' as const, memberCount: 2, unread: 0 }
  assert.equal(teamFromRow({ id: T, name: 'Equipo', retention_hours: 168 }, info)?.retentionHours, 168)
  assert.equal('retentionHours' in (teamFromRow({ id: T, name: 'Equipo', retention_hours: null }, info) ?? {}), false)
  assert.equal('retentionHours' in (teamFromRow({ id: T, name: 'Equipo', retention_hours: 5 }, info) ?? {}), false)
})

test('validación de reacción, búsqueda e id opcional', () => {
  assert.equal(parseEmoji('👍'), '👍')
  assert.throws(() => parseEmoji('💩'), /Reacción inválida/)
  assert.throws(() => parseEmoji(1), /Reacción inválida/)
  assert.equal(parseSearch('  hola '), 'hola')
  assert.throws(() => parseSearch(' a '), /al menos 2/)
  assert.throws(() => parseSearch('x'.repeat(101)), /más de 100/)
  assert.throws(() => parseSearch(null), /al menos 2/)
  assert.equal(parseOptionalUuid(undefined), undefined)
  assert.equal(parseOptionalUuid(null), undefined)
  assert.equal(parseOptionalUuid(ID.toUpperCase()), ID)
  assert.throws(() => parseOptionalUuid('x'))
})

test('referencia de respuesta: una línea y recortada; vacía si se borró', () => {
  assert.deepEqual(replyRefFrom({ id: ID, author_id: A, body: 'hola\n  che' }, 'ana'), {
    id: ID, authorLogin: 'ana', excerpt: 'hola che', deleted: false
  })
  assert.equal(replyRefFrom({ id: ID, author_id: A, body: 'x'.repeat(200) }, 'ana')?.excerpt.length, 141)
  assert.deepEqual(replyRefFrom({ id: ID, author_id: A, body: '', deleted_at: AT }, 'ana'), {
    id: ID, authorLogin: 'ana', excerpt: '', deleted: true
  })
  assert.equal(replyRefFrom({ id: null, author_id: A, body: 'x' }, 'ana'), undefined)
})

test('reacciones agrupadas por mensaje en el orden de la lista', () => {
  const m = reactionsByMessage(
    [
      { message_id: ID, user_id: A, emoji: '👀' },
      { message_id: ID, user_id: B, emoji: '👍' },
      { message_id: ID, user_id: A, emoji: '👍' },
      { message_id: ID, user_id: A, emoji: '👍' },
      { message_id: ID, user_id: A, emoji: '💩' },
      { message_id: null, user_id: A, emoji: '👍' }
    ],
    (id) => (id === A ? 'ana' : 'beto')
  )
  assert.deepEqual(m.get(ID), [
    { emoji: '👍', userIds: [B, A], logins: ['beto', 'ana'] },
    { emoji: '👀', userIds: [A], logins: ['ana'] }
  ])
  assert.equal(m.size, 1)
})

test('lectura del otro en un DM', () => {
  const t = { id: ID, user_a: A, user_b: B, last_read_a: AT, last_read_b: '2026-11-12T11:00:00+00:00' }
  assert.equal(otherReadAt(t, A), Date.parse('2026-11-12T11:00:00+00:00'))
  assert.equal(otherReadAt(t, B), Date.parse(AT))
  assert.equal(otherReadAt(t, T), undefined)
  assert.equal(otherReadAt({ id: ID, user_a: A, user_b: B }, A), undefined)
})
