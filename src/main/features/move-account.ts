import { existsSync } from 'node:fs'
import type { Feature, FeatureContext } from './context'
import type { Account, Workspace } from '../../shared/types'
import { accountStatus } from '../accounts'
import { copyConversation, latestSession, projectDirOf, UUID_RE } from './move-account-core'

/** Lo que devuelve «move»: si la conversación se va a retomar sola al abrir la terminal. */
export interface MoveResult {
  ok: true
  resumed: boolean
}

/** Arranque único con `claude --resume <id>` (wsId → conversación y cuenta destino). */
const pendingResume = new Map<string, { sessionId: string; accountId: string }>()
/** Espacios que se están moviendo ahora (evita dos movimientos a la vez del mismo espacio). */
const moving = new Set<string>()

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 100

function register(ctx: FeatureContext): void {
  // Se registra una sola vez. Solo aplica con la cuenta destino y se consume al primer uso.
  ctx.addClaudeCommandOverride((ws, acc) => {
    const p = pendingResume.get(ws.id)
    if (!p || p.accountId !== acc.id) return undefined
    pendingResume.delete(ws.id)
    return UUID_RE.test(p.sessionId) ? `claude --resume ${p.sessionId}` : undefined
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

  ctx.handle('move', async (wsId: unknown, targetAccountId: unknown): Promise<MoveResult> => {
    if (!isId(wsId) || !isId(targetAccountId)) throw new Error('Datos inválidos.')
    const ws = ctx.store.workspace(wsId)
    if (!ws) throw new Error('Ese espacio ya no existe.')
    const to = ctx.store.account(targetAccountId)
    if (!to) throw new Error('Esa cuenta ya no existe.')
    if (to.id === ws.accountId) throw new Error('El espacio ya usa esa cuenta.')
    if (!existsSync(to.configDir)) throw new Error(`Falta la carpeta de la cuenta «${to.label}».`)
    if (!accountStatus(to).loggedIn) throw new Error(`La cuenta «${to.label}» no tiene sesión iniciada.`)
    if (moving.has(ws.id)) throw new Error('Ese espacio ya se está moviendo.')
    moving.add(ws.id)
    try {
      return await move(ctx, ws, to)
    } finally {
      moving.delete(ws.id)
    }
  })
}

async function move(ctx: FeatureContext, ws: Workspace, to: Account): Promise<MoveResult> {
  const from = ctx.store.account(ws.accountId)
  // Primero se cierra la terminal: así la conversación no cambia mientras se copia.
  await (await ctx.backend()).kill(ws.id)

  let sessionId: string | undefined
  try {
    if (from) {
      const session = await latestSession(projectDirOf(from.configDir, ws.cwd))
      if (session) {
        await copyConversation(from.configDir, to.configDir, ws.cwd, session.sessionId)
        sessionId = session.sessionId
      }
    }
  } catch (e) {
    ctx.log(`no se pudo copiar la conversación de «${ws.name}»:`, e)
    // La cuenta no cambió: se vuelve a abrir la terminal como estaba.
    await ctx.restartTerminal(ws.id)
    throw new Error('No se pudo copiar la conversación a la otra cuenta. El espacio sigue con la cuenta anterior.')
  }

  ctx.store.updateWorkspace(ws.id, { accountId: to.id })
  // Solo se retoma sola si el espacio arranca Claude al abrirse (respeta «Arrancar Claude»).
  const resumed = Boolean(sessionId && ws.autoStartClaude)
  if (sessionId && resumed) pendingResume.set(ws.id, { sessionId, accountId: to.id })
  else pendingResume.delete(ws.id)

  ctx.prepareAccount(to)
  ctx.ui({ type: 'reload' })
  await ctx.restartTerminal(ws.id)
  ctx.log(`«${ws.name}» pasó de ${from?.label ?? '?'} a ${to.label}${resumed ? ` (retoma ${sessionId})` : ''}`)
  return { ok: true, resumed }
}

const feature: Feature = {
  name: 'move-account',
  register
}

export default feature
