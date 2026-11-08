import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Feature, FeatureContext } from './context'
import { accountStatus } from '../accounts'
import { buildInput, pickSuggested, SUGGESTED, TemplateFile, type Template } from './templates-core'
import { gitRaw, isDir, normPath } from './git-run'
import type { UsageTotals } from '../../shared/types'

/**
 * Función «templates»: plantillas de espacio en userData/features/templates.json.
 * Ops: list, save(plantilla), remove(id), duplicate(id), setDefault(id|null), used(id),
 * create(id, {ticket?, repoPath?}), folder(path), recent(), branches(path).
 * Evento: changed({list, defaultId}).
 *
 * Las plantillas «del equipo» son las que importó la función «team-config» (su mapa de ids).
 * La interfaz no las edita ni las borra; main tampoco deja borrarlas.
 */
let file: TemplateFile | undefined

const tot = (t?: UsageTotals): number => (t ? t.input + t.output + t.cacheWrite + t.cacheRead : 0)

/** Ids de plantillas que vienen del equipo (team-config las mapea al importarlas). Solo lectura. */
function teamIds(): Set<string> {
  const ids = new Set<string>()
  try {
    const raw = JSON.parse(readFileSync(join(app.getPath('userData'), 'features', 'team-config.json'), 'utf8').replace(/^﻿/, '')) as {
      teams?: Record<string, { mapping?: Record<string, unknown> }>
    }
    for (const e of Object.values(raw.teams ?? {})) for (const v of Object.values(e?.mapping ?? {})) if (typeof v === 'string') ids.add(v)
  } catch {
    /* sin equipo: ninguna */
  }
  return ids
}

interface FolderInfo {
  path: string
  name: string
  exists: boolean
  isGit: boolean
  /** Rama actual; null si no es git o está suelta (HEAD detached). */
  branch: string | null
  /** Espacios abiertos en esta carpeta. */
  spaces: { id: string; name: string; accountId: string; accountLabel: string }[]
}

async function folderInfo(ctx: FeatureContext, p: unknown): Promise<FolderInfo> {
  const path = typeof p === 'string' ? p.trim() : ''
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? ''
  if (!path || path.length > 1000 || !isAbsolute(path) || !isDir(path)) return { path, name, exists: false, isGit: false, branch: null, spaces: [] }
  let isGit = false
  let branch: string | null = null
  try {
    const r = await gitRaw(path, ['rev-parse', '--is-inside-work-tree'])
    isGit = r.code === 0 && r.stdout.trim() === 'true'
    if (isGit) {
      const b = await gitRaw(path, ['symbolic-ref', '--short', '-q', 'HEAD'])
      branch = b.code === 0 && b.stdout.trim() ? b.stdout.trim() : null
    }
  } catch {
    /* sin git instalado: no es un repo para nosotros */
  }
  const key = normPath(path)
  const spaces = ctx.store.workspaces
    .filter((w) => normPath(w.repoPath) === key || normPath(w.cwd) === key)
    .map((w) => ({ id: w.id, name: w.name, accountId: w.accountId, accountLabel: ctx.store.account(w.accountId)?.label ?? 'cuenta borrada' }))
  return { path, name, exists: true, isGit, branch, spaces }
}

async function recent(ctx: FeatureContext): Promise<{ folders: FolderInfo[]; counts: Record<string, number> }> {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const w of [...ctx.store.workspaces].reverse()) {
    const k = normPath(w.repoPath)
    if (seen.has(k)) continue
    seen.add(k)
    paths.push(w.repoPath)
  }
  const folders = await Promise.all(paths.slice(0, 6).map((p) => folderInfo(ctx, p)))
  const counts: Record<string, number> = {}
  for (const w of ctx.store.workspaces) counts[w.accountId] = (counts[w.accountId] ?? 0) + 1
  return { folders: folders.filter((f) => f.exists), counts }
}

async function branchesOf(p: unknown): Promise<{ branches: string[]; defaultBase: string | null }> {
  const path = typeof p === 'string' ? p.trim() : ''
  if (!path || !isAbsolute(path) || !isDir(path)) return { branches: [], defaultBase: null }
  const r = await gitRaw(path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin'])
  if (r.code !== 0) return { branches: [], defaultBase: null }
  const list = r.stdout
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x && x !== 'origin/HEAD')
    .slice(0, 300)
  const cur = await gitRaw(path, ['symbolic-ref', '--short', '-q', 'HEAD'])
  const current = cur.code === 0 ? cur.stdout.trim() : ''
  // Por defecto: staging del remoto si existe; si no, la rama actual.
  const defaultBase = list.includes('origin/staging') ? 'origin/staging' : current || list[0] || null
  return { branches: list, defaultBase }
}

