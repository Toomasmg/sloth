import { app, dialog, type SaveDialogOptions } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { Feature, FeatureContext } from './context'
import { currentSettings } from './settings'
import {
  listRecentSessions,
  listSessions,
  MAX_RESULTS,
  parseHistoryPrefs,
  parseTranscript,
  searchSessions,
  sessionMarkdown,
  SESSION_KEY_RE,
  SESSION_RANGE_DAYS,
  setPref,
  UUID_RE,
  type HistoryItem,
  type HistoryPrefs,
  type ParsedSession,
  type SearchControl,
  type SessionFile,
  type SessionInfo,
  type SessionRow
} from './history-core'

/**
 * Función «history» (lado main): historial de conversaciones de Claude de cada cuenta, leído de sus
 * transcripts (projects/<carpeta>/<uuid>.jsonl). Sloth NUNCA borra ni modifica esos archivos: «quitar
 * de la lista» solo marca la conversación como oculta en userData/features/history.json.
 *
 * Canales: list, detail, pin(key, on), hide(key, on), export(accountId, sessionId), open(...),
 * search(searchId, query, opts) y cancel(searchId).
 */

const projectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')
const samePath = (a: string, b: string): boolean =>
  resolve(a).replace(/[\\/]+$/, '').toLowerCase() === resolve(b).replace(/[\\/]+$/, '').toLowerCase()

const prefsFile = (): string => join(app.getPath('userData'), 'features', 'history.json')

function readPrefs(): HistoryPrefs {
  try {
    return parseHistoryPrefs(JSON.parse(readFileSync(prefsFile(), 'utf8').replace(/^﻿/, '')))
  } catch {
    return { pinned: [], hidden: [] }
  }
}

function writePrefs(p: HistoryPrefs): void {
  const path = prefsFile()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(p, null, 2), 'utf8')
  renameSync(tmp, path)
}

export interface OpenResult {
  wsId?: string
  created?: boolean
  /** Hay que confirmar: ese espacio tiene una terminal abierta que se va a cerrar. */
  needsConfirm?: boolean
  wsName?: string
  /** El espacio no arranca Claude solo: correr esto a mano. */
  manualCommand?: string
}

interface CacheEntry {
  mtimeMs: number
  size: number
  parsed: ParsedSession
}

