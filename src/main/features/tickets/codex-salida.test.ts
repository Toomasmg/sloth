import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aSobreComun, ERROR_LLAMADAS_FALLIDAS, ERROR_SIN_LLAMADA, esComando, esLlamadaMcp, leerSalidaCodex, mensajeError, usoFueraDelConector, type ReglaConector } from './codex-salida'
import { validarConector, type ConectorMcp } from './conector'
import gruv from './conectores/gruv'
import { parseDetalle, parseEnvelope } from './motor'
import { leerUso } from './uso'

const GRUV = validarConector(gruv) as ConectorMcp

// Formas inventadas a partir de la documentación (sin confirmar contra un Codex real).
const l = (...xs: unknown[]): string => xs.map((x) => JSON.stringify(x)).join('\n') + '\n'
const TICKETS = { yo: { id: 'u1', nombre: 'Ana' }, tickets: [{ id: 'GRV-1', titulo: 'Arreglar login', estado: 'pendiente' }] }
const FELIZ = l(
  { type: 'thread.started', thread_id: 't1' },
  { type: 'turn.started' },
  { type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'gruv', tool: 'listar_tickets', status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 'gruv', tool: 'listar_tickets', status: 'completed' } },
  { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: JSON.stringify(TICKETS) } },
  { type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 90 } }
)

const REGLA: ReglaConector = { servidor: 'gruv', herramientas: ['listar_tickets'] }
const OK = { type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 'gruv', tool: 'listar_tickets', status: 'completed' } }
const FALLA = { type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 'gruv', tool: 'listar_tickets', status: 'failed', error: { message: 'servidor caído' } } }
const VACIA = { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ yo: { id: 'u1', nombre: 'Ana' }, tickets: [] }) } }
const FIN = { type: 'turn.completed' }

test('salida feliz: una vuelta, texto y sobre de éxito sin costo', () => {
  const s = leerSalidaCodex(FELIZ)
  assert.equal(s.completado, true)
  assert.equal(s.vueltas, 1)
  assert.equal(s.error, undefined)
  assert.equal(s.texto, JSON.stringify(TICKETS))
  assert.equal(s.tokens, 1290)
  const sobre = aSobreComun(s)
  assert.ok(!sobre.includes('\n'))
  const j = JSON.parse(sobre)
  assert.equal(j.type, 'result')
  assert.equal(j.subtype, 'success')
  assert.equal(j.is_error, false)
  assert.equal(j.num_turns, 1)
  assert.deepEqual(j.permission_denials, [])
  assert.ok(!('total_cost_usd' in j))
  assert.ok(!('duration_ms' in j))
})

test('el sobre lo leen los parsers de Claude: parseEnvelope y leerUso', () => {
  const sobre = aSobreComun(leerSalidaCodex(FELIZ))
  assert.deepEqual(parseEnvelope(GRUV, sobre).data, TICKETS)
  assert.deepEqual(leerUso(sobre), { numTurns: 1, tokens: 1290 })
})

test('la respuesta de detalle también pasa por el sobre', () => {
  const detalle = { id: 'GRV-1', titulo: 'Arreglar login', criterios: [{ texto: 'anda', hecho: false }], comentarios: [] }
  const s = l(OK, { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(detalle) } }, { type: 'turn.completed' })
  const d = parseDetalle(GRUV, aSobreComun(leerSalidaCodex(s)))
  assert.equal(d.criterios?.length, 1)
})

test('sin tokens no hay usage', () => {
  const s = leerSalidaCodex(l({ type: 'item.completed', item: { type: 'agent_message', text: '{}' } }, { type: 'turn.completed' }))
  assert.ok(!('usage' in JSON.parse(aSobreComun(s))))
})

test('turn.failed con mensaje largo: error recortado a 300 y sobre de error', () => {
  const largo = 'x'.repeat(2000) + '\nsegunda línea'
  const s = leerSalidaCodex(l({ type: 'thread.started' }, { type: 'turn.failed', error: { message: largo } }))
  assert.equal(s.error?.length, 300)
  assert.ok(!s.error?.includes('\n'))
  const j = JSON.parse(aSobreComun(s))
  assert.equal(j.subtype, 'error_during_execution')
  assert.equal(j.is_error, true)
  assert.throws(() => parseEnvelope(GRUV, JSON.stringify(j)), /^Error: Codex no pudo completar la consulta: x+$/)
})

test('un turn.failed gana aunque haya texto antes', () => {
  const s = leerSalidaCodex(l({ type: 'item.completed', item: { type: 'agent_message', text: 'hola' } }, { type: 'turn.failed', error: { message: 'cuota agotada' } }))
  assert.equal(s.error, 'cuota agotada')
})

