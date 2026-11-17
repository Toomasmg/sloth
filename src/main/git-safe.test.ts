import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterOverrides, safeGitArgs, safeGitEnv } from './git-safe'

const NO_GPG = ['-c', 'gpg.program=', '-c', 'gpg.ssh.program=', '-c', 'gpg.x509.program=']

test('safeGitArgs apaga fsmonitor, untrackedCache, firmas en log y gpg, y no toma locks opcionales', () => {
  assert.deepEqual(safeGitArgs('C:\\repo', ['status', '--porcelain']), [
    '--no-optional-locks',
    '-C',
    'C:\\repo',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.untrackedCache=false',
    '-c',
    'protocol.ext.allow=never',
    '-c',
    'log.showSignature=false',
    ...NO_GPG,
    '-c',
    'core.quotepath=false',
    'status',
    '--porcelain'
  ])
})

test('commit y pull conservan el gpg del usuario para firmar o verificar', () => {
  for (const cmd of ['commit', 'pull']) assert.ok(!safeGitArgs('C:\\repo', [cmd]).includes('gpg.program='), cmd)
  assert.ok(safeGitArgs('C:\\repo', ['log', '-1']).includes('gpg.program='))
})

test('filterOverrides apaga los filtros del repo y deja el de git-lfs estándar', () => {
  const z = (pairs: [string, string][]): string => pairs.map(([k, v]) => `${k}\n${v}\0`).join('')
  const lfs: [string, string][] = [
    ['filter.lfs.clean', 'git-lfs clean -- %f'],
    ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
    ['filter.lfs.process', 'git-lfs filter-process'],
    ['filter.lfs.required', 'true']
  ]
  assert.deepEqual(filterOverrides(''), [])
  assert.deepEqual(filterOverrides(z(lfs)), [])
  const off = (n: string): string[] => ['-c', `filter.${n}.clean=`, '-c', `filter.${n}.smudge=`, '-c', `filter.${n}.process=`, '-c', `filter.${n}.required=false`]
  assert.deepEqual(filterOverrides(z([...lfs, ['filter.x.y.clean', 'evil.sh']])), off('x.y'))
  // El repo puede pisar el lfs de la config global: vale el último valor.
  assert.deepEqual(filterOverrides(z([...lfs, ['filter.lfs.process', 'evil.sh']])), off('lfs'))
  assert.equal(filterOverrides(z([['filter.a=b.clean', 'x']])), null)
})

test('los -c de más van antes del subcomando', () => {
  const a = safeGitArgs('C:\\repo', ['status'], ['-c', 'filter.x.clean='])
  assert.deepEqual(a.slice(-4), ['filter.x.clean=', '-c', 'core.quotepath=false', 'status'])
})

test('safeGitEnv suma la config a la que ya trae el entorno', () => {
  const env = safeGitEnv({ PATH: 'x', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Ana' })
  assert.equal(env.GIT_CONFIG_COUNT, '5')
  assert.equal(env.GIT_CONFIG_KEY_0, 'user.name')
  assert.equal(env.GIT_CONFIG_KEY_1, 'core.fsmonitor')
  assert.equal(env.GIT_CONFIG_VALUE_1, 'false')
  assert.equal(env.GIT_CONFIG_KEY_4, 'log.showSignature')
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0')
  assert.equal(safeGitEnv({}).GIT_CONFIG_KEY_0, 'core.fsmonitor')
})
