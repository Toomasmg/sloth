import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { entornoLimpio } from './env-limpio'
import { argvPanelCuenta, armarEnvCuenta, proveedorExigido, PROVEEDORES } from './proveedores'
import { loginDeConfigCopilot } from './proveedor-copilot'
import { PROMPT_VAR, pastePayload, shellLaunch, type ShellFamily } from './shell-args'

const copilot = PROVEEDORES.copilot
const FAMILIAS: ShellFamily[] = ['ps', 'cmd', 'posix']
const PROMPT_RARO = 'hola "x" & y'
const FLAGS_DE_PERMISOS = ['--allow-all', '--yolo', '--allow-all-tools', '--allow-all-paths', '--allow-all-urls']

function carpeta(): string {
  return mkdtempSync(join(tmpdir(), 'sloth-copilot-'))
}

function lineaDeShell(f: ShellFamily, args: string[]): string {
  return f === 'ps' ? Buffer.from(args[args.length - 1], 'base64').toString('utf16le') : args.join('\n')
}

test('copilot: rutas, capacidades y login', () => {
  assert.deepEqual([copilot.id, copilot.envConfigDir, copilot.subcarpetaCuenta, copilot.archivoMeta, copilot.carpetaHistorial], ['copilot', 'COPILOT_HOME', 'copilot', 'config.json', 'session-state'])
  assert.equal(Object.values(copilot.capacidades).some(Boolean), false)
  assert.deepEqual(copilot.argvLogin(), ['copilot', 'login', '--device-code'])
  assert.deepEqual(copilot.envCuenta('C:/x'), { COPILOT_HOME: 'C:/x', COPILOT_AUTO_UPDATE: 'false' })
  assert.equal(proveedorExigido({ proveedor: 'copilot' }), copilot)
  assert.deepEqual(argvPanelCuenta(copilot, false), ['copilot', 'login', '--device-code'])
  assert.deepEqual(argvPanelCuenta(copilot, true), ['copilot'])
})

test('copilot: argv nuevo, continuar y con prompt en una sola línea tras --', () => {
  assert.deepEqual(copilot.argvInteractivo({}), ['copilot'])
  assert.deepEqual(copilot.argvInteractivo({ continuar: true }), ['copilot'])
  assert.deepEqual(copilot.argvInteractivo({ prompt: '--allow-all' }), ['copilot', '--', '--allow-all'])
  assert.deepEqual(copilot.argvInteractivo({ prompt: 'a\nb "c" & d' }), ['copilot', '--', 'a b "c" & d'])
})

test('copilot: ningún argv lleva flags de permisos fuera del operando tras --', () => {
  const todos = [copilot.argvInteractivo({}), copilot.argvInteractivo({ prompt: '--yolo' }), copilot.argvLogin()]
  for (const a of todos) {
    const i = a.indexOf('--')
    const flags = i === -1 ? a : a.slice(0, i)
    for (const f of FLAGS_DE_PERMISOS) assert.equal(flags.includes(f), false, f)
  }
})

test('copilot: quitarDelEntorno saca tokens y claves de otros agentes y no el resto', () => {
  for (const k of ['COPILOT_GITHUB_TOKEN', 'COPILOT_HOME', 'COPILOT_ALLOW_ALL', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'OPENAI_API_KEY', 'CODEX_HOME']) {
    assert.equal(copilot.quitarDelEntorno(k), true, k)
  }
  for (const k of ['PATH', 'GITHUB_ACTIONS', 'GITHUB_WORKSPACE', 'HOME', 'USERPROFILE', 'SLOTH_X']) assert.equal(copilot.quitarDelEntorno(k), false, k)
})

test('claude y codex no quitan las variables de GitHub', () => {
  for (const id of ['claude', 'codex'] as const) {
    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN']) assert.equal(PROVEEDORES[id].quitarDelEntorno(k), false, `${id} ${k}`)
  }
})

