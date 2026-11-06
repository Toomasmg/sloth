/**
 * Lógica pura de «history» (sin Electron): buscar texto en los transcripts de Claude Code de
 * varias cuentas, por bloques de 1 MB, sin distinguir mayúsculas ni acentos.
 */
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const BLOCK = 1024 * 1024
/** Una línea más larga que esto (p. ej. imágenes en base64) se saltea. */
const MAX_LINE = 8 * 1024 * 1024
export const MAX_RESULTS = 200
/** Para que una sola conversación no se coma todos los resultados. */
export const MAX_PER_SESSION = 25

export interface SearchAccount {
  id: string
  label: string
  configDir: string
}

export interface HistoryItem {
  accountId: string
  accountLabel: string
  sessionId: string
  cwd: string
  /** ms */
  ts: number
  role: 'user' | 'assistant'
  before: string
  match: string
  after: string
}

export interface SessionFile {
  account: SearchAccount
  sessionId: string
  file: string
  mtimeMs: number
  size: number
}

/** Minúsculas y sin marcas diacríticas (NFD). */
export const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** Letra base → todas sus variantes con acento (Latin-1 y Latin Extended-A). */
const VARIANTS: Map<string, string> = (() => {
  const m = new Map<string, Set<string>>()
  for (let cp = 0xc0; cp <= 0x17f; cp++) {
    const ch = String.fromCodePoint(cp)
    const base = fold(ch)
    if (base.length !== 1 || !/[a-z]/.test(base)) continue
    if (!m.has(base)) m.set(base, new Set([base]))
    const low = ch.toLowerCase()
    if (low.length === 1) m.get(base)!.add(low)
  }
  return new Map([...m].map(([k, v]) => [k, [...v].join('')]))
})()

/** Escape fuera de una clase (en modo u no se puede escapar '-' ni '/'). */
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Escape dentro de [...]. */
const escClass = (s: string): string => s.replace(/[\]\\^-]/g, '\\$&')

/**
 * Regex equivalente a «contiene `query` sin mayúsculas ni acentos», que se puede correr directo
 * sobre el texto crudo (o sobre el JSON: tolera `\n` escapados entre palabras y `\\` en rutas).
 */
export function buildMatcher(query: string, forJson = false): RegExp {
  const q = fold(query).trim().replace(/\s+/g, ' ')
  let src = ''
  for (const ch of q) {
    if (ch === ' ') src += forJson ? '(?:\\s|\\\\[nrt])+' : '\\s+'
    else if (ch === '\\' && forJson) src += '\\\\{1,2}'
    else if (ch === '"' && forJson) src += '\\\\?"'
    else {
      const v = VARIANTS.get(ch)
      src += (v ? `[${escClass(v)}]` : esc(ch)) + '\\p{M}*'
    }
  }
  return new RegExp(src, forJson ? 'iu' : 'giu')
}

