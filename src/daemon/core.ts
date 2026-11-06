/**
 * Núcleo compartido por el daemon y por el backend en proceso: sesiones PTY con su buffer y el
 * servidor HTTP de hooks (eventos + pedidos de permiso). No importa electron ni node-pty: el
 * módulo de node-pty se inyecta (el daemon lo carga por ruta absoluta).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type * as NodePty from 'node-pty'
import type { PtyChunk, PtyStartResult } from '../shared/types'
import {
  HOOK_EVENTS,
  type HookEventPayload,
  type PendingPermission,
  type SessionInfo,
  type SpawnSpec
} from '../shared/daemon-protocol'

export type PtyModule = typeof NodePty

export const MAX_BUFFER_CHARS = 400_000
/** Ventana de agrupado de salida hacia los clientes. */
export const FLUSH_MS = 16
export const PERMISSION_TIMEOUT_MS = 120_000
const HOOK_BODY_LIMIT = 64 * 1024
const PERMISSION_BODY_LIMIT = 256 * 1024

export interface CoreSink {
  /** Salida agrupada de una sesión (solo se llama si streaming() es true). */
  data(id: string, chunks: PtyChunk[]): void
  exit(id: string, code: number): void
  hook(event: HookEventPayload): void
  permission(req: PendingPermission): void
  permissionResolved(id: string): void
  /** Hay alguien escuchando la salida: si no, solo se guarda en el buffer (no se serializa nada). */
  streaming(): boolean
  /** Hay alguna UI que pueda contestar un pedido de permiso. */
  canAskPermission(): boolean
  /** Cambió la cantidad de sesiones corriendo (para el apagado por inactividad). */
  sessionsChanged?(): void
}

interface Session {
  proc: NodePty.IPty
  /** Buffer de salida: array de chunks con un índice de inicio (sin concatenar strings). */
  chunks: PtyChunk[]
  head: number
  size: number
  seq: number
  running: boolean
  exitCode?: number
  /** Chunks pendientes de mandar al cliente (se vacía cada FLUSH_MS). */
  out: PtyChunk[]
}

interface Waiting {
  req: PendingPermission
  res: ServerResponse
  timer: NodeJS.Timeout
}

type Log = (msg: string) => void

