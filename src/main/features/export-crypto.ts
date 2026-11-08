/**
 * Cifrado del archivo .sloth con contraseña: AES-256-GCM con la clave derivada de la contraseña
 * con scrypt (sal aleatoria por archivo). Sloth no guarda la contraseña. Solo node:crypto.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

export const MIN_PASSWORD = 8
export const WRONG_PASSWORD = 'La contraseña no es correcta. Revisala y probá de nuevo.'

const KEY_LEN = 32
const SALT_LEN = 16
const IV_LEN = 12
const TAG_LEN = 16
/** Parámetros de scrypt: si el archivo trae otros, se rechaza (evita que un archivo cueste mucha memoria). */
const MAX_N = 2 ** 17
const MAX_R = 16
const MAX_P = 4

export interface CipherBlock {
  algoritmo: 'aes-256-gcm'
  kdf: 'scrypt'
  N: number
  r: number
  p: number
  sal: string
  iv: string
  tag: string
}

export interface Encrypted {
  cifrado: CipherBlock
  datos: string
}

function key(password: string, salt: Buffer, N: number, r: number, p: number): Buffer {
  return scryptSync(password, salt, KEY_LEN, { N, r, p, maxmem: 64 * 1024 * 1024 })
}

export function encryptText(text: string, password: string): Encrypted {
  const salt = randomBytes(SALT_LEN)
  const iv = randomBytes(IV_LEN)
  const N = 16384
  const r = 8
  const p = 1
  const c = createCipheriv('aes-256-gcm', key(password, salt, N, r, p), iv)
  const datos = Buffer.concat([c.update(text, 'utf8'), c.final()])
  return {
    cifrado: {
      algoritmo: 'aes-256-gcm',
      kdf: 'scrypt',
      N,
      r,
      p,
      sal: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: c.getAuthTag().toString('base64')
    },
    datos: datos.toString('base64')
  }
}

const b64 = (v: unknown, len: number, what: string): Buffer => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) throw new Error(`El cifrado del archivo está dañado (${what}).`)
  const buf = Buffer.from(v, 'base64')
  if (len && buf.length !== len) throw new Error(`El cifrado del archivo está dañado (${what}).`)
  return buf
}

/** Descifra. Tira un Error con mensaje claro si la contraseña no coincide o el archivo está dañado. */
export function decryptText(env: Encrypted, password: string): string {
  const c = env.cifrado
  if (!c || c.algoritmo !== 'aes-256-gcm' || c.kdf !== 'scrypt') throw new Error('Ese cifrado no lo reconoce esta versión de Sloth.')
  if (!Number.isInteger(c.N) || c.N < 2 || c.N > MAX_N || !Number.isInteger(c.r) || c.r < 1 || c.r > MAX_R || !Number.isInteger(c.p) || c.p < 1 || c.p > MAX_P)
    throw new Error('Los parámetros del cifrado del archivo no son válidos.')
  const salt = b64(c.sal, 0, 'sal')
  if (salt.length < SALT_LEN) throw new Error('El cifrado del archivo está dañado (sal).')
  const iv = b64(c.iv, IV_LEN, 'iv')
  const tag = b64(c.tag, TAG_LEN, 'tag')
  const data = b64(env.datos, 0, 'datos')
  try {
    const d = createDecipheriv('aes-256-gcm', key(password, salt, c.N, c.r, c.p), iv)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(data), d.final()]).toString('utf8')
  } catch {
    throw new Error(WRONG_PASSWORD)
  }
}
