import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aplicarRegistro, entradaMcp, esNuestra } from './chat-mcp-registro'

const E = entradaMcp('C:\\Users\\x\\AppData\\Roaming\\Sloth\\sloth-chat-mcp.cjs', 'acc-1')
const otro = { type: 'stdio', command: 'npx', args: ['otro-mcp'], env: {} }

test('entradaMcp usa barras normales y fija la cuenta', () => {
  assert.deepEqual(E, { type: 'stdio', command: 'node', args: ['C:/Users/x/AppData/Roaming/Sloth/sloth-chat-mcp.cjs', '--cuenta', 'acc-1'], env: {} })
  assert.equal(esNuestra(E), true)
  assert.equal(esNuestra(otro), false)
})

test('alta en un .claude.json vacío', () => {
  const r = aplicarRegistro({}, E)
  assert.deepEqual(r, { state: 'ok', json: { mcpServers: { sloth: E } } })
})

test('alta idempotente: la segunda vez no hay nada que escribir', () => {
  const r = aplicarRegistro({}, E)
  assert.deepEqual(aplicarRegistro(r.json ?? {}, E), { state: 'ok' })
})

test('alta conserva otros servidores y claves sin mutar la entrada', () => {
  const json = { numStartups: 3, mcpServers: { otro } }
  const antes = JSON.stringify(json)
  const r = aplicarRegistro(json, E)
  assert.equal(JSON.stringify(json), antes)
  assert.deepEqual(r.json, { numStartups: 3, mcpServers: { otro, sloth: E } })
})

test('actualiza una ruta vieja nuestra', () => {
  const vieja = entradaMcp('D:/viejo/sloth-chat-mcp.cjs', 'acc-1')
  const r = aplicarRegistro({ mcpServers: { sloth: vieja } }, E)
  assert.deepEqual(r, { state: 'ok', json: { mcpServers: { sloth: E } } })
})

test('la entrada de E1 sin cuenta, o con otra cuenta, se reescribe', () => {
  const sinCuenta = { type: 'stdio', command: 'node', args: ['C:/Users/x/AppData/Roaming/Sloth/sloth-chat-mcp.cjs'], env: {} }
  assert.deepEqual(aplicarRegistro({ mcpServers: { sloth: sinCuenta } }, E), { state: 'ok', json: { mcpServers: { sloth: E } } })
  const otraCuenta = entradaMcp('C:/Users/x/AppData/Roaming/Sloth/sloth-chat-mcp.cjs', 'acc-2')
  assert.deepEqual(aplicarRegistro({ mcpServers: { sloth: otraCuenta } }, E), { state: 'ok', json: { mcpServers: { sloth: E } } })
})

test('un sloth ajeno es conflicto y no se toca', () => {
  assert.deepEqual(aplicarRegistro({ mcpServers: { sloth: otro } }, E), { state: 'conflicto' })
})

test('baja de la nuestra', () => {
  const r = aplicarRegistro({ a: 1, mcpServers: { otro, sloth: E } }, null)
  assert.deepEqual(r, { state: 'ok', json: { a: 1, mcpServers: { otro } } })
})

test('baja con una ajena no cambia nada', () => {
  assert.deepEqual(aplicarRegistro({ mcpServers: { sloth: otro } }, null), { state: 'ok' })
  assert.deepEqual(aplicarRegistro({}, null), { state: 'ok' })
})

test('mcpServers que no es objeto es conflicto', () => {
  assert.deepEqual(aplicarRegistro({ mcpServers: [] }, E), { state: 'conflicto' })
  assert.deepEqual(aplicarRegistro({ mcpServers: 'x' }, null), { state: 'conflicto' })
})
