import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes, webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { SELLO_JS } from './celular-sello-web'
import { abrirPedido, derivarClaves, sellarRespuesta } from './celular-sello'

interface ClavesWeb {
  enc: Uint8Array
  mac: Uint8Array
}

interface SelloWeb {
  abrirClave(clave: string): ClavesWeb | null
  sellarPedido(c: ClavesWeb, ruta: string, objeto: unknown): { sobre: string; iv: Uint8Array }
  abrirRespuesta(c: ClavesWeb, iv: Uint8Array, sobre: string): string | null
  _t: {
    sha256(d: Uint8Array): Uint8Array
    hmac(k: Uint8Array, d: Uint8Array): Uint8Array
    aesBloque(k: Uint8Array, b: Uint8Array): Uint8Array
  }
}

function cargar(): SelloWeb {
  const ventana: { slothSello?: SelloWeb } = {}
  runInNewContext(SELLO_JS, { window: ventana, crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) } })
  assert.ok(ventana.slothSello)
  return ventana.slothSello
}

const web = cargar()
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')
const deHex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'))
const utf8 = (t: string): Uint8Array => new Uint8Array(Buffer.from(t, 'utf8'))

test('el código del celu no usa lo que rompería el template literal ni sintaxis moderna', () => {
  assert.ok(!SELLO_JS.includes('\\'))
  assert.ok(!/\b(let|const)\b/.test(SELLO_JS))
  assert.ok(!SELLO_JS.includes('=>'))
  assert.ok(!SELLO_JS.includes('subtle'))
})

