import { app, shell } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Feature, FeatureContext } from './context'
import { GitError, isDir, normPath, validBranchName } from './git-run'
import {
  changeCount,
  commitFiles,
  commitStaged,
  commitsToPush,
  commitsVsBase,
  createBranch,
  createPr,
  defaultBase,
  diffFile,
  discardFile,
  findStash,
  GITHUB_PR_URL,
  ghStatus,
  hasRef,
  isProtected,
  localBranches,
  logBranch,
  prCreateArgs,
  prView,
  pullFF,
  push,
  readTemplate,
  remoteBranches,
  repoInfo,
  stageAll,
  stageFile,
  stashPush,
  stashRestore,
  status,
  switchBranch,
  syncInfo,
  unstageAll,
  unstageFile,
  upstream,
  validatePr
} from './git-ops'
import type { FileChange } from './git-ops'

/**
 * Función «git»: cambios del espacio (preparar, sacar, descartar, commit), historial, ramas
 * (subir, traer, cambiar, stash de Sloth) y PR con gh. Nada corre solo: todo a pedido de la UI.
 * Avisa «changed» cuando Claude termina (hook Stop) o cuando una operación cambia el repo.
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

function text(v: unknown, max: number, what: string): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new GitError(`${what} inválido.`)
  return v
}

/** Un archivo del status: nunca se opera sobre rutas arbitrarias. */
async function fileOf(cwd: string, path: unknown): Promise<{ top: string; file: FileChange; hasHead: boolean }> {
  const p = text(path, 1024, 'Archivo')
  const st = await status(cwd)
  const file = st.files.find((f) => f.path === p)
  if (!file || !st.top) throw new GitError('Ese archivo ya no tiene cambios.')
  const info = await repoInfo(cwd)
  return { top: st.top, file, hasHead: Boolean(info.hasHead) }
}

async function topOf(cwd: string): Promise<string> {
  const info = await repoInfo(cwd)
  if (!info.isRepo || !info.top) throw new GitError('No es un repositorio git.')
  return info.top
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

/**
 * Operación que cambia el repo: se serializa por espacio y, si sale bien, avisa a la UI.
 * El primer argumento siempre es el id del espacio.
 */
function mutating<R>(fn: (cwd: string, ...rest: unknown[]) => Promise<R>): (wsId: unknown, ...rest: unknown[]) => Promise<R> {
  return wrap(async (wsId: unknown, ...rest: unknown[]) => {
    const cwd = cwdOf(wsId)
    const id = wsId as string
    const out = await exclusive(id, () => fn(cwd, ...rest))
    changed(id)
    return out
  })
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
        const { top, file, hasHead } = await fileOf(cwd, path)
        const lim = typeof limit === 'number' && Number.isFinite(limit) ? Math.min(Math.max(100, Math.floor(limit)), 20000) : 2000
        return diffFile(top, file, hasHead, lim)
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

    // ----- Cambios -----

    ctx.handle(
      'stage',
      mutating(async (cwd, path) => {
        const { top, file } = await fileOf(cwd, path)
        await stageFile(top, file)
        return true
      })
    )

    ctx.handle(
      'unstage',
      mutating(async (cwd, path) => {
        const { top, file } = await fileOf(cwd, path)
        await unstageFile(top, file)
        return true
      })
    )

    ctx.handle(
      'stageAll',
      mutating(async (cwd) => {
        await stageAll(await topOf(cwd))
        return true
      })
    )

    ctx.handle(
      'unstageAll',
      mutating(async (cwd) => {
        await unstageAll(await topOf(cwd))
        return true
      })
    )

    // Descarta los cambios de un archivo. Los no trackeados piden el nombre exacto (confirmación reforzada).
    ctx.handle(
      'discard',
      mutating(async (cwd, path, confirmName) => {
        const { top, file, hasHead } = await fileOf(cwd, path)
        if (file.code === '??' && confirmName !== basename(file.path)) throw new GitError('Escribí el nombre del archivo para confirmar.')
        await discardFile(top, file, hasHead)
        return true
      })
    )

    ctx.handle(
      'commit',
      mutating(async (cwd, message) => {
        if (typeof message !== 'string' || !message.trim()) throw new GitError('El mensaje del commit es obligatorio.')
        if (message.length > 10000) throw new GitError('Mensaje demasiado largo.')
        return commitStaged(cwd, message.trim())
      })
    )

    ctx.handle(
      'createBranch',
      mutating(async (cwd, name, base) => {
        if (typeof name !== 'string') throw new GitError('Nombre de rama inválido.')
        const n = name.trim()
        await createBranch(cwd, n, typeof base === 'string' ? base : undefined)
        return n
      })
    )

    // ----- Historial -----

    ctx.handle(
      'log',
      wrap(async (wsId: unknown) => {
        const cwd = cwdOf(wsId)
        const info = await repoInfo(cwd)
        if (!info.isRepo) return []
        return logBranch(cwd)
      })
    )

    ctx.handle(
      'commitFiles',
      wrap(async (wsId: unknown, sha: unknown) => {
        const cwd = cwdOf(wsId)
        return commitFiles(cwd, text(sha, 60, 'Commit'))
      })
    )

    // ----- Subir, traer y ramas -----

    ctx.handle(
      'sync',
      wrap(async (wsId: unknown) => {
        const cwd = cwdOf(wsId)
        const info = await repoInfo(cwd)
        if (!info.isRepo) return null
        return { branch: info.branch ?? null, ...(await syncInfo(cwd)) }
      })
    )

    // Subir: git push -u origin <rama actual>. Sin --force nunca.
    ctx.handle(
      'push',
      mutating(async (cwd, branch) => {
        if (typeof branch !== 'string') throw new GitError('Rama inválida.')
        return push(cwd, branch)
      })
    )

    // Traer: solo avance limpio (--ff-only).
    ctx.handle(
      'pull',
      mutating(async (cwd) => pullFF(cwd))
    )

    ctx.handle(
      'branches',
      wrap(async (wsId: unknown) => {
        const cwd = cwdOf(wsId)
        const info = await repoInfo(cwd)
        if (!info.isRepo) return { local: [], remote: [] }
        const local = await localBranches(cwd)
        const remote = await remoteBranches(cwd, local)
        return { local, remote }
      })
    )

    ctx.handle(
      'switch',
      mutating(async (cwd, name, remote) => {
        await switchBranch(cwd, text(name, 200, 'Rama'), remote === true)
        return true
      })
    )

    ctx.handle(
      'stashInfo',
      wrap(async (wsId: unknown) => {
        const top = await topOf(cwdOf(wsId))
        const s = await findStash(top)
        return s ? { branch: s.branch, files: s.files } : null
      })
    )

    ctx.handle(
      'stashPush',
      mutating(async (cwd) => {
        await stashPush(cwd)
        return true
      })
    )

    ctx.handle(
      'stashRestore',
      mutating(async (cwd) => {
        await stashRestore(cwd)
        return true
      })
    )

    // ----- PR -----

    ctx.handle(
      'gh',
      wrap(async () => ghStatus())
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
