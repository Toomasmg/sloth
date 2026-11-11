import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

/**
 * Corre Claude Code headless (`claude -p`) con el prompt por stdin. No importa electron.
 * Lo carga `node --test` con type stripping: sin enums, namespaces ni parameter properties, y los
 * tipos se importan con `type`.
 */

export const RUN_TIMEOUT_MS = 120_000
/** Tope de lo que se lee de stdout: una respuesta rara no llena la memoria. */
const MAX_STDOUT = 4 * 1024 * 1024

let exeCache: string | undefined
/**
 * Busca el ejecutable real de Claude (sin shell): `claude.exe` en el PATH o en ~/.local/bin,
 * o el que apunta el shim `claude.cmd` de npm.
 */
export function resolveClaudeExe(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (exeCache && existsSync(exeCache)) return exeCache
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  const candidates: string[] = []
  for (const d of dirs) candidates.push(join(d, 'claude.exe'))
  candidates.push(join(homedir(), '.local', 'bin', 'claude.exe'))
  for (const c of candidates) {
    if (existsSync(c)) return (exeCache = c)
  }
  for (const d of dirs) {
    const shim = join(d, 'claude.cmd')
    if (!existsSync(shim)) continue
    try {
      const txt = readFileSync(shim, 'utf8')
      const m = /"%dp0%\\([^"]+?\.exe)"/i.exec(txt)
      if (m) {
        const exe = join(dirname(shim), m[1])
        if (existsSync(exe)) return (exeCache = exe)
      }
      const js = /"%dp0%\\([^"]+?\.(?:c?js))"/i.exec(txt)
      if (js) {
        const exe = join(dirname(shim), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
        if (existsSync(exe)) return (exeCache = exe)
      }
    } catch {
      /* sigue */
    }
  }
  return undefined
}

function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* ya terminó */
    }
  }
}

export interface RunOptions<T> {
  exe: string
  args: string[]
  prompt: string
  cwd: string
  env: Record<string, string>
  /** A quién se le pregunta, para el mensaje de timeout («{conector} no respondió en…»). */
  quien: string
  timeoutMs?: number
  signal?: AbortSignal
  parse: (stdout: string) => T
}

/** Rechaza con un mensaje legible. */
export function runClaude<T>(o: RunOptions<T>): Promise<T> {
  const timeoutMs = o.timeoutMs ?? RUN_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    let done = false
    const child = spawn(o.exe, o.args, { cwd: o.cwd, env: o.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const finish = (e?: Error, r?: T): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      if (e) reject(e)
      else resolve(r as T)
    }
    const timer = setTimeout(() => {
      killTree(child.pid)
      finish(new Error(`${o.quien} no respondió en ${Math.round(timeoutMs / 1000)} s. Probá de nuevo.`))
    }, timeoutMs)
    const onAbort = (): void => {
      killTree(child.pid)
      finish(new Error('Consulta cancelada.'))
    }
    o.signal?.addEventListener('abort', onAbort)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      if (out.length < MAX_STDOUT) out += d
    })
    child.stderr.on('data', (d: string) => {
      if (err.length < 8000) err += d
    })
    child.on('error', (e) => finish(new Error(`No pude abrir Claude: ${e.message}`)))
    child.on('close', (code) => {
      if (done) return
      try {
        finish(undefined, o.parse(out))
      } catch (e) {
        const extra = code ? ` (salió con código ${code}${err.trim() ? `: ${err.trim().slice(0, 300)}` : ''})` : ''
        finish(new Error(`${(e as Error).message}${extra}`))
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(o.prompt, 'utf8')
  })
}
