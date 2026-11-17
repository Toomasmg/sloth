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
import { TerminalCore, type PtyModule } from './core'
import { daemonKeyFileFor, logFileFor, pipeNameFor } from './paths'
import { KEY_RE, mismaPrueba, NONCE_RE, nuevoNonce, pruebaCliente, pruebaDaemon } from './auth'
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

let key: string
try {
  key = readFileSync(daemonKeyFileFor(userData), 'utf8').trim()
} catch {
  fail('no se pudo leer daemon-key')
}
if (!KEY_RE.test(key)) fail('daemon-key inválida')

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
  nonce?: string
  nonceDaemon?: string
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
      if (clients.size === 0 && core.runningCount() === 0) void shutdown('inactivo')
    }, IDLE_SHUTDOWN_MS)
  } else if (!idle && idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

let shuttingDown = false
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutdown: ${reason}`)
  // Primero las terminales, de a una: así conpty también alcanza a cerrar los procesos hijos.
  await core.closeAll()
  core.close()
  server.close()
  for (const c of clients) c.sock.end()
  // Un momento para que se vacíen los sockets.
  setTimeout(() => process.exit(0), 100)
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
    if (msg.t === 'challenge' && !c.nonce && typeof msg.nonce === 'string' && NONCE_RE.test(msg.nonce)) {
      c.nonce = msg.nonce
      c.nonceDaemon = nuevoNonce()
      send(c, { t: 'challenge-ok', nonce: c.nonceDaemon, proof: pruebaDaemon(key, c.nonce, c.nonceDaemon) })
      return
    }
    if (msg.t !== 'hello' || !c.nonce || !c.nonceDaemon || !mismaPrueba(msg.proof, pruebaCliente(key, c.nonce, c.nonceDaemon))) {
      log('saludo rechazado')
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
      void shutdown('pedido por un cliente')
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
