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
  /** Variables que se suman al entorno de siempre (p. ej. las de gitSafeEnv). */
  env?: Record<string, string>
}

type ConfigPar = readonly [string, string]

/** Config por entorno (GIT_CONFIG_COUNT, git ≥ 2.31): pisa al .git/config igual que un -c. */
export function gitConfigEnv(pares: readonly ConfigPar[]): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pares.length) }
  pares.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k
    env[`GIT_CONFIG_VALUE_${i}`] = v
  })
  return env
}

/**
 * Un repo ajeno (zip, USB, carpeta compartida) puede traer core.fsmonitor = <comando> en su .git/config,
 * y git lo ejecuta en cualquier status. Sloth corre git solo, antes de que nadie confíe en la carpeta.
 * Con log.showSignature y un commit firmado, `git log` correría el gpg.program del repo.
 */
const SAFE_CONFIG: readonly ConfigPar[] = [
  ['core.fsmonitor', 'false'],
  ['log.showSignature', 'false']
]
export const GIT_SAFE_ENV = gitConfigEnv(SAFE_CONFIG)

// Solo estos firman o verifican firmas con la config de la persona. El resto nunca llama a gpg: un
// programa vacío no rompe nada y uno puesto por el repo no se ejecuta.
const FIRMAN: ReadonlySet<string> = new Set(['commit', 'pull', 'merge', 'rebase', 'cherry-pick', 'revert', 'tag', 'am'])
const SIN_GPG: readonly ConfigPar[] = ['gpg.program', 'gpg.ssh.program', 'gpg.x509.program'].map((k) => [k, ''] as const)

/** GIT_SAFE_ENV más, salvo en los que firman, los gpg.*.program vacíos; `extra` suma otros (los filtros). */
export function gitSafeEnv(args: readonly string[], extra: readonly ConfigPar[] = []): Record<string, string> {
  return gitConfigEnv([...SAFE_CONFIG, ...(FIRMAN.has(args[0] ?? '') ? [] : SIN_GPG), ...extra])
}

// status y diff contra el árbol de trabajo pasan cada archivo cambiado por el filtro clean del repo.
const CORREN_FILTROS: ReadonlySet<string> = new Set(['status', 'diff'])

// Lo que instala `git lfs install`: con estos comandos exactos el filtro «lfs» se respeta.
const LFS: Readonly<Record<string, string>> = {
  'filter.lfs.clean': 'git-lfs clean -- %f',
  'filter.lfs.smudge': 'git-lfs smudge -- %f',
  'filter.lfs.process': 'git-lfs filter-process',
  'filter.lfs.required': 'true'
}

/**
 * Config que apaga los filtros del repo (salida de `git config -z --get-regexp ^filter\.`): un
 * `.git/config` puede traer `filter.x.clean = <comando>` y un `.gitattributes` que lo use, y git lo
 * correría en un `status`. Se deja el de git-lfs si es el estándar.
 */
export function filtrosApagados(configZ: string): ConfigPar[] {
  const ultimo = new Map<string, string>()
  for (const entrada of configZ.split('\0')) {
    if (!entrada) continue
    const nl = entrada.indexOf('\n')
    ultimo.set(nl < 0 ? entrada : entrada.slice(0, nl), nl < 0 ? '' : entrada.slice(nl + 1))
  }
  const drivers = new Map<string, boolean>()
  for (const [clave, valor] of ultimo) {
    const m = /^filter\.(.+)\.([^.]+)$/i.exec(clave)
    if (!m) continue
    const estandar = LFS[clave.toLowerCase()] === valor.trim()
    drivers.set(m[1], (drivers.get(m[1]) ?? true) && estandar)
  }
  const out: ConfigPar[] = []
  for (const [nombre, estandar] of drivers) {
    if (estandar) continue
    for (const k of ['clean', 'smudge', 'process']) out.push([`filter.${nombre}.${k}`, ''])
    out.push([`filter.${nombre}.required`, 'false'])
  }
  return out
}

const FILTROS_TTL_MS = 10_000
const filtrosCache = new Map<string, { at: number; pares: ConfigPar[] }>()

/** Los filtros a apagar cuando `args` es un status o un diff automático (ver filtrosApagados). */
export async function filtrosDe(cwd: string, args: readonly string[]): Promise<ConfigPar[]> {
  if (!CORREN_FILTROS.has(args[0] ?? '')) return []
  const hit = filtrosCache.get(cwd)
  if (hit && Date.now() - hit.at < FILTROS_TTL_MS) return hit.pares
  const r = await run('git', ['-C', cwd, 'config', '-z', '--get-regexp', '^filter\\.'], { timeoutMs: 10000, env: gitSafeEnv(['config']) })
  // 1 = ningún filtro; otro error (carpeta que no existe, config rota) hace fallar igual al comando que sigue.
  const pares = r.code === 0 ? filtrosApagados(r.stdout) : []
  filtrosCache.set(cwd, { at: Date.now(), pares })
  return pares
}

const ENV = {
  ...process.env,
  ...GIT_SAFE_ENV,
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
        env: opts.env ? { ...ENV, ...opts.env } : ENV,
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
  const r = await gitRaw(cwd, args, opts)
  if (r.code !== 0) throw new GitError(readable(r, `git ${args[0]}`))
  return r.stdout
}

/** git que devuelve el resultado crudo (para comandos donde el código distinto de 0 significa "no"). */
export async function gitRaw(cwd: string, args: string[], opts: Omit<RunOpts, 'cwd'> = {}): Promise<RunResult> {
  const env = gitSafeEnv(args, await filtrosDe(cwd, args))
  return run('git', ['-C', cwd, '-c', 'core.quotepath=false', ...args], { ...opts, env: { ...env, ...opts.env } })
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
