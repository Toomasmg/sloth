import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConectorInvalidoError, nombreCompleto, regexDeId, regexDePersona, validarConector, type ConectorMcp } from './conector'
import { CONECTORES, conectorPorId } from './conectores'
import github from './conectores/github'
import gruv from './conectores/gruv'

const BORRAR = Symbol('borrar')

/** Copia de Gruv con un valor cambiado en `ruta` (a.b.0.c); BORRAR saca la clave. */
function con(ruta: string, valor: unknown): unknown {
  const d: unknown = structuredClone(gruv)
  const partes = ruta.split('.')
  let o = d as Record<string, unknown>
  for (const p of partes.slice(0, -1)) o = o[p] as Record<string, unknown>
  const ultima = partes[partes.length - 1]
  if (valor === BORRAR) delete o[ultima]
  else o[ultima] = valor
  return d
}

function rechaza(raw: unknown, motivo: RegExp): void {
  assert.throws(
    () => validarConector(raw),
    (e: unknown) => e instanceof ConectorInvalidoError && motivo.test(e.message)
  )
}

test('Gruv valida y la copia es nueva, igual e idempotente', () => {
  const def = validarConector(gruv)
  assert.deepEqual(def, gruv)
  assert.notEqual(def, gruv)
  assert.notEqual(def.herramientas.lista, gruv.herramientas.lista)
  assert.deepEqual(validarConector(JSON.parse(JSON.stringify(gruv))), def)
  assert.deepEqual(validarConector(def), def)
  def.estados.pop()
  assert.equal(gruv.estados.length, 8)
})

test('el registro trae Gruv y GitHub validados', () => {
  assert.deepEqual(CONECTORES.slice(0, 2).map((c) => c.id), ['gruv', 'github'])
  assert.deepEqual(conectorPorId('github'), github)
  assert.deepEqual(conectorPorId('gruv'), gruv)
  assert.equal(conectorPorId('trello'), undefined)
})

test('regexDeId se compila una vez y una alternancia no desancla', () => {
  const def = validarConector(gruv)
  assert.equal(regexDeId(def), regexDeId(def))
  const alt = validarConector(con('idRegex', '^TCK-\\d+|B-\\d+$'))
  assert.equal(regexDeId(alt).test('TCK-1'), true)
  assert.equal(regexDeId(alt).test('TCK-1xx'), false)
  assert.equal(regexDeId(alt).test('xxB-1'), false)
  assert.equal(nombreCompleto(def as ConectorMcp, 'ver_reloj'), 'mcp__claude_ai_Gruv__ver_reloj')
})

