import { app, shell } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Feature, FeatureContext } from './context'
import { git, gitRaw, GitError, isDir, normPath, readable, run, validBranchName } from './git-run'
import { ghStatus, remoteUrl, repoInfo } from './git-ops'
import {
  mergeArgs,
  parseGithubRemote,
  parseRepoResponse,
  queryArgs,
  updateBranchArgs,
  validMergeMethod,
  validRepo,
  validTarget,
  worktreesWithBranch
} from './prs-core'
import type { MergeMethod, PrRow, PrsSnapshot, PrTarget, RepoPrs } from '../../shared/prs'

/**
 * Función «prs»: los PR abiertos de los repos de GitHub que usan los espacios, con sus checks y
 * revisiones. Desde acá se abre la rama de un PR en un espacio, se rebasea contra la base o se mergea.
 * Lee con gh solo con la vista abierta (o a pedido).
 */

const STALE_MS = 30_000
const AUTH_TTL_MS = 5 * 60_000
const PARALLEL = 4

interface Saved {
  snapshot: Omit<PrsSnapshot, 'refreshing'>
  ids: Record<string, string>
}

let ctx: FeatureContext
let snapshot: PrsSnapshot = { problem: null, login: null, repos: [], at: 0, refreshing: false }
let ids = new Map<string, string>()
let inflight: Promise<void> | null = null
let authCache: { ok: boolean; at: number } | null = null
let viewOpen = false
const slugs = new Map<string, string>()
const busy = new Set<string>()

const keyOf = (t: PrTarget): string => `${t.repo}#${t.number}`

function stateFile(): string {
  return join(app.getPath('userData'), 'features', 'prs.json')
}

function load(): void {
  try {
    const j = JSON.parse(readFileSync(stateFile(), 'utf8')) as Partial<Saved>
    const s = j?.snapshot
    if (s && Array.isArray(s.repos) && typeof s.at === 'number') {
      snapshot = {
        problem: s.problem === 'no-gh' || s.problem === 'no-login' || s.problem === 'no-repos' ? s.problem : null,
        login: typeof s.login === 'string' ? s.login : null,
        repos: s.repos.filter((r) => validRepo(r?.repo) && Array.isArray(r.prs) && Array.isArray(r.repoPaths)),
        at: s.at,
        refreshing: false
      }
    }
    if (j?.ids && typeof j.ids === 'object') {
      ids = new Map(Object.entries(j.ids).filter((e): e is [string, string] => typeof e[1] === 'string'))
    }
  } catch {
    /* primera vez */
  }
}

function persist(): void {
  try {
    mkdirSync(join(app.getPath('userData'), 'features'), { recursive: true })
    const { refreshing: _r, ...rest } = snapshot
    const data: Saved = { snapshot: rest, ids: Object.fromEntries(ids) }
    const tmp = `${stateFile()}.tmp`
    writeFileSync(tmp, JSON.stringify(data), 'utf8')
    renameSync(tmp, stateFile())
  } catch (e) {
    ctx.log('no se pudo guardar prs.json', e)
  }
}

async function reposDeEspacios(): Promise<Map<string, string[]>> {
  const paths = new Map<string, string>()
  for (const ws of ctx.store.workspaces) {
    const k = normPath(ws.repoPath)
    if (!paths.has(k) && isDir(ws.repoPath)) paths.set(k, ws.repoPath)
  }
  await Promise.all(
    [...paths].map(async ([k, p]) => {
      if (slugs.has(k)) return
      try {
        const url = await remoteUrl(p)
        const slug = url ? parseGithubRemote(url) : null
        if (slug) slugs.set(k, slug)
      } catch (e) {
        ctx.log('prs: no se pudo leer el remoto de', p, e)
      }
    })
  )
  const out = new Map<string, string[]>()
  for (const [k, p] of paths) {
    const slug = slugs.get(k)
    if (!slug) continue
    out.set(slug, [...(out.get(slug) ?? []), p])
  }
  return out
}

async function loggedIn(): Promise<boolean> {
  if (authCache?.ok && Date.now() - authCache.at < AUTH_TTL_MS) return true
  const r = await run('gh', ['auth', 'status', '--hostname', 'github.com'], { timeoutMs: 10000 })
  authCache = { ok: r.code === 0, at: Date.now() }
  return authCache.ok
}

