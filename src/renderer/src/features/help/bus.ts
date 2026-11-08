/**
 * Abrir piezas de «help» desde otras funciones (settings, palette, menú). Las escucha el Global de help.
 * `shortcuts` queda como alias de `ayuda` (la hoja de atajos hoy es la página de Ayuda).
 */
export type HelpAction = 'ayuda' | 'shortcuts' | 'whatsnew' | 'invite'
const listeners = new Set<(a: HelpAction) => void>()
export const onHelp = (cb: (a: HelpAction) => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
export const openHelp = (a: HelpAction): void => listeners.forEach((l) => l(a))
