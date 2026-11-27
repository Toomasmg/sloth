import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cifrar, claveDeUserData, descifrar, type Dpapi } from './safe-storage'

// DPAPI de mentira: un xor reversible alcanza para probar el formato.
const falso: Dpapi = {
  protect: (d) => Buffer.from(d.map((b) => b ^ 0x5a)),
  unprotect: (d) => Buffer.from(d.map((b) => b ^ 0x5a))
}

function carpeta(): string {
  return mkdtempSync(join(tmpdir(), 'sloth-ss-'))
}

test('cifrar y descifrar dan el mismo texto, con el prefijo v10', () => {
  const clave = Buffer.alloc(32, 7)
  const c = cifrar(clave, 'sesión del chat ñ')
  assert.equal(c.subarray(0, 3).toString(), 'v10')
  assert.equal(descifrar(clave, c), 'sesión del chat ñ')
})

test('con otra clave o con datos cambiados falla en vez de devolver basura', () => {
  const c = cifrar(Buffer.alloc(32, 1), 'secreto')
  assert.throws(() => descifrar(Buffer.alloc(32, 2), c))
  c[c.length - 20] ^= 1
  assert.throws(() => descifrar(Buffer.alloc(32, 1), c))
  assert.throws(() => descifrar(Buffer.alloc(32, 1), Buffer.from('v10corto')))
  assert.throws(() => descifrar(Buffer.alloc(32, 1), Buffer.alloc(40)))
})

test('el nonce distinto da cifrados distintos para el mismo texto', () => {
  const clave = Buffer.alloc(32, 3)
  assert.notDeepEqual(cifrar(clave, 'a'), cifrar(clave, 'a'))
})

test('la clave se crea una vez, se guarda como Electron y se reutiliza', () => {
  const dir = carpeta()
  try {
    const k1 = claveDeUserData(dir, falso)
    assert.equal(k1.length, 32)
    const estado = JSON.parse(readFileSync(join(dir, 'Local State'), 'utf8')) as { os_crypt: { encrypted_key: string } }
    assert.equal(Buffer.from(estado.os_crypt.encrypted_key, 'base64').subarray(0, 5).toString(), 'DPAPI')
    assert.deepEqual(claveDeUserData(dir, falso), k1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lee la clave que dejó Electron y no pierde el resto de Local State', () => {
  const dir = carpeta()
  try {
    const clave = Buffer.alloc(32, 9)
    const guardada = Buffer.concat([Buffer.from('DPAPI'), falso.protect(clave)]).toString('base64')
    writeFileSync(join(dir, 'Local State'), JSON.stringify({ otra: 1, os_crypt: { encrypted_key: guardada } }))
    assert.deepEqual(claveDeUserData(dir, falso), clave)
    const nueva = carpeta()
    writeFileSync(join(nueva, 'Local State'), JSON.stringify({ otra: 1 }))
    claveDeUserData(nueva, falso)
    const estado = JSON.parse(readFileSync(join(nueva, 'Local State'), 'utf8')) as { otra: number; os_crypt: unknown }
    assert.equal(estado.otra, 1)
    assert.ok(estado.os_crypt)
    rmSync(nueva, { recursive: true, force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('una clave con formato desconocido no se pisa', () => {
  const dir = carpeta()
  try {
    writeFileSync(join(dir, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('v20xxxx').toString('base64') } }))
    assert.throws(() => claveDeUserData(dir, falso), /no reconoce/)
    assert.match(readFileSync(join(dir, 'Local State'), 'utf8'), /encrypted_key/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
