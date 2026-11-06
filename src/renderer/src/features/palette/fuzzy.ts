/**
 * Búsqueda difusa liviana para la paleta (sin dependencias).
 * Ignora mayúsculas y acentos, acepta varias palabras (todas tienen que aparecer, en cualquier orden)
 * y premia coincidencias seguidas, al principio de palabra y en el título.
 * Sin imports a propósito: así se prueba con Node directo.
 */

export interface FuzzyItem {
  title: string
  subtitle?: string
  keywords?: string
}

export interface FuzzyMatch {
  score: number
  /** Posiciones del título que coincidieron (para resaltar). */
  title: number[]
  /** Posiciones del subtítulo que coincidieron. */
  subtitle: number[]
}

/** Minúsculas y sin acentos, carácter por carácter: los índices coinciden con el original. */
export function fold(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    const code = c.charCodeAt(0)
    if (code < 128) {
      out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : c
      continue
    }
    const f = c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    out += f.length >= 1 ? f[0] : c
  }
  return out
}

const isSep = (c: string | undefined): boolean => c === undefined || /[\s\-_/\\.:·,()«»<>[\]|#@]/.test(c)

interface TokMatch {
  score: number
  pos: number[]
}

function subsequence(tok: string, text: string, preferWordStart: boolean): TokMatch | null {
  let score = 0
  let last = -1
  const pos: number[] = []
  for (let k = 0; k < tok.length; k++) {
    const c = tok[k]
    let j = text.indexOf(c, last + 1)
    if (j === -1) return null
    if (preferWordStart && !(j === last + 1) && !isSep(text[j - 1])) {
      // Si más adelante la letra empieza una palabra, preferir esa (acrónimos: «ne» → Nuevo Espacio).
      let w = text.indexOf(c, j + 1)
      while (w !== -1 && !isSep(text[w - 1])) w = text.indexOf(c, w + 1)
      if (w !== -1) j = w
    }
    const wordStart = isSep(text[j - 1])
    score += wordStart ? 10 : 0
    score += j === last + 1 ? 6 : -Math.min(j - last - 1, 5)
    pos.push(j)
    last = j
  }
  // Acrónimo completo (todas las letras empiezan palabra): casi tan bueno como una coincidencia exacta.
  if (tok.length >= 2 && pos.every((p) => isSep(text[p - 1]))) score += 60
  return { score, pos }
}

function matchToken(tok: string, text: string, subseq = true): TokMatch | null {
  if (!text) return null
  let best: TokMatch | null = null
  let idx = text.indexOf(tok)
  while (idx !== -1) {
    const s = 100 + tok.length * 4 + (isSep(text[idx - 1]) ? 40 : 0) + (idx === 0 ? 20 : 0) - Math.min(idx, 20) / 2
    if (!best || s > best.score) best = { score: s, pos: Array.from({ length: tok.length }, (_, i) => idx + i) }
    idx = text.indexOf(tok, idx + 1)
  }
  if (best || !subseq) return best
  const a = subsequence(tok, text, false)
  const b = subsequence(tok, text, true)
  if (!a) return b
  if (!b) return a
  return b.score > a.score ? b : a
}

export function tokens(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean)
}

/** Devuelve null si no coincide. `toks` = tokens(query). */
export function fuzzyMatch(item: FuzzyItem, toks: string[]): FuzzyMatch | null {
  const t = fold(item.title)
  const s = item.subtitle ? fold(item.subtitle) : ''
  const k = item.keywords ? fold(item.keywords) : ''
  if (toks.length === 0) return { score: 0, title: [], subtitle: [] }
  let score = 0
  const tPos = new Set<number>()
  const sPos = new Set<number>()
  for (const tok of toks) {
    const mt = matchToken(tok, t)
    const ms = matchToken(tok, s, false)
    const mk = matchToken(tok, k, false)
    const st = mt ? mt.score + 15 : -Infinity
    const ss = ms ? ms.score * 0.6 : -Infinity
    const sk = mk ? mk.score * 0.5 : -Infinity
    const top = Math.max(st, ss, sk)
    if (top === -Infinity) return null
    score += top
    if (top === st && mt) mt.pos.forEach((p) => tPos.add(p))
    else if (top === ss && ms) ms.pos.forEach((p) => sPos.add(p))
  }
  const whole = toks.join(' ')
  if (t.startsWith(whole)) score += 50
  score -= t.length * 0.1
  return { score, title: [...tPos].sort((a, b) => a - b), subtitle: [...sPos].sort((a, b) => a - b) }
}

/** Filtra y ordena (mejor primero; a igual puntaje, el orden original). */
export function fuzzyFilter<T extends FuzzyItem>(items: T[], query: string): { item: T; match: FuzzyMatch }[] {
  const toks = tokens(query)
  const out: { item: T; match: FuzzyMatch; i: number }[] = []
  items.forEach((item, i) => {
    const match = fuzzyMatch(item, toks)
    if (match) out.push({ item, match, i })
  })
  if (toks.length) out.sort((a, b) => b.match.score - a.match.score || a.i - b.i)
  return out.map(({ item, match }) => ({ item, match }))
}

/** Parte un texto en tramos resaltados / no resaltados según las posiciones. */
export function splitHighlight(text: string, pos: number[]): { text: string; hl: boolean }[] {
  if (!pos.length) return [{ text, hl: false }]
  const set = new Set(pos)
  const parts: { text: string; hl: boolean }[] = []
  for (let i = 0; i < text.length; i++) {
    const hl = set.has(i)
    const last = parts[parts.length - 1]
    if (last && last.hl === hl) last.text += text[i]
    else parts.push({ text: text[i], hl })
  }
  return parts
}
