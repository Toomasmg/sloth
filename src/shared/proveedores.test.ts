import { test } from 'node:test'
import assert from 'node:assert/strict'
import { esProveedorId, proveedorIdDe } from './proveedores'

test('proveedorIdDe: ausente o desconocido es claude', () => {
  assert.equal(proveedorIdDe({}), 'claude')
  assert.equal(proveedorIdDe({ proveedor: 'claude' }), 'claude')
  assert.equal(proveedorIdDe({ proveedor: 'codex' }), 'claude')
  assert.equal(proveedorIdDe({ proveedor: 5 }), 'claude')
  assert.equal(proveedorIdDe({ proveedor: '__proto__' }), 'claude')
})

test('esProveedorId solo acepta ids del registro', () => {
  assert.equal(esProveedorId('claude'), true)
  assert.equal(esProveedorId('codex'), false)
  assert.equal(esProveedorId('toString'), false)
  assert.equal(esProveedorId(undefined), false)
})
