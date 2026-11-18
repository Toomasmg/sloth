import { test } from 'node:test'
import assert from 'node:assert/strict'
import { entornoLimpio } from './env-limpio'
import { PROVEEDORES, armarEnvCuenta, proveedorDe } from './proveedores'
import { claudeWithPrompt, shellLaunch, type ShellFamily } from './shell-args'

const EXE = 'C:\Users\yo\.local\bin\claude.exe'
const FAMILIAS: ShellFamily[] = ['cmd', 'ps', 'posix']

interface Modo {
  continuar?: boolean
  resumir?: string
  prompt?: string
}

// Lo que armaban claudeCommand (index.ts) y los overrides de features antes de pasar por el proveedor.
function argvAnterior(m: Modo): string[] {
  if (m.prompt) return claudeWithPrompt(m.prompt)
  if (m.resumir) return 'claude --resume abc-123'.trim().split(/\s+/)
  if (m.continuar) return ['claude', '--continue']
  return ['claude']
}

const MODOS: Array<[string, Modo]> = [
  ['nuevo', {}],
  ['continuar', { continuar: true }],
  ['resumir', { resumir: 'abc-123' }],
  ['con prompt', { prompt: '/ticket PROJ-12' }],
  ['con prompt que parece opción', { prompt: '--dangerously\nhola "mundo" & más' }],
  ['con prompt y continuar', { prompt: 'hola', continuar: true }]
]

for (const [nombre, modo] of MODOS) {
  test(`argv y lanzamiento de claude idénticos a los de antes: ${nombre}`, () => {
    const p = proveedorDe({})
    const ahora = p.argvInteractivo(modo)
    assert.equal(JSON.stringify(ahora), JSON.stringify(argvAnterior(modo)))
    for (const f of FAMILIAS) {
      assert.equal(JSON.stringify(shellLaunch(f, ahora, EXE)), JSON.stringify(shellLaunch(f, argvAnterior(modo), EXE)), f)
      assert.equal(JSON.stringify(shellLaunch(f, ahora, undefined)), JSON.stringify(shellLaunch(f, argvAnterior(modo), undefined)), `${f} sin exe`)
    }
  })
}

test('el env de la terminal con CLAUDE_CONFIG_DIR es idéntico al de antes', () => {
  const origen: NodeJS.ProcessEnv = { PATH: 'C:\bin', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: 'C:\otra', ANTHROPIC_API_KEY: 'k', SLOTH_X: '1', HOME: 'C:\h' }
  const acc = { configDir: 'C:/sloth/accounts/a/claude', label: 'Trabajo', proveedor: undefined }
  const anterior = { ...entornoLimpio(origen, (k) => k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_CONFIG_DIR' || k === 'ANTHROPIC_API_KEY' || k === 'ANTHROPIC_AUTH_TOKEN'), CLAUDE_CONFIG_DIR: acc.configDir, SLOTH_ACCOUNT: acc.label }
  const p = proveedorDe(acc)
  const ahora = armarEnvCuenta(p, acc, entornoLimpio(origen, p.quitarDelEntorno))
  assert.equal(JSON.stringify(ahora), JSON.stringify(anterior))
})

test('un proveedor desconocido en la cuenta se resuelve a claude y nunca a otro comando', () => {
  for (const proveedor of ['codex', '', 'CLAUDE', 42, null, {}, ['claude']]) {
    const p = proveedorDe({ proveedor })
    assert.equal(p, PROVEEDORES.claude)
    assert.equal(p.argvInteractivo({})[0], 'claude')
  }
})
