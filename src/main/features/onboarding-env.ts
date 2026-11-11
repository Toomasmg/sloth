/**
 * Chequeo del entorno para el asistente de bienvenida: Claude Code, Node ≥ 18, git, gh y su sesión.
 * Sin Electron (solo node:*): se prueba con binarios falsos. Siempre execFile con un array de
 * argumentos, timeout y windowsHide; nunca shell. Los .cmd de npm no se ejecutan: se corre su
 * cli.js con node, que es lo mismo sin pasar por cmd.exe.
 */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export type CheckState = 'ok' | 'warn' | 'missing'
export type DocKey = 'claude' | 'node' | 'git' | 'gh' | 'gh-auth'

export interface CheckItem {
  id: 'claude' | 'node' | 'git' | 'gh' | 'gh-auth'
  label: string
  state: CheckState
  /** Lo que encontramos (versión, ruta o cuenta). */
  detail?: string
  /** Qué hacer si falta o está viejo. */
  fix?: string
  /** Comando sugerido para copiar. */
  command?: string
  doc?: DocKey
  optional?: boolean
}

export interface EnvReport {
  items: CheckItem[]
  checkedAt: number
}

/** Docs oficiales: el renderer manda la clave, nunca una URL. */
export const DOCS: Record<DocKey, string> = {
  claude: 'https://docs.claude.com/en/docs/claude-code/setup',
  node: 'https://nodejs.org/en/download',
  git: 'https://git-scm.com/downloads/win',
  gh: 'https://cli.github.com/',
  'gh-auth': 'https://cli.github.com/manual/gh_auth_login'
}

export interface RunResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  /** ENOENT, timeout, etc. */
  error?: string
}

export type Runner = (file: string, args: string[], timeoutMs: number) => Promise<RunResult>

/** execFile sin shell, con timeout, ventana oculta y salida acotada. */
export const runFile: Runner = (file, args, timeoutMs) =>
  new Promise((res) => {
    try {
      execFile(
        file,
        args,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } },
        (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null
          if (!e) return res({ ok: true, code: 0, stdout: String(stdout), stderr: String(stderr) })
          const error = e.killed ? 'timeout' : typeof e.code === 'string' ? e.code : undefined
          res({ ok: false, code: typeof e.code === 'number' ? e.code : null, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error })
        }
      )
    } catch (e) {
      res({ ok: false, code: null, stdout: '', stderr: '', error: (e as NodeJS.ErrnoException).code ?? 'spawn' })
    }
  })

export interface EnvOptions {
  /** PATH a revisar (por defecto el del proceso). */
  pathEnv?: string
  home?: string
  appData?: string
  run?: Runner
  timeoutMs?: number
  isFile?: (p: string) => boolean
}

