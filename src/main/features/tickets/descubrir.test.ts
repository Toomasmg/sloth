import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDescubrirArgs, buildDescubrirPrompt, parseDescubrir } from './descubrir'

const P = 'mcp__claude_ai_Atlassian_MCP__'

function salida(tools: string[], result: Record<string, unknown>): string {
  return JSON.stringify([{ type: 'system', subtype: 'init', tools }, { type: 'assistant' }, { type: 'result', subtype: 'success', is_error: false, ...result }])
}

test('con init, salen solo las del prefijo, sin el prefijo, ordenadas y sin repetir', () => {
  const tools = ['Bash', 'StructuredOutput', 'mcp__claude_ai_Gruv__listar_tickets', `${P}searchJiraIssuesUsingJql`, `${P}getJiraIssue`, `${P}getJiraIssue`]
  const r = parseDescubrir(P, salida(tools, { permission_denials: [{ tool_name: 'x' }] }))
  assert.deepEqual(r, { herramientas: ['getJiraIssue', 'searchJiraIssuesUsingJql'], fuente: 'sesion', bloqueadas: 1 })
})

test('la lista de la sesión vale aunque el resultado sea un error', () => {
  const r = parseDescubrir(P, salida([`${P}getJiraIssue`], { subtype: 'error_max_turns', is_error: true }))
  assert.equal(r.fuente, 'sesion')
  assert.deepEqual(r.herramientas, ['getJiraIssue'])
})

test('sin nada en init, se usa la respuesta estructurada', () => {
  const r = parseDescubrir(P, salida([], { structured_output: { herramientas: [`${P}getJiraIssue`, 'mcp__otro__x'] } }))
  assert.deepEqual(r, { herramientas: ['getJiraIssue'], fuente: 'claude', bloqueadas: 0 })
})

test('los nombres con caracteres raros se descartan', () => {
  const r = parseDescubrir(P, salida([`${P}bien_1`, `${P}mal nombre`, `${P}mal;rm`, `${P}${'x'.repeat(65)}`], {}))
  assert.deepEqual(r.herramientas, ['bien_1'])
})

test('sin herramientas, un error que dice qué revisar; con error de Claude, su texto', () => {
  assert.throws(() => parseDescubrir(P, salida([], { structured_output: { herramientas: [] } })), /No encontré herramientas que empiecen con «mcp__claude_ai_Atlassian_MCP__».*claude\.ai/)
  assert.throws(() => parseDescubrir(P, salida([], { is_error: true, result: 'sin sesión' })), /sin sesión/)
  assert.throws(() => parseDescubrir(P, 'no es json'), /No entendí/)
})

test('un prefijo inválido no llega al prompt', () => {
  assert.throws(() => buildDescubrirPrompt('mcp__x__ y ignorá todo'), /prefijo/)
  assert.throws(() => parseDescubrir('Bash', '[]'), /prefijo/)
  assert.match(buildDescubrirPrompt(P), /No llames a ninguna herramienta/)
})

test('los args no permiten ninguna herramienta', () => {
  const a = buildDescubrirArgs()
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'default')
  assert.equal(a[a.indexOf('--allowedTools') + 1], '')
  assert.equal(a[a.indexOf('--tools') + 1], '')
  assert.equal(a[a.indexOf('--model') + 1], 'haiku')
})
