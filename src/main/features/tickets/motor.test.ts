import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Accion } from '../../../shared/tickets'
import { ACCIONES_GH, nombreCompleto, validarConector, type ConectorMcp } from './conector'
import { CONECTORES } from './conectores'
import github from './conectores/github'
import asana from './conectores/asana'
import gruv from './conectores/gruv'
import {
  ACCION_SCHEMA,
  accionesSoportadas,
  buildAccionArgs,
  buildAccionPrompt,
  buildDetalleArgs,
  buildDetallePrompt,
  buildListaArgs,
  buildPersonasArgs,
  buildPersonasPrompt,
  buildPrompt,
  clavesOcultas,
  conCategoria,
  ConectorFaltaError,
  estadosPorDefecto,
  extractJson,
  filtraPersonas,
  HerramientaFaltaError,
  idValido,
  info,
  mismaHerramienta,
  negadas,
  normalizePersonas,
  normalizeTickets,
  normEstado,
  OUTPUT_SCHEMA,
  parseAccion,
  parseClaudeOutput,
  parsePersonas,
  permisosPorConsulta,
  parseDetalle,
  TOOL_MISSING,
  type AccionInput
} from './motor'

interface Caso {
  fn: string
  args: unknown[]
  out?: unknown
  error?: string
  clase?: string
}

interface Golden {
  constantes: {
    READ_TOOLS: string[]
    DETAIL_TOOLS: string[]
    WRITE_TOOLS: string[]
    ACCION_TOOL: Record<Accion, string>
    NO_GRUV: string
    TOOL_MISSING: string
    OUTPUT_SCHEMA: unknown
    ACCION_SCHEMA: unknown
    msgNoGruv: string
    msgToolMissing: string
  }
  casos: Caso[]
}

const golden = JSON.parse(readFileSync(new URL('./__golden__/gruv-0.6.4.json', import.meta.url), 'utf8')) as Golden
const GRUV = validarConector(gruv) as ConectorMcp

/** La versión vieja pedía `horas` en minutos; ahora se llama `minutos`. */
function entrada(viejo: unknown): AccionInput {
  const { horas, ...resto } = viejo as AccionInput & { horas?: number }
  return horas === undefined ? resto : { ...resto, minutos: horas }
}

const s = (v: unknown): string => v as string
const a = (v: unknown): Accion => v as Accion

const NUEVAS: Record<string, (args: unknown[]) => unknown> = {
  buildPrompt: ([id]) => buildPrompt(GRUV, s(id)),
  buildArgs: ([m]) => buildListaArgs(GRUV, s(m)),
  buildDetallePrompt: ([id]) => buildDetallePrompt(GRUV, s(id)),
  buildDetalleArgs: ([m]) => buildDetalleArgs(GRUV, s(m)),
  buildAccionPrompt: ([ac, i]) => buildAccionPrompt(GRUV, a(ac), entrada(i)),
  buildAccionArgs: ([m, ac]) => buildAccionArgs(GRUV, s(m), a(ac)),
  sameTool: ([ac]) => mismaHerramienta(GRUV, a(ac)),
  normEstado: ([v]) => normEstado(v),
  extractJson: ([t]) => extractJson(s(t)),
  parseClaudeOutput: ([out]) => parseClaudeOutput(GRUV, s(out)),
  parseDetalle: ([out]) => parseDetalle(GRUV, s(out)),
  parseAccion: ([out, ac]) => parseAccion(GRUV, s(out), a(ac))
}

/**
 * Diferencias deliberadas con 0.6.4 en los args: sin skills ni comandos, el modo de permisos fijo y,
 * al final, `--max-turns 40` (red de seguridad nueva: 0.6.4 no ponía tope de vueltas).
 */
function conModoPermisos(args: string[]): string[] {
  const i = args.indexOf('--no-session-persistence')
  assert.ok(i >= 0, 'el golden debería tener --no-session-persistence')
  return [...args.slice(0, i + 1), '--disable-slash-commands', '--permission-mode', 'default', ...args.slice(i + 1), '--max-turns', '40']
}

