import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { entornoLimpio } from './env-limpio'
import { argvPanelCuenta, armarEnvCuenta, proveedorExigido, PROVEEDORES } from './proveedores'
import { CONFIG_INICIAL } from './proveedor-codex'
import { PROMPT_VAR, pastePayload, shellLaunch, type ShellFamily } from './shell-args'

const codex = PROVEEDORES.codex
const FAMILIAS: ShellFamily[] = ['ps', 'cmd', 'posix']
const SEGURO = ['-s', 'workspace-write', '-a', 'on-request', '--no-daemon']
const PROMPT_RARO = '--dangerously-bypass\nhola "mundo" & más $(x) `y`'

function carpeta(): string {
  return mkdtempSync(join(tmpdir(), 'sloth-codex-'))
}

function lineaDeShell(f: ShellFamily, args: string[]): string {
  return f === 'ps' ? Buffer.from(args[args.length - 1], 'base64').toString('utf16le') : args.join('\n')
}

test('codex: rutas, capacidades y login', () => {
  assert.deepEqual([codex.id, codex.envConfigDir, codex.subcarpetaCuenta, codex.archivoMeta, codex.carpetaHistorial], ['codex', 'CODEX_HOME', 'codex', 'config.toml', 'sessions'])
  assert.deepEqual(Object.entries(codex.capacidades).filter(([, v]) => v).map(([k]) => k), ['avisoTurno', 'limitesExperimental'])
  assert.deepEqual(codex.argvLogin(), ['codex', 'login'])
  assert.equal(codex.comoInstalar, 'npm install -g @openai/codex')
  assert.deepEqual(codex.envCuenta('C:/x'), { CODEX_HOME: 'C:/x' })
  assert.equal(proveedorExigido({ proveedor: 'codex' }), codex)
})

test('codex: argv nuevo, continuar y con prompt', () => {
  assert.deepEqual(codex.argvInteractivo({}), ['codex', ...SEGURO])
  assert.deepEqual(codex.argvInteractivo({ continuar: true }), ['codex', ...SEGURO])
  assert.deepEqual(codex.argvInteractivo({ prompt: '--x' }), ['codex', ...SEGURO, '--', '--x'])
  assert.deepEqual(codex.argvInteractivo({ prompt: 'a\nb\t"c"', continuar: true }), ['codex', ...SEGURO, '--', 'a b "c"'])
})

test('codex: ningún argv lleva opciones que saltan permisos o sandbox', () => {
  const todos = [codex.argvInteractivo({}), codex.argvInteractivo({ prompt: 'hola' }), codex.argvLogin()]
  for (const a of todos) {
    for (const x of a) assert.equal(x.includes('--dangerously'), false, x)
    assert.equal(a.includes('danger-full-access'), false)
  }
})

test('codex: quitarDelEntorno saca las claves de otros agentes y no el PATH', () => {
  for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDECODE', 'AZURE_OPENAI_API_KEY', 'MISTRAL_API_KEY']) {
    assert.equal(codex.quitarDelEntorno(k), true, k)
  }
  for (const k of ['PATH', 'HOME', 'SLOTH_X', 'USERPROFILE']) assert.equal(codex.quitarDelEntorno(k), false, k)
})

test('claude no quita las claves de OpenAI', () => {
  assert.equal(PROVEEDORES.claude.quitarDelEntorno('OPENAI_API_KEY'), false)
  assert.equal(PROVEEDORES.claude.quitarDelEntorno('CODEX_HOME'), false)
})

test('codex: armarEnvCuenta pone base, CODEX_HOME y SLOTH_ACCOUNT en ese orden', () => {
  const origen: NodeJS.ProcessEnv = { PATH: 'p', OPENAI_API_KEY: 'k', CODEX_HOME: 'C:\\otra', CLAUDE_CONFIG_DIR: 'C:\\c', ANTHROPIC_API_KEY: 'a', HOME: 'h' }
  const env = armarEnvCuenta(codex, { configDir: 'C:/x', label: 'Mi cuenta' }, entornoLimpio(origen, codex.quitarDelEntorno))
  assert.deepEqual(Object.entries(env), [['PATH', 'p'], ['HOME', 'h'], ['TERM_PROGRAM', 'Sloth'], ['CODEX_HOME', 'C:/x'], ['SLOTH_ACCOUNT', 'Mi cuenta']])
})

test('shellLaunch sin .exe o con codex.cmd: el prompt nunca llega a la línea de la shell', () => {
  const argv = codex.argvInteractivo({ prompt: PROMPT_RARO })
  for (const f of FAMILIAS) {
    for (const exe of [undefined, 'C:\\bin\\codex.cmd']) {
      const l = shellLaunch(f, argv, exe)
      for (const trozo of ['dangerously-bypass', 'mundo', '$(x)']) {
        assert.equal(lineaDeShell(f, l.args).includes(trozo), false, `${f} ${exe}: ${trozo}`)
      }
      assert.equal(l.paste?.includes('dangerously-bypass'), true, f)
      assert.deepEqual(l.env, {})
      assert.equal(pastePayload(l.paste ?? '').includes('mundo'), true)
    }
  }
})

test('shellLaunch con codex.exe: el prompt común va por SLOTH_PROMPT en ps y posix y se pega en cmd', () => {
  const exe = 'C:\\bin\\codex.exe'
  const argv = codex.argvInteractivo({ prompt: 'Revisá el ticket PROJ-12' })
  for (const f of ['ps', 'posix'] as const) {
    const l = shellLaunch(f, argv, exe)
    assert.equal(l.paste, undefined, f)
    assert.equal(PROMPT_VAR in l.env, true, f)
    assert.equal(lineaDeShell(f, l.args).includes('PROJ-12'), false, f)
  }
  const c = shellLaunch('cmd', argv, exe)
  assert.equal(c.paste, 'Revisá el ticket PROJ-12')
  assert.deepEqual(c.env, {})
  assert.equal(c.args.join(' ').includes('PROJ-12'), false)
})