function tokenOk(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || given.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected))
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export class TerminalCore {
  private sessions = new Map<string, Session>()
  private flushTimer: NodeJS.Timeout | null = null
  private server?: Server
  private waiting = new Map<string, Waiting>()
  private lastHooks = new Map<string, HookEventPayload>()
  readonly hookToken = randomBytes(24).toString('hex')
  hookUrl = ''

  constructor(
    private readonly pty: PtyModule,
    private readonly sink: CoreSink,
    private readonly log: Log = () => {}
  ) {}

  // ---------------- PTYs ----------------

  isRunning(id: string): boolean {
    return this.sessions.get(id)?.running ?? false
  }

  runningCount(): number {
    let n = 0
    for (const s of this.sessions.values()) if (s.running) n++
    return n
  }

  list(): SessionInfo[] {
    return [...this.sessions].map(([id, s]) =>
      s.running ? { id, running: true } : { id, running: false, exitCode: s.exitCode }
    )
  }

  private snapshot(s: Session): PtyStartResult {
    return { chunks: s.chunks.slice(s.head), upTo: s.seq, running: s.running }
  }

  /** Si la sesión corre devuelve su buffer sin respawnear; si terminó o no existe, la arranca. */
  start(id: string, spec: SpawnSpec): PtyStartResult {
    const prev = this.sessions.get(id)
    if (prev?.running) return this.snapshot(prev)
    if (typeof spec?.file !== 'string' || !spec.file) throw new Error('spawn.file inválido')
    const proc = this.pty.spawn(spec.file, Array.isArray(spec.args) ? spec.args.map(String) : [], {
      name: 'xterm-256color',
      cols: Math.max(Number(spec.cols) || 0, 20),
      rows: Math.max(Number(spec.rows) || 0, 5),
      cwd: spec.cwd,
      env: spec.env,
      useConpty: true
    })
    const s: Session = { proc, chunks: [], head: 0, size: 0, seq: prev?.seq ?? 0, running: true, out: [] }
    this.sessions.set(id, s)
    this.log(`start ${id} pid=${proc.pid}`)
    proc.onData((data) => this.onData(s, data))
    proc.onExit(({ exitCode }) => {
      s.running = false
      s.exitCode = exitCode
      const current = this.sessions.get(id)
      // Si la sesión ya fue borrada (kill) o reemplazada, no confundimos al cliente.
      if (current === s) {
        this.flushSession(id, s)
        this.sink.exit(id, exitCode)
      } else if (!current) {
        this.sink.exit(id, exitCode)
      }
      this.log(`exit ${id} code=${exitCode}`)
      this.sink.sessionsChanged?.()
    })
    this.sink.sessionsChanged?.()
    return this.snapshot(s)
  }

  private onData(s: Session, data: string): void {
    const chunk = { seq: ++s.seq, data }
    s.chunks.push(chunk)
    s.size += data.length
    while (s.size > MAX_BUFFER_CHARS && s.chunks.length - s.head > 1) {
      s.size -= s.chunks[s.head].data.length
      s.head++
    }
    if (s.head > 1024 && s.head * 2 > s.chunks.length) {
      s.chunks = s.chunks.slice(s.head)
      s.head = 0
    }
    if (!this.sink.streaming()) return
    s.out.push(chunk)
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS)
  }

  private flushSession(id: string, s: Session): void {
    if (!s.out.length) return
    const out = s.out
    s.out = []
    if (this.sink.streaming()) this.sink.data(id, out)
  }

  private flush(): void {
    this.flushTimer = null
    for (const [id, s] of this.sessions) this.flushSession(id, s)
  }

  write(id: string, data: string): void {
    const s = this.sessions.get(id)
    if (s?.running && typeof data === 'string') s.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id)
    if (s?.running && cols > 0 && rows > 0) {
      try {
        s.proc.resize(Math.floor(cols), Math.floor(rows))
      } catch {
        /* la terminal pudo cerrarse justo ahora */
      }
    }
  }

  kill(id: string): void {
    const s = this.sessions.get(id)
    if (s?.running) {
      try {
        s.proc.kill()
      } catch {
        /* ya terminó */
      }
    }
    this.sessions.delete(id)
    this.lastHooks.delete(id)
    this.sink.sessionsChanged?.()
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }

  // ---------------- Hooks HTTP ----------------

  lastHookEvents(): Record<string, HookEventPayload> {
    return Object.fromEntries(this.lastHooks)
  }

  pendingPermissions(): PendingPermission[] {
    return [...this.waiting.values()].map((w) => w.req)
  }

  /** decision: objeto de Claude Code ({behavior:'allow'|'deny', ...}) o null (que pregunte en la terminal). */
  answerPermission(reqId: string, decision: object | null): void {
    this.resolvePermission(reqId, isPlainObject(decision) ? decision : null)
  }

  /** Todos los pendientes se contestan con null (ej. se fueron todos los clientes). */
  resolveAllPermissions(): void {
    for (const id of [...this.waiting.keys()]) this.resolvePermission(id, null)
  }

  private resolvePermission(id: string, decision: object | null): void {
    const w = this.waiting.get(id)
    if (!w) return
    this.waiting.delete(id)
    clearTimeout(w.timer)
    if (!w.res.writableEnded && !w.res.destroyed) {
      w.res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ decision }))
    }
    this.sink.permissionResolved(id)
  }

  async listen(): Promise<void> {
    this.server = createServer((req, res) => this.handleHttp(req, res))
    this.server.keepAliveTimeout = 1000
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = this.server.address()
    if (!addr || typeof addr === 'string') throw new Error('No se pudo abrir el servidor de hooks')
    this.hookUrl = `http://127.0.0.1:${addr.port}/hook`
  }

  close(): void {
    this.resolveAllPermissions()
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.server?.close()
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const route = req.url
    if (req.method !== 'POST' || (route !== '/hook' && route !== '/permission')) {
      res.writeHead(404).end()
      return
    }
    if (!tokenOk(req.headers['x-sloth-token'], this.hookToken)) {
      res.writeHead(403).end()
      return
    }
    const limit = route === '/hook' ? HOOK_BODY_LIMIT : PERMISSION_BODY_LIMIT
    const parts: Buffer[] = []
    let size = 0
    let tooBig = false
    req.on('data', (c: Buffer) => {
      if (tooBig) return
      size += c.length
      if (size > limit) {
        tooBig = true
        res.writeHead(413, { connection: 'close' }).end()
        req.resume()
        return
      }
      parts.push(c)
    })
    req.on('end', () => {
      if (tooBig) return
      let body: unknown
      try {
        body = JSON.parse(Buffer.concat(parts).toString('utf8'))
      } catch {
        res.writeHead(400).end()
        return
      }
      if (route === '/hook') this.onHook(body, res)
      else this.onPermission(body, res)
    })
  }

  private onHook(body: unknown, res: ServerResponse): void {
    res.writeHead(204).end()
    if (!isPlainObject(body)) return
    const p = body as Partial<HookEventPayload>
    if (typeof p.ws !== 'string' || !(HOOK_EVENTS as readonly string[]).includes(p.event as string)) return
    const ev: HookEventPayload = {
      ws: p.ws,
      event: p.event as HookEventPayload['event'],
      tool: typeof p.tool === 'string' ? p.tool : undefined,
      message: typeof p.message === 'string' ? p.message : undefined,
      notificationType: typeof p.notificationType === 'string' ? p.notificationType : undefined,
      at: Date.now()
    }
    this.lastHooks.set(ev.ws, ev)
    this.sink.hook(ev)
  }

  private onPermission(body: unknown, res: ServerResponse): void {
    const sendNull = (): void => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"decision":null}')
    }
    if (!isPlainObject(body) || typeof body.ws !== 'string' || typeof body.tool !== 'string') {
      res.writeHead(400).end()
      return
    }
    if (!this.sink.canAskPermission()) {
      sendNull()
      return
    }
    const now = Date.now()
    const req: PendingPermission = {
      id: randomUUID(),
      ws: body.ws,
      tool: body.tool,
      input: isPlainObject(body.input) ? body.input : {},
      suggestions: Array.isArray(body.suggestions) ? body.suggestions : undefined,
      at: now,
      expiresAt: now + PERMISSION_TIMEOUT_MS
    }
    const timer = setTimeout(() => this.resolvePermission(req.id, null), PERMISSION_TIMEOUT_MS)
    timer.unref()
    this.waiting.set(req.id, { req, res, timer })
    // Si el hook muere (Claude lo cortó o el usuario contestó en la terminal), se retira el pedido.
    res.on('close', () => {
      if (this.waiting.get(req.id)?.res === res) this.resolvePermission(req.id, null)
    })
    this.log(`permission ${req.id} ws=${req.ws} tool=${req.tool}`)
    this.sink.permission(req)
  }
}
