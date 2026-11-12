/** Para abrir la Configuración desde la paleta, el engranaje u otra función (fuera del árbol de React). */

/** Secciones de la pantalla (ids estables). */
export type SectionId = 'general' | 'cuentas' | 'apariencia' | 'terminal' | 'atajos' | 'notif' | 'plantillas' | 'tickets' | 'equipo' | 'updates' | 'backup' | 'about'

/** Acepta también los nombres de antes: «comportamiento» → General y «datos» → Equipo y chat. */
export type SettingsTab = SectionId | 'comportamiento' | 'datos'

const listeners = new Set<(tab?: SettingsTab) => void>()
export const onOpenSettings = (cb: (tab?: SettingsTab) => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
let alVolver: (() => void) | null = null

/** `alVolver` corre una sola vez al cerrar Configuración: sirve para devolver a quien la pidió al lugar de donde salió. */
export const openSettings = (tab?: SettingsTab, alVolver_?: () => void): void => {
  alVolver = alVolver_ ?? null
  listeners.forEach((l) => l(tab))
}

export const takeAlVolver = (): (() => void) | null => {
  const f = alVolver
  alVolver = null
  return f
}
