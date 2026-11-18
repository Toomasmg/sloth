import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hayPowerShell7, resolverCopilotExe, versionCopilotOk, type DepsPowerShell } from './copilot-exe'

const conArchivos = (...ps: string[]) => (p: string): boolean => ps.includes(p)

test('win32: prefiere copilot.exe, usa copilot.cmd y ignora el shim sin extensión', () => {
  const env = { PATH: 'C:\\a;C:\\b' }
  assert.equal(resolverCopilotExe(env, conArchivos('C:\\a\\copilot.cmd', 'C:\\a\\copilot.exe'), 'win32'), 'C:\\a\\copilot.exe')
  assert.equal(resolverCopilotExe(env, conArchivos('C:\\b\\copilot.cmd'), 'win32'), 'C:\\b\\copilot.cmd')
  assert.equal(resolverCopilotExe(env, conArchivos('C:\\a\\copilot', 'C:\\b\\copilot'), 'win32'), undefined)
  assert.equal(resolverCopilotExe({ Path: 'C:\\a' }, conArchivos('C:\\a\\copilot.cmd'), 'win32'), 'C:\\a\\copilot.cmd')
})

test('una entrada relativa del PATH no se resuelve contra el cwd', () => {
  assert.equal(resolverCopilotExe({ PATH: '.;C:\\a' }, conArchivos('.\\copilot.exe'), 'win32'), undefined)
  assert.equal(resolverCopilotExe({ PATH: '.:bin:/usr/bin' }, conArchivos('./copilot', 'bin/copilot'), 'linux'), undefined)
  assert.equal(resolverCopilotExe({ PATH: '.;C:\\a' }, conArchivos('C:\\a\\copilot.exe'), 'win32'), 'C:\\a\\copilot.exe')
})

test('posix: busca copilot en cada carpeta del PATH', () => {
  assert.equal(resolverCopilotExe({ PATH: '/x:/usr/bin' }, conArchivos('/usr/bin/copilot'), 'linux'), '/usr/bin/copilot')
  assert.equal(resolverCopilotExe({ PATH: '/x' }, conArchivos('/x/copilot.cmd'), 'linux'), undefined)
  assert.equal(resolverCopilotExe({}, () => true, 'linux'), undefined)
})

test('versionCopilotOk: 1.0.100 en adelante sirve, una más vieja no y un texto raro tampoco', () => {
  assert.deepEqual(versionCopilotOk('1.0.113'), { version: '1.0.113', ok: true })
  assert.deepEqual(versionCopilotOk('GitHub Copilot CLI 1.0.100'), { version: '1.0.100', ok: true })
  assert.deepEqual(versionCopilotOk('2.0.0\n'), { version: '2.0.0', ok: true })
  assert.deepEqual(versionCopilotOk('0.9.9'), { version: '0.9.9', ok: false })
  assert.deepEqual(versionCopilotOk('1.0.99'), { version: '1.0.99', ok: false })
  assert.deepEqual(versionCopilotOk('basura'), { ok: false })
  assert.deepEqual(versionCopilotOk(''), { ok: false })
})

function depsPwsh(existentes: string[], versiones: Record<string, string>): { deps: DepsPowerShell; corridos: string[] } {
  const corridos: string[] = []
  return {
    corridos,
    deps: {
      existe: conArchivos(...existentes),
      mayor: async (exe) => {
        corridos.push(exe)
        return versiones[exe]
      }
    }
  }
}

test('hayPowerShell7: pwsh en el PATH o en Program Files cuenta si responde una versión 6 o más', async () => {
  const a = depsPwsh(['C:\\b\\pwsh.exe'], { 'C:\\b\\pwsh.exe': '7\r\n' })
  assert.equal(await hayPowerShell7({ PATH: 'C:\\a;C:\\b' }, 'win32', a.deps), true)
  const b = depsPwsh(['C:\\Program Files\\PowerShell\\7\\pwsh.exe'], { 'C:\\Program Files\\PowerShell\\7\\pwsh.exe': '7' })
  assert.equal(await hayPowerShell7({ PATH: 'C:\\a' }, 'win32', b.deps), true)
  const c = depsPwsh(['D:\\Programas\\PowerShell\\7-preview\\pwsh.exe'], { 'D:\\Programas\\PowerShell\\7-preview\\pwsh.exe': '7' })
  assert.equal(await hayPowerShell7({ PATH: '', ProgramFiles: 'D:\\Programas' }, 'win32', c.deps), true)
})

test('hayPowerShell7: el pwsh de Microsoft Store (alias que existsSync no ve) se reconoce corriéndolo', async () => {
  const alias = 'C:\\Users\\t\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'
  const enPath = depsPwsh([], { [alias]: '7' })
  assert.equal(await hayPowerShell7({ PATH: 'C:\\Users\\t\\AppData\\Local\\Microsoft\\WindowsApps' }, 'win32', enPath.deps), true)
  assert.deepEqual(enPath.corridos, [alias])
  const sinPath = depsPwsh([], { [alias]: '7' })
  assert.equal(await hayPowerShell7({ PATH: 'C:\\a', LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' }, 'win32', sinPath.deps), true)
  const sinAlias = depsPwsh([], {})
  assert.equal(await hayPowerShell7({ PATH: 'C:\\Users\\t\\AppData\\Local\\Microsoft\\WindowsApps', LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' }, 'win32', sinAlias.deps), false)
})

test('hayPowerShell7: powershell.exe 5.1, una versión 5 o una salida rara no cuentan, y nunca se corre otro ejecutable', async () => {
  const solo51 = depsPwsh(['C:\\a\\powershell.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'], { 'C:\\a\\powershell.exe': '5' })
  assert.equal(await hayPowerShell7({ PATH: 'C:\\a;C:\\Windows\\System32\\WindowsPowerShell\\v1.0' }, 'win32', solo51.deps), false)
  assert.deepEqual(solo51.corridos, [])
  for (const salida of ['5', '5\r\n', '', 'error', '7 8', undefined]) {
    const d = depsPwsh(['C:\\a\\pwsh.exe'], salida === undefined ? {} : { 'C:\\a\\pwsh.exe': salida })
    assert.equal(await hayPowerShell7({ PATH: 'C:\\a' }, 'win32', d.deps), false, String(salida))
  }
})

test('hayPowerShell7: una entrada relativa del PATH no se corre, se prueba el resto y fuera de Windows no hace falta', async () => {
  const d = depsPwsh(['.\\pwsh.exe', 'C:\\b\\pwsh.exe'], { '.\\pwsh.exe': '7', 'C:\\b\\pwsh.exe': '5' })
  assert.equal(await hayPowerShell7({ PATH: '.;C:\\b' }, 'win32', d.deps), false)
  assert.deepEqual(d.corridos, ['C:\\b\\pwsh.exe'])
  assert.equal(await hayPowerShell7({}, 'win32', depsPwsh([], {}).deps), false)
  const linux = depsPwsh([], {})
  assert.equal(await hayPowerShell7({}, 'linux', linux.deps), true)
  assert.deepEqual(linux.corridos, [])
})
