import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keyHash } from './chat-config'
import { buildInvitation, decideInvite, INVITE_PREFIX, looksLikeInvitation, MAX_INVITE_TEXT, parseInvitation } from './chat-invite'

const URL_OK = 'https://abcd.supabase.co'
const KEY = 'sb_publishable_abcdefgh12345'
const CODE = '0123456789abcdef'
const cfg = { supabaseUrl: URL_OK, anonKey: KEY }

const tokenOf = (obj: unknown): string => `${INVITE_PREFIX}${Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')}`
const jwt = (payload: object): string =>
  ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'firma'].join('.')

test('ida y vuelta con y sin nombre de equipo', () => {
  const t = buildInvitation(cfg, CODE, 'Equipo Ñandú')
  assert.ok(t.startsWith(INVITE_PREFIX))
  assert.deepEqual(parseInvitation(t), { cfg, code: CODE, teamName: 'Equipo Ñandú' })
  assert.deepEqual(parseInvitation(buildInvitation(cfg, CODE)), { cfg, code: CODE })
})

test('acepta el token con texto alrededor, como llega por un chat', () => {
  const t = buildInvitation(cfg, CODE)
  assert.equal(parseInvitation(`Sumate al chat:\n  ${t}  \n¡Nos vemos!`).code, CODE)
})

test('un nombre de equipo raro no entra en la invitación', () => {
  assert.equal(parseInvitation(buildInvitation(cfg, CODE, 'a‮b')).teamName, undefined)
  assert.equal(parseInvitation(buildInvitation(cfg, CODE, 'x'.repeat(61))).teamName, undefined)
})

test('rechaza la secret key y la service_role con su mensaje', () => {
  for (const key of ['sb_secret_abcdefgh12345', jwt({ role: 'service_role' })]) {
    assert.throws(() => parseInvitation(tokenOf({ url: URL_OK, key, code: CODE })), /service_role \/ secret key/)
    assert.throws(() => buildInvitation({ supabaseUrl: URL_OK, anonKey: key }, CODE), /service_role/)
  }
})

test('acepta una anon key JWT', () => {
  const key = jwt({ role: 'anon' })
  assert.equal(parseInvitation(tokenOf({ url: URL_OK, key, code: CODE })).cfg.anonKey, key)
})

test('rechaza URL http, con ruta o con usuario', () => {
  for (const url of ['http://abcd.supabase.co', 'https://abcd.supabase.co/rest', 'https://u:p@abcd.supabase.co', 'javascript:alert(1)'])
    assert.throws(() => parseInvitation(tokenOf({ url, key: KEY, code: CODE })), /La invitación no es válida/)
})

test('rechaza claves desconocidas, faltantes o con tipo equivocado', () => {
  assert.throws(() => parseInvitation(tokenOf({ url: URL_OK, key: KEY, code: CODE, cmd: 'rm -rf' })), /no conoce/)
  assert.throws(() => parseInvitation(tokenOf({ url: URL_OK, key: KEY })), /código/)
  assert.throws(() => parseInvitation(tokenOf({ url: URL_OK, key: KEY, code: 'ABC' })), /código/)
  assert.throws(() => parseInvitation(tokenOf({ url: URL_OK, key: KEY, code: CODE, team: 5 })), /nombre del equipo/)
  assert.throws(() => parseInvitation(tokenOf([URL_OK, KEY, CODE])), /dañada/)
})

test('rechaza JSON roto, base64 inválido y texto que no es invitación', () => {
  assert.throws(() => parseInvitation(`${INVITE_PREFIX}${Buffer.from('{"url":').toString('base64url')}`), /dañada/)
  assert.throws(() => parseInvitation(`${INVITE_PREFIX}`), /incompleta/)
  assert.throws(() => parseInvitation('hola'), /no es una invitación/)
  assert.throws(() => parseInvitation(''), /Pegá/)
  assert.throws(() => parseInvitation(42), /Pegá/)
  const t = buildInvitation(cfg, CODE)
  assert.throws(() => parseInvitation(`${t} ${t}`), /más de una/)
})

test('rechaza tamaños grandes', () => {
  assert.throws(() => parseInvitation('x'.repeat(MAX_INVITE_TEXT + 1)), /demasiado largo/)
  assert.throws(() => parseInvitation(`${INVITE_PREFIX}${'A'.repeat(5000)}`), /demasiado larga/)
  assert.equal(looksLikeInvitation('x'.repeat(MAX_INVITE_TEXT + 1) + INVITE_PREFIX), false)
  assert.equal(looksLikeInvitation(`hola ${INVITE_PREFIX}abc`), true)
  assert.equal(looksLikeInvitation(null), false)
})

test('decisión: sin config, misma config, config distinta, con sesión', () => {
  const inv = parseInvitation(buildInvitation(cfg, CODE))
  const same = { supabaseUrl: URL_OK, keyHash: keyHash(KEY) }
  assert.equal(decideInvite(inv, { signedIn: false }), 'confirmNew')
  assert.equal(decideInvite(inv, { active: same, signedIn: false }), 'signIn')
  assert.equal(decideInvite(inv, { active: same, signedIn: true }), 'redeem')
  assert.equal(decideInvite(inv, { active: { supabaseUrl: 'https://otro.supabase.co', keyHash: same.keyHash }, signedIn: true }), 'confirmReplace')
  assert.equal(decideInvite(inv, { active: { supabaseUrl: URL_OK, keyHash: keyHash('sb_publishable_otraotra99') }, signedIn: true }), 'confirmReplace')
})
