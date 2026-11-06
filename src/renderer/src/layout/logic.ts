/**
 * Lógica pura del layout de paneles: forma de la grilla, proporciones, reordenamiento y
 * persistencia. Sin DOM ni React, para poder probarla con Node.
 */

export type ViewMode = 'grid' | 'tabs'
/** Dónde cae un panel arrastrado respecto del panel de destino. */
export type DropMode = 'before' | 'after' | 'swap'

/** Proporciones: alto de cada fila y, por fila, ancho de cada columna. Cada lista suma 1. */
export interface Sizes {
  rows: number[]
  cols: number[][]
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Columnas automáticas según la cantidad de paneles (como antes: 1, 2 hasta 4, después 3). */
export function autoCols(n: number): number {
  return n <= 1 ? 1 : n <= 4 ? 2 : 3
}

/**
 * Cantidad de paneles por fila. Las filas quedan parejas y la última nunca deja huecos:
 * 3 → [2, 1] (el de abajo ocupa todo el ancho), 5 → [3, 2], 7 → [3, 2, 2].
 */
export function gridShape(n: number): number[] {
  if (!Number.isFinite(n) || n <= 0) return []
  const cols = autoCols(n)
  const rows = Math.ceil(n / cols)
  const base = Math.floor(n / rows)
  const extra = n % rows
  return Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0))
}

export function shapeKey(shape: number[]): string {
  return shape.join('-')
}

export function equalParts(n: number): number[] {
  return n > 0 ? Array.from({ length: n }, () => 1 / n) : []
}

export function defaultSizes(shape: number[]): Sizes {
  return { rows: equalParts(shape.length), cols: shape.map((c) => equalParts(c)) }
}

function normalize(arr: number[]): number[] | null {
  if (!arr.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) return null
  const sum = arr.reduce((a, b) => a + b, 0)
  return sum > 0 ? arr.map((v) => v / sum) : null
}