/**
 * Diferencias deliberadas de la consulta de lista con 0.6.4 (fix/tickets-lista-grande): páginas de 50 en vez de 100
 * (una de 100 pasaba el máximo de salida de una herramienta MCP), sin pedirle al modelo que reescriba los criterios
 * de cada ticket (la interfaz solo los lee del detalle) y la descripción a 120 caracteres, y el id propio se saca de
 * ver_mi_perfil (que se suma a las herramientas permitidas) porque ver_mi_inicio no lo trae.
 */
function listaNueva(prompt: string): string {
  return prompt
    .replace('Tu id y tu nombre en Gruv los sacás de ver_mi_inicio.', GRUV.pistas.yo.sinId)
    .replace('limite: 100. Si vuelven 100, seguí con desplazamiento: 100, 200…', 'limite: 50. Si vuelven 50, seguí con desplazamiento: 50, 100…')
    .replace('recortado a 200 caracteres, si la trae. "criterios" son hasta 5 criterios de aceptación, con "texto" (máx. 120 caracteres) y "hecho" (true o false), si los trae.', 'recortado a 120 caracteres, si la trae.')
    .replace(',"criterios":[{"texto":"…","hecho":false}]', '')
}

function esquemaNuevo(schema: unknown): unknown {
  const s = JSON.parse(JSON.stringify(schema)) as { properties: { tickets: { items: { properties: Record<string, unknown> } } } }
  const p = s.properties.tickets.items.properties
  delete p.criterios
  p.fecha = { type: 'string' }
  return s
}

function listaArgsNuevos(args: string[]): string[] {
  const out = [...args]
  const i = out.indexOf('--allowedTools')
  out[i + 1] = out[i + 1].replace('mcp__claude_ai_Gruv__ver_mi_inicio', 'mcp__claude_ai_Gruv__ver_mi_inicio,mcp__claude_ai_Gruv__ver_mi_perfil')
  const j = out.indexOf('--json-schema')
  out[j + 1] = JSON.stringify(esquemaNuevo(JSON.parse(out[j + 1])))
  return out
}

const CLASES: Record<string, string> = { NoGruvError: ConectorFaltaError.name, ToolMissingError: HerramientaFaltaError.name, Error: Error.name }

test('con Gruv, cada caso del golden 0.6.4 sale igual', async (t) => {
  for (const [i, c] of golden.casos.entries()) {
    await t.test(`${i} ${c.fn}`, () => {
      const fn = NUEVAS[c.fn]
      assert.ok(fn, `falta mapear ${c.fn}`)
      if (c.error !== undefined) {
        assert.throws(
          () => fn(c.args),
          (e: unknown) => {
            assert.ok(e instanceof Error)
            assert.equal(e.message, c.error)
            assert.equal(e.constructor.name, CLASES[c.clase ?? ''])
            return true
          }
        )
        return
      }
      const esperado =
        c.fn === 'buildArgs' ? listaArgsNuevos(conModoPermisos(c.out as string[])) : c.fn.endsWith('Args') ? conModoPermisos(c.out as string[]) : c.fn === 'buildPrompt' ? listaNueva(c.out as string) : c.out
      assert.deepEqual(JSON.parse(JSON.stringify(fn(c.args) ?? null)), esperado)
    })
  }
})

test('constantes iguales a las de Gruv 0.6.4', () => {
  const k = golden.constantes
  assert.deepEqual(negadas(GRUV), k.WRITE_TOOLS)
  assert.deepEqual(GRUV.herramientas.lista.map((t) => nombreCompleto(GRUV, t)), [...k.READ_TOOLS.slice(0, 3), nombreCompleto(GRUV, 'ver_mi_perfil'), ...k.READ_TOOLS.slice(3)])
  assert.deepEqual(GRUV.herramientas.detalle.map((t) => nombreCompleto(GRUV, t)), k.DETAIL_TOOLS)
  for (const ac of accionesSoportadas(GRUV)) assert.equal(nombreCompleto(GRUV, GRUV.herramientas.escritura[ac] ?? ''), k.ACCION_TOOL[ac])
  assert.equal(GRUV.faltaConector.clave, k.NO_GRUV)
  assert.equal(TOOL_MISSING, k.TOOL_MISSING)
  assert.deepEqual(OUTPUT_SCHEMA, esquemaNuevo(k.OUTPUT_SCHEMA))
  assert.deepEqual(ACCION_SCHEMA, k.ACCION_SCHEMA)
  assert.equal(new ConectorFaltaError(GRUV).message, k.msgNoGruv)
  assert.equal(new HerramientaFaltaError(GRUV).message, k.msgToolMissing)
})

