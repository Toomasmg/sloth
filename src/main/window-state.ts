import { app, screen, type BrowserWindow, type Rectangle } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { pickBounds, parseState } from './window-state-core'

/**
 * Tamaño, posición y maximizado de la ventana entre sesiones (v0.5, cosita 5).
 * CONTRATO (lo usa src/main/index.ts, no cambiar las firmas):
 *  - `loadWindowState()` se llama ANTES de crear la ventana, sincrónico y sin tirar nunca.
 *    Devuelve `bounds` solo si el rectángulo guardado sigue visible en algún monitor actual
 *    (screen.getAllDisplays(), al menos 120×80 px dentro del workArea); si no, `{}`.
 *  - `trackWindowState(win)` escucha resize/move/maximize/unmaximize/close y guarda en
 *    userData/window-state.json (tmp + rename) con debounce (≥ 400 ms; nada de timers permanentes).
 *    Guarda `win.getNormalBounds()` (no los bounds maximizados) y `win.isMaximized()`.
 */
export interface WindowState {
  bounds?: Rectangle
  maximized?: boolean
}

const DEBOUNCE_MS = 500

function stateFile(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

export function loadWindowState(): WindowState {
  try {
    const file = stateFile()
    if (!existsSync(file)) return {}
    const saved = parseState(readFileSync(file, 'utf8'))
    if (!saved.bounds) return {}
    const areas = screen.getAllDisplays().map((d) => d.workArea)
    const bounds = pickBounds(saved.bounds, areas)
    if (!bounds) return {}
    return { bounds, maximized: saved.maximized === true }
  } catch (e) {
    console.warn('[ventana] no se pudo leer el estado guardado:', e instanceof Error ? e.message : e)
    return {}
  }
}

function writeState(win: BrowserWindow): void {
  try {
    // Minimizada o destruida: los bounds no sirven.
    if (win.isDestroyed() || win.isMinimized()) return
    const file = stateFile()
    const tmp = file + '.tmp'
    const data = JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() })
    writeFileSync(tmp, data, 'utf8')
    renameSync(tmp, file)
  } catch (e) {
    console.warn('[ventana] no se pudo guardar el estado:', e instanceof Error ? e.message : e)
  }
}

export function trackWindowState(win: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const later = (): void => {
    cancel()
    timer = setTimeout(() => {
      timer = null
      writeState(win)
    }, DEBOUNCE_MS)
  }
  win.on('resize', later)
  win.on('move', later)
  win.on('maximize', later)
  win.on('unmaximize', later)
  // Al cerrar se guarda ya, sin esperar el debounce.
  win.on('close', () => {
    cancel()
    writeState(win)
  })
}
