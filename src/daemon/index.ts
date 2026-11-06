/**
 * Daemon de terminales de Sloth. Corre con el `node` del sistema (no con Electron), así las
 * PowerShell y el servidor de hooks sobreviven al cierre de la app.
 *
 *   node sloth-daemon.cjs --user-data <dir> --node-pty <ruta a node_modules/node-pty> [--app-version x]
 *
 * Se compila a UN archivo CJS autónomo (scripts/build-daemon.mjs); su única dependencia en runtime
 * es node-pty, que se carga por la ruta absoluta recibida.
 */
import { createServer, type Socket } from 'node:net'
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { timingSafeEqual } from 'node:crypto'
import { TerminalCore, type PtyModule } from './core'
import { logFileFor, pipeNameFor, tokenFileFor } from './paths'
import { DAEMON_PROTOCOL_VERSION, type ClientMessage, type DaemonMessage } from '../shared/daemon-protocol'

declare const __SLOTH_DAEMON_VERSION__: string | undefined

const IDLE_SHUTDOWN_MS = 30_000
const HELLO_TIMEOUT_MS = 5_000
const PRE_AUTH_LINE_LIMIT = 64 * 1024
const LINE_LIMIT = 32 * 1024 * 1024
/** Un cliente que no lee (colgado) no puede hacernos crecer la memoria sin límite. */
const MAX_CLIENT_BACKLOG = 16 * 1024 * 1024
const LOG_MAX_BYTES = 2 * 1024 * 1024

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const userData = arg('user-data')
const ptyPath = arg('node-pty')
const VERSION =
  (typeof __SLOTH_DAEMON_VERSION__ !== 'undefined' && __SLOTH_DAEMON_VERSION__) || arg('app-version') || 'dev'

const logFile = userData ? logFileFor(userData) : undefined
let logWrites = 0
function log(msg: string): void {
  if (!logFile) return
  try {
    if (logWrites++ % 200 === 0 && existsSync(logFile) && statSync(logFile).size > LOG_MAX_BYTES) {
      renameSync(logFile, `${logFile}.1`)
    }
    appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${msg}\n`)
  } catch {
    /* sin log no es grave */
  }
}

function fail(msg: string): never {
  log(`FATAL ${msg}`)
  process.exit(1)
}

process.on('uncaughtException', (e) => log(`uncaughtException ${e?.stack ?? e}`))
process.on('unhandledRejection', (e) => log(`unhandledRejection ${String(e)}`))

if (!userData || !ptyPath) fail('faltan --user-data o --node-pty')

let token: string
try {
  token = readFileSync(tokenFileFor(userData), 'utf8').trim()
} catch {
  fail('no se pudo leer daemon-token')
}
if (!/^[0-9a-f]{64}$/i.test(token)) fail('daemon-token inválido')

let pty: PtyModule
try {
  pty = createRequire(__filename)(ptyPath) as PtyModule
} catch (e) {
  fail(`no se pudo cargar node-pty: ${(e as Error).message}`)
}

interface Client {
  sock: Socket
  authed: boolean
  version?: string
}
const clients = new Set<Client>()
const authedCount = (): number => {
  let n = 0
  for (const c of clients) if (c.authed) n++
  return n
}

function send(c: Client, msg: DaemonMessage): void {
  if (c.sock.destroyed) return
  c.sock.write(JSON.stringify(msg) + '\n')
  if (c.sock.writableLength > MAX_CLIENT_BACKLOG) {
    log('cliente no lee: se corta la conexión')
    c.sock.destroy()
  }
}

function broadcast(msg: DaemonMessage): void {
  let line: string | undefined
  for (const c of clients) {
    if (!c.authed || c.sock.destroyed) continue
    line ??= JSON.stringify(msg) + '\n'
    c.sock.write(line)
    if (c.sock.writableLength > MAX_CLIENT_BACKLOG) {
      log('cliente no lee: se corta la conexión')
      c.sock.destroy()
    }
  }
}

const core = new TerminalCore(
  pty,
  {
    data: (id, chunks) => broadcast({ t: 'data', id, chunks }),
    exit: (id, code) => broadcast({ t: 'exit', id, code }),
    hook: (event) => broadcast({ t: 'hook', event }),
    permission: (req) => broadcast({ t: 'permission', req }),
    permissionResolved: (id) => broadcast({ t: 'permission-resolved', id }),
    streaming: () => authedCount() > 0,
    canAskPermission: () => authedCount() > 0,
    sessionsChanged: () => checkIdle()
  },
  log
)

// Apagado por inactividad: un único timeout, armado solo cuando no hay sesiones ni clientes.
let idleTimer: NodeJS.Timeout | null = null
function checkIdle(): void {
  const idle = clients.size === 0 && core.runningCount() === 0
  if (idle && !idleTimer) {
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (clients.size === 0 && core.runningCount() === 0) shutdown('inactivo')
    }, IDLE_SHUTDOWN_MS)
  } else if (!idle && idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

let shuttingDown = false
function shutdown(reason: string): void {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutdown: ${reason}`)
  core.killAll()
  core.close()
  server.close()
  for (const c of clients) c.sock.end()
  // Un momento para que conpty cierre los procesos y se vacíen los sockets.
  setTimeout(() => process.exit(0), 300)
}

