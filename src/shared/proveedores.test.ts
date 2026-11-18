import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CAPACIDADES, agenteComun, agenteDe, PROVEEDORES_IDS, capacidadesDe, cuentaSugerida, esProveedorId, motivoNoAgregar, motivoSinCapacidad, nombreProveedor, proveedorIdDe } from './proveedores'
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
  assert.deepEqual([...PROVEEDORES_IDS], ['claude', 'codex', 'copilot'])
  for (const k of Object.keys(CAPACIDADES.claude) as (keyof Capacidades)[]) {
    if (k === 'limitesExperimental' || k === 'avisoTurno') continue
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
  assert.match(motivoSinCapacidad({ proveedor: 'codex' }, 'tickets') ?? '', /tickets todavía solo corren con Claude Code/)
  assert.match(motivoSinCapacidad({ proveedor: 'codex' }, 'historial') ?? '', /historial/)
  assert.match(motivoSinCapacidad({ proveedor: 'codex' }, 'moverCuenta') ?? '', /Mover espacios/)
  assert.equal(motivoSinCapacidad({ proveedor: 'codex' }, 'dormir'), 'Codex todavía no soporta esto en Sloth.')
  assert.match(motivoSinCapacidad({ proveedor: 'codex' }, 'hooks') ?? '', /avisos de permisos desde el celu/)
  assert.match(motivoSinCapacidad({ proveedor: 'otro-agente' }, 'tickets') ?? '', /actualizá Sloth/)
})

test('cuentaSugerida: una cuenta de Codex (uso 0) no gana por tener menos uso', () => {
  const cuentas = [{ id: 'cx', proveedor: 'codex' }, { id: 'a' }, { id: 'b', proveedor: 'claude' }]
  const uso: Record<string, number> = { cx: 0, a: 500, b: 100 }
  assert.equal(cuentaSugerida(cuentas, () => true, (id) => uso[id]), 'b')
  assert.equal(cuentaSugerida(cuentas, (id) => id !== 'b', (id) => uso[id]), 'a')
})

test('cuentaSugerida: sin sesión en Claude se prefiere una Claude sin sesión antes que Codex con sesión, como antes', () => {
  const cuentas = [{ id: 'cx', proveedor: 'codex' }, { id: 'a' }]
  assert.equal(cuentaSugerida(cuentas, (id) => id === 'cx', () => 0), 'a')
})

test('cuentaSugerida: si solo hay Codex o un agente desconocido se usa igual, y sin cuentas no hay nada', () => {
  assert.equal(cuentaSugerida([{ id: 'cx', proveedor: 'codex' }], () => true, () => 0), 'cx')
  assert.equal(cuentaSugerida([{ id: 'x', proveedor: 'otro-agente' }], () => false, () => 0), 'x')
  assert.equal(cuentaSugerida([], () => true, () => 0), undefined)
})

test('cuentaSugerida con solo cuentas de Claude: con sesión y la de menos uso, o todas si ninguna tiene sesión', () => {
  const cuentas = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const uso: Record<string, number> = { a: 30, b: 10, c: 5 }
  assert.equal(cuentaSugerida(cuentas, (id) => id !== 'c', (id) => uso[id]), 'b')
  assert.equal(cuentaSugerida(cuentas, () => false, (id) => uso[id]), 'c')
})

test('avisoTurno y limitesExperimental por agente', () => {
  assert.equal(CAPACIDADES.claude.avisoTurno, true)
  assert.equal(CAPACIDADES.claude.limitesExperimental, false)
  assert.equal(CAPACIDADES.codex.avisoTurno, true)
  assert.equal(CAPACIDADES.codex.limitesExperimental, true)
  assert.equal(motivoSinCapacidad({ proveedor: 'codex' }, 'limitesExperimental'), undefined)
  assert.equal(capacidadesDe({ proveedor: 'zzz' })?.limitesExperimental, undefined)
})

test('agenteDe: nombre corto o genérico si no se conoce', () => {
  assert.equal(agenteDe({}), 'Claude')
  assert.equal(agenteDe({ proveedor: 'codex' }), 'Codex')
  assert.equal(agenteDe({ proveedor: 'zzz' }), 'el agente')
})

test('agenteComun: Claude sin cuentas o todas Claude, el mismo agente, o undefined si hay mezcla', () => {
  assert.equal(agenteComun([]), 'Claude')
  assert.equal(agenteComun([{}, { proveedor: 'claude' }]), 'Claude')
  assert.equal(agenteComun([{ proveedor: 'codex' }, { proveedor: 'codex' }]), 'Codex')
  assert.equal(agenteComun([{}, { proveedor: 'codex' }]), undefined)
  assert.equal(agenteComun([{}, { proveedor: 'zzz' }]), undefined)
})

test('motivoSinCapacidad: motivos permanentes de Codex', () => {
  for (const k of ['statusline', 'setupCompartido', 'uso', 'overrideClaude'] as const) {
    assert.notEqual(motivoSinCapacidad({ proveedor: 'codex' }, k), 'Codex todavía no soporta esto en Sloth.', k)
    assert.equal(motivoSinCapacidad({}, k), undefined, k)
  }
})

test('copilot: sin capacidades, con motivos propios y sin compartir el objeto con codex', () => {
  assert.equal(proveedorIdDe({ proveedor: 'copilot' }), 'copilot')
  assert.equal(nombreProveedor({ proveedor: 'copilot' }), 'GitHub Copilot')
  assert.equal(Object.values(capacidadesDe({ proveedor: 'copilot' }) ?? {}).some(Boolean), false)
  assert.notEqual(CAPACIDADES.copilot, CAPACIDADES.codex)
  assert.match(motivoSinCapacidad({ proveedor: 'copilot' }, 'tickets') ?? '', /Copilot/)
  assert.match(motivoSinCapacidad({ proveedor: 'copilot' }, 'uso') ?? '', /no informa cuánto te queda/)
  assert.equal(motivoSinCapacidad({ proveedor: 'copilot' }, 'dormir'), 'GitHub Copilot todavía no soporta esto en Sloth.')
})

test('motivoNoAgregar: claude sin tope, copilot una sola cuenta y los desconocidos no cuentan', () => {
  assert.equal(motivoNoAgregar([{}, {}, {}], 'claude'), undefined)
  assert.equal(motivoNoAgregar([{}, { proveedor: 'codex' }], 'copilot'), undefined)
  assert.equal(motivoNoAgregar([{ proveedor: 'otro-agente' }], 'copilot'), undefined)
  assert.match(motivoNoAgregar([{ proveedor: 'copilot' }], 'copilot') ?? '', /^Ya tenés una cuenta de GitHub Copilot: su login es del sistema/)
})

test('agenteDe y agenteComun con Copilot', () => {
  assert.equal(agenteDe({ proveedor: 'copilot' }), 'Copilot')
  assert.equal(agenteComun([{ proveedor: 'copilot' }, { proveedor: 'copilot' }]), 'Copilot')
  assert.equal(agenteComun([{ proveedor: 'copilot' }, { proveedor: 'codex' }]), undefined)
})
