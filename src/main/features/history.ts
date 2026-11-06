import { existsSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { Feature, FeatureContext } from './context'
import { listSessions, MAX_RESULTS, searchSessions, UUID_RE, type HistoryItem, type SearchControl } from './history-core'

const projectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')
const samePath = (a: string, b: string): boolean =>
  resolve(a).replace(/[\\/]+$/, '').toLowerCase() === resolve(b).replace(/[\\/]+$/, '').toLowerCase()

export interface OpenResult {
  wsId?: string
  created?: boolean
  /** Hay que confirmar: ese espacio tiene una terminal abierta que se va a cerrar. */
  needsConfirm?: boolean
  wsName?: string
  /** El espacio no arranca Claude solo: correr esto a mano. */
  manualCommand?: string
}

function register(ctx: FeatureContext): void {
  const searches = new Map<string, SearchControl>()
  const pendingResume = new Map<string, { sessionId: string; accountId: string }>()

  ctx.addClaudeCommandOverride((ws, acc) => {
    const p = pendingResume.get(ws.id)
    if (!p || p.accountId !== acc.id) return undefined
    pendingResume.delete(ws.id)
    return UUID_RE.test(p.sessionId) ? `claude --resume ${p.sessionId}` : undefined
  })

  ctx.handle('search', async (searchId: unknown, query: unknown, opts: unknown) => {
    if (typeof searchId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(searchId)) throw new Error('Búsqueda inválida.')
    if (typeof query !== 'string') throw new Error('Búsqueda inválida.')
    const q = query.trim()
    if (q.length < 2 || q.length > 200) throw new Error('Escribí entre 2 y 200 caracteres.')
    const o = (opts ?? {}) as { accountId?: unknown }
    const accountId = typeof o.accountId === 'string' && ctx.store.account(o.accountId) ? o.accountId : undefined
    // Una búsqueda a la vez: la nueva cancela las anteriores.
    for (const c of searches.values()) c.cancelled = true
    const ctl: SearchControl = { cancelled: false }
    searches.set(searchId, ctl)
    const t0 = Date.now()
    const all: HistoryItem[] = []
    try {
      const accounts = ctx.store.accounts
        .filter((a) => !accountId || a.id === accountId)
        .map((a) => ({ id: a.id, label: a.label, configDir: a.configDir }))
      const files = await listSessions(accounts)
      const stats = await searchSessions(
        files,
        q,
        ctl,
        (items) => {
          all.push(...items)
          ctx.emit('results', { searchId, items })
        },
        { accountId, max: MAX_RESULTS }
      )
      all.sort((a, b) => b.ts - a.ts)
      ctx.emit('done', { searchId, items: ctl.cancelled ? undefined : all, ...stats, ms: Date.now() - t0 })
      return { ok: true }
    } catch (e) {
      ctx.emit('done', { searchId, error: (e as Error).message, cancelled: ctl.cancelled, total: all.length })
      throw e
    } finally {
      searches.delete(searchId)
    }
  })

  ctx.handle('cancel', (searchId: unknown) => {
    if (typeof searchId !== 'string') return
    const c = searches.get(searchId)
    if (c) c.cancelled = true
  })

  ctx.handle('open', async (args: unknown): Promise<OpenResult> => {
    const a = (args ?? {}) as { accountId?: unknown; sessionId?: unknown; cwd?: unknown; confirmRestart?: unknown }
    if (typeof a.accountId !== 'string' || typeof a.sessionId !== 'string' || typeof a.cwd !== 'string')
      throw new Error('Datos inválidos.')
    if (!UUID_RE.test(a.sessionId)) throw new Error('Id de conversación inválido.')
    if (!a.cwd || a.cwd.length > 1000) throw new Error('Carpeta inválida.')
    const acc = ctx.store.account(a.accountId)
    if (!acc) throw new Error('Esa cuenta ya no existe en Sloth.')
    const cwd = a.cwd
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`La carpeta ${cwd} ya no existe: no se puede retomar ahí.`)
    // Claude busca la conversación en projects/<slug del cwd>: tiene que estar ahí.
    if (!existsSync(join(acc.configDir, 'projects', projectSlug(cwd), `${a.sessionId}.jsonl`)))
      throw new Error('No encontré esa conversación en la carpeta de la cuenta.')

    let ws = ctx.store.workspaces.find((w) => w.accountId === acc.id && samePath(w.cwd, cwd))
    let created = false
    if (ws) {
      const running = ctx.terminal()?.isRunning(ws.id) ?? false
      if (running && a.confirmRestart !== true) return { needsConfirm: true, wsId: ws.id, wsName: ws.name }
    } else {
      ws = await ctx.addWorkspace({
        name: basename(cwd) || cwd,
        repoPath: cwd,
        accountId: acc.id,
        autoStartClaude: true,
        resume: true
      })
      created = true
    }
    const result: OpenResult = { wsId: ws.id, created, wsName: ws.name }
    if (ws.autoStartClaude) pendingResume.set(ws.id, { sessionId: a.sessionId, accountId: acc.id })
    else result.manualCommand = `claude --resume ${a.sessionId}`
    if (!created) await ctx.restartTerminal(ws.id)
    ctx.ui({ type: 'open-pane', id: ws.id })
    return result
  })

  ctx.handle('accounts', () => ctx.store.accounts.map((a) => ({ id: a.id, label: a.label })))
}

const feature: Feature = {
  name: 'history',
  register,
  dispose() {}
}

export default feature
