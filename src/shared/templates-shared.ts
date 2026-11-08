/**
 * Plantillas de espacio: lo que comparten main y la interfaz (variables, ramas, catálogos).
 * Sin Node ni Electron: lo usan templates-core (main) y el diálogo de Nuevo espacio (renderer).
 */

/** Variables del primer mensaje, del nombre y de la rama. */
export const TEMPLATE_VARS = ['ticket', 'ticketmin', 'carpeta', 'rama', 'fecha', 'n', 'plantilla'] as const
/** Las que se pueden usar en el patrón de rama (la rama no puede depender de sí misma ni de la carpeta). */
export const BRANCH_VARS = ['ticket', 'ticketmin', 'fecha', 'n', 'plantilla'] as const

const VAR_RE = /\{([^{}\s]*)\}/g

/** Nombres de variables que aparecen en un texto (sin llaves). */
export function varsIn(s: string | null | undefined): string[] {
  if (!s) return []
  return [...s.matchAll(VAR_RE)].map((m) => m[1])
}

export interface VarValues {
  ticket?: string
  /** Carpeta corta para mostrar: «Cosmos-Ai/front». */
  carpeta?: string
  /** Rama que se va a usar (la del worktree o la actual del repo). */
  rama?: string
  /** AAAA-MM-DD */
  fecha?: string
  n?: number
  plantilla?: string
}

/** Valor de una variable, o undefined si no hay (o si no existe). */
export function valueOf(name: string, v: VarValues): string | undefined {
  switch (name) {
    case 'ticket':
      return v.ticket
    case 'ticketmin':
      return v.ticket ? v.ticket.toLowerCase() : undefined
    case 'carpeta':
      return v.carpeta
    case 'rama':
      return v.rama
    case 'fecha':
      return v.fecha
    case 'n':
      return v.n !== undefined ? String(v.n) : undefined
    case 'plantilla':
      return v.plantilla
    default:
      return undefined
  }
}

/** Reemplaza las variables que tengan valor. Las que faltan quedan como están (no tira error). */
export function applyVars(s: string, v: VarValues): string {
  return s.replace(VAR_RE, (whole, name: string) => valueOf(name, v) ?? whole)
}

/** Variables que el texto usa y todavía no tienen valor, o que no existen. */
export function missingVars(s: string | null | undefined, v: VarValues): string[] {
  return [...new Set(varsIn(s).filter((n) => !(TEMPLATE_VARS as readonly string[]).includes(n) || valueOf(n, v) === undefined))]
}

/** Variables que no existen (para avisar al escribir). */
export function unknownVars(s: string | null | undefined): string[] {
  return [...new Set(varsIn(s).filter((n) => !(TEMPLATE_VARS as readonly string[]).includes(n)))]
}

/** Fecha local YYYY-MM-DD. */
export function today(d = new Date()): string {
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Carpeta corta para {carpeta}: los dos últimos tramos («Cosmos-Ai/front»). */
export function folderLabel(p: string | null | undefined): string {
  const parts = String(p ?? '')
    .split(/[\\/]/)
    .filter(Boolean)
  return parts.slice(-2).join('/')
}

/** Nombre de rama válido para git (subconjunto conservador de check-ref-format). */
export function validBranch(b: string): boolean {
  if (!b || b.length > 200) return false
  if (!/^[A-Za-z0-9._/-]+$/.test(b)) return false
  if (b.startsWith('-') || b.startsWith('/') || b.endsWith('/') || b.endsWith('.') || b.endsWith('.lock')) return false
  if (b.includes('..') || b.includes('//') || b.includes('/.') || b === '@') return false
  return true
}

export const TICKET_RE = /^[A-Z][A-Z0-9]*-\d+$/

/** Íconos de plantilla (claves). Los dibujos están en features/templates/catalog.ts. */
export const TEMPLATE_ICON_KEYS = ['ticket', 'db', 'revision', 'bolt', 'compass', 'rama'] as const
/** Colores de plantilla y de espacio (claves). */
export const TEMPLATE_COLOR_KEYS = ['cielo', 'hoja', 'lila', 'ambar', 'coral'] as const

export const SUGGESTED = 'sugerida'
