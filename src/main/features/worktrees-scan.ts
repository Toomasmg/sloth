import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { parsePorcelain } from './git-ops'
import { git, gitRaw, GitError, normPath, readable, run, validBranchName } from './git-run'

/** Lógica de la limpieza de worktrees, sin Electron (se prueba con Node). */

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

export interface WsRef {
  id: string
  name: string
  repoPath: string
  cwd: string
}

export interface WorktreeInfo {
  repo: string
  path: string
  branch: string | null
  head?: string
  exists: boolean
  locked: boolean
  /** Archivos con cambios (incluye sin trackear). -1 = no se pudo leer. */
  dirty: number
  /** Commits que no están en ningún remoto (o en el upstream). */
  unpushed: number
  merged: boolean
  mergedBy?: 'git' | 'pr'
  /** La rama no tiene commits propios respecto de la base. */
  sameAsBase?: boolean
  pr?: { number: number; url: string }
  base: string | null
  lastCommitAt?: number
  workspaces: { id: string; name: string }[]
  safe: boolean
  reasons: string[]
}

export interface RepoScan {
  repo: string
  base: string | null
  error?: string
  worktrees: WorktreeInfo[]
}

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

async function baseRef(repo: string): Promise<{ name: string; ref: string } | null> {
  const has = async (ref: string): Promise<boolean> => (await gitRaw(repo, ['rev-parse', '--verify', '--quiet', ref], { timeoutMs: 10000 })).code === 0
  if (await has('refs/remotes/origin/staging')) return { name: 'staging', ref: 'refs/remotes/origin/staging' }
  const s = await gitRaw(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { timeoutMs: 10000 })
  if (s.code === 0 && s.stdout.trim()) {
    const ref = s.stdout.trim()
    return { name: ref.replace(/^refs\/remotes\/origin\//, ''), ref }
  }
  for (const b of ['main', 'master']) if (await has(`refs/remotes/origin/${b}`)) return { name: b, ref: `refs/remotes/origin/${b}` }
  for (const b of ['staging', 'main', 'master']) if (await has(`refs/heads/${b}`)) return { name: b, ref: `refs/heads/${b}` }
  return null
}

async function countDirty(path: string): Promise<number> {
  const r = await gitRaw(path, ['status', '--porcelain=v1', '-z'], { timeoutMs: 20000 })
  if (r.code !== 0) return -1
  return parsePorcelain(r.stdout).length
}

async function countUnpushed(path: string): Promise<number> {
  const up = await gitRaw(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { timeoutMs: 10000 })
  const args = up.code === 0 ? ['rev-list', '--count', `${up.stdout.trim()}..HEAD`] : ['rev-list', '--count', 'HEAD', '--not', '--remotes']
  const r = await gitRaw(path, args, { timeoutMs: 15000 })
  return r.code === 0 ? Number(r.stdout.trim()) || 0 : -1
}

let ghOk: boolean | null = null
async function ghAvailable(): Promise<boolean> {
  if (ghOk !== null) return ghOk
  try {
    const r = await run('gh', ['--version'], { timeoutMs: 8000 })
    ghOk = r.code === 0
  } catch {
    ghOk = false
  }
  return ghOk
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

export async function scanRepo(repo: string, workspaces: WsRef[], opts: ScanOptions = {}): Promise<RepoScan> {
  let entries: WorktreeEntry[]
  try {
    entries = parseWorktreeList(await git(repo, ['worktree', 'list', '--porcelain'], { timeoutMs: 20000 }))
  } catch (e) {
    return { repo, base: null, error: e instanceof Error ? e.message : String(e), worktrees: [] }
  }
  const base = await baseRef(repo)
  const useGh = opts.useGh !== false && (await ghAvailable())
  // El primero es el principal: no se ofrece.
  const others = entries.slice(1).filter((e) => !e.bare)
  const worktrees = await pool(others, 4, async (e): Promise<WorktreeInfo> => {
    const exists = existsSync(e.path)
    const key = normPath(e.path)
    const ws = workspaces.filter((w) => normPath(w.cwd) === key).map((w) => ({ id: w.id, name: w.name }))
    const info: WorktreeInfo = {
      repo,
      path: e.path,
      branch: e.branch ?? null,
      head: e.head,
      exists,
      locked: Boolean(e.locked),
      dirty: 0,
      unpushed: 0,
      merged: false,
      base: base?.name ?? null,
      workspaces: ws,
      safe: false,
      reasons: []
    }
    if (!exists) {
      info.reasons.push('La carpeta ya no existe (se limpia con «git worktree prune»).')
      return info
    }
    info.dirty = await countDirty(e.path)
    info.unpushed = await countUnpushed(e.path)
    const lc = await gitRaw(e.path, ['log', '-1', '--format=%ct', 'HEAD'], { timeoutMs: 10000 })
    if (lc.code === 0) info.lastCommitAt = Number(lc.stdout.trim()) * 1000 || undefined
    if (base) {
      const anc = await gitRaw(e.path, ['merge-base', '--is-ancestor', 'HEAD', base.ref], { timeoutMs: 15000 })
      if (anc.code === 0) {
        info.merged = true
        info.mergedBy = 'git'
        const same = await gitRaw(e.path, ['rev-list', '--count', `${base.ref}..HEAD`], { timeoutMs: 10000 })
        const tip = await gitRaw(e.path, ['rev-parse', base.ref], { timeoutMs: 10000 })
        info.sameAsBase = same.code === 0 && same.stdout.trim() === '0' && tip.stdout.trim() === e.head
      }
    }
    if (!info.merged && useGh && e.branch) {
      const r = await run('gh', ['pr', 'list', '--state', 'merged', '--head', e.branch, '--json', 'number,url,headRefOid', '--limit', '1'], {
        cwd: e.path,
        timeoutMs: 20000
      }).catch(() => null)
      if (r && r.code === 0) {
        try {
          const arr = JSON.parse(r.stdout) as { number: number; url: string; headRefOid?: string }[]
          if (arr[0]) {
            info.pr = { number: arr[0].number, url: arr[0].url }
            info.merged = true
            info.mergedBy = 'pr'
            // Squash/rebase: los commits no quedan en la base. Si el HEAD local es el que se mergeó, no se pierde nada.
            if (arr[0].headRefOid && arr[0].headRefOid === e.head) info.unpushed = 0
          }
        } catch {
          /* salida rara: se ignora */
        }
      }
    }
    if (e.locked) info.reasons.push('Está bloqueado (git worktree lock).')
    if (info.dirty < 0) info.reasons.push('No se pudo leer el estado.')
    else if (info.dirty > 0) info.reasons.push(`Tiene ${info.dirty} archivo${info.dirty === 1 ? '' : 's'} con cambios sin commitear.`)
    if (info.unpushed < 0) info.reasons.push('No se pudo saber si hay commits sin pushear.')
    else if (info.unpushed > 0) info.reasons.push(`Tiene ${info.unpushed} commit${info.unpushed === 1 ? '' : 's'} sin pushear.`)
    if (!info.merged) info.reasons.push(base ? `La rama no está mergeada en ${base.name}.` : 'No encontré una rama base para comparar.')
    if (!e.branch) info.reasons.push('HEAD separado (sin rama).')
    info.safe = info.merged && info.dirty === 0 && info.unpushed === 0 && !e.locked
    return info
  })
  return { repo, base: base?.name ?? null, worktrees }
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

export interface RemoveRequest {
  path: string
  /** Opt-in explícito por fila: `git worktree remove --force`. */
  force?: boolean
  deleteBranch?: boolean
  /** Opt-in explícito: `git branch -D` en vez de `-d`. */
  forceBranch?: boolean
  removeWorkspaces?: boolean
}

/** Comandos exactos que se van a correr para una fila (para la confirmación y para correrlos). */
export function removeCommands(w: Pick<WorktreeInfo, 'repo' | 'path' | 'branch'>, r: RemoveRequest): string[][] {
  const cmds: string[][] = [['git', '-C', w.repo, 'worktree', 'remove', ...(r.force ? ['--force'] : []), w.path]]
  if (r.deleteBranch && w.branch) cmds.push(['git', '-C', w.repo, 'branch', r.forceBranch ? '-D' : '-d', w.branch])
  return cmds
}

export interface RemoveResult {
  path: string
  ok: boolean
  removedWorktree: boolean
  removedBranch: boolean
  error?: string
}

/** Borra un worktree (y su rama si se pidió). Revalida que no esté sucio si no hay --force. */
export async function removeWorktree(w: WorktreeInfo, r: RemoveRequest): Promise<RemoveResult> {
  const res: RemoveResult = { path: w.path, ok: false, removedWorktree: false, removedBranch: false }
  if (!r.force) {
    const d = await countDirty(w.path)
    if (d !== 0) {
      res.error = d < 0 ? 'No se pudo leer el estado; no se borra.' : `Ahora tiene ${d} archivo(s) con cambios; no se borra sin «forzar».`
      return res
    }
  }
  const wr = await gitRaw(w.repo, ['worktree', 'remove', ...(r.force ? ['--force'] : []), w.path], { timeoutMs: 60000 })
  if (wr.code !== 0) {
    res.error = readable(wr, 'git worktree remove')
    return res
  }
  res.removedWorktree = true
  if (r.deleteBranch && w.branch) {
    if (!validBranchName(w.branch)) {
      res.error = 'Nombre de rama raro: no se borra.'
      return res
    }
    const br = await gitRaw(w.repo, ['branch', r.forceBranch ? '-D' : '-d', w.branch], { timeoutMs: 20000 })
    if (br.code !== 0) {
      res.error = `Se borró la carpeta, pero no la rama: ${readable(br, 'git branch').replace(/^git branch falló: /, '')}`
      return res
    }
    res.removedBranch = true
  }
  res.ok = true
  return res
}

export { GitError }
