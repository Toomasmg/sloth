import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Feature, FeatureContext } from './context'
import { normPath } from './git-run'
import { removeCommands, removeWorktree, reposOf, scanRepo, type RemoveRequest, type RemoveResult, type RepoScan, type WorktreeInfo } from './worktrees-scan'

/**
 * Función «worktrees»: limpieza de worktrees viejos de los repos de los espacios.
 * Escanea solo a pedido (al abrir la sección o el modal). Nada de timers.
 */

interface Summary {
  at: number
  ready: number
  total: number
}

let ctx: FeatureContext
let last: Map<string, WorktreeInfo> = new Map()
let summary: Summary | null = null
let scanning: Promise<RepoScan[]> | null = null
let removing = false

function file(): string {
  return join(app.getPath('userData'), 'features', 'worktrees.json')
}

function load(): void {
  try {
    const j = JSON.parse(readFileSync(file(), 'utf8')) as { summary?: Summary }
    if (j.summary && typeof j.summary.ready === 'number') summary = j.summary
  } catch {
    /* primera vez */
  }
}

function persist(): void {
  try {
    mkdirSync(join(app.getPath('userData'), 'features'), { recursive: true })
    const tmp = `${file()}.tmp`
    writeFileSync(tmp, JSON.stringify({ summary }, null, 2), 'utf8')
    renameSync(tmp, file())
  } catch (e) {
    ctx.log('no se pudo guardar worktrees.json', e)
  }
}

async function doScan(): Promise<RepoScan[]> {
  const wss = ctx.store.workspaces.map((w) => ({ id: w.id, name: w.name, repoPath: w.repoPath, cwd: w.cwd }))
  const repos = await reposOf(wss)
  const result: RepoScan[] = []
  for (const r of repos) result.push(await scanRepo(r, wss))
  last = new Map()
  let ready = 0
  let total = 0
  for (const r of result)
    for (const w of r.worktrees) {
      last.set(normPath(w.path), w)
      total++
      if (w.safe) ready++
    }
  summary = { at: Date.now(), ready, total }
  persist()
  ctx.emit('summary', summary)
  return result
}

function parseRequests(x: unknown): RemoveRequest[] {
  if (!Array.isArray(x) || x.length === 0 || x.length > 200) throw new Error('Nada para borrar.')
  return x.map((o) => {
    const r = o as Record<string, unknown>
    if (!r || typeof r.path !== 'string' || r.path.length > 1024) throw new Error('Pedido inválido.')
    return {
      path: r.path,
      force: r.force === true,
      deleteBranch: r.deleteBranch === true,
      forceBranch: r.forceBranch === true,
      removeWorkspaces: r.removeWorkspaces !== false
    }
  })
}

const feature: Feature = {
  name: 'worktrees',
  register(c) {
    ctx = c
    load()

    ctx.handle('summary', () => summary)

    ctx.handle('scan', async () => {
      // Si ya hay un escaneo en curso, se comparte.
      if (!scanning) scanning = doScan().finally(() => (scanning = null))
      return scanning
    })

    // Comandos exactos para la confirmación (solo de worktrees del último escaneo).
    ctx.handle('plan', (reqs: unknown) => {
      const list = parseRequests(reqs)
      return list.map((r) => {
        const w = last.get(normPath(r.path))
        if (!w) throw new Error(`No figura en el último escaneo: ${r.path}`)
        if (!w.safe && !r.force && w.dirty !== 0) throw new Error(`${w.path} tiene cambios: requiere «forzar».`)
        return {
          path: w.path,
          branch: w.branch,
          commands: removeCommands(w, r).map((c) => c.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')),
          workspaces: w.workspaces
        }
      })
    })

    ctx.handle('remove', async (reqs: unknown) => {
      if (removing) throw new Error('Ya se está borrando.')
      const list = parseRequests(reqs)
      // Solo rutas que salieron del último escaneo: nunca una ruta arbitraria.
      const items = list.map((r) => {
        const w = last.get(normPath(r.path))
        if (!w) throw new Error(`No figura en el último escaneo: ${r.path}. Volvé a escanear.`)
        if (!w.exists) throw new Error(`La carpeta ya no existe: ${w.path}`)
        if (!w.safe && !r.force && (w.dirty !== 0 || w.locked)) throw new Error(`${w.path} no es seguro: requiere «forzar».`)
        return { w, r }
      })
      removing = true
      const results: RemoveResult[] = []
      let reload = false
      try {
        const term = await ctx.backend()
        for (const { w, r } of items) {
          // La terminal tiene la carpeta abierta: en Windows hay que cerrarla antes de borrar.
          for (const ws of w.workspaces) {
            try {
              await term.kill(ws.id)
            } catch {
              /* ya estaba cerrada */
            }
          }
          const res = await removeWorktree(w, r)
          if (res.removedWorktree) {
            last.delete(normPath(w.path))
            if (r.removeWorkspaces !== false)
              for (const ws of w.workspaces) {
                await ctx.removeWorkspace(ws.id)
                reload = true
              }
          }
          if (w.workspaces.length) reload = true
          results.push(res)
        }
      } finally {
        removing = false
        if (reload) ctx.ui({ type: 'reload' })
      }
      if (summary) {
        const ready = [...last.values()].filter((w) => w.safe).length
        summary = { at: Date.now(), ready, total: last.size }
        persist()
        ctx.emit('summary', summary)
      }
      return results
    })
  }
}

export default feature
