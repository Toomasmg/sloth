import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hayPowerShell7, resolverCopilotExe, versionCopilotOk } from './copilot-exe'

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

test('hayPowerShell7: pwsh en el PATH o en Program Files cuenta, powershell.exe 5.1 no', () => {
  assert.equal(hayPowerShell7({ PATH: 'C:\\a;C:\\b' }, conArchivos('C:\\b\\pwsh.exe'), 'win32'), true)
  assert.equal(hayPowerShell7({ PATH: 'C:\\a' }, conArchivos('C:\\a\\powershell.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), 'win32'), false)
  assert.equal(hayPowerShell7({ PATH: 'C:\\a' }, conArchivos('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 'win32'), true)
  assert.equal(hayPowerShell7({ PATH: '.' }, conArchivos('.\\pwsh.exe'), 'win32'), false)
  assert.equal(hayPowerShell7({}, () => false, 'win32'), false)
  assert.equal(hayPowerShell7({}, () => false, 'linux'), true)
})