const defaultIsFile = (p: string): boolean => {
  try {
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

/** Busca un ejecutable en el PATH a mano (así no dependemos de cómo resuelve cada shell). */
export function findInPath(names: string[], pathEnv: string, isFile = defaultIsFile): string | undefined {
  const dirs = pathEnv
    .split(delimiter)
    .map((d) => d.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
  for (const d of dirs) for (const n of names) {
    const p = join(d, n)
    if (isFile(p)) return p
  }
  return undefined
}

const firstLine = (s: string): string => s.trim().split(/\r?\n/)[0]?.trim().slice(0, 120) ?? ''
const exe = (n: string): string[] => (process.platform === 'win32' ? [`${n}.exe`] : [n])

/** «v20.11.1» → 20. */
export function nodeMajor(v: string): number | undefined {
  const m = /v?(\d+)\.(\d+)/.exec(v)
  return m ? Number(m[1]) : undefined
}

interface ClaudeCandidate {
  file: string
  args: string[]
  where: string
}

/** Dónde puede estar Claude Code: en el PATH, el instalador nativo (~/.local/bin) o el shim de npm. */
export function claudeCandidates(o: Required<Pick<EnvOptions, 'pathEnv' | 'home' | 'appData'>>, node: string | undefined, isFile = defaultIsFile): ClaudeCandidate[] {
  const out: ClaudeCandidate[] = []
  const inPath = findInPath(exe('claude'), o.pathEnv, isFile)
  if (inPath) out.push({ file: inPath, args: ['--version'], where: inPath })
  const native = join(o.home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
  if (isFile(native) && native !== inPath) out.push({ file: native, args: ['--version'], where: native })
  // Shim de npm (claude.cmd): se corre el cli.js con node, sin cmd.exe.
  const npmDirs = [join(o.appData, 'npm'), ...o.pathEnv.split(delimiter).filter((d) => /[\\/]npm[\\/]?$/i.test(d))]
  for (const d of [...new Set(npmDirs)]) {
    const pkg = join(d, 'node_modules', '@anthropic-ai', 'claude-code')
    // Versiones nuevas del paquete traen el binario nativo (bin/claude.exe); las viejas, cli.js.
    const bin = join(pkg, 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
    if (isFile(bin)) {
      out.push({ file: bin, args: ['--version'], where: join(d, 'claude.cmd') })
      break
    }
    const cli = join(pkg, 'cli.js')
    if (node && isFile(cli)) {
      out.push({ file: node, args: [cli, '--version'], where: join(d, 'claude.cmd') })
      break
    }
  }
  return out
}

export async function checkEnvironment(opts: EnvOptions = {}): Promise<EnvReport> {
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? process.env.Path ?? ''
  const home = opts.home ?? process.env.USERPROFILE ?? process.env.HOME ?? ''
  const appData = opts.appData ?? process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
  const run = opts.run ?? runFile
  const t = opts.timeoutMs ?? 6000
  const isFile = opts.isFile ?? defaultIsFile

  const nodePath = findInPath(exe('node'), pathEnv, isFile)
  const gitPath = findInPath(exe('git'), pathEnv, isFile)
  const ghPath = findInPath(exe('gh'), pathEnv, isFile)

  const nodeCheck = async (): Promise<CheckItem> => {
    const base = { id: 'node' as const, label: 'Node.js 18 o más', doc: 'node' as const }
    const fix = { fix: 'Hace falta para que las terminales sigan vivas al cerrar Sloth. Instalá la versión LTS y reiniciá Sloth.', command: 'winget install OpenJS.NodeJS.LTS' }
    if (!nodePath) return { ...base, state: 'missing', ...fix }
    const r = await run(nodePath, ['--version'], t)
    const v = firstLine(r.stdout)
    const major = nodeMajor(v)
    if (!r.ok || major === undefined) return { ...base, state: 'warn', detail: r.error === 'timeout' ? 'No respondió a tiempo' : 'No se pudo leer la versión', ...fix }
    if (major < 18) return { ...base, state: 'warn', detail: `${v} (vieja)`, ...fix }
    return { ...base, state: 'ok', detail: v }
  }

  const claudeCheck = async (): Promise<CheckItem> => {
    const base = { id: 'claude' as const, label: 'Claude Code', doc: 'claude' as const }
    const fix = { fix: 'Instalalo con el instalador oficial (en PowerShell) y reiniciá Sloth.', command: 'irm https://claude.ai/install.ps1 | iex' }
    const cands = claudeCandidates({ pathEnv, home, appData }, nodePath, isFile)
    if (!cands.length) return { ...base, state: 'missing', ...fix }
    for (const c of cands) {
      const r = await run(c.file, c.args, t)
      const v = firstLine(r.stdout)
      if (r.ok && /\d+\.\d+/.test(v)) return { ...base, state: 'ok', detail: v.replace(/\s*\(Claude Code\)\s*$/i, '') + ' · ' + c.where }
    }
    return { ...base, state: 'warn', detail: `Está en ${cands[0].where} pero no respondió`, ...fix }
  }

  const gitCheck = async (): Promise<CheckItem> => {
    const base = { id: 'git' as const, label: 'Git', doc: 'git' as const }
    const fix = { fix: 'Hace falta para los worktrees, el diff y las ramas.', command: 'winget install Git.Git' }
    if (!gitPath) return { ...base, state: 'missing', ...fix }
    const r = await run(gitPath, ['--version'], t)
    const m = /(\d+\.\d+\.\d+)/.exec(r.stdout)
    return r.ok && m ? { ...base, state: 'ok', detail: `git ${m[1]}` } : { ...base, state: 'warn', detail: 'No respondió', ...fix }
  }

  const ghChecks = async (): Promise<CheckItem[]> => {
    const base = { id: 'gh' as const, label: 'GitHub CLI (gh)', doc: 'gh' as const, optional: true }
    const auth = { id: 'gh-auth' as const, label: 'Sesión de gh', doc: 'gh-auth' as const, optional: true }
    if (!ghPath)
      return [
        { ...base, state: 'warn', fix: 'Opcional: sirve para crear PRs desde Sloth.', command: 'winget install GitHub.cli' },
        { ...auth, state: 'warn', detail: 'Sin gh', fix: 'Después de instalar gh, iniciá sesión.', command: 'gh auth login' }
      ]
    const v = await run(ghPath, ['--version'], t)
    const m = /(\d+\.\d+\.\d+)/.exec(v.stdout)
    const ghItem: CheckItem = v.ok && m ? { ...base, state: 'ok', detail: `gh ${m[1]}` } : { ...base, state: 'warn', detail: 'No respondió', command: 'winget install GitHub.cli' }
    // gh auth status: 0 = con sesión. Solo sacamos el nombre de la cuenta (nunca el token).
    const a = await run(ghPath, ['auth', 'status', '--hostname', 'github.com'], t)
    const out = `${a.stdout}\n${a.stderr}`
    const acct = /account\s+([A-Za-z0-9-]{1,39})/.exec(out)?.[1] ?? /as\s+([A-Za-z0-9-]{1,39})/.exec(out)?.[1]
    const authItem: CheckItem = a.ok
      ? { ...auth, state: 'ok', detail: acct ? `Cuenta ${acct}` : 'Sesión iniciada' }
      : { ...auth, state: 'warn', detail: a.error === 'timeout' ? 'No respondió a tiempo' : 'Sin sesión', fix: 'Iniciá sesión en GitHub desde una terminal.', command: 'gh auth login' }
    return [ghItem, authItem]
  }

  const [claude, node, git, gh] = await Promise.all([claudeCheck(), nodeCheck(), gitCheck(), ghChecks()])
  return { items: [claude, node, git, ...gh], checkedAt: Date.now() }
}

/** Repos sugeridos: los que ya usás y las carpetas con .git dentro de las rutas comunes (hasta 8). */
export function repoCandidates(home: string, extra: string[] = [], isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory(), hijos = (p: string): string[] => readdirSync(p)): string[] {
  const bases = ['C:\dev\work', join(home, 'dev', 'work'), 'C:\dev', join(home, 'dev'), 'D:\dev\work', join(home, 'Documents', 'GitHub'), join(home, 'source', 'repos'), join(home, 'repos')]
  const out: string[] = []
  const seen = new Set<string>()
  const add = (p: string): void => {
    const k = p.toLowerCase()
    if (seen.has(k)) return
    seen.add(k)
    try {
      if (isDir(p) && existsSync(join(p, '.git'))) out.push(p)
    } catch {
      /* sin permisos */
    }
  }
  for (const e of extra) add(e)
  for (const b of bases) {
    let nombres: string[]
    try {
      nombres = hijos(b)
    } catch {
      continue
    }
    for (const h of nombres) add(join(b, h))
  }
  return out.slice(0, 8)
}