test('estados de Gruv: los por defecto son los DEFAULT_ESTADOS de gruv.ts y cerrado queda oculto', () => {
  const DEFAULT_ESTADOS = [
    { clave: 'abierto', nombre: 'Abierto' },
    { clave: 'en_curso', nombre: 'En curso' },
    { clave: 'bloqueado', nombre: 'Bloqueado' },
    { clave: 'en_revision', nombre: 'En revisión' },
    { clave: 'pre_rtd', nombre: 'Pre RTD' },
    { clave: 'en_qa', nombre: 'En QA' },
    { clave: 'rechazado', nombre: 'Rechazado' }
  ]
  assert.deepEqual(
    estadosPorDefecto(GRUV).map(({ clave, nombre }) => ({ clave, nombre })),
    DEFAULT_ESTADOS
  )
  assert.deepEqual(clavesOcultas(GRUV), ['cerrado'])
  assert.deepEqual(conCategoria(GRUV, [{ clave: 'en_qa', nombre: 'QA' }, { clave: 'nuevo', nombre: 'Nuevo' }]), [
    { clave: 'en_qa', nombre: 'QA', categoria: 'revision' },
    { clave: 'nuevo', nombre: 'Nuevo', categoria: 'pendiente' }
  ])
})

test('idValido normaliza y no evalúa ids de más de 20 caracteres', () => {
  assert.equal(idValido(GRUV, ' tck-12 '), 'TCK-12')
  assert.equal(idValido(GRUV, 'TCK-12345678'), null)
  assert.equal(idValido(GRUV, 1234), null)
  assert.equal(idValido(GRUV, 'ABCDEFGHIJKLMNOP-123'), 'ABCDEFGHIJKLMNOP-123')
  // 21 caracteres que la regex aceptaría: se rechaza igual, antes se recortaba a otro id.
  assert.equal(idValido(GRUV, 'ABCDEFGHIJKLMNOP-1234'), null)
})

test('idValido exige caracteres seguros aunque la regex del conector acepte cualquier cosa', () => {
  const laxa = (id: string): unknown => ({ ...structuredClone(gruv), id: 'laxo', idRegex: '^.+$', idMayusculas: false, ejemplo: { ...gruv.ejemplo, id } })
  const laxo = validarConector(laxa('x-1'))
  for (const ok of ['x-1', 'A_b.9', '#12', 'PROJ.sub-3']) assert.equal(idValido(laxo, ok), ok)
  for (const malo of ['a b', 'a;rm', 'a"b', "a'b", 'a$b', 'a`b', 'a\nb', 'a/b', 'a\\b', '{x}', 'ñ-1', 'a|b'])
    assert.equal(idValido(laxo, malo), null, JSON.stringify(malo))
  assert.throws(() => validarConector(laxa('x 1')), /ejemplo\.id/)
})

test('info de un conector que existe y de uno que no', () => {
  const i = info(GRUV, 'gruv')
  assert.equal(i.disponible, true)
  assert.equal(i.via, 'mcp')
  assert.equal(i.leeDetalle, true)
  assert.equal(i.ejemploId, 'TCK-1234')
  assert.equal(i.comandoTicket, '/ticket')
  assert.deepEqual(i.acciones, ['estado', 'tomar', 'soltar', 'comentar', 'criterio', 'horas'])
  assert.equal(i.estados.length, 8)
  assert.notEqual(i.estados[0], GRUV.estados[0])
  assert.deepEqual(info(undefined, 'jira'), {
    id: 'jira',
    nombre: 'jira',
    verificado: false,
    via: 'mcp',
    disponible: false,
    acciones: [],
    leeDetalle: false,
    ejemploId: '',
    estados: [],
    comandoTicket: null,
    idRegex: '^[A-Za-z0-9_.-]{1,20}$',
    idMayusculas: false,
    filtraPersonas: false
  })
})

