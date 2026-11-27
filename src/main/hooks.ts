import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentState } from '../shared/types'
import { HOOK_EVENTS, type HookEventPayload } from '../shared/daemon-protocol'
import { HOOK_MARKER, HOOK_SCRIPT, LEGACY_HOOK_MARKERS } from '../daemon/hook-script'
import { NOTIFY_SCRIPT } from '../daemon/notify-script'
import { envolverStatusline, STATUSLINE_SCRIPT } from './statusline-core'
import { respaldarAntesDeReemplazar, respaldarUnaVez } from './respaldo'
import { raizDatos } from './perfil'

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
  return join(raizDatos(), 'sloth-hook.cjs')
}

/** Ruta del script de aviso de turno de Codex (userData/sloth-notify.cjs). */
export function notifyScriptPath(): string {
  return join(raizDatos(), 'sloth-notify.cjs')
}

let nodeEnPath: boolean | undefined

/** Una sola vez por arranque: el envoltorio corre con node y, sin node, la statusline quedaría vacía. */
export function hayNode(): boolean {
  if (nodeEnPath === undefined) {
    try {
      execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['node'], { stdio: 'ignore', windowsHide: true, timeout: 5000 })
      nodeEnPath = true
    } catch {
      nodeEnPath = false
    }
  }
  return nodeEnPath
}

/** Ruta del envoltorio de la statusline (userData/sloth-statusline.cjs). */
export function statuslineScriptPath(): string {
  return join(raizDatos(), 'sloth-statusline.cjs')
}

let helperCache: { exe: string; comando: string } | null | undefined

/**
 * El ejecutable en Rust de los hooks, la statusline y el aviso de Codex (native/helper): reemplaza a los tres scripts
 * de Node, así las cuentas no necesitan Node. Se copia a userData/bin y se corre desde ahí (no desde la carpeta de
 * instalación, que el instalador tiene que poder actualizar). `comando` es la ruta para escribirla en un comando de
 * shell: con barras y sin espacios (en PowerShell una ruta con comillas delante del primer argumento no se ejecuta),
 * usando el nombre corto 8.3 si la carpeta tiene espacios. Null si no está compilado o no hay ruta usable: se sigue
 * con Node.
 */
export function helperHook(): { exe: string; comando: string } | null {
  if (helperCache !== undefined) return helperCache
  helperCache = null
  if (process.platform !== 'win32') return null
  const origen = [process.env.SLOTH_HELPER, join(process.resourcesPath ?? '', 'daemon', 'sloth-hook.exe'), join(process.env.SLOTH_APP_PATH ?? process.cwd(), 'out', 'daemon', 'sloth-hook.exe')].find(
    (c): c is string => !!c && existsSync(c)
  )
  if (!origen) return null
  try {
    const destino = join(raizDatos(), 'bin', 'sloth-hook.exe')
    mkdirSync(join(raizDatos(), 'bin'), { recursive: true })
    const hash = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex')
    if (!existsSync(destino) || hash(destino) !== hash(origen)) {
      const tmp = `${destino}.${process.pid}.tmp`
      copyFileSync(origen, tmp)
      try {
        renameSync(tmp, destino)
      } catch (e) {
        // Un hook corriendo en este momento tiene el archivo abierto: se sigue con el anterior y se reintenta al próximo arranque.
        rmSync(tmp, { force: true })
        if (!existsSync(destino)) throw e
      }
    }
    const comando = rutaParaShell(destino)
    if (comando) helperCache = { exe: destino, comando }
  } catch (e) {
    console.warn(`[hooks] no se pudo preparar sloth-hook.exe: ${(e as Error).message}`)
  }
  return helperCache
}

/** Ruta con barras y sin espacios, o null si no hay forma de escribirla sin comillas. */
export function rutaParaShell(ruta: string): string | null {
  let r = ruta
  if (/\s/.test(r)) {
    try {
      r = execFileSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${ruta}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim()
    } catch {
      return null
    }
  }
  return r && !/[\s"'`$&|;<>()^%!]/.test(r.replace(/\\/g, '/')) ? r.replace(/\\/g, '/') : null
}

export function writeIfChanged(file: string, content: string): void {
  let current = ''
  try {
    current = readFileSync(file, 'utf8')
  } catch {
    /* no existe */
  }
  if (current === content) return
  mkdirSync(raizDatos(), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

/** Escribe (o actualiza) el script de hook, el de la statusline y el de aviso de turno de Codex. Llamar una vez al arrancar, antes de installInto. */
export function writeHookScript(): string {
  const file = hookScriptPath()
  writeIfChanged(file, HOOK_SCRIPT)
  writeIfChanged(statuslineScriptPath(), STATUSLINE_SCRIPT)
  writeIfChanged(notifyScriptPath(), NOTIFY_SCRIPT)
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
  const helper = helperHook()
  for (const event of INSTALLED_EVENTS) {
    const others = (hooks[event] ?? []).filter((e) => !e.hooks?.some((h) => isOurs(h.command)))
    const hook: Hook = { type: 'command', command: helper ? `${helper.comando} ${event}` : `node "${script}" ${event}` }
    if (event === 'PermissionRequest') hook.timeout = PERMISSION_HOOK_TIMEOUT_S
    const ours: Entry = { hooks: [hook] }
    if (event === 'PreToolUse' || event === 'PermissionRequest') ours.matcher = ''
    hooks[event] = [...others, ours]
  }
  settings.hooks = hooks
  // El % real de los límites solo llega en la entrada de la statusline: se envuelve para leerlo (función «celular»).
  if (helper || hayNode()) settings.statusLine = envolverStatusline(settings.statusLine, statuslineScriptPath(), helper?.comando)
  const texto = JSON.stringify(settings, null, 2)
  // Un respaldo que no se pudo hacer no frena la terminal: queda en el log.
  try {
    respaldarUnaVez(file)
    if (base) respaldarAntesDeReemplazar(file, texto)
  } catch (e) {
    console.warn(`[hooks] no se pudo respaldar ${file}: ${(e as Error).message}`)
  }
  const tmp = `${file}.tmp`
  writeFileSync(tmp, texto, 'utf8')
  renameSync(tmp, file)
}
