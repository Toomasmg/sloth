import { test } from 'node:test'
import assert from 'node:assert/strict'
import { entornoLimpio } from './env-limpio'
import { PROVEEDORES } from './proveedores'

function baseEnvAnterior(origen: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(origen)) {
    if (v === undefined) continue
    const key = k.toUpperCase()
    if (
      key === 'CLAUDECODE' ||
      key.startsWith('CLAUDE_CODE_') ||
      key === 'CLAUDE_CONFIG_DIR' ||
      key === 'ANTHROPIC_API_KEY' ||
      key === 'ANTHROPIC_AUTH_TOKEN' ||
      key.startsWith('ELECTRON_') ||
      key.startsWith('ANTIREA_') ||
      key.startsWith('SLOTH_')
    )
      continue
    env[k] = v
  }
  env.TERM_PROGRAM = 'Sloth'
  return env
}

const ORIGEN: NodeJS.ProcessEnv = {
  PATH: 'C:\bin',
  Path: 'C:\otro',
  CLAUDECODE: '1',
  claudecode: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  claude_code_x: 'x',
  CLAUDE_CONFIG_DIR: 'C:\viejo',
  Claude_Config_Dir: 'C:\viejo2',
  ANTHROPIC_API_KEY: 'k',
  anthropic_auth_token: 't',
  ANTHROPIC_BASE_URL: 'https://x',
  CLAUDE: 'no',
  ELECTRON_RUN_AS_NODE: '1',
  ANTIREA_X: '1',
  SLOTH_USER_DATA: 'C:\d',
  sloth_ws: 'w',
  TERM_PROGRAM: 'otra',
  VACIA: '',
  INDEFINIDA: undefined
}

test('entornoLimpio con el proveedor claude da lo mismo que baseEnv de antes, con el mismo orden', () => {
  const ahora = entornoLimpio(ORIGEN, PROVEEDORES.claude.quitarDelEntorno)
  const antes = baseEnvAnterior(ORIGEN)
  assert.deepEqual(ahora, antes)
  assert.equal(JSON.stringify(ahora), JSON.stringify(antes))
})

test('entornoLimpio: deja lo que no es del agente y siempre pone TERM_PROGRAM', () => {
  const e = entornoLimpio(ORIGEN, PROVEEDORES.claude.quitarDelEntorno)
  assert.equal(e.PATH, 'C:\bin')
  assert.equal(e.ANTHROPIC_BASE_URL, 'https://x')
  assert.equal(e.CLAUDE, 'no')
  assert.equal(e.VACIA, '')
  assert.equal(e.TERM_PROGRAM, 'Sloth')
  for (const k of ['CLAUDECODE', 'claudecode', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CONFIG_DIR', 'Claude_Config_Dir', 'ANTHROPIC_API_KEY', 'ELECTRON_RUN_AS_NODE', 'SLOTH_USER_DATA', 'INDEFINIDA']) {
    assert.equal(k in e, false, k)
  }
})
