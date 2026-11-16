import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  abrir,
  aBase64url,
  CELU_WEB_URL,
  claveCelu,
  DECISION_VENTANA_MS,
  enlaceCelu,
  EVENTOS,
  leerEmparejamiento,
  MAX_SOBRE,
  sellar,
  secretoValido,
  topicCelu,
  validarDecision,
  validarHola
} from './celu-remoto'

const ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b'
const OTRO_ID = '00000000-1111-2222-3333-444444444444'
const secreto = (b: number): string => aBase64url(new Uint8Array(32).fill(b))
const S = secreto(7)
const T = topicCelu(ID)

test('topicCelu va en minúsculas', () => {
  assert.equal(topicCelu('ABC-1'), 'celu:abc-1')
})

test('secretoValido pide al menos 43 caracteres base64url', () => {
  assert.equal(secretoValido(S), true)
  assert.equal(secretoValido('corto'), false)
  assert.equal(secretoValido(`${S.slice(0, 42)}+`), false)
  assert.equal(secretoValido(42), false)
})

test('sellar y abrir: ida y vuelta', async () => {
  const k = await claveCelu(S, ID)
  const dato = { at: 123, texto: 'ñandú' }
  const sobre = await sellar(k, T, EVENTOS.hola, dato)
  assert.equal(sobre.v, 1)
  assert.deepEqual(await abrir(k, T, EVENTOS.hola, sobre), dato)
})

test('abrir da null con otro evento, otro topic u otra clave', async () => {
  const k = await claveCelu(S, ID)
  const sobre = await sellar(k, T, EVENTOS.estado, { n: 1 })
  assert.equal(await abrir(k, T, EVENTOS.decision, sobre), null)
  assert.equal(await abrir(k, topicCelu(OTRO_ID), EVENTOS.estado, sobre), null)
  assert.equal(await abrir(await claveCelu(secreto(8), ID), T, EVENTOS.estado, sobre), null)
  assert.equal(await abrir(await claveCelu(S, OTRO_ID), T, EVENTOS.estado, sobre), null)
})

test('la clave no depende de las mayúsculas del userId', async () => {
  const sobre = await sellar(await claveCelu(S, ID.toUpperCase()), T, EVENTOS.hola, { at: 1 })
  assert.deepEqual(await abrir(await claveCelu(S, ID), T, EVENTOS.hola, sobre), { at: 1 })
})

test('abrir da null con un sobre alterado o con basura', async () => {
  const k = await claveCelu(S, ID)
  const sobre = await sellar(k, T, EVENTOS.hola, { at: 1 })
  const ct = sobre.ct
  const otro = ct[0] === 'A' ? 'B' : 'A'
  assert.equal(await abrir(k, T, EVENTOS.hola, { ...sobre, ct: otro + ct.slice(1) }), null)
  assert.equal(await abrir(k, T, EVENTOS.hola, { ...sobre, iv: aBase64url(new Uint8Array(8)) }), null)
  assert.equal(await abrir(k, T, EVENTOS.hola, { ...sobre, v: 2 }), null)
  assert.equal(await abrir(k, T, EVENTOS.hola, { ...sobre, ct: 'no base64!' }), null)
  assert.equal(await abrir(k, T, EVENTOS.hola, null), null)
  assert.equal(await abrir(k, T, EVENTOS.hola, {}), null)
  assert.equal(await abrir(k, T, EVENTOS.hola, 'texto'), null)
  assert.equal(await abrir(k, T, EVENTOS.hola, { ...sobre, ct: 'A'.repeat(MAX_SOBRE + 1) }), null)
})

test('enlaceCelu y leerEmparejamiento: ida y vuelta', () => {
  const p = { u: 'https://abc.supabase.co', k: 'sb_publishable_x', s: S, id: ID }
  const enlace = enlaceCelu(p)
  assert.ok(enlace.startsWith(`${CELU_WEB_URL}#p=`))
  assert.deepEqual(leerEmparejamiento(new URL(enlace).hash), p)
  assert.deepEqual(leerEmparejamiento(enlaceCelu(p, 'http://localhost:5173/').split('#')[1]), p)
})

test('leerEmparejamiento rechaza http, ids raros, secretos cortos y basura', () => {
  const base = { u: 'https://abc.supabase.co', k: 'k', s: S, id: ID }
  const hash = (o: Record<string, unknown>): string => `#p=${aBase64url(new TextEncoder().encode(JSON.stringify(o)))}`
  assert.equal(leerEmparejamiento(hash({ ...base, u: 'http://abc.supabase.co' })), null)
  assert.equal(leerEmparejamiento(hash({ ...base, u: 'no es url' })), null)
  assert.equal(leerEmparejamiento(hash({ ...base, id: 'no-uuid' })), null)
  assert.equal(leerEmparejamiento(hash({ ...base, s: 'corto' })), null)
  assert.equal(leerEmparejamiento(hash({ ...base, k: '' })), null)
  assert.equal(leerEmparejamiento('#p=%%%'), null)
  assert.equal(leerEmparejamiento('#otra=1'), null)
  assert.equal(leerEmparejamiento(''), null)
})

test('validarHola pide un at cercano', () => {
  assert.deepEqual(validarHola({ at: 1000 }, 1000), { at: 1000 })
  assert.equal(validarHola({ at: 1000 - DECISION_VENTANA_MS - 1 }, 1000), null)
  assert.equal(validarHola({ at: 'ya' }, 1000), null)
  assert.equal(validarHola(null, 1000), null)
})

test('validarDecision acepta lo válido y rechaza lo viejo, lo futuro, lo raro y el nonce corto', () => {
  const ahora = 1_000_000
  const ok = { id: 'p-1', decision: 'allow', at: ahora - 5000, nonce: 'n'.repeat(16) }
  assert.deepEqual(validarDecision(ok, ahora), ok)
  assert.deepEqual(validarDecision({ ...ok, decision: 'deny', extra: 1 }, ahora), { ...ok, decision: 'deny' })
  assert.equal(validarDecision({ ...ok, at: ahora - DECISION_VENTANA_MS - 1 }, ahora), null)
  assert.equal(validarDecision({ ...ok, at: ahora + DECISION_VENTANA_MS + 1 }, ahora), null)
  assert.equal(validarDecision({ ...ok, decision: 'always' }, ahora), null)
  assert.equal(validarDecision({ ...ok, nonce: 'corto' }, ahora), null)
  assert.equal(validarDecision({ ...ok, nonce: 'n'.repeat(65) }, ahora), null)
  assert.equal(validarDecision({ ...ok, id: '' }, ahora), null)
  assert.equal(validarDecision({ ...ok, id: 'x'.repeat(101) }, ahora), null)
  assert.equal(validarDecision(null, ahora), null)
})