test('shellLaunch con codex: un prompt que parece subcomando se pega, nunca va por la variable', () => {
  const argv = codex.argvInteractivo({ prompt: 'exec' })
  for (const f of FAMILIAS) {
    const l = shellLaunch(f, argv, 'C:\\bin\\codex.exe')
    assert.equal(l.paste, 'exec', f)
    assert.deepEqual(l.env, {}, f)
  }
})

test('shellLaunch con codex sin prompt: sin .exe la línea corre codex y no claude', () => {
  const argv = codex.argvInteractivo({})
  for (const f of FAMILIAS) {
    const l = shellLaunch(f, argv, undefined)
    assert.equal(lineaDeShell(f, l.args).includes('codex'), true, f)
    assert.equal(lineaDeShell(f, l.args).includes('claude'), false, f)
  }
})

test('shellLaunch en PowerShell con codex.cmd llama al .cmd por ruta; en cmd y posix queda el nombre', () => {
  const argv = codex.argvInteractivo({})
  const cmd = String.raw`C:\Users\Tomás\AppData\Roaming\npm\codex.cmd`
  assert.equal(lineaDeShell('ps', shellLaunch('ps', argv, cmd).args), `& '${cmd}' ${SEGURO.join(' ')}`)
  for (const f of ['cmd', 'posix'] as const) {
    assert.deepEqual(shellLaunch(f, argv, cmd).args, shellLaunch(f, argv, undefined).args, f)
  }
})

test('shellLaunch en PowerShell con un .cmd de ruta rara no la arma a ciegas: queda el nombre', () => {
  const argv = codex.argvInteractivo({})
  const sinRuta = lineaDeShell('ps', shellLaunch('ps', argv, undefined).args)
  const raras = ['C:\\a&b\\codex.cmd', 'C:\\a%PATH%\\codex.cmd', 'C:\\a"b\\codex.cmd', 'C:\\a^b\\codex.cmd', 'C:\\a!b\\codex.cmd', 'C:\\a\nb\\codex.cmd', 'C:\\a<b\\codex.cmd', 'C:\\a|b\\codex.cmd', 'C:\\a\\codex.bat']
  for (const cmd of raras) {
    assert.equal(lineaDeShell('ps', shellLaunch('ps', argv, cmd).args), sinRuta, JSON.stringify(cmd))
  }
})

test('shellLaunch en PowerShell con codex.cmd y un prompt peligroso: el prompt nunca está en la línea', () => {
  const cmd = 'C:\\bin\\codex.cmd'
  const l = shellLaunch('ps', codex.argvInteractivo({ prompt: PROMPT_RARO }), cmd)
  const linea = lineaDeShell('ps', l.args)
  assert.equal(linea, `& ${cmd} ${SEGURO.join(' ')}`)
  assert.equal(linea.includes('dangerously-bypass'), false)
  assert.equal(l.paste?.includes('dangerously-bypass'), true)
  assert.deepEqual(l.env, {})
})

test('prepararCarpeta crea config.toml, no pisa uno existente y no deja tmp', () => {
  const d = carpeta()
  try {
    const cuenta = join(d, 'a', 'codex')
    codex.prepararCarpeta(cuenta)
    assert.equal(readFileSync(join(cuenta, 'config.toml'), 'utf8'), CONFIG_INICIAL)
    assert.deepEqual(readdirSync(cuenta), ['config.toml'])

    const propia = join(d, 'b')
    mkdirSync(propia)
    writeFileSync(join(propia, 'config.toml'), 'model = "x"\n')
    codex.prepararCarpeta(propia)
    assert.equal(readFileSync(join(propia, 'config.toml'), 'utf8'), 'model = "x"\n')
    assert.deepEqual(readdirSync(propia), ['config.toml'])
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('prepararCarpeta no falla por un tmp que quedó de antes y puede correr dos veces', () => {
  const d = carpeta()
  try {
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, `config.toml.tmp-${process.pid}`), 'resto')
    codex.prepararCarpeta(d)
    codex.prepararCarpeta(d)
    assert.equal(readFileSync(join(d, 'config.toml'), 'utf8'), CONFIG_INICIAL)
    assert.deepEqual(readdirSync(d).sort(), ['config.toml', `config.toml.tmp-${process.pid}`])
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('estadoLogin solo mira si auth.json existe', () => {
  const d = carpeta()
  try {
    assert.deepEqual(codex.estadoLogin(d), { loggedIn: false })
    writeFileSync(join(d, 'auth.json'), '')
    assert.deepEqual(codex.estadoLogin(d), { loggedIn: true })
    assert.equal(existsSync(join(d, 'auth.json')), true)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('hayConversacionPrevia no deduce nada de los rollouts: sin certeza no hay resume', () => {
  const d = carpeta()
  try {
    const dia = join(d, 'sessions', '2026', '11', '17')
    mkdirSync(dia, { recursive: true })
    writeFileSync(join(dia, 'rollout-2026-11-17T10-00-00-0b9f6b1e-3c7a-4d2e-9a51-6f1c2d3e4f50.jsonl'), '')
    assert.equal(codex.hayConversacionPrevia(d, 'C:/otro-repo'), false)
    for (const continuar of [true, false]) assert.equal(codex.argvInteractivo({ continuar }).includes('resume'), false)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})
