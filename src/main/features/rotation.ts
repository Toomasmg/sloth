import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Feature, FeatureContext } from './context'
import type { Workspace } from '../../shared/types'
import {
  copySession,
  latestSession,
  limitAtEnd,
  parsePtyLimit,
  projectSlug,
  stripAnsiPty,
  UUID_RE,
  type LimitInfo
} from './rotation-core'

/** Lo que ve la UI: el espacio `wsId` llegó al límite con la cuenta `accountId`. */
export interface LimitState extends LimitInfo {
  wsId: string
  accountId: string
  at: number
  source: 'transcript' | 'terminal'
}

export interface MoveResult {
  sessionId?: string
  /** El espacio no arranca Claude solo: hay que correr esto a mano. */
  manualCommand?: string
  backup?: string
}

/** Cola de salida por terminal: alcanza para el aviso aunque llegue partido en varios trozos. */
const RAW_TAIL = 300
const HOT_CHARS = 600
const HOT_CHUNKS = 8
/** Después de un aviso por terminal, no volver a mirar esa terminal por un rato (Claude redibuja). */
const PTY_QUIET_MS = 2 * 60 * 1000

function register(ctx: FeatureContext): void {
  const limits = new Map<string, LimitState>()
  const tails = new Map<string, { raw: string; hot: string | null; left: number }>()
  const quietUntil = new Map<string, number>()
  const checking = new Set<string>()
  /** Arranque de una vez con `claude --resume <id>` (wsId → sesión y cuenta destino). */
  const pendingResume = new Map<string, { sessionId: string; accountId: string }>()

  ctx.addClaudeCommandOverride((ws, acc) => {
    const p = pendingResume.get(ws.id)
    if (!p || p.accountId !== acc.id) return undefined
    pendingResume.delete(ws.id)
    return UUID_RE.test(p.sessionId) ? `claude --resume ${p.sessionId}` : undefined
  })

  const projectDirFor = (ws: Workspace): string | undefined => {
    const acc = ctx.store.account(ws.accountId)
    return acc ? join(acc.configDir, 'projects', projectSlug(ws.cwd)) : undefined
  }

  function setLimit(ws: Workspace, info: LimitInfo, source: LimitState['source']): void {
    const prev = limits.get(ws.id)
    if (prev && prev.accountId === ws.accountId && prev.text === info.text && prev.resetsAt === info.resetsAt) return
    if (info.resetsAt && info.resetsAt < Date.now()) return
    const st: LimitState = { ...info, wsId: ws.id, accountId: ws.accountId, at: Date.now(), source }
    limits.set(ws.id, st)
    ctx.emit('limit', st)
  }

  function clearLimit(wsId: string): void {
    if (limits.delete(wsId)) ctx.emit('clear', wsId)
  }

  /** Mira la cola del transcript más nuevo de ese espacio (cuenta + carpeta). */
  async function checkTranscript(wsId: string): Promise<'limit' | 'ok' | 'none'> {
    const ws = ctx.store.workspace(wsId)
    const dir = ws && projectDirFor(ws)
    if (!ws || !dir) return 'none'
    const s = await latestSession(dir)
    if (!s) return 'none'
    const info = await limitAtEnd(s.file)
    if (info) {
      setLimit(ws, info, 'transcript')
      return 'limit'
    }
    return 'ok'
  }

  // (a) Hooks: al terminar un turno o al avisar algo, mirar si lo último fue el límite.
  ctx.onHook((p) => {
    if (p.event !== 'Stop' && p.event !== 'Notification') return
    if (!ctx.store.workspace(p.ws) || checking.has(p.ws)) return
    checking.add(p.ws)
    void checkTranscript(p.ws)
      .then((r) => {
        // Una respuesta normal después del límite: ya se renovó (o se cambió de plan).
        if (r === 'ok' && p.event === 'Stop') {
          const l = limits.get(p.ws)
          if (l && l.source === 'transcript') clearLimit(p.ws)
        }
      })
      .finally(() => checking.delete(p.ws))
  })

  // (b) Salida de la terminal: cola cruda chica por terminal; solo se limpia de ANSI y se analiza
  // cuando aparece «limit», y por unos pocos trozos más (el resto del aviso puede venir después).
  ctx.onPtyData((id, chunks) => {
    if ((quietUntil.get(id) ?? 0) > Date.now()) return
    let data = ''
    for (const c of chunks) data += c.data
    const t = tails.get(id) ?? { raw: '', hot: null, left: 0 }
    const combined = t.raw + data
    t.raw = combined.slice(-RAW_TAIL)
    if (t.hot === null) {
      if (!/limit/i.test(combined)) {
        tails.set(id, t)
        return
      }
      t.hot = stripAnsiPty(combined).slice(-HOT_CHARS)
      t.left = HOT_CHUNKS
    } else {
      t.hot = (t.hot + stripAnsiPty(data)).slice(-HOT_CHARS)
      t.left--
    }
    const info = parsePtyLimit(t.hot)
    if (!info) {
      if (t.left <= 0) {
        // Era otra cosa («limit» suelto): se descarta la cola para no volver a analizarla.
        t.hot = null
        t.raw = ''
      }
      tails.set(id, t)
      return
    }
    tails.delete(id)
    const ws = ctx.store.workspace(id)
    if (!ws) return
    quietUntil.set(id, Date.now() + PTY_QUIET_MS)
    // Confirmar con el transcript (trae la hora exacta); si todavía no está escrito, reintentar una vez.
    // Es un único temporizador por aviso, no un polling.
    void checkTranscript(id).then(async (r) => {
      if (r === 'limit') return
      await new Promise((res) => setTimeout(res, 2500))
      const r2 = await checkTranscript(id)
      // Conservador: si hay transcript y no termina en el aviso, era texto que pasó por la terminal.
      if (r2 === 'none') setLimit(ws, info, 'terminal')
    })
  })

  ctx.onPtyExit((id) => {
    tails.delete(id)
    quietUntil.delete(id)
  })

  ctx.handle('list', () => [...limits.values()].filter((l) => ctx.store.workspace(l.wsId)?.accountId === l.accountId))

  ctx.handle('dismiss', (wsId: unknown) => {
    if (typeof wsId === 'string') clearLimit(wsId)
  })

  /** ¿Tiene conversación para llevarse? (para el texto de confirmación). */
  ctx.handle('peek', async (wsId: unknown) => {
    if (typeof wsId !== 'string' || wsId.length > 100) throw new Error('Espacio inválido.')
    const ws = ctx.store.workspace(wsId)
    if (!ws) throw new Error('Ese espacio ya no existe.')
    const dir = projectDirFor(ws)
    const s = dir ? await latestSession(dir) : undefined
    return { sessionId: s?.sessionId, autoStartClaude: ws.autoStartClaude }
  })

  ctx.handle('move', async (args: unknown): Promise<MoveResult> => {
    const a = (args ?? {}) as { wsId?: unknown; toAccountId?: unknown }
    if (typeof a.wsId !== 'string' || typeof a.toAccountId !== 'string' || a.wsId.length > 100 || a.toAccountId.length > 100)
      throw new Error('Datos inválidos.')
    const ws = ctx.store.workspace(a.wsId)
    if (!ws) throw new Error('Ese espacio ya no existe.')
    const from = ctx.store.account(ws.accountId)
    const to = ctx.store.account(a.toAccountId)
    if (!to) throw new Error('Esa cuenta ya no existe.')
    if (to.id === ws.accountId) throw new Error('El espacio ya usa esa cuenta.')
    if (!existsSync(to.configDir)) throw new Error(`Falta la carpeta de la cuenta «${to.label}».`)

    // Primero se cierra la terminal: así el transcript no cambia mientras se copia.
    await (await ctx.backend()).kill(ws.id)

    const result: MoveResult = {}
    const dir = from ? join(from.configDir, 'projects', projectSlug(ws.cwd)) : undefined
    const session = dir ? await latestSession(dir) : undefined
    if (from && session) {
      const rep = await copySession(from.configDir, to.configDir, ws.cwd, session.sessionId)
      result.sessionId = session.sessionId
      result.backup = rep.backup
    }

    ctx.store.updateWorkspace(ws.id, { accountId: to.id })
    if (result.sessionId) {
      if (ws.autoStartClaude) pendingResume.set(ws.id, { sessionId: result.sessionId, accountId: to.id })
      else result.manualCommand = `claude --resume ${result.sessionId}`
    }
    clearLimit(ws.id)
    tails.delete(ws.id)
    quietUntil.delete(ws.id)
    ctx.prepareAccount(to)
    ctx.ui({ type: 'reload' })
    await ctx.restartTerminal(ws.id)
    ctx.log(`«${ws.name}» pasó de ${from?.label ?? '?'} a ${to.label}${result.sessionId ? ` (retoma ${result.sessionId})` : ''}`)
    return result
  })
}

const feature: Feature = {
  name: 'rotation',
  register
}

export default feature
