import { existsSync } from 'node:fs'
import type { Feature, FeatureContext } from './context'
import { accountStatus } from '../accounts'
import { changeCount } from './git-ops'
import { buildSummary, copyConversation, latestSession, projectDirOf, sanitizeSummary, UUID_RE } from './move-account-core'

/**
 * «Mover espacio a otra cuenta». Es siempre manual: Sloth no cambia de cuenta sola ni detecta límites.
 * La conversación de Claude se copia a la carpeta de la cuenta destino y la terminal arranca con
 * `claude --resume <id>`, así Claude sigue donde estaba. Los archivos del proyecto no se tocan.
 * El resumen es opcional: si se deja, se escribe en la terminal nueva cuando Claude arranca.
 */

export type MoveResult =
  | {
      ok: true
      /** La terminal retoma la conversación copiada. */
      resumed: boolean
      /** Se le dejó un resumen a Claude. */
      summary: boolean
    }
  | {
      ok: false
      /** No se pudo copiar la conversación: el espacio sigue con la cuenta anterior. Se puede reintentar sin conversación. */
      copyFailed: true
      message: string
    }

/** Arranque único con `claude --resume <id>` (wsId → conversación y cuenta destino). */
const pendingResume = new Map<string, { sessionId: string; accountId: string }>()
/** Resumen pendiente por espacio: se escribe en el primer SessionStart, si llega a tiempo. */
const pending = new Map<string, { text: string; until: number }>()
/** Espacios que se están moviendo ahora. */
const moving = new Set<string>()

const SUMMARY_WAIT_MS = 10 * 60 * 1000
/** Pegado entre corchetes: Claude Code recibe el texto de varias líneas sin enviarlo a mitad. */
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 100

function register(ctx: FeatureContext): void {
  // Solo aplica con la cuenta destino y se consume al primer uso.
  ctx.addClaudeCommandOverride((ws, acc) => {
    const p = pendingResume.get(ws.id)
    if (!p || p.accountId !== acc.id) return undefined
    pendingResume.delete(ws.id)
    return UUID_RE.test(p.sessionId) ? `claude --resume ${p.sessionId}` : undefined
  })

  // Cuando Claude arranca en el espacio con un resumen pendiente, lo escribe en su terminal.
  ctx.onHook((p) => {
    if (p.event !== 'SessionStart') return
    const s = pending.get(p.ws)
    if (!s) return
    pending.delete(p.ws)
    if (Date.now() > s.until) return
    setTimeout(() => {
      void ctx.backend().then((b) => {
        b.write(p.ws, PASTE_START + s.text + PASTE_END)
        // Enter aparte, después de que el pegado llegó.
        setTimeout(() => b.write(p.ws, '\r'), 300)
      })
    }, 1500)
  })

  /** Texto inicial del resumen, armado con datos reales del espacio (la persona lo edita). */
  ctx.handle('summary', async (wsId: unknown) => {
    if (!isId(wsId)) throw new Error('Espacio inválido.')
    const ws = ctx.store.workspace(wsId)
    if (!ws) throw new Error('Ese espacio ya no existe.')
    const changes = (await changeCount(ws.cwd)) ?? -1
    return { text: buildSummary({ name: ws.name, cwd: ws.cwd, branch: ws.branch ?? null, changes }) }
  })

  /** ¿El espacio tiene una conversación en su cuenta actual? Solo mira nombres de archivo. */
  ctx.handle('peek', async (wsId: unknown) => {
    if (!isId(wsId)) throw new Error('Espacio inválido.')
    const ws = ctx.store.workspace(wsId)
    if (!ws) throw new Error('Ese espacio ya no existe.')
    const acc = ctx.store.account(ws.accountId)
    const session = acc ? await latestSession(projectDirOf(acc.configDir, ws.cwd)) : undefined
    return { hasConversation: session !== undefined }
  })

  /**
   * `keepConversation: false` = seguir sin copiar la conversación (arranca de cero, con el resumen si hay).
   * Se usa tras un fallo de copia que la persona eligió ignorar.
   */
  ctx.handle('move', async (wsId: unknown, targetAccountId: unknown, summary: unknown, keepConversation: unknown): Promise<MoveResult> => {
    if (!isId(wsId) || !isId(targetAccountId)) throw new Error('Datos inválidos.')
    const text = summary === null || summary === undefined ? null : sanitizeSummary(summary)
    const ws = ctx.store.workspace(wsId)
    if (!ws) throw new Error('Ese espacio ya no existe.')
    const to = ctx.store.account(targetAccountId)
    if (!to) throw new Error('Esa cuenta ya no existe.')
    if (to.id === ws.accountId) throw new Error('El espacio ya usa esa cuenta.')
    if (!existsSync(to.configDir)) throw new Error(`Falta la carpeta de la cuenta «${to.label}».`)
    if (!accountStatus(to).loggedIn) throw new Error(`La cuenta «${to.label}» no tiene sesión iniciada.`)
    if (moving.has(ws.id)) throw new Error('Ese espacio ya se está moviendo.')
    // Guarda real: no se corta a Claude mientras trabaja o espera una respuesta.
    const st = ctx.agents().get(ws.id)?.state
    if (st === 'working' || st === 'waiting') throw new Error('Claude está trabajando. Esperá a que termine o movelo cuando esté libre.')
    moving.add(ws.id)
    try {
      return await move(ctx, ws.id, to.id, text, keepConversation !== false)
    } finally {
      moving.delete(ws.id)
    }
  })
}

