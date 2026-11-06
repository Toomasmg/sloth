import { useSyncExternalStore } from 'react'
import type { UiCtx } from '../host'

/** Lo mismo que manda main (team-config.ts). */
export interface TeamLink {
  nombre: string
  url: string
}
export interface TeamSettings {
  densidad?: 'compacta' | 'cómoda'
  tamañoTerminal?: number
}
export interface TeamStatus {
  repoPath: string
  state: 'ok' | 'invalid'
  error?: string
  equipo?: string
  hash?: string
  pending: number
  imported: number
  total: number
  notify: boolean
  links: TeamLink[]
  ajustes?: TeamSettings
  settingsPending: boolean
}
export type PlanAction = 'new' | 'update' | 'same' | 'renamed'
export interface PlanItem {
  key: string
  action: PlanAction
  payload?: Record<string, unknown>
  id?: string
  savedName: string
  error?: string
}
export interface ImportPlan {
  equipo: string
  hash: string
  items: PlanItem[]
  orphans: string[]
}

export type TeamDialog = null | { kind: 'import'; repoPath: string } | { kind: 'export'; repoPath?: string }

interface State {
  teams: TeamStatus[]
  dialog: TeamDialog
}

let state: State = { teams: [], dialog: null }
const subs = new Set<() => void>()
const set = (patch: Partial<State>): void => {
  state = { ...state, ...patch }
  subs.forEach((f) => f())
}
const subscribe = (cb: () => void): (() => void) => {
  subs.add(cb)
  return () => subs.delete(cb)
}

export const useTeam = (): State => useSyncExternalStore(subscribe, () => state)
export const getTeams = (): TeamStatus[] => state.teams
export const setTeams = (teams: unknown): void => set({ teams: Array.isArray(teams) ? (teams as TeamStatus[]) : [] })
export const openTeamDialog = (dialog: TeamDialog): void => set({ dialog })

export async function scanTeams(ctx: Pick<UiCtx, 'invoke'>, extra: string[] = []): Promise<TeamStatus[]> {
  const list = await ctx.invoke<TeamStatus[]>('feat:team-config:scan', extra)
  setTeams(list)
  return list
}

export const ACTION_LABEL: Record<PlanAction, string> = {
  new: 'Nueva',
  update: 'Se actualiza',
  same: 'Al día',
  renamed: 'Nueva (con otro nombre)'
}

export interface ImportOutcome {
  created: number
  updated: number
  errors: string[]
}

/**
 * Importa o actualiza las plantillas del equipo. Las guarda la función «templates» con su
 * propio canal (valida y las tiene en memoria); después main recuerda cuáles son del equipo.
 */
export async function importTeam(ctx: Pick<UiCtx, 'invoke'>, repoPath: string, plan?: ImportPlan): Promise<ImportOutcome> {
  const p = plan ?? (await ctx.invoke<ImportPlan>('feat:team-config:plan', repoPath))
  const mapping: Record<string, string> = {}
  const out: ImportOutcome = { created: 0, updated: 0, errors: [] }
  for (const it of p.items) {
    if (it.error) {
      out.errors.push(`${it.savedName}: ${it.error}`)
      continue
    }
    if (it.payload) {
      try {
        const t = await ctx.invoke<{ id: string }>('feat:templates:save', it.payload)
        mapping[it.key] = t.id
        if (it.action === 'update') out.updated++
        else out.created++
      } catch (e) {
        out.errors.push(`${it.savedName}: ${cleanMsg(e)}`)
      }
    } else if (it.id) mapping[it.key] = it.id
  }
  setTeams(await ctx.invoke('feat:team-config:markImported', repoPath, p.hash, mapping))
  return out
}

/** Aplica los ajustes recomendados con la función «settings» (solo si el usuario acepta). */
export async function applyTeamSettings(ctx: Pick<UiCtx, 'invoke'>, repoPath: string, a: TeamSettings): Promise<void> {
  const patch: Record<string, unknown> = {}
  if (a.densidad) patch.density = a.densidad
  if (a.tamañoTerminal) patch.terminal = { fontSize: a.tamañoTerminal }
  if (Object.keys(patch).length) await ctx.invoke('feat:settings:set', patch)
  setTeams(await ctx.invoke('feat:team-config:settingsDone', repoPath))
}

export const settingsText = (a?: TeamSettings): string =>
  [a?.densidad ? `densidad ${a.densidad}` : '', a?.tamañoTerminal ? `terminal ${a.tamañoTerminal} px` : ''].filter(Boolean).join(' · ')

export const cleanMsg = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export const repoName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p
