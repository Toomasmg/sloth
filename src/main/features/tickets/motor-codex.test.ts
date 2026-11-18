import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validarConector, type ConectorMcp } from './conector'
import gruv from './conectores/gruv'
import { permisosPorConsulta } from './motor'
import { ACCIONES_VERIFICADAS, herramientasPermitidas, motorCodex } from './motor-codex'
import type { PedidoMotor } from './motor-tickets'
import { motorDe, MOTORES } from './motores'
import { TopeVueltasError } from './uso'

const GRUV = validarConector(gruv) as ConectorMcp
const lista = (extra: Partial<PedidoMotor> = {}): PedidoMotor => ({ tarea: 'lista', def: GRUV, model: 'haiku', ajenos: [], servidoresCuenta: ['gruv', 'otro', 'x y'], servidorElegido: 'gruv', ...extra })
const mcp = JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call' } })

test('argv de lista: solo lectura, ajenos apagados, el conector acotado y el prompt por stdin', () => {
  const a = motorCodex.argv(lista())
  const cortas = permisosPorConsulta(GRUV).lista
  assert.deepEqual(a, [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-rules',
    '-s',
    'read-only',
    '-c',
    'approval_policy="never"',
    '-c',
    'mcp_servers.otro.enabled=false',
    '-c',
    `mcp_servers.gruv.enabled_tools=${JSON.stringify(cortas)}`,
    '-'
  ])
  assert.ok(!a.includes('-m'))
  assert.ok(!a.some((x) => x.includes('x y')))
})

test('ningún elemento del argv lleva un nombre sin validar ni texto de un ticket', () => {
  const hostil = 'GRV-1; rm -rf /'
  const a = motorCodex.argv(lista({ servidoresCuenta: ['otro', hostil, 'a"b', 'gruv'] }))
  assert.ok(!a.some((x) => x.includes(hostil) || x.includes('a"b')))
  assert.deepEqual(
    a.filter((x) => /\s/.test(x)),
    []
  )
})

test('el servidor elegido no se apaga a sí mismo y los demás van una sola vez', () => {
  const a = motorCodex.argv(lista({ servidoresCuenta: ['otro', 'otro', 'gruv'] }))
  assert.equal(a.filter((x) => x === 'mcp_servers.otro.enabled=false').length, 1)
  assert.ok(!a.includes('mcp_servers.gruv.enabled=false'))
  const b = motorCodex.argv(lista({ servidorElegido: 'otro', servidoresCuenta: ['gruv', 'otro'] }))
  assert.ok(b.includes('mcp_servers.gruv.enabled=false'))
  assert.ok(b.some((x) => x.startsWith('mcp_servers.otro.enabled_tools=')))
})

test('sin saber los servidores de la cuenta o el elegido no se lanza: no se puede apagar a los demás', () => {
  assert.throws(() => motorCodex.argv(lista({ servidoresCuenta: undefined })), /Falta saber/)
  assert.throws(() => motorCodex.argv(lista({ servidorElegido: undefined })), /Falta saber/)
  assert.throws(() => motorCodex.argv(lista({ servidorElegido: 'otro-que-no-esta' })), /no está en la configuración/)
})

test('detalle usa las herramientas de detalle', () => {
  const a = motorCodex.argv(lista({ tarea: 'detalle' }))
  assert.ok(a.includes(`mcp_servers.gruv.enabled_tools=${JSON.stringify(permisosPorConsulta(GRUV).detalle)}`))
})

test('accion falla antes de armar nada mientras no esté verificada', () => {
  assert.equal(ACCIONES_VERIFICADAS, false)
  assert.throws(() => motorCodex.argv(lista({ tarea: 'accion', accion: 'comentar' })), /solo lectura/)
  assert.throws(() => motorCodex.argv({ tarea: 'accion', model: 'm', ajenos: [] }), /solo lectura/)
})

test('descubrir y revisar no existen con Codex', () => {
  for (const tarea of ['descubrir', 'revisar'] as const) assert.throws(() => motorCodex.argv({ tarea, model: 'm', ajenos: [] }), /no puede buscar herramientas/)
})

test('pedido incompleto o prefijo raro falla en vez de armar a medias', () => {
  assert.throws(() => motorCodex.argv({ tarea: 'lista', model: 'm', ajenos: [] }), /incompleto/)
  assert.throws(() => motorCodex.argv(lista({ servidorElegido: 'x y' })), /no es válido/)
  const sinHerramientas = { ...GRUV, herramientas: { ...GRUV.herramientas, detalle: [], apoyo: [] } } as ConectorMcp
  assert.throws(() => motorCodex.argv(lista({ def: sinHerramientas, tarea: 'detalle' })), /no tiene herramientas permitidas/)
})

test('herramientasPermitidas coincide con permisosPorConsulta', () => {
  const p = permisosPorConsulta(GRUV)
  assert.deepEqual(herramientasPermitidas(GRUV, 'lista'), p.lista)
  assert.deepEqual(herramientasPermitidas(GRUV, 'detalle'), p.detalle)
  for (const [a, xs] of Object.entries(p.acciones)) assert.deepEqual(herramientasPermitidas(GRUV, 'accion', a as never), xs)
  assert.deepEqual(herramientasPermitidas(GRUV, 'accion'), [])
  assert.deepEqual(herramientasPermitidas(GRUV, 'descubrir'), [])
  assert.ok(herramientasPermitidas(GRUV, 'lista').every((t) => !t.startsWith('mcp__')))
})

test('cortarSi emula el tope de vueltas con las llamadas MCP', () => {
  const p = lista({ limites: { maxTurns: 2 } })
  assert.equal(motorCodex.cortarSi?.(mcp, p), undefined)
  assert.equal(motorCodex.cortarSi?.('{"type":"turn.started"}', p), undefined)
  assert.equal(motorCodex.cortarSi?.(mcp, p), undefined)
  const e = motorCodex.cortarSi?.(mcp, p)
  assert.ok(e instanceof TopeVueltasError)
  assert.equal(e.tope, 'vueltas')
  assert.equal(e.uso.numTurns, 3)
  assert.match(e.message, /tope de vueltas \(2\)/)
  assert.equal(motorCodex.cortarSi?.(mcp, lista({ limites: { maxTurns: 2 } })), undefined)
})

test('cortarSi corta si Codex quiere correr un comando', () => {
  const e = motorCodex.cortarSi?.(JSON.stringify({ type: 'item.started', item: { type: 'command_execution' } }), lista())
  assert.match(e?.message ?? '', /intentó correr comandos/)
  assert.ok(!(e instanceof TopeVueltasError))
})

test('el motor es experimental, no lee init, no suma entorno y normaliza al sobre común', () => {
  assert.equal(motorCodex.experimental, true)
  assert.equal(motorCodex.leeInit, false)
  assert.deepEqual(motorCodex.envExtra(lista()), {})
  const s = '{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}\n{"type":"turn.completed"}\n'
  assert.equal(JSON.parse(motorCodex.normalizar(s, lista())).subtype, 'success')
})

test('motores: codex está registrado y claude no cambia', () => {
  assert.equal(MOTORES.codex, motorCodex)
  assert.equal(motorDe({ proveedor: 'codex' }), motorCodex)
  assert.equal(motorDe({}), MOTORES.claude)
})
