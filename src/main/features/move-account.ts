import { existsSync } from 'node:fs'
import type { Feature, FeatureContext } from './context'
import { accountStatus } from '../accounts'
import { changeCount } from './git-ops'
import { buildSummary, sanitizeSummary } from './move-account-core'

/**
 * «Mover espacio a otra cuenta». Es siempre manual: Sloth no cambia de cuenta sola ni detecta límites.
 * La conversación no se pasa; si el usuario deja un resumen, se escribe en la terminal nueva cuando
 * Claude arranca (evento real SessionStart del hook).
 */

export interface MoveResult {
  ok: true
  /** Se le dejó un resumen a Claude. */
  summary: boolean
}

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

  ctx.handle('move', async (wsId: unknown, targetAccountId: unknown, summary: unknown): Promise<MoveResult> => {
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
      return await move(ctx, ws.id, to.id, text)
    } finally {
      moving.delete(ws.id)
    }
  })
}

async function move(ctx: FeatureContext, wsId: string, toId: string, text: string | null): Promise<MoveResult> {
  const ws = ctx.store.workspace(wsId)
  const to = ctx.store.account(toId)
  if (!ws || !to) throw new Error('Ese espacio o esa cuenta ya no existe.')
  const from = ctx.store.account(ws.accountId)
  // Primero se cierra la terminal: Claude no sigue escribiendo mientras cambia la cuenta.
  await (await ctx.backend()).kill(ws.id)

  ctx.store.updateWorkspace(ws.id, { accountId: to.id })
  if (text) pending.set(ws.id, { text, until: Date.now() + SUMMARY_WAIT_MS })
  else pending.delete(ws.id)

  ctx.prepareAccount(to)
  ctx.ui({ type: 'reload' })
  await ctx.restartTerminal(ws.id)
  ctx.log(`«${ws.name}» pasó de ${from?.label ?? '?'} a ${to.label}${text ? ' (con resumen)' : ''}`)
  return { ok: true, summary: Boolean(text) }
}

const feature: Feature = {
  name: 'move-account',
  register
}

export default feature