test('copilot: el entorno de la cuenta no trae tokens y sí COPILOT_HOME, COPILOT_AUTO_UPDATE y SLOTH_ACCOUNT', () => {
  const origen: NodeJS.ProcessEnv = {
    PATH: 'p', HOME: 'h', GH_TOKEN: 'a', GITHUB_TOKEN: 'b', COPILOT_GITHUB_TOKEN: 'c', GH_ENTERPRISE_TOKEN: 'd', COPILOT_HOME: 'C:\\otra',
    COPILOT_AUTO_UPDATE: 'true', ANTHROPIC_API_KEY: 'e', OPENAI_API_KEY: 'f', CODEX_HOME: 'g', gh_token: 'h', SLOTH_PROMPT: 'z'
  }
  const env = armarEnvCuenta(copilot, { configDir: 'C:/x', label: 'Mi cuenta' }, entornoLimpio(origen, copilot.quitarDelEntorno))
  assert.deepEqual(Object.entries(env), [['PATH', 'p'], ['HOME', 'h'], ['TERM_PROGRAM', 'Sloth'], ['COPILOT_HOME', 'C:/x'], ['COPILOT_AUTO_UPDATE', 'false'], ['SLOTH_ACCOUNT', 'Mi cuenta']])
})

test('shellLaunch con copilot sin exe o con copilot.cmd: el prompt nunca llega a la línea de la shell y queda en paste', () => {
  const argv = copilot.argvInteractivo({ prompt: PROMPT_RARO })
  for (const f of FAMILIAS) {
    for (const exe of [undefined, 'C:\\bin\\copilot.cmd']) {
      const l = shellLaunch(f, argv, exe)
      const linea = lineaDeShell(f, l.args)
      assert.equal(linea.includes('hola'), false, `${f} ${exe}`)
      assert.equal(linea.includes(' -- '), false, `${f} ${exe}`)
      assert.equal(l.paste, PROMPT_RARO, `${f} ${exe}`)
      assert.deepEqual(l.env, {})
      assert.equal(pastePayload(l.paste ?? '').includes('hola'), true)
    }
  }
})

test('shellLaunch con copilot.exe: el prompt queda en paste en las tres familias, sin SLOTH_PROMPT ni --', () => {
  const argv = copilot.argvInteractivo({ prompt: PROMPT_RARO })
  for (const f of FAMILIAS) {
    const l = shellLaunch(f, argv, 'C:\\bin\\copilot.exe')
    assert.equal(l.paste, PROMPT_RARO, f)
    assert.equal(PROMPT_VAR in l.env, false, f)
    const linea = lineaDeShell(f, l.args)
    assert.equal(linea.includes('hola'), false, f)
    assert.equal(linea.includes(' -- '), false, f)
    assert.equal(linea.includes('copilot.exe'), true, f)
  }
})

test('shellLaunch con copilot: un prompt que parece subcomando o flag también queda en paste, fuera de la línea', () => {
  for (const prompt of ['config', '--allow-all', 'update']) {
    for (const f of FAMILIAS) {
      const l = shellLaunch(f, copilot.argvInteractivo({ prompt }), 'C:\\bin\\copilot.exe')
      assert.equal(l.paste, prompt, `${f} ${prompt}`)
      assert.deepEqual(l.env, {}, f)
      assert.equal(lineaDeShell(f, l.args).includes(prompt), false, `${f} ${prompt}`)
    }
  }
})

test('shellLaunch con copilot sin prompt: PowerShell llama al .cmd por ruta y cmd sin ruta no mira la carpeta del repo', () => {
  const argv = copilot.argvInteractivo({})
  const cmd = String.raw`C:\Users\Tomás\AppData\Roaming\npm\copilot.cmd`
  assert.equal(lineaDeShell('ps', shellLaunch('ps', argv, cmd).args), `& '${cmd}'`)
  assert.equal(lineaDeShell('ps', shellLaunch('ps', argv, undefined).args), '& copilot')
  for (const f of ['cmd', 'posix'] as const) {
    assert.deepEqual(shellLaunch(f, argv, cmd).args, shellLaunch(f, argv, undefined).args, f)
  }
  assert.match(shellLaunch('cmd', argv, undefined).args[1], /^set NoDefaultCurrentDirectoryInExePath=1& copilot& set /)
  assert.equal(lineaDeShell('posix', shellLaunch('posix', argv, undefined).args).includes('copilot'), true)
})

test('shellLaunch en PowerShell con un .cmd de ruta rara no la arma a ciegas', () => {
  const argv = copilot.argvInteractivo({})
  const sinRuta = lineaDeShell('ps', shellLaunch('ps', argv, undefined).args)
  for (const cmd of ['C:\\a&b\\copilot.cmd', 'C:\\a%PATH%\\copilot.cmd', 'C:\\a"b\\copilot.cmd', 'C:\\a^b\\copilot.cmd', 'C:\\a\\copilot.bat']) {
    assert.equal(lineaDeShell('ps', shellLaunch('ps', argv, cmd).args), sinRuta, JSON.stringify(cmd))
  }
})

