import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AVISO_CODEX, AVISO_CODEX_VIEJO, AVISO_COPILOT, AVISO_COPILOT_VIEJO, SIN_DATO_EN_USO, TITULO_LIMITES, filasLimites, formularioCuenta, textoSinLimites } from './agente-form'
import type { AgenteDisponible } from '../../../../shared/types'

const claude: AgenteDisponible = { id: 'claude', nombre: 'Claude Code', instalado: true }
const codex = (extra: Partial<AgenteDisponible> = {}): AgenteDisponible => ({ id: 'codex', nombre: 'Codex', instalado: true, versionOk: true, ...extra })

const copilot = (extra: Partial<AgenteDisponible> = {}): AgenteDisponible => ({ id: 'copilot', nombre: 'Copilot', instalado: true, versionOk: true, ...extra })

test('sin Codex instalado no hay selector y el formulario es el de Claude', () => {
  const f = formularioCuenta('claude', [claude, codex({ instalado: false })])
  assert.deepEqual(f, { titulo: 'Nueva cuenta de Claude', mostrarSelector: false, mostrarPlan: true, opciones: [{ id: 'claude', nombre: 'Claude Code' }] })
  assert.equal(formularioCuenta('claude', []).mostrarSelector, false)
})

test('sin Codex instalado un proveedor codex pedido igual cae al formulario de Claude', () => {
  assert.equal(formularioCuenta('codex', [claude]).titulo, 'Nueva cuenta de Claude')
})

test('con Codex instalado aparece el selector y Claude sigue por defecto', () => {
  const f = formularioCuenta('claude', [claude, codex()])
  assert.equal(f.mostrarSelector, true)
  assert.equal(f.mostrarPlan, true)
  assert.equal(f.aviso, undefined)
})

test('con Codex elegido cambia el título, se oculta el plan y hay aviso', () => {
  const f = formularioCuenta('codex', [claude, codex()])
  assert.equal(f.titulo, 'Nueva cuenta de Codex')
  assert.equal(f.mostrarPlan, false)
  assert.match(f.aviso ?? '', /puerto 1455/)
  assert.equal(f.avisoVersion, undefined)
})

test('con un Codex viejo se avisa cómo actualizarlo', () => {
  assert.equal(formularioCuenta('codex', [claude, codex({ versionOk: false })]).avisoVersion, AVISO_CODEX_VIEJO)
})

test('filasLimites: solo las ventanas que llegaron y sin ceros inventados', () => {
  const v = (pct: number) => ({ pct, reiniciaEn: null })
  assert.deepEqual(filasLimites({ cincoHoras: v(37.4), semana: v(12), at: 1 }), [
    { nombre: '5 h', valor: '37 % usado' },
    { nombre: 'Semana', valor: '12 % usado' }
  ])
  assert.deepEqual(filasLimites({ cincoHoras: null, semana: v(0), at: 1 }), [{ nombre: 'Semana', valor: '0 % usado' }])
  assert.deepEqual(filasLimites({ cincoHoras: null, semana: null, at: 1 }), [])
  assert.deepEqual(filasLimites(null), [])
  assert.deepEqual(filasLimites(undefined), [])
})

test('filasLimites y el título dicen «usado», nunca «queda»: el dato es usedPercent', () => {
  const v = (pct: number) => ({ pct, reiniciaEn: null })
  const [fila] = filasLimites({ cincoHoras: v(90), semana: null, at: 1 })
  assert.equal(fila.valor, '90 % usado')
  assert.match(TITULO_LIMITES, /usaste/)
  assert.doesNotMatch(TITULO_LIMITES, /queda/)
})

test('textoSinLimites distingue leyendo, terminal abierta y sin dato', () => {
  assert.equal(textoSinLimites(undefined), 'Leyendo límites…')
  assert.equal(textoSinLimites({ tipo: 'en-uso' }), SIN_DATO_EN_USO)
  assert.match(SIN_DATO_EN_USO, /cerrá la terminal/)
  assert.equal(textoSinLimites({ tipo: 'sin-dato' }), 'Sin dato')
  assert.equal(textoSinLimites({ tipo: 'sin-dato', reintentaEnMin: 12 }), 'Sin dato (reintenta en 12 min)')
  assert.equal(textoSinLimites({ tipo: 'datos', limites: { cincoHoras: null, semana: null, at: 1 } }), 'Sin dato')
})

test('con Codex solo: opciones Claude y Codex, y el formulario de Codex con sus textos', () => {
  const f = formularioCuenta('codex', [claude, codex()])
  assert.deepEqual(f.opciones.map((o) => o.nombre), ['Claude Code', 'Codex'])
  assert.equal(f.aviso, AVISO_CODEX)
  assert.equal(f.bloqueo, undefined)
})

test('con Copilot solo: opciones Claude y Copilot, y el formulario avisa del login compartido', () => {
  const f = formularioCuenta('copilot', [claude, copilot()])
  assert.deepEqual(f.opciones.map((o) => o.id), ['claude', 'copilot'])
  assert.equal(f.titulo, 'Nueva cuenta de Copilot')
  assert.equal(f.mostrarPlan, false)
  assert.equal(f.aviso, AVISO_COPILOT)
  assert.equal(f.bloqueo, undefined)
  assert.equal(formularioCuenta('claude', [claude, copilot()]).titulo, 'Nueva cuenta de Claude')
})

test('con Copilot no instalado el proveedor pedido cae a Claude', () => {
  const f = formularioCuenta('copilot', [claude, copilot({ instalado: false })])
  assert.equal(f.titulo, 'Nueva cuenta de Claude')
  assert.equal(f.mostrarSelector, false)
})

test('Copilot con aviso de PowerShell bloquea con ese motivo', () => {
  const aviso = 'Falta PowerShell 7.'
  assert.equal(formularioCuenta('copilot', [claude, copilot({ aviso })]).bloqueo, aviso)
})

test('Copilot con una cuenta existente bloquea por el tope', () => {
  const f = formularioCuenta('copilot', [claude, copilot()], [{}, { proveedor: 'copilot' }])
  assert.match(f.bloqueo ?? '', /Ya tenés una cuenta de GitHub Copilot/)
  assert.equal(formularioCuenta('copilot', [claude, copilot()], [{}, { proveedor: 'codex' }]).bloqueo, undefined)
})

test('un Copilot viejo avisa cómo actualizarlo', () => {
  assert.equal(formularioCuenta('copilot', [claude, copilot({ versionOk: false })]).avisoVersion, AVISO_COPILOT_VIEJO)
})

test('con ambos instalados hay tres opciones', () => {
  assert.equal(formularioCuenta('claude', [claude, codex(), copilot()]).opciones.length, 3)
})
