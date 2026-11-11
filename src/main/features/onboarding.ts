import { app, shell } from 'electron'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Feature } from './context'
import { writeJsonAtomic } from './tray-settings'
import { checkEnvironment, DOCS, repoCandidates, type DocKey, type EnvReport } from './onboarding-env'

/**
 * Función «onboarding»: asistente de primera vez. Estado en userData/features/onboarding.json.
 * Ops: state, save(patch), env, suggestRepos, inspectRepo(path), openDoc(clave).
 */

export const STEPS = ['entorno', 'cuentas', 'repo', 'espacio'] as const

interface OnboardingState {
  version: 1
  completed: boolean
  skipped?: boolean
  /** Índice del paso en el que quedó (0 a 3). */
  step: number
  repoPath?: string
  updatedAt: number
}

const file = (): string => join(app.getPath('userData'), 'features', 'onboarding.json')

function load(): OnboardingState {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8').replace(/^\uFEFF/, '')) as Partial<OnboardingState>
    return {
      version: 1,
      completed: raw.completed === true,
      skipped: raw.skipped === true || undefined,
      step: Number.isInteger(raw.step) && raw.step! >= 0 && raw.step! < STEPS.length ? raw.step! : 0,
      repoPath: typeof raw.repoPath === 'string' && raw.repoPath.length <= 1000 ? raw.repoPath : undefined,
      updatedAt: Number(raw.updatedAt) || 0
    }
  } catch {
    return { version: 1, completed: false, step: 0, updatedAt: 0 }
  }
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function checkRepoArg(p: unknown): string {
  if (typeof p !== 'string' || !p.trim() || p.length > 1000) throw new Error('Elegí una carpeta.')
  const r = p.trim()
  if (!isAbsolute(r) || !isDir(r)) throw new Error('Esa carpeta no existe.')
  return r
}

const feature: Feature = {
  name: 'onboarding',
  register(ctx) {
    let state = load()
    let envRunning: Promise<EnvReport> | null = null

    ctx.handle('state', () => ({
      ...state,
      steps: STEPS,
      // Se muestra solo la primera vez: sin cuentas y sin haberlo terminado o salteado.
      show: !state.completed && ctx.store.accounts.length === 0
    }))

    ctx.handle('save', (patch: unknown) => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Datos inválidos.')
      const p = patch as Record<string, unknown>
      const next: OnboardingState = { ...state, updatedAt: Date.now() }
      if (p.step !== undefined) {
        if (!Number.isInteger(p.step) || (p.step as number) < 0 || (p.step as number) >= STEPS.length) throw new Error('Paso inválido.')
        next.step = p.step as number
      }
      if (p.completed !== undefined) {
        if (typeof p.completed !== 'boolean') throw new Error('Datos inválidos.')
        next.completed = p.completed
      }
      if (p.skipped !== undefined) {
        if (typeof p.skipped !== 'boolean') throw new Error('Datos inválidos.')
        next.skipped = p.skipped || undefined
      }
      if (p.repoPath !== undefined) next.repoPath = p.repoPath === null ? undefined : checkRepoArg(p.repoPath)
      state = next
      writeJsonAtomic(file(), state)
      return state
    })

    // Un chequeo a la vez (son 5 procesos cortos con timeout).
    ctx.handle('env', () => {
      envRunning ??= checkEnvironment().finally(() => {
        envRunning = null
      })
      return envRunning
    })

    ctx.handle('suggestRepos', () => {
      const fromWs = [...new Set(ctx.store.workspaces.map((w) => w.repoPath))]
      const list = repoCandidates(homedir(), [...(state.repoPath ? [state.repoPath] : []), ...fromWs])
      return { list }
    })

    ctx.handle('inspectRepo', (p: unknown) => {
      const repo = checkRepoArg(p)
      return { repoPath: repo, isGit: existsSync(join(repo, '.git')), name: repo.split(/[\\/]/).filter(Boolean).pop() ?? repo }
    })

    ctx.handle('openDoc', async (key: unknown) => {
      if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(DOCS, key)) throw new Error('Documento desconocido.')
      const url = DOCS[key as DocKey]
      if (!url.startsWith('https://')) throw new Error('Link inválido.')
      await shell.openExternal(url)
    })
  }
}

export default feature
