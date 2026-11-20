import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createHash, createHmac, randomBytes, webcrypto } from 'node:crypto'
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
    hmacPartes(k: Uint8Array, partes: Uint8Array[]): Uint8Array
    aesBloque(k: Uint8Array, b: Uint8Array): Uint8Array
    ctr(k: Uint8Array, iv: Uint8Array, d: Uint8Array): Uint8Array
    aBase64url(b: Uint8Array): string
    deBase64url(t: string): Uint8Array | null
    aUtf8(t: string): Uint8Array
    deUtf8(b: Uint8Array): string
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

test('abrirRespuesta acepta una respuesta de ~100 sesiones (más de 8192 caracteres)', () => {
  const claves = derivarClaves(Buffer.alloc(32, 3).toString('base64url'))
  const w = web.abrirClave(Buffer.alloc(32, 3).toString('base64url'))
  assert.ok(claves && w)
  const iv = randomBytes(16)
  const json = JSON.stringify({ sesiones: Array.from({ length: 100 }, (_, i) => ({ id: 's' + i, detalle: 'é'.repeat(200) })) })
  const sobre = sellarRespuesta(claves, iv, json)
  assert.ok(sobre.length > 8192)
  assert.equal(web.abrirRespuesta(w, new Uint8Array(iv), sobre), json)
})

