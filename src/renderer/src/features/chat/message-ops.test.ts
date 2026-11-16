import test from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage, ChatReactionEvent } from '../../../../shared/chat'
import { applyReaction, composerKey, lastEditable, mergeUpdate, seenUpTo } from './message-ops'

const conv = { kind: 'dm', id: 'c1' } as const
const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1',
  clientId: 'k1',
  conv,
  author: { id: 'me', login: 'yo' },
  body: 'hola',
  createdAt: 100,
  status: 'sent',
  ...over
})
const ev = (over: Partial<ChatReactionEvent> = {}): ChatReactionEvent => ({
  conv,
  messageId: 'm1',
  emoji: '👍',
  userId: 'u1',
  login: 'ana',
  op: 'add',
  ...over
})

test('una reacción repetida no duplica', () => {
  const once = applyReaction(msg(), ev())
  const twice = applyReaction(once, ev())
  assert.deepEqual(twice.reactions, [{ emoji: '👍', userIds: ['u1'], logins: ['ana'] }])
})

test('sacar al último usuario borra el emoji', () => {
  const m = applyReaction(applyReaction(msg(), ev()), ev({ op: 'remove' }))
  assert.deepEqual(m.reactions, [])
})

test('sacar una reacción que no estaba no cambia nada', () => {
  assert.deepEqual(applyReaction(msg(), ev({ op: 'remove' })).reactions, [])
})

test('las reacciones salen en el orden de CHAT_REACTIONS', () => {
  const m = applyReaction(applyReaction(msg(), ev({ emoji: '👀' })), ev({ emoji: '❤️', userId: 'u2', login: 'beto' }))
  assert.deepEqual(
    m.reactions?.map((r) => r.emoji),
    ['❤️', '👀']
  )
})

test('mergeUpdate de una edición conserva reacciones y cita', () => {
  const prev = msg({
    reactions: [{ emoji: '🎉', userIds: ['u1'], logins: ['ana'] }],
    replyTo: { id: 'x', authorLogin: 'b', excerpt: 'q', deleted: false }
  })
  const out = mergeUpdate(prev, msg({ body: 'chau', editedAt: 200 }))
  assert.equal(out.body, 'chau')
  assert.equal(out.reactions?.length, 1)
  assert.equal(out.replyTo?.id, 'x')
})

test('mergeUpdate de un borrado limpia las reacciones', () => {
  const prev = msg({ reactions: [{ emoji: '🎉', userIds: ['u1'], logins: ['ana'] }] })
  assert.deepEqual(mergeUpdate(prev, msg({ body: '', deletedAt: 300 })).reactions, [])
})

test('lastEditable saltea fallidos, borrados y ajenos', () => {
  const list = [
    msg({ id: 'a' }),
    msg({ id: 'b', createdAt: 101 }),
    msg({ id: 'c', status: 'failed', createdAt: 102 }),
    msg({ id: 'd', deletedAt: 5, createdAt: 103 }),
    msg({ id: 'e', author: { id: 'otro', login: 'o' }, createdAt: 104 })
  ]
  assert.equal(lastEditable(list, 'me')?.id, 'b')
  assert.equal(lastEditable([], 'me'), undefined)
})

test('seenUpTo marca el último propio leído y sin otherReadAt no hay nada', () => {
  const list = [msg({ id: 'a', createdAt: 10 }), msg({ id: 'b', createdAt: 20 }), msg({ id: 'c', createdAt: 30 })]
  assert.equal(seenUpTo(list, 'me', 25), 'b')
  assert.equal(seenUpTo(list, 'me', 5), undefined)
  assert.equal(seenUpTo(list, 'me', undefined), undefined)
})

const mods = { shift: false, composing: false }
const reply = { kind: 'reply', to: { id: 'x', authorLogin: 'b', excerpt: '', deleted: false } } as const

test('Enter envía y Shift+Enter no', () => {
  assert.equal(composerKey('Enter', mods, 'hola', { kind: 'new' }), 'send')
  assert.equal(composerKey('Enter', { ...mods, shift: true }, 'hola', { kind: 'new' }), null)
})

test('con composición IME no hace nada', () => {
  assert.equal(composerKey('Enter', { ...mods, composing: true }, 'hola', { kind: 'new' }), null)
})

test('flecha arriba edita solo con texto vacío y en modo nuevo', () => {
  assert.equal(composerKey('ArrowUp', mods, '', { kind: 'new' }), 'editLast')
  assert.equal(composerKey('ArrowUp', mods, 'a', { kind: 'new' }), null)
  assert.equal(composerKey('ArrowUp', mods, '', reply), null)
})

test('Esc cancela el modo y en modo nuevo no hace nada', () => {
  assert.equal(composerKey('Escape', mods, '', reply), 'cancel')
  assert.equal(composerKey('Escape', mods, '', { kind: 'edit', id: 'm', original: 'x' }), 'cancel')
  assert.equal(composerKey('Escape', mods, '', { kind: 'new' }), null)
})
