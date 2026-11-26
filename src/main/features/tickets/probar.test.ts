import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Disponibilidad, EstadoMcp } from '../../../shared/tickets'
import type { ConectorMcp } from './conector'
import { conectorPorId } from './conectores'
import { conPrefijo } from './cuentas'
import { buildProbarArgs, buildProbarPrompt, datosDeMcpGet, diagnosticar, limpiarCausa, nombreProbable, parseProbar, type EntradaDiagnostico } from './probar'

const base = conectorPorId('gruv')
if (base?.via !== 'mcp') throw new Error('falta gruv')
const TOMY: ConectorMcp = conPrefijo(base, 'mcp__gruv-tomy__')

const tiene = (estado: EstadoMcp, verificado = estado === 'connected'): Disponibilidad => ({ tipo: 'tiene', nombre: 'gruv-tomy', prefijo: 'mcp__gruv-tomy__', estado, adaptado: true, verificado })
const dx = (d: Disponibilidad, resto: Partial<EntradaDiagnostico> = {}) => diagnosticar({ def: TOMY, cuenta: 'Cosmos-Fusion', d, ms: 4200, ...resto })
const sobre = (structured: unknown): string => JSON.stringify([{ type: 'system', subtype: 'init' }, { type: 'result', subtype: 'success', is_error: false, result: '', structured_output: structured }])

// Salidas reales de `claude mcp get` (2.1.332) contra servidores locales de juguete.
const GET_ROTO = 'stdio-roto:\n  Scope: User config (available in all your projects)\n  Status: ✘ Failed to connect\n  Issue: CONNECTION_CLOSED: Connection closed\n  Type: stdio\n  Command: nodo-que-no-existe\n  Args:\n'
const GET_LENTO = 'gruv-lento:\n  Scope: User config (available in all your projects)\n  Status: ✘ Failed to connect\n  Issue: MCP server "gruv-lento" connection timed out after 30000ms\n  Type: http\n  URL: http://127.0.0.1:18703\n'
const GET_LOCAL = 'otro:\n  Scope: Local config (private to you in this project)\n  Status: ✘ Failed to connect\n  Issue: HTTP 500\n  Type: http\n  URL: https://x.example/mcp\n  Headers:\n    Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEF\n'

test('la prueba llama a una sola herramienta de lectura del servidor de la cuenta, con el nombre con guión y sin escribir', () => {
  const args = buildProbarArgs(TOMY, 'haiku', ['mcp__otro'])
  const i = args.indexOf('--allowedTools')
  assert.equal(args[i + 1], 'mcp__gruv-tomy__listar_tickets')
  assert.match(args[args.indexOf('--disallowedTools') + 1], /mcp__gruv-tomy__mover_ticket/)
  assert.match(args[args.indexOf('--disallowedTools') + 1], /mcp__otro$/)
  assert.equal(args[args.indexOf('--max-turns') + 1], '6')
  assert.ok(args.includes('--verbose'))
  assert.match(buildProbarPrompt(TOMY), /UNA sola vez a listar_tickets/)
})

test('parseProbar: ok, error con motivo y herramienta que falta', () => {
  assert.deepEqual(parseProbar(TOMY, sobre({ ok: true })), { ok: true })
  assert.deepEqual(parseProbar(TOMY, sobre({ ok: false, error: 'HTTP 401' })), { ok: false, error: 'HTTP 401' })
  assert.deepEqual(parseProbar(TOMY, sobre({ ok: false })), { ok: false, error: 'sin motivo' })
})

test('limpiarCausa tapa tokens, Bearer y deja solo el origen de las URL', () => {
  assert.equal(limpiarCausa('GET https://api.example.com/v1/x?token=abc123secret falló'), 'GET https://api.example.com falló')
  assert.equal(limpiarCausa('Authorization: Bearer abcdef.ghijkl-mnop'), 'Authorization: Bearer ***')
  assert.equal(limpiarCausa('clave abcdefghijklmnopqrstuvwxyz0123456789ABCDEF rota'), 'clave *** rota')
  assert.equal(limpiarCausa('fallo https://user:pass@host.example/x'), 'fallo https://host.example')
  assert.equal(limpiarCausa('api_key=abc123 y X-Api-Key: zzz'), 'api_key=*** y X-Api-Key=***')
  assert.equal(limpiarCausa('Authorization: Basic dXNlcjpwYXNz'), 'Authorization: Basic ***')
  assert.equal(limpiarCausa('a\nb\u0000c'), 'a b c')
  assert.ok(limpiarCausa('x'.repeat(500)).length <= 200)
})

test('datosDeMcpGet lee solo el alcance y el motivo, nunca la URL ni las cabeceras', () => {
  assert.deepEqual(datosDeMcpGet(GET_ROTO), { alcance: 'usuario', motivo: 'CONNECTION_CLOSED: Connection closed' })
  assert.deepEqual(datosDeMcpGet(GET_LENTO), { alcance: 'usuario', motivo: 'MCP server "gruv-lento" connection timed out after 30000ms' })
  const local = datosDeMcpGet(GET_LOCAL)
  assert.deepEqual(local, { alcance: 'local', motivo: 'HTTP 500' })
  assert.doesNotMatch(JSON.stringify(local), /Bearer|abcdefghijkl|x\.example/)
  assert.deepEqual(datosDeMcpGet('nada útil'), {})
})

