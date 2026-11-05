import * as pty from 'node-pty'
import { execFileSync } from 'node:child_process'
import type { PtyChunk, PtyStartResult } from '../shared/types'

const MAX_BUFFER_CHARS = 400_000

export interface PtySpec {
  cwd: string
  env: Record<string, string>
  args: string[]
}

interface Session {
  proc: pty.IPty
  chunks: PtyChunk[]
  size: number
  seq: number
  running: boolean
}

let shellCache: string | undefined
/** PowerShell 7 si está instalado; si no, Windows PowerShell. */
export function resolveShell(): string {
  if (shellCache) return shellCache
  try {
    execFileSync('where', ['pwsh'], { stdio: 'ignore', windowsHide: true })
    shellCache = 'pwsh.exe'
  } catch {
    shellCache = 'powershell.exe'
  }
  return shellCache
}

/**
 * Entorno limpio para cada terminal: se quitan las variables que harían que Claude use otra
 * cuenta (API keys) o crea que corre anidado dentro de otra sesión de Claude Code.
 */
export function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    const key = k.toUpperCase()
    if (
      key === 'CLAUDECODE' ||
      key.startsWith('CLAUDE_CODE_') ||
      key === 'CLAUDE_CONFIG_DIR' ||
      key === 'ANTHROPIC_API_KEY' ||
      key === 'ANTHROPIC_AUTH_TOKEN' ||
      key.startsWith('ELECTRON_') ||
      key.startsWith('ANTIREA_')
    )
      continue
    env[k] = v
  }
  env.TERM_PROGRAM = 'AntiRea'
  return env
}

export class PtyManager {
  private sessions = new Map<string, Session>()

  constructor(
    private readonly onData: (id: string, chunk: PtyChunk) => void,
    private readonly onExit: (id: string, code: number) => void
  ) {}

  isRunning(id: string): boolean {
    return this.sessions.get(id)?.running ?? false
  }

  /** Arranca la terminal si no está corriendo y devuelve lo que ya imprimió (para redibujar). */
  start(id: string, spec: () => PtySpec, cols: number, rows: number): PtyStartResult {
    let s = this.sessions.get(id)
    if (!s || !s.running) {
      const { cwd, env, args } = spec()
      const proc = pty.spawn(resolveShell(), args, {
        name: 'xterm-256color',
        cols: Math.max(cols, 20),
        rows: Math.max(rows, 5),
        cwd,
        env,
        useConpty: true
      })
      const session: Session = { proc, chunks: [], size: 0, seq: s?.seq ?? 0, running: true }
      s = session
      this.sessions.set(id, session)
      proc.onData((data) => {
        const chunk = { seq: ++session.seq, data }
        session.chunks.push(chunk)
        session.size += data.length
        while (session.size > MAX_BUFFER_CHARS && session.chunks.length > 1) {
          session.size -= session.chunks.shift()!.data.length
        }
        this.onData(id, chunk)
      })
      proc.onExit(({ exitCode }) => {
        session.running = false
        this.onExit(id, exitCode)
      })
    }
    return { chunks: [...s.chunks], upTo: s.seq, running: s.running }
  }

  write(id: string, data: string): void {
    const s = this.sessions.get(id)
    if (s?.running) s.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id)
    if (s?.running && cols > 0 && rows > 0) {
      try {
        s.proc.resize(cols, rows)
      } catch {
        /* la terminal pudo cerrarse justo ahora */
      }
    }
  }

  kill(id: string): void {
    const s = this.sessions.get(id)
    if (s?.running) s.proc.kill()
    this.sessions.delete(id)
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }
}