test('claude y codex: shellLaunch da lo mismo que antes de sumar Copilot', () => {
  const codexArgv = ['codex', '-s', 'workspace-write', '-a', 'on-request', '--no-daemon']
  const cmd = 'C:\\bin\\codex.cmd'
  assert.equal(lineaDeShell('ps', shellLaunch('ps', codexArgv, cmd).args), `& ${cmd} -s workspace-write -a on-request --no-daemon`)
  assert.deepEqual(shellLaunch('cmd', codexArgv, cmd).args, ['/k', 'set NoDefaultCurrentDirectoryInExePath=1& codex -s workspace-write -a on-request --no-daemon& set NoDefaultCurrentDirectoryInExePath='])
  const conPrompt = shellLaunch('ps', ['codex', '--', 'Revisá el ticket'], 'C:\\bin\\codex.exe')
  assert.equal(conPrompt.paste, undefined)
  assert.equal(conPrompt.env[PROMPT_VAR], '"Revisá el ticket"')
  const claudeExe = shellLaunch('posix', ['claude', '--', 'Revisá el ticket'], 'C:\\bin\\claude.exe')
  assert.equal(claudeExe.paste, undefined)
  assert.equal(claudeExe.env[PROMPT_VAR], 'Revisá el ticket')
  assert.equal(lineaDeShell('ps', shellLaunch('ps', ['claude'], 'C:\\bin\\claude.cmd').args), '& claude')
})

test('loginDeConfigCopilot: solo hay sesión con un usuario en loggedInUsers (lastLoggedInUser puede quedar tras un logout)', () => {
  assert.deepEqual(loginDeConfigCopilot({ loggedInUsers: [{ host: 'https://github.com', login: 'x' }] }), { loggedIn: true })
  for (const j of [{ loggedInUsers: [] }, { loggedInUsers: 'x' }, { lastLoggedInUser: { login: 'x' } }, { loggedInUsers: [], lastLoggedInUser: { login: 'x' } }, {}, [], null, 'x', 3, undefined]) {
    assert.deepEqual(loginDeConfigCopilot(j), { loggedIn: false }, JSON.stringify(j))
  }
})

test('estadoLogin lee solo config.json: sin archivo, vacío, roto o con BOM', () => {
  const d = carpeta()
  try {
    assert.deepEqual(copilot.estadoLogin(d), { loggedIn: false })
    writeFileSync(join(d, 'config.json'), '{"loggedInUsers":[{"login":"x"}]}')
    assert.deepEqual(copilot.estadoLogin(d), { loggedIn: true })
    writeFileSync(join(d, 'config.json'), '{"loggedInUsers":[]}')
    assert.deepEqual(copilot.estadoLogin(d), { loggedIn: false })
    writeFileSync(join(d, 'config.json'), '{roto')
    assert.deepEqual(copilot.estadoLogin(d), { loggedIn: false })
    writeFileSync(join(d, 'config.json'), '\uFEFF{"loggedInUsers":[{"login":"x"}]}')
    assert.deepEqual(copilot.estadoLogin(d), { loggedIn: true })
    writeFileSync(join(d, 'config.json'), '{"lastLoggedInUser":{"login":"x"}}')
    assert.deepEqual(copilot.estadoLogin(d), { loggedIn: false })
    assert.deepEqual(copilot.estadoLogin(join(d, 'no-existe')), { loggedIn: false })
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('estadoLogin no lee un config.json que no es un archivo regular ni uno enorme', () => {
  const d = carpeta()
  try {
    mkdirSync(join(d, 'config.json'))
    assert.deepEqual(copilot.estadoLogin(d), { loggedIn: false })
    rmSync(join(d, 'config.json'), { recursive: true })
    const usuarios = '{"loggedInUsers":[{"login":"x"}],"relleno":"' + 'a'.repeat(1024 * 1024) + '"}'
    writeFileSync(join(d, 'config.json'), usuarios)
    assert.deepEqual(copilot.estadoLogin(d), { loggedIn: false })
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('prepararCarpeta crea la carpeta y puede correr dos veces', () => {
  const d = carpeta()
  try {
    const cuenta = join(d, 'a', 'copilot')
    copilot.prepararCarpeta(cuenta)
    copilot.prepararCarpeta(cuenta)
    assert.equal(existsSync(cuenta), true)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('hayConversacionPrevia es siempre falso: copilot abre una sesión nueva', () => {
  assert.equal(copilot.hayConversacionPrevia('C:/x', 'C:/repo'), false)
})
