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
