/**
 * Notas del release (markdown de GitHub) agrupadas en Nuevo / Mejoras / Arreglos.
 * Puro, sin Electron: lo usa main (updater.ts) y así la interfaz no parsea markdown.
 *
 * Reconoce encabezados como «## Nuevo», «### Mejoras», «## Arreglos» (con o sin acentos ni
 * dos puntos). Cualquier otro encabezado conserva su texto como grupo propio. Los viñetas sin
 * encabezado van a «Novedades».
 */

export type NoteGroupId = 'nuevo' | 'mejoras' | 'arreglos' | 'otros'
export interface NoteGroup {
  id: string
  label: string
  items: string[]
}

const MAX_ITEMS = 60
const MAX_ITEM_LEN = 300

const FIXED: { id: NoteGroupId; label: string; re: RegExp }[] = [
  { id: 'nuevo', label: 'Nuevo', re: /^(nuevo|nuevos|novedades?|lo nuevo|features?)\b/ },
  { id: 'mejoras', label: 'Mejoras', re: /^(mejoras?|cambios?|improvements?)\b/ },
  { id: 'arreglos', label: 'Arreglos', re: /^(arreglos?|correcciones?|correccion|fix(es)?|bugs?)\b/ }
]

/** Minúsculas, sin acentos ni puntuación de cierre ni emojis, para comparar encabezados. */
function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Quita el markdown en línea que no se muestra en la interfaz. */
export function plain(s: string): string {
  return s
    .replace(/\s+by @\S+\s+in\s+\S+$/i, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ITEM_LEN)
}

export function groupNotes(markdown: string | null | undefined): NoteGroup[] {
  const text = String(markdown ?? '').replace(/\r\n?/g, '\n')
  const groups = new Map<string, NoteGroup>()
  const order: string[] = []
  const add = (id: string, label: string, item: string): void => {
    if (!item) return
    let g = groups.get(id)
    if (!g) {
      g = { id, label, items: [] }
      groups.set(id, g)
      order.push(id)
    }
    if (g.items.length < MAX_ITEMS) g.items.push(item)
  }

  let current: { id: string; label: string } = { id: 'otros', label: 'Novedades' }
  let sawBullet = false
  const loose: string[] = []

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    const h = /^\s{0,3}#{1,6}\s+(.+?)\s*#*$/.exec(line)
    if (h) {
      const title = plain(h[1]).replace(/:$/, '').trim()
      const n = norm(title)
      const fixed = FIXED.find((f) => f.re.test(n))
      current = fixed ? { id: fixed.id, label: fixed.label } : { id: `h:${n}`, label: title || 'Novedades' }
      continue
    }
    const b = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line)
    if (b) {
      sawBullet = true
      add(current.id, current.label, plain(b[1]))
      continue
    }
    if (line.trim() && !/^\s*(---+|\*\*\*+)\s*$/.test(line)) loose.push(plain(line))
  }

  // Sin viñetas en ningún lado: el texto suelto son las novedades.
  if (!sawBullet) for (const l of loose) add('otros', 'Novedades', l)

  const out: NoteGroup[] = []
  for (const f of FIXED) if (groups.has(f.id)) out.push(groups.get(f.id)!)
  for (const id of order) if (!FIXED.some((f) => f.id === id)) out.push(groups.get(id)!)
  return out
}