const RECHAZOS: Array<[string, unknown, RegExp]> = [
  ['raíz que no es objeto', [], /tiene que ser un objeto/],
  ['función', con('nombre', () => 'Gruv'), /function no permitido/],
  ['símbolo', con('nombre', Symbol('x')), /symbol no permitido/],
  ['clave símbolo', con('ejemplo', { [Symbol('x')]: 1 }), /claves símbolo/],
  ['undefined', con('pistas.estados', undefined), /undefined no permitido/],
  ['NaN', con('pistas.acciones.horas.args.minutos', Number.NaN), /no finito/],
  ['Infinity', con('pistas.acciones.horas.args.minutos', Infinity), /no finito/],
  ['Date', con('ejemplo', new Date(0)), /no es plano/],
  ['Map', con('herramientas.escritura', new Map()), /no es plano/],
  ['demasiado anidado', con('pistas.acciones.horas.args.minutos', { a: { b: { c: 1 } } }), /niveles/],
  ['más de 64 KB', con('herramientas.negar', Array.from({ length: 3000 }, (_, i) => `herramienta_${i}_${'x'.repeat(20)}`)), /64 KB/],
  ['clave desconocida arriba', con('extra', 1), /conector\.extra: clave desconocida/],
  ['clave desconocida adentro', con('pistas.yo.otro', 'x'), /pistas\.yo\.otro: clave desconocida/],
  ['vía desconocida', con('via', 'jira'), /conector.via: vía no soportada/],
  ['vía gh con herramientas', con('via', 'gh'), /conector.herramientas: clave desconocida/],
  ['falta una clave', con('faltaConector', BORRAR), /faltaConector: falta/],
  ['id de conector', con('id', 'Gruv'), /conector\.id: tiene un formato inválido/],
  ['nombre con símbolos', con('nombre', 'Gr<uv>'), /conector\.nombre: tiene un formato inválido/],
  ['booleano', con('verificado', 'si'), /true o false/],
  ['salto de línea en una pista', con('pistas.lista', 'a\nb'), /control o saltos de línea/],
  ['pista larga', con('pistas.lista', 'x'.repeat(1001)), /más de 1000 caracteres/],
  ['comillas en el ejemplo', con('ejemplo.proyecto', 'a"b'), /ejemplo\.proyecto: tiene un formato inválido/],
  ['llave en un nombre de estado', con('estados.0.nombre', 'A{b}'), /estados\[0\]\.nombre/],
  ['clave de estado', con('estados.0.clave', 'Abierto'), /estados\[0\]\.clave/],
  ['categoría', con('estados.0.categoria', 'cerrado'), /estados\[0\]\.categoria/],
  ['estado repetido', con('estados.1.clave', 'abierto'), /«abierto» está repetido/],
  ['sin estados', con('estados', []), /entre 1 y 30/],
  ['todos hecho', con('estados', [{ clave: 'cerrado', nombre: 'Cerrado', categoria: 'hecho' }]), /al menos uno que no sea 'hecho'/],
  ['clave de faltaConector', con('faltaConector.clave', 'X'), /faltaConector\.clave/],
  ['mensaje largo', con('faltaConector.mensaje', 'x'.repeat(301)), /más de 300/],
  ['prefijo', con('herramientas.prefijo', 'mcp__Gruv_'), /prefijo: tiene un formato inválido/],
  ['nombre de herramienta', con('herramientas.lista.0', 'listar tickets'), /lista\[0\]: tiene un formato inválido/],
  ['herramienta repetida', con('herramientas.lista', ['listar_tickets', 'listar_tickets']), /repetido/],
  ['lista vacía', con('herramientas.lista', []), /entre 1 y 20/],
  ['lectura negada', con('herramientas.negar', ['listar_tickets']), /«listar_tickets» no puede ser de lectura/],
  ['lectura que escribe', con('herramientas.escritura.comentar', 'ver_reloj'), /«ver_reloj» no puede ser de lectura/],
  ['acción desconocida', con('herramientas.escritura.borrar', 'borrar_ticket'), /escritura\.borrar: clave desconocida/],
  ['criterio sin detalle', { ...(con('herramientas.detalle', []) as object), pistas: { ...gruv.pistas, detalle: [] } }, /tildar criterios necesita/],
  ['pasos sin herramientas de detalle', con('pistas.detalle', []), /pasos de detalle/],
  ['paso con herramienta ajena', con('pistas.detalle.0.herramienta', 'listar_tickets'), /no está en herramientas\.detalle/],
  ['placeholder ajeno en el detalle', con('pistas.detalle.0.args.id', '{estado}'), /solo admite \{ticket\}/],
  ['sin argumentos', con('pistas.acciones.estado.args', {}), /entre 1 y 10 argumentos/],
  ['nombre de argumento', con('pistas.acciones.estado.args', { Id: '{ticket}' }), /nombre de argumento inválido/],
  ['argumento objeto', con('pistas.acciones.estado.args.id', ['x']), /texto no vacío/],
  ['placeholder de otra acción', con('pistas.acciones.estado.args.id', '{cuerpo}'), /solo admite \{ticket\}, \{estado\}/],
  ['placeholder a medias', con('pistas.acciones.estado.args.id', 'TCK {ticket}'), /como valor completo/],
  ['nota con otra llave', con('pistas.acciones.estado.nota', 'Para {persona}'), /nota: solo admite \{ticket\}, \{estado\}/],
  ['nota de comentar con {estado}', con('pistas.acciones.comentar.nota', 'Pasalo a {estado}'), /comentar\.nota: solo admite \{ticket\}, \{cuerpo\}/],
  ['personaId sin anclar', con('personaId', '[a-z]+'), /personaId: tiene que estar anclada/],
  ['apoyo negado', con('herramientas.apoyo', ['mover_ticket']), /«mover_ticket» no puede ser de apoyo/],
  ['apoyo que escribe', con('herramientas.apoyo', ['sumar_al_reloj']), /«sumar_al_reloj» no puede ser de apoyo/],
  ['pista de apoyo sin herramientas', con('pistas.apoyo', 'Antes mirá el ticket {ticket}.'), /pistas\.apoyo: la pista de apoyo/],
  ['herramientas de apoyo sin pista', con('herramientas.apoyo', ['ver_mi_inicio']), /pistas\.apoyo: la pista de apoyo/],
  ['pista de apoyo con otra llave', { ...(con('herramientas.apoyo', ['ver_mi_inicio']) as object), pistas: { ...gruv.pistas, apoyo: 'Para {estado}' } }, /pistas\.apoyo: solo admite \{ticket\}/],
  ['args anidados de más', con('pistas.acciones.tomar.args', { id: '{ticket}', a: { b: { c: { d: '{persona}' } } } }), /niveles/],
  ['placeholder ajeno anidado', con('pistas.acciones.tomar.args', { id: '{ticket}', a: { b: '{cuerpo}' } }), /tomar\.args\.a\.b: solo admite/],
  ['lista en los args', con('pistas.acciones.tomar.args', { id: '{ticket}', a: { b: ['x'] } }), /texto no vacío/],
  ['pista de acción que falta', con('pistas.acciones.comentar', BORRAR), /acciones\.comentar: falta/],
  ['pista de acción sin herramienta', con('herramientas.escritura.comentar', BORRAR), /acciones\.comentar: clave desconocida/],
  ['conId sin {id}', con('pistas.yo.conId', 'Tu id es fijo.'), /una sola vez/],
  ['conId con dos {id}', con('pistas.yo.conId', '{id} y {id}'), /una sola vez/],
  ['regex sin ^', con('idRegex', '[A-Z]+-\\d+$'), /anclada/],
  ['regex con $ escapado', con('idRegex', '^[A-Z]+-\\d+\\$'), /anclada/],
  ['grupo cuantificado', con('idRegex', '^(A+)+-\\d$'), /grupos cuantificados/],
  ['referencia hacia atrás', con('idRegex', '^(A)\\1-\\d$'), /referencias hacia atrás/],
  ['lookaround', con('idRegex', '^(?=A)A-\\d$'), /lookarounds/],
  ['regex que no compila', con('idRegex', '^[A-$'), /no compila/],
  ['ejemplo en minúsculas', con('ejemplo.id', 'tck-1234'), /ejemplo\.id: no cumple idRegex/],
  ['ejemplo largo', con('ejemplo.id', 'ABCDEFGHIJKLMNOP-1234'), /ejemplo\.id: no cumple idRegex/],
  ['ejemplo de estado', con('ejemplo.estado', 'hecho'), /ningún estado/]
]