test('info de GitHub: vía gh, con detalle y las acciones de gh', () => {
  const def = validarConector(github)
  const i = info(def, 'github')
  assert.equal(i.via, 'gh')
  assert.equal(i.leeDetalle, true)
  assert.equal(i.comandoTicket, null)
  assert.deepEqual(i.acciones, ACCIONES_GH)
  assert.deepEqual(accionesSoportadas(def), ACCIONES_GH)
  assert.deepEqual(mismaHerramienta(def, 'tomar'), ['tomar'])
  assert.deepEqual(clavesOcultas(def), ['cerrado'])
  assert.equal(idValido(def, ' 42 '), '42')
  for (const malo of ['0', '-1', '1;x', '12345678']) assert.equal(idValido(def, malo), null)
})

function variante(cambiar: (d: ConectorMcp) => void): ConectorMcp {
  const d = structuredClone(GRUV)
  cambiar(d)
  return validarConector(d) as ConectorMcp
}

test('sin pistas.estados no hay paso 3 ni "estados" en el ejemplo', () => {
  const p = buildPrompt(
    variante((d) => delete d.pistas.estados),
    ''
  )
  assert.doesNotMatch(p, /^3\. /m)
  assert.doesNotMatch(p, /"estados"/)
  assert.match(buildPrompt(GRUV, ''), /^3\. Llamá a ver_flujo_tickets/m)
})

test('otro nombre de conector llega a los textos y al reconocimiento de «no tengo»', () => {
  const otro = variante((d) => {
    d.nombre = 'Mesa.Ayuda'
    d.faltaConector = { clave: 'sin_mesa', mensaje: 'Conectá Mesa.Ayuda.' }
  })
  assert.match(buildPrompt(otro, ''), /^Tarea de solo lectura\. No modifiques nada en Mesa\.Ayuda:/)
  assert.match(buildPrompt(otro, ''), /\{"error":"sin_mesa","tickets":\[\]\}\.$/)
  const sinJson = JSON.stringify({ type: 'result', subtype: 'success', result: 'No tengo Mesa.Ayuda acá.' })
  assert.throws(() => parseClaudeOutput(otro, sinJson), ConectorFaltaError)
  // El punto del nombre es literal, no comodín.
  const parecido = JSON.stringify({ type: 'result', subtype: 'success', result: 'No tengo MesaXAyuda acá.' })
  assert.throws(() => parseClaudeOutput(otro, parecido), /JSON válido/)
})

test('un conector sin comentar no lo ofrece ni arma su prompt', () => {
  const sin = variante((d) => {
    delete d.herramientas.escritura.comentar
    delete d.pistas.acciones.comentar
  })
  assert.deepEqual(accionesSoportadas(sin), ['estado', 'tomar', 'soltar', 'criterio', 'horas'])
  assert.deepEqual(mismaHerramienta(sin, 'comentar'), [])
  assert.deepEqual(mismaHerramienta(sin, 'tomar'), ['tomar', 'soltar'])
  assert.throws(() => buildAccionPrompt(sin, 'comentar', { ticket: 'TCK-1', cuerpo: 'x' }), /no permite la acción «comentar»/)
  assert.throws(() => buildAccionArgs(sin, 'haiku', 'comentar'), /no permite/)
})

test('un placeholder sin valor deja afuera la clave y los literales quedan tipados', () => {
  const p = buildAccionPrompt(GRUV, 'tomar', { ticket: 'TCK-1', persona: null })
  assert.match(p, /Llamá a asignar_ticket con \{"id":"TCK-1","persona":null\}\./)
  const h = buildAccionPrompt(GRUV, 'horas', { ticket: 'TCK-1', minutos: 30 })
  assert.match(h, /\{"entidad":"ticket","id":"TCK-1","minutos":30\}/)
})

test('permisosPorConsulta es exactamente lo que va a --allowedTools en cada consulta y acción', () => {
  const permitidas = (args: string[]): string[] => args[args.indexOf('--allowedTools') + 1].split(',').filter(Boolean)
  for (const def of CONECTORES) {
    if (def.via !== 'mcp') continue
    const p = permisosPorConsulta(def)
    const full = (xs: string[] | undefined): string[] => (xs ?? []).map((t) => nombreCompleto(def, t))
    assert.deepEqual(permitidas(buildListaArgs(def, 'haiku')), full(p.lista), def.id)
    assert.deepEqual(permitidas(buildDetalleArgs(def, 'haiku')), full(p.detalle), def.id)
    assert.deepEqual(Object.keys(p.acciones), accionesSoportadas(def), def.id)
    for (const a of accionesSoportadas(def)) assert.deepEqual(permitidas(buildAccionArgs(def, 'haiku', a)), full(p.acciones[a]), `${def.id} ${a}`)
  }
})

