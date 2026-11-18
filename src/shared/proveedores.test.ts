import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CAPACIDADES, PROVEEDORES_IDS, capacidadesDe, esProveedorId, motivoSinCapacidad, nombreProveedor, proveedorIdDe } from './proveedores'
import type { Capacidades } from './proveedores'

test('proveedorIdDe: ausente es claude y desconocido no es ninguno', () => {
  assert.equal(proveedorIdDe({}), 'claude')
  assert.equal(proveedorIdDe({ proveedor: 'claude' }), 'claude')
  assert.equal(proveedorIdDe({ proveedor: 'codex' }), 'codex')
  assert.equal(proveedorIdDe({ proveedor: 'otro-agente' }), undefined)
  assert.equal(proveedorIdDe({ proveedor: 5 }), undefined)
  assert.equal(proveedorIdDe({ proveedor: '__proto__' }), undefined)
})

test('esProveedorId solo acepta ids del registro', () => {
  assert.equal(esProveedorId('claude'), true)
  assert.equal(esProveedorId('codex'), true)
  assert.equal(esProveedorId('otro-agente'), false)
  assert.equal(esProveedorId('toString'), false)
  assert.equal(esProveedorId(undefined), false)
})

test('capacidades: claude las tiene todas y codex ninguna', () => {
  assert.deepEqual([...PROVEEDORES_IDS], ['claude', 'codex'])
  for (const k of Object.keys(CAPACIDADES.claude) as (keyof Capacidades)[]) {
    assert.equal(CAPACIDADES.claude[k], true, `claude ${k}`)
    assert.equal(CAPACIDADES.codex[k], false, `codex ${k}`)
  }
  assert.equal(capacidadesDe({})?.hooks, true)
  assert.equal(capacidadesDe({ proveedor: 'codex' })?.hooks, false)
  assert.equal(capacidadesDe({ proveedor: 'otro-agente' }), undefined)
})

test('nombreProveedor y motivoSinCapacidad', () => {
  assert.equal(nombreProveedor({}), 'Claude Code')
  assert.equal(nombreProveedor({ proveedor: 'codex' }), 'Codex')
  assert.equal(nombreProveedor({ proveedor: 'otro-agente' }), 'Agente desconocido')
  assert.equal(motivoSinCapacidad({}, 'tickets'), undefined)
  assert.equal(motivoSinCapacidad({ proveedor: 'codex' }, 'tickets'), 'Codex todavía no soporta esto en Sloth.')
  assert.match(motivoSinCapacidad({ proveedor: 'codex' }, 'hooks') ?? '', /avisos de permisos desde el celu/)
  assert.match(motivoSinCapacidad({ proveedor: 'otro-agente' }, 'tickets') ?? '', /actualizá Sloth/)
})
