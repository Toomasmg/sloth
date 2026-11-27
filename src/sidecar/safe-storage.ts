/**
 * Cifrado compatible con `safeStorage` de Electron en Windows (el esquema «os_crypt» de Chromium):
 * - la clave AES-256 vive en `<userData>/Local State` (os_crypt.encrypted_key), protegida con DPAPI y con el prefijo «DPAPI»;
 * - cada texto se guarda como «v10» + nonce de 12 bytes + texto cifrado + etiqueta GCM de 16 bytes.
 * Así lo que ya guardó la versión con Electron se sigue leyendo, y al revés.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface Dpapi {
  protect(datos: Buffer): Buffer
  unprotect(datos: Buffer): Buffer
}

const PREFIJO_DATOS = Buffer.from('v10')
const PREFIJO_CLAVE = Buffer.from('DPAPI')
const NONCE = 12
const ETIQUETA = 16

export function cifrar(clave: Buffer, texto: string, nonce: Buffer = randomBytes(NONCE)): Buffer {
  const c = createCipheriv('aes-256-gcm', clave, nonce)
  const cifrado = Buffer.concat([c.update(texto, 'utf8'), c.final()])
  return Buffer.concat([PREFIJO_DATOS, nonce, cifrado, c.getAuthTag()])
}

export function descifrar(clave: Buffer, datos: Buffer): string {
  if (datos.length < PREFIJO_DATOS.length + NONCE + ETIQUETA || !datos.subarray(0, PREFIJO_DATOS.length).equals(PREFIJO_DATOS)) {
    throw new Error('Los datos no tienen el formato del cifrado del sistema.')
  }
  const nonce = datos.subarray(PREFIJO_DATOS.length, PREFIJO_DATOS.length + NONCE)
  const etiqueta = datos.subarray(datos.length - ETIQUETA)
  const cifrado = datos.subarray(PREFIJO_DATOS.length + NONCE, datos.length - ETIQUETA)
  const d = createDecipheriv('aes-256-gcm', clave, nonce)
  d.setAuthTag(etiqueta)
  return Buffer.concat([d.update(cifrado), d.final()]).toString('utf8')
}

interface LocalState {
  os_crypt?: { encrypted_key?: unknown }
  [otro: string]: unknown
}

function leerLocalState(archivo: string): LocalState {
  try {
    const j: unknown = JSON.parse(readFileSync(archivo, 'utf8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as LocalState) : {}
  } catch {
    return {}
  }
}

/**
 * La clave de la carpeta de datos. Si no hay (instalación nueva) se crea una y se guarda con el mismo
 * formato que Electron, sin tocar el resto de «Local State».
 */
export function claveDeUserData(userData: string, dpapi: Dpapi): Buffer {
  const archivo = join(userData, 'Local State')
  const estado = leerLocalState(archivo)
  const guardada = estado.os_crypt?.encrypted_key
  if (typeof guardada === 'string') {
    const bruto = Buffer.from(guardada, 'base64')
    if (bruto.subarray(0, PREFIJO_CLAVE.length).equals(PREFIJO_CLAVE)) return dpapi.unprotect(bruto.subarray(PREFIJO_CLAVE.length))
    throw new Error('La clave del cifrado del sistema tiene un formato que Sloth no reconoce.')
  }
  const clave = randomBytes(32)
  const protegida = Buffer.concat([PREFIJO_CLAVE, dpapi.protect(clave)])
  const nuevo = { ...estado, os_crypt: { ...estado.os_crypt, encrypted_key: protegida.toString('base64') } }
  if (!existsSync(dirname(archivo))) mkdirSync(dirname(archivo), { recursive: true })
  const tmp = `${archivo}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(nuevo))
  renameSync(tmp, archivo)
  return clave
}