test('un conector en solo lectura no ofrece acciones y sus escrituras siguen negadas', () => {
  assert.ok(accionesSoportadas(asana).length > 0)
  assert.deepEqual(info(asana, 'asana', true).acciones, [])
  assert.deepEqual(info(asana, 'asana').acciones, accionesSoportadas(asana))
  assert.ok(negadas(asana as ConectorMcp).includes(nombreCompleto(asana as ConectorMcp, 'add_comment')))
})

test('los MCP ajenos van a --disallowedTools en la lista, el detalle y las acciones', () => {
  const ajenos = ['mcp__claude_ai_Slack', 'mcp__mi_server']
  const negadasDe = (args: string[]): string[] => args[args.indexOf('--disallowedTools') + 1].split(',')
  const accion = accionesSoportadas(GRUV)[0]
  for (const args of [buildListaArgs(GRUV, 'haiku', ajenos), buildDetalleArgs(GRUV, 'haiku', ajenos), buildAccionArgs(GRUV, 'haiku', accion, ajenos)]) {
    for (const a of ajenos) assert.ok(negadasDe(args).includes(a), a)
  }
  assert.ok(!negadasDe(buildListaArgs(GRUV, 'haiku')).includes('mcp__claude_ai_Slack'))
})

test('--max-turns sale de un entero validado y cae a 40 con cualquier otra cosa', () => {
  const turnos = (args: string[]): string[] => args.slice(args.indexOf('--max-turns'))
  assert.deepEqual(turnos(buildListaArgs(GRUV, 'haiku', [], { maxTurns: 7 })), ['--max-turns', '7'])
  assert.deepEqual(turnos(buildDetalleArgs(GRUV, 'haiku', [], { maxTurns: 200 })), ['--max-turns', '200'])
  assert.deepEqual(turnos(buildAccionArgs(GRUV, 'haiku', accionesSoportadas(GRUV)[0], [], { maxTurns: 1 })), ['--max-turns', '1'])
  const malos: unknown[] = [0, 201, 999, NaN, Infinity, 1.5, -3, '9', null]
  for (const maxTurns of malos) assert.deepEqual(turnos(buildListaArgs(GRUV, 'haiku', [], { maxTurns: maxTurns as number })), ['--max-turns', '40'], String(maxTurns))
  assert.equal(buildListaArgs(GRUV, 'haiku').filter((a) => a === '--max-turns').length, 1)
})

test('--max-budget-usd solo va con un costo válido y en texto', () => {
  const args = buildListaArgs(GRUV, 'haiku', [], { maxCostUsd: 2.5 })
  assert.deepEqual(args.slice(-2), ['--max-budget-usd', '2.5'])
  for (const maxCostUsd of [0, -1, 101, NaN, Infinity, '2' as unknown as number]) {
    assert.ok(!buildListaArgs(GRUV, 'haiku', [], { maxCostUsd }).includes('--max-budget-usd'), String(maxCostUsd))
  }
  assert.ok(!buildListaArgs(GRUV, 'haiku').includes('--max-budget-usd'))
})

test('parseClaudeOutput trae las vueltas del sobre', () => {
  const sobre = JSON.stringify({ type: 'result', subtype: 'success', num_turns: 5, result: '', structured_output: { tickets: [] } })
  assert.equal(parseClaudeOutput(GRUV, sobre).numTurns, 5)
})

const ALCANCE = { personas: ['11111111-1111-1111-1111-111111111111'], sinAsignar: true, hechos: true, desde: '2026-11-14' }

