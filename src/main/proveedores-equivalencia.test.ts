import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { entornoLimpio } from './env-limpio'
import { armarEnvCuenta, proveedorExigido } from './proveedores'
import { shellLaunch, type ShellFamily } from './shell-args'

interface Modo {
  nombre: string
  argv: string[]
  lanzamiento: Record<ShellFamily, { conExe: unknown; sinExe: unknown }>
}

// Datos generados con el shell-args.ts de staging: la argv que armaba claudeCommand y lo que shellLaunch devolvía con ella.
const fixtures = JSON.parse(readFileSync(new URL('./proveedores-equivalencia.fixtures.json', import.meta.url), 'utf8')) as { exe: string; modos: Modo[] }

// El JSON no guarda las claves undefined.
const plano = (x: unknown): unknown => JSON.parse(JSON.stringify(x))

const ENTRADAS: Record<string, { continuar?: boolean; prompt?: string }> = {
  nuevo: {},
  continuar: { continuar: true },
  'con prompt': { prompt: '/ticket PROJ-12' },
  'con prompt que parece opción': { prompt: '--dangerously\nhola "mundo" & más' },
  'con prompt y continuar': { prompt: 'hola', continuar: true }
}

for (const m of fixtures.modos) {
  test(`argv y lanzamiento de claude idénticos a los de staging: ${m.nombre}`, () => {
    const argv = proveedorExigido({}).argvInteractivo(ENTRADAS[m.nombre])
    assert.deepEqual(argv, m.argv)
    for (const f of Object.keys(m.lanzamiento) as ShellFamily[]) {
      assert.deepEqual(plano(shellLaunch(f, argv, fixtures.exe)), m.lanzamiento[f].conExe, f)
      assert.deepEqual(plano(shellLaunch(f, argv, undefined)), m.lanzamiento[f].sinExe, `${f} sin exe`)
    }
  })
}

test('el env de la terminal con CLAUDE_CONFIG_DIR es el de staging, con el mismo orden', () => {
  const origen: NodeJS.ProcessEnv = { PATH: 'C:\\bin', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: 'C:\\otra', ANTHROPIC_API_KEY: 'k', SLOTH_X: '1', HOME: 'C:\\h' }
  const acc = { configDir: 'C:/sloth/accounts/a/claude', label: 'Trabajo', proveedor: undefined }
  const p = proveedorExigido(acc)
  const env = armarEnvCuenta(p, acc, entornoLimpio(origen, p.quitarDelEntorno))
  assert.deepEqual(Object.entries(env), [
    ['PATH', 'C:\\bin'],
    ['HOME', 'C:\\h'],
    ['TERM_PROGRAM', 'Sloth'],
    ['CLAUDE_CONFIG_DIR', 'C:/sloth/accounts/a/claude'],
    ['SLOTH_ACCOUNT', 'Trabajo']
  ])
})

test('una cuenta con un proveedor que no se conoce nunca arma un spawn', () => {
  for (const proveedor of ['otro-agente', '', 'CLAUDE', ' claude', 'claude ', '__proto__', 'toString', 42, null, {}, ['claude']]) {
    assert.throws(() => proveedorExigido({ proveedor }), /no conoce; actualizá Sloth/, String(proveedor))
  }
})

test('las cuentas de antes, sin campo, siguen siendo claude', () => {
  assert.equal(proveedorExigido({}).id, 'claude')
  assert.equal(proveedorExigido({ proveedor: undefined }).id, 'claude')
  assert.equal(proveedorExigido({ proveedor: 'claude' }).id, 'claude')
})
