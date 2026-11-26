import type { PrRow } from '../../../shared/prs'

export interface ResumenEquipo {
  ciFailing: number
  waitingReview: number
  blocked: number
}

export interface PendientesPrs {
  propiosRojos: number
  piden: number
  /** Todos los PRs con CI fallando y sin revisión, de cualquiera: sirve de respaldo de Equipo cuando todavía no leyó GitHub. */
  rojos: number
  sinRevision: number
}

export interface Insignia {
  n: number
  tono: 'danger' | 'waiting'
  /** Texto para lectores de pantalla y tooltip: el número y el color solos no alcanzan. */
  label: string
}

const plural = (n: number, uno: string, otros: string): string => `${n} ${n === 1 ? uno : otros}`

/** Un borrador no espera revisión de nadie; con CI rojo sí cuenta, porque es lo que hay que arreglar. */
export function contarPendientesPrs(repos: readonly { prs: readonly Pick<PrRow, 'mine' | 'checks' | 'reviewRequestedFromMe' | 'isDraft' | 'review'>[] }[]): PendientesPrs {
  let propiosRojos = 0
  let piden = 0
  let rojos = 0
  let sinRevision = 0
  for (const repo of repos) {
    for (const pr of repo.prs) {
      if (pr.checks === 'fail') rojos++
      if (!pr.isDraft && pr.review === 'required') sinRevision++
      if (pr.mine && pr.checks === 'fail') propiosRojos++
      if (pr.reviewRequestedFromMe && !pr.isDraft) piden++
    }
  }
  return { propiosRojos, piden, rojos, sinRevision }
}

/**
 * Equipo lee GitHub solo al abrir su vista y no lo guarda: sin lectura en esta sesión se usa lo que
 * ya guardó PRs (los tickets bloqueados vienen de Equipo igual). Con lectura, manda Equipo.
 */
export function resumenParaRiel(equipo: (ResumenEquipo & { leyoGithub: boolean }) | null | undefined, prs: PendientesPrs): ResumenEquipo {
  const blocked = equipo?.blocked ?? 0
  if (equipo?.leyoGithub) return { ciFailing: equipo.ciFailing, waitingReview: equipo.waitingReview, blocked }
  return { ciFailing: prs.rojos, waitingReview: prs.sinRevision, blocked }
}

export function insigniaEquipo(r: ResumenEquipo | null | undefined): Insignia | null {
  if (!r) return null
  const n = r.ciFailing + r.blocked
  if (n <= 0) return null
  const partes: string[] = []
  if (r.ciFailing > 0) partes.push(plural(r.ciFailing, 'PR con CI fallando', 'PRs con CI fallando'))
  if (r.blocked > 0) partes.push(plural(r.blocked, 'ticket bloqueado', 'tickets bloqueados'))
  if (r.waitingReview > 0) partes.push(`${r.waitingReview} esperando review`)
  return { n, tono: 'danger', label: partes.join(', ') }
}

export function insigniaPrs(p: PendientesPrs): Insignia | null {
  if (p.propiosRojos <= 0 && p.piden <= 0) return null
  const partes: string[] = []
  if (p.propiosRojos > 0) partes.push(plural(p.propiosRojos, 'tuyo con CI fallando', 'tuyos con CI fallando'))
  if (p.piden > 0) partes.push(plural(p.piden, 'te pide revisión', 'te piden revisión'))
  const label = partes.join(', ')
  return p.propiosRojos > 0 ? { n: p.propiosRojos, tono: 'danger', label } : { n: p.piden, tono: 'waiting', label }
}

export function chipPrRojo(p: PendientesPrs): { texto: string; label: string } | null {
  if (p.propiosRojos <= 0) return null
  const texto = p.propiosRojos === 1 ? '1 PR rojo' : `${p.propiosRojos} PRs rojos`
  return { texto, label: `${plural(p.propiosRojos, 'PR tuyo con CI fallando', 'PRs tuyos con CI fallando')}. Ver mis PRs` }
}
