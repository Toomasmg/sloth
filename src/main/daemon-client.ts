/**
 * Cliente del daemon de terminales + backend en proceso con la misma interfaz.
 *
 * createTerminalBackend() intenta conectarse al daemon (lanzándolo con el `node` del sistema si
 * no está corriendo). Si no hay node o el daemon no levanta, devuelve un backend en proceso: la
 * app funciona igual pero las terminales mueren al cerrarla.
 */
import { EventEmitter } from 'node:events'
import { connect, type Socket } from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, sep } from 'node:path'
import * as nodePty from 'node-pty'
import type { PtyChunk, PtyStartResult } from '../shared/types'
import type {
  ClientMessage,
  DaemonMessage,
  HelloOkMsg,
  HookEventPayload,
  PendingPermission,
  SessionInfo,
  SpawnSpec
} from '../shared/daemon-protocol'
import { TerminalCore } from '../daemon/core'
import { DAEMON_SCRIPT_NAME, pipeNameFor, tokenFileFor } from '../daemon/paths'

export type { HookEventPayload, PendingPermission, SessionInfo, SpawnSpec }

export interface BackendInfo {
  mode: 'daemon' | 'inprocess'
  pid?: number
  version?: string
  /** En modo inprocess: por qué no se usa el daemon. */
  reason?: string
}

/**
 * Eventos: 'data'(id, chunks: PtyChunk[]) · 'exit'(id, code) · 'hook'(event) · 'permission'(req) ·
 * 'permission-resolved'(id) · 'disconnect'() · 'reconnect'(info) (extra: se reconectó al daemon,
 * hookUrl/hookToken pueden haber cambiado si se relanzó).
 */
export interface TerminalBackend extends EventEmitter {
  readonly mode: 'daemon' | 'inprocess'
  info(): BackendInfo
  readonly hookUrl: string
  readonly hookToken: string
  start(id: string, spawn: SpawnSpec): Promise<PtyStartResult>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  kill(id: string): Promise<void>
  list(): Promise<SessionInfo[]>
  isRunning(id: string): boolean
  shutdown(): Promise<void>
  answerPermission(reqId: string, decision: object | null): void
  pendingPermissions(): PendingPermission[]
  lastHookEvents(): Record<string, HookEventPayload>
  dispose(): void
}

export interface CreateBackendOptions {
  userDataDir: string
  appVersion: string
  /** process.resourcesPath en la app empaquetada (ahí está daemon/sloth-daemon.cjs). */
  resourcesDir?: string
  /** Raíz del proyecto en desarrollo (out/daemon/sloth-daemon.cjs y node_modules/node-pty). */
  projectRoot?: string
  log?: (msg: string) => void
  /** Forzar el backend en proceso (también con la variable SLOTH_INPROCESS=1). */
  forceInProcess?: boolean
  /** Ruta de node a usar en vez de buscarla en PATH (también SLOTH_NODE). */
  nodePath?: string
}

const CONNECT_TIMEOUT_MS = 5_000
const HELLO_TIMEOUT_MS = 3_000
const REQUEST_TIMEOUT_MS = 15_000

// ======================= Backend en proceso =======================

class InProcessBackend extends EventEmitter implements TerminalBackend {
  readonly mode = 'inprocess' as const
  private core: TerminalCore

  constructor(
    private readonly reason: string,
    private readonly appVersion: string
  ) {
    super()
    this.core = new TerminalCore(nodePty, {
      data: (id, chunks) => this.emit('data', id, chunks),
      exit: (id, code) => this.emit('exit', id, code),
      hook: (ev) => this.emit('hook', ev),
      permission: (req) => this.emit('permission', req),
      permissionResolved: (id) => this.emit('permission-resolved', id),
      streaming: () => true,
      canAskPermission: () => this.listenerCount('permission') > 0
    })
  }

  async init(): Promise<this> {
    await this.core.listen()
    return this
  }

