import { test } from 'node:test'
import assert from 'node:assert/strict'
import { avatarValido, parsearUsuarioGh, urlAvatarConTamano } from './perfiles-github'

const ok = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ login: 'octo-cat', name: 'Octo Cat', avatar_url: 'https://avatars.githubusercontent.com/u/583231?v=4', ...extra })

test('una respuesta válida de gh se acepta completa', () => {
  assert.deepEqual(parsearUsuarioGh(ok()), { login: 'octo-cat', nombre: 'Octo Cat', avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4' })
})

test('sin nombre o con nombre inservible se ignora solo el nombre', () => {
  assert.equal(parsearUsuarioGh(ok({ name: null }))?.nombre, undefined)
  assert.equal(parsearUsuarioGh(ok({ name: 'x'.repeat(41) }))?.nombre, undefined)
  assert.equal(parsearUsuarioGh(ok({ name: 'Ana\u0007 Pérez' }))?.nombre, undefined)
  assert.equal(parsearUsuarioGh(ok({ name: 42 }))?.nombre, undefined)
  assert.equal(parsearUsuarioGh(ok({ name: 'Ana\u202ePérez' }))?.nombre, undefined)
  assert.equal(parsearUsuarioGh(ok({ name: 'x'.repeat(41) }))?.login, 'octo-cat')
})

test('rechaza JSON roto, que no sea objeto y logins inválidos', () => {
  assert.equal(parsearUsuarioGh('{roto'), null)
  assert.equal(parsearUsuarioGh(''), null)
  assert.equal(parsearUsuarioGh('[]'), null)
  assert.equal(parsearUsuarioGh('null'), null)
  assert.equal(parsearUsuarioGh(ok({ login: 'con espacio' })), null)
  assert.equal(parsearUsuarioGh(ok({ login: '' })), null)
  assert.equal(parsearUsuarioGh(ok({ login: 'a'.repeat(40) })), null)
  assert.equal(parsearUsuarioGh(ok({ login: '../etc' })), null)
  assert.equal(parsearUsuarioGh(ok({ login: 7 })), null)
})

test('el avatar solo puede ser https://avatars.githubusercontent.com sin credenciales ni puerto', () => {
  for (const url of [
    'http://avatars.githubusercontent.com/u/1',
    'https://evil.example/u/1',
    'https://avatars.githubusercontent.com.evil.example/u/1',
    'https://evil.example/avatars.githubusercontent.com/u/1',
    'https://user:pass@avatars.githubusercontent.com/u/1',
    'https://avatars.githubusercontent.com:8443/u/1',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'file:///C:/Windows/win.ini',
    '//avatars.githubusercontent.com/u/1',
    'no es una url',
    `https://avatars.githubusercontent.com/${'a'.repeat(400)}`
  ]) {
    assert.equal(avatarValido(url), null, url)
    assert.equal(parsearUsuarioGh(ok({ avatar_url: url })), null, url)
  }
  assert.equal(parsearUsuarioGh(ok({ avatar_url: 5 })), null)
  assert.equal(parsearUsuarioGh(JSON.stringify({ login: 'a', name: 'b' })), null)
})

test('urlAvatarConTamano suma s sin duplicarlo', () => {
  assert.equal(urlAvatarConTamano('https://avatars.githubusercontent.com/u/1?v=4', 128), 'https://avatars.githubusercontent.com/u/1?v=4&s=128')
  assert.equal(urlAvatarConTamano('https://avatars.githubusercontent.com/u/1', 128), 'https://avatars.githubusercontent.com/u/1?s=128')
  assert.equal(urlAvatarConTamano('https://avatars.githubusercontent.com/u/1?s=999', 128), 'https://avatars.githubusercontent.com/u/1?s=128')
})

test('una salida enorme de gh se descarta sin parsearla', () => {
  assert.equal(parsearUsuarioGh(ok({ relleno: 'x'.repeat(20000) })), null)
})