async function resolveAccount(ctx: FeatureContext, t: Template): Promise<string> {
  const accounts = ctx.store.accounts
  if (t.accountId !== SUGGESTED) {
    if (!ctx.store.account(t.accountId)) throw new Error(`La cuenta de la plantilla «${t.name}» ya no existe. Editala y elegí otra.`)
    return t.accountId
  }
  if (!accounts.length) throw new Error('Agregá una cuenta primero.')
  let usage = ctx.usage.latest
  try {
    // Incremental y cacheado; si tarda, nos quedamos con lo último que se leyó.
    usage = await Promise.race([ctx.usage.scan(accounts), new Promise<typeof usage>((r) => setTimeout(() => r(ctx.usage.latest), 4000))])
  } catch {
    /* sin datos de uso: se elige entre las que tienen sesión */
  }
  const id = pickSuggested(
    accounts,
    (aid) => {
      const a = ctx.store.account(aid)
      return a ? accountStatus(a).loggedIn : false
    },
    (aid) => tot(usage[aid]?.last5h)
  )
  if (!id) throw new Error('No hay ninguna cuenta para usar.')
  return id
}

const feature: Feature = {
  name: 'templates',
  register(ctx) {
    file = new TemplateFile(join(app.getPath('userData'), 'features', 'templates.json'))
    const f = file
    const accountIds = (): Set<string> => new Set(ctx.store.accounts.map((a) => a.id))
    const view = (): { list: (Template & { team: boolean })[]; defaultId: string | null } => {
      const team = teamIds()
      return { list: f.all().map((t) => ({ ...t, team: team.has(t.id) })), defaultId: f.defaultId() }
    }
    const changed = (): void => ctx.emit('changed', view())

    ctx.handle('list', () => view())

    ctx.handle('save', (raw: unknown) => {
      const t = f.save(raw, accountIds())
      changed()
      return t
    })

    ctx.handle('remove', (id: unknown) => {
      if (typeof id === 'string' && teamIds().has(id)) throw new Error('Las plantillas del equipo no se borran. Duplicala y borrá tu copia.')
      f.remove(id)
      changed()
    })

    ctx.handle('duplicate', (id: unknown) => {
      const t = f.duplicate(id)
      changed()
      return t
    })

    ctx.handle('setDefault', (id: unknown) => {
      if (id !== null && typeof id !== 'string') throw new Error('Datos inválidos.')
      f.setDefault(id)
      changed()
    })

    ctx.handle('used', (id: unknown) => {
      f.bump(id)
      changed()
    })

    ctx.handle('folder', (p: unknown) => folderInfo(ctx, p))
    ctx.handle('recent', () => recent(ctx))
    ctx.handle('branches', (p: unknown) => branchesOf(p))

    let creating = false
    ctx.handle('create', async (id: unknown, vars: unknown) => {
      const t = f.get(id)
      if (!t) throw new Error('Esa plantilla ya no existe.')
      if (vars !== undefined && (vars === null || typeof vars !== 'object' || Array.isArray(vars))) throw new Error('Datos inválidos.')
      const v = (vars ?? {}) as { ticket?: unknown; repoPath?: unknown }
      if (creating) throw new Error('Ya se está creando un espacio; esperá un momento.')
      if (!t.repoPath && typeof v.repoPath !== 'string') throw new Error('Esta plantilla no tiene carpeta: elegila al crear el espacio.')
      creating = true
      try {
        const accountId = await resolveAccount(ctx, t)
        const repoPath = t.repoPath ?? (typeof v.repoPath === 'string' ? v.repoPath : undefined)
        const info = repoPath ? await folderInfo(ctx, repoPath) : null
        const { input, n } = buildInput(
          t,
          { ticket: typeof v.ticket === 'string' ? v.ticket : undefined, repoPath, currentBranch: info?.branch ?? undefined },
          accountId
        )
        const ws = await ctx.addWorkspace(input)
        f.setCounter(t.id, n)
        changed()
        ctx.ui({ type: 'open-pane', id: ws.id })
        return ws
      } finally {
        creating = false
      }
    })
  }
}

export default feature