  get hookUrl(): string {
    return this.core.hookUrl
  }
  get hookToken(): string {
    return this.core.hookToken
  }
  info(): BackendInfo {
    return { mode: 'inprocess', pid: process.pid, version: this.appVersion, reason: this.reason }
  }
  async start(id: string, spec: SpawnSpec): Promise<PtyStartResult> {
    return this.core.start(id, spec)
  }
  write(id: string, data: string): void {
    this.core.write(id, data)
  }
  resize(id: string, cols: number, rows: number): void {
    this.core.resize(id, cols, rows)
  }
  async kill(id: string): Promise<void> {
    this.core.kill(id)
  }
  async list(): Promise<SessionInfo[]> {
    return this.core.list()
  }
  isRunning(id: string): boolean {
    return this.core.isRunning(id)
  }
  async shutdown(): Promise<void> {
    this.core.killAll()
    this.core.close()
  }
  answerPermission(reqId: string, decision: object | null): void {
    this.core.answerPermission(reqId, decision)
  }
  pendingPermissions(): PendingPermission[] {
    return this.core.pendingPermissions()
  }
  lastHookEvents(): Record<string, HookEventPayload> {
    return this.core.lastHookEvents()
  }
  /** En proceso no hay persistencia: liberar = matar todo. */
  dispose(): void {
    void this.shutdown()
  }
}

// ======================= Lanzador del daemon =======================

interface Launcher {
  pipe: string
  token: string
  /** Lanza el daemon (detached). Tira si no hay node o faltan archivos. */
  launch(): void
}

function ensureToken(userDataDir: string): string {
  const file = tokenFileFor(userDataDir)
  try {
    const t = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{64}$/i.test(t)) return t
  } catch {
    /* no existe: se crea */
  }
  mkdirSync(userDataDir, { recursive: true })
  const t = randomBytes(32).toString('hex')
  writeFileSync(file, t, { encoding: 'utf8', mode: 0o600 })
  return t
}

function findNode(override?: string): string {
  const candidate = override || process.env.SLOTH_NODE
  let nodePath = candidate
  if (!nodePath) {
    try {
      const out = execFileSync('where.exe', ['node'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      nodePath = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => /\.exe$/i.test(l))
    } catch {
      nodePath = undefined
    }
  }
  if (!nodePath || !existsSync(nodePath)) throw new Error('No se encontró `node` en el PATH.')
  const v = execFileSync(nodePath, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim()
  const major = Number(/^v(\d+)/.exec(v)?.[1] ?? 0)
  if (major < 18) throw new Error(`Node ${v} es muy viejo (hace falta 18 o más).`)
  return nodePath
}

/**
 * En la app instalada, el daemon y node-pty se copian a userData/daemon-bin/<versión>: así el
 * daemon no deja archivos abiertos dentro de la carpeta de instalación y el instalador puede
 * actualizar la app aunque haya terminales vivas.
 */
function runtimeFiles(opts: CreateBackendOptions): { script: string; ptyDir: string } {
  const packagedScript = opts.resourcesDir ? join(opts.resourcesDir, 'daemon', DAEMON_SCRIPT_NAME) : ''
  if (packagedScript && existsSync(packagedScript)) {
    const srcPty = join(opts.resourcesDir!, 'app.asar.unpacked', 'node_modules', 'node-pty')
    if (!existsSync(srcPty)) throw new Error('Falta node-pty fuera del asar.')
    const binRoot = join(opts.userDataDir, 'daemon-bin')
    const safeVersion = opts.appVersion.replace(/[^0-9A-Za-z.+-]/g, '_')
    const dest = join(binRoot, safeVersion)
    const script = join(dest, DAEMON_SCRIPT_NAME)
    const ptyDir = join(dest, 'node_modules', 'node-pty')
    if (!existsSync(join(dest, '.ok'))) {
      rmSync(dest, { recursive: true, force: true })
      mkdirSync(dest, { recursive: true })
      cpSync(packagedScript, script)
      const skipDirs = new Set(['src', 'deps', 'third_party', 'scripts', 'typings', 'node-addon-api'])
      const keepPrebuild = `${process.platform}-${process.arch}`
      cpSync(srcPty, ptyDir, {
        recursive: true,
        filter: (src) => {
          const rel = src.slice(srcPty.length).split(sep).filter(Boolean)
          if (rel.length === 0) return true
          if (rel.length === 1 && skipDirs.has(rel[0])) return false
          if (rel[0] === 'prebuilds' && rel.length >= 2 && rel[1] !== keepPrebuild) return false
          const name = basename(src)
          return !/\.(pdb|map)$/i.test(name) && !/\.test\.js$/i.test(name)
        }
      })
      writeFileSync(join(dest, '.ok'), opts.appVersion)
    }
    // Versiones viejas: se borran si nadie las usa (si un daemon viejo las tiene abiertas, falla y queda).
    try {
      for (const d of readdirSync(binRoot)) {
        if (d !== safeVersion) rmSync(join(binRoot, d), { recursive: true, force: true })
      }
    } catch {
      /* en uso */
    }
    return { script, ptyDir }
  }
  if (opts.projectRoot) {
    const script = join(opts.projectRoot, 'out', 'daemon', DAEMON_SCRIPT_NAME)
    const ptyDir = join(opts.projectRoot, 'node_modules', 'node-pty')
    if (!existsSync(script)) throw new Error(`No está compilado el daemon (${script}). Corré npm run build:daemon.`)
    return { script, ptyDir }
  }
  throw new Error('No se encontró el script del daemon.')
}

function makeLauncher(opts: CreateBackendOptions): Launcher {
  const token = ensureToken(opts.userDataDir)
  return {
    pipe: pipeNameFor(opts.userDataDir),
    token,
    launch() {
      const nodePath = findNode(opts.nodePath)
      const { script, ptyDir } = runtimeFiles(opts)
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) {
        const K = k.toUpperCase()
        if (v === undefined || K.startsWith('ELECTRON_') || K === 'NODE_OPTIONS' || K.startsWith('SLOTH_') || K.startsWith('ANTIREA_')) continue
        env[k] = v
      }
      const child = spawn(
        nodePath,
        [
          '--max-old-space-size=96',
          script,
          '--user-data',
          opts.userDataDir,
          '--node-pty',
          ptyDir,
          '--app-version',
          opts.appVersion
        ],
        // cwd en userData: no dejamos tomada la carpeta de instalación.
        { detached: true, stdio: 'ignore', windowsHide: true, cwd: opts.userDataDir, env }
      )
      child.on('error', () => {})
      child.unref()
    }
  }
}

// ======================= Conexión al pipe =======================

function connectPipe(pipe: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect(pipe)
    const onErr = (e: Error): void => {
      sock.destroy()
      reject(e)
    }
    sock.once('error', onErr)
    sock.once('connect', () => {
      sock.off('error', onErr)
      resolve(sock)
    })
  })
}

