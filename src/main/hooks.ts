import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentState } from '../shared/types'
import { HOOK_EVENTS, type HookEventPayload } from '../shared/daemon-protocol'
import { HOOK_MARKER, HOOK_SCRIPT, LEGACY_HOOK_MARKERS } from '../daemon/hook-script'

export type { HookEventPayload }

/**
 * Hooks que instalamos en cada cuenta. El servidor HTTP que los recibe vive en el daemon de
 * terminales (o en el backend en proceso): ver src/daemon/core.ts.
 * PermissionRequest espera la respuesta de la UI, por eso lleva timeout propio.
 */
const INSTALLED_EVENTS = [...HOOK_EVENTS, 'PermissionRequest'] as const
const PERMISSION_HOOK_TIMEOUT_S = 130

/** Ruta del script de hook (userData/sloth-hook.cjs). */
export function hookScriptPath(): string {
  return join(app.getPath('userData'), 'sloth-hook.cjs')
}

/** Escribe (o actualiza) el script de hook. Llamar una vez al arrancar, antes de installInto. */
export function writeHookScript(): string {
  const file = hookScriptPath()
  let current = ''
  try {
    current = readFileSync(file, 'utf8')
  } catch {
    /* no existe */
  }
  if (current !== HOOK_SCRIPT) {
    mkdirSync(app.getPath('userData'), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, HOOK_SCRIPT, 'utf8')
    renameSync(tmp, file)
  }
  return file
}

export function stateForEvent(p: HookEventPayload): { state: AgentState; detail?: string } {
  switch (p.event) {
    case 'SessionStart':
      return { state: 'idle' }
    case 'UserPromptSubmit':
      return { state: 'working' }
    case 'PreToolUse':
      return { state: 'working', detail: p.tool }
    case 'Notification':
      return { state: 'waiting', detail: p.message }
    case 'Stop':
      return { state: 'done' }
    case 'SessionEnd':
      // Claude se cerró pero la shell del espacio sigue abierta.
      return { state: 'idle', detail: 'Claude cerrado' }
  }
}

/**
 * Agrega (o actualiza) nuestros hooks en el settings.json de la cuenta, sin tocar los hooks
 * que el usuario ya tenga.
 */
export function installInto(configDir: string, base?: Record<string, unknown>): void {
  mkdirSync(configDir, { recursive: true })
  const file = join(configDir, 'settings.json')
  let settings: Record<string, unknown> = {}
  if (base) {
    // Copia profunda: no queremos mutar el settings.json del usuario en memoria.
    settings = structuredClone(base)
  } else if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>
    } catch {
      // No pisamos un settings.json que no entendemos.
      console.warn(`[hooks] settings.json inválido en ${configDir}; no se instalan hooks`)
      return
    }
  }
  type Hook = { type: string; command: string; timeout?: number }
  type Entry = { matcher?: string; hooks: Hook[] }
  const hooks = (settings.hooks ?? {}) as Record<string, Entry[]>
  const isOurs = (cmd?: string): boolean =>
    typeof cmd === 'string' && [HOOK_MARKER, ...LEGACY_HOOK_MARKERS].some((m) => cmd.includes(m))
  const script = hookScriptPath().replace(/\\/g, '/')
  for (const event of INSTALLED_EVENTS) {
    const others = (hooks[event] ?? []).filter((e) => !e.hooks?.some((h) => isOurs(h.command)))
    const hook: Hook = { type: 'command', command: `node "${script}" ${event}` }
    if (event === 'PermissionRequest') hook.timeout = PERMISSION_HOOK_TIMEOUT_S
    const ours: Entry = { hooks: [hook] }
    if (event === 'PreToolUse' || event === 'PermissionRequest') ours.matcher = ''
    hooks[event] = [...others, ours]
  }
  settings.hooks = hooks
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8')
  renameSync(tmp, file)
}
