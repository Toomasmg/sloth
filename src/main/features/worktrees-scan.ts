import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { parsePorcelain } from './git-ops'
import { git, gitRaw, normPath, run, validBranchName } from './git-run'

/** Lógica de «Ramas aparte» (git worktrees), sin Electron: se puede probar con Node. Todo con git sin shell. */

export interface WorktreeEntry {
  path: string
  head?: string
  /** Nombre corto (sin refs/heads/). */
  branch?: string
  bare?: boolean
  detached?: boolean
  locked?: boolean
  prunable?: boolean
}

export function parseWorktreeList(out: string): WorktreeEntry[] {
  const list: WorktreeEntry[] = []
  let cur: WorktreeEntry | null = null
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (!line) {
      if (cur) list.push(cur)
      cur = null
      continue
    }
    const sp = line.indexOf(' ')
    const key = sp < 0 ? line : line.slice(0, sp)
    const val = sp < 0 ? '' : line.slice(sp + 1)
    if (key === 'worktree') {
      if (cur) list.push(cur)
      cur = { path: resolve(val) }
    } else if (!cur) continue
    else if (key === 'HEAD') cur.head = val
    else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '')
    else if (key === 'bare') cur.bare = true
    else if (key === 'detached') cur.detached = true
    else if (key === 'locked') cur.locked = true
    else if (key === 'prunable') cur.prunable = true
  }
  if (cur) list.push(cur)
  return list
}

/** Un espacio de Sloth, con lo que hace falta para asociarlo a una carpeta. */
export interface WsRef {
  id: string
  name: string
  repoPath: string
  cwd: string
  /** Nombre de la cuenta (solo para mostrarla). */
  accountLabel?: string
}

export interface SpaceRef {
  id: string
  name: string
  accountLabel?: string
}

/** Una fila de «Ramas aparte»: la copia principal o una rama aparte. */
export interface BranchRow {
  /** Id del repo (owner/nombre del remoto, o nombre de la carpeta). */
  repo: string
  path: string
  branch: string | null
  isMain: boolean
  exists: boolean
  locked: boolean
  /** Archivos con cambios sin confirmar (incluye sin trackear). -1 = no se pudo leer. */
  changes: number
  /** Commits que no están en ningún remoto. -1 = no se pudo saber. */
  ahead: number
  /** La rama del remoto se borró (upstream «[gone]»). */
  gone: boolean
  /** Ya está en la rama base (por git o por un PR mergeado). */
  merged: boolean
  mergedBy?: 'git' | 'pr'
  pr?: { number: number; url: string }
  lastCommitAt?: number
  spaces: SpaceRef[]
}

export interface RepoScan {
  id: string
  mainPath: string
  /** Rama de la copia principal (la que no se quita nunca). */
  mainBranch: string | null
  /** Ramas desde las que se puede crear una rama aparte (las que existen en el repo). */
  bases: string[]
  /** Rama base por defecto (staging, origin/HEAD, main o master). */
  defaultBase: string | null
  error?: string
  /** La primera es la copia principal. */
  rows: BranchRow[]
}

const BASE_CANDIDATES = ['staging', 'develop', 'main', 'master']

/** Repo principal de una carpeta (aunque sea un worktree): padre de --git-common-dir. */
export async function mainRepoOf(path: string): Promise<string | null> {
  if (!existsSync(path)) return null
  const r = await gitRaw(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { timeoutMs: 10000 })
  if (r.code !== 0) return null
  const common = r.stdout.trim()
  if (!common || !isAbsolute(common)) return null
  // Repo normal: <repo>/.git ; bare: la carpeta misma.
  return /[\\/]\.git$/i.test(common) ? dirname(resolve(common)) : resolve(common)
}

async function refExists(repo: string, ref: string): Promise<boolean> {
  return (await gitRaw(repo, ['rev-parse', '--verify', '--quiet', ref], { timeoutMs: 10000 })).code === 0
}

