import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claudeWithPrompt, cmdArg, posixArg, psArg, shellArgs } from './shell-args'

test('psArg deja sin comillas lo simple y duplica la comilla recta', () => {
  assert.equal(psArg('--continue'), '--continue')
  assert.equal(psArg("it's"), "'it''s'")
})

test('psArg duplica las comillas tipográficas: PowerShell también cierra el string con ellas', () => {
  assert.equal(psArg('a \u2019; calc; \u2018 b'), "'a \u2019\u2019; calc; \u2018\u2018 b'")
  assert.equal(psArg('\u201a\u201b'), "'\u201a\u201a\u201b\u201b'")
})

test('un prompt que empieza con guion va después de «--» y no se lee como opción de claude', () => {
  assert.deepEqual(claudeWithPrompt('--permission-mode=bypassPermissions\nhola'), ['claude', '--', '--permission-mode=bypassPermissions hola'])
  assert.deepEqual(shellArgs('ps', claudeWithPrompt('--settings=x y')).at(-1), "claude -- '--settings=x y'")
})

test('posixArg y cmdArg', () => {
  assert.equal(posixArg("it's"), `'it'\\''s'`)
  assert.equal(cmdArg('a & b "c"'), '"a  b c"')
})

test('shellArgs arma el comando de cada familia', () => {
  assert.deepEqual(shellArgs('ps'), ['-NoLogo'])
  assert.deepEqual(shellArgs('ps', ['claude', 'hola vos']), ['-NoLogo', '-NoExit', '-Command', "claude 'hola vos'"])
  assert.deepEqual(shellArgs('cmd', ['claude']), ['/k', 'claude'])
  assert.deepEqual(shellArgs('posix', ['claude', 'x y']), ['--login', '-i', '-c', "claude 'x y'; exec bash --login -i"])
})