function semilla(inicial: number): () => number {
  let a = inicial >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function bytesAleatorios(rnd: () => number, n: number): Buffer {
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = Math.floor(rnd() * 256)
  return b
}

const PIEZAS = ['a', 'Z', ' ', '\n', 'ñ', 'é', '€', '😀', '𝒳', '\u001b[31m', '\u001b[0m', '"', '/']

function textoAleatorio(rnd: () => number, bytes: number): string {
  let t = ''
  let usados = 0
  for (;;) {
    const p = PIEZAS[Math.floor(rnd() * PIEZAS.length)]
    const largo = Buffer.byteLength(p)
    if (usados + largo > bytes) break
    t += p
    usados += largo
  }
  return t + 'a'.repeat(bytes - usados)
}

const TAMANOS = [0, 1, 15, 16, 17, 1000, 20000, 120000]

test('AES-256-CTR: vector F.5.5 de NIST SP 800-38A', () => {
  const clave = deHex('603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4')
  const iv = deHex('f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff')
  const claro = deHex(
    '6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710'
  )
  assert.equal(
    hex(web._t.ctr(clave, iv, claro)),
    '601ec313775789a5b7a7f504bbf3d228f443e3ca4d62b59aca84e990cacaf5c52b0930daa23de94ce87017ba2d84988ddfc9c58db67aada613c2dd08457941a6'
  )
})

test('HMAC-SHA256: casos 3 y 4 de RFC 4231', () => {
  assert.equal(
    hex(web._t.hmac(deHex('aa'.repeat(20)), deHex('dd'.repeat(50)))),
    '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe'
  )
  assert.equal(
    hex(web._t.hmac(deHex('0102030405060708090a0b0c0d0e0f10111213141516171819'), deHex('cd'.repeat(50)))),
    '82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b'
  )
})

test('HMAC coincide con node:crypto con claves y mensajes de muchos largos y cortes', () => {
  const rnd = semilla(7)
  for (const kl of [0, 1, 32, 63, 64, 65, 131]) {
    for (const ml of [0, 1, 55, 56, 63, 64, 65, 127, 128, 129, 1000, 5000]) {
      const k = bytesAleatorios(rnd, kl)
      const m = bytesAleatorios(rnd, ml)
      const esperado = createHmac('sha256', k).update(m).digest('hex')
      assert.equal(hex(web._t.hmac(new Uint8Array(k), new Uint8Array(m))), esperado, `${kl}/${ml}`)
      const corte1 = Math.floor(rnd() * (ml + 1))
      const corte2 = corte1 + Math.floor(rnd() * (ml - corte1 + 1))
      const partes = [m.subarray(0, corte1), m.subarray(corte1, corte2), m.subarray(corte2)].map((p) => new Uint8Array(p))
      assert.equal(hex(web._t.hmacPartes(new Uint8Array(k), partes)), esperado, `partes ${kl}/${ml}`)
    }
  }
})

test('AES-256-CTR coincide con node:crypto: claves, ivs y largos aleatorios, bloque parcial y acarreo del contador', () => {
  const rnd = semilla(11)
  const ivs: Buffer[] = [
    Buffer.alloc(16),
    Buffer.alloc(16, 0xff),
    Buffer.concat([randomBytes(12), Buffer.alloc(4, 0xff)]),
    Buffer.concat([randomBytes(8), Buffer.alloc(8, 0xff)]),
    Buffer.concat([randomBytes(12), Buffer.from('fffffffe', 'hex')]),
    Buffer.concat([randomBytes(4), Buffer.alloc(12, 0xff)]),
    Buffer.concat([randomBytes(8), Buffer.from('00000000ffffffff', 'hex')])
  ]
  for (let i = 0; i < 40; i++) ivs.push(bytesAleatorios(rnd, 16))
  for (const iv of ivs) {
    const clave = bytesAleatorios(rnd, 32)
    for (const n of [0, 1, 15, 16, 17, 31, 33, 47, 100, 1000 + Math.floor(rnd() * 500)]) {
      const datos = bytesAleatorios(rnd, n)
      const cifra = createCipheriv('aes-256-ctr', clave, iv)
      const esperado = Buffer.concat([cifra.update(datos), cifra.final()])
      const obtenido = web._t.ctr(new Uint8Array(clave), new Uint8Array(iv), new Uint8Array(datos))
      assert.equal(hex(obtenido), esperado.toString('hex'), `${iv.toString('hex')}/${n}`)
    }
  }
})

test('AES-256 de un bloque coincide con node:crypto en 50 claves y bloques aleatorios', () => {
  const rnd = semilla(13)
  for (let i = 0; i < 50; i++) {
    const clave = bytesAleatorios(rnd, 32)
    const bloque = bytesAleatorios(rnd, 16)
    const cifra = createCipheriv('aes-256-ecb', clave, null)
    cifra.setAutoPadding(false)
    const esperado = Buffer.concat([cifra.update(bloque), cifra.final()])
    assert.equal(hex(web._t.aesBloque(new Uint8Array(clave), new Uint8Array(bloque))), esperado.toString('hex'))
  }
})

test('sellarPedido: 50 sobres aleatorios iguales bit a bit a los que arma node:crypto', () => {
  const rnd = semilla(17)
  for (let i = 0; i < 50; i++) {
    const clave = bytesAleatorios(rnd, 32).toString('base64url')
    const cw = web.abrirClave(clave)
    const cn = derivarClaves(clave)
    assert.ok(cw && cn)
    const ruta = '/api/' + 'r'.repeat(Math.floor(rnd() * 20))
    const n = TAMANOS[i % TAMANOS.length]
    const cuerpo = textoAleatorio(rnd, n)
    const { sobre, iv } = web.sellarPedido(cw, ruta, { texto: cuerpo })
    const bytes = Buffer.from(sobre, 'base64url')
    assert.equal(bytes.toString('base64url'), sobre)
    assert.equal(hex(bytes.subarray(0, 16)), hex(iv))
    const ct = bytes.subarray(16, bytes.length - 32)
    const claro = createCipheriv('aes-256-ctr', cn.enc, Buffer.from(iv)).update(ct).toString('utf8')
    const dato = JSON.parse(claro) as { t: number; b: { texto: string } }
    assert.equal(dato.b.texto, cuerpo)
    assert.equal(claro, JSON.stringify({ t: dato.t, b: { texto: cuerpo } }))
    assert.equal(ct.length, Buffer.byteLength(claro))
    const tag = createHmac('sha256', cn.mac).update('q' + ruta + '\0').update(iv).update(ct).digest()
    assert.equal(hex(bytes.subarray(bytes.length - 32)), tag.toString('hex'))
    if (sobre.length <= 8192) {
      const abierto = abrirPedido(cn, ruta, sobre)
      assert.ok(abierto, String(n))
      assert.equal(abierto.json, claro)
    }
  }
})

test('abrirRespuesta: 50 sobres de Node de largos, claves e ivs aleatorios se abren idénticos', () => {
  const rnd = semilla(19)
  for (let i = 0; i < 50; i++) {
    const clave = bytesAleatorios(rnd, 32).toString('base64url')
    const cw = web.abrirClave(clave)
    const cn = derivarClaves(clave)
    assert.ok(cw && cn)
    const ivPedido = bytesAleatorios(rnd, 16)
    const iv = i % 5 === 0 ? Buffer.concat([bytesAleatorios(rnd, 12), Buffer.alloc(4, 0xff)]) : bytesAleatorios(rnd, 16)
    const cuerpo = textoAleatorio(rnd, TAMANOS[i % TAMANOS.length])
    const sobre = sellarRespuesta(cn, ivPedido, cuerpo, iv)
    assert.equal(web.abrirRespuesta(cw, new Uint8Array(ivPedido), sobre), cuerpo, String(i))
  }
})

test('abrirRespuesta rechaza un bit cambiado en cualquier byte del sobre y los sobres demasiado largos', () => {
  const clave = randomBytes(32).toString('base64url')
  const cw = web.abrirClave(clave)
  const cn = derivarClaves(clave)
  assert.ok(cw && cn)
  const ivPedido = randomBytes(16)
  const ivWeb = new Uint8Array(ivPedido)
  const sobre = sellarRespuesta(cn, ivPedido, textoAleatorio(semilla(5), 40))
  const bytes = Buffer.from(sobre, 'base64url')
  for (let i = 0; i < bytes.length; i++) {
    for (const bit of [0, 7]) {
      const malo = Buffer.from(bytes)
      malo[i] ^= 1 << bit
      assert.equal(web.abrirRespuesta(cw, ivWeb, malo.toString('base64url')), null, `${i}/${bit}`)
    }
  }
  const largo = sellarRespuesta(cn, ivPedido, 'a'.repeat(200000))
  assert.ok(largo.length > 262144)
  assert.equal(web.abrirRespuesta(cw, ivWeb, largo), null)
  assert.equal(web.abrirRespuesta(cw, ivWeb, sellarRespuesta(cn, ivPedido, 'a'.repeat(150000))), 'a'.repeat(150000))
})

test('base64url de la web: ida y vuelta igual que Buffer y rechazo de todo lo no canónico', () => {
  const rnd = semilla(23)
  for (let n = 0; n < 70; n++) {
    const b = bytesAleatorios(rnd, n)
    const t = b.toString('base64url')
    assert.equal(web._t.aBase64url(new Uint8Array(b)), t, String(n))
    const d = web._t.deBase64url(t)
    assert.ok(d, String(n))
    assert.equal(hex(d), b.toString('hex'))
  }
  for (const malo of ['AB', 'AAB', 'A', 'AAAAA', 'AAAA=', 'AA==', 'AA+/', 'AAé', 'AAAé', 'AAAAĀ', 'AAAA AAAA']) {
    assert.equal(web._t.deBase64url(malo), null, malo)
  }
  assert.equal(web._t.deBase64url(7 as unknown as string), null)
  assert.equal(web._t.deBase64url('')?.length, 0)
})

function deUtf8Anterior(b: Uint8Array): string {
  let r = ''
  let i = 0
  while (i < b.length) {
    let c = b[i++]
    let extra = 0
    let min = 0
    if (c < 0x80) {
      r += String.fromCharCode(c)
      continue
    }
    if (c >= 0xc2 && c < 0xe0) {
      extra = 1
      c &= 0x1f
      min = 0x80
    } else if (c >= 0xe0 && c < 0xf0) {
      extra = 2
      c &= 0x0f
      min = 0x800
    } else if (c >= 0xf0 && c < 0xf5) {
      extra = 3
      c &= 0x07
      min = 0x10000
    } else {
      r += String.fromCharCode(0xfffd)
      continue
    }
    let ok = i + extra <= b.length
    for (let k = 0; ok && k < extra; k++) {
      if ((b[i + k] & 0xc0) !== 0x80) ok = false
      else c = (c << 6) | (b[i + k] & 63)
    }
    if (!ok || c < min || c > 0x10ffff || (c >= 0xd800 && c < 0xe000)) {
      r += String.fromCharCode(0xfffd)
      continue
    }
    i += extra
    if (c >= 0x10000) {
      c -= 0x10000
      r += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff))
    } else r += String.fromCharCode(c)
  }
  return r
}

