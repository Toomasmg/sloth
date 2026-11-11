import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Detalle, Ticket } from '../../../shared/tickets'
import { aplicarAccion, entradaDeAccion, esAccion, esMio, MAX_HORAS, texto, textoObligatorio, ticketId, type Contexto } from './acciones'
import { validarConector } from './conector'
import gruv from './conectores/gruv'
import { estadosPorDefecto } from './motor'

const GRUV = validarConector(gruv)
const CRIT = '0f8c12ab-0000-4000-8000-000000000001'
const ME = { id: 'u-1', nombre: 'Tomy' }
const detalle = (): Detalle => ({ criterios: [{ id: CRIT, texto: 'Anda', hecho: false }], comentarios: [], minutos: 30 })
const ctx = (o: Partial<Contexto> = {}): Contexto => ({ estados: estadosPorDefecto(GRUV), me: ME, detalle: detalle(), ...o })
const libre = (): Ticket => ({ id: 'TCK-1', titulo: 'Uno', estado: 'abierto' })
const mio = (): Ticket => ({ ...libre(), responsable: 'Tomy', responsableId: 'u-1' })
const falla = (fn: () => unknown, msg: string): void => assert.throws(fn, { message: msg })

test('esAccion solo acepta las seis acciones', () => {
  for (const a of ['estado', 'tomar', 'soltar', 'comentar', 'criterio', 'horas']) assert.ok(esAccion(a))
  for (const a of ['borrar', '', 3, null, 'ESTADO']) assert.equal(esAccion(a), false)
})

test('ticketId normaliza y explica con el ejemplo del conector', () => {
  assert.equal(ticketId(GRUV, ' tck-12 '), 'TCK-12')
  for (const v of ['TCK', 12, null, 'TCK-1'.padEnd(21, '1')]) falla(() => ticketId(GRUV, v), 'El ticket tiene que ser tipo TCK-1234.')
})

test('texto colapsa espacios y valida largo y tipo', () => {
  assert.equal(texto('  a \n b  ', 10, 'X'), 'a b')
  assert.equal(texto('', 10, 'X'), undefined)
  assert.equal(texto(null, 10, 'X'), undefined)
  assert.equal(texto('   ', 10, 'X'), undefined)
  falla(() => texto(3, 10, 'X'), 'X no es válido.')
  falla(() => texto('abcdef', 5, 'X'), 'X es demasiado largo (máx. 5).')
  falla(() => textoObligatorio('  ', 5, 'X'), 'Falta X.')
  assert.equal(textoObligatorio(' hola ', 5, 'X'), 'hola')
})

test('esMio compara por id si hay, si no por nombre', () => {
  assert.equal(esMio(ME, mio()), true)
  assert.equal(esMio(ME, { ...mio(), responsableId: 'u-2' }), false)
  assert.equal(esMio({ nombre: ' tomy ' }, { ...libre(), responsable: 'Tomy' }), true)
  assert.equal(esMio(undefined, mio()), false)
  assert.equal(esMio(ME, libre()), false)
})

test('estado: solo columnas del flujo y nunca las ocultas', () => {
  assert.deepEqual(entradaDeAccion(GRUV, 'estado', libre(), { estado: 'en_qa' }, ctx()), { ticket: 'TCK-1', estado: 'en_qa' })
  assert.equal(entradaDeAccion(GRUV, 'estado', libre(), { estado: 'abierto' }, ctx()), null)
  for (const estado of ['cerrado', 'inventado', 3, undefined])
    falla(() => entradaDeAccion(GRUV, 'estado', libre(), { estado }, ctx()), 'Ese estado no está en el flujo de Gruv.')
  const conCerrado = ctx({ estados: [...estadosPorDefecto(GRUV), { clave: 'cerrado', nombre: 'Cerrado' }] })
  falla(() => entradaDeAccion(GRUV, 'estado', libre(), { estado: 'cerrado' }, conCerrado), 'Ese estado no está en el flujo de Gruv.')
})

test('tomar y soltar', () => {
  assert.deepEqual(entradaDeAccion(GRUV, 'tomar', libre(), {}, ctx()), { ticket: 'TCK-1', persona: 'u-1' })
  falla(() => entradaDeAccion(GRUV, 'tomar', { ...libre(), responsable: 'Ana' }, {}, ctx()), 'Ya lo tiene Ana.')
  falla(() => entradaDeAccion(GRUV, 'tomar', libre(), {}, ctx({ me: { nombre: 'Tomy' } })), 'Falta tu id de Gruv: actualizá la lista para cargarlo.')
  assert.deepEqual(entradaDeAccion(GRUV, 'soltar', mio(), null, ctx()), { ticket: 'TCK-1', persona: null })
  falla(() => entradaDeAccion(GRUV, 'soltar', { ...libre(), responsable: 'Ana' }, {}, ctx()), 'Solo podés soltar un ticket que tenés asignado.')
})

