import test from 'node:test'
import assert from 'node:assert/strict'
import { payloadDeEvento, payloadDeRazon } from './payload'

test('Error: mensaje y stack', () => {
  const e = new Error('roto')
  assert.deepEqual(payloadDeRazon(e), { mensaje: 'roto', stack: e.stack })
})

test('string: queda como mensaje', () => {
  assert.deepEqual(payloadDeRazon('algo'), { mensaje: 'algo' })
})

test('objeto raro: String', () => {
  assert.deepEqual(payloadDeRazon({}), { mensaje: '[object Object]' })
  assert.deepEqual(payloadDeRazon(42), { mensaje: '42' })
})

test('objeto sin toString usable no lanza', () => {
  assert.deepEqual(payloadDeRazon(Object.create(null)), { mensaje: '(sin detalle)' })
})

test('undefined y null: sin detalle', () => {
  assert.deepEqual(payloadDeRazon(undefined), { mensaje: '(sin detalle)' })
  assert.deepEqual(payloadDeRazon(null), { mensaje: '(sin detalle)' })
})

test('evento sin Error usa el mensaje del evento', () => {
  assert.deepEqual(payloadDeEvento('Script error.', null), { mensaje: 'Script error.' })
  assert.deepEqual(payloadDeEvento('', undefined), { mensaje: '(sin detalle)' })
})

test('evento con Error trae el stack', () => {
  const e = new Error('x')
  assert.equal(payloadDeEvento('ignorado', e).stack, e.stack)
})
