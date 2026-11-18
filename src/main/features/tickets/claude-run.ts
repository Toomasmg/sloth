import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { cortarArbol, spawnOptsArbol } from '../../kill-tree'
import { depsReales } from '../../kill-tree-real'

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
  /** Mira cada línea de stdout apenas llega: si devuelve algo, se corta el proceso y ese es el resultado. */
  temprano?: (linea: string) => T | undefined
  /** Mira cada línea de stdout: si devuelve un Error, se corta el árbol de procesos y se rechaza con él. Un motor lo usa para emular un tope que su CLI no tiene. */
  cortarSi?: (linea: string) => Error | undefined
  /** Cómo se llama el programa en «No pude abrir …». */
  agente?: string
  /** `args` es la línea de comandos ya armada (un .cmd por cmd.exe): Node no la entrecomilla de nuevo. */
  verbatim?: boolean
}

/** Rechaza con un mensaje legible. */
export function runClaude<T>(o: RunOptions<T>): Promise<T> {
  const timeoutMs = o.timeoutMs ?? RUN_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    let pendiente = ''
    let done = false
    // Con cortarSi el hijo es líder de su grupo fuera de Windows: sin eso cortarArbol no alcanza a sus nietos.
    const arbol = o.cortarSi !== undefined
    const child = spawn(o.exe, o.args, { cwd: o.cwd, env: o.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...(o.verbatim ? { windowsVerbatimArguments: true } : {}), ...(arbol ? spawnOptsArbol(process.platform) : {}) })
    const cortar = (): void => {
      if (arbol) void cortarArbol(child, depsReales(), 3000)
      else killTree(child.pid)
    }
    const finish = (e?: Error, r?: T): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      if (e) reject(e)
      else resolve(r as T)
    }
    const timer = setTimeout(() => {
      cortar()
      finish(new Error(`${o.quien} no respondió en ${Math.round(timeoutMs / 1000)} s. Probá de nuevo.`))
    }, timeoutMs)
    const onAbort = (): void => {
      cortar()
      finish(new Error('Consulta cancelada.'))
    }
    o.signal?.addEventListener('abort', onAbort)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const mirar = (d: string): void => {
      if ((!o.temprano && !o.cortarSi) || done) return
      const lineas = (pendiente + d).split('\n')
      pendiente = lineas.pop() ?? ''
      if (pendiente.length > MAX_STDOUT) pendiente = ''
      for (const l of lineas) {
        let corte: Error | undefined
        try {
          corte = o.cortarSi?.(l)
        } catch (e) {
          // Si el que decide el corte falla no se sigue sin tope: se corta.
          corte = e instanceof Error ? e : new Error(String(e))
        }
        if (corte) {
          cortar()
          return finish(corte)
        }
        let r: T | undefined
        try {
          r = o.temprano?.(l)
        } catch {
          continue
        }
        if (r !== undefined) {
          cortar()
          return finish(undefined, r)
        }
      }
    }
    child.stdout.on('data', (d: string) => {
      if (out.length < MAX_STDOUT) out += d
      mirar(d)
    })
    child.stderr.on('data', (d: string) => {
      if (err.length < 8000) err += d
    })
    child.on('error', (e) => finish(new Error(`No pude abrir ${o.agente ?? 'Claude'}: ${e.message}`)))
    child.on('close', (code) => {
      if (done) return
      try {
        finish(undefined, o.parse(out))
      } catch (e) {
        // Un error propio (conector o herramienta que falta) se devuelve tal cual: quien llama lo distingue por clase.
        if (e instanceof Error && e.constructor !== Error) return finish(e)
        const extra = code ? ` (salió con código ${code}${err.trim() ? `: ${err.trim().slice(0, 300)}` : ''})` : ''
        finish(new Error(`${(e as Error).message}${extra}`))
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(o.prompt, 'utf8')
  })
}
