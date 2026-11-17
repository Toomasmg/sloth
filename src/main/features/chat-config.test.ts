import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSupabaseUrl, parseChatServerConfig } from './chat-config'
import { parseInvitation } from './chat-invite'
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

test('una invitación o un team.json con otro host se rechazan', () => {
  const token = Buffer.from(JSON.stringify({ url: 'https://acme.supabase.co.evil.example', key: KEY, code: 'abcd-efgh-ijkl' })).toString('base64url')
  assert.throws(() => parseInvitation(`sloth-invitacion:v1.${token}`), /solo acepta proyectos de Supabase/)
  const team = (chat: object): string => JSON.stringify({ formato: 'sloth-team', versión: 1, equipo: 'X', chat })
  assert.throws(() => parseTeamConfig(team({ supabaseUrl: 'https://evil.example', anonKey: KEY })), /solo acepta proyectos de Supabase/)
  assert.throws(() => parseTeamConfig(team({ supabaseUrl: 'https://evil.example', anonKey: KEY, selfHosted: true })), /a mano/)
  assert.equal(parseTeamConfig(team({ supabaseUrl: REF, anonKey: KEY })).chat?.supabaseUrl, REF)
})
