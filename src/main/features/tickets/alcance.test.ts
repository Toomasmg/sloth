import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AlcanceLeido, Ticket } from '../../../shared/tickets'
import { conectorPorId } from './conectores'
import type { ConectorMcp } from './conector'
import { alcanceAPedir, conteos, diaDesde, estadosPorDefecto, estadosValidos, fechaValida, filtroDe, leidoTras, mezclar, pendientesDe, personasValidas, sinPendientes, ventanaValida, visibles } from './alcance'

const GRUV = conectorPorId('gruv') as ConectorMcp
const AHORA = Date.parse('2026-11-18T15:00:00Z')
const DIA = 24 * 60 * 60 * 1000
const iso = (diasAtras: number): string => new Date(AHORA - diasAtras * DIA).toISOString()
const YO = { id: 'u-yo', nombre: 'Tomy' }
const t = (id: string, o: Partial<Ticket> = {}): Ticket => ({ id, titulo: id, estado: 'en_curso', ...o })
const mio = (id: string, o: Partial<Ticket> = {}): Ticket => t(id, { responsable: 'Tomy', responsableId: 'u-yo', ...o })
const de = (id: string, persona: string, o: Partial<Ticket> = {}): Ticket => t(id, { responsable: persona, responsableId: `u-${persona}`, ...o })
const F = (o: Parameters<typeof filtroDe>[0] = {}): ReturnType<typeof filtroDe> => filtroDe(o, GRUV)

test('sin elegir, se ve en curso, revisión/QA y terminado, con 4 días', () => {
  assert.deepEqual(estadosPorDefecto(GRUV), ['en_curso', 'en_revision', 'pre_rtd', 'en_qa', 'cerrado'])
  assert.deepEqual(F(), { personasElegidas: [], incluirSinAsignar: false, estadosElegidos: estadosPorDefecto(GRUV), ventanaDias: 4 })
  assert.deepEqual(F({ estadosElegidos: ['bloqueado', 'zzz'], ventanaDias: 9 }).estadosElegidos, ['bloqueado'])
})

test('validaciones: ventana de 1 a 14, personas con la forma del conector y estados conocidos', () => {
  assert.equal(ventanaValida(4), 4)
  for (const mal of [0, 15, 2.5, '4', null, NaN]) assert.equal(ventanaValida(mal), undefined)
  assert.deepEqual(personasValidas(GRUV, ['a-1', 'a-1', 'b']), ['a-1', 'b'])
  assert.equal(personasValidas(GRUV, 'a-1'), null)
  assert.equal(personasValidas(GRUV, ['a b']), null)
  assert.equal(personasValidas(GRUV, ['a"]; rm -rf']), null)
  assert.equal(personasValidas(GRUV, Array.from({ length: 21 }, (_, i) => `p${i}`)), null)
  assert.deepEqual(estadosValidos(['en_qa', 'en_qa'], ['en_qa', 'cerrado']), ['en_qa'])
  assert.equal(estadosValidos(['otro'], ['en_qa']), null)
  assert.equal(estadosValidos([1], ['en_qa']), null)
})

test('fechaValida normaliza a ISO y descarta lo que no es una fecha', () => {
  assert.equal(fechaValida('2026-11-18T13:57:15.236983+00:00'), '2026-11-18T13:57:15.236Z')
  for (const mal of ['mañana', '', 12, null, undefined, 'x'.repeat(50)]) assert.equal(fechaValida(mal), undefined)
  assert.equal(diaDesde(AHORA, 4), '2026-11-14')
})

test('lo propio abierto se ve siempre; lo propio terminado y lo ajeno, solo dentro de la ventana', () => {
  const f = F({ personasElegidas: ['u-Mateo'], estadosElegidos: ['en_curso', 'cerrado'] })
  const ts = [
    mio('M-VIEJO', { fecha: iso(30) }),
    mio('M-CERRADO-VIEJO', { estado: 'cerrado', fecha: iso(10) }),
    mio('M-CERRADO', { estado: 'cerrado', fecha: iso(1) }),
    de('T-VIEJO', 'Mateo', { fecha: iso(6) }),
    de('T-NUEVO', 'Mateo', { fecha: iso(2) }),
    de('T-SIN-FECHA', 'Mateo'),
    de('OTRO', 'Lola', { fecha: iso(1) })
  ]
  assert.deepEqual(visibles(ts, f, YO, GRUV, AHORA).map((x) => x.id), ['M-VIEJO', 'M-CERRADO', 'T-NUEVO', 'T-SIN-FECHA'])
})

test('sin asignar solo si se pide, y el estado filtra', () => {
  const ts = [t('S', { fecha: iso(1) }), mio('M', { estado: 'bloqueado' }), mio('E', { estado: 'en_qa' })]
  assert.deepEqual(visibles(ts, F(), YO, GRUV, AHORA).map((x) => x.id), ['E'])
  assert.deepEqual(visibles(ts, F({ incluirSinAsignar: true }), YO, GRUV, AHORA).map((x) => x.id), ['S', 'E'])
  assert.deepEqual(visibles(ts, F({ estadosElegidos: ['bloqueado'] }), YO, GRUV, AHORA).map((x) => x.id), ['M'])
})

