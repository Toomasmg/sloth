import type { ShortcutId } from '../../shared/settings-model'

/**
 * Con la terminal enfocada, la tecla es de la shell salvo que acá se diga lo contrario.
 * - global: la app la atiende y la tecla no llega a la shell (se corta antes de xterm).
 * - terminal: la shell la conserva; el atajo anda solo con el foco afuera de la terminal.
 * Regla: son globales las combinaciones que la shell no usa (Ctrl+Shift, Ctrl+Alt, Ctrl+dígito, Ctrl+K,
 * Ctrl+N y Ctrl+, no son de readline en PowerShell/cmd). Siguen de la shell Ctrl+B (retroceder un
 * carácter), F1 y F2 (vim, less, mc): tomarlas rompe la línea de comandos sin forma de recuperarla.
 */
export type AlcanceEnTerminal = 'global' | 'terminal'

export const ALCANCE_EN_TERMINAL: Readonly<Record<ShortcutId, AlcanceEnTerminal>> = {
  palette: 'global',
  new: 'global',
  sidebar: 'terminal',
  broadcast: 'global',
  layout: 'global',
  settings: 'global',
  chat: 'global',
  history: 'global',
  rename: 'terminal',
  help: 'terminal',
  focus1: 'global',
  focus2: 'global',
  focus3: 'global',
  focus4: 'global',
  broadcastNow: 'global',
  dictado: 'global'
}

/** ¿La app atiende este atajo aunque el foco esté en una terminal? */
export const esGlobalEnTerminal = (id: ShortcutId): boolean => ALCANCE_EN_TERMINAL[id] === 'global'

/** Decide si un atajo se atiende dado dónde está el foco. */
export function seAtiende(id: ShortcutId, foco: { enTerminal: boolean }): boolean {
  return !foco.enTerminal || esGlobalEnTerminal(id)
}

/**
 * Al cerrar una vista, ¿devolver el foco a quien la abrió? No si el foco ya está en otra capa
 * (la vista que la reemplazó): devolverlo lo dejaría en una terminal oculta detrás.
 */
export function debeDevolverFoco(foco: { enOtraCapa: boolean }): boolean {
  return !foco.enOtraCapa
}
