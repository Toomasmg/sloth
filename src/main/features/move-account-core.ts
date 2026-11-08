/**
 * Lógica pura de «Mover espacio a otra cuenta» (sin Electron).
 *
 * Al mover, Claude empieza de cero con la otra cuenta en la misma carpeta: la conversación no se pasa.
 * Lo que sí puede llevar es un resumen, armado con datos reales del espacio (carpeta, rama, cambios
 * sin confirmar). El usuario lo puede editar antes de mover.
 */

export const SUMMARY_MAX = 4000

export interface SummaryInput {
  name: string
  cwd: string
  branch: string | null
  /** Archivos con cambios sin confirmar. -1 = no se pudo leer. */
  changes: number
}

/** Resumen inicial para el texto editable. */
export function buildSummary(s: SummaryInput): string {
  const where = s.branch ? `carpeta ${s.cwd}, rama ${s.branch}` : `carpeta ${s.cwd}`
  let changes: string
  if (s.changes < 0) changes = 'No pude leer los cambios sin confirmar'
  else if (s.changes === 0) changes = 'No hay cambios sin confirmar'
  else if (s.changes === 1) changes = 'Hay 1 archivo con cambios sin confirmar'
  else changes = `Hay ${s.changes} archivos con cambios sin confirmar`
  return `Estábamos trabajando en el espacio «${s.name}» (${where}). ${changes}. Antes de seguir, revisá el estado del repo con git status y retomá desde ahí.`
}

/** Texto que escribe el usuario: sin caracteres de control (salvo saltos de línea), con tope de largo. */
export function sanitizeSummary(v: unknown): string {
  if (typeof v !== 'string') throw new Error('El resumen tiene que ser texto.')
  // eslint-disable-next-line no-control-regex
  const clean = v.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim()
  if (clean.length > SUMMARY_MAX) throw new Error(`El resumen es demasiado largo (máximo ${SUMMARY_MAX} caracteres).`)
  return clean
}
