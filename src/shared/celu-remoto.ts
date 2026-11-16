import type { EstadoCelular } from './celular'

/**
 * Contrato de «Celular desde cualquier red»: la PC y la página del celu hablan por un canal privado de
 * Supabase Realtime (`celu:<userId>`) con todo cifrado (AES-256-GCM). La clave sale del secreto del QR,
 * que viaja en el `#` del enlace y nunca llega a ningún servidor. Lo usan main y la web: sin `node:*`.
 */

export const CELU_WEB_URL = 'https://toomasmg.github.io/sloth/celu/'

export const EVENTOS = { estado: 'estado', hola: 'hola', decision: 'decision', resultado: 'resultado' } as const
export type EventoCelu = (typeof EVENTOS)[keyof typeof EVENTOS]

export const HOLA_CADA_MS = 30_000
export const CELU_ACTIVO_MS = 75_000
export const LATIDO_MS = 15_000
export const MIN_ENTRE_ESTADOS_MS = 2_000
export const VIEJO_MS = 40_000
export const DECISION_VENTANA_MS = 60_000
export const MAX_SOBRE = 200_000

export type Clave = CryptoKey

export interface Sobre {
  v: 1
  iv: string
  ct: string
}

/** Lo que va en el QR: url y anon key del proyecto, el secreto y el uuid de auth del usuario. */
export interface Emparejamiento {
  u: string
  k: string
  s: string
  id: string
}

/** Lo que el celu guarda a la vista: todo menos el secreto, que queda solo como clave no exportable. */
export type Destino = Omit<Emparejamiento, 's'>

export interface DatoEstado {
  estado: EstadoCelular
  n: number
}

export interface DatoHola {
  at: number
}

export interface DatoDecision {
  id: string
  decision: 'allow' | 'deny'
  at: number
  nonce: string
}

export interface DatoResultado {
  id: string
  ok: boolean
  error?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IV_BYTES = 12
const MAX_ENLACE = 8000

export const topicCelu = (userId: string): string => `celu:${userId.toLowerCase()}`

export const secretoValido = (s: unknown): s is string => typeof s === 'string' && s.length <= 128 && /^[A-Za-z0-9_-]{43,}$/.test(s)

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

export function aBase64url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Lanza si el texto no es base64url. */
export function deBase64url(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('base64url inválido')
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const utf8 = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s)

export function enlaceCelu(p: Emparejamiento, base?: string): string {
  return `${base ?? CELU_WEB_URL}#p=${aBase64url(utf8(JSON.stringify({ u: p.u, k: p.k, s: p.s, id: p.id })))}`
}

export function leerEmparejamiento(hash: string): Emparejamiento | null {
  if (typeof hash !== 'string' || hash.length > MAX_ENLACE) return null
  const p = new URLSearchParams(hash.replace(/^#/, '')).get('p')
  if (!p) return null
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(deBase64url(p)))
  } catch {
    return null
  }
  const d = validarDestino(raw)
  if (!d || !isObj(raw) || !secretoValido(raw.s)) return null
  return { ...d, s: raw.s }
}

export function validarDestino(raw: unknown): Destino | null {
  if (!isObj(raw)) return null
  const { u, k, id } = raw
  if (typeof u !== 'string' || typeof k !== 'string' || typeof id !== 'string') return null
  try {
    if (new URL(u).protocol !== 'https:') return null
  } catch {
    return null
  }
  if (!k || k.length > 2000 || !UUID.test(id)) return null
  return { u, k, id: id.toLowerCase() }
}

/** Mismo proyecto y misma cuenta: un enlace así reemplaza al guardado sin preguntar. */
export const mismoDestino = (a: Destino, b: Destino): boolean => a.u === b.u && a.id.toLowerCase() === b.id.toLowerCase()

/**
 * El celu descarta un estado más viejo que el último (un sobre reenviado). Si el último ya venció, acepta
 * cualquiera: así se recupera si el reloj de la PC volvió para atrás.
 */
export function estadoMasNuevo(ultimo: { ahora: number; recibido: number } | null, ahoraPc: number, ahoraCelu: number): boolean {
  if (!ultimo || ahoraCelu - ultimo.recibido > VIEJO_MS) return true
  return ahoraPc > ultimo.ahora
}

/** HKDF-SHA-256 del secreto, con el userId de sal: el mismo secreto con otra cuenta da otra clave. */
export async function claveCelu(secreto: string, userId: string): Promise<Clave> {
  const base = await crypto.subtle.importKey('raw', deBase64url(secreto), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8(userId.toLowerCase()), info: utf8('sloth-celu-v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

// El AAD ata el sobre a su topic y a su evento: un `estado` no se puede reenviar como `decision`.
const aad = (topic: string, evento: EventoCelu): Uint8Array<ArrayBuffer> => utf8(`${topic}|${evento}`)

export async function sellar(clave: Clave, topic: string, evento: EventoCelu, dato: unknown): Promise<Sobre> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(topic, evento) }, clave, utf8(JSON.stringify(dato)))
  return { v: 1, iv: aBase64url(iv), ct: aBase64url(new Uint8Array(ct)) }
}

/** null si no es un sobre, si es demasiado grande o si no lo selló esta clave para este topic y evento. */
export async function abrir(clave: Clave, topic: string, evento: EventoCelu, sobre: unknown): Promise<unknown | null> {
  if (!isObj(sobre) || sobre.v !== 1 || typeof sobre.iv !== 'string' || typeof sobre.ct !== 'string') return null
  if (sobre.ct.length > MAX_SOBRE || sobre.iv.length > 32) return null
  try {
    const iv = deBase64url(sobre.iv)
    if (iv.length !== IV_BYTES) return null
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(topic, evento) }, clave, deBase64url(sobre.ct))
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pt)) as unknown
  } catch {
    return null
  }
}

const enVentana = (at: unknown, ahora: number): at is number => typeof at === 'number' && Number.isFinite(at) && Math.abs(at - ahora) <= DECISION_VENTANA_MS

export function validarHola(d: unknown, ahora: number): DatoHola | null {
  return isObj(d) && enVentana(d.at, ahora) ? { at: d.at } : null
}

export function validarDecision(d: unknown, ahora: number): DatoDecision | null {
  if (!isObj(d)) return null
  const { id, decision, at, nonce } = d
  if (typeof id !== 'string' || id.length < 1 || id.length > 100) return null
  if (decision !== 'allow' && decision !== 'deny') return null
  if (!enVentana(at, ahora)) return null
  if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 64) return null
  return { id, decision, at, nonce }
}