/** Rama base por defecto: staging, origin/HEAD, main o master. */
async function defaultBase(repo: string): Promise<string | null> {
  if (await refExists(repo, 'refs/remotes/origin/staging')) return 'staging'
  const s = await gitRaw(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { timeoutMs: 10000 })
  if (s.code === 0 && s.stdout.trim()) return s.stdout.trim().replace(/^refs\/remotes\/origin\//, '')
  for (const b of ['main', 'master']) if (await refExists(repo, `refs/remotes/origin/${b}`)) return b
  for (const b of ['staging', 'main', 'master']) if (await refExists(repo, `refs/heads/${b}`)) return b
  return null
}

/** Bases que existen en el repo (local o en origin), con la por defecto primero. */
async function basesOf(repo: string, def: string | null): Promise<string[]> {
  const out: string[] = []
  for (const b of BASE_CANDIDATES) {
    if ((await refExists(repo, `refs/remotes/origin/${b}`)) || (await refExists(repo, `refs/heads/${b}`))) out.push(b)
  }
  return def ? [def, ...out.filter((b) => b !== def)] : out
}

/** Nombre del repo para mostrar: owner/nombre del remoto origin; si no hay, el nombre de la carpeta. */
async function repoIdOf(mainPath: string): Promise<string> {
  const r = await gitRaw(mainPath, ['config', '--get', 'remote.origin.url'], { timeoutMs: 8000 })
  const url = r.code === 0 ? r.stdout.trim() : ''
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url)
  return m ? `${m[1]}/${m[2]}` : basename(mainPath)
}

/** Todas las ramas locales (para no repetir nombres al crear). */
export async function localBranches(repo: string): Promise<string[]> {
  const r = await gitRaw(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { timeoutMs: 15000 })
  return r.code === 0 ? r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : []
}

/** Rama → estado de su upstream (p. ej. «[gone]», «[ahead 2]»). Una sola llamada por repo. */
async function trackMap(repo: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const r = await gitRaw(repo, ['for-each-ref', '--format=%(refname:short)%09%(upstream:track)', 'refs/heads'], { timeoutMs: 15000 })
  if (r.code !== 0) return out
  for (const line of r.stdout.split(/\r?\n/)) {
    const [name, track = ''] = line.split('\t')
    if (name) out.set(name, track.trim())
  }
  return out
}

export async function countDirty(path: string): Promise<number> {
  const r = await gitRaw(path, ['status', '--porcelain=v1', '-z'], { timeoutMs: 20000 })
  if (r.code !== 0) return -1
  return parsePorcelain(r.stdout).length
}

export async function countUnpushed(path: string): Promise<number> {
  const up = await gitRaw(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { timeoutMs: 10000 })
  const args = up.code === 0 ? ['rev-list', '--count', `${up.stdout.trim()}..HEAD`] : ['rev-list', '--count', 'HEAD', '--not', '--remotes']
  const r = await gitRaw(path, args, { timeoutMs: 15000 })
  return r.code === 0 ? Number(r.stdout.trim()) || 0 : -1
}

let ghOk: boolean | null = null
async function ghAvailable(): Promise<boolean> {
  if (ghOk !== null) return ghOk
  try {
    ghOk = (await run('gh', ['--version'], { timeoutMs: 8000 })).code === 0
  } catch {
    ghOk = false
  }
  return ghOk
}

/** PR mergeado de una rama, por 5 minutos: gh es lento y el escaneo se pide cada vez que se abre el panel. */
const GH_TTL_MS = 5 * 60_000
interface MergedPr {
  number: number
  url: string
  headRefOid?: string
}
const ghMerged = new Map<string, { at: number; pr: MergedPr | null }>()

/** Último PR mergeado de la rama (o null). Si gh falla, no se guarda nada y se consulta de nuevo después. */
async function mergedPrFor(repo: string, cwd: string, branch: string): Promise<MergedPr | null> {
  const key = `${repo}\u0000${branch}`
  const hit = ghMerged.get(key)
  if (hit && Date.now() - hit.at < GH_TTL_MS) return hit.pr
  const r = await run('gh', ['pr', 'list', '--state', 'merged', '--head', branch, '--json', 'number,url,headRefOid', '--limit', '1'], {
    cwd,
    timeoutMs: 20000
  }).catch(() => null)
  if (!r || r.code !== 0) return null
  let pr: MergedPr | null = null
  try {
    const arr = JSON.parse(r.stdout) as MergedPr[]
    pr = arr[0] ?? null
  } catch {
    /* salida rara: se ignora */
  }
  ghMerged.set(key, { at: Date.now(), pr })
  return pr
}

export interface ScanOptions {
  /** Consultar PRs mergeados con gh (por defecto sí, si gh está instalado). */
  useGh?: boolean
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++
        out[k] = await fn(items[k])
      }
    })
  )
  return out
}

