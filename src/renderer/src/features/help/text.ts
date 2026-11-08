/** Texto para buscar: sin mayúsculas ni marcas (tildes), y resaltado por palabra. Lo usan Ayuda, Historial y Reportar. */

export const norm = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** Palabras de una búsqueda (vacío si no hay nada escrito). */
export const wordsOf = (q: string): string[] => norm(q.trim()).split(/\s+/).filter(Boolean)

/** True si el texto contiene todas las palabras (sin importar tildes ni mayúsculas). */
export const matchesAll = (text: string, words: string[]): boolean => {
  if (words.length === 0) return true
  const h = norm(text)
  return words.every((w) => h.includes(w))
}

/**
 * Parte el texto en tramos, marcando los que coinciden con las palabras (sin tildes). Los tramos
 * que coinciden salen con `hit: true`; el resto, con `hit: false`.
 */
export function marks(text: string, words: string[]): { t: string; hit: boolean }[] {
  const cs = [...text]
  let joined = ''
  const owner: number[] = []
  cs.forEach((c, i) => {
    const n = norm(c)
    for (let k = 0; k < n.length; k++) owner.push(i)
    joined += n
  })
  const hit = new Array<boolean>(cs.length).fill(false)
  for (const w of words) {
    if (!w) continue
    let at = joined.indexOf(w)
    while (at !== -1) {
      for (let k = at; k < at + w.length; k++) hit[owner[k]] = true
      at = joined.indexOf(w, at + 1)
    }
  }
  const out: { t: string; hit: boolean }[] = []
  cs.forEach((c, i) => {
    const last = out[out.length - 1]
    if (last && last.hit === hit[i]) last.t += c
    else out.push({ t: c, hit: hit[i] })
  })
  return out
}
