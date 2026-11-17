import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createHmac, randomBytes } from 'node:crypto'
import {
  MAX_SOBRE_BYTES,
  VENTANA_MS,
  abrirPedido,
  abrirRespuesta,
  crearRepetidos,
  derivarClaves,
  fechaValida,
  sellarPedido,
  sellarRespuesta
} from './celular-sello'
import type { Claves } from './celular-sello'

const CLAVE = randomBytes(32).toString('base64url')

function claves(clave = CLAVE): Claves {
  const c = derivarClaves(clave)
  assert.ok(c)
  return c
}

function cambiarBit(sobre: string, byte: number): string {
  const b = Buffer.from(sobre, 'base64url')
  b[byte] ^= 1
  return b.toString('base64url')
}

test('derivarClaves sigue el esquema HMAC con las etiquetas del plan', () => {
  const bytes = Buffer.from(CLAVE, 'base64url')
  const c = claves()
  assert.deepEqual(c.enc, createHmac('sha256', bytes).update('sloth-wifi enc').digest())
  assert.deepEqual(c.mac, createHmac('sha256', bytes).update('sloth-wifi mac').digest())
})

test('derivarClaves rechaza claves que no son 32 bytes en base64url', () => {
  assert.equal(derivarClaves('corta'), null)
  assert.equal(derivarClaves(''), null)
  assert.equal(derivarClaves(randomBytes(31).toString('base64url')), null)
  assert.equal(derivarClaves(randomBytes(33).toString('base64url')), null)
  assert.equal(derivarClaves(CLAVE + '='), null)
  assert.equal(derivarClaves(CLAVE.replace(/.$/, '+')), null)
  assert.equal(derivarClaves(7 as unknown as string), null)
})

test('el pedido sellado coincide con una construcción independiente con node:crypto', () => {
  const c = claves()
  const iv = randomBytes(16)
  const json = '{"t":1,"b":"á"}'
  const sobre = sellarPedido(c, '/api/x', json, iv)
  const ct = Buffer.concat([createCipheriv('aes-256-ctr', c.enc, iv).update(json, 'utf8')])
  const tag = createHmac('sha256', c.mac).update(Buffer.from('q/api/x\0')).update(iv).update(ct).digest()
  assert.equal(sobre, Buffer.concat([iv, ct, tag]).toString('base64url'))
})

test('pedido: ida y vuelta devuelve el json y el iv', () => {
  const c = claves()
  const iv = randomBytes(16)
  const abierto = abrirPedido(c, '/api/estado', sellarPedido(c, '/api/estado', '{"a":"ñ😀"}', iv))
  assert.ok(abierto)
  assert.equal(abierto.json, '{"a":"ñ😀"}')
  assert.deepEqual(abierto.iv, iv)
})

test('pedido: dos sellados del mismo texto usan iv distintos', () => {
  const c = claves()
  assert.notEqual(sellarPedido(c, '/r', 'x'), sellarPedido(c, '/r', 'x'))
})

test('pedido: ruta distinta, clave equivocada o sobre inválido dan null', () => {
  const c = claves()
  const sobre = sellarPedido(c, '/a', '{}')
  assert.equal(abrirPedido(c, '/b', sobre), null)
  assert.equal(abrirPedido(claves(randomBytes(32).toString('base64url')), '/a', sobre), null)
  assert.equal(abrirPedido(c, '/a', 5 as unknown as string), null)
  assert.equal(abrirPedido(c, '/a', ''), null)
  assert.equal(abrirPedido(c, '/a', '!!!!'), null)
  assert.equal(abrirPedido(c, '/a', sobre + '='), null)
})

test('pedido: un bit cambiado en el iv, el texto cifrado o el tag da null', () => {
  const c = claves()
  const sobre = sellarPedido(c, '/a', '{"x":1}')
  const largo = Buffer.from(sobre, 'base64url').length
  assert.ok(abrirPedido(c, '/a', sobre))
  assert.equal(abrirPedido(c, '/a', cambiarBit(sobre, 3)), null)
  assert.equal(abrirPedido(c, '/a', cambiarBit(sobre, 17)), null)
  assert.equal(abrirPedido(c, '/a', cambiarBit(sobre, largo - 1)), null)
})

test('pedido: truncado o recortado da null', () => {
  const c = claves()
  const sobre = sellarPedido(c, '/a', '{"x":1}')
  const bytes = Buffer.from(sobre, 'base64url')
  assert.equal(abrirPedido(c, '/a', bytes.subarray(0, bytes.length - 1).toString('base64url')), null)
  assert.equal(abrirPedido(c, '/a', bytes.subarray(0, 47).toString('base64url')), null)
  assert.equal(abrirPedido(c, '/a', bytes.subarray(0, 16).toString('base64url')), null)
  assert.equal(abrirPedido(c, '/a', sobre.slice(0, -2)), null)
})

