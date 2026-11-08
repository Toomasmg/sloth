/**
 * Lógica pura de «history» (sin Electron): buscar texto en los transcripts de Claude Code de
 * varias cuentas, por bloques de 1 MB, sin distinguir mayúsculas ni acentos.
 */
import { createReadStream } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { isAbsolute, join, relative, resolve } from 'node:path'

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

// ---------------------------------------------------------------------------
// Sesiones (página «Historial de sesiones»): resumen de cada transcript y detalle.
// Todo sale de los .jsonl que Claude Code ya escribe; Sloth no modifica ni borra esos archivos.
// ---------------------------------------------------------------------------

/** Solo se listan las conversaciones modificadas en los últimos días (el rango más largo de la UI). */
export const SESSION_RANGE_DAYS = 30
export const MAX_SESSION_FILES = 400
const MAX_FILES_PER_SESSION = 200
const MAX_TOOL_LINES = 30
const MAX_TEXT = 20_000
const MAX_DETAIL_ITEMS = 3000

export interface FileTouch {
  path: string
  add: number
  del: number
}

export type ToolKind = 'read' | 'edit' | 'run' | 'other'

export type DetailItem =
  | { k: 'msg'; role: 'user' | 'assistant'; text: string }
  | { k: 'tool'; kind: ToolKind; title: string; cmd: string; meta: string; err: boolean; lines: string[] }

export interface ParsedSession {
  title: string
  cwd: string
  branch: string
  /** ms del primer mensaje */
  start: number
  /** ms del último mensaje */
  end: number
  messages: number
  tools: number
  files: FileTouch[]
  /** ok: la última respuesta es de Claude. int: quedó sin contestar (se cortó, pidió algo, etc.). */
  status: 'ok' | 'int'
  /** Última respuesta de texto de Claude (recortada). */
  lastAnswer: string
}

export interface ParsedDetail extends ParsedSession {
  items: DetailItem[]
}

/** Fila de la lista (lo que devuelve main; el espacio lo agrega history.ts). */
export interface SessionRow {
  key: string
  accountId: string
  accountLabel: string
  sessionId: string
  cwd: string
  /** Espacio de Sloth con esa carpeta, o null si no hay ninguno. */
  spaceId: string | null
  /** Clave para filtrar: el id del espacio, o «cwd:<carpeta>» si no hay espacio. */
  spaceKey: string
  spaceName: string
  branch: string
  title: string
  start: number
  end: number
  messages: number
  tools: number
  files: FileTouch[]
  status: 'ok' | 'int'
}

export interface SessionInfo extends SessionRow {
  lastAnswer: string
  items: DetailItem[]
}

const nlCount = (s: unknown): number => (typeof s === 'string' && s.length > 0 ? s.split('\n').length : 0)
const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)

type Block = Record<string, unknown>

export function toolKind(name: string): ToolKind {
  if (['Read', 'Grep', 'Glob', 'LS'].includes(name)) return 'read'
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return 'edit'
  if (name === 'Bash' || name === 'BashOutput') return 'run'
  return 'other'
}

export interface Described {
  kind: ToolKind
  title: string
  cmd: string
  meta: string
  lines: string[]
  file: string
  add: number
  del: number
}

/** Título y datos visibles de un uso de herramienta. Solo lee lo que la herramienta declara en su entrada. */
export function describeTool(name: string, inp: Record<string, unknown>): Described {
  const s = (k: string): string => (typeof inp[k] === 'string' ? (inp[k] as string) : '')
  const d: Described = { kind: toolKind(name), title: name, cmd: '', meta: '', lines: [], file: '', add: 0, del: 0 }
  switch (name) {
    case 'Read': {
      d.file = s('file_path')
      d.title = `Leyó ${baseName(d.file) || 'un archivo'}`
      d.lines = d.file ? [d.file] : []
      d.meta = 'solo lectura'
      break
    }
    case 'Grep':
    case 'Glob': {
      const pat = clip(oneLine(s('pattern')), 60)
      d.title = name === 'Grep' ? `Buscó «${pat}»` : `Buscó archivos «${pat}»`
      d.meta = 'solo lectura'
      break
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      d.file = s('file_path') || s('notebook_path')
      if (name === 'Edit') {
        d.add = nlCount(s('new_string'))
        d.del = nlCount(s('old_string'))
      } else if (name === 'Write') {
        d.add = nlCount(s('content'))
      } else if (name === 'NotebookEdit') {
        d.add = nlCount(s('new_source'))
      } else {
        const eds = Array.isArray(inp.edits) ? (inp.edits as Block[]) : []
        for (const e of eds) {
          d.add += nlCount(e.new_string)
          d.del += nlCount(e.old_string)
        }
      }
      d.title = `${name === 'Write' ? 'Creó' : 'Editó'} ${baseName(d.file) || 'un archivo'}`
      d.meta = `+${d.add} −${d.del}`
      d.lines = d.file ? [d.file] : []
      break
    }
    case 'Bash': {
      const cmd = s('command')
      d.cmd = clip(cmd.trim(), 400)
      d.title = `Ejecutó ${clip(oneLine(s('description') || cmd), 80)}`
      break
    }
    default:
      break
  }
  return d
}