async function fetchRepo(slug: string, repoPaths: string[], old: RepoPrs | undefined): Promise<{ repo: RepoPrs; ids: Record<number, string> | null; login: string }> {
  const kept = (error: string): { repo: RepoPrs; ids: null; login: string } => ({
    repo: { repo: slug, repoPaths, mergeMethods: old?.mergeMethods ?? [], prs: old?.prs ?? [], error },
    ids: null,
    login: ''
  })
  const [owner, name] = slug.split('/')
  try {
    const r = await run('gh', queryArgs(owner, name), { timeoutMs: 20000, maxBytes: 4 * 1024 * 1024 })
    if (r.code !== 0) return kept(readable(r, 'gh api graphql'))
    const p = parseRepoResponse(r.stdout, slug)
    return { repo: { repo: slug, repoPaths, mergeMethods: p.mergeMethods, prs: p.prs, error: null }, ids: p.ids, login: p.login }
  } catch (e) {
    return kept(e instanceof Error ? e.message : String(e))
  }
}

async function compute(): Promise<PrsSnapshot> {
  const at = Date.now()
  if (!(await ghStatus()).installed) return { ...snapshot, problem: 'no-gh', at }
  if (!(await loggedIn())) return { ...snapshot, problem: 'no-login', at }
  const repos = [...(await reposDeEspacios())]
  if (repos.length === 0) {
    ids.clear()
    return { problem: 'no-repos', login: snapshot.login, repos: [], at, refreshing: true }
  }
  const prev = new Map(snapshot.repos.map((r) => [r.repo, r]))
  const results: Awaited<ReturnType<typeof fetchRepo>>[] = new Array(repos.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < repos.length) {
      const i = next++
      const [slug, paths] = repos[i]
      results[i] = await fetchRepo(slug, paths, prev.get(slug))
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, repos.length) }, worker))

  const nextIds = new Map<string, string>()
  let login = snapshot.login
  for (const { repo, ids: got, login: l } of results) {
    if (l) login = l
    if (got) {
      for (const [n, id] of Object.entries(got)) nextIds.set(`${repo.repo}#${n}`, id)
    } else {
      for (const [k, id] of ids) if (k.startsWith(`${repo.repo}#`)) nextIds.set(k, id)
    }
  }
  ids = nextIds
  return { problem: null, login, repos: results.map((r) => r.repo), at, refreshing: true }
}

async function doRefresh(): Promise<void> {
  snapshot = { ...snapshot, refreshing: true }
  ctx.emit('updated', snapshot)
  try {
    snapshot = await compute()
  } catch (e) {
    ctx.log('prs: falló el refresco', e)
  } finally {
    snapshot = { ...snapshot, refreshing: false }
    persist()
    ctx.emit('updated', snapshot)
  }
}

function refresh(force: boolean): Promise<void> {
  if (inflight) return inflight
  if (!force && Date.now() - snapshot.at < STALE_MS) return Promise.resolve()
  inflight = doRefresh().finally(() => {
    inflight = null
  })
  return inflight
}

/** Después de cambiar un PR: espera un refresco en curso (que pudo leer el estado viejo) y vuelve a leer. */
async function refreshAfterChange(): Promise<void> {
  if (inflight) await inflight
  await refresh(true)
}

function rowOf(x: unknown): { row: PrRow; repo: RepoPrs; target: PrTarget } {
  const target = validTarget(x)
  const repo = snapshot.repos.find((r) => r.repo === target.repo)
  const row = repo?.prs.find((p) => p.number === target.number)
  const enUso = repo?.repoPaths.some((p) => ctx.store.workspaces.some((w) => normPath(w.repoPath) === normPath(p)))
  if (!repo || !row || !enUso) throw new Error('Ese PR ya no está en la lista. Refrescá.')
  return { row, repo, target }
}

async function exclusive<T>(t: PrTarget, fn: () => Promise<T>): Promise<T> {
  const k = keyOf(t)
  if (busy.has(k)) throw new Error('Ya hay una operación en curso con ese PR.')
  busy.add(k)
  try {
    return await fn()
  } finally {
    busy.delete(k)
  }
}

function methodOf(repo: RepoPrs, row: PrRow, method: unknown): MergeMethod {
  if (!validMergeMethod(method) || !repo.mergeMethods.includes(method)) throw new Error('Ese método de merge no está habilitado en el repo.')
  if (row.isDraft) throw new Error('Es un borrador.')
  return method
}

