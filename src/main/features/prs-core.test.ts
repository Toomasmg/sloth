import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checksOf,
  cleanText,
  mergeArgs,
  parseGithubRemote,
  parseRepoResponse,
  queryArgs,
  updateBranchArgs,
  validTarget,
  worktreesWithBranch
} from './prs-core'

const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)

test('parseGithubRemote reconoce https, ssh y scp de github', () => {
  assert.equal(parseGithubRemote('https://github.com/o/r.git'), 'o/r')
  assert.equal(parseGithubRemote('https://github.com/o/r'), 'o/r')
  assert.equal(parseGithubRemote('git@github.com:o/r.git'), 'o/r')
  assert.equal(parseGithubRemote('ssh://git@github.com/o/r.git'), 'o/r')
  assert.equal(parseGithubRemote('https://gitlab.com/o/r.git'), null)
  assert.equal(parseGithubRemote('cualquier cosa'), null)
  assert.equal(parseGithubRemote('https://github.com/o/r;rm.git'), null)
})

test('validTarget acepta un PR válido y rechaza basura', () => {
  assert.deepEqual(validTarget({ repo: 'o/r', number: 12 }), { repo: 'o/r', number: 12 })
  assert.throws(() => validTarget({ repo: 'o/r;rm', number: 1 }))
  assert.throws(() => validTarget({ repo: '../x', number: 1 }))
  assert.throws(() => validTarget({ repo: 'o/r', number: 0 }))
  assert.throws(() => validTarget({ repo: 'o/r', number: 1.5 }))
  assert.throws(() => validTarget({ repo: 'o/r', number: '3' }))
  assert.throws(() => validTarget('o/r#3'))
})

test('cleanText saca caracteres de control e invisibles y corta', () => {
  assert.equal(cleanText('a\u202Eb\u200Bc\nd\x1b[31me', 100), 'abc d [31me')
  assert.equal(cleanText('abcdef', 3), 'abc')
  assert.equal(cleanText(42, 10), '')
})

test('checksOf: sin checks es none', () => {
  assert.deepEqual(checksOf([]), { state: 'none', counts: { ok: 0, fail: 0, pending: 0 }, failing: [] })
})

test('checksOf: un fallo gana a un pendiente y trae su link', () => {
  const r = checksOf([
    { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci/1' },
    { __typename: 'StatusContext', context: 'lint', state: 'PENDING', targetUrl: 'https://ci/2' },
    { __typename: 'CheckRun', name: 'skip', status: 'COMPLETED', conclusion: 'SKIPPED', detailsUrl: null }
  ])
  assert.equal(r.state, 'fail')
  assert.deepEqual(r.counts, { ok: 1, fail: 1, pending: 1 })
  assert.deepEqual(r.failing, [{ name: 'build', url: 'https://ci/1' }])
})

test('checksOf: solo pendientes es pending; url que no es https queda en null', () => {
  assert.equal(checksOf([{ __typename: 'CheckRun', name: 'a', status: 'IN_PROGRESS' }]).state, 'pending')
  const r = checksOf([{ __typename: 'StatusContext', context: 'x', state: 'ERROR', targetUrl: 'javascript:alert(1)' }])
  assert.deepEqual(r.failing, [{ name: 'x', url: null }])
})

function pr(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'PR_kwABC',
    number: 1,
    title: 'Arreglo',
    url: 'https://github.com/o/r/pull/1',
    isDraft: false,
    baseRefName: 'staging',
    headRefName: 'fix/algo',
    isCrossRepository: false,
    updatedAt: '2026-11-16T10:00:00Z',
    author: { login: 'yo' },
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    reviewRequests: { nodes: [] },
    commits: { nodes: [{ commit: { oid: SHA, statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } } } }] },
    ...over
  }
}

test('parseRepoResponse arma filas, descarta urls de otro host y lee métodos de merge', () => {
  const json = {
    data: {
      viewer: { login: 'yo' },
      repository: {
        mergeCommitAllowed: false,
        squashMergeAllowed: true,
        rebaseMergeAllowed: false,
        pullRequests: {
          nodes: [
            pr({}),
            pr({ id: 'PR_2', number: 2, url: 'https://github.com/o/r/pull/2', author: { login: 'otra' }, reviewRequests: { nodes: [{ requestedReviewer: { login: 'yo' } }] }, reviewDecision: null, mergeable: 'CONFLICTING', commits: { nodes: [{ commit: { oid: SHA2 } }] } }),
            pr({ id: 'PR_3', number: 3, url: 'https://evil.com/o/r/pull/3' }),
            pr({ id: 'PR_4', number: 4, url: 'https://github.com/o/r/pull/4', commits: { nodes: [{ commit: { oid: 'nope' } }] } })
          ]
        }
      }
    }
  }
  const r = parseRepoResponse(JSON.stringify(json), 'o/r')
  assert.equal(r.login, 'yo')
  assert.deepEqual(r.mergeMethods, ['squash'])
  assert.deepEqual(r.prs.map((p) => p.number), [1, 2])
  assert.deepEqual(r.ids, { 1: 'PR_kwABC', 2: 'PR_2' })
  const [a, b] = r.prs
  assert.equal(a.mine, true)
  assert.equal(a.reviewRequestedFromMe, false)
  assert.equal(a.review, 'approved')
  assert.equal(a.checks, 'none')
  assert.equal(b.mine, false)
  assert.equal(b.reviewRequestedFromMe, true)
  assert.equal(b.review, 'none')
  assert.equal(b.mergeable, 'conflict')
  assert.equal(b.headSha, SHA2)
})

test('parseRepoResponse con json roto o sin repo tira un error legible', () => {
  assert.throws(() => parseRepoResponse('{nope', 'o/r'), /no se pudo leer/)
  assert.throws(() => parseRepoResponse({ data: { repository: null }, errors: [{ message: 'Could not resolve' }] }, 'o/r'), /GitHub: Could not resolve/)
})

test('mergeArgs nunca fuerza y ata el merge al commit visto', () => {
  const args = mergeArgs({ repo: 'o/r', number: 7 }, 'squash', SHA)
  assert.deepEqual(args, ['pr', 'merge', '7', '--repo', 'o/r', '--squash', '--match-head-commit', SHA])
  for (const f of ['--admin', '--auto', '--delete-branch']) assert.ok(!args.includes(f))
  assert.deepEqual(args.slice(-2), ['--match-head-commit', SHA])
  assert.throws(() => mergeArgs({ repo: 'o/r', number: 7 }, 'squash', 'HEAD'))
})

test('updateBranchArgs y queryArgs validan sus datos', () => {
  assert.equal(updateBranchArgs('PR_kwABC', SHA).at(-1), `sha=${SHA}`)
  assert.throws(() => updateBranchArgs('a b', SHA))
  assert.deepEqual(queryArgs('o', 'r').slice(-4), ['-f', 'owner=o', '-f', 'name=r'])
  assert.throws(() => queryArgs('..', 'r'))
})

test('worktreesWithBranch encuentra la carpeta que tiene la rama', () => {
  const out = 'worktree C:/repo\nHEAD 1\nbranch refs/heads/main\n\nworktree C:/wt/x\nHEAD 2\nbranch refs/heads/fix/x\n\n'
  assert.deepEqual(worktreesWithBranch(out, 'fix/x'), ['C:/wt/x'])
  assert.deepEqual(worktreesWithBranch(out, 'fix'), [])
})