test('lista por alcance: los ids y la fecha van en el pedido, sin descripción ni criterios', () => {
  const p = buildPrompt(GRUV, '', ALCANCE)
  assert.match(p, /\["tu id","11111111-1111-1111-1111-111111111111","sin_asignar"\]/)
  assert.match(p, /cerrados con "fecha" anterior a 2026-11-14/)
  assert.doesNotMatch(p, /dejá de paginar/)
  assert.match(p, /estado: "cerrado"/)
  assert.match(p, /ver_mi_perfil/)
  assert.doesNotMatch(p, /"criterios"/)
  assert.doesNotMatch(p, /"descripcion"/)
  assert.match(p, /"fecha":"<fecha ISO>"/)
  assert.doesNotMatch(buildPrompt(GRUV, '', { ...ALCANCE, hechos: false }), /estado: "cerrado"/)
  assert.match(buildPrompt(GRUV, 'abc-123', ALCANCE), /Tu id en Gruv es "abc-123"/)
})

test('sin alcance, o con un conector que no lista por responsable, la lista es la de todo el equipo', () => {
  assert.equal(buildPrompt(GRUV, ''), buildPrompt(GRUV, '', undefined))
  assert.match(buildPrompt(GRUV, ''), /limite: 50/)
  const { listaPor, listaHechos, ...pistas } = GRUV.pistas
  const { personas, ...herramientas } = GRUV.herramientas
  void listaPor, listaHechos, personas
  const sin = { ...GRUV, herramientas, pistas } as ConectorMcp
  assert.equal(buildPrompt(sin, '', ALCANCE), buildPrompt(sin, ''))
})

test('la lista pide como mucho 50 por página y nunca descripción larga ni criterios', () => {
  const props = (OUTPUT_SCHEMA.properties.tickets.items.properties as Record<string, unknown>)
  assert.ok('fecha' in props)
  assert.ok(!('criterios' in props))
  assert.match(buildPrompt(GRUV, ''), /recortado a 120 caracteres/)
})

test('normalizeTickets: fecha ISO validada y terminados solo si se piden', () => {
  const raw = {
    tickets: [
      { id: 'TCK-1', titulo: 'a', estado: 'en_curso', fecha: '2026-11-17T10:00:00+00:00' },
      { id: 'TCK-2', titulo: 'b', estado: 'en_curso', fecha: 'ayer' },
      { id: 'TCK-3', titulo: 'c', estado: 'cerrado', fecha: '2026-11-16T10:00:00Z' }
    ]
  }
  assert.deepEqual(normalizeTickets(GRUV, raw).map((t) => t.id), ['TCK-1', 'TCK-2'])
  const todos = normalizeTickets(GRUV, raw, { conservarHechos: true })
  assert.deepEqual(todos.map((t) => [t.id, t.fecha]), [['TCK-1', '2026-11-17T10:00:00.000Z'], ['TCK-2', undefined], ['TCK-3', '2026-11-16T10:00:00.000Z']])
})

test('personas: solo id y nombre, validados y sin repetir', () => {
  const raw = [
    { id: '22222222-2222-2222-2222-222222222222', nombre: 'Zoe', email: 'zoe@x.com' },
    { id: '11111111-1111-1111-1111-111111111111', nombre: 'Ana', celular: '123' },
    { id: '11111111-1111-1111-1111-111111111111', nombre: 'Ana de nuevo' },
    { id: 'mal id', nombre: 'Mal' },
    { id: 'sin-nombre' },
    null
  ]
  assert.deepEqual(normalizePersonas(GRUV, raw), [
    { id: '11111111-1111-1111-1111-111111111111', nombre: 'Ana' },
    { id: '22222222-2222-2222-2222-222222222222', nombre: 'Zoe' }
  ])
  assert.deepEqual(normalizePersonas(GRUV, 'x'), [])
  const sobre = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { personas: raw } })
  assert.equal(parsePersonas(GRUV, sobre).length, 2)
  assert.throws(() => parsePersonas(GRUV, JSON.stringify({ type: 'result', subtype: 'success', result: '{"error":"sin_gruv","personas":[]}' })), ConectorFaltaError)
})

test('la consulta de personas solo deja usar la herramienta de personas', () => {
  const a = buildPersonasArgs(GRUV, 'haiku')
  assert.equal(a[a.indexOf('--allowedTools') + 1], 'mcp__claude_ai_Gruv__buscar_persona')
  assert.match(buildPersonasPrompt(GRUV), /No pongas mails, teléfonos/)
  assert.equal(filtraPersonas(GRUV), true)
  assert.equal(filtraPersonas(github as never), false)
})
