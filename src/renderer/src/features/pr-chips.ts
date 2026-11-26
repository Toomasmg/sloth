import type { PrRow } from '../../../shared/prs'

export type TonoChip = 'ok' | 'bad' | 'warn' | 'run' | 'mute'
export type IconoChip = 'ok' | 'fail' | 'run' | 'none' | 'review' | 'changes' | 'conflict' | 'draft'

export interface ChipPr {
  id: 'ci' | 'review' | 'conflicto'
  texto: string
  tono: TonoChip
  icono: IconoChip
}

/** Lo que Equipo y PRs saben de un PR, dicho con las mismas palabras en las dos pantallas. */
export interface EstadoPr {
  ci: 'pass' | 'fail' | 'running' | 'none'
  review: 'approved' | 'changes' | 'pending' | 'none'
  isDraft: boolean
  conflicto: boolean
  failing: readonly string[]
}

type Aspecto = Pick<ChipPr, 'texto' | 'tono' | 'icono'>

const CI: Record<EstadoPr['ci'], Aspecto> = {
  pass: { texto: 'CI pasa', tono: 'ok', icono: 'ok' },
  fail: { texto: 'CI falla', tono: 'bad', icono: 'fail' },
  running: { texto: 'CI corriendo', tono: 'run', icono: 'run' },
  none: { texto: 'sin CI', tono: 'mute', icono: 'none' }
}

const REVIEW: Record<Exclude<EstadoPr['review'], 'none'>, Aspecto> = {
  approved: { texto: 'aprobado', tono: 'ok', icono: 'ok' },
  changes: { texto: 'cambios pedidos', tono: 'warn', icono: 'changes' },
  pending: { texto: 'review pendiente', tono: 'mute', icono: 'review' }
}

export function chipsDePr(e: EstadoPr): ChipPr[] {
  const chips: ChipPr[] = [{ id: 'ci', ...CI[e.ci] }]
  if (e.isDraft) chips.push({ id: 'review', texto: 'borrador', tono: 'mute', icono: 'draft' })
  else if (e.review !== 'none') chips.push({ id: 'review', ...REVIEW[e.review] })
  if (e.conflicto) chips.push({ id: 'conflicto', texto: 'conflictos', tono: 'bad', icono: 'conflict' })
  return chips
}

/** Nombre del primer check que falla; con más, «build y 2 más». Null si no hay datos. */
export function checkQueFalla(failing: readonly string[]): string | null {
  const nombres = failing.map((n) => n.trim()).filter(Boolean)
  if (!nombres.length) return null
  return nombres.length === 1 ? nombres[0] : `${nombres[0]} y ${nombres.length - 1} más`
}

export function estadoDeRow(r: PrRow): EstadoPr {
  return {
    ci: r.checks === 'ok' ? 'pass' : r.checks === 'fail' ? 'fail' : r.checks === 'pending' ? 'running' : 'none',
    review: r.review === 'required' ? 'pending' : r.review,
    isDraft: r.isDraft,
    conflicto: r.mergeable === 'conflict',
    failing: r.failing.map((c) => c.name)
  }
}
