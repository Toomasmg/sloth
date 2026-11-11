import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/**
 * Corre git / gh sin shell (array de argumentos), oculto en Windows y con timeout.
 * Lo usan las funciones «git» y «worktrees».
 */
export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunOpts {
  cwd?: string
  timeoutMs?: number
  /** Texto para stdin (p. ej. `gh pr create --body-file -`). */
  input?: string
  /** Corta la salida a este tamaño (bytes aprox.). */
  maxBytes?: number
  /** Al abortarla se corta el proceso y se rechaza con motivo 'cancelada'. */
  signal?: AbortSignal
}

const ENV = {
  ...process.env,
  // Nada de prompts interactivos: si git o gh quieren preguntar algo, fallan con un mensaje.
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  NO_COLOR: '1',
  LC_ALL: 'C'
}

export function run(cmd: 'git' | 'gh', args: string[], opts: RunOpts = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const { signal } = opts
    if (signal?.aborted) {
      reject(new GitError('Consulta cancelada.', 'cancelada'))
      return
    }
    const maxBytes = opts.maxBytes ?? 16 * 1024 * 1024
    let child
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: ENV,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (e) {
      reject(e)
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outLen = 0
    let done = false
    const terminar = (): void => {
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', alAbortar)
    }
    const alAbortar = (): void => {
      if (done) return
      terminar()
      child.kill()
      reject(new GitError('Consulta cancelada.', 'cancelada'))
    }
    const timer = setTimeout(() => {
      if (done) return
      terminar()
      child.kill()
      reject(new GitError(`${cmd} tardó demasiado y se canceló (${Math.round((opts.timeoutMs ?? 30000) / 1000)} s).`, 'tiempo'))
    }, opts.timeoutMs ?? 30000)
    child.stdout.on('data', (b: Buffer) => {
      if (outLen >= maxBytes) return
      out.push(b)
      outLen += b.length
    })
    child.stderr.on('data', (b: Buffer) => {
      if (err.length < 200) err.push(b)
    })
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (done) return
      terminar()
      if (e.code === 'ENOENT') reject(new GitError(`No encontré «${cmd}» en el PATH.`, 'falta'))
      else reject(e)
    })
    child.on('close', (code) => {
      if (done) return
      terminar()
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
    signal?.addEventListener('abort', alAbortar, { once: true })
    child.stdin.on('error', () => {})
    if (opts.input !== undefined) child.stdin.end(opts.input, 'utf8')
    else child.stdin.end()
  })
}

export class GitError extends Error {
  /** Para quien tenga que distinguir «no está instalado», «se pasó de tiempo» o «se canceló» de un error de git/gh. */
  motivo?: 'falta' | 'tiempo' | 'cancelada'
  constructor(mensaje: string, motivo?: 'falta' | 'tiempo' | 'cancelada') {
    super(mensaje)
    this.motivo = motivo
  }
}

/** Mensaje legible a partir del stderr de git/gh. */
export function readable(r: RunResult, what: string): string {
  const raw = (r.stderr || r.stdout || '').trim()
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^(fatal|error|hint|remote):\s*/i, '').trim())
    .filter(Boolean)
  const text = lines.slice(0, 6).join(' — ')
  if (/not a git repository/i.test(raw)) return 'La carpeta no es un repositorio git.'
  if (/gh auth login|not logged into/i.test(raw)) return 'gh no tiene sesión iniciada: corré «gh auth login».'
  if (/rejected.*non-fast-forward|fetch first/i.test(raw))
    return 'El remoto tiene commits que no tenés (push rechazado). Traelos con pull/rebase antes de pushear; nunca se fuerza.'
  if (/Not possible to fast-forward|divergent branches|Diverging branches/i.test(raw))
    return 'La rama local y el remoto se separaron: no se puede traer sin combinar. Resolvelo a mano (merge o rebase); Sloth nunca fuerza nada.'
  if (/There is no tracking information|no upstream branch/i.test(raw)) return 'La rama no tiene remoto asociado. Subila primero con «Subir».'
  if (/Your local changes to the following files would be overwritten|would be overwritten by/i.test(raw))
    return 'Hay cambios sin confirmar que chocan con la otra rama. Confirmalos o guardalos en stash antes de cambiar.'
  if (/CONFLICT|Automatic merge failed/i.test(raw)) return 'Quedaron conflictos. Resolvelos a mano en el editor.'
  if (/Could not read from remote|Authentication failed|Permission denied \(publickey\)/i.test(raw))
    return `No se pudo conectar con el remoto (credenciales o red). ${text}`
  return `${what} falló${text ? `: ${text}` : ` (código ${r.code}).`}`
}

/** git con -C <cwd>; tira GitError legible si falla. */
export async function git(cwd: string, args: string[], opts: Omit<RunOpts, 'cwd'> = {}): Promise<string> {
  const r = await run('git', ['-C', cwd, '-c', 'core.quotepath=false', ...args], opts)
  if (r.code !== 0) throw new GitError(readable(r, `git ${args[0]}`))
  return r.stdout
}

/** git que devuelve el resultado crudo (para comandos donde el código distinto de 0 significa "no"). */
export function gitRaw(cwd: string, args: string[], opts: Omit<RunOpts, 'cwd'> = {}): Promise<RunResult> {
  return run('git', ['-C', cwd, '-c', 'core.quotepath=false', ...args], opts)
}

export function isDir(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024 || !isAbsolute(p)) return false
  try {
    return existsSync(p) && statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Nombre de rama válido según git (sin correr git: reglas de check-ref-format más comunes). */
export function validBranchName(b: unknown): b is string {
  if (typeof b !== 'string' || b.length === 0 || b.length > 200) return false
  if (b.startsWith('-') || b.startsWith('/') || b.endsWith('/') || b.endsWith('.') || b.endsWith('.lock')) return false
  if (b.includes('..') || b.includes('@{') || b.includes('//') || b === '@') return false
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(b)) return false
  return b.split('/').every((part) => part.length > 0 && !part.startsWith('.'))
}

export const PROTECTED = new Set(['main', 'master', 'staging'])

/** Normaliza una ruta para comparar (Windows: sin mayúsculas, barras \\ y sin barra final). */
export function normPath(p: string): string {
  let s = p.replace(/\//g, '\\').replace(/\\+$/, '')
  if (process.platform === 'win32') s = s.toLowerCase()
  return s
}
