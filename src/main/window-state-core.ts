/**
 * Lógica pura del estado de la ventana (v0.5, T6). Sin Electron: se prueba con node.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface SavedWindowState {
  bounds?: Rect
  maximized?: boolean
}

/** Tamaño mínimo que se acepta para restaurar (igual que minWidth/minHeight de la ventana). */
export const MIN_SIZE = { width: 900, height: 560 }
/** Cuánto tiene que verse del rectángulo dentro de algún monitor para usarlo. */
export const MIN_VISIBLE = { width: 120, height: 80 }

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Lee el JSON guardado. Tolerante: si está roto o tiene forma rara, devuelve `{}`.
 * Nunca tira.
 */
export function parseState(json: string): SavedWindowState {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return {}
  }
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const out: SavedWindowState = {}
  const b = r.bounds
  if (b && typeof b === 'object') {
    const o = b as Record<string, unknown>
    if (isNum(o.x) && isNum(o.y) && isNum(o.width) && isNum(o.height) && o.width > 0 && o.height > 0) {
      out.bounds = {
        x: Math.round(o.x),
        y: Math.round(o.y),
        width: Math.round(o.width),
        height: Math.round(o.height)
      }
    }
  }
  if (typeof r.maximized === 'boolean') out.maximized = r.maximized
  return out
}

/** Área común de dos rectángulos (0 si no se tocan). */
function overlap(a: Rect, b: Rect): { width: number; height: number } {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return { width: Math.max(0, w), height: Math.max(0, h) }
}

/**
 * Devuelve los bounds guardados si siguen siendo usables con los monitores actuales:
 * al menos 900×560 de tamaño y al menos 120×80 visibles dentro de algún workArea.
 * Si no, `undefined` (la ventana arranca con el tamaño por defecto).
 */
export function pickBounds(saved: Rect | undefined, workAreas: Rect[]): Rect | undefined {
  if (!saved) return undefined
  if (!isNum(saved.x) || !isNum(saved.y) || !isNum(saved.width) || !isNum(saved.height)) return undefined
  if (saved.width < MIN_SIZE.width || saved.height < MIN_SIZE.height) return undefined
  const visible = workAreas.some((area) => {
    const o = overlap(saved, area)
    return o.width >= MIN_VISIBLE.width && o.height >= MIN_VISIBLE.height
  })
  return visible ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : undefined
}
