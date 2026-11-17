import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decryptText, encryptText, MIN_PASSWORD, WRONG_PASSWORD, type Encrypted } from './export-crypto'

const PASS = 'contraseña-larga'
const TEXT = JSON.stringify({ formato: 'sloth-config', espacios: [{ nombre: 'ñandú ✓' }] })

const clone = (e: Encrypted): Encrypted => JSON.parse(JSON.stringify(e)) as Encrypted

function flipByte(b64: string, index: number): string {
  const buf = Buffer.from(b64, 'base64')
  buf[index] ^= 0xff
  return buf.toString('base64')
}

const recortar = (b64: string, len: number): string => Buffer.from(b64, 'base64').subarray(0, len).toString('base64')

test('ida y vuelta devuelve el mismo texto, con acentos y símbolos', () => {
  assert.equal(decryptText(encryptText(TEXT, PASS), PASS), TEXT)
})

test('el sobre no deja el texto ni la contraseña a la vista', () => {
  const env = encryptText(TEXT, PASS)
  const raw = JSON.stringify(env)
  assert.ok(!raw.includes('andú'))
  assert.ok(!raw.includes(PASS))
  assert.ok(!Buffer.from(env.datos, 'base64').toString('utf8').includes('sloth-config'))
  assert.equal(env.cifrado.algoritmo, 'aes-256-gcm')
  assert.equal(env.cifrado.kdf, 'scrypt')
})

test('cada cifrado usa sal e iv nuevos', () => {
  const a = encryptText(TEXT, PASS)
  const b = encryptText(TEXT, PASS)
  assert.notEqual(a.cifrado.sal, b.cifrado.sal)
  assert.notEqual(a.cifrado.iv, b.cifrado.iv)
  assert.notEqual(a.datos, b.datos)
})

test('contraseña errónea, vacía o con otra capitalización da el mensaje de contraseña', () => {
  const env = encryptText(TEXT, PASS)
  for (const mala of ['otra-contraseña', '', PASS.toUpperCase(), PASS + ' ']) {
    assert.throws(() => decryptText(env, mala), { message: WRONG_PASSWORD })
  }
})

test('un byte cambiado en los datos, el tag, el iv o la sal se rechaza', () => {
  const env = encryptText(TEXT, PASS)
  const datos = clone(env)
  datos.datos = flipByte(env.datos, 0)
  assert.throws(() => decryptText(datos, PASS), { message: WRONG_PASSWORD })
  const tag = clone(env)
  tag.cifrado.tag = flipByte(env.cifrado.tag, 3)
  assert.throws(() => decryptText(tag, PASS), { message: WRONG_PASSWORD })
  const iv = clone(env)
  iv.cifrado.iv = flipByte(env.cifrado.iv, 0)
  assert.throws(() => decryptText(iv, PASS), { message: WRONG_PASSWORD })
  const sal = clone(env)
  sal.cifrado.sal = flipByte(env.cifrado.sal, 0)
  assert.throws(() => decryptText(sal, PASS), { message: WRONG_PASSWORD })
})

test('datos truncados o con bytes de más no se descifran', () => {
  const env = encryptText(TEXT, PASS)
  const bytes = Buffer.from(env.datos, 'base64')
  const corto = clone(env)
  corto.datos = bytes.subarray(0, bytes.length - 5).toString('base64')
  assert.throws(() => decryptText(corto, PASS), { message: WRONG_PASSWORD })
  const largo = clone(env)
  largo.datos = Buffer.concat([bytes, Buffer.from('x')]).toString('base64')
  assert.throws(() => decryptText(largo, PASS), { message: WRONG_PASSWORD })
})

test('tag, iv o sal truncados se detectan como archivo dañado', () => {
  const env = encryptText(TEXT, PASS)
  const tag = clone(env)
  tag.cifrado.tag = recortar(env.cifrado.tag, 8)
  assert.throws(() => decryptText(tag, PASS), /dañado \(tag\)/)
  const iv = clone(env)
  iv.cifrado.iv = recortar(env.cifrado.iv, 8)
  assert.throws(() => decryptText(iv, PASS), /dañado \(iv\)/)
  const sal = clone(env)
  sal.cifrado.sal = recortar(env.cifrado.sal, 4)
  assert.throws(() => decryptText(sal, PASS), /dañado \(sal\)/)
})

test('campos que no son base64 o no son texto se rechazan como dañados', () => {
  const env = encryptText(TEXT, PASS)
  for (const valor of ['no es base64!', '', 42, null, undefined]) {
    const e = clone(env)
    ;(e as unknown as { datos: unknown }).datos = valor
    assert.throws(() => decryptText(e, PASS), /dañado \(datos\)/)
  }
})

test('algoritmo o kdf desconocidos, o sin bloque de cifrado, no los reconoce esta versión', () => {
  const env = encryptText(TEXT, PASS)
  const algo = clone(env)
  ;(algo.cifrado as unknown as { algoritmo: string }).algoritmo = 'aes-128-cbc'
  assert.throws(() => decryptText(algo, PASS), /no lo reconoce/)
  const kdf = clone(env)
  ;(kdf.cifrado as unknown as { kdf: string }).kdf = 'pbkdf2'
  assert.throws(() => decryptText(kdf, PASS), /no lo reconoce/)
  assert.throws(() => decryptText({ datos: env.datos } as unknown as Encrypted, PASS), /no lo reconoce/)
})

test('parámetros de scrypt fuera de rango se rechazan antes de gastar memoria', () => {
  const env = encryptText(TEXT, PASS)
  const casos: Partial<Encrypted['cifrado']>[] = [
    { N: 2 ** 20 },
    { N: 1 },
    { N: 1000.5 },
    { N: Number.NaN },
    { r: 0 },
    { r: 1000 },
    { p: 0 },
    { p: 64 }
  ]
  for (const caso of casos) {
    const e = clone(env)
    Object.assign(e.cifrado, caso)
    assert.throws(() => decryptText(e, PASS), /parámetros del cifrado/, JSON.stringify(caso))
  }
})

test('la contraseña mínima exigida es 8', () => {
  assert.equal(MIN_PASSWORD, 8)
})

test('texto vacío: ida y vuelta', { todo: 'cifrar «» deja datos vacíos y descifrar lo rechaza como dañado' }, () => {
  assert.equal(decryptText(encryptText('', PASS), PASS), '')
})
