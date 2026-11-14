import test from 'node:test'
import assert from 'node:assert/strict'
import { chatButtonLabel, firstWords, planIncoming, planSent, RecentIds, toastText, type ChatAlertSettings } from './alerts'
import { chatChimeSpec } from '../sound/logic'

const on: ChatAlertSettings = { sounds: true, noMolestar: false, notify: { team: true, soundIn: true, soundOut: true } }
const base = { mine: false, alreadySeen: false, windowFocused: true, viewing: false, settings: on }

test('ajeno con foco y sin mirar: suena y avisa en la app', () => {
  assert.deepEqual(planIncoming(base), { sound: 'receive', toast: true })
})

test('ajeno mirando esa conversación: suena, sin toast', () => {
  assert.deepEqual(planIncoming({ ...base, viewing: true }), { sound: 'receive', toast: false })
})

test('sin foco: suena, el aviso lo da el sistema (sin toast)', () => {
  assert.deepEqual(planIncoming({ ...base, windowFocused: false }), { sound: 'receive', toast: false })
})

test('propio y repetido no hacen nada al recibir', () => {
  assert.deepEqual(planIncoming({ ...base, mine: true }), { sound: null, toast: false })
  assert.deepEqual(planIncoming({ ...base, alreadySeen: true }), { sound: null, toast: false })
})

test('No molestar silencia sonido y toast', () => {
  assert.deepEqual(planIncoming({ ...base, settings: { ...on, noMolestar: true } }), { sound: null, toast: false })
  assert.equal(planSent({ ...on, noMolestar: true }, false).sound, null)
})

test('ajustes apagados: cada uno es independiente', () => {
  assert.deepEqual(planIncoming({ ...base, settings: { ...on, notify: { ...on.notify, team: false } } }), { sound: 'receive', toast: false })
  assert.deepEqual(planIncoming({ ...base, settings: { ...on, notify: { ...on.notify, soundIn: false } } }), { sound: null, toast: true })
  assert.deepEqual(planIncoming({ ...base, settings: { ...on, sounds: false } }), { sound: null, toast: true })
})

test('enviar: suena una vez y respeta su ajuste', () => {
  assert.equal(planSent(on, false).sound, 'send')
  assert.equal(planSent(on, true).sound, null)
  assert.equal(planSent({ ...on, notify: { ...on.notify, soundOut: false } }, false).sound, null)
  assert.equal(planSent({ ...on, sounds: false }, false).sound, null)
})

test('RecentIds deduplica y olvida lo más viejo', () => {
  const r = new RecentIds(2)
  assert.equal(r.seen('a'), false)
  assert.equal(r.seen('a'), true)
  r.seen('b')
  r.seen('c')
  assert.equal(r.seen('a'), false)
})

test('texto del toast', () => {
  assert.equal(toastText('ana', 'Núcleo', 'hola\n  equipo'), 'ana · Núcleo: hola equipo')
  assert.equal(toastText('ana', undefined, 'hola'), 'ana: hola')
  const largo = firstWords('palabra '.repeat(30))
  assert.ok(largo.endsWith('…') && largo.length <= 81)
})

test('etiqueta del botón y tope 99+', () => {
  assert.equal(chatButtonLabel(0), 'Chat del equipo')
  assert.equal(chatButtonLabel(1), 'Chat, 1 mensaje sin leer')
  assert.equal(chatButtonLabel(3), 'Chat, 3 mensajes sin leer')
  assert.equal(chatButtonLabel(150), 'Chat, 150 mensajes sin leer')
})

test('el sonido de enviar es más corto y suave que el de recibir', () => {
  for (const n of ['Gota', 'Campana suave', 'Clic'] as const) {
    const r = chatChimeSpec(n, 'receive')
    const s = chatChimeSpec(n, 'send')
    assert.ok(s.total < r.total || s.total <= 0.12)
    assert.ok(s.peak < r.peak)
    assert.equal(s.notes.length, 1)
  }
})
