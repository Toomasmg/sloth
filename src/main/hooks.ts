import { app } from 'electron'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AgentState } from '../shared/types'

/** Eventos de Claude Code que usamos para saber qué está haciendo cada agente. */
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop'] as const
type HookEvent = (typeof HOOK_EVENTS)[number]

const MARKER = 'antirea-hook'

/**
 * Script que corre Claude en cada hook. Solo reporta si lo lanzó AntiRea (variables de entorno
 * presentes), así usar esa cuenta fuera de la app no hace nada. Nunca bloquea ni falla.
 */
const HOOK_SCRIPT = `// ${MARKER}: generado por AntiRea, no editar.
const http = require('node:http');
const url = process.env.ANTIREA_HOOK_URL, token = process.env.ANTIREA_TOKEN, ws = process.env.ANTIREA_WS;
if (!url || !token || !ws) process.exit(0);
const done = () => process.exit(0);
setTimeout(done, 2500).unref();
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { if (raw.length < 65536) raw += c; });
process.stdin.on('end', () => {
  let j = {};
  try { j = JSON.parse(raw); } catch {}
  const body = JSON.stringify({ ws, event: process.argv[2], tool: j.tool_name, message: j.message, notificationType: j.notification_type });
  const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-antirea-token': token }, timeout: 1500 }, (res) => { res.resume(); res.on('end', done); });
  req.on('error', done); req.on('timeout', () => { req.destroy(); done(); });
  req.end(body);
});
`

export interface HookEventPayload {
  ws: string
  event: HookEvent
  tool?: string
  message?: string
  notificationType?: string
}

export function stateForEvent(p: HookEventPayload): { state: AgentState; detail?: string } {
  switch (p.event) {
    case 'SessionStart':
      return { state: 'idle' }
    case 'UserPromptSubmit':
      return { state: 'working' }
    case 'PreToolUse':
      return { state: 'working', detail: p.tool }
    case 'Notification':
      return { state: 'waiting', detail: p.message }
    case 'Stop':
      return { state: 'done' }
  }
}

export class HookServer {
  private server?: Server
  readonly token = randomBytes(24).toString('hex')
  url = ''
  readonly scriptPath = join(app.getPath('userData'), 'antirea-hook.cjs')

  constructor(private readonly onEvent: (p: HookEventPayload) => void) {}

  async start(): Promise<void> {
    writeFileSync(this.scriptPath, HOOK_SCRIPT, 'utf8')
    this.server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/hook' || req.headers['x-antirea-token'] !== this.token) {
        res.writeHead(403).end()
        return
      }
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (c: string) => {
        body += c
        if (body.length > 65536) req.destroy()
      })
      req.on('end', () => {
        res.writeHead(204).end()
        try {
          const p = JSON.parse(body) as HookEventPayload
          if (typeof p.ws === 'string' && (HOOK_EVENTS as readonly string[]).includes(p.event)) this.onEvent(p)
        } catch {
          /* payload inválido: se ignora */
        }
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    const addr = this.server.address()
    if (!addr || typeof addr === 'string') throw new Error('No se pudo abrir el servidor de hooks')
    this.url = `http://127.0.0.1:${addr.port}/hook`
  }

  stop(): void {
    this.server?.close()
  }

  /**
   * Agrega (o actualiza) nuestros hooks en el settings.json de la cuenta, sin tocar los hooks
   * que el usuario ya tenga.
   */
  installInto(configDir: string, base?: Record<string, unknown>): void {
    mkdirSync(configDir, { recursive: true })
    const file = join(configDir, 'settings.json')
    let settings: Record<string, unknown> = {}
    if (base) {
      // Copia profunda: no queremos mutar el settings.json del usuario en memoria.
      settings = structuredClone(base)
    } else if (existsSync(file)) {
      try {
        settings = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      } catch {
        // No pisamos un settings.json que no entendemos.
        console.warn(`[hooks] settings.json inválido en ${configDir}; no se instalan hooks`)
        return
      }
    }
    type Entry = { matcher?: string; hooks: { type: string; command: string }[] }
    const hooks = (settings.hooks ?? {}) as Record<string, Entry[]>
    const script = this.scriptPath.replace(/\\/g, '/')
    for (const event of HOOK_EVENTS) {
      const others = (hooks[event] ?? []).filter((e) => !e.hooks?.some((h) => h.command?.includes(MARKER)))
      const ours: Entry = { hooks: [{ type: 'command', command: `node "${script}" ${event}` }] }
      if (event === 'PreToolUse') ours.matcher = ''
      hooks[event] = [...others, ours]
    }
    settings.hooks = hooks
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8')
    renameSync(tmp, file)
  }
}