test('pedido: el texto vacío se sella y se abre', () => {
  const c = claves()
  const sobre = sellarPedido(c, '/a', '')
  assert.equal(Buffer.from(sobre, 'base64url').length, 48)
  assert.equal(abrirPedido(c, '/a', sobre)?.json, '')
})

test('un sobre de más de MAX_SOBRE_BYTES da null aunque esté bien sellado', () => {
  const c = claves()
  const sobre = sellarPedido(c, '/a', 'x'.repeat(MAX_SOBRE_BYTES))
  assert.ok(sobre.length > MAX_SOBRE_BYTES)
  assert.equal(abrirPedido(c, '/a', sobre), null)
  const justo = sellarPedido(c, '/a', 'x'.repeat(5000))
  assert.ok(justo.length <= MAX_SOBRE_BYTES)
  assert.ok(abrirPedido(c, '/a', justo))
})

test('respuesta: ida y vuelta atada al iv del pedido', () => {
  const c = claves()
  const ivPedido = randomBytes(16)
  const sobre = sellarRespuesta(c, ivPedido, '{"ok":true,"n":"ü"}')
  assert.equal(abrirRespuesta(c, ivPedido, sobre), '{"ok":true,"n":"ü"}')
})

test('respuesta: otro ivPedido, clave equivocada o bit cambiado dan null', () => {
  const c = claves()
  const ivPedido = randomBytes(16)
  const sobre = sellarRespuesta(c, ivPedido, '{"ok":true}')
  assert.equal(abrirRespuesta(c, randomBytes(16), sobre), null)
  assert.equal(abrirRespuesta(claves(randomBytes(32).toString('base64url')), ivPedido, sobre), null)
  const largo = Buffer.from(sobre, 'base64url').length
  for (const i of [0, 16, largo - 1]) assert.equal(abrirRespuesta(c, ivPedido, cambiarBit(sobre, i)), null)
  assert.equal(abrirRespuesta(c, ivPedido, 'x'.repeat(MAX_SOBRE_BYTES + 1)), null)
})

test('un pedido no se acepta como respuesta ni al revés', () => {
  const c = claves()
  const iv = randomBytes(16)
  assert.equal(abrirRespuesta(c, iv, sellarPedido(c, '/a', '{}', iv)), null)
  assert.equal(abrirPedido(c, '', sellarRespuesta(c, iv, '{}')), null)
})

test('sellar rechaza un iv que no mide 16 bytes', () => {
  assert.throws(() => sellarPedido(claves(), '/a', '{}', randomBytes(12)))
})

test('crearRepetidos: la primera vez es false, la segunda true', () => {
  const r = crearRepetidos()
  const iv = randomBytes(16)
  assert.equal(r.vistoAntes(iv, 1000), false)
  assert.equal(r.vistoAntes(iv, 1001), true)
  assert.equal(r.vistoAntes(randomBytes(16), 1002), false)
})

test('crearRepetidos: pasado el ttl el iv vuelve a valer', () => {
  const r = crearRepetidos(1000)
  const iv = randomBytes(16)
  assert.equal(r.vistoAntes(iv, 0), false)
  assert.equal(r.vistoAntes(iv, 1000), true)
  assert.equal(r.vistoAntes(iv, 1001), false)
})

test('crearRepetidos: al llegar al tope se descarta el más viejo', () => {
  const r = crearRepetidos(60_000, 3)
  const [a, b, c, d] = [1, 2, 3, 4].map(() => randomBytes(16))
  r.vistoAntes(a, 1)
  r.vistoAntes(b, 2)
  r.vistoAntes(c, 3)
  r.vistoAntes(d, 4)
  assert.equal(r.vistoAntes(b, 5), true)
  assert.equal(r.vistoAntes(c, 5), true)
  assert.equal(r.vistoAntes(d, 5), true)
  assert.equal(r.vistoAntes(a, 5), false)
})

test('fechaValida acepta hasta la ventana y rechaza lo que no es un número finito', () => {
  const ahora = 1_700_000_000_000
  assert.equal(VENTANA_MS, 300_000)
  assert.equal(fechaValida(ahora, ahora), true)
  assert.equal(fechaValida(ahora - VENTANA_MS, ahora), true)
  assert.equal(fechaValida(ahora + VENTANA_MS, ahora), true)
  assert.equal(fechaValida(ahora - VENTANA_MS - 1, ahora), false)
  assert.equal(fechaValida(ahora + VENTANA_MS + 1, ahora), false)
  for (const malo of [NaN, Infinity, -Infinity, '1700000000000', null, undefined, {}]) {
    assert.equal(fechaValida(malo, ahora), false)
  }
})
