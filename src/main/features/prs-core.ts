import type { ChecksState, MergeMethod, Mergeable, PrCheck, PrRow, PrTarget, ReviewState } from '../../shared/prs'

/** Lógica pura del panel de PRs: armar consultas a gh y validar lo que devuelve GitHub. */

export const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
const SHA_RE = /^[0-9a-f]{40}$/
const ID_RE = /^[A-Za-z0-9_=-]{1,100}$/
// Copia de GITHUB_PR_URL de git-ops: este módulo no puede importar child_process.
const PR_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+\/?$/
const MAX_FAILING = 5
const MERGE_METHODS: readonly MergeMethod[] = ['squash', 'merge', 'rebase']

export function validRepo(s: unknown): s is string {
  return typeof s === 'string' && REPO_RE.test(s) && s.split('/').every((p) => !/^\.+$/.test(p))
}

const REMOTE_RES = [
  /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  /^ssh:\/\/git@github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i
]

export function parseGithubRemote(url: string): string | null {
  const u = url.trim()
  for (const re of REMOTE_RES) {
    const m = re.exec(u)
    if (!m) continue
    const slug = `${m[1]}/${m[2]}`
    return validRepo(slug) ? slug : null
  }
  return null
}

export function validTarget(x: unknown): PrTarget {
  if (typeof x !== 'object' || x === null) throw new Error('PR inválido.')
  const { repo, number } = x as Record<string, unknown>
  if (!validRepo(repo)) throw new Error('Repo inválido.')
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > 10_000_000) throw new Error('Número de PR inválido.')
  return { repo, number }
}

export function validMergeMethod(m: unknown): m is MergeMethod {
  return typeof m === 'string' && (MERGE_METHODS as readonly string[]).includes(m)
}

export function cleanText(s: unknown, max: number): string {
  if (typeof s !== 'string') return ''
  const t = s
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return [...t].slice(0, max).join('')
}

export const PRS_QUERY =
  'query($owner:String!,$name:String!){viewer{login} repository(owner:$owner,name:$name){' +
  'mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed ' +
  'pullRequests(states:OPEN,first:30,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{' +
  'id number title url isDraft baseRefName headRefName isCrossRepository updatedAt author{login} ' +
  'mergeable mergeStateStatus reviewDecision ' +
  'reviewRequests(first:20){nodes{requestedReviewer{... on User{login}}}} ' +
  'commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:50){nodes{__typename ' +
  '... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}}}}}}}' +
  '}}}}'

export function queryArgs(owner: string, name: string): string[] {
  if (!validRepo(`${owner}/${name}`)) throw new Error('Repo inválido.')
  return ['api', 'graphql', '-f', `query=${PRS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`]
}

function obj(x: unknown): Record<string, unknown> | null {
  return typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null
}

function nodesOf(x: unknown): unknown[] {
  const n = obj(x)?.nodes
  return Array.isArray(n) ? n : []
}

function httpsUrl(x: unknown): string | null {
  return typeof x === 'string' && x.startsWith('https://') && x.length <= 2000 && !/[\s\p{Cc}]/u.test(x) ? x : null
}

const FAIL_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])

export function checksOf(contexts: unknown[]): { state: ChecksState; counts: PrRow['checkCounts']; failing: PrCheck[] } {
  const counts = { ok: 0, fail: 0, pending: 0 }
  const failing: PrCheck[] = []
  for (const c of contexts) {
    const o = obj(c)
    if (!o) continue
    let kind: 'ok' | 'fail' | 'pending'
    let name: string
    let url: string | null
    if (o.__typename === 'CheckRun') {
      name = cleanText(o.name, 200)
      url = httpsUrl(o.detailsUrl)
      if (o.status !== 'COMPLETED') kind = 'pending'
      else kind = typeof o.conclusion === 'string' && FAIL_CONCLUSIONS.has(o.conclusion) ? 'fail' : 'ok'
    } else if (o.__typename === 'StatusContext') {
      name = cleanText(o.context, 200)
      url = httpsUrl(o.targetUrl)
      if (o.state === 'PENDING' || o.state === 'EXPECTED') kind = 'pending'
      else if (o.state === 'FAILURE' || o.state === 'ERROR') kind = 'fail'
      else if (o.state === 'SUCCESS') kind = 'ok'
      else continue
    } else continue
    counts[kind]++
    if (kind === 'fail' && failing.length < MAX_FAILING) failing.push({ name: name || 'check', url })
  }
  const state: ChecksState = counts.fail > 0 ? 'fail' : counts.pending > 0 ? 'pending' : counts.ok > 0 ? 'ok' : 'none'
  return { state, counts, failing }
}

function reviewOf(x: unknown): ReviewState {
  if (x === 'APPROVED') return 'approved'
  if (x === 'CHANGES_REQUESTED') return 'changes'
  if (x === 'REVIEW_REQUIRED') return 'required'
  return 'none'
}

