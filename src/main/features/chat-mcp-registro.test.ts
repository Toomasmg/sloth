import { test } from 'node:test'
import assert from 'node:assert/strict'
import { argsAlta, argsBaja, esNuestra, leerRegistro, planificar, TOKEN_ENV } from './chat-mcp-registro'
import { hashToken } from './chat-mcp-core'

const SCRIPT = 'C:\\Users\\x\\AppData\\Roaming\\Sloth\\sloth-chat-mcp.cjs'
const SCRIPT_N = 'C:/Users/x/AppData/Roaming/Sloth/sloth-chat-mcp.cjs'
const TOKEN = 'a'.repeat(64)
const nuestra = (env: Record<string, string> = { [TOKEN_ENV]: TOKEN }, script = SCRIPT_N) => ({ type: 'stdio', command: 'node', args: [script], env })
const otro = { type: 'stdio', command: 'npx', args: ['otro-mcp'], env: {} }

test('esNuestra mira el script, con cualquier barra', () => {
  assert.equal(esNuestra(nuestra()), true)
  assert.equal(esNuestra({ args: [SCRIPT] }), true)
  assert.equal(esNuestra(otro), false)
  assert.equal(esNuestra(null), false)
})

test('leerRegistro: ausente, ajena, nuestra con y sin token', () => {
  assert.deepEqual(leerRegistro({}), { estado: 'ausente' })
  assert.deepEqual(leerRegistro({ mcpServers: { otro } }), { estado: 'ausente' })
  assert.deepEqual(leerRegistro({ mcpServers: { sloth: otro } }), { estado: 'ajena' })
  assert.deepEqual(leerRegistro({ mcpServers: [] }), { estado: 'ajena' })
  assert.deepEqual(leerRegistro('x'), { estado: 'ajena' })
  assert.deepEqual(leerRegistro({ mcpServers: { sloth: nuestra() } }), { estado: 'nuestra', script: SCRIPT_N, token: TOKEN })
  const vieja = { type: 'stdio', command: 'node', args: [SCRIPT_N, '--cuenta', 'acc-1'], env: {} }
  assert.deepEqual(leerRegistro({ mcpServers: { sloth: vieja } }), { estado: 'nuestra', script: SCRIPT_N })
})

test('planificar: alta, nada, reemplazo y baja', () => {
  const h = hashToken(TOKEN)
  const conToken = leerRegistro({ mcpServers: { sloth: nuestra() } })
  assert.equal(planificar(true, { estado: 'ausente' }, SCRIPT, h, hashToken), 'alta')
  assert.equal(planificar(false, { estado: 'ausente' }, SCRIPT, undefined, hashToken), 'nada')
  assert.equal(planificar(true, conToken, SCRIPT, h, hashToken), 'nada')
  assert.equal(planificar(false, conToken, SCRIPT, h, hashToken), 'baja')
})

test('planificar reemplaza si el token no es el que reconoce el main, o si cambió la ruta', () => {
  const conToken = leerRegistro({ mcpServers: { sloth: nuestra() } })
  assert.equal(planificar(true, conToken, SCRIPT, undefined, hashToken), 'reemplazo')
  assert.equal(planificar(true, conToken, SCRIPT, hashToken('b'.repeat(64)), hashToken), 'reemplazo')
  assert.equal(planificar(true, conToken, 'D:/otro/sloth-chat-mcp.cjs', hashToken(TOKEN), hashToken), 'reemplazo')
  assert.equal(planificar(true, leerRegistro({ mcpServers: { sloth: nuestra({}) } }), SCRIPT, hashToken(TOKEN), hashToken), 'reemplazo')
})

test('planificar no toca un sloth ajeno', () => {
  assert.equal(planificar(true, { estado: 'ajena' }, SCRIPT, undefined, hashToken), 'conflicto')
  assert.equal(planificar(false, { estado: 'ajena' }, SCRIPT, undefined, hashToken), 'nada')
})

test('argsAlta arma el comando del CLI con el token en el env del servidor', () => {
  assert.deepEqual(argsAlta(SCRIPT, TOKEN), ['mcp', 'add', '-s', 'user', 'sloth', '-e', `${TOKEN_ENV}=${TOKEN}`, '--', 'node', SCRIPT_N])
  assert.deepEqual(argsBaja(), ['mcp', 'remove', '-s', 'user', 'sloth'])
})

test('argsAlta rechaza tokens y rutas raras', () => {
  assert.throws(() => argsAlta(SCRIPT, 'corto'), /Token/)
  assert.throws(() => argsAlta(SCRIPT, `${TOKEN}\n-e X=1`), /Token/)
  assert.throws(() => argsAlta('relativo/sloth-chat-mcp.cjs', TOKEN), /Ruta/)
  assert.throws(() => argsAlta('C:/x/otro.cjs', TOKEN), /Ruta/)
  assert.throws(() => argsAlta('C:/x"/sloth-chat-mcp.cjs', TOKEN), /Ruta/)
  assert.throws(() => argsAlta('C:/x\n/sloth-chat-mcp.cjs', TOKEN), /Ruta/)
})
