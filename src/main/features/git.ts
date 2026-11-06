import { app, shell } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Feature, FeatureContext } from './context'
import { GitError, isDir, normPath, validBranchName } from './git-run'
import {
  changeCount,
  commitAll,
  commitsToPush,
  commitsVsBase,
  createBranch,
  createPr,
  defaultBase,
  diffFile,
  GITHUB_PR_URL,
  hasRef,
  isProtected,
  prCreateArgs,
  prView,
  push,
  pushArgs,
  readTemplate,
  remoteUrl,
  repoInfo,
  status,
  upstream,
  validatePr
} from './git-ops'

/**
 * Función «git»: ver los cambios de un espacio (status + diff), commitear, pushear y abrir PR.
 * Nada corre solo: todo a pedido de la UI. Avisa «changed» cuando Claude termina (hook Stop).
 */

interface Saved {
  /** Base elegida por repo (clave: ruta normalizada del top). */
  bases: Record<string, string>
}

let ctx: FeatureContext
let saved: Saved = { bases: {} }
const busy = new Set<string>()

function stateFile(): string {
  return join(app.getPath('userData'), 'features', 'git.json')
}

function load(): void {
  try {
    const j = JSON.parse(readFileSync(stateFile(), 'utf8')) as Partial<Saved>
    if (j && typeof j.bases === 'object' && j.bases) saved = { bases: j.bases as Record<string, string> }
  } catch {
    /* primera vez */
  }
}

function persist(): void {
  try {
    mkdirSync(join(app.getPath('userData'), 'features'), { recursive: true })
    const tmp = `${stateFile()}.tmp`
    writeFileSync(tmp, JSON.stringify(saved, null, 2), 'utf8')
    renameSync(tmp, stateFile())
  } catch (e) {
    ctx.log('no se pudo guardar git.json', e)
  }
}

function cwdOf(wsId: unknown): string {
  if (typeof wsId !== 'string' || wsId.length > 100) throw new GitError('Espacio inválido.')
  const ws = ctx.store.workspace(wsId)
  if (!ws) throw new GitError('El espacio ya no existe.')
  if (!isDir(ws.cwd)) throw new GitError(`No existe la carpeta ${ws.cwd}.`)
  return ws.cwd
}

async function exclusive<T>(wsId: string, fn: () => Promise<T>): Promise<T> {
  if (busy.has(wsId)) throw new GitError('Ya hay una operación de git en curso en este espacio.')
  busy.add(wsId)
  try {
    return await fn()
  } finally {
    busy.delete(wsId)
  }
}

async function baseFor(cwd: string, top: string): Promise<string | null> {
  const chosen = saved.bases[normPath(top)]
  if (chosen) return chosen
  return defaultBase(cwd)
}

function changed(wsId: string): void {
  ctx.emit('changed', wsId)
}

/** Errores con mensaje limpio para la UI (Electron antepone «Error invoking remote method…»). */
function wrap<A extends unknown[], R>(fn: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
  return async (...a: A) => {
    try {
      return await fn(...a)
    } catch (e) {
      if (e instanceof GitError) throw new Error(e.message)
      throw new Error(e instanceof Error ? e.message : String(e))
    }
  }
}

