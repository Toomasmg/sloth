import { test } from 'node:test'
import assert from 'node:assert/strict'
import { esProveedorId, proveedorIdDe } from './proveedores'

test('proveedorIdDe: ausente es claude y desconocido no es ninguno', () => {
  assert.equal(proveedorIdDe({}), 'claude')
  assert.equal(proveedorIdDe({ proveedor: 'claude' }), 'claude')
  assert.equal(proveedorIdDe({ proveedor: 'codex' }), undefined)
  assert.equal(proveedorIdDe({ proveedor: 5 }), undefined)
  assert.equal(proveedorIdDe({ proveedor: '__proto__' }), undefined)
})

test('esProveedorId solo acepta ids del registro', () => {
  assert.equal(esProveedorId('claude'), true)
  assert.equal(esProveedorId('codex'), false)
  assert.equal(esProveedorId('toString'), false)
  assert.equal(esProveedorId(undefined), false)
})
