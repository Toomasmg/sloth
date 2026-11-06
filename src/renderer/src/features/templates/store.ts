import { useSyncExternalStore } from 'react'
import type { UiCtx } from '../host'
import { cleanError } from '../../format'

/** Lo mismo que guarda main (templates-core.ts). */
export interface TemplateDto {
  id: string
  name: string
  repoPath: string
  accountId: string
  namePattern?: string
  initialPrompt?: string
  useWorktree?: { branchPattern: string }
  autoStartClaude: boolean
  resume: boolean
  counter: number
}

export type Draft = Partial<Omit<TemplateDto, 'counter'>>

export const SUGGESTED = 'sugerida'
export const TICKET_RE = /^[A-Z][A-Z0-9]*-\d+$/

export const usesTicket = (t: Draft): boolean =>
  [t.namePattern, t.initialPrompt, t.useWorktree?.branchPattern].some((s) => Boolean(s && /\{ticket(min)?\}/.test(s)))

export type Dialog = null | { kind: 'edit'; draft: Draft } | { kind: 'ticket'; template: TemplateDto }

interface State {
  list: TemplateDto[]
  loaded: boolean
  dialog: Dialog
  busy: string | null
}

let state: State = { list: [], loaded: false, dialog: null, busy: null }
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
export const setTemplates = (list: TemplateDto[]): void => set({ list: Array.isArray(list) ? list : [], loaded: true })
export const openDialog = (dialog: Dialog): void => set({ dialog })

export async function createFrom(ctx: Pick<UiCtx, 'invoke' | 'notifyError'>, t: TemplateDto, ticket?: string): Promise<boolean> {
  if (usesTicket(t) && !ticket) {
    openDialog({ kind: 'ticket', template: t })
    return false
  }
  if (state.busy) return false
  set({ busy: t.id })
  try {
    await ctx.invoke('feat:templates:create', t.id, ticket ? { ticket } : {})
    return true
  } catch (e) {
    ctx.notifyError(cleanError(e))
    return false
  } finally {
    set({ busy: null })
  }
}
