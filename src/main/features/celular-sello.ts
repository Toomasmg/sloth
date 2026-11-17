import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const VENTANA_MS = 5 * 60_000
export const MAX_SOBRE_BYTES = 8192

const IV_BYTES = 16
const TAG_BYTES = 32

export interface Claves {
  enc: Buffer
  mac: Buffer
}

export interface Repetidos {
  vistoAntes(iv: Buffer, ahora: number): boolean
}

function hmac(clave: Buffer, ...partes: Array<Buffer | string>): Buffer {
  const h = createHmac('sha256', clave)
  for (const p of partes) h.update(p)
  return h.digest()
}

// Buffer.from(…, 'base64url') perdona caracteres de más: se exige la forma canónica.
function decodificar(texto: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(texto)) return null
  const b = Buffer.from(texto, 'base64url')
  return b.toString('base64url') === texto ? b : null
}

export function derivarClaves(clave: string): Claves | null {
  if (typeof clave !== 'string') return null
  const bytes = decodificar(clave)
  if (!bytes || bytes.length !== 32) return null
  return { enc: hmac(bytes, 'sloth-wifi enc'), mac: hmac(bytes, 'sloth-wifi mac') }
}

function ctr(c: Claves, iv: Buffer, datos: Buffer): Buffer {
  const cifra = createCipheriv('aes-256-ctr', c.enc, iv)
  return Buffer.concat([cifra.update(datos), cifra.final()])
}

function sellar(c: Claves, prefijo: Buffer, json: string, iv: Buffer): string {
  if (iv.length !== IV_BYTES) throw new Error('El iv tiene que medir 16 bytes')
  const ct = ctr(c, iv, Buffer.from(json, 'utf8'))
  const tag = hmac(c.mac, prefijo, iv, ct)
  return Buffer.concat([iv, ct, tag]).toString('base64url')
}

function abrir(c: Claves, prefijo: Buffer, sobre: unknown): { json: string; iv: Buffer } | null {
  if (typeof sobre !== 'string' || sobre.length > MAX_SOBRE_BYTES) return null
  const bytes = decodificar(sobre)
  if (!bytes || bytes.length < IV_BYTES + TAG_BYTES) return null
  const iv = bytes.subarray(0, IV_BYTES)
  const ct = bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES)
  const tag = bytes.subarray(bytes.length - TAG_BYTES)
  const esperado = hmac(c.mac, prefijo, iv, ct)
  if (!timingSafeEqual(tag, esperado)) return null
  const claro = createDecipheriv('aes-256-ctr', c.enc, iv)
  const json = Buffer.concat([claro.update(ct), claro.final()]).toString('utf8')
  return { json, iv: Buffer.from(iv) }
}

function prefijoPedido(ruta: string): Buffer {
  return Buffer.from('q' + ruta + '\0', 'utf8')
}

function prefijoRespuesta(ivPedido: Buffer): Buffer {
  return Buffer.concat([Buffer.from('r', 'utf8'), ivPedido])
}

export function sellarPedido(c: Claves, ruta: string, json: string, iv: Buffer = randomBytes(IV_BYTES)): string {
  return sellar(c, prefijoPedido(ruta), json, iv)
}

export function abrirPedido(c: Claves, ruta: string, sobre: string): { json: string; iv: Buffer } | null {
  return abrir(c, prefijoPedido(ruta), sobre)
}

export function sellarRespuesta(c: Claves, ivPedido: Buffer, json: string, iv: Buffer = randomBytes(IV_BYTES)): string {
  return sellar(c, prefijoRespuesta(ivPedido), json, iv)
}

export function abrirRespuesta(c: Claves, ivPedido: Buffer, sobre: string): string | null {
  return abrir(c, prefijoRespuesta(ivPedido), sobre)?.json ?? null
}

export function crearRepetidos(ttlMs = 10 * 60_000, tope = 20_000): Repetidos {
  const vistos = new Map<string, number>()
  return {
    vistoAntes(iv, ahora) {
      for (const [k, t] of vistos) {
        if (ahora - t <= ttlMs) break
        vistos.delete(k)
      }
      const clave = iv.toString('base64')
      if (vistos.has(clave)) return true
      while (vistos.size >= tope) {
        const mas = vistos.keys().next()
        if (mas.done) break
        vistos.delete(mas.value)
      }
      vistos.set(clave, ahora)
      return false
    }
  }
}

export function fechaValida(t: unknown, ahora: number): t is number {
  return typeof t === 'number' && Number.isFinite(t) && Math.abs(ahora - t) <= VENTANA_MS
}