test('comentar, criterio y horas', () => {
  assert.deepEqual(entradaDeAccion(GRUV, 'comentar', libre(), { cuerpo: ' hola\n che ' }, ctx()), { ticket: 'TCK-1', cuerpo: 'hola che' })
  falla(() => entradaDeAccion(GRUV, 'comentar', libre(), { cuerpo: '' }, ctx()), 'Falta El comentario.')
  falla(() => entradaDeAccion(GRUV, 'comentar', libre(), { cuerpo: 'x'.repeat(2001) }, ctx()), 'El comentario es demasiado largo (máx. 2000).')
  assert.deepEqual(entradaDeAccion(GRUV, 'criterio', libre(), { criterioId: CRIT, hecho: true }, ctx()), { ticket: 'TCK-1', criterioId: CRIT, hecho: true })
  assert.deepEqual(entradaDeAccion(GRUV, 'criterio', libre(), { criterioId: CRIT, hecho: 'si' }, ctx()), { ticket: 'TCK-1', criterioId: CRIT, hecho: false })
  for (const c of [ctx({ detalle: undefined }), ctx()])
    falla(() => entradaDeAccion(GRUV, 'criterio', libre(), { criterioId: 'otro' }, c), 'Abrí el ticket de nuevo: no encuentro ese criterio.')
  assert.deepEqual(entradaDeAccion(GRUV, 'horas', libre(), { horas: 1.5 }, ctx()), { ticket: 'TCK-1', minutos: 90, motivo: 'Horas cargadas desde Sloth' })
  for (const horas of [0, -1, MAX_HORAS + 0.1, 0.001, NaN, Infinity, '2'])
    falla(() => entradaDeAccion(GRUV, 'horas', libre(), { horas }, ctx()), 'Las horas tienen que ser más de 0 y hasta 12.')
})

test('aplicarAccion deja el ticket y el detalle como quedaron en el conector', () => {
  const fecha = '2026-11-11T12:00:00.000Z'
  const t = libre()
  aplicarAccion('estado', t, { ticket: 'TCK-1', estado: 'en_qa' }, { fecha })
  aplicarAccion('tomar', t, { ticket: 'TCK-1', persona: 'u-1' }, { me: ME, fecha })
  assert.deepEqual(t, { ...libre(), estado: 'en_qa', responsable: 'Tomy', responsableId: 'u-1' })
  aplicarAccion('soltar', t, { ticket: 'TCK-1', persona: null }, { fecha })
  assert.deepEqual(t, { ...libre(), estado: 'en_qa' })

  const d = detalle()
  aplicarAccion('comentar', t, { ticket: 'TCK-1', cuerpo: 'hola' }, { detalle: d, fecha })
  aplicarAccion('criterio', t, { ticket: 'TCK-1', criterioId: CRIT, hecho: true }, { detalle: d, fecha })
  aplicarAccion('horas', t, { ticket: 'TCK-1', minutos: 60 }, { detalle: d, fecha })
  assert.deepEqual(d, { criterios: [{ id: CRIT, texto: 'Anda', hecho: true }], comentarios: [{ autor: 'Vos', cuerpo: 'hola', fecha }], minutos: 90 })
  assert.deepEqual(t.criterios, d.criterios)
  assert.notEqual(t.criterios?.[0], d.criterios[0])
  aplicarAccion('horas', t, { ticket: 'TCK-1', minutos: 60 }, { detalle: d, minutosTotal: 200, fecha })
  assert.equal(d.minutos, 200)
  const sinRegistro: Detalle = { ...detalle(), minutos: null }
  aplicarAccion('horas', t, { ticket: 'TCK-1', minutos: 15 }, { detalle: sinRegistro, fecha })
  assert.equal(sinRegistro.minutos, 15)
})

test('aplicarAccion sin detalle cargado no rompe', () => {
  const t = libre()
  for (const a of ['comentar', 'criterio', 'horas'] as const) aplicarAccion(a, t, { ticket: 'TCK-1', cuerpo: 'x', criterioId: CRIT, minutos: 5 }, { fecha: '' })
  assert.deepEqual(t, libre())
})
