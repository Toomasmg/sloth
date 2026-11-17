import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { filtrosApagados, git, GitError, gitRaw, gitSafeEnv, run } from './git-run'

test('con la señal ya abortada, run rechaza enseguida como cancelada', async () => {
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(run('git', ['--version'], { signal: ac.signal }), (e: unknown) => e instanceof GitError && e.motivo === 'cancelada')
})

test('abortar a mitad de camino corta git y rechaza como cancelada', async () => {
  const ac = new AbortController()
  // Un alias de shell que tarda: solo termina antes si lo cortan.
  const p = run('git', ['-c', 'alias.espera=!sleep 10', 'espera'], { signal: ac.signal, timeoutMs: 20_000 })
  setTimeout(() => ac.abort(), 50)
  await assert.rejects(p, (e: unknown) => e instanceof GitError && e.motivo === 'cancelada')
})

test('sin abortar, run termina normal', async () => {
  const ac = new AbortController()
  const r = await run('git', ['--version'], { signal: ac.signal })
  assert.equal(r.code, 0)
})

test('un core.fsmonitor del repo no se ejecuta cuando Sloth corre git status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sloth-fsmonitor-'))
  try {
    const marca = join(dir, 'ejecutado.txt').split(sep).join('/')
    await git(dir, ['init', '-q'])
    await git(dir, ['config', 'core.fsmonitor', `echo x > "${marca}"`])
    await git(dir, ['status', '--porcelain'])
    assert.equal(existsSync(marca), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('las lecturas automáticas no ven log.showSignature ni el gpg.program del repo; commit sí usa la config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sloth-gpg-'))
  try {
    await git(dir, ['init', '-q'])
    await git(dir, ['config', 'log.showSignature', 'true'])
    await git(dir, ['config', 'gpg.program', 'C:/malo/gpg.exe'])
    assert.equal((await git(dir, ['config', '--get', 'log.showSignature'])).trim(), 'false')
    assert.equal((await gitRaw(dir, ['config', '--get', 'gpg.program'])).stdout.trim(), '')
    assert.equal(gitSafeEnv(['commit']).GIT_CONFIG_COUNT, String(Object.keys(gitSafeEnv(['commit'])).filter((k) => k.startsWith('GIT_CONFIG_KEY_')).length))
    assert.ok(!Object.values(gitSafeEnv(['commit'])).includes('gpg.program'))
    assert.ok(Object.values(gitSafeEnv(['log'])).includes('gpg.program'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('un filtro clean del repo no se ejecuta cuando Sloth corre git status o diff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sloth-filtro-'))
  try {
    const marca = join(dir, 'ejecutado.marca').split(sep).join('/')
    await git(dir, ['init', '-q'])
    await git(dir, ['config', 'filter.malo.clean', `echo x > "${marca}"; cat`])
    writeFileSync(join(dir, '.gitattributes'), '*.txt filter=malo\n')
    writeFileSync(join(dir, 'a.txt'), 'hola\n')
    // add sí lo corre (lo pide la persona); después se borra la marca y se cambia el archivo.
    await git(dir, ['add', 'a.txt'])
    assert.equal(existsSync(marca), true)
    rmSync(marca)
    writeFileSync(join(dir, 'a.txt'), 'chau\n')
    await git(dir, ['status', '--porcelain'])
    await gitRaw(dir, ['diff', '--no-ext-diff', '--no-textconv'])
    assert.equal(existsSync(marca), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('filtrosApagados apaga todo filtro salvo el de git-lfs estándar', () => {
  const lfs = 'filter.lfs.clean\ngit-lfs clean -- %f\0filter.lfs.smudge\ngit-lfs smudge -- %f\0filter.lfs.process\ngit-lfs filter-process\0filter.lfs.required\ntrue\0'
  assert.deepEqual(filtrosApagados(lfs), [])
  assert.deepEqual(filtrosApagados(`${lfs}filter.x=y.clean\ncalc\0`), [
    ['filter.x=y.clean', ''],
    ['filter.x=y.smudge', ''],
    ['filter.x=y.process', ''],
    ['filter.x=y.required', 'false']
  ])
  assert.equal(filtrosApagados('filter.lfs.clean\ncalc.exe\0').length, 4)
})