async function move(ctx: FeatureContext, wsId: string, toId: string, text: string | null, keepConversation: boolean): Promise<MoveResult> {
  const ws = ctx.store.workspace(wsId)
  const to = ctx.store.account(toId)
  if (!ws || !to) throw new Error('Ese espacio o esa cuenta ya no existe.')
  const from = ctx.store.account(ws.accountId)
  // Primero se cierra la terminal: así la conversación no cambia mientras se copia.
  await (await ctx.backend()).kill(ws.id)

  let sessionId: string | undefined
  if (keepConversation && from) {
    try {
      const session = await latestSession(projectDirOf(from.configDir, ws.cwd))
      if (session) {
        await copyConversation(from.configDir, to.configDir, ws.cwd, session.sessionId)
        sessionId = session.sessionId
      }
    } catch (e) {
      ctx.log(`no se pudo copiar la conversación de «${ws.name}»:`, e)
      // La cuenta no cambió: se vuelve a abrir la terminal como estaba.
      await ctx.restartTerminal(ws.id)
      return {
        ok: false,
        copyFailed: true,
        message: 'No se pudo copiar la conversación a la otra cuenta. El espacio sigue con la cuenta anterior.'
      }
    }
  }

  ctx.store.updateWorkspace(ws.id, { accountId: to.id })
  // Solo se retoma sola si el espacio arranca Claude al abrirse (respeta «Arrancar Claude»).
  const resumed = Boolean(sessionId && ws.autoStartClaude)
  if (sessionId && resumed) pendingResume.set(ws.id, { sessionId, accountId: to.id })
  else pendingResume.delete(ws.id)
  if (text) pending.set(ws.id, { text, until: Date.now() + SUMMARY_WAIT_MS })
  else pending.delete(ws.id)

  ctx.prepareAccount(to)
  ctx.ui({ type: 'reload' })
  await ctx.restartTerminal(ws.id)
  ctx.log(`«${ws.name}» pasó de ${from?.label ?? '?'} a ${to.label}${resumed ? ` (retoma ${sessionId})` : ''}${text ? ' (con resumen)' : ''}`)
  return { ok: true, resumed, summary: Boolean(text) }
}

const feature: Feature = {
  name: 'move-account',
  register
}

export default feature
