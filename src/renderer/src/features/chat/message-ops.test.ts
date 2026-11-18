import test from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage, ChatReactionEvent } from '../../../../shared/chat'
import { applyReaction, clearBefore, composerKey, lastEditable, matchParts, mergeUpdate, proximoVencimiento, seenUpTo, snippet, startsGroup, typingText } from './message-ops'

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

test('mergeUpdate no deja que una versión vieja pise a una nueva', () => {
  const gone = msg({ body: '', deletedAt: 300 })
  assert.equal(mergeUpdate(gone, msg({ body: 'editado', editedAt: 200 })), gone, 'no se des-borra')
  const v2 = msg({ body: 'v2', editedAt: 250 })
  assert.equal(mergeUpdate(v2, msg({ body: 'v1', editedAt: 200 })), v2)
  assert.equal(mergeUpdate(v2, msg({ body: 'original' })), v2)
  assert.equal(mergeUpdate(v2, msg({ body: 'v3', editedAt: 300 })).body, 'v3')
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

test('startsGroup agrupa al mismo autor seguido y corta por autor, tiempo, cita y borrado', () => {
  const a = msg({ id: 'a', createdAt: 1_000_000 })
  assert.equal(startsGroup(undefined, a), true)
  assert.equal(startsGroup(a, msg({ id: 'b', createdAt: 1_000_000 + 60_000 })), false)
  assert.equal(startsGroup(a, msg({ id: 'b', createdAt: 1_000_000 + 6 * 60_000 })), true)
  assert.equal(startsGroup(a, msg({ id: 'b', author: { id: 'otro', login: 'o' }, createdAt: 1_000_001 })), true)
  assert.equal(startsGroup(a, msg({ id: 'b', createdAt: 1_000_001, replyTo: { id: 'x', authorLogin: 'q', excerpt: '', deleted: false } })), true)
  assert.equal(startsGroup(a, msg({ id: 'b', createdAt: 1_000_001, deletedAt: 5 })), true)
})

test('typingText según cuántos escriben', () => {
  assert.equal(typingText([]), '')
  assert.equal(typingText(['ana']), 'ana está escribiendo…')
  assert.equal(typingText(['ana', 'beto']), 'ana y beto están escribiendo…')
  assert.equal(typingText(['a', 'b', 'c']), 'Varios están escribiendo…')
})

test('matchParts marca las coincidencias sin tocar el resto ni interpretar HTML', () => {
  assert.deepEqual(matchParts('Hola <b>hola</b>', 'HOLA'), [
    { text: 'Hola', hit: true },
    { text: ' <b>', hit: false },
    { text: 'hola', hit: true },
    { text: '</b>', hit: false }
  ])
  assert.deepEqual(matchParts('abc', ' '), [{ text: 'abc', hit: false }])
})

test('snippet corta alrededor de la coincidencia', () => {
  const long = `${'x'.repeat(200)} aguja ${'y'.repeat(200)}`
  const out = snippet(long, 'aguja', 60)
  assert.ok(out.includes('aguja') && out.startsWith('…') && out.endsWith('…'))
  assert.equal(snippet('corto', 'co'), 'corto')
})

test('vaciar: quedan el aviso, lo posterior y los envíos que no salieron', () => {
  const clear = msg({ id: 'c', createdAt: 200, notice: { kind: 'clear' } })
  const list = [
    msg({ id: 'a', createdAt: 100 }),
    msg({ id: 'b', createdAt: 200 }),
    msg({ id: 'local:x', createdAt: 150, status: 'sending' }),
    msg({ id: 'local:y', createdAt: 120, status: 'failed' }),
    clear,
    msg({ id: 'd', createdAt: 300 })
  ]
  assert.deepEqual(clearBefore(list, clear).map((m) => m.id), ['local:x', 'local:y', 'c', 'd'])
  assert.deepEqual(clearBefore([], clear), [])
})

test('avisos: no se editan, no llevan «Visto» y no agrupan al siguiente', () => {
  const notice = msg({ id: 'n', createdAt: 150, notice: { kind: 'retention', hours: 24 } })
  assert.equal(lastEditable([msg(), notice], 'me')?.id, 'm1')
  assert.equal(seenUpTo([msg(), notice], 'me', 500), 'm1')
  assert.equal(startsGroup(notice, msg({ id: 'm2', createdAt: 160 })), true)
})

const HORA = 3_600_000

test('próximo vencimiento: sin retención o sin mensajes no hay nada que agendar', () => {
  assert.equal(proximoVencimiento([msg()], undefined, 1000), undefined)
  assert.equal(proximoVencimiento([], 24, 1000), undefined)
})

test('próximo vencimiento: el del mensaje no vencido más viejo', () => {
  const list = [msg({ id: 'a', createdAt: 5 * HORA }), msg({ id: 'b', createdAt: 2 * HORA }), msg({ id: 'c', createdAt: 9 * HORA })]
  assert.equal(proximoVencimiento(list, 24, 10 * HORA), 2 * HORA + 24 * HORA)
})

test('próximo vencimiento: saltea los que ya vencieron y es exacto en el borde', () => {
  const list = [msg({ id: 'a', createdAt: 0 }), msg({ id: 'b', createdAt: 4 * HORA })]
  assert.equal(proximoVencimiento(list, 24, 24 * HORA), 28 * HORA)
  assert.equal(proximoVencimiento(list, 24, 24 * HORA - 1), 24 * HORA)
  assert.equal(proximoVencimiento([msg({ createdAt: 0 })], 24, 24 * HORA), undefined)
})
