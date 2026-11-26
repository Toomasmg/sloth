/**
 * Con la terminal enfocada la tecla es de la shell salvo que el atajo sea de los que la shell no usa.
 * Se decide por la combinación que llegó, no por la acción: así un atajo reasignado a Ctrl+C o Ctrl+R
 * nunca le saca la tecla a la terminal.
 * - Se atienden: Ctrl con Shift o Alt (Ctrl+Shift+M, Ctrl+Alt+1) y Ctrl con un número o la coma.
 * - Quedan de la shell: Ctrl+letra suelta (Ctrl+B retrocede un carácter; Ctrl+N es «historial siguiente»
 *   en readline y en Claude Code, y lo usa quien navega comandos), Alt+letra, F1/F2 (vim, less) y Enter/Tab.
 * Por eso «Nuevo espacio» anda con Ctrl+N solo fuera de la terminal; con la terminal enfocada se usa la
 * paleta (Ctrl+K) o se reasigna a una combinación con Shift en Configuración.
 */
export interface TeclaEvento {
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  /** AltGr llega como Ctrl+Alt en Windows: Ctrl+Alt+2 es la «@» de un teclado español. */
  altGraph: boolean
  isComposing: boolean
  /** Tecla en el formato de los atajos («K», «3», «Enter»…). */
  key: string | null
}

export function seAtiende(e: TeclaEvento, enTerminal: boolean): boolean {
  if (e.altGraph || e.isComposing) return false
  if (!enTerminal) return true
  if (!e.ctrlKey) return false
  if (e.shiftKey || e.altKey) return true
  return e.key !== null && /^[0-9,]$/.test(e.key)
}

/** Al volver de una Vista: ¿el foco ya es de otra capa distinta de la que se cierra? */
export function capaAjena(capaDelFoco: unknown, propia: unknown): boolean {
  return !!capaDelFoco && capaDelFoco !== propia
}
