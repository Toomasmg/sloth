import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ago, checksLabel, counts, filterPrs, mergeBlocker } from './model'
import type { PrRow, RepoPrs } from '../../../../shared/prs'

const row = (over: Partial<PrRow> = {}): PrRow => ({
  repo: 'a/b',
  number: 1,
  title: 't',
  url: 'https://github.com/a/b/pull/1',
  author: 'x',
  isDraft: false,
  base: 'main',
  head: 'f',
  crossRepo: false,
  maintainerCanModify: false,
  headSha: 'abc',
  updatedAt: '',
  checks: 'ok',
  checkCounts: { ok: 1, fail: 0, pending: 0 },
  failing: [],
  review: 'none',
  reviewRequestedFromMe: false,
  mine: false,
  mergeable: 'yes',
  mergeState: 'CLEAN',
  ...over
})

const repo = (name: string, prs: PrRow[], error: string | null = null): RepoPrs => ({ repo: name, repoPaths: [], defaultBranch: 'main', mergeMethods: ['squash'], prs, error })

const repos = [
  repo('a/b', [row({ number: 1, mine: true }), row({ number: 2, reviewRequestedFromMe: true })]),
  repo('c/d', [row({ number: 3 })]),
  repo('e/f', [], 'sin acceso')
]

test('filtros y conteos', () => {
  assert.deepEqual(counts(repos), { mine: 1, review: 1, all: 3 })
  assert.deepEqual(filterPrs(repos, 'mine').map((r) => r.repo), ['a/b', 'e/f'])
  assert.deepEqual(filterPrs(repos, 'review')[0].prs.map((p) => p.number), [2])
  assert.equal(filterPrs(repos, 'all').length, 3)
})

test('mergeBlocker', () => {
  assert.match(mergeBlocker(row({ isDraft: true }))!, /borrador/)
  assert.match(mergeBlocker(row({ mergeable: 'conflict' }))!, /conflictos/)
  assert.match(mergeBlocker(row({ checks: 'fail' }))!, /fallando/)
  assert.equal(mergeBlocker(row()), null)
})

test('ago en los bordes', () => {
  assert.equal(ago(0, 59_000), 'recién')
  assert.equal(ago(0, 60_000), 'hace 1 min')
  assert.equal(ago(0, 3_600_000), 'hace 1 h')
})

test('checksLabel con plurales', () => {
  assert.equal(checksLabel(row({ checks: 'fail', checkCounts: { ok: 0, fail: 1, pending: 0 } })), '1 check fallando')
  assert.equal(checksLabel(row({ checks: 'fail', checkCounts: { ok: 0, fail: 2, pending: 0 } })), '2 checks fallando')
  assert.equal(checksLabel(row({ checks: 'pending', checkCounts: { ok: 0, fail: 0, pending: 3 } })), '3 checks pendientes')
  assert.equal(checksLabel(row({ checks: 'fail', checkCounts: { ok: 50, fail: 0, pending: 0 } })), 'Checks fallando')
  assert.equal(checksLabel(row({ checks: 'none' })), 'Sin checks')
})
