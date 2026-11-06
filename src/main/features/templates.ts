import { app } from 'electron'
import { join } from 'node:path'
import type { Feature, FeatureContext } from './context'
import { accountStatus } from '../accounts'
import { buildInput, pickSuggested, SUGGESTED, TemplateFile, type Template } from './templates-core'
import type { UsageTotals } from '../../shared/types'

/**
 * Función «templates»: plantillas de espacio en userData/features/templates.json.
 * Ops: list, save(plantilla), remove(id), create(id, {ticket?}). Evento: changed(lista).
 */
let file: TemplateFile | undefined

const tot = (t?: UsageTotals): number => (t ? t.input + t.output + t.cacheWrite + t.cacheRead : 0)

async function resolveAccount(ctx: FeatureContext, t: Template): Promise<string> {
  const accounts = ctx.store.accounts
  if (t.accountId !== SUGGESTED) {
    if (!ctx.store.account(t.accountId)) throw new Error(`La cuenta de la plantilla «${t.name}» ya no existe. Editala y elegí otra.`)
    return t.accountId
  }
  if (!accounts.length) throw new Error('Agregá una cuenta primero.')
  let usage = ctx.usage.latest
  try {
    // Incremental y cacheado; si tarda, nos quedamos con lo último que se leyó.
    usage = await Promise.race([ctx.usage.scan(accounts), new Promise<typeof usage>((r) => setTimeout(() => r(ctx.usage.latest), 4000))])
  } catch {
    /* sin datos de uso: se elige entre las que tienen sesión */
  }
  const id = pickSuggested(
    accounts,
    (aid) => {
      const a = ctx.store.account(aid)
      return a ? accountStatus(a).loggedIn : false
    },
    (aid) => tot(usage[aid]?.last5h)
  )
  if (!id) throw new Error('No hay ninguna cuenta para usar.')
  return id
}

const feature: Feature = {
  name: 'templates',
  register(ctx) {
    file = new TemplateFile(join(app.getPath('userData'), 'features', 'templates.json'))
    const f = file
    const accountIds = (): Set<string> => new Set(ctx.store.accounts.map((a) => a.id))
    const changed = (): void => ctx.emit('changed', f.all())

    ctx.handle('list', () => f.all())

    ctx.handle('save', (raw: unknown) => {
      const t = f.save(raw, accountIds())
      changed()
      return t
    })

    ctx.handle('remove', (id: unknown) => {
      f.remove(id)
      changed()
    })

    let creating = false
    ctx.handle('create', async (id: unknown, vars: unknown) => {
      const t = f.get(id)
      if (!t) throw new Error('Esa plantilla ya no existe.')
      if (vars !== undefined && (vars === null || typeof vars !== 'object' || Array.isArray(vars))) throw new Error('Datos inválidos.')
      if (creating) throw new Error('Ya se está creando un espacio; esperá un momento.')
      creating = true
      try {
        const accountId = await resolveAccount(ctx, t)
        const { input, n } = buildInput(t, { ticket: (vars as { ticket?: unknown } | undefined)?.ticket as string | undefined }, accountId)
        const ws = await ctx.addWorkspace(input)
        f.setCounter(t.id, n)
        changed()
        ctx.ui({ type: 'open-pane', id: ws.id })
        return ws
      } finally {
        creating = false
      }
    })
  }
}

export default feature