/** Todas las conversaciones (projects/<carpeta>/<uuid>.jsonl) de las cuentas, más nuevas primero. */
export async function listSessions(accounts: SearchAccount[]): Promise<SessionFile[]> {
  const out: SessionFile[] = []
  for (const account of accounts) {
    const root = join(account.configDir, 'projects')
    let dirs: string[]
    try {
      dirs = await readdir(root)
    } catch {
      continue
    }
    for (const d of dirs) {
      let names: string[]
      try {
        names = await readdir(join(root, d))
      } catch {
        continue
      }
      for (const n of names) {
        if (!n.endsWith('.jsonl') || !UUID_RE.test(n.slice(0, -6))) continue
        const file = join(root, d, n)
        try {
          const st = await stat(file)
          if (st.isFile() && st.size > 0) out.push({ account, sessionId: n.slice(0, -6), file, mtimeMs: st.mtimeMs, size: st.size })
        } catch {
          /* desapareció */
        }
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

interface Line {
  type?: string
  isMeta?: boolean
  isSidechain?: boolean
  timestamp?: string
  cwd?: string
  sessionId?: string
  message?: { role?: string; content?: unknown }
}

/** Texto visible del mensaje: content string o bloques type:'text' (sin tool_result ni thinking). */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content) {
    if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
      const t = (b as { text?: unknown }).text
      if (typeof t === 'string') parts.push(t)
    }
  }
  return parts.join('\n')
}

const BEFORE = 70
const AFTER = 130

function snippet(text: string, index: number, len: number): Pick<HistoryItem, 'before' | 'match' | 'after'> {
  const clean = (s: string): string => s.replace(/\s+/g, ' ')
  let before = text.slice(Math.max(0, index - BEFORE), index)
  let after = text.slice(index + len, index + len + AFTER)
  if (index > BEFORE) before = '…' + before.replace(/^\S*\s/, '')
  if (index + len + AFTER < text.length) after = after.replace(/\s\S*$/, '') + '…'
  return { before: clean(before).trimStart(), match: clean(text.slice(index, index + len)), after: clean(after).trimEnd() }
}

export interface SearchControl {
  cancelled: boolean
}

export interface SearchStats {
  files: number
  bytes: number
  total: number
  truncated: boolean
  cancelled: boolean
}

/**
 * Recorre los archivos en orden y llama a `onItems` con los resultados de cada archivo apenas los
 * tiene. Lee de a bloques de 1 MB cortando en '\n' y cede el event loop entre bloques.
 * Los bloques que no contienen la búsqueda ni se parsean.
 */
export async function searchSessions(
  files: SessionFile[],
  query: string,
  ctl: SearchControl,
  onItems: (items: HistoryItem[]) => void,
  opts: { accountId?: string; max?: number } = {}
): Promise<SearchStats> {
  const max = opts.max ?? MAX_RESULTS
  const blockRe = buildMatcher(query, true)
  const textRe = buildMatcher(query, false)
  const stats: SearchStats = { files: 0, bytes: 0, total: 0, truncated: false, cancelled: false }
  const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

  for (const f of files) {
    if (opts.accountId && f.account.id !== opts.accountId) continue
    if (ctl.cancelled) break
    if (stats.total >= max) {
      stats.truncated = true
      break
    }
    stats.files++
    const found: HistoryItem[] = []
    let perSession = 0
    let cwd = ''
    let fh
    try {
      fh = await open(f.file, 'r')
      let pos = 0
      let rest: Buffer = Buffer.alloc(0)
      const chunk = Buffer.alloc(BLOCK)
      for (;;) {
        if (ctl.cancelled) break
        const { bytesRead } = await fh.read(chunk, 0, BLOCK, pos)
        const eof = bytesRead === 0
        pos += bytesRead
        stats.bytes += bytesRead
        let buf = rest.length ? Buffer.concat([rest, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
        let cut = eof ? buf.length : buf.lastIndexOf(0x0a)
        if (cut < 0) {
          // Línea más larga que el bloque: se acumula (con tope).
          rest = buf.length > MAX_LINE ? Buffer.alloc(0) : Buffer.from(buf)
          if (eof) break
          continue
        }
        const text = buf.subarray(0, cut).toString('utf8')
        rest = eof ? Buffer.alloc(0) : Buffer.from(buf.subarray(cut + 1))
        buf = Buffer.alloc(0)
        // El cwd viene en casi todas las líneas: tomamos el primero que aparezca aunque no haya coincidencia.
        if (!cwd) {
          const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(text)
          if (m) {
            try {
              cwd = JSON.parse(`"${m[1]}"`) as string
            } catch {
              /* raro */
            }
          }
        }
        if (blockRe.test(text) && perSession < MAX_PER_SESSION) {
          for (const line of text.split('\n')) {
            if (perSession >= MAX_PER_SESSION || stats.total + found.length >= max) break
            if (!line || !blockRe.test(line)) continue
            if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue
            let j: Line
            try {
              j = JSON.parse(line) as Line
            } catch {
              continue
            }
            if ((j.type !== 'user' && j.type !== 'assistant') || j.isMeta || j.isSidechain) continue
            const body = messageText(j.message?.content)
            if (!body) continue
            textRe.lastIndex = 0
            const m = textRe.exec(body)
            if (!m) continue
            if (j.cwd) cwd = j.cwd
            const ts = j.timestamp ? Date.parse(j.timestamp) : NaN
            found.push({
              accountId: f.account.id,
              accountLabel: f.account.label,
              sessionId: f.sessionId,
              cwd: j.cwd ?? cwd,
              ts: Number.isNaN(ts) ? f.mtimeMs : ts,
              role: j.type,
              ...snippet(body, m.index, m[0].length)
            })
            perSession++
          }
        }
        if (eof) break
        await yieldLoop()
      }
    } catch {
      /* archivo ilegible: seguir con el próximo */
    } finally {
      await fh?.close().catch(() => undefined)
    }
    if (found.length) {
      for (const it of found) if (!it.cwd) it.cwd = cwd
      stats.total += found.length
      if (!ctl.cancelled) onItems(found)
    }
    if (stats.total >= max) stats.truncated = true
    await yieldLoop()
  }
  stats.cancelled = ctl.cancelled
  return stats
}