/** Escanea un repo: copia principal + ramas aparte, con su estado real. */
export async function scanRepo(mainPath: string, workspaces: WsRef[], opts: ScanOptions = {}): Promise<RepoScan> {
  const id = await repoIdOf(mainPath)
  let entries: WorktreeEntry[]
  try {
    entries = parseWorktreeList(await git(mainPath, ['worktree', 'list', '--porcelain'], { timeoutMs: 20000 })).filter((e) => !e.bare)
  } catch (e) {
    return { id, mainPath, mainBranch: null, bases: [], defaultBase: null, error: e instanceof Error ? e.message : String(e), rows: [] }
  }
  const def = await defaultBase(mainPath)
  const bases = await basesOf(mainPath, def)
  const tracks = await trackMap(mainPath)
  const useGh = opts.useGh !== false && (await ghAvailable())
  const rows = await pool(entries, 4, (e) => rowOf(e, e.path === entries[0]?.path, { id, mainPath, def, tracks, useGh, workspaces }))
  return { id, mainPath, mainBranch: entries[0]?.branch ?? null, bases, defaultBase: def, rows }
}

async function rowOf(
  e: WorktreeEntry,
  isMain: boolean,
  c: { id: string; mainPath: string; def: string | null; tracks: Map<string, string>; useGh: boolean; workspaces: WsRef[] }
): Promise<BranchRow> {
  const key = normPath(e.path)
  const spaces: SpaceRef[] = c.workspaces
    .filter((w) => normPath(w.cwd) === key)
    .map((w) => ({ id: w.id, name: w.name, accountLabel: w.accountLabel }))
  const row: BranchRow = {
    repo: c.id,
    path: e.path,
    branch: e.branch ?? null,
    isMain,
    exists: existsSync(e.path),
    locked: Boolean(e.locked),
    changes: 0,
    ahead: 0,
    gone: Boolean(e.branch) && c.tracks.get(e.branch as string) === '[gone]',
    merged: false,
    spaces
  }
  if (!row.exists) return row
  row.changes = await countDirty(e.path)
  row.ahead = await countUnpushed(e.path)
  const lc = await gitRaw(e.path, ['log', '-1', '--format=%ct', 'HEAD'], { timeoutMs: 10000 })
  if (lc.code === 0 && Number(lc.stdout.trim())) row.lastCommitAt = Number(lc.stdout.trim()) * 1000
  if (!isMain && c.def) {
    const defRef = (await refExists(c.mainPath, `refs/remotes/origin/${c.def}`)) ? `refs/remotes/origin/${c.def}` : `refs/heads/${c.def}`
    const anc = await gitRaw(e.path, ['merge-base', '--is-ancestor', 'HEAD', defRef], { timeoutMs: 15000 })
    if (anc.code === 0) {
      row.merged = true
      row.mergedBy = 'git'
    }
  }
  if (!isMain && !row.merged && c.useGh && e.branch) {
    const pr = await mergedPrFor(c.mainPath, e.path, e.branch)
    if (pr) {
      row.pr = { number: pr.number, url: pr.url }
      row.merged = true
      row.mergedBy = 'pr'
      // Squash/rebase: si el HEAD local es el que se mergeó, no queda nada sin subir.
      if (pr.headRefOid && pr.headRefOid === e.head) row.ahead = 0
    }
  }
  return row
}

/** Carpeta hermana de la copia principal para una rama: `<repo>-<rama con - en lugar de />`. */
export function siblingFolder(mainPath: string, branch: string): string {
  return join(dirname(mainPath), `${basename(mainPath)}-${branch.replace(/[\\/]/g, '-')}`)
}

/**
 * Error legible para un nombre de rama nuevo, o '' si sirve. `branches` son las ramas locales
 * del repo; `mainBranch` la de la copia principal.
 */
export function branchNameError(raw: string, taken: { mainBranch: string | null; branches: string[] }): string {
  const b = raw.trim()
  if (!b) return 'Poné un nombre para la rama.'
  if (/\s/.test(b)) return 'Sin espacios: usá guiones o barras (feat/mi-cambio).'
  if (!validBranchName(b)) return 'Esa rama no es válida. Usá letras, números, guiones, puntos o barras.'
  if (b === taken.mainBranch) return 'Esa es la copia principal del repo. Elegí otro nombre.'
  if (taken.branches.includes(b)) return 'Ya hay una rama con ese nombre en este repo.'
  return ''
}

/** Repos distintos de los espacios (resolviendo worktrees a su repo principal). */
export async function reposOf(workspaces: WsRef[]): Promise<string[]> {
  const seen = new Map<string, string>()
  for (const w of workspaces) {
    for (const p of [w.repoPath, w.cwd]) {
      if (typeof p !== 'string' || !p) continue
      const main = await mainRepoOf(p)
      if (main && !seen.has(normPath(main))) seen.set(normPath(main), main)
    }
  }
  return [...seen.values()]
}