test('sin turn.completed (proceso cortado) es un error', () => {
  const s = leerSalidaCodex(l({ type: 'turn.started' }, { type: 'item.completed', item: { type: 'agent_message', text: '{"tickets":[]}' } }))
  assert.equal(s.completado, false)
  assert.match(s.error ?? '', /terminó sin completar/)
  assert.equal(JSON.parse(aSobreComun(s)).is_error, true)
  assert.equal(leerSalidaCodex('').error, 'Codex terminó sin completar la respuesta')
})

test('un error suelto no tumba una respuesta completa, pero sí explica una cortada', () => {
  const aviso = { type: 'error', message: 'Reconnecting... 1/5' }
  const ok = leerSalidaCodex(l(aviso, OK, { type: 'item.completed', item: { type: 'agent_message', text: '{}' } }, { type: 'turn.completed' }))
  assert.equal(ok.error, undefined)
  assert.equal(leerSalidaCodex(l(aviso)).error, 'Reconnecting... 1/5')
})

test('completado sin texto es un error y usa el fallo de la herramienta si lo hay', () => {
  assert.match(leerSalidaCodex(l({ type: 'turn.completed' })).error ?? '', /sin devolver ninguna respuesta/)
  const s = leerSalidaCodex(l({ type: 'item.completed', item: { type: 'mcp_tool_call', status: 'failed', error: { message: 'no autorizado' } } }, { type: 'turn.completed' }))
  assert.equal(s.error, 'no autorizado')
})

test('líneas basura, vacías, arrays, null, tipos raros y una línea enorme se ignoran sin tirar', () => {
  const enorme = '{"type":"item.completed","item":{"type":"agent_message","text":"' + 'a'.repeat(5 * 1024 * 1024) + '"}}'
  const basura = ['', '   ', 'Reading prompt from stdin...', '[]', 'null', '{"type":5}', '{"type":"x"', '{"sin":"tipo"}', '"texto"', '42', enorme].join('\n')
  const s = leerSalidaCodex(basura + '\n' + FELIZ)
  assert.equal(s.vueltas, 1)
  assert.equal(s.texto, JSON.stringify(TICKETS))
  assert.equal(s.error, undefined)
  const solo = leerSalidaCodex(basura)
  assert.equal(solo.completado, false)
  assert.equal(solo.texto, '')
})

test('campos con tipos inesperados no cuentan', () => {
  const s = leerSalidaCodex(
    l(
      { type: 'item.started', item: 'mcp_tool_call' },
      { type: 'item.started', item: null },
      { type: 'item.completed', item: { type: 'agent_message', text: 7 } },
      { type: 'turn.completed', usage: { input_tokens: 'mucho', output_tokens: -3 } }
    )
  )
  assert.equal(s.vueltas, 0)
  assert.equal(s.texto, '')
  assert.equal(s.tokens, undefined)
})

test('el texto del agente se limita a 200000 caracteres', () => {
  const s = leerSalidaCodex(l({ type: 'item.completed', item: { type: 'agent_message', text: 'z'.repeat(300_000) } }, { type: 'turn.completed' }))
  assert.equal(s.texto.length, 200_000)
})

test('un command_execution cancela la consulta aunque haya respuesta', () => {
  const s = leerSalidaCodex(
    l(
      { type: 'item.started', item: { type: 'command_execution', command: 'ls' } },
      { type: 'item.completed', item: { type: 'agent_message', text: '{}' } },
      { type: 'turn.completed' }
    )
  )
  assert.equal(s.comandos, 1)
  assert.equal(s.error, 'Codex intentó correr comandos; se canceló la consulta')
  assert.equal(JSON.parse(aSobreComun(s)).is_error, true)
})

test('una lista vacía sin ninguna llamada al conector es un error, no «no hay tickets»', () => {
  const s = leerSalidaCodex(l({ type: 'turn.started' }, VACIA, FIN), REGLA)
  assert.equal(s.llamadasOk, 0)
  assert.equal(s.error, ERROR_SIN_LLAMADA)
  const j = JSON.parse(aSobreComun(s))
  assert.equal(j.is_error, true)
  assert.throws(() => parseEnvelope(GRUV, JSON.stringify(j)), /sin consultar el conector/)
})

