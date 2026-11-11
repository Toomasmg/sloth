import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Accion } from '../../../shared/tickets'
import { ACCIONES_GH, nombreCompleto, validarConector, type ConectorMcp } from './conector'
import { CONECTORES } from './conectores'
import github from './conectores/github'
import gruv from './conectores/gruv'
import {
  ACCION_SCHEMA,
  accionesSoportadas,
  buildAccionArgs,
  buildAccionPrompt,
  buildDetalleArgs,
  buildDetallePrompt,
  buildListaArgs,
  buildPrompt,
  clavesOcultas,
  conCategoria,
  ConectorFaltaError,
  estadosPorDefecto,
  extractJson,
  HerramientaFaltaError,
  idValido,
  info,
  mismaHerramienta,
  negadas,
  normEstado,
  OUTPUT_SCHEMA,
  parseAccion,
  parseClaudeOutput,
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

/** Única diferencia deliberada con 0.6.4 en los args: el modo de permisos fijo. */
function conModoPermisos(args: string[]): string[] {
  const i = args.indexOf('--no-session-persistence')
  assert.ok(i >= 0, 'el golden debería tener --no-session-persistence')
  return [...args.slice(0, i + 1), '--permission-mode', 'default', ...args.slice(i + 1)]
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
      const esperado = c.fn.endsWith('Args') ? conModoPermisos(c.out as string[]) : c.out
      assert.deepEqual(JSON.parse(JSON.stringify(fn(c.args) ?? null)), esperado)
    })
  }
})

test('constantes iguales a las de Gruv 0.6.4', () => {
  const k = golden.constantes
  assert.deepEqual(negadas(GRUV), k.WRITE_TOOLS)
  assert.deepEqual(GRUV.herramientas.lista.map((t) => nombreCompleto(GRUV, t)), k.READ_TOOLS)
  assert.deepEqual(GRUV.herramientas.detalle.map((t) => nombreCompleto(GRUV, t)), k.DETAIL_TOOLS)
  for (const ac of accionesSoportadas(GRUV)) assert.equal(nombreCompleto(GRUV, GRUV.herramientas.escritura[ac] ?? ''), k.ACCION_TOOL[ac])
  assert.equal(GRUV.faltaConector.clave, k.NO_GRUV)
  assert.equal(TOOL_MISSING, k.TOOL_MISSING)
  assert.deepEqual(OUTPUT_SCHEMA, k.OUTPUT_SCHEMA)
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
  assert.equal(i.comandoTicket, true)
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
    comandoTicket: false
  })
})

test('info de GitHub: vía gh, con detalle y las acciones de gh', () => {
  const def = validarConector(github)
  const i = info(def, 'github')
  assert.equal(i.via, 'gh')
  assert.equal(i.leeDetalle, true)
  assert.equal(i.comandoTicket, false)
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
