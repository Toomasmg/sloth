import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Feature, FeatureContext } from './context'
import type { HookEventPayload } from '../hooks'
import { currentSettings } from './settings'
import { featuresDir, writeJsonAtomic } from './tray-settings'

/**
 * Dormir espacios inactivos: cierra el Claude de un espacio que lleva un rato sin uso (libera su
 * memoria) y, al despertarlo, lo abre con `claude --continue`, que retoma la misma conversación.
 *
 * Solo se duerme si es seguro: Claude terminó su turno (Stop) o está quieto en el prompt (aviso
 * «idle_prompt»), no hay un permiso esperando y no quedó texto escrito sin enviar. Apagado por
 * defecto (Configuración › General › «Dormir espacios inactivos»).
 */

const TICK_MS = 60_000
const file = (): string => join(featuresDir(), 'sleep.json')

function readAsleep(): string[] {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8').replace(/^﻿/, '')) as { asleep?: unknown }
    return Array.isArray(raw.asleep) ? raw.asleep.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** ¿Lo escrito tiene texto? (Las secuencias de escape, como el aviso de foco de la terminal, no cuentan.) */
const hasText = (d: string): boolean => /[^\x00-\x1f\x7f]/.test(d.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1bO.|\x1b./g, ''))

const isIdleNotice = (p: HookEventPayload): boolean => p.event === 'Notification' && p.notificationType === 'idle_prompt'

let timer: NodeJS.Timeout | null = null

const feature: Feature = {
  name: 'sleep',
  register(ctx: FeatureContext) {
    /** Dormidos: su terminal está cerrada y al abrirlos se retoma con --continue. Sobrevive a reiniciar Sloth. */
    const asleep = new Set(readAsleep().filter((id) => ctx.store.workspace(id)))
    /** Último evento de Claude por espacio (para saber si está quieto y desde cuándo). */
    const lastEvent = new Map<string, HookEventPayload>()
    /** Última actividad (hook que no sea el aviso de inactividad, o algo escrito en la terminal). */
    const lastActivity = new Map<string, number>()
    /** Se escribió algo que Claude todavía no recibió (un borrador en el prompt): no se duerme. */
    const draft = new Set<string>()

    const save = (): void => {
      try {
        writeJsonAtomic(file(), { asleep: [...asleep] })
      } catch (e) {
        ctx.log('no se pudo guardar sleep.json:', (e as Error).message)
      }
    }
    const markAsleep = (id: string): void => ctx.setAgent(id, { state: 'sleeping', at: Date.now() })
    for (const id of asleep) markAsleep(id)

    ctx.onHook((p) => {
      lastEvent.set(p.ws, p)
      if (isIdleNotice(p)) return
      lastActivity.set(p.ws, p.at ?? Date.now())
      draft.delete(p.ws)
    })
    ctx.onPtyWrite((id, data) => {
      lastActivity.set(id, Date.now())
      if (hasText(data)) draft.add(id)
    })
    ctx.onPtyExit((id) => {
      lastEvent.delete(id)
      draft.delete(id)
    })
    // Con terminales que siguieron vivas en el daemon: se parte de su último evento.
    void ctx.backend().then((b) => {
      for (const [id, ev] of Object.entries(b.lastHookEvents())) {
        if (lastEvent.has(id)) continue
        lastEvent.set(id, ev)
        lastActivity.set(id, ev.at ?? Date.now())
      }
    }, () => {})

    /** ¿Se puede dormir sin perder nada? */
    function canSleep(id: string, now: number, afterMs: number): boolean {
      const b = ctx.terminal()
      if (!b?.isRunning(id)) return false
      // Corriendo y marcado como dormido: lo abrió otro reemplazo de comando (Historial, mover de
      // cuenta) antes que el nuestro. Ya despertó: se limpia la marca para que pueda volver a dormir.
      if (asleep.delete(id)) save()
      if (draft.has(id)) return false
      // Solo con Claude quieto en su prompt. Tras SessionEnd (salió con /exit) la shell puede estar
      // corriendo cualquier cosa, y dormir la mataría.
      const ev = lastEvent.get(id)
      if (!ev || (ev.event !== 'Stop' && !isIdleNotice(ev))) return false
      if (b.pendingPermissions().some((r) => r.ws === id)) return false
      return now - (lastActivity.get(id) ?? now) >= afterMs
    }

    async function tick(): Promise<void> {
      const min = currentSettings().sleepAfterMin
      // Solo para probar: SLOTH_SLEEP_AFTER_MS=20000 duerme a los 20 s (pisa la Configuración).
      const afterMs = Number(process.env.SLOTH_SLEEP_AFTER_MS) || min * 60_000
      if (!afterMs) return
      const b = ctx.terminal()
      if (!b) return
      const now = Date.now()
      for (const ws of ctx.store.workspaces) {
        if (!canSleep(ws.id, now, afterMs)) continue
        asleep.add(ws.id)
        save()
        // Primero el estado: así la salida de la terminal no lo pisa con «Cerrado».
        markAsleep(ws.id)
        ctx.log(`durmiendo «${ws.name}» (${Math.round(afterMs / 60_000)} min sin uso)`)
        await b.kill(ws.id).catch((e: Error) => ctx.log('no se pudo dormir:', e.message))
      }
    }

    // Al abrir la terminal de un espacio dormido: retomar la conversación.
    ctx.addClaudeCommandOverride((ws) => {
      if (!asleep.delete(ws.id)) return undefined
      save()
      return 'claude --continue'
    })

    ctx.handle('wake', (id: unknown) => {
      if (typeof id !== 'string' || !ctx.store.workspace(id)) throw new Error('Ese espacio ya no existe.')
      if (!asleep.has(id)) return
      // Si la terminal no llegó a cerrarse, se reconecta tal cual: ya no hay nada que retomar.
      if (ctx.terminal()?.isRunning(id)) {
        asleep.delete(id)
        save()
      }
      lastActivity.set(id, Date.now())
      ctx.setAgent(id, { state: 'idle', at: Date.now() })
      ctx.ui({ type: 'restart-pane', id })
    })

    if (timer) clearInterval(timer)
    timer = setInterval(() => void tick(), Math.min(TICK_MS, Number(process.env.SLOTH_SLEEP_AFTER_MS) || TICK_MS))
    timer.unref()
    app.on('before-quit', () => {
      if (timer) clearInterval(timer)
      timer = null
    })
  }
}

export default feature