for (const [nombre, raw, motivo] of RECHAZOS) test(`rechaza: ${nombre}`, () => rechaza(raw, motivo))

test('la ruta del error queda en el error', () => {
  try {
    validarConector(con('herramientas.lista.1', 'x y'))
    assert.fail('tenía que tirar')
  } catch (e) {
    assert.ok(e instanceof ConectorInvalidoError)
    assert.equal(e.ruta, 'conector.herramientas.lista[1]')
  }
})

/** Copia de GitHub con una clave cambiada arriba. */
const gh = (cambio: Record<string, unknown>): unknown => ({ ...structuredClone(github), ...cambio })

test('GitHub valida y no lleva herramientas ni pistas', () => {
  assert.deepEqual(validarConector(github), github)
  rechaza(gh({ pistas: {} }), /conector\.pistas: clave desconocida/)
})

test('GitHub solo admite los estados que gh sabe mover', () => {
  rechaza(gh({ estados: [...github.estados, { clave: 'en_curso', nombre: 'En curso', categoria: 'en_curso' }] }), /estados\[2\]\.clave: con gh/)
  rechaza(gh({ estados: [{ clave: 'cerrado', nombre: 'Cerrado', categoria: 'pendiente' }], ejemplo: { ...github.ejemplo, estado: 'cerrado' } }), /hace falta el estado 'abierto'/)
})

test('acepta args anidados, notas con placeholders de la acción, apoyo y personaId', () => {
  const d = structuredClone(gruv) as unknown as ConectorMcp
  d.personaId = '^[A-Za-z0-9:-]{1,128}$'
  d.herramientas.apoyo = ['ver_mi_inicio', 'buscar_persona']
  d.pistas.apoyo = 'Mirá antes el ticket {ticket}.'
  d.pistas.acciones.tomar = { args: { id: '{ticket}', campos: { responsable: { id: '{persona}' } } }, nota: 'Para {persona} en {ticket}.' }
  d.pistas.acciones.estado = { args: { id: '{ticket}', estado: '{estado}' }, nota: 'Al estado {estado}.' }
  assert.deepEqual(validarConector(d), d)
})

/** Copia de Gruv con apoyo general y `apoyoEn` en las herramientas. */
function conApoyoEn(apoyoEn: unknown, pista = true): unknown {
  const d = con('herramientas.apoyoEn', apoyoEn) as ConectorMcp
  d.herramientas.apoyo = ['ver_mi_inicio']
  if (pista) d.pistas.apoyo = 'Mirá antes el ticket {ticket}.'
  else delete d.herramientas.apoyo
  return d
}

test('apoyoEn: herramientas de lectura solo para una acción', () => {
  const d = conApoyoEn({ estado: ['buscar_persona'] }) as ConectorMcp
  assert.deepEqual(validarConector(d), d)
  rechaza(conApoyoEn({ estado: ['mover_ticket'] }), /«mover_ticket» no puede ser de apoyo/)
  rechaza(conApoyoEn({ borrar: ['buscar_persona'] }), /apoyoEn\.borrar: clave desconocida/)
  rechaza(conApoyoEn({ estado: [] }), /apoyoEn\.estado/)
  rechaza(conApoyoEn({ estado: ['buscar_persona'] }, false), /apoyoEn: necesita la pista de apoyo/)
})

test('regexDePersona: la del conector, cacheada, o la de siempre', () => {
  assert.equal(regexDePersona(validarConector(gruv)).test('a1-b'), true)
  assert.equal(regexDePersona(validarConector(gruv)).test('557058:abc'), false)
  const d = validarConector({ ...structuredClone(gruv), personaId: '^[a-z]+|[0-9]+$' })
  assert.equal(regexDePersona(d), regexDePersona(d))
  assert.equal(regexDePersona(d).test('abc'), true)
  assert.equal(regexDePersona(d).test('abc1'), false)
})
