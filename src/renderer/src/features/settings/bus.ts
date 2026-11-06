/** Para abrir la Configuración desde la paleta, el engranaje u otra función (fuera del árbol de React). */
export type SettingsTab = 'apariencia' | 'terminal' | 'cuentas' | 'comportamiento' | 'atajos' | 'datos'

const listeners = new Set<(tab?: SettingsTab) => void>()
export const onOpenSettings = (cb: (tab?: SettingsTab) => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
export const openSettings = (tab?: SettingsTab): void => listeners.forEach((l) => l(tab))