/** Texto de un tool_result (string o bloques de texto). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

/**
 * Recorre un transcript (.jsonl) línea por línea y arma el resumen. Con `withItems`, también la
 * conversación y los bloques de herramientas (para el detalle). No carga el archivo entero en memoria.
 */
export async function parseTranscript(file: string, withItems = false, maxLine = 8 * 1024 * 1024): Promise<ParsedDetail> {
  const out: ParsedDetail = {
    title: '',
    cwd: '',
    branch: '',
    start: 0,
    end: 0,
    messages: 0,
    tools: 0,
    files: [],
    status: 'int',
    lastAnswer: '',
    items: []
  }
  const touched = new Map<string, FileTouch>()
  const pending = new Map<string, Extract<DetailItem, { k: 'tool' }>>()
  let summaryTitle = ''
  let firstUser = ''
  let last: 'answer' | 'other' = 'other'

  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line || line.length > maxLine) continue
      if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes('"type":"summary"')) continue
      let j: Record<string, unknown>
      try {
        j = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      const ts = typeof j.timestamp === 'string' ? Date.parse(j.timestamp) : NaN
      if (!Number.isNaN(ts)) {
        if (!out.start || ts < out.start) out.start = ts
        if (ts > out.end) out.end = ts
      }
      if (j.type === 'summary') {
        if (!summaryTitle && typeof j.summary === 'string') summaryTitle = oneLine(j.summary)
        continue
      }
      if (j.isSidechain) continue
      if (!out.cwd && typeof j.cwd === 'string') out.cwd = j.cwd
      if (typeof j.gitBranch === 'string' && j.gitBranch) out.branch = j.gitBranch
      const msg = (j.message ?? {}) as { content?: unknown }
      const content = msg.content

      if (j.type === 'user') {
        if (j.isMeta) continue
        if (Array.isArray(content)) {
          for (const b of content as Block[]) {
            if (b.type !== 'tool_result') continue
            const id = String(b.tool_use_id ?? '')
            const it = pending.get(id)
            if (!it) continue
            pending.delete(id)
            it.err = b.is_error === true
            it.lines = resultText(b.content).split('\n').filter((l) => l.length > 0).slice(0, MAX_TOOL_LINES)
            if (it.kind === 'run') it.meta = it.err ? 'con errores' : 'salió bien'
            last = 'other'
          }
        }
        const text = (typeof content === 'string' ? content : messageText(content)).trim()
        if (text) {
          out.messages++
          if (!firstUser && !text.startsWith('<')) firstUser = oneLine(text)
          if (withItems && out.items.length < MAX_DETAIL_ITEMS) out.items.push({ k: 'msg', role: 'user', text: clip(text, MAX_TEXT) })
          last = 'other'
        }
        continue
      }

      if (j.type !== 'assistant') continue
      const blocks: Block[] = Array.isArray(content)
        ? (content as Block[])
        : typeof content === 'string'
          ? [{ type: 'text', text: content }]
          : []
      const texts: string[] = []
      let uses = 0
      for (const b of blocks) {
        if (b.type === 'text' && typeof b.text === 'string') {
          if (b.text.trim()) texts.push(b.text.trim())
          continue
        }
        if (b.type !== 'tool_use') continue
        uses++
        out.tools++
        const inp = (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>
        const d = describeTool(String(b.name ?? ''), inp)
        if (d.file) {
          const t = touched.get(d.file) ?? { path: d.file, add: 0, del: 0 }
          t.add += d.add
          t.del += d.del
          touched.set(d.file, t)
        }
        if (withItems && out.items.length < MAX_DETAIL_ITEMS) {
          const item: Extract<DetailItem, { k: 'tool' }> = {
            k: 'tool',
            kind: d.kind,
            title: d.title,
            cmd: d.cmd,
            meta: d.meta,
            err: false,
            lines: d.lines
          }
          out.items.push(item)
          if (typeof b.id === 'string') pending.set(b.id, item)
        }
      }
      const text = texts.join('\n')
      if (text) {
        out.messages++
        out.lastAnswer = clip(text, 4000)
        if (withItems && out.items.length < MAX_DETAIL_ITEMS) out.items.push({ k: 'msg', role: 'assistant', text: clip(text, MAX_TEXT) })
      }
      if (uses > 0) last = 'other'
      else if (text) last = 'answer'
    }
  } finally {
    rl.close()
  }

  out.title = clip(summaryTitle || firstUser || 'Sin título', 140)
  out.status = last === 'answer' ? 'ok' : 'int'
  out.lastAnswer = clip(out.lastAnswer, 700)
  out.files = [...touched.values()].slice(0, MAX_FILES_PER_SESSION)
  if (!out.end) out.end = out.start
  return out
}

/** Transcripts modificados desde `sinceMs`, como mucho `MAX_SESSION_FILES`. */
export async function listRecentSessions(accounts: SearchAccount[], sinceMs: number): Promise<SessionFile[]> {
  return (await listSessions(accounts)).filter((f) => f.mtimeMs >= sinceMs).slice(0, MAX_SESSION_FILES)
}

