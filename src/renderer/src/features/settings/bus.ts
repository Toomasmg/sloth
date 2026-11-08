/** Para abrir la Configuración desde la paleta, el engranaje u otra función (fuera del árbol de React). */

/** Secciones de la pantalla (ids estables). */
export type SectionId = 'general' | 'cuentas' | 'apariencia' | 'terminal' | 'atajos' | 'notif' | 'equipo' | 'updates' | 'about'

/** Acepta también los nombres de antes: «comportamiento» → General y «datos» → Equipo y chat. */
export type SettingsTab = SectionId | 'comportamiento' | 'datos'

const listeners = new Set<(tab?: SettingsTab) => void>()
export const onOpenSettings = (cb: (tab?: SettingsTab) => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
export const openSettings = (tab?: SettingsTab): void => listeners.forEach((l) => l(tab))
