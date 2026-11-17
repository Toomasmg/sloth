import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeGitArgs, safeGitEnv } from './git-safe'

test('safeGitArgs apaga fsmonitor y untrackedCache y no toma locks opcionales', () => {
  assert.deepEqual(safeGitArgs('C:\repo', ['status', '--porcelain']), [
    '--no-optional-locks',
    '-C',
    'C:\repo',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.untrackedCache=false',
    '-c',
    'protocol.ext.allow=never',
    '-c',
    'core.quotepath=false',
    'status',
    '--porcelain'
  ])
})

test('safeGitEnv suma la config a la que ya trae el entorno', () => {
  const env = safeGitEnv({ PATH: 'x', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Ana' })
  assert.equal(env.GIT_CONFIG_COUNT, '4')
  assert.equal(env.GIT_CONFIG_KEY_0, 'user.name')
  assert.equal(env.GIT_CONFIG_KEY_1, 'core.fsmonitor')
  assert.equal(env.GIT_CONFIG_VALUE_1, 'false')
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0')
  assert.equal(safeGitEnv({}).GIT_CONFIG_KEY_0, 'core.fsmonitor')
})
