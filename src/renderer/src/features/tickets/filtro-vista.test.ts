import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Estado, FiltroVista, PersonaEquipo, Ticket } from '../../../../shared/tickets'
import gruv from '../../../../main/features/tickets/conectores/gruv'
import {
  alternarAtajo,
  alternarEstado,
  alternarPersona,
  atajoActivo,
  atajosDe,
  filtrarPersonas,
  grupoDe,
  gruposDe,
  hayFaltante,
  nombreSeguro,
  opcionesVentana,
  ordenarPorGrupo,
  resumenFiltro,
  textoFaltante
} from './filtro-vista'

const ESTADOS: Estado[] = gruv.estados
const YO = { id: 'u-yo', nombre: 'Tomás' }
const PERSONAS: PersonaEquipo[] = [
  { id: 'u-yo', nombre: 'Tomás' },
  { id: 'u-mateo', nombre: 'Mateo Rossi' },
  { id: 'u-jose', nombre: 'José Álvarez' },
  { id: 'u-lola', nombre: 'Lola Gómez' }
]
const F = (p: Partial<FiltroVista> = {}): FiltroVista => ({ personasElegidas: [], incluirSinAsignar: false, estadosElegidos: ['en_curso', 'en_revision', 'pre_rtd', 'en_qa', 'cerrado'], ventanaDias: 4, ...p })
const T = (id: string, responsable?: string, responsableId?: string): Ticket => ({ id, titulo: id, estado: 'en_curso', responsable, responsableId })

test('los atajos salen de las categorías del conector y no de nombres fijos', () => {
  const a = atajosDe(ESTADOS)
  assert.deepEqual(a.map((x) => x.id), ['en_curso', 'revision', 'hecho'])
  assert.deepEqual(a.find((x) => x.id === 'revision')?.claves, ['en_revision', 'pre_rtd', 'en_qa'])
  assert.deepEqual(a.find((x) => x.id === 'hecho')?.claves, ['cerrado'])
  const otro: Estado[] = [{ clave: 'doing', nombre: 'Haciendo', categoria: 'en_curso' }]
  assert.deepEqual(atajosDe(otro).map((x) => [x.id, x.claves]), [['en_curso', ['doing']]])
})

test('un atajo prende o apaga todos sus estados y no deja el filtro vacío', () => {
  const [curso, revision, hecho] = atajosDe(ESTADOS)
  assert.equal(atajoActivo(revision!, ['en_qa']), false)
  assert.deepEqual(alternarAtajo(revision!, ['en_curso']), ['en_curso', 'en_revision', 'pre_rtd', 'en_qa'])
  assert.deepEqual(alternarAtajo(revision!, ['en_curso', 'en_revision', 'pre_rtd', 'en_qa']), ['en_curso'])
  assert.deepEqual(alternarAtajo(hecho!, ['en_curso']), ['en_curso', 'cerrado'])
  assert.equal(alternarAtajo(curso!, ['en_curso']), null)
  assert.deepEqual(alternarEstado('bloqueado', ['en_curso']), ['en_curso', 'bloqueado'])
  assert.equal(alternarEstado('en_curso', ['en_curso']), null)
})

test('«yo» no se elige ni se saca, y hay un tope de personas', () => {
  assert.deepEqual(alternarPersona('u-yo', ['u-mateo'], YO), { ok: true, ids: ['u-mateo'] })
  assert.deepEqual(alternarPersona('u-lola', ['u-mateo'], YO), { ok: true, ids: ['u-mateo', 'u-lola'] })
  assert.deepEqual(alternarPersona('u-mateo', ['u-mateo', 'u-lola'], YO), { ok: true, ids: ['u-lola'] })
  const veinte = Array.from({ length: 20 }, (_, i) => `u-${i}`)
  assert.equal(alternarPersona('u-nuevo', veinte, YO).ok, false)
  assert.equal(alternarPersona('u-5', veinte, YO).ok, true)
})

test('buscar persona ignora tildes y mayúsculas, deja afuera a «yo» y pone primero a las elegidas', () => {
  assert.deepEqual(filtrarPersonas(PERSONAS, 'JOSE', [], YO).lista.map((p) => p.id), ['u-jose'])
  assert.deepEqual(filtrarPersonas(PERSONAS, '  gomez ', [], YO).lista.map((p) => p.id), ['u-lola'])
  assert.deepEqual(filtrarPersonas(PERSONAS, '', ['u-lola'], YO).lista.map((p) => p.id), ['u-lola', 'u-mateo', 'u-jose'])
  assert.deepEqual(filtrarPersonas(PERSONAS, 'zzz', [], YO), { lista: [], total: 0 })
  const muchas = Array.from({ length: 300 }, (_, i) => ({ id: `u-${i}`, nombre: `Persona ${i}` }))
  const r = filtrarPersonas(muchas, 'persona', [], undefined)
  assert.equal(r.lista.length, 120)
  assert.equal(r.total, 300)
})