const fmtWhen = (ms: number): string =>
  new Date(ms).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

export function durationMin(start: number, end: number): number {
  return Math.max(1, Math.round((end - start) / 60_000))
}

/** Markdown de una conversación para «Exportar como Markdown». */
export function sessionMarkdown(s: SessionInfo, spaceName: string): string {
  const L: string[] = []
  const mins = durationMin(s.start, s.end)
  const dur = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`
  L.push(`# ${s.title}`, '')
  L.push(`- **Espacio:** ${spaceName}`)
  L.push(`- **Cuenta:** ${s.accountLabel}`)
  L.push(`- **Carpeta:** ${s.cwd}`)
  if (s.branch) L.push(`- **Rama:** ${s.branch}`)
  L.push(`- **Inicio:** ${fmtWhen(s.start)} · **Duración:** ${dur} · **Mensajes:** ${s.messages}`)
  L.push(`- **Estado:** ${s.status === 'ok' ? 'Terminada' : 'Interrumpida'}`)
  L.push(`- **Id de la conversación:** ${s.sessionId}`, '')
  if (s.lastAnswer) L.push('## Última respuesta de Claude', '', s.lastAnswer, '')
  L.push('## Conversación', '')
  for (const it of s.items) {
    if (it.k === 'msg') {
      L.push(it.role === 'user' ? '**Vos:**' : '**Claude:**', '', it.text, '')
    } else {
      L.push(`> ${it.title}${it.meta ? ` · ${it.meta}` : ''}`)
      if (it.cmd) L.push('', '```bash', `$ ${it.cmd}`, '```')
      if (it.kind === 'run' && it.lines.length) L.push('', '```text', ...it.lines, '```')
      L.push('')
    }
  }
  if (s.files.length) {
    L.push('## Archivos tocados', '', '| Archivo | + | − |', '| --- | ---: | ---: |')
    for (const f of s.files) L.push(`| ${f.path.replace(/\|/g, '\\|')} | ${f.add} | ${f.del} |`)
    L.push('')
  }
  return L.join('\n')
}

// ---------------------------------------------------------------------------
// Fijadas y ocultas (de Sloth, no de Claude). Se guardan en userData/features/history.json.
// ---------------------------------------------------------------------------

/** `<id de cuenta>:<uuid de la conversación>`. */
export const SESSION_KEY_RE = /^[A-Za-z0-9-]{1,64}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_KEYS = 5000

export interface HistoryPrefs {
  pinned: string[]
  hidden: string[]
}

export function parseHistoryPrefs(raw: unknown): HistoryPrefs {
  const pick = (v: unknown): string[] =>
    Array.isArray(v)
      ? [...new Set(v.filter((k): k is string => typeof k === 'string' && SESSION_KEY_RE.test(k)))].slice(0, MAX_KEYS)
      : []
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return { pinned: pick(o.pinned), hidden: pick(o.hidden) }
}

/** Marca o desmarca una clave en una lista. Devuelve null si la clave no es válida. */
export function setPref(prefs: HistoryPrefs, which: 'pinned' | 'hidden', key: string, on: boolean): HistoryPrefs | null {
  if (!SESSION_KEY_RE.test(key)) return null
  const rest = prefs[which].filter((k) => k !== key)
  return { ...prefs, [which]: on ? [...rest, key].slice(-MAX_KEYS) : rest }
}

/** Carpeta de proyectos de una cuenta de Claude (`<configDir>/projects`). */
export const projectsRoot = (configDir: string): string => join(configDir, 'projects')

/**
 * true si `target` queda dentro de `projects/` de la cuenta y no es la carpeta en sí: al menos
 * `<carpeta>/<algo>`. Así nunca se toca nada fuera de las conversaciones.
 */
export function isInsideProjects(configDir: string, target: string): boolean {
  const rel = relative(resolve(projectsRoot(configDir)), resolve(target))
  if (!rel || isAbsolute(rel)) return false
  const parts = rel.split(/[\\/]+/)
  return parts[0] !== '..' && parts.length >= 2 && parts.every((p) => p !== '' && p !== '.' && p !== '..')
}

/**
 * Rutas que se mandan a la Papelera para borrar una conversación: su `<id>.jsonl` y la carpeta con el
 * mismo id (si Claude la guardó). Null si el id o la carpeta no son válidos o queda algo fuera de projects/.
 */
export function sessionTrashPaths(
  configDir: string,
  slug: string,
  sessionId: string
): { file: string; dir: string } | null {
  if (!UUID_RE.test(sessionId)) return null
  if (!slug || slug === '.' || slug === '..' || /[\\/]/.test(slug)) return null
  const file = join(projectsRoot(configDir), slug, `${sessionId}.jsonl`)
  const dir = join(projectsRoot(configDir), slug, sessionId)
  if (!isInsideProjects(configDir, file) || !isInsideProjects(configDir, dir)) return null
  return { file, dir }
}