test('SHA-256: vectores conocidos', () => {
  assert.equal(hex(web._t.sha256(utf8('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(hex(web._t.sha256(utf8(''))), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(
    hex(web._t.sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
  )
})

test('SHA-256 coincide con node:crypto en todos los largos de borde', () => {
  for (const n of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000]) {
    const d = randomBytes(n)
    assert.equal(hex(web._t.sha256(new Uint8Array(d))), createHash('sha256').update(d).digest('hex'), String(n))
  }
})

test('HMAC-SHA256: casos 1, 2 y 6 de RFC 4231', () => {
  assert.equal(
    hex(web._t.hmac(deHex('0b'.repeat(20)), utf8('Hi There'))),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'
  )
  assert.equal(
    hex(web._t.hmac(utf8('Jefe'), utf8('what do ya want for nothing?'))),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'
  )
  assert.equal(
    hex(web._t.hmac(deHex('aa'.repeat(131)), utf8('Test Using Larger Than Block-Size Key - Hash Key First'))),
    '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54'
  )
})

test('AES-256: bloque de FIPS-197 C.3', () => {
  const clave = deHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')
  const bloque = deHex('00112233445566778899aabbccddeeff')
  assert.equal(hex(web._t.aesBloque(clave, bloque)), '8ea2b7ca516745bfeafc49904b496089')
})

test('abrirClave deriva igual que Node y rechaza claves malas', () => {
  const clave = randomBytes(32).toString('base64url')
  const n = derivarClaves(clave)
  const w = web.abrirClave(clave)
  assert.ok(n && w)
  assert.equal(hex(w.enc), n.enc.toString('hex'))
  assert.equal(hex(w.mac), n.mac.toString('hex'))
  assert.equal(web.abrirClave('corta'), null)
  assert.equal(web.abrirClave(clave + 'A'), null)
  assert.equal(web.abrirClave(clave.slice(0, -1)), null)
  assert.equal(web.abrirClave(clave.slice(0, -1) + '+'), null)
})

const LARGOS = [0, 1, 15, 16, 17, 100, 5000]

function texto(bytes: number): string {
  const base = 'añ€😀x'
  let t = ''
  while (Buffer.byteLength(t) < bytes) t += base
  while (Buffer.byteLength(t) > bytes) t = t.slice(0, -1)
  return Buffer.byteLength(t) === bytes ? t : 'a'.repeat(bytes)
}

test('lo que sella la web lo abre Node, con la ruta y el instante', () => {
  const clave = randomBytes(32).toString('base64url')
  const cw = web.abrirClave(clave)
  const cn = derivarClaves(clave)
  assert.ok(cw && cn)
  for (const n of LARGOS) {
    const cuerpo = texto(n)
    const antes = Date.now()
    const { sobre, iv } = web.sellarPedido(cw, '/api/enviar', { texto: cuerpo, emoji: '😀' })
    const abierto = abrirPedido(cn, '/api/enviar', sobre)
    assert.ok(abierto, String(n))
    assert.deepEqual(abierto.iv, Buffer.from(iv))
    const dato = JSON.parse(abierto.json) as { t: number; b: { texto: string; emoji: string } }
    assert.equal(dato.b.texto, cuerpo)
    assert.equal(dato.b.emoji, '😀')
    assert.ok(dato.t >= antes && dato.t <= Date.now())
    assert.equal(abrirPedido(cn, '/api/otra', sobre), null)
  }
})

test('lo que sella Node lo abre la web', () => {
  const clave = randomBytes(32).toString('base64url')
  const cw = web.abrirClave(clave)
  const cn = derivarClaves(clave)
  assert.ok(cw && cn)
  for (const n of LARGOS) {
    const ivPedido = randomBytes(16)
    const cuerpo = texto(n)
    const sobre = sellarRespuesta(cn, ivPedido, cuerpo)
    assert.equal(web.abrirRespuesta(cw, new Uint8Array(ivPedido), sobre), cuerpo, String(n))
    assert.equal(web.abrirRespuesta(cw, new Uint8Array(randomBytes(16)), sobre), null)
  }
})

test('el contador CTR de la web acarrea como OpenSSL', () => {
  const clave = randomBytes(32).toString('base64url')
  const cw = web.abrirClave(clave)
  const cn = derivarClaves(clave)
  assert.ok(cw && cn)
  const ivPedido = randomBytes(16)
  const iv = Buffer.alloc(16, 0xff)
  iv[0] = 0x12
  const cuerpo = 'z'.repeat(70)
  assert.equal(web.abrirRespuesta(cw, new Uint8Array(ivPedido), sellarRespuesta(cn, ivPedido, cuerpo, iv)), cuerpo)
})

test('la web rechaza una respuesta alterada, truncada o fuera de formato', () => {
  const clave = randomBytes(32).toString('base64url')
  const cw = web.abrirClave(clave)
  const cn = derivarClaves(clave)
  assert.ok(cw && cn)
  const ivPedido = randomBytes(16)
  const sobre = sellarRespuesta(cn, ivPedido, '{"ok":true}')
  const bytes = Buffer.from(sobre, 'base64url')
  const iv = new Uint8Array(ivPedido)
  assert.equal(web.abrirRespuesta(cw, iv, sobre), '{"ok":true}')
  for (const i of [0, 16, bytes.length - 1]) {
    const malo = Buffer.from(bytes)
    malo[i] ^= 1
    assert.equal(web.abrirRespuesta(cw, iv, malo.toString('base64url')), null, String(i))
  }
  assert.equal(web.abrirRespuesta(cw, iv, bytes.subarray(0, bytes.length - 1).toString('base64url')), null)
  assert.equal(web.abrirRespuesta(cw, iv, bytes.subarray(0, 47).toString('base64url')), null)
  assert.equal(web.abrirRespuesta(cw, iv, ''), null)
  assert.equal(web.abrirRespuesta(cw, iv, sobre + '='), null)
  assert.equal(web.abrirRespuesta(cw, iv, 'x'.repeat(9000)), null)
  assert.equal(web.abrirRespuesta(cw, iv, 12 as unknown as string), null)
  const otra = web.abrirClave(randomBytes(32).toString('base64url'))
  assert.ok(otra)
  assert.equal(web.abrirRespuesta(otra, iv, sobre), null)
})

test('el MAC de la web coincide con el de node:crypto', () => {
  const k = randomBytes(40)
  const d = randomBytes(300)
  assert.equal(hex(web._t.hmac(new Uint8Array(k), new Uint8Array(d))), createHmac('sha256', k).update(d).digest('hex'))
})
