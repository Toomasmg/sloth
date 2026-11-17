import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EVERY_MS, friendly, isPostponedOn, localDay, nextCheckDelay, notesText, parseChannel, parsePostponed } from './updater-core'

test('friendly traduce los errores de red', () => {
  for (const m of ['getaddrinfo ENOTFOUND github.com', 'connect ECONNREFUSED', 'net::ERR_FAILED', 'ETIMEDOUT']) {
    assert.equal(friendly(new Error(m)), 'No hay conexión con GitHub.')
  }
})

test('friendly traduce 404 y checksum dañado', () => {
  assert.equal(friendly(new Error('HttpError: 404 Not Found')), 'Todavía no hay versiones publicadas.')
  assert.equal(friendly(new Error('Cannot find latest.yml')), 'Todavía no hay versiones publicadas.')
  assert.match(friendly(new Error('sha512 checksum mismatch, expected x')), /dañada/)
})

test('friendly corta a la primera línea y a 200 caracteres', () => {
  assert.equal(friendly(new Error('uno\ndos')), 'uno')
  assert.equal(friendly(new Error('x'.repeat(500))).length, 200)
})

test('friendly tolera valores raros', () => {
  assert.equal(friendly(undefined), 'Error desconocido.')
  assert.equal(friendly(null), 'Error desconocido.')
  assert.equal(friendly(''), 'Error desconocido.')
  assert.equal(friendly('texto suelto'), 'texto suelto')
  assert.equal(friendly(new Error('')), 'Error desconocido.')
})

test('notesText acepta texto, lista y vacío', () => {
  assert.equal(notesText('hola'), 'hola')
  assert.equal(notesText([{ note: 'a' }, { note: null }, {}, { note: 'b' }]), 'a\n\nb')
  assert.equal(notesText(null), '')
  assert.equal(notesText(undefined), '')
  assert.equal(notesText([]), '')
})

test('parseChannel solo da beta con el valor exacto', () => {
  assert.equal(parseChannel({ updateChannel: 'beta' }), 'beta')
  for (const v of [{ updateChannel: 'Beta' }, { updateChannel: 1 }, {}, null, undefined, 'beta', []]) assert.equal(parseChannel(v), 'estable')
})

test('parsePostponed exige version y day como texto', () => {
  assert.deepEqual(parsePostponed({ version: '1.2.3', day: '2026-01-02', extra: 1 }), { version: '1.2.3', day: '2026-01-02' })
  for (const v of [null, undefined, 3, 'x', {}, { version: '1' }, { version: 1, day: 'a' }]) assert.equal(parsePostponed(v), null)
})

test('isPostponedOn pospone solo la misma versión el mismo día', () => {
  const p = { version: '1.0.0', day: '2026-05-01' }
  assert.equal(isPostponedOn(p, '1.0.0', '2026-05-01'), true)
  assert.equal(isPostponedOn(p, '1.0.1', '2026-05-01'), false)
  assert.equal(isPostponedOn(p, '1.0.0', '2026-05-02'), false)
  assert.equal(isPostponedOn(null, '1.0.0', '2026-05-01'), false)
})

test('localDay rellena mes y día con ceros', () => {
  assert.equal(localDay(new Date(2026, 0, 5, 23, 59)), '2026-01-05')
  assert.equal(localDay(new Date(2026, 11, 31, 0, 0)), '2026-12-31')
})

test('nextCheckDelay duplica el intervalo en modo liviano', () => {
  assert.equal(nextCheckDelay(false), EVERY_MS)
  assert.equal(nextCheckDelay(true), EVERY_MS * 2)
})