/** Valida unas proporciones guardadas contra la forma actual. Devuelve null si no sirven. */
export function coerceSizes(value: unknown, shape: number[]): Sizes | null {
  if (!value || typeof value !== 'object') return null
  const v = value as { rows?: unknown; cols?: unknown }
  if (!Array.isArray(v.rows) || !Array.isArray(v.cols)) return null
  if (v.rows.length !== shape.length || v.cols.length !== shape.length) return null
  const rows = normalize(v.rows as number[])
  if (!rows) return null
  const cols: number[][] = []
  for (let i = 0; i < shape.length; i++) {
    const c = v.cols[i]
    if (!Array.isArray(c) || c.length !== shape[i]) return null
    const n = normalize(c as number[])
    if (!n) return null
    cols.push(n)
  }
  return { rows, cols }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** Posición acumulada (0..1) del borde que sigue al elemento `i`. */
export function boundaryPos(arr: number[], i: number): number {
  let s = 0
  for (let k = 0; k <= i && k < arr.length; k++) s += arr[k]
  return s
}

/**
 * Mueve el borde entre `arr[i]` y `arr[i + 1]` a la posición `pos` (0..1 del total).
 * Solo cambian esos dos; cada uno queda con al menos `min`.
 */
export function resizeBoundary(arr: number[], i: number, pos: number, min: number): number[] {
  if (i < 0 || i >= arr.length - 1 || !Number.isFinite(pos)) return arr
  const start = boundaryPos(arr, i - 1)
  const pair = arr[i] + arr[i + 1]
  const lo = Math.min(min, pair / 2)
  const a = clamp(pos - start, lo, pair - lo)
  const out = arr.slice()
  out[i] = a
  out[i + 1] = pair - a
  return out
}

/** Corre el borde `i` en `delta` (fracción del total): para las flechas del teclado. */
export function nudgeBoundary(arr: number[], i: number, delta: number, min: number): number[] {
  return resizeBoundary(arr, i, boundaryPos(arr, i) + delta, min)
}

export function isEqual(arr: number[], eps = 0.004): boolean {
  return arr.every((v) => Math.abs(v - 1 / arr.length) < eps)
}

export function sizesAreEqual(s: Sizes): boolean {
  return isEqual(s.rows) && s.cols.every((c) => isEqual(c))
}

/** Rectángulos (fracciones del área) de cada panel, en orden de lectura. */
export function cellRects(shape: number[], sizes: Sizes): Rect[] {
  const out: Rect[] = []
  let y = 0
  for (let r = 0; r < shape.length; r++) {
    const h = sizes.rows[r] ?? 1 / shape.length
    let x = 0
    for (let c = 0; c < shape[r]; c++) {
      const w = sizes.cols[r]?.[c] ?? 1 / shape[r]
      out.push({ x, y, w, h })
      x += w
    }
    y += h
  }
  return out
}

/** Reubica `id` respecto de `target`: antes, después o intercambiando lugares. */
export function movePane(list: string[], id: string, target: string, mode: DropMode): string[] {
  const from = list.indexOf(id)
  const to = list.indexOf(target)
  if (from < 0 || to < 0 || id === target) return list
  if (mode === 'swap') {
    const out = list.slice()
    out[from] = target
    out[to] = id
    return out
  }
  const rest = list.filter((x) => x !== id)
  const t = rest.indexOf(target)
  rest.splice(mode === 'before' ? t : t + 1, 0, id)
  return sameOrder(rest, list) ? list : rest
}

/** Corre `id` una o más posiciones (negativo = hacia el principio). */
export function shiftPane(list: string[], id: string, delta: number): string[] {
  const from = list.indexOf(id)
  if (from < 0 || delta === 0) return list
  const to = clamp(from + delta, 0, list.length - 1)
  if (to === from) return list
  const out = list.slice()
  out.splice(from, 1)
  out.splice(to, 0, id)
  return out
}

/**
 * Mueve `id` a la fila de arriba (dRow = -1) o de abajo (dRow = 1) de la grilla, en la misma
 * columna. Si ahí hay un panel, se intercambian. Si la fila destino es más corta, `id` queda al
 * final de esa fila. `order` está en orden de lectura y `shape` es la forma de la grilla
 * (`gridShape`). Si no hay fila destino, devuelve la misma lista.
 */
export function shiftPaneRow(order: string[], id: string, dRow: -1 | 1, shape: number[]): string[] {
  const i = order.indexOf(id)
  if (i < 0 || (dRow !== 1 && dRow !== -1) || shape.reduce((a, b) => a + b, 0) !== order.length) return order
  let row = 0
  let start = 0
  while (row < shape.length && i >= start + shape[row]) {
    start += shape[row]
    row++
  }
  const t = row + dRow
  if (t < 0 || t >= shape.length) return order
  const col = i - start
  // Inicio de la fila destino.
  let tStart = 0
  for (let r = 0; r < t; r++) tStart += shape[r]
  const tLen = shape[t]
  const out = order.slice()
  if (col < tLen) {
    const j = tStart + col
    out[i] = order[j]
    out[j] = id
    return out
  }
  // La fila destino es más corta: `id` va al final de esa fila.
  const endOrig = tStart + tLen - 1
  out.splice(i, 1)
  out.splice(i < endOrig ? endOrig : endOrig + 1, 0, id)
  return sameOrder(out, order) ? order : out
}

/** Fila y columna (base 0) de `id` en la grilla de forma `shape`, o null si no está. */
export function locatePane(order: string[], id: string, shape: number[]): { row: number; col: number } | null {
  const i = order.indexOf(id)
  if (i < 0) return null
  let start = 0
  for (let row = 0; row < shape.length; row++) {
    if (i < start + shape[row]) return { row, col: i - start }
    start += shape[row]
  }
  return null
}

export function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** Siguiente o anterior en forma circular (Ctrl+Tab). */
export function cycle(list: string[], current: string | null, dir: 1 | -1): string | null {
  if (list.length === 0) return null
  const i = current ? list.indexOf(current) : -1
  if (i < 0) return dir === 1 ? list[0] : list[list.length - 1]
  return list[(i + dir + list.length) % list.length]
}

/**
 * Modo de soltado según dónde está el puntero dentro del destino (fracción horizontal 0..1).
 * En la grilla: bordes = insertar, centro = intercambiar. En pestañas: mitad izquierda o derecha.
 */
export function dropModeAt(relX: number, kind: 'pane' | 'tab'): DropMode {
  if (kind === 'tab') return relX < 0.5 ? 'before' : 'after'
  return relX < 0.28 ? 'before' : relX > 0.72 ? 'after' : 'swap'
}

// ---------- Persistencia (Storage inyectable: localStorage en la app, un mapa en las pruebas) ----------

export interface KV {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const SIZES_KEY = 'sloth.layout.sizes.v1'
export const MODE_KEY = 'sloth.layout.view.v1'
const MAX_SAVED_SHAPES = 24

function readMap(kv: KV | null): Record<string, unknown> {
  if (!kv) return {}
  try {
    const raw = kv.getItem(SIZES_KEY)
    const v = raw ? (JSON.parse(raw) as unknown) : null
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Proporciones guardadas para esta forma (o las parejas si no hay o no sirven). */
export function loadSizes(kv: KV | null, shape: number[]): Sizes {
  return coerceSizes(readMap(kv)[shapeKey(shape)], shape) ?? defaultSizes(shape)
}

export function saveSizes(kv: KV | null, shape: number[], sizes: Sizes): void {
  if (!kv || shape.length === 0) return
  const map = readMap(kv)
  const key = shapeKey(shape)
  delete map[key]
  const round = (a: number[]): number[] => a.map((v) => Math.round(v * 10000) / 10000)
  if (!sizesAreEqual(sizes)) map[key] = { rows: round(sizes.rows), cols: sizes.cols.map(round) }
  // Lo último guardado va al final; se descartan las formas más viejas.
  const keys = Object.keys(map)
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SAVED_SHAPES))) delete map[k]
  try {
    kv.setItem(SIZES_KEY, JSON.stringify(map))
  } catch {
    /* sin espacio o bloqueado: se pierde la preferencia, nada más */
  }
}

export function loadMode(kv: KV | null): ViewMode {
  try {
    return kv?.getItem(MODE_KEY) === 'tabs' ? 'tabs' : 'grid'
  } catch {
    return 'grid'
  }
}

export function saveMode(kv: KV | null, mode: ViewMode): void {
  try {
    kv?.setItem(MODE_KEY, mode)
  } catch {
    /* idem */
  }
}