function mergeableOf(x: unknown): Mergeable {
  if (x === 'MERGEABLE') return 'yes'
  if (x === 'CONFLICTING') return 'conflict'
  return 'unknown'
}

function prOf(n: unknown, repo: string, login: string): { row: PrRow; id: string } | null {
  const o = obj(n)
  if (!o) return null
  const { number, url, id } = o
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > 10_000_000) return null
  if (typeof url !== 'string' || !PR_URL_RE.test(url)) return null
  if (typeof id !== 'string' || !ID_RE.test(id)) return null
  const commit = obj(obj(nodesOf(o.commits)[0])?.commit)
  const headSha = commit?.oid
  if (typeof headSha !== 'string' || !SHA_RE.test(headSha)) return null
  const checks = checksOf(nodesOf(obj(commit?.statusCheckRollup)?.contexts))
  const author = cleanText(obj(o.author)?.login, 200)
  const mergeState = cleanText(o.mergeStateStatus, 40)
  const reviewRequestedFromMe =
    login !== '' && nodesOf(o.reviewRequests).some((r) => cleanText(obj(obj(r)?.requestedReviewer)?.login, 200) === login)
  return {
    id,
    row: {
      repo,
      number,
      title: cleanText(o.title, 300),
      url,
      author,
      isDraft: o.isDraft === true,
      base: cleanText(o.baseRefName, 200),
      head: cleanText(o.headRefName, 200),
      crossRepo: o.isCrossRepository === true,
      headSha,
      updatedAt: cleanText(o.updatedAt, 40),
      checks: checks.state,
      checkCounts: checks.counts,
      failing: checks.failing,
      review: reviewOf(o.reviewDecision),
      reviewRequestedFromMe,
      mine: login !== '' && author === login,
      mergeable: mergeableOf(o.mergeable),
      mergeState: /^[A-Z_]+$/.test(mergeState) ? mergeState : 'UNKNOWN'
    }
  }
}

export function parseRepoResponse(
  json: unknown,
  repo: string
): { login: string; mergeMethods: MergeMethod[]; prs: PrRow[]; ids: Record<number, string> } {
  let data: unknown = json
  if (typeof json === 'string') {
    try {
      data = JSON.parse(json)
    } catch {
      throw new Error('GitHub devolvió una respuesta que no se pudo leer.')
    }
  }
  const root = obj(data)
  if (!root) throw new Error('GitHub devolvió una respuesta que no se pudo leer.')
  const d = obj(root.data)
  const r = obj(d?.repository)
  if (!r) {
    const errs = Array.isArray(root.errors) ? root.errors : []
    const msg = cleanText(obj(errs[0])?.message, 300)
    throw new Error(msg ? `GitHub: ${msg}` : 'No encontré el repo en GitHub o no tenés acceso.')
  }
  const login = cleanText(obj(d?.viewer)?.login, 200)
  const allowed: Record<MergeMethod, unknown> = { squash: r.squashMergeAllowed, merge: r.mergeCommitAllowed, rebase: r.rebaseMergeAllowed }
  const mergeMethods = MERGE_METHODS.filter((m) => allowed[m] === true)
  const prs: PrRow[] = []
  const ids: Record<number, string> = {}
  for (const n of nodesOf(r.pullRequests)) {
    const p = prOf(n, repo, login)
    if (!p) continue
    prs.push(p.row)
    ids[p.row.number] = p.id
  }
  return { login, mergeMethods, prs, ids }
}

export function mergeArgs(t: PrTarget, method: MergeMethod, headSha: string): string[] {
  const { repo, number } = validTarget(t)
  if (!validMergeMethod(method)) throw new Error('Método de merge inválido.')
  if (!SHA_RE.test(headSha)) throw new Error('Commit del PR inválido.')
  return ['pr', 'merge', String(number), '--repo', repo, `--${method}`, '--match-head-commit', headSha]
}

export const UPDATE_BRANCH_MUTATION =
  'mutation($id:ID!,$sha:GitObjectID!){updatePullRequestBranch(input:{pullRequestId:$id,expectedHeadOid:$sha,updateMethod:REBASE}){pullRequest{number}}}'

export function updateBranchArgs(prId: string, headSha: string): string[] {
  if (!ID_RE.test(prId)) throw new Error('Id de PR inválido.')
  if (!SHA_RE.test(headSha)) throw new Error('Commit del PR inválido.')
  return ['api', 'graphql', '-f', `query=${UPDATE_BRANCH_MUTATION}`, '-f', `id=${prId}`, '-f', `sha=${headSha}`]
}

/** Carpetas de worktree que tienen esa rama, según `git worktree list --porcelain`. */
export function worktreesWithBranch(porcelain: string, branch: string): string[] {
  const out: string[] = []
  let path: string | null = null
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    else if (line === `branch refs/heads/${branch}` && path) out.push(path)
    else if (line === '') path = null
  }
  return out
}
