import test from 'node:test'
import assert from 'node:assert/strict'
import type { PerfilesPayload, PerfilVista } from '../../../../shared/perfiles'
import { agruparActividadPorDia, iniciales, mostrarChip, textoActividad, textoConfirmarCambio } from './view'

const vista = (id: string): PerfilVista => ({ id, nombre: id, creado: 0, tieneFoto: false, activo: false })
const payload = (n: number): PerfilesPayload => ({
  perfiles: Array.from({ length: n }, (_, i) => vista('p' + i)),
  activo: 'p0',
  ajenas: { cantidad: 0 },
  modoRaiz: false,
  terminalesVivas: 0,
  puedeConservarTerminales: true
})

test('iniciales', () => {
  assert.equal(iniciales('Mi perfil'), 'MP')
  assert.equal(iniciales('Trabajo'), 'T')
  assert.equal(iniciales('  ana   maría  luz '), 'AM')
  assert.equal(iniciales('émile'), 'É')
  assert.equal(iniciales('   '), '?')
  assert.equal(iniciales(''), '?')
})

test('mostrarChip solo con 2 o más perfiles', () => {
  assert.equal(mostrarChip(null), false)
  assert.equal(mostrarChip(payload(0)), false)
  assert.equal(mostrarChip(payload(1)), false)
  assert.equal(mostrarChip(payload(2)), true)
})

test('textoActividad por tipo', () => {
  assert.equal(textoActividad({ t: 1, tipo: 'espacio', espacio: 'web' }), 'Abriste el espacio «web»')
  assert.equal(textoActividad({ t: 1, tipo: 'ticket', ticket: 'ABC-1', espacio: 'web' }), 'Tomaste el ticket ABC-1 en «web»')
  assert.equal(textoActividad({ t: 1, tipo: 'ticket', ticket: 'ABC-1' }), 'Tomaste el ticket ABC-1')
  assert.equal(textoActividad({ t: 1, tipo: 'pr', pr: '42' }), 'Creaste el PR 42')
  assert.equal(textoActividad({ t: 1, tipo: 'pr', pr: '#42' }), 'Creaste el PR 42')
  assert.equal(textoActividad({ t: 1, tipo: 'pr' }), 'Creaste un PR')
})

test('agrupación por día con medianoche local', () => {
  const ahora = new Date(2026, 5, 10, 0, 30).getTime()
  const e = (t: number) => ({ t, tipo: 'espacio' as const, espacio: 'x' })
  const g = agruparActividadPorDia(
    [e(new Date(2026, 5, 10, 0, 5).getTime()), e(new Date(2026, 5, 9, 23, 59).getTime()), e(new Date(2026, 5, 9, 8).getTime()), e(new Date(2026, 4, 3, 12).getTime())],
    ahora
  )
  assert.deepEqual(g.map((x) => [x.dia, x.items.length]), [['Hoy', 1], ['Ayer', 2], ['03/05', 1]])
  assert.deepEqual(agruparActividadPorDia([], ahora), [])
})

test('confirmación del cambio', () => {
  assert.equal(textoConfirmarCambio('Trabajo', true, 0), 'Sloth se reinicia y abre «Trabajo».')
  assert.match(textoConfirmarCambio('Trabajo', true, 3), /Las 3 terminales de este perfil siguen abiertas en segundo plano\. Podés cerrarlas desde Perfiles\./)
  assert.match(textoConfirmarCambio('Trabajo', false, 2), /Las 2 terminales de este perfil se cierran/)
  assert.match(textoConfirmarCambio('Trabajo', true, 1), /La terminal de este perfil sigue abierta/)
})
