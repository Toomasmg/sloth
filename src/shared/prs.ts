export type ChecksState = 'ok' | 'fail' | 'pending' | 'none'
export type ReviewState = 'approved' | 'changes' | 'required' | 'none'
export type Mergeable = 'yes' | 'conflict' | 'unknown'
export type MergeMethod = 'squash' | 'merge' | 'rebase'

export interface PrCheck {
  name: string
  url: string | null
}

export interface PrRow {
  /** 'owner/name' */
  repo: string
  number: number
  title: string
  url: string
  author: string
  isDraft: boolean
  base: string
  head: string
  crossRepo: boolean
  /** En un PR de un fork, si el autor dejó que los mantenedores toquen su rama. */
  maintainerCanModify: boolean
  headSha: string
  updatedAt: string
  checks: ChecksState
  checkCounts: { ok: number; fail: number; pending: number }
  /** Hasta 5, con el link a cada check. */
  failing: PrCheck[]
  review: ReviewState
  reviewRequestedFromMe: boolean
  mine: boolean
  mergeable: Mergeable
  /** mergeStateStatus de GitHub (CLEAN, BLOCKED, BEHIND, DIRTY…). */
  mergeState: string
}

export interface RepoPrs {
  repo: string
  /** Carpetas de los espacios que apuntan a este repo. */
  repoPaths: string[]
  /** null si GitHub no la informó (o el dato viene de un caché viejo). */
  defaultBranch: string | null
  mergeMethods: MergeMethod[]
  prs: PrRow[]
  error: string | null
}

export type PrsProblem = 'no-gh' | 'no-login' | 'no-repos' | null

export interface PrsSnapshot {
  problem: PrsProblem
  login: string | null
  repos: RepoPrs[]
  /** ms del último refresco completo; 0 = nunca. */
  at: number
  refreshing: boolean
}

export interface PrTarget {
  repo: string
  number: number
}

export type OpenBranchMode = 'local' | 'copy'

export type OpenBranchResult =
  | { kind: 'opened'; id: string; created: boolean }
  | { kind: 'diverged'; branch: string; ahead: number; behind: number; copy: string }

const PROTECTED_BRANCHES = new Set(['main', 'master', 'staging', 'develop', 'production', 'release'])

/** Por qué no se ofrece el rebase en GitHub de este PR, o null si se puede. */
export function rebaseBlocker(pr: PrRow, repo: Pick<RepoPrs, 'defaultBranch' | 'prs'>): string | null {
  if (pr.crossRepo) return pr.maintainerCanModify ? null : 'Es de un fork que no deja modificar su rama.'
  if (!repo.defaultBranch) return 'No sé cuál es la rama por defecto del repo: refrescá.'
  if (pr.head === repo.defaultBranch) return `${pr.head} es la rama por defecto del repo.`
  if (PROTECTED_BRANCHES.has(pr.head)) return `${pr.head} es una rama protegida.`
  if (repo.prs.some((p) => p.number !== pr.number && p.base === pr.head)) return `Otros PR salen de ${pr.head}.`
  return null
}
