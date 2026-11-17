import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dimValida, idValido, origenConfiable, permisoChromium } from './ipc-guard'

test('origenConfiable: app://ui con cualquier path', () => {
  assert.equal(origenConfiable('app://ui/index.html', undefined), true)
  assert.equal(origenConfiable('app://ui/', undefined), true)
  assert.equal(origenConfiable('app://otro/index.html', undefined), false)
})

test('origenConfiable: lo de afuera, vacío o roto no', () => {
  assert.equal(origenConfiable('https://evil', undefined), false)
  assert.equal(origenConfiable('https://app.ui/', undefined), false)
  assert.equal(origenConfiable('file:///C:/x.html', undefined), false)
  assert.equal(origenConfiable(undefined, undefined), false)
  assert.equal(origenConfiable('', undefined), false)
  assert.equal(origenConfiable('no es url', 'no es url'), false)
})

test('origenConfiable: el origin de dev vale solo si se pasa devUrl', () => {
  assert.equal(origenConfiable('http://localhost:5173/', undefined), false)
  assert.equal(origenConfiable('http://localhost:5173/x', 'http://localhost:5173/'), true)
  assert.equal(origenConfiable('http://localhost:5174/', 'http://localhost:5173/'), false)
  assert.equal(origenConfiable('https://evil/', 'http://localhost:5173/'), false)
})

test('permisoChromium: micrófono solo de audio y portapapeles de escritura', () => {
  assert.equal(permisoChromium('media', true, ['audio']), true)
  assert.equal(permisoChromium('media', true, ['audio', 'video']), false)
  assert.equal(permisoChromium('media', true, ['video']), false)
  assert.equal(permisoChromium('media', true, []), false)
  assert.equal(permisoChromium('media', true, undefined), false)
  assert.equal(permisoChromium('clipboard-sanitized-write', true, undefined), true)
  assert.equal(permisoChromium('geolocation', true, undefined), false)
  assert.equal(permisoChromium('notifications', true, undefined), false)
})

test('permisoChromium: con el origen mal no se permite nada', () => {
  assert.equal(permisoChromium('media', false, ['audio']), false)
  assert.equal(permisoChromium('clipboard-sanitized-write', false, undefined), false)
})

test('idValido y dimValida', () => {
  assert.equal(idValido('abc'), true)
  assert.equal(idValido(''), false)
  assert.equal(idValido('a'.repeat(201)), false)
  assert.equal(idValido(5), false)
  assert.equal(dimValida(80), true)
  assert.equal(dimValida(1), true)
  assert.equal(dimValida(2000), true)
  assert.equal(dimValida(0), false)
  assert.equal(dimValida(2001), false)
  assert.equal(dimValida(80.5), false)
  assert.equal(dimValida('80'), false)
})
