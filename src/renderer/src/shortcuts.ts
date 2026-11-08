/**
 * Atajos de teclado.
 * - SHORTCUTS: la lista ÚNICA de lo que ve el usuario en la hoja de atajos («?», función «help»).
 * - SHORTCUT_ACTIONS: los atajos que el usuario puede cambiar en Configuración → Atajos. El valor
 *   vigente sale de Configuración (settings.shortcuts); sin cambio, el por defecto de acá.
 *   Las funciones que atienden un atajo deben preguntar `matchShortcut(id, e)`, no mirar la tecla fija.
 */
import { canonicalCombo, parseCombo, type ShortcutId } from '../../main/features/settings-model'
import { getSettings } from './features/settings/store'

export interface Shortcut {
  /** Cada combinación es una lista de teclas; varias combinaciones = alternativas. */
  keys: string[][]
  what: string
  /** Para agrupar en la hoja de atajos. */
  group?: 'General' | 'Paneles' | 'Terminal'
}

export const SHORTCUTS: Shortcut[] = [
  { keys: [['Ctrl', 'K']], what: 'Paleta de comandos', group: 'General' },
  { keys: [['Ctrl', 'Shift', 'P']], what: 'Paleta de comandos (alternativo)', group: 'General' },
  { keys: [['Ctrl', ',']], what: 'Configuración', group: 'General' },
  { keys: [['?']], what: 'Esta hoja de atajos', group: 'General' },
  { keys: [['Ctrl', 'Shift', 'F']], what: 'Buscar en el historial de conversaciones', group: 'General' },
  { keys: [['Ctrl', 'Shift', 'B']], what: 'Enviar a varios espacios', group: 'General' },
  { keys: [['Esc']], what: 'Cerrar ventanas y paletas', group: 'General' },
  { keys: [['Ctrl', 'Tab'], ['Ctrl', 'Shift', 'Tab']], what: 'Cambiar de panel (siguiente o anterior, en pestañas)', group: 'Paneles' },
  { keys: [['Ctrl', 'Alt', '←']], what: 'Mover el panel a la izquierda', group: 'Paneles' },
  { keys: [['Ctrl', 'Alt', '→']], what: 'Mover el panel a la derecha', group: 'Paneles' },
  { keys: [['Ctrl', 'Alt', '↑']], what: 'Mover el panel a la fila de arriba', group: 'Paneles' },
  { keys: [['Ctrl', 'Alt', '↓']], what: 'Mover el panel a la fila de abajo', group: 'Paneles' },
  { keys: [['Ctrl', 'Shift', 'C']], what: 'Copiar la selección de la terminal', group: 'Terminal' },
  { keys: [['Ctrl', 'Shift', 'V']], what: 'Pegar en la terminal', group: 'Terminal' },
  { keys: [['Clic derecho']], what: 'En la terminal: copia si hay selección, si no pega', group: 'Terminal' }
]

export interface ShortcutAction {
  id: ShortcutId
  name: string
  /** Por defecto. */
  def: string
  /** Rango fijo (no se graba): «Ctrl Alt 1–4» cambia la distribución con 1 a 4. */
  fixed?: boolean
}

export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  { id: 'palette', name: 'Buscar (paleta de comandos)', def: 'Ctrl K' },
  { id: 'new', name: 'Nuevo espacio', def: 'Ctrl N' },
  { id: 'sidebar', name: 'Mostrar u ocultar la barra lateral', def: 'Ctrl B' },
  { id: 'broadcast', name: 'Enviar a varios espacios', def: 'Ctrl Shift B' },
  { id: 'layout', name: 'Cambiar distribución', def: 'Ctrl Alt 1–4', fixed: true },
  { id: 'settings', name: 'Abrir configuración', def: 'Ctrl ,' },
  { id: 'chat', name: 'Abrir el chat del equipo', def: 'Ctrl Shift M' }
]

/** Combinación vigente de una acción: la personalizada, o el por defecto. */
export function bindingOf(id: ShortcutId, custom: Partial<Record<ShortcutId, string>> = getSettings().settings.shortcuts): string {
  const action = SHORTCUT_ACTIONS.find((a) => a.id === id)
  return custom[id] ?? action?.def ?? ''
}

/** Tecla de una KeyboardEvent en el formato de los atajos («K», «3», «←», «Enter»…), o null. */
export function keyTokenOf(e: KeyboardEvent): string | null {
  const c = e.code
  if (/^Key[A-Z]$/.test(c)) return c.slice(3)
  if (/^Digit[0-9]$/.test(c)) return c.slice(5)
  if (/^F(?:[1-9]|1[0-2])$/.test(c)) return c
  const map: Record<string, string> = {
    Comma: ',',
    Period: '.',
    Semicolon: ';',
    Minus: '-',
    Equal: '=',
    Slash: '/',
    Enter: 'Enter',
    NumpadEnter: 'Enter',
    Space: 'Space',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Insert: 'Insert',
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓'
  }
  return map[c] ?? null
}

/** ¿Este evento de teclado es la combinación de la acción? (Ctrl/Alt/Shift exactos, sin Meta.) */
export function matchShortcut(id: ShortcutId, e: KeyboardEvent): boolean {
  const b = parseCombo(bindingOf(id))
  if (!b || e.metaKey) return false
  return e.ctrlKey === b.ctrl && e.altKey === b.alt && e.shiftKey === b.shift && keyTokenOf(e) === b.key
}

/** Combinación canónica de un evento para grabarla, o null si no es una combinación usable (sin Ctrl/Alt o solo modificadores). */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const key = keyTokenOf(e)
  if (!key) return null
  if (!e.ctrlKey && !e.altKey) return null
  return canonicalCombo([e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join(' '))
}

const norm = (s: string): string => canonicalCombo(s) ?? s

/**
 * Qué otra cosa usa ya esta combinación: otra acción configurable o un atajo fijo de la app.
 * Devuelve el nombre para mostrar, o null si está libre.
 */
export function findConflict(id: ShortcutId, combo: string, custom: Partial<Record<ShortcutId, string>> = getSettings().settings.shortcuts): string | null {
  const target = norm(combo)
  for (const a of SHORTCUT_ACTIONS) {
    if (a.id === id || a.fixed) continue
    if (norm(bindingOf(a.id, custom)) === target) return a.name
  }
  for (const s of SHORTCUTS) for (const k of s.keys) if (norm(k.join(' ')) === target) return s.what
  return null
}

/* ---------- Captura (mientras se graba un atajo en Configuración) ---------- */

let capturing = false
/** true mientras Configuración graba un atajo: las funciones no deben disparar el atajo viejo. */
export const isCapturingShortcut = (): boolean => capturing
export const setShortcutCapture = (on: boolean): void => {
  capturing = on
}
