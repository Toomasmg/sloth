import type { BrowserWindow, Rectangle } from 'electron'

/**
 * Tamaño, posición y maximizado de la ventana entre sesiones (v0.5, cosita 5).
 * CONTRATO (lo usa src/main/index.ts, no cambiar las firmas):
 *  - `loadWindowState()` se llama ANTES de crear la ventana, sincrónico y sin tirar nunca.
 *    Devuelve `bounds` solo si el rectángulo guardado sigue visible en algún monitor actual
 *    (screen.getAllDisplays(), al menos 120×80 px dentro del workArea); si no, `{}`.
 *  - `trackWindowState(win)` escucha resize/move/maximize/unmaximize/close y guarda en
 *    userData/window-state.json (tmp + rename) con debounce (≥ 400 ms; nada de timers permanentes).
 *    Guarda `win.getNormalBounds()` (no los bounds maximizados) y `win.isMaximized()`.
 * STUB: lo completa la tarea T6 del plan v0.5.
 */
export interface WindowState {
  bounds?: Rectangle
  maximized?: boolean
}

export function loadWindowState(): WindowState {
  return {}
}

export function trackWindowState(_win: BrowserWindow): void {
  /* T6 */
}
