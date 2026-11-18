import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AVISO_CODEX_VIEJO, filasLimites, formularioCuenta } from './agente-form'
import type { AgenteDisponible } from '../../../../shared/types'

const claude: AgenteDisponible = { id: 'claude', nombre: 'Claude Code', instalado: true }
const codex = (extra: Partial<AgenteDisponible> = {}): AgenteDisponible => ({ id: 'codex', nombre: 'Codex', instalado: true, versionOk: true, ...extra })

test('sin Codex instalado no hay selector y el formulario es el de Claude', () => {
  const f = formularioCuenta('claude', [claude, codex({ instalado: false })])
  assert.deepEqual(f, { titulo: 'Nueva cuenta de Claude', mostrarSelector: false, mostrarPlan: true })
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
    { nombre: '5 h', valor: '37 %' },
    { nombre: 'Semana', valor: '12 %' }
  ])
  assert.deepEqual(filasLimites({ cincoHoras: null, semana: v(0), at: 1 }), [{ nombre: 'Semana', valor: '0 %' }])
  assert.deepEqual(filasLimites({ cincoHoras: null, semana: null, at: 1 }), [])
  assert.deepEqual(filasLimites(null), [])
  assert.deepEqual(filasLimites(undefined), [])
})
