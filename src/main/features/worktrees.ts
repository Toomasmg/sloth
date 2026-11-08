import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { shell } from 'electron'
import type { Workspace } from '../../shared/types'
import type { Feature, FeatureContext } from './context'
import { gitRaw, normPath, readable } from './git-run'
import {
  branchNameError,
  countDirty,
  countUnpushed,
  localBranches,
  reposOf,
  scanRepo,
  siblingFolder,
  type BranchRow,
  type RepoScan,
  type WsRef
} from './worktrees-scan'

/**
 * Función «worktrees»: «Ramas aparte» (git worktree) de los repos de los espacios abiertos.
 * Escanea solo a pedido (al abrir el panel). Nada de timers ni de escaneos en segundo plano.
 */

let ctx: FeatureContext
/** Último escaneo: solo se actúa sobre rutas que salieron de ahí (nunca una ruta arbitraria). */
let lastRepos: RepoScan[] = []
let lastRows = new Map<string, { repo: RepoScan; row: BranchRow }>()
let scanning: Promise<RepoView[]> | null = null
let busy = false

/** Fila tal como la ve la interfaz: con la última actividad calculada. */
export interface RowView extends BranchRow {
  /** Último uso: el de sus espacios o el último commit, lo que sea más reciente (ms). */
  lastUseAt?: number
}

export interface RepoView {
  id: string
  mainPath: string
  mainBranch: string | null
  bases: string[]
  defaultBase: string | null
  error?: string
  rows: RowView[]
}

export interface RemoveResult {
  path: string
  ok: boolean
  error?: string
  /** Nombres de los espacios que se cerraron al quitar la carpeta. */
  closedSpaces: string[]
}

const key = (p: string): string => normPath(p)

function wsRefs(): WsRef[] {
  return ctx.store.workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    repoPath: w.repoPath,
    cwd: w.cwd,
    accountLabel: ctx.store.account(w.accountId)?.label
  }))
}

function viewOf(repos: RepoScan[]): RepoView[] {
  const agents = ctx.agents()
  return repos.map((r) => ({
    id: r.id,
    mainPath: r.mainPath,
    mainBranch: r.mainBranch,
    bases: r.bases,
    defaultBase: r.defaultBase,
    error: r.error,
    rows: r.rows.map((row) => {
      const agentAt = row.spaces.map((s) => agents.get(s.id)?.at ?? 0)
      const lastUseAt = Math.max(row.lastCommitAt ?? 0, ...agentAt)
      return { ...row, lastUseAt: lastUseAt || undefined }
    })
  }))
}

async function doScan(): Promise<RepoView[]> {
  const wss = wsRefs()
  const repos = await reposOf(wss)
  const out: RepoScan[] = []
  for (const r of repos) out.push(await scanRepo(r, wss))
  lastRepos = out
  lastRows = new Map()
  for (const r of out) for (const row of r.rows) lastRows.set(key(row.path), { repo: r, row })
  return viewOf(out)
}

/** La fila del último escaneo, o un error que pide volver a abrir el panel. */
function known(path: unknown): { repo: RepoScan; row: BranchRow } {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024) throw new Error('Ruta inválida.')
  const hit = lastRows.get(key(path))
  if (!hit) throw new Error('Esa rama aparte no está en la última lista. Volvé a abrir «Ramas aparte».')
  return hit
}

function parseText(v: unknown, max: number, what: string): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new Error(`${what} inválido.`)
  return v
}

/** Quita una rama aparte: cierra sus espacios y borra la carpeta (la rama queda en el repo). */
async function removeOne(path: string, force: boolean): Promise<RemoveResult> {
  const { repo, row } = known(path)
  if (row.isMain) return { path, ok: false, error: 'La copia principal no se quita.', closedSpaces: [] }
  if (row.locked) return { path, ok: false, error: 'La carpeta está bloqueada (git worktree lock).', closedSpaces: [] }
  const spaces = ctx.store.workspaces.filter((w) => key(w.cwd) === key(row.path))
  if (!row.exists) {
    // La carpeta ya no está: se limpia el registro de git.
    const pr = await gitRaw(repo.mainPath, ['worktree', 'prune'], { timeoutMs: 30000 })
    if (pr.code !== 0) return { path, ok: false, error: readable(pr, 'git worktree prune'), closedSpaces: [] }
    lastRows.delete(key(path))
    return { path, ok: true, closedSpaces: [] }
  }
  if (!force) {
    const dirty = await countDirty(row.path)
    if (dirty < 0) return { path, ok: false, error: 'No se pudo leer el estado de la carpeta; no se quita.', closedSpaces: [] }
    if (dirty > 0) return { path, ok: false, error: `Tiene ${dirty} cambio${dirty === 1 ? '' : 's'} sin confirmar: confirmá que se pierden.`, closedSpaces: [] }
  }
  // Windows no borra una carpeta que una terminal tiene abierta: se cierran antes.
  const term = await ctx.backend()
  for (const w of spaces) {
    try {
      await term.kill(w.id)
    } catch {
      /* ya estaba cerrada */
    }
  }
  const r = await gitRaw(repo.mainPath, ['worktree', 'remove', ...(force ? ['--force'] : []), row.path], { timeoutMs: 120000 })
  if (r.code !== 0) return { path, ok: false, error: readable(r, 'git worktree remove'), closedSpaces: [] }
  for (const w of spaces) await ctx.removeWorkspace(w.id)
  lastRows.delete(key(path))
  return { path, ok: true, closedSpaces: spaces.map((w) => w.name) }
}