/** Lee líneas JSON de un socket. */
function lineReader(sock: Socket, onMsg: (m: DaemonMessage) => void): void {
  let buf = ''
  sock.setEncoding('utf8')
  sock.on('data', (d: string) => {
    buf += d
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line) continue
      try {
        onMsg(JSON.parse(line) as DaemonMessage)
      } catch {
        /* línea inválida */
      }
    }
  })
}

interface Conn {
  sock: Socket
  hello: HelloOkMsg
  /** Mensajes que llegaron después del hello, hasta que se engancha el handler definitivo. */
  setHandler(fn: (m: DaemonMessage) => void): void
}

function handshake(sock: Socket, token: string, clientVersion: string): Promise<Conn> {
  return new Promise((resolve, reject) => {
    let handler: ((m: DaemonMessage) => void) | null = null
    const queue: DaemonMessage[] = []
    let hello: HelloOkMsg | null = null
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error('El daemon no respondió el saludo.'))
    }, HELLO_TIMEOUT_MS)
    const onClose = (): void => {
      clearTimeout(timer)
      reject(new Error('El daemon rechazó la conexión (¿token distinto?).'))
    }
    sock.once('close', onClose)
    sock.on('error', () => {})
    lineReader(sock, (m) => {
      if (!hello) {
        if (m.t !== 'hello-ok') return
        hello = m
        clearTimeout(timer)
        sock.off('close', onClose)
        resolve({
          sock,
          hello: m,
          setHandler(fn) {
            handler = fn
            for (const q of queue.splice(0)) fn(q)
          }
        })
        return
      }
      if (handler) handler(m)
      else queue.push(m)
    })
    const msg: ClientMessage = { t: 'hello', token, clientVersion }
    sock.write(JSON.stringify(msg) + '\n')
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Conecta y saluda; si no hay daemon (y se permite) lo lanza y reintenta hasta ~5 s. */
async function connectOrLaunch(l: Launcher, appVersion: string, allowLaunch: boolean): Promise<Conn> {
  try {
    return await handshake(await connectPipe(l.pipe), l.token, appVersion)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw e
    if (!allowLaunch) throw e
  }
  l.launch()
  const deadline = Date.now() + CONNECT_TIMEOUT_MS
  let last: unknown
  while (Date.now() < deadline) {
    await sleep(150)
    try {
      return await handshake(await connectPipe(l.pipe), l.token, appVersion)
    } catch (e) {
      last = e
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw e
    }
  }
  throw new Error(`El daemon no levantó en ${CONNECT_TIMEOUT_MS / 1000} s (${(last as Error)?.message ?? '?'}).`)
}