test('los nombres de afuera se muestran de una línea, sin caracteres de control ni de dirección y acotados', () => {
  assert.equal(nombreSeguro('  Ana\n\tPérez‮  '), 'Ana Pérez')
  assert.equal(nombreSeguro('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>')
  const largo = nombreSeguro('x'.repeat(200))
  assert.equal(largo.length, 60)
  assert.ok(largo.endsWith('…'))
})

test('grupos: míos arriba, las elegidas en su orden y sin asignar solo si se pidió', () => {
  const ts = [T('A', 'Tomás', 'u-yo'), T('B', 'Lola Gómez', 'u-lola'), T('C', 'Lola Gómez', 'u-lola'), T('D'), T('E', 'Mateo Rossi', 'u-mateo')]
  const f = F({ personasElegidas: ['u-mateo', 'u-lola'] })
  const g = gruposDe(f, PERSONAS, YO, ts, { personas: ['u-mateo'], sinAsignar: false, todo: false })
  assert.deepEqual(g.map((x) => [x.clave, x.nombre, x.n, x.sinTraer]), [['mios', 'Míos', 1, false], ['u-mateo', 'Mateo Rossi', 1, true], ['u-lola', 'Lola Gómez', 2, false]])
  const todo = gruposDe(f, PERSONAS, YO, ts, { personas: ['u-mateo', 'u-lola'], sinAsignar: false, todo: true })
  assert.equal(todo.some((x) => x.sinTraer), false)
  const con = gruposDe({ ...f, incluirSinAsignar: true }, PERSONAS, YO, ts, undefined)
  assert.deepEqual(con.at(-1), { clave: 'sin_asignar', nombre: 'Sin asignar', tipo: 'sin', n: 1, sinTraer: false })
})

test('un grupo sin la lista de personas toma el nombre del ticket, y sin nada, un nombre neutro', () => {
  const f = F({ personasElegidas: ['u-mateo', 'u-x'] })
  const g = gruposDe(f, undefined, YO, [T('E', 'Mateo Rossi', 'u-mateo')], undefined)
  assert.deepEqual(g.map((x) => x.nombre), ['Míos', 'Mateo Rossi', 'Persona sin nombre'])
})

test('grupoDe y el orden por grupo', () => {
  assert.equal(grupoDe(T('A', 'Tomás', 'u-yo'), YO), 'mios')
  assert.equal(grupoDe(T('A', 'tomas'), { nombre: 'Tomás' }), 'mios')
  assert.equal(grupoDe(T('A'), YO), 'sin_asignar')
  assert.equal(grupoDe(T('A', 'Ana Pérez'), YO), 'n:ana perez')
  const ts = [T('1', 'Lola', 'u-lola'), T('2'), T('3', 'Tomás', 'u-yo'), T('4', 'Lola', 'u-lola'), T('5', 'Mateo', 'u-mateo')]
  const g = gruposDe(F({ personasElegidas: ['u-mateo', 'u-lola'], incluirSinAsignar: true }), PERSONAS, YO, ts, undefined)
  assert.deepEqual(ordenarPorGrupo(ts, g, YO).map((t) => t.id), ['3', '5', '1', '4', '2'])
})

test('el resumen de una línea dice quiénes, qué estados y cuántos días de terminados', () => {
  assert.equal(resumenFiltro(F(), PERSONAS, ESTADOS), 'vos · En curso, Revisión / QA, Terminado · terminados de los últimos 4 días')
  assert.equal(
    resumenFiltro(F({ personasElegidas: ['u-mateo'], incluirSinAsignar: true, estadosElegidos: ['en_curso', 'bloqueado'], ventanaDias: 1 }), PERSONAS, ESTADOS),
    'vos, Mateo Rossi, sin asignar · En curso, Bloqueado'
  )
  assert.match(resumenFiltro(F({ personasElegidas: ['u-mateo', 'u-lola', 'u-jose'] }), PERSONAS, ESTADOS), /^vos, Mateo Rossi, 2 más ·/)
  assert.match(resumenFiltro(F({ estadosElegidos: ['en_qa', 'abierto', 'bloqueado', 'rechazado'] }), PERSONAS, ESTADOS), /En QA, Abierto, Bloqueado y 1 más$/)
  assert.match(resumenFiltro(F({ ventanaDias: 1 }), PERSONAS, ESTADOS), /último 1 día$|últimos 1 día$/)
})

test('lo que falta traer se dice en una frase y se detecta', () => {
  const f = F({ personasElegidas: ['u-mateo', 'u-lola'], incluirSinAsignar: true })
  assert.equal(hayFaltante(undefined), false)
  assert.equal(hayFaltante({ personas: [], sinAsignar: false, todo: false }), false)
  assert.equal(hayFaltante({ personas: ['u-lola'], sinAsignar: false, todo: false }), true)
  assert.equal(textoFaltante({ personas: ['u-lola'], sinAsignar: false, todo: false }, f, PERSONAS), 'Todavía no se trajeron los tickets de Lola Gómez.')
  assert.equal(textoFaltante({ personas: ['u-lola', 'u-mateo'], sinAsignar: true, todo: false }, f, PERSONAS), 'Todavía no se trajeron los tickets de 2 personas ni de los sin asignar.')
  assert.match(textoFaltante({ personas: [], sinAsignar: false, todo: true }, f, PERSONAS), /^Cambió lo que se pide/)
})

test('las opciones de ventana incluyen la que ya está guardada', () => {
  assert.deepEqual(opcionesVentana(4), [1, 2, 4, 7, 14])
  assert.deepEqual(opcionesVentana(3), [1, 2, 3, 4, 7, 14])
})
