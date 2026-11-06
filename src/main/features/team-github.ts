import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { parseGithubRemote, parsePrList, REPO_RE, type TeamPr } from './team-core'

/**
 * GitHub para la vista «Equipo», solo lectura: `git remote get-url origin` de cada repo y
 * `gh pr list` por repo. Sin shell (execFile con array), oculto y con timeout.
 */

export const PR_FIELDS = 'number,title,author,headRefName,isDraft,reviewDecision,statusCheckRollup,updatedAt,createdAt,url'
const GH_TIMEOUT_MS = 30_000
const GIT_TIMEOUT_MS = 8_000
const MAX_REPOS = 20
const PARALLEL = 4

const ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  NO_COLOR: '1'
}

export class GhMissingError extends Error {
  constructor() {
    super('No encontré «gh» (GitHub CLI). Instalalo desde https://cli.github.com y corré «gh auth login» en una terminal.')
  }
}
export class GhAuthError extends Error {
  constructor() {
    super('gh no tiene sesión iniciada: corré «gh auth login» en una terminal y tocá «Actualizar».')
  }
}

interface ExecOut {
  code: number
  stdout: string
  stderr: string
  missing?: boolean
  timedOut?: boolean
}

export function exec(cmd: string, args: string[], cwd: string | undefined, timeoutMs: number): Promise<ExecOut> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, env: ENV, windowsHide: true, shell: false, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null
        if (e?.code === 'ENOENT') return resolve({ code: -1, stdout: '', stderr: '', missing: true })
        resolve({
          code: e ? (typeof e.code === 'number' ? e.code : -1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut: Boolean(e?.killed)
        })
      }
    )
  })
}

/** `owner/repo` de GitHub del remoto origin de una carpeta, o undefined. */
export async function githubRepoOf(dir: string, run = exec): Promise<string | undefined> {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return undefined
  } catch {
    return undefined
  }
  const r = await run('git', ['remote', 'get-url', 'origin'], dir, GIT_TIMEOUT_MS)
  if (r.missing || r.code !== 0) return undefined
  return parseGithubRemote(r.stdout.trim())
}

export const isAuthError = (stderr: string): boolean =>
  /gh auth login|not logged in|authentication required|HTTP 401|Bad credentials|GH_TOKEN/i.test(stderr)

function cleanStderr(s: string): string {
  const line = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-2)
    .join(' ')
  return line.slice(0, 240) || 'error desconocido'
}

export async function listPrs(repo: string, run = exec): Promise<TeamPr[]> {
  if (!REPO_RE.test(repo)) throw new Error('Repo inválido.')
  const r = await run('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--json', PR_FIELDS, '--limit', '50'], undefined, GH_TIMEOUT_MS)
  if (r.missing) throw new GhMissingError()
  if (r.timedOut) throw new Error(`gh tardó más de ${GH_TIMEOUT_MS / 1000} s.`)
  if (r.code !== 0) {
    if (isAuthError(r.stderr)) throw new GhAuthError()
    throw new Error(cleanStderr(r.stderr))
  }
  return parsePrList(r.stdout, repo)
}

export interface GithubFetch {
  repos: string[]
  prs: TeamPr[]
  /** Errores por repo (sin acceso, no existe…). */
  errors: Record<string, string>
  /** Error general (gh no está o no tiene sesión): no hay datos. */
  fatal?: string
}

/** Repos distintos de GitHub entre las carpetas dadas, y sus PRs abiertos. */
export async function fetchGithub(dirs: string[], run = exec): Promise<GithubFetch> {
  const uniqueDirs = [...new Set(dirs.map((d) => d.trim()).filter(Boolean))].slice(0, 60)
  const repos: string[] = []
  const seen = new Set<string>()
  for (const r of await Promise.all(uniqueDirs.map((d) => githubRepoOf(d, run)))) {
    if (!r || seen.has(r.toLowerCase())) continue
    seen.add(r.toLowerCase())
    repos.push(r)
  }
  const out: GithubFetch = { repos: repos.slice(0, MAX_REPOS), prs: [], errors: {} }
  if (!out.repos.length) return out
  let i = 0
  const worker = async (): Promise<void> => {
    while (i < out.repos.length && !out.fatal) {
      const repo = out.repos[i++]
      try {
        out.prs.push(...(await listPrs(repo, run)))
      } catch (e) {
        if (e instanceof GhMissingError || e instanceof GhAuthError) out.fatal = e.message
        else out.errors[repo] = (e as Error).message
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, out.repos.length) }, worker))
  if (out.fatal) out.prs = []
  return out
}