async function waitPipeGone(pipe: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      const s = await connectPipe(pipe)
      s.destroy()
    } catch {
      return
    }
    await sleep(100)
  }
}

// ======================= Backend daemon =======================

type WithoutRid<T> = T extends unknown ? Omit<T, 'rid'> : never

interface PendingReq {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

class DaemonBackend extends EventEmitter implements TerminalBackend {
  readonly mode = 'daemon' as const
  hookUrl = ''
  hookToken = ''
  private sock: Socket | null = null
  private hello!: HelloOkMsg
  private rid = 0
  private reqs = new Map<number, PendingReq>()
  private running = new Map<string, boolean>()
  private perms = new Map<string, PendingPermission>()
  private hooks: Record<string, HookEventPayload> = {}
  private disposed = false
  private reconnecting = false

  constructor(
    private readonly launcher: Launcher,
    private readonly appVersion: string,
    private readonly log: (m: string) => void
  ) {
    super()
  }

  attach(c: Conn): void {
    const before = new Set([...this.running].filter(([, r]) => r).map(([id]) => id))
    this.sock = c.sock
    this.hello = c.hello
    this.hookUrl = c.hello.hookUrl
    this.hookToken = c.hello.hookToken
    this.running = new Map(c.hello.sessions.map((s) => [s.id, s.running]))
    this.hooks = { ...c.hello.lastHookEvents }
    const oldPerms = [...this.perms.keys()]
    this.perms = new Map(c.hello.permissions.map((p) => [p.id, p]))
    for (const id of oldPerms) if (!this.perms.has(id)) this.emit('permission-resolved', id)
    // Sesiones que creíamos vivas y el daemon (relanzado) ya no tiene.
    for (const id of before) if (!this.running.get(id)) this.emit('exit', id, -1)
    c.setHandler((m) => this.onMessage(m))
    c.sock.on('error', () => {})
    c.sock.on('close', () => this.onClose(c.sock))
  }

  private onMessage(m: DaemonMessage): void {
    switch (m.t) {
      case 'reply': {
        const r = this.reqs.get(m.rid)
        if (!r) return
        this.reqs.delete(m.rid)
        clearTimeout(r.timer)
        if (m.ok) r.resolve(m.result)
        else r.reject(new Error(m.error ?? 'Error del daemon'))
        break
      }
      case 'data':
        this.emit('data', m.id, m.chunks)
        break
      case 'exit':
        if (this.running.has(m.id)) this.running.set(m.id, false)
        this.emit('exit', m.id, m.code)
        break
      case 'hook':
        this.hooks[m.event.ws] = m.event
        this.emit('hook', m.event)
        break
      case 'permission':
        this.perms.set(m.req.id, m.req)
        this.emit('permission', m.req)
        break
      case 'permission-resolved':
        this.perms.delete(m.id)
        this.emit('permission-resolved', m.id)
        break
    }
  }

  private failAll(err: Error): void {
    for (const r of this.reqs.values()) {
      clearTimeout(r.timer)
      r.reject(err)
    }
    this.reqs.clear()
  }

  private onClose(sock: Socket): void {
    if (this.sock !== sock) return
    this.sock = null
    this.failAll(new Error('Se cortó la conexión con el daemon.'))
    if (this.disposed) return
    void this.reconnect()
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return
    this.reconnecting = true
    this.log('[daemon] conexión cortada, reintentando')
    try {
      const c = await connectOrLaunch(this.launcher, this.appVersion, true)
      if (this.disposed) {
        c.sock.destroy()
        return
      }
      this.attach(c)
      this.log(`[daemon] reconectado (pid ${c.hello.pid})`)
      this.emit('reconnect', this.info())
    } catch (e) {
      this.log(`[daemon] no se pudo reconectar: ${(e as Error).message}`)
      this.emit('disconnect')
    } finally {
      this.reconnecting = false
    }
  }