test('UTF-8 de la web: aUtf8 como Buffer y deUtf8 como la lógica anterior, también con bytes inválidos', () => {
  const rnd = semilla(29)
  for (const t of ['', 'abc', 'ñandú €', '😀 𝒳', 'a\ud800b', '\udc00', 'x\ud83d', '😀\ud83d']) {
    assert.equal(hex(web._t.aUtf8(t)), Buffer.from(t, 'utf8').toString('hex'), t)
  }
  for (let i = 0; i < 30; i++) {
    const t = textoAleatorio(rnd, Math.floor(rnd() * 3000))
    assert.equal(hex(web._t.aUtf8(t)), Buffer.from(t, 'utf8').toString('hex'))
    assert.equal(web._t.deUtf8(new Uint8Array(Buffer.from(t, 'utf8'))), t)
  }
  assert.equal(web._t.deUtf8(new Uint8Array(Buffer.from('é'.repeat(20000), 'utf8'))), 'é'.repeat(20000))
  for (let i = 0; i < 300; i++) {
    const crudo = bytesAleatorios(rnd, Math.floor(rnd() * 40))
    const b = new Uint8Array(crudo.map((x) => (rnd() < 0.5 ? x : 0x80 + (x & 0x7f))))
    assert.equal(web._t.deUtf8(b), deUtf8Anterior(b), hex(b))
  }
})

test('las claves de la web se reusan con la expansión cacheada y dan lo mismo', () => {
  const clave = randomBytes(32).toString('base64url')
  const cw = web.abrirClave(clave)
  const cn = derivarClaves(clave)
  assert.ok(cw && cn)
  const rnd = semilla(31)
  for (let i = 0; i < 20; i++) {
    const iv = randomBytes(16)
    const cuerpo = textoAleatorio(rnd, i * 37)
    assert.equal(web.abrirRespuesta(cw, new Uint8Array(iv), sellarRespuesta(cn, iv, cuerpo)), cuerpo)
  }
})