/** Solo candidatas: sin espacio, sin cambios, sin commits sin subir, y mergeada o borrada en origin. Revalida con git. */
async function cleanOne(path: string): Promise<RemoveResult> {
  const { row } = known(path)
  const ok = !row.isMain && row.exists && !row.locked && row.spaces.length === 0 && (row.merged || row.gone)
  if (!ok) return { path, ok: false, error: 'Ya no cumple las condiciones para limpiar.', closedSpaces: [] }
  const dirty = await countDirty(row.path)
  const ahead = await countUnpushed(row.path)
  if (dirty !== 0 || ahead !== 0) return { path, ok: false, error: 'Ahora tiene cambios o commits sin subir: no se quita.', closedSpaces: [] }
  return removeOne(path, false)
}

interface CreateInput {
  repoPath: string
  name: string
  base: string
  openSpace: boolean
  accountId?: string
}

function parseCreate(x: unknown): CreateInput {
  const o = (x ?? {}) as Record<string, unknown>
  const openSpace = o.openSpace === true
  return {
    repoPath: parseText(o.repoPath, 1024, 'Repo'),
    name: typeof o.name === 'string' ? o.name : '',
    base: parseText(o.base, 200, 'Rama base'),
    openSpace,
    accountId: openSpace ? parseText(o.accountId, 100, 'Cuenta') : undefined
  }
}

/** Crea la rama aparte en su carpeta hermana y, si se pidió, un espacio de Sloth con cuenta. */
async function createOne(x: unknown): Promise<{ path: string; branch: string; spaceId?: string }> {
  const i = parseCreate(x)
  const rs = lastRepos.find((r) => key(r.mainPath) === key(i.repoPath))
  if (!rs) throw new Error('Ese repo ya no está en la lista. Volvé a abrir «Ramas aparte».')
  const acc = i.openSpace ? ctx.store.account(i.accountId as string) : undefined
  if (i.openSpace && !acc) throw new Error('Esa cuenta ya no existe.')
  if (acc && !existsSync(acc.configDir)) throw new Error(`Falta la carpeta de la cuenta «${acc.label}».`)

  const branch = i.name.trim()
  const err = branchNameError(branch, { mainBranch: rs.mainBranch, branches: await localBranches(rs.mainPath) })
  if (err) throw new Error(err)
  if (!rs.bases.includes(i.base)) throw new Error(`La rama base «${i.base}» no existe en este repo.`)
  const folder = siblingFolder(rs.mainPath, branch)
  if (existsSync(folder)) throw new Error(`Ya existe la carpeta ${basename(folder)} al lado de la copia principal.`)

  // Sale de origin/<base> si existe (lo último del remoto); si no, de la rama local.
  const fromRemote = (await gitRaw(rs.mainPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${i.base}`], { timeoutMs: 10000 })).code === 0
  const start = fromRemote ? `origin/${i.base}` : i.base
  const r = await gitRaw(rs.mainPath, ['worktree', 'add', '-b', branch, folder, start], { timeoutMs: 120000 })
  if (r.code !== 0) throw new Error(readable(r, 'git worktree add'))

  let spaceId: string | undefined
  if (acc) {
    const seg = branch.split('/').pop() || branch
    const ws: Workspace = {
      id: randomUUID(),
      name: seg,
      repoPath: rs.mainPath,
      cwd: folder,
      branch,
      accountId: acc.id,
      autoStartClaude: true,
      createdAt: Date.now(),
      resume: true
    }
    ctx.store.addWorkspace(ws)
    spaceId = ws.id
    ctx.ui({ type: 'reload' })
    ctx.ui({ type: 'open-pane', id: ws.id })
  }
  return { path: folder, branch, spaceId }
}

const feature: Feature = {
  name: 'worktrees',
  register(c) {
    ctx = c

    ctx.handle('scan', async () => {
      if (!scanning) scanning = doScan().finally(() => (scanning = null))
      return scanning
    })

    ctx.handle('create', (x: unknown) => {
      if (busy) throw new Error('Todavía se está haciendo otra operación. Esperá un momento.')
      busy = true
      return createOne(x).finally(() => (busy = false))
    })

    ctx.handle('remove', async (x: unknown) => {
      if (busy) throw new Error('Todavía se está haciendo otra operación. Esperá un momento.')
      const o = (x ?? {}) as Record<string, unknown>
      busy = true
      try {
        const res = await removeOne(parseText(o.path, 1024, 'Ruta'), o.force === true)
        if (res.closedSpaces.length) ctx.ui({ type: 'reload' })
        return res
      } finally {
        busy = false
      }
    })

    ctx.handle('clean', async (x: unknown) => {
      if (!Array.isArray(x) || x.length === 0 || x.length > 200) throw new Error('Nada para limpiar.')
      if (busy) throw new Error('Todavía se está haciendo otra operación. Esperá un momento.')
      busy = true
      const out: RemoveResult[] = []
      try {
        for (const p of x) {
          const res = await cleanOne(parseText(p, 1024, 'Ruta')).catch((e: unknown) => ({
            path: String(p),
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            closedSpaces: []
          }))
          out.push(res)
        }
      } finally {
        busy = false
        if (out.some((r) => r.closedSpaces.length)) ctx.ui({ type: 'reload' })
      }
      return out
    })

    /** Abre la carpeta en el Explorador. Solo carpetas del último escaneo. Devuelve '' o el error. */
    ctx.handle('openFolder', async (p: unknown) => {
      const { row } = known(parseText(p, 1024, 'Ruta'))
      if (!row.exists || !statSync(row.path).isDirectory()) throw new Error('La carpeta ya no existe.')
      return shell.openPath(row.path)
    })
  }
}

export default feature