function reply(c: Client, rid: number, fn: () => unknown): void {
  try {
    const result = fn()
    send(c, { t: 'reply', rid, ok: true, result: (result ?? null) as never })
  } catch (e) {
    send(c, { t: 'reply', rid, ok: false, error: (e as Error)?.message ?? String(e) })
  }
}

function handle(c: Client, msg: ClientMessage): void {
  if (!c.authed) {
    if (msg.t !== 'hello' || typeof msg.token !== 'string' || msg.token.length !== token.length) {
      c.sock.destroy()
      return
    }
    if (!timingSafeEqual(Buffer.from(msg.token), Buffer.from(token))) {
      log('hello con token incorrecto')
      c.sock.destroy()
      return
    }
    c.authed = true
    c.version = String(msg.clientVersion ?? '')
    log(`cliente conectado (versión ${c.version}); clientes=${authedCount()}`)
    send(c, {
      t: 'hello-ok',
      version: VERSION,
      pid: process.pid,
      hookUrl: core.hookUrl,
      hookToken: core.hookToken,
      sessions: core.list(),
      lastHookEvents: core.lastHookEvents(),
      permissions: core.pendingPermissions(),
      protocol: DAEMON_PROTOCOL_VERSION
    })
    return
  }
  switch (msg.t) {
    case 'start':
      reply(c, msg.rid, () => core.start(String(msg.id), msg.spawn))
      break
    case 'write':
      core.write(String(msg.id), msg.data)
      break
    case 'resize':
      core.resize(String(msg.id), Number(msg.cols), Number(msg.rows))
      break
    case 'kill':
      reply(c, msg.rid, () => core.kill(String(msg.id)))
      break
    case 'list':
      reply(c, msg.rid, () => core.list())
      break
    case 'permission-answer':
      core.answerPermission(String(msg.reqId), msg.decision)
      break
    case 'shutdown':
      reply(c, msg.rid, () => null)
      shutdown('pedido por un cliente')
      break
  }
}

const server = createServer((sock) => {
  const c: Client = { sock, authed: false }
  clients.add(c)
  checkIdle()
  sock.setEncoding('utf8')
  const helloTimer = setTimeout(() => {
    if (!c.authed) sock.destroy()
  }, HELLO_TIMEOUT_MS)
  helloTimer.unref()
  let buf = ''
  sock.on('data', (d: string) => {
    buf += d
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg: ClientMessage
      try {
        msg = JSON.parse(line) as ClientMessage
      } catch {
        if (!c.authed) sock.destroy()
        continue
      }
      if (msg && typeof msg === 'object') handle(c, msg)
      if (sock.destroyed) return
    }
    if (buf.length > (c.authed ? LINE_LIMIT : PRE_AUTH_LINE_LIMIT)) sock.destroy()
  })
  sock.on('error', () => {})
  sock.on('close', () => {
    clearTimeout(helloTimer)
    const was = c.authed
    clients.delete(c)
    if (was) {
      log(`cliente desconectado; clientes=${authedCount()}`)
      if (authedCount() === 0) core.resolveAllPermissions()
    }
    checkIdle()
  })
})

server.on('error', (e: NodeJS.ErrnoException) => {
  // Otro daemon ya escucha en este pipe (arranque simultáneo): nos vamos sin tocar nada.
  log(`error del pipe: ${e.code ?? e.message}`)
  core.close()
  process.exit(e.code === 'EADDRINUSE' ? 0 : 1)
})

void (async () => {
  try {
    await core.listen()
  } catch (e) {
    fail(`servidor de hooks: ${(e as Error).message}`)
  }
  server.listen(pipeNameFor(userData), () => {
    log(`Sloth daemon ${VERSION} escuchando (node ${process.version})`)
    checkIdle()
  })
})()
