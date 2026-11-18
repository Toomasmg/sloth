import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolverCodexExe, versionCodexOk } from './codex-exe'

const conArchivos = (...ps: string[]) => (p: string): boolean => ps.includes(p)

test('win32: prefiere codex.exe, usa codex.cmd y ignora el shim sin extensión', () => {
  const env = { PATH: 'C:\\a;C:\\b' }
  assert.equal(resolverCodexExe(env, conArchivos('C:\\a\\codex.cmd', 'C:\\a\\codex.exe'), 'win32'), 'C:\\a\\codex.exe')
  assert.equal(resolverCodexExe(env, conArchivos('C:\\b\\codex.cmd'), 'win32'), 'C:\\b\\codex.cmd')
  assert.equal(resolverCodexExe(env, conArchivos('C:\\a\\codex', 'C:\\b\\codex'), 'win32'), undefined)
  assert.equal(resolverCodexExe({ Path: 'C:\\a' }, conArchivos('C:\\a\\codex.cmd'), 'win32'), 'C:\\a\\codex.cmd')
})

test('una entrada relativa del PATH (como «.») no se resuelve contra el cwd', () => {
  assert.equal(resolverCodexExe({ PATH: '.;C:\\a' }, conArchivos('.\\codex.exe'), 'win32'), undefined)
  assert.equal(resolverCodexExe({ PATH: '.:bin:/usr/bin' }, conArchivos('./codex', 'bin/codex'), 'linux'), undefined)
  assert.equal(resolverCodexExe({ PATH: '.;C:\\a' }, conArchivos('C:\\a\\codex.exe'), 'win32'), 'C:\\a\\codex.exe')
})

test('posix: busca codex en cada carpeta del PATH', () => {
  assert.equal(resolverCodexExe({ PATH: '/x:/usr/bin' }, conArchivos('/usr/bin/codex'), 'linux'), '/usr/bin/codex')
  assert.equal(resolverCodexExe({ PATH: '/x' }, conArchivos('/x/codex.cmd'), 'linux'), undefined)
  assert.equal(resolverCodexExe({}, () => true, 'linux'), undefined)
})

test('versionCodexOk: 0.164.0 sirve, una más vieja no y un texto raro tampoco', () => {
  assert.deepEqual(versionCodexOk('codex-cli 0.164.0\n'), { version: '0.164.0', ok: true })
  assert.deepEqual(versionCodexOk('codex-cli 0.200.3'), { version: '0.200.3', ok: true })
  assert.deepEqual(versionCodexOk('codex-cli 1.0.0'), { version: '1.0.0', ok: true })
  assert.deepEqual(versionCodexOk('codex-cli 0.163.9'), { version: '0.163.9', ok: false })
  assert.deepEqual(versionCodexOk('codex-cli 0.100.0'), { version: '0.100.0', ok: false })
  assert.deepEqual(versionCodexOk('algo raro'), { ok: false })
  assert.deepEqual(versionCodexOk(''), { ok: false })
})