test('nombreProbable: solo nombres simples (nada de espacios ni opciones) van a `claude mcp get`', () => {
  for (const ok of ['gruv-tomy', 'gruv.punto', 'mi_servidor2']) assert.equal(nombreProbable(ok), true, ok)
  for (const mal of ['claude.ai Gruv', '--help', '-x', '', 'a b', 'a;b', 'x'.repeat(65)]) assert.equal(nombreProbable(mal), false, mal)
})

test('necesita sesión: lo dice con el nombre del servidor y la cuenta, y qué hacer', () => {
  const r = dx(tiene('needs-auth'))
  assert.equal(r.estado, 'necesita-sesion')
  assert.equal(r.mensaje, 'El servidor «gruv-tomy» pide iniciar sesión.')
  assert.match(r.queHacer ?? '', /cuenta «Cosmos-Fusion», corré \/mcp, elegí «gruv-tomy»/)
})

test('no conecta: dice la causa que dio Claude Code y, si es de otro alcance, que Sloth no lo ve', () => {
  const lento = dx(tiene('failed'), { datos: datosDeMcpGet(GET_LENTO) })
  assert.equal(lento.estado, 'error')
  assert.equal(lento.mensaje, 'No se pudo conectar a «gruv-tomy».')
  assert.match(lento.causa ?? '', /connection timed out after 30000ms/)
  assert.doesNotMatch(lento.queHacer ?? '', /alcance/)
  const local = dx(tiene('failed'), { datos: datosDeMcpGet(GET_LOCAL) })
  assert.match(local.queHacer ?? '', /alcance local: Sloth consulta desde otra carpeta y no lo ve/)
  assert.equal(dx(tiene('failed')).causa, 'Claude Code no dijo por qué.')
})

test('pending al terminar la revisión es un error de tiempo, no «conectado»', () => {
  const r = dx(tiene('pending', false))
  assert.equal(r.estado, 'error')
  assert.match(r.mensaje, /no terminó de conectar a tiempo/)
})

test('sin el servidor: sin herramientas, y avisa del alcance local o de proyecto', () => {
  const r = dx({ tipo: 'falta' })
  assert.equal(r.estado, 'sin-herramientas')
  assert.match(r.queHacer ?? '', /--scope user/)
  const parecido = dx({ tipo: 'falta', parecido: { nombre: 'gruv-tomy', faltan: ['ver_mi_perfil', 'buscar_persona'] } })
  assert.equal(parecido.estado, 'sin-herramientas')
  assert.equal(parecido.causa, 'Le faltan: ver_mi_perfil, buscar_persona.')
})

test('un conector de claude.ai sin conectar manda a claude.ai, no a /mcp', () => {
  const r = diagnosticar({ def: base, cuenta: 'Cosmos-Fusion', d: { tipo: 'falta' }, ms: 1 })
  assert.match(r.queHacer ?? '', /claude\.ai/)
})

test('más de un servidor posible: pide elegir', () => {
  const r = dx({ tipo: 'elegir', opciones: [] })
  assert.equal(r.estado, 'error')
  assert.match(r.queHacer ?? '', /Conectores por cuenta/)
})

test('conectado con herramientas: sin prueba, con prueba ok, con error de la herramienta, sin la herramienta y por plazo', () => {
  const d = tiene('connected')
  assert.equal(dx(d).estado, 'conectado')
  const ok = dx(d, { prueba: { ok: true } })
  assert.equal(ok.estado, 'conectado')
  assert.match(ok.mensaje, /respondió a una consulta de prueba \(4 s\)/)
  const mal = dx(d, { prueba: { ok: false, error: 'HTTP 401: token vencido' } })
  assert.equal(mal.estado, 'error')
  assert.equal(mal.causa, 'HTTP 401: token vencido')
  assert.equal(dx(d, { prueba: { ok: false, error: 'sin_herramienta' } }).estado, 'sin-herramientas')
  const plazo = dx(d, { prueba: { plazoS: 75 } })
  assert.equal(plazo.estado, 'error')
  assert.match(plazo.mensaje, /tardó más de 75 s/)
  assert.equal(dx(d, { prueba: { cayo: 'No pude abrir Claude' } }).causa, 'No pude abrir Claude')
})

test('conectado pero sin haberle visto las herramientas: no se da por bueno', () => {
  assert.equal(dx(tiene('connected', false)).estado, 'sin-herramientas')
})

test('cuenta sin revisar: el error de la revisión llega como causa', () => {
  const r = dx({ tipo: 'sin_revisar' }, { errorRevision: 'No encontré el ejecutable de Claude Code' })
  assert.equal(r.estado, 'error')
  assert.equal(r.causa, 'No encontré el ejecutable de Claude Code')
})