test('sin saber quién sos, solo se ve lo de las personas elegidas', () => {
  const ts = [mio('M'), de('T', 'Mateo')]
  assert.deepEqual(visibles(ts, F({ personasElegidas: ['u-Mateo'] }), undefined, GRUV, AHORA).map((x) => x.id), ['T'])
})

test('conteos por persona, por estado, ocultos y sin fecha', () => {
  const f = F({ personasElegidas: ['u-Mateo'], incluirSinAsignar: true })
  const ts = [mio('A'), mio('B', { estado: 'en_qa', fecha: iso(1) }), de('C', 'Mateo', { fecha: iso(1) }), t('D'), de('E', 'Lola'), de('F', 'Mateo', { estado: 'abierto', fecha: iso(1) })]
  const c = conteos(ts, f, YO, GRUV, AHORA)
  assert.deepEqual(c.porPersona, { 'u-yo': 2, 'u-Mateo': 1, sin_asignar: 1 })
  assert.deepEqual(c.porEstado, { en_curso: 3, en_qa: 1, abierto: 1 })
  assert.equal(c.ocultos, 2)
  assert.equal(c.sinFecha, 2)
})

test('pendientes: todo la primera vez, y después solo lo que se sumó', () => {
  const f = F({ personasElegidas: ['u-Mateo', 'u-yo'], incluirSinAsignar: true })
  assert.deepEqual(pendientesDe(f, undefined, GRUV, YO), { personas: ['u-Mateo'], sinAsignar: true, todo: true })
  const leido: AlcanceLeido = { personas: [], sinAsignar: false, hechos: true, ventanaDias: 4 }
  assert.deepEqual(pendientesDe(f, leido, GRUV, YO), { personas: ['u-Mateo'], sinAsignar: true, todo: false })
  assert.equal(sinPendientes(pendientesDe(F(), leido, GRUV, YO)), true)
  assert.equal(pendientesDe(F({ personasElegidas: ['u-Mateo'] }), { ...leido, personas: ['u-Mateo'] }, GRUV, YO).personas.length, 0)
  assert.equal(pendientesDe(F({ ventanaDias: 7 }), leido, GRUV, YO).todo, true)
  assert.equal(pendientesDe(F({ ventanaDias: 2 }), leido, GRUV, YO).todo, false)
  assert.equal(pendientesDe(F(), { ...leido, hechos: false }, GRUV, YO).todo, true)
  assert.equal(pendientesDe(F({ estadosElegidos: ['en_curso'] }), { ...leido, hechos: false }, GRUV, YO).todo, false)
  assert.equal(pendientesDe(F(), leido, GRUV, undefined).todo, true)
})

test('lo que se pide: solo lo pendiente, o todo si se actualiza', () => {
  const f = F({ personasElegidas: ['u-Mateo', 'u-Lola'], incluirSinAsignar: true })
  const leido: AlcanceLeido = { personas: ['u-Mateo'], sinAsignar: true, hechos: true, ventanaDias: 4 }
  const p = pendientesDe(f, leido, GRUV, YO)
  assert.deepEqual(alcanceAPedir(f, p, GRUV, AHORA, YO, false), { personas: ['u-Lola'], sinAsignar: false, hechos: true, desde: '2026-11-14' })
  assert.deepEqual(alcanceAPedir(f, p, GRUV, AHORA, YO, true), { personas: ['u-Mateo', 'u-Lola'], sinAsignar: true, hechos: true, desde: '2026-11-14' })
  const pedido = alcanceAPedir(f, p, GRUV, AHORA, YO, false)
  assert.deepEqual(leidoTras(f, leido, pedido, false, GRUV), { personas: ['u-Mateo', 'u-Lola'], sinAsignar: true, hechos: true, ventanaDias: 4 })
  assert.deepEqual(leidoTras(f, leido, alcanceAPedir(f, p, GRUV, AHORA, YO, true), true, GRUV).personas, ['u-Mateo', 'u-Lola'])
})

test('mezclar: lo releído reemplaza a lo viejo y lo demás queda', () => {
  const previos = [mio('M1'), de('T1', 'Mateo'), de('L1', 'Lola'), t('S1')]
  const nuevos = [mio('M2'), de('L2', 'Lola')]
  const pedido = { personas: ['u-Lola'], sinAsignar: false, hechos: false, desde: '2026-11-14' }
  assert.deepEqual(mezclar(previos, nuevos, pedido, YO, false).map((x) => x.id), ['T1', 'S1', 'M2', 'L2'])
  assert.deepEqual(mezclar(previos, nuevos, pedido, YO, true).map((x) => x.id), ['M2', 'L2'])
})
