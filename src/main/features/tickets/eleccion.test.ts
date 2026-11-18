import { test } from 'node:test'
import assert from 'node:assert/strict'
import { elegirCuenta, sirveParaTickets, type Candidata } from './eleccion'

const claude = {}
const codex = { proveedor: 'codex' }
const copilot = { proveedor: 'copilot' }

test('trabajar por ticket es solo de Claude: Codex y Copilot no sirven para «Empezar en Sloth»', () => {
  assert.equal(sirveParaTickets(claude, 'trabajo'), true)
  assert.equal(sirveParaTickets({ proveedor: 'claude' }, 'trabajo'), true)
  assert.equal(sirveParaTickets(codex, 'trabajo'), false)
  assert.equal(sirveParaTickets(copilot, 'trabajo'), false)
  assert.equal(sirveParaTickets({ proveedor: 'otro' }, 'trabajo'), false)
})

test('consultar tickets sí sirve con Codex; buscar herramientas, solo con Claude', () => {
  assert.equal(sirveParaTickets(codex, 'consulta'), true)
  assert.equal(sirveParaTickets(copilot, 'consulta'), false)
  assert.equal(sirveParaTickets(claude, 'descubrir'), true)
  assert.equal(sirveParaTickets(codex, 'descubrir'), false)
})

test('si solo hay cuentas de Codex con sesión, el flujo de trabajo no tiene a quién elegir', () => {
  const logueadas = [{ id: 'c1', ...codex }, { id: 'c2', ...codex }]
  assert.deepEqual(logueadas.filter((a) => sirveParaTickets(a, 'trabajo')), [])
  assert.equal(elegirCuenta([]), undefined)
})

const c = (id: string, extra: Partial<Candidata> = {}): Candidata => ({ id, conConector: false, conUso: true, consumo: 0, ...extra })

test('elegirCuenta: la de menos consumo', () => {
  assert.equal(elegirCuenta([c('a', { consumo: 9 }), c('b', { consumo: 2 }), c('d', { consumo: 5 })]), 'b')
})

test('elegirCuenta: una sin dato de uso no gana a una con dato aunque cuente 0', () => {
  assert.equal(elegirCuenta([c('codex', { conUso: false }), c('claude', { consumo: 50 })]), 'claude')
  assert.equal(elegirCuenta([c('codex', { conUso: false })]), 'codex')
})

test('elegirCuenta: las que tienen el conector van primero, si se sabe de alguna', () => {
  assert.equal(elegirCuenta([c('a', { consumo: 1 }), c('b', { consumo: 90, conConector: true })]), 'b')
  assert.equal(elegirCuenta([c('a', { consumo: 1 }), c('b', { consumo: 90 })]), 'a')
})
