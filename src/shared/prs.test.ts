import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rebaseBlocker } from './prs'
import type { PrRow } from './prs'

const row = (over: Partial<PrRow> = {}): PrRow => ({
  repo: 'o/r',
  number: 1,
  title: 't',
  url: 'https://github.com/o/r/pull/1',
  author: 'x',
  isDraft: false,
  base: 'staging',
  head: 'feat/x',
  crossRepo: false,
  maintainerCanModify: false,
  headSha: 'a'.repeat(40),
  updatedAt: '',
  checks: 'ok',
  checkCounts: { ok: 1, fail: 0, pending: 0 },
  failing: [],
  review: 'none',
  reviewRequestedFromMe: false,
  mine: true,
  mergeable: 'yes',
  mergeState: 'CLEAN',
  ...over
})

test('rebaseBlocker deja rebasear una rama de trabajo común', () => {
  const pr = row()
  assert.equal(rebaseBlocker(pr, { defaultBranch: 'main', prs: [pr] }), null)
})

test('rebaseBlocker no deja reescribir la rama por defecto ni una protegida', () => {
  const release = row({ base: 'main', head: 'staging' })
  assert.match(rebaseBlocker(release, { defaultBranch: 'main', prs: [release] }) ?? '', /protegida/)
  const def = row({ base: 'release', head: 'trunk' })
  assert.match(rebaseBlocker(def, { defaultBranch: 'trunk', prs: [def] }) ?? '', /por defecto/)
})

test('rebaseBlocker no deja reescribir una rama de la que salen otros PR', () => {
  const pr = row({ number: 1, head: 'feat/base' })
  const hijo = row({ number: 2, base: 'feat/base', head: 'feat/hijo' })
  assert.match(rebaseBlocker(pr, { defaultBranch: 'main', prs: [pr, hijo] }) ?? '', /Otros PR/)
  assert.equal(rebaseBlocker(hijo, { defaultBranch: 'main', prs: [pr, hijo] }), null)
})

test('rebaseBlocker en un fork depende del permiso del autor', () => {
  const sin = row({ crossRepo: true, head: 'main' })
  assert.match(rebaseBlocker(sin, { defaultBranch: 'main', prs: [sin] }) ?? '', /fork/)
  const con = row({ crossRepo: true, maintainerCanModify: true, head: 'main' })
  assert.equal(rebaseBlocker(con, { defaultBranch: 'main', prs: [con] }), null)
})

test('rebaseBlocker sin rama por defecto conocida (caché viejo) no arriesga', () => {
  const pr = row()
  assert.match(rebaseBlocker(pr, { defaultBranch: null, prs: [pr] }) ?? '', /refrescá/)
})