  private send(msg: ClientMessage): boolean {
    if (!this.sock || this.sock.destroyed) return false
    this.sock.write(JSON.stringify(msg) + '\n')
    return true
  }

  private request<T>(msg: WithoutRid<Extract<ClientMessage, { rid: number }>>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const rid = ++this.rid
      const timer = setTimeout(() => {
        this.reqs.delete(rid)
        reject(new Error('El daemon no respondió.'))
      }, REQUEST_TIMEOUT_MS)
      this.reqs.set(rid, { resolve: resolve as (v: unknown) => void, reject, timer })
      if (!this.send({ ...msg, rid } as ClientMessage)) {
        clearTimeout(timer)
        this.reqs.delete(rid)
        reject(new Error('Sin conexión con el daemon.'))
      }
    })
  }

  info(): BackendInfo {
    return { mode: 'daemon', pid: this.hello?.pid, version: this.hello?.version }
  }

  async start(id: string, spec: SpawnSpec): Promise<PtyStartResult> {
    const r = await this.request<PtyStartResult>({ t: 'start', id, spawn: spec })
    this.running.set(id, r.running)
    return r
  }
  write(id: string, data: string): void {
    this.send({ t: 'write', id, data })
  }
  resize(id: string, cols: number, rows: number): void {
    this.send({ t: 'resize', id, cols, rows })
  }
  async kill(id: string): Promise<void> {
    this.running.delete(id)
    delete this.hooks[id]
    await this.request({ t: 'kill', id })
  }
  async list(): Promise<SessionInfo[]> {
    const l = await this.request<SessionInfo[]>({ t: 'list' })
    this.running = new Map(l.map((s) => [s.id, s.running]))
    return l
  }
  isRunning(id: string): boolean {
    return this.running.get(id) ?? false
  }
  async shutdown(): Promise<void> {
    this.disposed = true
    const sock = this.sock
    try {
      await this.request({ t: 'shutdown' })
    } catch {
      /* ya se fue */
    }
    if (sock && !sock.destroyed) await new Promise<void>((r) => sock.once('close', () => r()))
    this.running.clear()
    await waitPipeGone(this.launcher.pipe, 3000)
  }
  answerPermission(reqId: string, decision: object | null): void {
    this.send({ t: 'permission-answer', reqId, decision })
  }
  pendingPermissions(): PendingPermission[] {
    return [...this.perms.values()]
  }
  lastHookEvents(): Record<string, HookEventPayload> {
    return { ...this.hooks }
  }
  /** Suelta la conexión; el daemon y sus terminales siguen vivos. */
  dispose(): void {
    this.disposed = true
    this.failAll(new Error('Backend liberado.'))
    this.sock?.end()
    this.sock = null
  }
}

// ======================= Fábrica =======================

export async function createTerminalBackend(opts: CreateBackendOptions): Promise<TerminalBackend> {
  const log = opts.log ?? ((m: string) => console.log(m))
  const inProcess = async (reason: string): Promise<TerminalBackend> => {
    log(`[daemon] usando terminales en proceso: ${reason}`)
    return new InProcessBackend(reason, opts.appVersion).init()
  }
  if (opts.forceInProcess || process.env.SLOTH_INPROCESS === '1') return inProcess('forzado por configuración')

  try {
    const launcher = makeLauncher(opts)
    let c = await connectOrLaunch(launcher, opts.appVersion, true)
    if (c.hello.version !== opts.appVersion) {
      const busy = c.hello.sessions.some((s) => s.running)
      if (busy) {
        log(`[daemon] versión ${c.hello.version} ≠ ${opts.appVersion}, pero tiene terminales vivas: se sigue usando`)
      } else {
        log(`[daemon] versión ${c.hello.version} ≠ ${opts.appVersion}: se reinicia`)
        const old = new DaemonBackend(launcher, opts.appVersion, log)
        old.attach(c)
        await old.shutdown()
        c = await connectOrLaunch(launcher, opts.appVersion, true)
      }
    }
    const b = new DaemonBackend(launcher, opts.appVersion, log)
    b.attach(c)
    log(`[daemon] conectado (pid ${c.hello.pid}, versión ${c.hello.version})`)
    return b
  } catch (e) {
    return inProcess((e as Error)?.message ?? String(e))
  }
}
