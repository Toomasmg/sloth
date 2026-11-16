/** Pasa una duración de CSS («140ms», «0.2s») a milisegundos; `null` si no se entiende. */
export function cssMs(raw: string): number | null {
  const m = /^(\d*\.?\d+)(ms|s)$/.exec(raw.trim())
  if (!m) return null
  const n = parseFloat(m[1])
  return m[2] === 's' ? n * 1000 : n
}
