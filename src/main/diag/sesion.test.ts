import { test } from 'node:test'
import assert from 'node:assert/strict'
import { huboCierreInesperado, leerSesion } from './sesion'

test('sin archivo no hay sesión ni falso positivo', () => {
  assert.equal(leerSesion(undefined), undefined)
  assert.equal(huboCierreInesperado(undefined), false)
})

test('JSON roto o de otra forma se descarta', () => {
  for (const raw of ['', '{', 'null', '[]', '3', '"x"', '{}', '{"inicio":1}', '{"limpia":true}']) {
    assert.equal(leerSesion(raw), undefined, raw)
  }
})

test('tipos erróneos se descartan', () => {
  assert.equal(leerSesion('{"inicio":"1","limpia":true}'), undefined)
  assert.equal(leerSesion('{"inicio":1,"limpia":"false"}'), undefined)
  assert.equal(leerSesion('{"inicio":null,"limpia":false}'), undefined)
  assert.equal(leerSesion('{"inicio":1e999,"limpia":false}'), undefined)
})

test('una sesión limpia no es un cierre inesperado y una sucia sí', () => {
  const limpia = leerSesion('{"inicio":1700000000000,"limpia":true}')
  const sucia = leerSesion('{"inicio":1700000000000,"limpia":false}')
  assert.deepEqual(limpia, { inicio: 1700000000000, limpia: true })
  assert.equal(huboCierreInesperado(limpia), false)
  assert.equal(huboCierreInesperado(sucia), true)
})
