import { app, Notification, type BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Feature, FeatureContext } from './context'
import type { TerminalBackend, PendingPermission } from '../daemon-client'
import type { HookEventPayload } from '../hooks'
import { currentSettings } from './settings'
import {
  CHOICES,
  decisionFor,
  findRule,
  kindOf,
  labelOf,
  ruleFor,
  shouldNotify,
  type PermissionChoice,
  type PermissionKind,
  type PermissionRule
} from './permissions-core'

/**
 * Función «permissions» (lado main): pedidos de permiso de Claude, reglas «Permitir siempre» por
 * espacio, historial de decisiones de hoy y avisos de Windows. Todo es por eventos: sin timers.
 * Persiste en userData/features/permissions.json (escritura atómica).
 */

export interface DecisionEntry {
  id: string
  at: number
  workspaceId: string
  spaceName: string
  tool: string
  kind: PermissionKind
  label: string
  /** once: permitido una vez · always: regla guardada · rule: lo aplicó una regla · deny · terminal */
  tag: 'once' | 'always' | 'rule' | 'deny' | 'terminal'
  ruleId?: string
  undone?: boolean
}

interface State {
  rules: PermissionRule[]
  history: DecisionEntry[]
}

const MAX_HISTORY = 300
const MAX_RULES = 200
const MAX_MESSAGE = 1000

const file = (): string => join(app.getPath('userData'), 'features', 'permissions.json')

function writeAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, path)
}

/** Lectura tolerante: lo que no se entiende se descarta (nunca tira). */
function load(): State {
  const empty: State = { rules: [], history: [] }
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8').replace(/^﻿/, '')) as Partial<State>
    const rules = Array.isArray(raw.rules)
      ? raw.rules.filter((r): r is PermissionRule => !!r && typeof r.id === 'string' && typeof r.workspaceId === 'string').slice(0, MAX_RULES)
      : []
    const history = Array.isArray(raw.history)
      ? raw.history.filter((h): h is DecisionEntry => !!h && typeof h.id === 'string' && typeof h.at === 'number').slice(0, MAX_HISTORY)
      : []
    return { rules, history }
  } catch {
    return empty
  }
}

