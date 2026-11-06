import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Account, AccountUsage, UsageTotals } from '../shared/types'

const DAY = 24 * 60 * 60 * 1000
const WINDOW_5H = 5 * 60 * 60 * 1000
const MAX_DEPTH = 4
const READ_BLOCK = 1024 * 1024

interface Entry {
  id: string
  ts: number
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

interface FileCache {
  /** Bytes ya leídos (siempre hasta el último salto de línea). */
  offset: number
  mtimeMs: number
  entries: Map<string, Entry>
}

const empty = (): UsageTotals => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0 })

function add(t: UsageTotals, e: Entry): void {
  t.input += e.input
  t.output += e.output
  t.cacheWrite += e.cacheWrite
  t.cacheRead += e.cacheRead
  t.messages += 1
}

function parseLine(line: string): Entry | undefined {
  if (!line.includes('"usage"')) return undefined
  try {
    const j = JSON.parse(line) as {
      type?: string
      timestamp?: string
      requestId?: string
      message?: {
        id?: string
        usage?: {
          input_tokens?: number
          output_tokens?: number
          cache_creation_input_tokens?: number
          cache_read_input_tokens?: number
        }
      }
    }
    const u = j.message?.usage
    if (j.type !== 'assistant' || !u || !j.timestamp) return undefined
    const ts = Date.parse(j.timestamp)
    if (Number.isNaN(ts)) return undefined
    return {
      // Un mismo mensaje aparece en varias líneas (una por bloque): se cuenta una sola vez.
      id: j.message?.id ?? j.requestId ?? `${ts}`,
      ts,
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0
    }
  } catch {
    return undefined
  }
}

async function listJsonl(dir: string, depth = 0, out: string[] = []): Promise<string[]> {
  let items
  try {
    items = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const it of items) {
    const p = join(dir, it.name)
    if (it.isDirectory() && depth < MAX_DEPTH) await listJsonl(p, depth + 1, out)
    else if (it.isFile() && it.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

export class UsageScanner {
  private cache = new Map<string, FileCache>()
  private running?: Promise<Record<string, AccountUsage>>
  private last: Record<string, AccountUsage> = {}

  /** Escanea todas las cuentas; si ya hay un escaneo en curso, devuelve ese. */
  scan(accounts: Account[]): Promise<Record<string, AccountUsage>> {
    const fresh = Object.values(this.last)[0]?.scannedAt
    const sameAccounts = accounts.every((a) => a.id in this.last)
    if (!this.running && fresh && sameAccounts && Date.now() - fresh < 20_000) return Promise.resolve(this.last)
    if (!this.running) {
      this.running = this.doScan(accounts).finally(() => (this.running = undefined))
    }
    return this.running
  }

  get latest(): Record<string, AccountUsage> {
    return this.last
  }

  private async readNew(file: string, since: number): Promise<FileCache | undefined> {
    let st
    try {
      st = await stat(file)
    } catch {
      this.cache.delete(file)
      return undefined
    }
    if (st.mtimeMs < since) return this.cache.get(file)
    let c = this.cache.get(file)
    if (c && st.size < c.offset) c = undefined // el archivo se reescribió
    if (!c) c = { offset: 0, mtimeMs: 0, entries: new Map() }
    if (c.mtimeMs === st.mtimeMs && c.offset === st.size) return c

    // Lectura por bloques: memoria acotada aunque el transcript pese cientos de MB.
    const fh = await open(file, 'r')
    try {
      const buf = Buffer.allocUnsafe(READ_BLOCK)
      // Se corta siempre en '\n' (byte 0x0a, nunca parte de un carácter UTF-8 multibyte).
      let carry: Buffer = Buffer.alloc(0)
      let pos = c.offset
      while (pos < st.size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(READ_BLOCK, st.size - pos), pos)
        if (bytesRead <= 0) break
        pos += bytesRead
        const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead)
        const lastNl = chunk.lastIndexOf(0x0a)
        if (lastNl < 0) {
          carry = Buffer.from(chunk)
          continue
        }
        for (const line of chunk.toString('utf8', 0, lastNl).split('\n')) {
          const e = parseLine(line)
          if (e) c.entries.set(e.id, e)
        }
        carry = Buffer.from(chunk.subarray(lastNl + 1))
        // Ceder el event loop entre bloques para no trabar la app.
        await new Promise<void>((r) => setImmediate(r))
      }
      // Lo que quedó sin salto de línea se relee la próxima vez.
      c.offset = pos - carry.length
      c.mtimeMs = st.mtimeMs
    } finally {
      await fh.close()
    }
    // Lo viejo no se usa más: se descarta para no crecer sin límite.
    for (const [id, e] of c.entries) if (e.ts < since) c.entries.delete(id)
    this.cache.set(file, c)
    return c
  }

  private async doScan(accounts: Account[]): Promise<Record<string, AccountUsage>> {
    const now = Date.now()
    const since7d = now - 7 * DAY
    const midnight = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime()
    const result: Record<string, AccountUsage> = {}
    for (const acc of accounts) {
      const files = await listJsonl(join(acc.configDir, 'projects'))
      const seen = new Map<string, Entry>()
      for (const f of files) {
        const c = await this.readNew(f, since7d)
        if (c) for (const e of c.entries.values()) seen.set(e.id, e)
      }
      const usage: AccountUsage = { last5h: empty(), today: empty(), last7d: empty(), scannedAt: now }
      for (const e of seen.values()) {
        if (e.ts < since7d) continue
        add(usage.last7d, e)
        if (e.ts >= midnight) add(usage.today, e)
        if (e.ts >= now - WINDOW_5H) {
          add(usage.last5h, e)
          if (!usage.windowStart || e.ts < usage.windowStart) usage.windowStart = e.ts
        }
      }
      result[acc.id] = usage
    }
    this.last = result
    return result
  }
}
