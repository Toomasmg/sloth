/** Abrir piezas de «help» desde otras funciones (settings, palette). Las escucha el Global de help (T3). */
export type HelpAction = 'shortcuts' | 'whatsnew' | 'invite'
const listeners = new Set<(a: HelpAction) => void>()
export const onHelp = (cb: (a: HelpAction) => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
export const openHelp = (a: HelpAction): void => listeners.forEach((l) => l(a))