function register(ctx: FeatureContext): void {
  const searches = new Map<string, SearchControl>()
  const pendingResume = new Map<string, { sessionId: string; accountId: string }>()
  // Resumen de cada transcript ya leído (se invalida si cambia su tamaño o fecha).
  const cache = new Map<string, CacheEntry>()

  ctx.addClaudeCommandOverride((ws, acc) => {
    const p = pendingResume.get(ws.id)
    if (!p || p.accountId !== acc.id) return undefined
    pendingResume.delete(ws.id)
    return UUID_RE.test(p.sessionId) ? `claude --resume ${p.sessionId}` : undefined
  })

  const accountsForScan = (): { id: string; label: string; configDir: string }[] =>
    ctx.store.accounts.map((a) => ({ id: a.id, label: a.label, configDir: a.configDir }))

  /** Fila de la lista: agrega el espacio de Sloth que usa esa carpeta. */
  const rowOf = (f: SessionFile, p: ParsedSession): SessionRow | null => {
    if (!p.cwd) return null
    const cwd = p.cwd
    const ws = ctx.store.workspaces.find((w) => w.accountId === f.account.id && (samePath(w.cwd, cwd) || samePath(w.repoPath, cwd)))
    return {
      key: `${f.account.id}:${f.sessionId}`,
      accountId: f.account.id,
      accountLabel: f.account.label,
      sessionId: f.sessionId,
      cwd,
      spaceId: ws?.id ?? null,
      spaceKey: ws ? ws.id : `cwd:${cwd.toLowerCase()}`,
      spaceName: ws?.name ?? (basename(cwd) || cwd),
      branch: p.branch || ws?.branch || '',
      title: p.title,
      start: p.start || f.mtimeMs,
      end: p.end || f.mtimeMs,
      messages: p.messages,
      tools: p.tools,
      files: p.files,
      status: p.status
    }
  }

  const findFile = async (accountId: string, sessionId: string): Promise<SessionFile> => {
    const acc = ctx.store.account(accountId)
    if (!acc) throw new Error('Esa cuenta ya no existe en Sloth.')
    const files = await listSessions([{ id: acc.id, label: acc.label, configDir: acc.configDir }])
    const f = files.find((x) => x.sessionId === sessionId)
    if (!f) throw new Error('No encontré esa conversación en la carpeta de la cuenta.')
    return f
  }

  const checkIds = (accountId: unknown, sessionId: unknown): { accountId: string; sessionId: string } => {
    if (typeof accountId !== 'string' || typeof sessionId !== 'string') throw new Error('Datos inválidos.')
    if (!UUID_RE.test(sessionId)) throw new Error('Id de conversación inválido.')
    return { accountId, sessionId }
  }

  ctx.handle('list', async () => {
    // Modo liviano: solo la última semana (la lista es lo que más se lee del disco).
    const days = currentSettings().lightMode ? 7 : SESSION_RANGE_DAYS
    const since = Date.now() - days * 86_400_000
    const files = await listRecentSessions(accountsForScan(), since)
    const seen = new Set<string>()
    const rows: SessionRow[] = []
    for (const f of files) {
      seen.add(f.file)
      let entry = cache.get(f.file)
      if (!entry || entry.mtimeMs !== f.mtimeMs || entry.size !== f.size) {
        try {
          entry = { mtimeMs: f.mtimeMs, size: f.size, parsed: await parseTranscript(f.file) }
          cache.set(f.file, entry)
        } catch {
          continue
        }
      }
      const row = rowOf(f, entry.parsed)
      if (row) rows.push(row)
    }
    for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k)
    rows.sort((a, b) => b.start - a.start)
    return { sessions: rows, ...readPrefs() }
  })

  ctx.handle('detail', async (accountId: unknown, sessionId: unknown): Promise<SessionInfo> => {
    const ids = checkIds(accountId, sessionId)
    const f = await findFile(ids.accountId, ids.sessionId)
    const parsed = await parseTranscript(f.file, true)
    const row = rowOf(f, parsed)
    if (!row) throw new Error('La conversación no tiene carpeta registrada.')
    return { ...row, lastAnswer: parsed.lastAnswer, items: parsed.items }
  })

  const setFlag = (which: 'pinned' | 'hidden') => (key: unknown, on: unknown) => {
    if (typeof key !== 'string' || !SESSION_KEY_RE.test(key) || typeof on !== 'boolean') throw new Error('Datos inválidos.')
    const next = setPref(readPrefs(), which, key, on)
    if (!next) throw new Error('Datos inválidos.')
    writePrefs(next)
    return next
  }
  ctx.handle('pin', setFlag('pinned'))
  ctx.handle('hide', setFlag('hidden'))

  ctx.handle('export', async (accountId: unknown, sessionId: unknown) => {
    const ids = checkIds(accountId, sessionId)
    const f = await findFile(ids.accountId, ids.sessionId)
    const parsed = await parseTranscript(f.file, true)
    const row = rowOf(f, parsed)
    if (!row) throw new Error('La conversación no tiene carpeta registrada.')
    const info: SessionInfo = { ...row, lastAnswer: parsed.lastAnswer, items: parsed.items }
    const win = ctx.window()
    const day = new Date(info.start).toLocaleDateString('sv-SE')
    const name = info.title.replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'conversacion'
    const opts: SaveDialogOptions = {
      title: 'Exportar conversación como Markdown',
      defaultPath: join(app.getPath('documents'), `${day} ${name}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    writeFileSync(r.filePath, sessionMarkdown(info, row.spaceName), 'utf8')
    ctx.log(`historial: conversación exportada a ${r.filePath}`)
    return { file: basename(r.filePath) }
  })

  // Búsqueda de texto dentro de las conversaciones (Ctrl+Shift+F y el campo de búsqueda).
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
      const files = await listSessions(accountsForScan())
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
}

const feature: Feature = {
  name: 'history',
  register,
  dispose() {}
}

export default feature
