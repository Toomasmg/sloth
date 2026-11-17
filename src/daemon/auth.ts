import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const NONCE_RE = /^[0-9a-f]{64}$/
export const KEY_RE = /^[0-9a-f]{64}$/i

export function nuevoNonce(): string {
  return randomBytes(32).toString('hex')
}

const hmac = (key: string, data: string): string => createHmac('sha256', key).update(data).digest('hex')

export function pruebaDaemon(key: string, nonceCliente: string, nonceDaemon: string): string {
  return hmac(key, `sloth-daemon|${nonceCliente}|${nonceDaemon}`)
}

export function pruebaCliente(key: string, nonceCliente: string, nonceDaemon: string): string {
  return hmac(key, `sloth-client|${nonceCliente}|${nonceDaemon}`)
}

export function mismaPrueba(dada: unknown, esperada: string): boolean {
  if (typeof dada !== 'string') return false
  const a = Buffer.from(dada)
  const b = Buffer.from(esperada)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Cada espacio recibe un token derivado: el de un espacio no sirve para mandar hooks en nombre de otro. */
export function hookTokenDe(hookToken: string, ws: string): string {
  return hmac(hookToken, `ws:${ws}`)
}
