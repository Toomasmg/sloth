import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keyHash, normalizeSupabaseUrl, parseChatServerConfig, parseSavedChatConfig } from './chat-config'
import { buildInvitation, decideInvite, inviteConfirmation, parseInvitation } from './chat-invite'
import { parseTeamConfig } from './team-config-core'

const KEY = 'sb_publishable_abcdefgh12345'
const REF = 'https://abcdefghijklmnopqrst.supabase.co'

test('acepta solo https://<ref>.supabase.co', () => {
  assert.equal(normalizeSupabaseUrl(`${REF}/`), REF)
  assert.equal(normalizeSupabaseUrl('https://ABCDEFGHIJKLMNOPQRST.supabase.co'), REF)
  for (const u of ['https://acme.supabase.co.evil.example', 'https://evil.example', 'https://supabase.co', 'https://a.b.supabase.co', 'https://acme.supabase.com', `${REF}:8443`, 'https://acme-supabase.co', 'https://xsupabase.co']) {
    assert.throws(() => normalizeSupabaseUrl(u), /solo acepta proyectos de Supabase/, u)
  }
})

test('el mensaje de rechazo muestra el host completo', () => {
  assert.throws(() => normalizeSupabaseUrl('https://acme.supabase.co.evil.example'), /«acme\.supabase\.co\.evil\.example»/)
})

test('servidor propio: solo con la marca y solo desde Configuración', () => {
  const own = parseChatServerConfig({ supabaseUrl: 'https://chat.acme.com', anonKey: KEY, selfHosted: true })
  assert.deepEqual(own, { supabaseUrl: 'https://chat.acme.com', anonKey: KEY, selfHosted: true })
  assert.throws(() => parseChatServerConfig({ supabaseUrl: 'https://chat.acme.com', anonKey: KEY }), /Servidor propio/)
  assert.throws(() => parseChatServerConfig({ supabaseUrl: 'https://chat.acme.com', anonKey: KEY, selfHosted: true }, { allowSelfHosted: false }), /a mano/)
  assert.throws(() => parseChatServerConfig({ supabaseUrl: REF, anonKey: KEY, selfHosted: 'si' }), /true o false/)
  assert.equal(parseChatServerConfig({ supabaseUrl: REF, anonKey: KEY }).selfHosted, undefined)
})

test('una invitación a otro host entra como servidor propio y se confirma con el host completo', () => {
  const token = Buffer.from(JSON.stringify({ url: 'https://acme.supabase.co.evil.example', key: KEY, code: '0123456789abcdef' })).toString('base64url')
  const inv = parseInvitation(`sloth-invitacion:v1.${token}`)
  assert.equal(inv.cfg.selfHosted, true)
  assert.equal(decideInvite(inv, { signedIn: false }), 'confirmNew')
  assert.equal(inviteConfirmation('confirmNew', inv), 'confirmNew@acme.supabase.co.evil.example')
  const supa = parseInvitation(buildInvitation({ supabaseUrl: REF, anonKey: KEY }, '0123456789abcdef'))
  assert.equal(supa.cfg.selfHosted, undefined)
  assert.equal(inviteConfirmation('confirmNew', supa), 'confirmNew')
})

test('el owner de un servidor propio puede armar la invitación y vuelve igual', () => {
  const own = { supabaseUrl: 'https://chat.acme.com', anonKey: KEY, selfHosted: true as const }
  const inv = parseInvitation(buildInvitation(own, '0123456789abcdef', 'Acme'))
  assert.deepEqual(inv.cfg, own)
  assert.equal(decideInvite(inv, { active: { supabaseUrl: own.supabaseUrl, keyHash: keyHash(KEY) }, signedIn: true }), 'redeem')
  assert.throws(() => buildInvitation({ supabaseUrl: 'https://chat.acme.com', anonKey: KEY }, '0123456789abcdef'), /Servidor propio/)
})

test('una config guardada de servidor propio sin la marca se migra, no se descarta', () => {
  const r = parseSavedChatConfig({ supabaseUrl: 'https://chat.acme.com', anonKey: KEY })
  assert.equal(r.migrated, true)
  assert.deepEqual(r.cfg, { supabaseUrl: 'https://chat.acme.com', anonKey: KEY, selfHosted: true })
  assert.equal(parseSavedChatConfig({ supabaseUrl: REF, anonKey: KEY }).migrated, false)
  assert.throws(() => parseSavedChatConfig({ supabaseUrl: 'http://chat.acme.com', anonKey: KEY }))
  assert.throws(() => parseSavedChatConfig({ supabaseUrl: 'https://chat.acme.com', anonKey: 'sb_secret_x' }))
})

test('un team.json con otro host pierde solo el chat', () => {
  const team = (chat: object): string => JSON.stringify({ formato: 'sloth-team', versión: 1, equipo: 'X', chat })
  const otro = parseTeamConfig(team({ supabaseUrl: 'https://evil.example', anonKey: KEY }))
  assert.equal(otro.chat, undefined)
  assert.match(otro.avisos?.[0] ?? '', /solo acepta proyectos de Supabase/)
  assert.match(parseTeamConfig(team({ supabaseUrl: 'https://evil.example', anonKey: KEY, selfHosted: true })).avisos?.[0] ?? '', /a mano/)
  assert.equal(parseTeamConfig(team({ supabaseUrl: REF, anonKey: KEY })).chat?.supabaseUrl, REF)
})
