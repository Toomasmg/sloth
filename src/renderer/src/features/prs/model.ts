import type { MergeMethod, PrRow, RepoPrs, ReviewState } from '../../../../shared/prs'

export type PrFilter = 'mine' | 'review' | 'all'

const keep = (r: PrRow, f: PrFilter): boolean => (f === 'mine' ? r.mine : f === 'review' ? r.reviewRequestedFromMe : true)

export function filterPrs(repos: RepoPrs[], f: PrFilter): RepoPrs[] {
  return repos
    .map((repo) => ({ ...repo, prs: repo.prs.filter((r) => keep(r, f)) }))
    .filter((repo) => repo.prs.length > 0 || repo.error)
}

export function counts(repos: RepoPrs[]): Record<PrFilter, number> {
  const all = repos.flatMap((r) => r.prs)
  return {
    mine: all.filter((r) => r.mine).length,
    review: all.filter((r) => r.reviewRequestedFromMe).length,
    all: all.length
  }
}

export function checksLabel(r: PrRow): string {
  const { fail, pending } = r.checkCounts
  if (r.checks === 'ok') return 'Checks pasando'
  if (r.checks === 'fail') return fail === 1 ? '1 check fallando' : `${fail} checks fallando`
  if (r.checks === 'pending') return pending === 1 ? '1 check pendiente' : `${pending} checks pendientes`
  return 'Sin checks'
}

export function reviewLabel(s: ReviewState): string | null {
  if (s === 'approved') return 'Aprobado'
  if (s === 'changes') return 'Cambios pedidos'
  if (s === 'required') return 'Falta revisión'
  return null
}

export function mergeBlocker(r: PrRow): string | null {
  if (r.isDraft) return 'Es un borrador: marcalo como listo en GitHub antes de mergear.'
  if (r.mergeable === 'conflict') return 'Tiene conflictos con la rama base.'
  if (r.checks === 'fail') return 'Hay checks fallando.'
  if (r.review === 'changes') return 'Hay cambios pedidos en la revisión.'
  if (r.mergeState === 'BEHIND') return 'La rama está desactualizada respecto de la base.'
  if (r.mergeState === 'BLOCKED') return 'GitHub lo tiene bloqueado (revisiones o checks requeridos).'
  return null
}

export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000))
  if (s < 60) return 'recién'
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`
  return `hace ${Math.floor(s / 3600)} h`
}

export function methodLabel(m: MergeMethod): string {
  if (m === 'squash') return 'Squash'
  if (m === 'merge') return 'Merge commit'
  return 'Rebase'
}
