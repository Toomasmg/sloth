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
const lista = (extra: Partial<PedidoMotor> = {}): PedidoMotor => ({ tarea: 'lista', def: GRUV, model: 'haiku', ajenos: [], servidoresCuenta: ['gruv', 'otro'], servidorElegido: 'gruv', ...extra })
const llamada = (server: string, tool: string, type = 'item.started'): string => JSON.stringify({ type, item: { type: 'mcp_tool_call', server, tool } })
const TOOL = permisosPorConsulta(GRUV).lista[0]
const mcp = llamada('gruv', TOOL)
const MENSAJE = '{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}'

test('argv de lista: solo lectura, funciones propias apagadas, ajenos apagados, el conector acotado y el prompt por stdin', () => {
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
    'web_search="disabled"',
    '-c',
    'features.shell_tool=false',
    '-c',
    'features.unified_exec=false',
    '-c',
    'features.apps=false',
    '-c',
    'features.plugins=false',
    '-c',
    'features.browser_use=false',
    '-c',
    'features.computer_use=false',
    '-c',
    'features.multi_agent=false',
    '-c',
    'mcp_servers.otro.enabled=false',
    '-c',
    `mcp_servers.gruv.enabled_tools=${JSON.stringify(cortas)}`,
    '-'
  ])
  assert.ok(!a.includes('-m'))
})

test('ningún elemento del argv lleva un nombre sin validar ni texto de un ticket', () => {
  const a = motorCodex.argv(lista({ servidoresCuenta: ['otro', 'gruv'] }))
  assert.deepEqual(
    a.filter((x) => /\s/.test(x)),
    []
  )
  for (const hostil of ['GRV-1; rm -rf /', 'a"b', 'x y', 'mi.server']) {
    assert.throws(() => motorCodex.argv(lista({ servidoresCuenta: ['otro', hostil, 'gruv'] })), /no puede apagar/)
  }
})

test('con un servidor de nombre no válido no se consulta: el motivo dice cuál y cómo arreglarlo', () => {
  assert.throws(
    () => motorCodex.argv(lista({ servidoresCuenta: ['gruv', 'mi.server'] })),
    (e: Error) => /mi\.server/.test(e.message) && /No se consultó nada/.test(e.message) && /renombralos/.test(e.message)
  )
  assert.throws(() => motorCodex.argv(lista({ servidoresCuenta: ['gruv', 'a.b', 'c d'] })), /servidores MCP/)
  assert.doesNotThrow(() => motorCodex.argv(lista({ servidoresCuenta: ['gruv', 'ok-1', 'ok_2'] })))
})

test('un nombre de herramienta que no se puede pasar no se descarta en silencio', () => {
  const raro = { ...GRUV, herramientas: { ...GRUV.herramientas, lista: [...GRUV.herramientas.lista, 'a b'] } } as ConectorMcp
  assert.throws(() => motorCodex.argv(lista({ def: raro })), /nombre que Sloth no puede pasarle/)
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

test('cortarSi corta una herramienta de otro servidor o fuera de la lista, en started y en completed', () => {
  const fueraDeLaLista = 'crear_issue'
  assert.ok(!permisosPorConsulta(GRUV).lista.includes(fueraDeLaLista))
  for (const type of ['item.started', 'item.completed']) {
    const otroServidor = motorCodex.cortarSi?.(llamada('mi_otro', TOOL, type), lista())
    assert.match(otroServidor?.message ?? '', /fuera del conector \(mi_otro\//)
    assert.ok(!(otroServidor instanceof TopeVueltasError))
    assert.match(motorCodex.cortarSi?.(llamada('gruv', fueraDeLaLista, type), lista())?.message ?? '', /fuera del conector \(gruv\/crear_issue\)/)
  }
  // Server o tool ausentes o de otro tipo: con duda se corta.
  for (const item of [{ type: 'mcp_tool_call' }, { type: 'mcp_tool_call', server: 'gruv' }, { type: 'mcp_tool_call', server: 7, tool: 7 }]) {
    assert.ok(motorCodex.cortarSi?.(JSON.stringify({ type: 'item.started', item }), lista()))
  }
  // Una llamada de las permitidas no corta, y tampoco el texto ni el razonamiento.
  assert.equal(motorCodex.cortarSi?.(llamada('gruv', TOOL, 'item.completed'), lista()), undefined)
  assert.equal(motorCodex.cortarSi?.(MENSAJE, lista()), undefined)
  assert.equal(motorCodex.cortarSi?.(JSON.stringify({ type: 'item.started', item: { type: 'reasoning' } }), lista()), undefined)
})

test('cortarSi corta con un pedido que no dice cuál es el conector', () => {
  assert.ok(motorCodex.cortarSi?.(mcp, lista({ servidorElegido: undefined })))
  assert.ok(motorCodex.cortarSi?.(mcp, lista({ def: undefined })))
})

test('cortarSi corta búsqueda web, cambios de archivos, subagentes y tipos que no conoce', () => {
  for (const tipo of ['web_search', 'file_change', 'collab_tool_call', 'algo_nuevo']) {
    const e = motorCodex.cortarSi?.(JSON.stringify({ type: 'item.started', item: { type: tipo } }), lista())
    assert.match(e?.message ?? '', new RegExp(`fuera del conector \\(${tipo}\\)`))
  }
})

test('cortarSi sanea lo que cuenta de la herramienta ajena', () => {
  const e = motorCodex.cortarSi?.(llamada('x\n<script>', 'y'.repeat(500)), lista())
  assert.ok(e && !e.message.includes('\n') && !e.message.includes('<') && e.message.length < 200)
})

test('cortarSi no confunde el texto de un ticket con un evento', () => {
  const e = motorCodex.cortarSi?.(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '"item.started" mcp_tool_call web_search' } }), lista())
  assert.equal(e, undefined)
  assert.equal(motorCodex.cortarSi?.('Reading prompt "item.started" from stdin', lista()), undefined)
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
  const s = `${llamada('gruv', TOOL, 'item.completed')}\n${MENSAJE}\n{"type":"turn.completed"}\n`
  assert.equal(JSON.parse(motorCodex.normalizar(s, lista())).subtype, 'success')
})

test('normalizar: una llamada a otra herramienta es un error aunque haya respuesta', () => {
  const s = `${llamada('mi_otro', 'x', 'item.completed')}\n${llamada('gruv', TOOL, 'item.completed')}\n${MENSAJE}\n{"type":"turn.completed"}\n`
  const j = JSON.parse(motorCodex.normalizar(s, lista()))
  assert.equal(j.is_error, true)
  assert.match(j.result, /fuera del conector \(mi_otro\/x\)/)
})

test('normalizar: sin una llamada al conector no hay datos, no una lista vacía', () => {
  const vacia = '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"tickets\\":[]}"}}\n{"type":"turn.completed"}\n'
  const j = JSON.parse(motorCodex.normalizar(vacia, lista()))
  assert.equal(j.is_error, true)
  assert.match(j.result, /sin consultar el conector/)
})

test('motores: codex está registrado y claude no cambia', () => {
  assert.equal(MOTORES.codex, motorCodex)
  assert.equal(motorDe({ proveedor: 'codex' }), motorCodex)
  assert.equal(motorDe({}), MOTORES.claude)
})