test('una lista vacía con todas las llamadas fallidas es un error con el motivo de la última', () => {
  const s = leerSalidaCodex(l({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'gruv', tool: 'listar_tickets' } }, FALLA, FALLA, VACIA, FIN), REGLA)
  assert.equal(s.llamadasFallidas, 2)
  assert.equal(s.llamadasOk, 0)
  assert.equal(s.error, `${ERROR_LLAMADAS_FALLIDAS}: servidor caído`)
  assert.equal(JSON.parse(aSobreComun(s)).is_error, true)
})

test('una llamada fallida con un error sin status también cuenta como fallida', () => {
  const s = leerSalidaCodex(l({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'gruv', tool: 'listar_tickets', error: 'no autorizado' } }, VACIA, FIN))
  assert.equal(s.llamadasFallidas, 1)
  assert.match(s.error ?? '', /fallaron/)
})

test('con una llamada lograda, aunque otra haya fallado, la lista vacía es una respuesta', () => {
  const s = leerSalidaCodex(l(FALLA, OK, VACIA, FIN), REGLA)
  assert.equal(s.llamadasOk, 1)
  assert.equal(s.error, undefined)
  assert.equal(JSON.parse(aSobreComun(s)).subtype, 'success')
})

test('una llamada con error: null o sin error cuenta como lograda', () => {
  const s = leerSalidaCodex(l({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'gruv', tool: 'listar_tickets', status: 'completed', error: null } }, VACIA, FIN))
  assert.equal(s.llamadasOk, 1)
  assert.equal(s.error, undefined)
})

test('con regla, usar otro servidor, otra herramienta o la web cancela la consulta', () => {
  const otro = { type: 'item.started', item: { type: 'mcp_tool_call', server: 'mi_otro', tool: 'listar_tickets' } }
  const s = leerSalidaCodex(l(otro, OK, VACIA, FIN), REGLA)
  assert.equal(s.fuera, 'mi_otro/listar_tickets')
  assert.match(s.error ?? '', /fuera del conector \(mi_otro\/listar_tickets\)/)
  assert.match(leerSalidaCodex(l(OK, { type: 'item.started', item: { type: 'web_search' } }, VACIA, FIN), REGLA).error ?? '', /\(web_search\)/)
  // Sin regla no se juzga qué es el conector.
  assert.equal(leerSalidaCodex(l(otro, OK, VACIA, FIN)).fuera, undefined)
})

test('usoFueraDelConector: lo inocuo y lo ajeno', () => {
  const ev = (item: unknown, type = 'item.started'): Record<string, unknown> => ({ type, item })
  for (const t of ['agent_message', 'reasoning', 'todo_list', 'error']) assert.equal(usoFueraDelConector(ev({ type: t }), REGLA), undefined)
  assert.equal(usoFueraDelConector(ev({ type: 'command_execution' }), REGLA), undefined)
  assert.equal(usoFueraDelConector({ type: 'turn.completed' }, REGLA), undefined)
  assert.equal(usoFueraDelConector(ev({ type: 'mcp_tool_call', server: 'gruv', tool: 'listar_tickets' }), REGLA), undefined)
  assert.equal(usoFueraDelConector(ev({ type: 'mcp_tool_call', server: 'gruv', tool: 'listar_tickets' }), undefined), 'gruv/listar_tickets')
  assert.equal(usoFueraDelConector(ev({ type: 'file_change' }, 'item.completed'), REGLA), 'file_change')
})

test('esLlamadaMcp y esComando: solo item.started del tipo justo', () => {
  const mcp = { type: 'item.started', item: { type: 'mcp_tool_call' } }
  assert.equal(esLlamadaMcp(JSON.stringify(mcp)), true)
  assert.equal(esLlamadaMcp(JSON.stringify({ ...mcp, type: 'item.completed' })), false)
  assert.equal(esLlamadaMcp(JSON.stringify({ type: 'item.started', item: { type: 'reasoning' } })), false)
  assert.equal(esLlamadaMcp(JSON.stringify({ type: 'item.started', item: { type: 'agent_message', text: 'mcp_tool_call' } })), false)
  assert.equal(esLlamadaMcp('mcp_tool_call'), false)
  assert.equal(esLlamadaMcp(''), false)
  assert.equal(esComando(JSON.stringify({ type: 'item.started', item: { type: 'command_execution' } })), true)
  assert.equal(esComando(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } })), false)
})

test('mensajeError recorta, junta espacios y acepta string u objeto con message', () => {
  assert.equal(mensajeError('  a\n\nb  '), 'a b')
  assert.equal(mensajeError({ message: 'x'.repeat(400) })?.length, 300)
  assert.equal(mensajeError(''), undefined)
  assert.equal(mensajeError(5), undefined)
  assert.equal(mensajeError({ message: 5 }), undefined)
  assert.equal(mensajeError(null), undefined)
})
