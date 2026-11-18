import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROVEEDORES, proveedorDe } from './proveedores'
import { claudeWithPrompt } from './shell-args'

test('proveedorDe: sin campo o con un valor desconocido es claude', () => {
  assert.equal(proveedorDe({}), PROVEEDORES.claude)
  assert.equal(proveedorDe({ proveedor: 'codex' }), PROVEEDORES.claude)
})

test('claude: quitarDelEntorno', () => {
  const p = PROVEEDORES.claude
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_X', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) assert.equal(p.quitarDelEntorno(k), true, k)
  for (const k of ['PATH', 'SLOTH_X', 'ELECTRON_RUN_AS_NODE', 'CLAUDE']) assert.equal(p.quitarDelEntorno(k), false, k)
})

test('claude: env, rutas y argv', () => {
  const p = PROVEEDORES.claude
  assert.deepEqual(p.envCuenta('C:/x'), { CLAUDE_CONFIG_DIR: 'C:/x' })
  assert.deepEqual([p.comando, p.subcarpetaCuenta, p.archivoMeta, p.carpetaHistorial], ['claude', 'claude', '.claude.json', 'projects'])
  assert.deepEqual(p.argvInteractivo({}), ['claude'])
  assert.deepEqual(p.argvInteractivo({ continuar: true }), ['claude', '--continue'])
  assert.deepEqual(p.argvInteractivo({ resumir: 'abc' }), ['claude', '--resume', 'abc'])
  assert.deepEqual(p.argvInteractivo({ prompt: '--x\ny' }), claudeWithPrompt('--x\ny'))
  assert.deepEqual(p.argvInteractivo({ prompt: 'hola', continuar: true }), ['claude', '--', 'hola'])
})
