import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GitError, run } from './git-run'

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