const feature: Feature = {
  name: 'git',
  register(c) {
    ctx = c
    load()

    // Claude terminó un turno: puede haber cambiado archivos. La UI refresca el contador de ese espacio.
    ctx.onHook((p) => {
      if (p.event === 'Stop' && typeof p.ws === 'string') changed(p.ws)
    })

    ctx.handle(
      'count',
      wrap(async (wsId: unknown) => {
        let cwd: string
        try {
          cwd = cwdOf(wsId)
        } catch {
          return null
        }
        return changeCount(cwd)
      })
    )

    ctx.handle(
      'status',
      wrap(async (wsId: unknown) => {
        const cwd = cwdOf(wsId)
        const st = await status(cwd)
        if (!st.isRepo) return { ...st, base: null, protected: false }
        const base = await baseFor(cwd, st.top!)
        return { ...st, base, protected: isProtected(st.branch) }
      })
    )

    ctx.handle(
      'diff',
      wrap(async (wsId: unknown, path: unknown, limit: unknown) => {
        const cwd = cwdOf(wsId)
        if (typeof path !== 'string' || !path || path.length > 1024) throw new GitError('Archivo inválido.')
        const lim = typeof limit === 'number' && Number.isFinite(limit) ? Math.min(Math.max(100, Math.floor(limit)), 20000) : 2000
        // Solo se puede pedir el diff de un archivo que figure en el status (nada de leer rutas arbitrarias).
        const st = await status(cwd)
        const file = st.files.find((f) => f.path === path)
        if (!file || !st.top) throw new GitError('Ese archivo ya no tiene cambios.')
        const info = await repoInfo(cwd)
        return diffFile(st.top, file, Boolean(info.hasHead), lim)
      })
    )

    ctx.handle(
      'setBase',
      wrap(async (wsId: unknown, base: unknown) => {
        const cwd = cwdOf(wsId)
        if (!validBranchName(base) || base.startsWith('+')) throw new GitError('Nombre de base inválido.')
        const info = await repoInfo(cwd)
        if (!info.top) throw new GitError('No es un repositorio git.')
        saved.bases[normPath(info.top)] = base
        persist()
        const exists = (await hasRef(cwd, `refs/remotes/origin/${base}`)) || (await hasRef(cwd, `refs/heads/${base}`))
        return { base, exists }
      })
    )

    ctx.handle(
      'commit',
      wrap(async (wsId: unknown, message: unknown) => {
        const cwd = cwdOf(wsId)
        if (typeof message !== 'string' || !message.trim()) throw new GitError('El mensaje del commit es obligatorio.')
        if (message.length > 10000) throw new GitError('Mensaje demasiado largo.')
        const sha = await exclusive(wsId as string, () => commitAll(cwd, message.trim()))
        changed(wsId as string)
        return sha
      })
    )

    ctx.handle(
      'createBranch',
      wrap(async (wsId: unknown, name: unknown) => {
        const cwd = cwdOf(wsId)
        if (typeof name !== 'string') throw new GitError('Nombre de rama inválido.')
        await exclusive(wsId as string, () => createBranch(cwd, name.trim()))
        changed(wsId as string)
        return name.trim()
      })
    )

    // Lo que haría el push, para la confirmación: comando exacto, remoto y commits.
    ctx.handle(
      'pushPreview',
      wrap(async (wsId: unknown) => {
        const cwd = cwdOf(wsId)
        const info = await repoInfo(cwd)
        if (!info.isRepo) throw new GitError('No es un repositorio git.')
        const branch = info.branch ?? null
        return {
          branch,
          protected: isProtected(branch),
          remote: await remoteUrl(cwd),
          upstream: await upstream(cwd),
          commits: await commitsToPush(cwd),
          command: branch ? ['git', ...pushArgs(branch)].join(' ') : null
        }
      })
    )

    ctx.handle(
      'push',
      wrap(async (wsId: unknown, branch: unknown) => {
        const cwd = cwdOf(wsId)
        if (typeof branch !== 'string') throw new GitError('Rama inválida.')
        const out = await exclusive(wsId as string, () => push(cwd, branch))
        changed(wsId as string)
        return out
      })
    )

    // Datos para armar el PR: rama, base, si está pusheada, commits, plantilla y PR existente.
    ctx.handle(
      'prPrepare',
      wrap(async (wsId: unknown, baseArg: unknown) => {
        const cwd = cwdOf(wsId)
        const info = await repoInfo(cwd)
        if (!info.isRepo || !info.top) throw new GitError('No es un repositorio git.')
        const branch = info.branch ?? null
        const base = typeof baseArg === 'string' && validBranchName(baseArg) ? baseArg : await baseFor(cwd, info.top)
        const up = await upstream(cwd)
        const unpushed = await commitsToPush(cwd)
        const commits = base ? await commitsVsBase(cwd, base) : []
        let existing = null
        let ghError: string | null = null
        if (branch && !isProtected(branch)) {
          try {
            existing = await prView(cwd, branch)
          } catch (e) {
            ghError = e instanceof Error ? e.message : String(e)
          }
        }
        const tpl = readTemplate(info.top)
        return {
          branch,
          base,
          protected: isProtected(branch),
          pushed: Boolean(up) && unpushed.length === 0,
          upstream: up,
          unpushed: unpushed.length,
          commits,
          existing,
          ghError,
          template: tpl,
          defaultTitle: commits.length === 1 ? commits[0].subject : (commits[commits.length - 1]?.subject ?? branch ?? '')
        }
      })
    )

    // Comando exacto que se va a correr (para mostrarlo en la confirmación).
    ctx.handle(
      'prCommand',
      wrap(async (input: unknown) => {
        const p = validatePr(input)
        return ['gh', ...prCreateArgs(p)]
      })
    )

    ctx.handle(
      'createPr',
      wrap(async (wsId: unknown, input: unknown) => {
        const cwd = cwdOf(wsId)
        const p = validatePr(input)
        if (isProtected(p.head)) throw new GitError(`No se abre un PR desde ${p.head}.`)
        return exclusive(wsId as string, () => createPr(cwd, p))
      })
    )

    ctx.handle(
      'openUrl',
      wrap(async (url: unknown) => {
        if (typeof url !== 'string' || url.length > 500 || !GITHUB_PR_URL.test(url)) throw new GitError('Solo se abren links https://github.com/…/pull/N.')
        const u = new URL(url)
        if (u.protocol !== 'https:' || u.hostname !== 'github.com') throw new GitError('Link no permitido.')
        await shell.openExternal(u.toString())
        return true
      })
    )
  }
}

export default feature