async function openBranch(x: unknown): Promise<{ id: string; created: boolean }> {
  const { row, repo, target } = rowOf(x)
  if (row.crossRepo) throw new Error('Es un PR de un fork: abrilo en GitHub.')
  const head = row.head
  if (!validBranchName(head)) throw new Error('La rama del PR tiene un nombre que no puedo usar.')
  return exclusive(target, async () => {
    const paths = new Set(repo.repoPaths.map(normPath))
    const candidates = ctx.store.workspaces.filter((w) => paths.has(normPath(w.repoPath)) || paths.has(normPath(w.cwd)))
    const opened = (id: string, created: boolean): { id: string; created: boolean } => {
      ctx.ui({ type: 'open-pane', id })
      return { id, created }
    }
    const same = candidates.find((w) => w.branch === head)
    if (same) return opened(same.id, false)
    for (const w of candidates) {
      if (!isDir(w.cwd)) continue
      if ((await repoInfo(w.cwd)).branch === head) return opened(w.id, false)
    }

    const repoPath = repo.repoPaths.find((p) => isDir(p))
    const accountId = candidates.find((w) => paths.has(normPath(w.repoPath)))?.accountId
    if (!repoPath || !accountId) throw new Error('No encuentro la carpeta del repo en tus espacios.')
    const name = `PR #${row.number}`

    const listed = await git(repoPath, ['worktree', 'list', '--porcelain'], { timeoutMs: 15000 })
    const existing = worktreesWithBranch(listed, head).find((p) => isDir(p))
    if (existing) {
      const ws = await ctx.addWorkspace({ name, repoPath: existing, accountId, autoStartClaude: false })
      return opened(ws.id, true)
    }

    const f = await gitRaw(repoPath, ['fetch', 'origin', `refs/heads/${head}:refs/remotes/origin/${head}`], { timeoutMs: 120000 })
    if (f.code !== 0) throw new GitError(readable(f, 'git fetch'))
    const ws = await ctx.addWorkspace({ name, repoPath, accountId, branch: head, baseBranch: `origin/${head}`, autoStartClaude: false })
    try {
      await git(ws.cwd, ['branch', '--set-upstream-to', `origin/${head}`, head], { timeoutMs: 15000 })
    } catch (e) {
      ctx.log('prs: no se pudo asociar la rama a origin', e)
    }
    return opened(ws.id, true)
  })
}

const prs: Feature = {
  name: 'prs',
  register(c) {
    ctx = c
    load()

    ctx.handle('list', () => {
      refresh(false).catch((e) => ctx.log('prs: refresco', e))
      return snapshot
    })

    ctx.handle('refresh', async () => {
      await refresh(true)
      return snapshot
    })

    ctx.handle('setOpen', (b: unknown) => {
      if (typeof b !== 'boolean') throw new Error('Valor inválido.')
      viewOpen = b
    })

    ctx.handle('openUrl', async (x: unknown, url: unknown) => {
      const { row } = rowOf(x)
      if (typeof url !== 'string' || (url !== row.url && !row.failing.some((f) => f.url === url))) throw new Error('Ese link no es de este PR.')
      await shell.openExternal(url)
    })

    ctx.handle('openBranch', (x: unknown) => openBranch(x))

    ctx.handle('rebase', async (x: unknown) => {
      const { row, target } = rowOf(x)
      const id = ids.get(keyOf(target))
      if (!id) throw new Error('Ese PR ya no está en la lista. Refrescá.')
      await exclusive(target, async () => {
        const r = await run('gh', updateBranchArgs(id, row.headSha), { timeoutMs: 60000 })
        if (r.code !== 0) throw new GitError(readable(r, 'gh api graphql'))
      })
      await refreshAfterChange()
      return { ok: true }
    })

    ctx.handle('merge', async (x: unknown, method: unknown) => {
      const { row, repo, target } = rowOf(x)
      const m = methodOf(repo, row, method)
      await exclusive(target, async () => {
        // Fuera del repo: así gh no toca ramas locales.
        const r = await run('gh', mergeArgs(target, m, row.headSha), { cwd: app.getPath('userData'), timeoutMs: 120000 })
        if (r.code !== 0) throw new GitError(readable(r, 'gh pr merge'))
      })
      await refreshAfterChange()
      return { ok: true }
    })

    ctx.handle('mergeCommand', (x: unknown, method: unknown) => {
      const { row, repo, target } = rowOf(x)
      return ['gh', ...mergeArgs(target, methodOf(repo, row, method), row.headSha)]
    })

    ctx.onWindow((win) => {
      win.on('focus', () => {
        if (viewOpen) refresh(false).catch((e) => ctx.log('prs: refresco', e))
      })
    })
  }
}

export default prs
