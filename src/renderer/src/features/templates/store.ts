import { useSyncExternalStore } from 'react'
import type { UiCtx } from '../host'
import { cleanError } from '../../format'
import { SUGGESTED, varsIn } from '../../../../shared/templates-shared'

/** Lo mismo que guarda main (templates-core.ts). `team` lo calcula main (lo importó team-config). */
export interface TemplateDto {
  id: string
  name: string
  description?: string
  icon?: string
  color?: string
  repoPath?: string
  accountId: string
  namePattern?: string
  initialPrompt?: string
  useWorktree?: { branchPattern: string }
  autoStartClaude: boolean
  resume: boolean
  counter: number
  team: boolean
}

export interface TemplatesView {
  list: TemplateDto[]
  defaultId: string | null
}

export { SUGGESTED }
export const TICKET_RE = /^[A-Z][A-Z0-9]*-\d+$/

/** Usa {ticket} o {ticketmin} en el nombre, el primer mensaje o la rama. */
export const usesTicket = (t: Partial<Pick<TemplateDto, 'namePattern' | 'initialPrompt' | 'useWorktree'>>): boolean =>
  [t.namePattern, t.initialPrompt, t.useWorktree?.branchPattern].some((s) => varsIn(s).some((v) => v === 'ticket' || v === 'ticketmin'))

export type Dialog = null | { kind: 'manage'; id?: string }

interface State {
  list: TemplateDto[]
  defaultId: string | null
  loaded: boolean
  dialog: Dialog
  busy: string | null
  /** Plantilla que el próximo «Nuevo espacio» debe traer seleccionada (una sola vez). */
  preselect: string | null
}

let state: State = { list: [], defaultId: null, loaded: false, dialog: null, busy: null, preselect: null }
const subs = new Set<() => void>()
const set = (patch: Partial<State>): void => {
  state = { ...state, ...patch }
  subs.forEach((f) => f())
}
const subscribe = (cb: () => void): (() => void) => {
  subs.add(cb)
  return () => subs.delete(cb)
}

export const useTemplates = (): State => useSyncExternalStore(subscribe, () => state)
export const getTemplates = (): TemplateDto[] => state.list
export const getDefaultId = (): string | null => state.defaultId
export const setView = (v: TemplatesView): void =>
  set({ list: Array.isArray(v?.list) ? v.list : [], defaultId: v?.defaultId ?? null, loaded: true })
export const openDialog = (dialog: Dialog): void => set({ dialog })
export const setPreselect = (id: string | null): void => set({ preselect: id })
/** Lee la preselección sin consumirla. */
export const peekPreselect = (): string | null => state.preselect
/** Lee y limpia la preselección (el diálogo la consume al abrir). */
export function takePreselect(): string | null {
  const id = state.preselect
  if (id !== null) set({ preselect: null })
  return id
}

/** Carga la lista y el predeterminado desde main. */
export async function loadTemplates(ctx: Pick<UiCtx, 'invoke'>): Promise<void> {
  try {
    setView(await ctx.invoke<TemplatesView>('feat:templates:list'))
  } catch {
    /* sin datos: la lista queda vacía */
  }
}

/**
 * Crea un espacio desde una plantilla de la barra lateral. Si necesita ticket o no tiene carpeta,
 * abre Nuevo espacio con la plantilla elegida.
 */
export async function createFrom(ctx: Pick<UiCtx, 'invoke' | 'notifyError' | 'openNewWorkspace'>, t: TemplateDto): Promise<boolean> {
  if (usesTicket(t) || !t.repoPath) {
    setPreselect(t.id)
    ctx.openNewWorkspace('normal')
    return false
  }
  if (state.busy) return false
  set({ busy: t.id })
  try {
    await ctx.invoke('feat:templates:create', t.id, {})
    return true
  } catch (e) {
    ctx.notifyError(cleanError(e))
    return false
  } finally {
    set({ busy: null })
  }
}
