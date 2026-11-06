/**
 * Lógica pura de «rotation» (sin Electron): detectar el aviso de límite de Claude Code y copiar
 * una conversación de una cuenta a otra. Se prueba con scripts de Node sobre un árbol falso.
 *
 * Forma real del aviso (transcripts de Claude Code 2.1.x): una línea `type:"assistant"` sintética
 * (`model:"<synthetic>"`) con `isApiErrorMessage:true`, `error:"rate_limit"`,
 * `apiError:"usage_limit_reached"`, `apiErrorParams.rate_limit_info.resetsAt` (segundos) y el texto
 * «You've hit your session limit · resets 2:30pm (America/Argentina/Buenos_Aires)»
 * (también «You've hit your 5-hour limit · …»). En la terminal se ve ese mismo texto.
 */
import { constants as FS } from 'node:fs'
import { copyFile, cp, mkdir, open, readdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface LimitInfo {
  /** Momento de renovación (ms), si se conoce. */
  resetsAt?: number
  /** «2:30pm» tal como lo dice Claude, si no vino la hora exacta. */
  resetsLabel?: string
  /** five_hour, seven_day, … */
  kind?: string
  text: string
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Claude guarda cada conversación en projects/<cwd con todo lo no alfanumérico como '-'>. */
export const projectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
export const stripAnsi = (s: string): string => s.replace(ANSI_RE, '')
/** Para la salida de la terminal: los saltos de cursor (CSI n C / saltos de línea de cursor) cuentan como espacio. */
// eslint-disable-next-line no-control-regex
export const stripAnsiPty = (s: string): string => stripAnsi(s.replace(/\x1b\[\d*[CEG]|\x1b\[\d+;\d+H/g, ' '))

/** Texto del aviso, en terminal o transcript. Conservador: exige «hit your … limit» o «usage limit reached». */
const LIMIT_TEXT_RE =
  /(?:you(?:'|’)ve\s+hit\s+your\s+([a-z0-9 -]{1,24}?)\s*limit|claude\s+(?:ai\s+)?usage\s+limit\s+reached)(?:[^\n]{0,8}?resets\s+(?:at\s+)?([0-9]{1,2}(?::[0-9]{2})?\s*[ap]\.?m\.?)(?:\s*\(([^)]{1,60})\))?)?(?:\|([0-9]{10}))?/i

export function parseLimitText(raw: string): LimitInfo | undefined {
  const text = raw.replace(/\s+/g, ' ')
  const m = LIMIT_TEXT_RE.exec(text)
  if (!m) return undefined
  const info: LimitInfo = { text: m[0].trim() }
  if (m[1]) info.kind = m[1].trim()
  if (m[2]) info.resetsLabel = m[2].replace(/\s+/g, '').toLowerCase()
  if (m[4]) info.resetsAt = Number(m[4]) * 1000
  return info
}

/** En la terminal: solo el aviso con «resets» o con la marca de tiempo vieja (menos falsos positivos). */
export function parsePtyLimit(stripped: string): LimitInfo | undefined {
  const info = parseLimitText(stripped)
  if (!info) return undefined
  return info.resetsLabel || info.resetsAt ? info : undefined
}

interface TranscriptLine {
  type?: string
  isMeta?: boolean
  isApiErrorMessage?: boolean
  error?: string
  apiError?: string
  apiErrorParams?: { rate_limit_info?: { resetsAt?: number; rateLimitType?: string } }
  quotaLimits?: { resetsAt?: number; rateLimitType?: string }
  message?: { content?: unknown }
}

function firstText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const b of content) if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') return String((b as { text?: unknown }).text ?? '')
  }
  return ''
}

/** ¿Esta línea del transcript es el aviso de límite? */
export function parseLimitLine(line: string): LimitInfo | undefined {
  if (!line.includes('limit')) return undefined
  let j: TranscriptLine
  try {
    j = JSON.parse(line) as TranscriptLine
  } catch {
    return undefined
  }
  if (j.type !== 'assistant') return undefined
  const text = firstText(j.message?.content)
  const flagged = j.error === 'rate_limit' || j.apiError === 'usage_limit_reached'
  const fromText = j.isApiErrorMessage ? parseLimitText(text) : undefined
  if (!flagged && !fromText) return undefined
  const rli = j.apiErrorParams?.rate_limit_info ?? j.quotaLimits
  const info: LimitInfo = { ...(fromText ?? parseLimitText(text) ?? {}), text: text.slice(0, 300) || 'Límite de uso' }
  if (typeof rli?.resetsAt === 'number' && rli.resetsAt > 1e9) info.resetsAt = rli.resetsAt * 1000
  if (typeof rli?.rateLimitType === 'string') info.kind = rli.rateLimitType
  return info
}

/** Mensaje «relevante» (de la conversación): user o assistant que no sea meta. */
function isRelevant(line: string): boolean {
  if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return false
  try {
    const j = JSON.parse(line) as TranscriptLine
    return (j.type === 'user' || j.type === 'assistant') && !j.isMeta
  } catch {
    return false
  }
}

/**
 * Lee solo la cola del transcript (hasta `maxBytes`) y dice si el último mensaje de la
 * conversación es el aviso de límite.
 */
export async function limitAtEnd(file: string, maxBytes = 128 * 1024): Promise<LimitInfo | undefined> {
  let fh
  try {
    fh = await open(file, 'r')
    const { size } = await fh.stat()
    const len = Math.min(size, maxBytes)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    const lines = buf.toString('utf8').split('\n')
    if (len < size) lines.shift() // la primera puede estar cortada
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim()
      if (!l || !isRelevant(l)) continue
      return parseLimitLine(l)
    }
    return undefined
  } catch {
    return undefined
  } finally {
    await fh?.close().catch(() => undefined)
  }
}

export interface SessionRef {
  sessionId: string
  file: string
  mtimeMs: number
}

/** La conversación más reciente de una carpeta projects/<slug> (nombre del .jsonl = sessionId). */
export async function latestSession(projectDir: string): Promise<SessionRef | undefined> {
  let names: string[]
  try {
    names = await readdir(projectDir)
  } catch {
    return undefined
  }
  let best: SessionRef | undefined
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue
    const id = n.slice(0, -6)
    if (!UUID_RE.test(id)) continue
    try {
      const st = await stat(join(projectDir, n))
      if (!st.isFile() || st.size === 0) continue
      if (!best || st.mtimeMs > best.mtimeMs) best = { sessionId: id, file: join(projectDir, n), mtimeMs: st.mtimeMs }
    } catch {
      /* se borró mientras mirábamos */
    }
  }
  return best
}

export interface CopyReport {
  copied: boolean
  /** Si en el destino ya había un archivo con ese nombre, se renombró a esto (no se pisa nada). */
  backup?: string
  dirCopied: boolean
}

/**
 * Copia la conversación `sessionId` (y su carpeta homónima, con subagentes y resultados de
 * herramientas) de projects/<slug> de una cuenta a la otra. Nunca pisa: si el destino ya tenía
 * ese .jsonl y es distinto, lo guarda como `<id>.jsonl.sloth-<fecha>.bak`; en la carpeta solo
 * agrega lo que falta.
 */
export async function copySession(fromConfigDir: string, toConfigDir: string, cwd: string, sessionId: string): Promise<CopyReport> {
  if (!UUID_RE.test(sessionId)) throw new Error('Id de conversación inválido.')
  const slug = projectSlug(cwd)
  const srcDir = join(fromConfigDir, 'projects', slug)
  const dstDir = join(toConfigDir, 'projects', slug)
  const src = join(srcDir, `${sessionId}.jsonl`)
  const dst = join(dstDir, `${sessionId}.jsonl`)
  await mkdir(dstDir, { recursive: true })
  const report: CopyReport = { copied: false, dirCopied: false }
  const srcSt = await stat(src)
  const dstSt = await stat(dst).catch(() => undefined)
  if (dstSt && dstSt.size === srcSt.size && dstSt.mtimeMs >= srcSt.mtimeMs) {
    // Ya es la misma copia.
  } else {
    if (dstSt) {
      const backup = `${dst}.sloth-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`
      await rename(dst, backup)
      report.backup = backup
    }
    await copyFile(src, dst, FS.COPYFILE_EXCL)
    report.copied = true
  }
  const srcFolder = join(srcDir, sessionId)
  const folderSt = await stat(srcFolder).catch(() => undefined)
  if (folderSt?.isDirectory()) {
    await cp(srcFolder, join(dstDir, sessionId), { recursive: true, force: false, errorOnExist: false })
    report.dirCopied = true
  }
  return report
}

/** «2:30pm» → «14:30». */
export function labelTo24h(label: string): string | undefined {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*([ap])/i.exec(label)
  if (!m) return undefined
  let h = Number(m[1]) % 12
  if (m[3].toLowerCase() === 'p') h += 12
  return `${String(h).padStart(2, '0')}:${m[2] ?? '00'}`
}