const startOfToday = (): number => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const feature: Feature = {
  name: 'permissions',
  register(ctx: FeatureContext) {
    let state = load()
    let focusedSpace: string | null = null

    const save = (): void => {
      try {
        writeAtomic(file(), state)
      } catch (e) {
        ctx.log('no se pudo guardar:', (e as Error).message)
      }
      ctx.emit('changed')
    }

    /** Única fuente de «No molestar»: la Configuración (settings.noMolestar). */
    const isDnd = (): boolean => currentSettings().noMolestar

    const spaceName = (wsId: string): string => ctx.store.workspace(wsId)?.name ?? 'Espacio borrado'

    const remember = (e: Omit<DecisionEntry, 'id' | 'at'>): DecisionEntry => {
      const entry: DecisionEntry = { id: randomUUID(), at: Date.now(), ...e }
      state.history = [entry, ...state.history].slice(0, MAX_HISTORY)
      return entry
    }

    /** Responde un pedido que sigue pendiente. Lanza si ya no lo está (venció o se respondió en la terminal). */
    function answer(b: TerminalBackend, id: string, choice: PermissionChoice, message?: string): void {
      const req = b.pendingPermissions().find((r) => r.id === id)
      if (!req) throw new Error('Ese permiso ya no está pendiente (venció o se respondió en la terminal).')
      const kind = kindOf(req.tool)
      const label = labelOf(kind, req.tool, req.input)
      const base = { workspaceId: req.ws, spaceName: spaceName(req.ws), tool: req.tool, kind, label }
      if (choice === 'allowAlways') {
        const r = ruleFor(req)
        const existing = state.rules.find((x) => x.on && x.workspaceId === r.workspaceId && x.kind === r.kind && x.tool === r.tool && x.match === r.match)
        const rule = existing ?? { ...r, id: randomUUID(), on: true, createdAt: Date.now() }
        if (!existing) state.rules = [rule, ...state.rules].slice(0, MAX_RULES)
        remember({ ...base, tag: 'always', ruleId: rule.id })
      } else if (choice === 'allow') remember({ ...base, tag: 'once' })
      else if (choice === 'deny') remember({ ...base, tag: 'deny' })
      else if (choice === 'terminal') remember({ ...base, tag: 'terminal' })
      b.answerPermission(id, decisionFor(choice, message))
      save()
    }

    function showWindow(wsId?: string): void {
      const win: BrowserWindow | null = ctx.window()
      if (win && !win.isDestroyed()) {
        if (!win.isVisible()) win.show()
        if (win.isMinimized()) win.restore()
        win.focus()
      }
      if (wsId && ctx.store.workspace(wsId)) ctx.ui({ type: 'open-pane', id: wsId })
    }

    /** Aviso de Windows con Permitir / Ver (las acciones dependen del sistema; el clic abre el espacio). */
    function notifyRequest(req: PendingPermission): void {
      const ws = ctx.store.workspace(req.ws)
      if (!ws || !Notification.isSupported()) return
      const win = ctx.window()
      if (!currentSettings().notify.perm) return
      if (!shouldNotify({ dnd: isDnd(), windowFocused: !!win && !win.isDestroyed() && win.isFocused(), focusedSpace, wsId: ws.id })) return
      const n = new Notification({
        title: `${ws.name} pide permiso`,
        body: labelOf(kindOf(req.tool), req.tool, req.input),
        actions: [
          { type: 'button', text: 'Permitir' },
          { type: 'button', text: 'Ver' }
        ]
      })
      n.on('click', () => showWindow(ws.id))
      // Electron manda el índice en el evento (actionIndex); el segundo argumento es el formato viejo.
      n.on('action', (event: { actionIndex?: number }, legacyIndex?: number) => {
        const index = event.actionIndex ?? legacyIndex
        if (index === 0) {
          const b = ctx.terminal()
          try {
            if (b) answer(b, req.id, 'allow')
          } catch {
            /* ya no estaba pendiente */
          }
        } else showWindow(ws.id)
      })
      n.show()
    }

    /** Aviso de un espacio (terminó o te espera): lo gobierna «notify.done». */
    function notifyText(wsId: string, title: string, body: string): void {
      const ws = ctx.store.workspace(wsId)
      if (!ws || !Notification.isSupported()) return
      if (!currentSettings().notify.done) return
      const win = ctx.window()
      if (!shouldNotify({ dnd: isDnd(), windowFocused: !!win && !win.isDestroyed() && win.isFocused(), focusedSpace, wsId })) return
      const n = new Notification({ title: `${ws.name} ${title}`, body })
      n.on('click', () => showWindow(wsId))
      n.show()
    }

    /** Pedido nuevo: si una regla lo cubre se aprueba solo; si no, aviso (la tarjeta la muestra la UI). */
    function onRequest(b: TerminalBackend, req: PendingPermission): void {
      if (!ctx.store.workspace(req.ws)) return
      const rule = findRule(state.rules, req)
      if (rule) {
        try {
          b.answerPermission(req.id, decisionFor('allow'))
          const kind = kindOf(req.tool)
          remember({ workspaceId: req.ws, spaceName: spaceName(req.ws), tool: req.tool, kind, label: labelOf(kind, req.tool, req.input), tag: 'rule', ruleId: rule.id })
          save()
        } catch (e) {
          ctx.log('regla no aplicada:', (e as Error).message)
        }
        return
      }
      notifyRequest(req)
    }

    ctx.handle('list', () => {
      // Reglas de espacios que ya no existen: se quitan (no quedan huérfanas en el archivo).
      const before = state.rules.length
      state.rules = state.rules.filter((r) => Boolean(ctx.store.workspace(r.workspaceId)))
      if (state.rules.length !== before) save()
      return {
        rules: state.rules,
        history: state.history.filter((h) => h.at >= startOfToday()),
        spaces: Object.fromEntries(ctx.store.workspaces.map((w) => [w.id, { name: w.name, cwd: w.cwd, accountId: w.accountId }]))
      }
    })

    ctx.handle('decide', (payload: unknown) => {
      const p = (payload ?? {}) as { id?: unknown; answer?: unknown; message?: unknown }
      if (typeof p.id !== 'string' || typeof p.answer !== 'string' || !(CHOICES as readonly string[]).includes(p.answer))
        throw new Error('Respuesta inválida.')
      const message = typeof p.message === 'string' ? p.message.slice(0, MAX_MESSAGE) : undefined
      const b = ctx.terminal()
      if (!b) throw new Error('Las terminales todavía no están listas. Probá de nuevo.')
      answer(b, p.id, p.answer as PermissionChoice, message)
    })

    ctx.handle('rule:set', (id: unknown, on: unknown) => {
      if (typeof id !== 'string' || typeof on !== 'boolean') throw new Error('Cambio inválido.')
      const r = state.rules.find((x) => x.id === id)
      if (!r) throw new Error('Esa regla ya no existe.')
      r.on = on
      save()
    })

    ctx.handle('rule:remove', (id: unknown) => {
      if (typeof id !== 'string') throw new Error('Regla inválida.')
      state.rules = state.rules.filter((x) => x.id !== id)
      save()
    })

    /** Deshacer «Permitir siempre»: quita la regla y marca la decisión. Solo sirve para reglas guardadas. */
    ctx.handle('undo', (entryId: unknown) => {
      if (typeof entryId !== 'string') throw new Error('Decisión inválida.')
      const e = state.history.find((h) => h.id === entryId)
      if (!e || e.tag !== 'always' || !e.ruleId || e.undone) throw new Error('Esa decisión no se puede deshacer.')
      const ruleId = e.ruleId
      state.rules = state.rules.filter((r) => r.id !== ruleId)
      e.undone = true
      save()
    })

    /** La UI avisa qué espacio tiene en pantalla (para no avisar de lo que ya se ve). */
    ctx.handle('focus', (wsId: unknown) => {
      focusedSpace = typeof wsId === 'string' && ctx.store.workspace(wsId) ? wsId : null
    })

    // Pedidos y hooks: el backend puede llegar después (daemon). Sin polling.
    void ctx.backend().then(
      (b) => {
        b.on('permission', (req: PendingPermission) => onRequest(b, req))
      },
      () => undefined
    )

    ctx.onHook((p: HookEventPayload) => {
      if (p.event === 'Stop') notifyText(p.ws, 'terminó', 'Claude terminó. Revisá los cambios antes de seguir.')
      else if (p.event === 'Notification' && p.notificationType !== 'permission_prompt')
        notifyText(p.ws, 'te espera', p.message || 'Claude necesita tu atención.')
    })
  }
}

export default feature
