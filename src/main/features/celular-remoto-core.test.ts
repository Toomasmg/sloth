import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EstadoCelular } from '../../shared/celular'
import { CELU_ACTIVO_MS, LATIDO_MS, MIN_ENTRE_ESTADOS_MS } from '../../shared/celu-remoto'
import { celuActivo, debePublicar, huella, Nonces, type RitmoEntrada } from './celular-remoto-core'

const base: RitmoEntrada = { ahora: 100_000, ultimoHola: 99_000, ultimoEnvio: 99_500, cambio: false, holaNuevo: false }

test('sin hola o con un hola viejo no publica', () => {
  assert.equal(debePublicar({ ...base, ultimoHola: null, holaNuevo: true }), false)
  assert.equal(debePublicar({ ...base, ultimoHola: base.ahora - CELU_ACTIVO_MS - 1, holaNuevo: true, cambio: true, ultimoEnvio: null }), false)
})

test('con un hola nuevo publica al toque', () => {
  assert.equal(debePublicar({ ...base, holaNuevo: true, ultimoEnvio: base.ahora }), true)
  assert.equal(debePublicar({ ...base, ultimoEnvio: null }), true)
})

test('ante cambios respeta el mínimo entre estados', () => {
  assert.equal(debePublicar({ ...base, cambio: true, ultimoEnvio: base.ahora - MIN_ENTRE_ESTADOS_MS + 1 }), false)
  assert.equal(debePublicar({ ...base, cambio: true, ultimoEnvio: base.ahora - MIN_ENTRE_ESTADOS_MS }), true)
  assert.equal(debePublicar({ ...base, cambio: false, ultimoEnvio: base.ahora - MIN_ENTRE_ESTADOS_MS }), false)
})

test('sin cambios manda un latido', () => {
  assert.equal(debePublicar({ ...base, ultimoEnvio: base.ahora - LATIDO_MS + 1 }), false)
  assert.equal(debePublicar({ ...base, ultimoEnvio: base.ahora - LATIDO_MS }), true)
})

test('celuActivo mira los últimos 75 s', () => {
  assert.equal(celuActivo(null, 1000), false)
  assert.equal(celuActivo(1000, 1000 + CELU_ACTIVO_MS), true)
  assert.equal(celuActivo(1000, 1001 + CELU_ACTIVO_MS), false)
})

test('huella ignora ahora y ve lo demás', () => {
  const e: EstadoCelular = { ahora: 1, aprobar: false, cuentas: [], sesiones: [], pedidos: [] }
  assert.equal(huella(e), huella({ ...e, ahora: 2 }))
  assert.notEqual(huella(e), huella({ ...e, aprobar: true }))
})

test('Nonces rechaza un repetido y olvida los más viejos', () => {
  const n = new Nonces(2)
  assert.equal(n.usar('a'), true)
  assert.equal(n.usar('a'), false)
  assert.equal(n.usar('b'), true)
  assert.equal(n.usar('c'), true)
  assert.equal(n.usar('b'), false)
  assert.equal(n.usar('a'), true)
})
