import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyMention, containsText, escapeLike, esHostSupabase, hostNoSupabase, inviteConfirmation, mentionQueryAt, mentionsLogin, splitMentions } from './chat-text'

test('menciones: separa texto y logins', () => {
  assert.deepEqual(splitMentions('hola @Tomy, ¿venís?'), [
    { kind: 'text', text: 'hola ' },
    { kind: 'mention', login: 'Tomy' },
    { kind: 'text', text: ', ¿venís?' }
  ])
  assert.deepEqual(splitMentions('@ana'), [{ kind: 'mention', login: 'ana' }])
  assert.deepEqual(splitMentions(''), [])
})

test('un mail no es una mención', () => {
  assert.deepEqual(splitMentions('escribí a a@b.com'), [{ kind: 'text', text: 'escribí a a@b.com' }])
  assert.equal(mentionsLogin('mandalo a tomy@empresa.com', 'tomy'), false)
  assert.equal(mentionsLogin('@@tomy', 'tomy'), false)
  assert.equal(mentionsLogin('@-tomy', 'tomy'), false)
})

test('mención sin distinguir mayúsculas', () => {
  assert.equal(mentionsLogin('ey @TOMY mirá', 'tomy'), true)
  assert.equal(mentionsLogin('ey @tomyx mirá', 'tomy'), false)
  assert.equal(mentionsLogin('(@tomy)', 'Tomy'), true)
})

test('consulta de mención en el cursor', () => {
  assert.deepEqual(mentionQueryAt('hola @to', 8), { start: 5, query: 'to' })
  assert.deepEqual(mentionQueryAt('@', 1), { start: 0, query: '' })
  assert.equal(mentionQueryAt('hola @tomy', 8), undefined, 'cursor en medio de la palabra')
  assert.equal(mentionQueryAt('mail a@b', 8), undefined)
  assert.equal(mentionQueryAt('hola @to y', 10), undefined)
  assert.equal(mentionQueryAt('x', 5), undefined)
})

test('aplicar mención deja un espacio después', () => {
  assert.deepEqual(applyMention('hola @to', 5, 8, 'tomy'), { text: 'hola @tomy ', caret: 11 })
  assert.deepEqual(applyMention('@to mirá', 0, 3, 'tomy'), { text: '@tomy mirá', caret: 6 })
})

test('escapar comodines de LIKE', () => {
  assert.equal(escapeLike('50%_\\'), '50\\%\\_\\\\')
  assert.equal(escapeLike('hola'), 'hola')
  assert.equal(escapeLike('a*b'), 'a_b')
  assert.equal(containsText('Hola A*B chau', 'a*b'), true)
  assert.equal(containsText('axb', 'a*b'), false)
})

test('esHostSupabase: solo <ref>.supabase.co, no un host parecido', () => {
  assert.equal(esHostSupabase('abcdefghijklmnopqrst.supabase.co'), true)
  assert.equal(esHostSupabase('ABCDEFGHIJ.SUPABASE.CO'), true)
  for (const h of ['acme.supabase.co.evil.example', 'supabase.co', 'evil-supabase.co', 'a.b.supabase.co', 'abcdefghij.supabase.co:8443', 'chat.miempresa.com', ''])
    assert.equal(esHostSupabase(h), false, h)
})

test('con un servidor propio, confirmar una invitación exige el host completo que se mostró', () => {
  assert.equal(inviteConfirmation('confirmNew', 'abcdefghijklmnopqrst.supabase.co'), 'confirmNew')
  assert.equal(inviteConfirmation('confirmNew', 'chat.miempresa.com'), 'confirmNew@chat.miempresa.com')
  assert.equal(inviteConfirmation('confirmReplace', 'acme.supabase.co.evil.example'), 'confirmReplace@acme.supabase.co.evil.example')
})

test('hostNoSupabase: el host completo de un servidor propio, nada si es de Supabase', () => {
  assert.equal(hostNoSupabase('https://abcdefghijklmnopqrst.supabase.co'), undefined)
  assert.equal(hostNoSupabase('https://chat.miempresa.com:8443'), 'chat.miempresa.com:8443')
  assert.equal(hostNoSupabase('no es url'), undefined)
})
