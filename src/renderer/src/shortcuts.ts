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
  /** Si la acción se puede cambiar en Configuración, la hoja muestra la combinación vigente (bindingOf). */
  id?: ShortcutId
  what: string
  /** Para agrupar en la hoja de atajos. */
  group?: 'General' | 'Paneles' | 'Terminal' | 'Chat'
}

export const SHORTCUTS: Shortcut[] = [
  { keys: [['Ctrl', 'K']], what: 'Paleta de comandos', group: 'General', id: 'palette' },
  { keys: [['Ctrl', 'Shift', 'P']], what: 'Paleta de comandos (alternativo)', group: 'General' },
  { keys: [['Ctrl', ',']], what: 'Configuración', group: 'General', id: 'settings' },
  { keys: [['?']], what: 'Esta hoja de atajos', group: 'General' },
  { keys: [['Ctrl', 'Shift', 'F']], what: 'Buscar en el historial de conversaciones', group: 'General', id: 'history' },
  { keys: [['Ctrl', 'Shift', 'B']], what: 'Enviar a varios espacios', group: 'General', id: 'broadcast' },
  { keys: [['Ctrl', 'N']], what: 'Nuevo espacio', group: 'General', id: 'new' },
  { keys: [['Ctrl', 'B']], what: 'Mostrar u ocultar la barra lateral', group: 'General', id: 'sidebar' },
  { keys: [['Ctrl', 'Shift', '1–5']], what: 'Ir a Espacios (1), Tickets (2), Equipo (3), Historial (4) o Ramas aparte (5)', group: 'General' },
  { keys: [['Ctrl', 'Shift', 'M']], what: 'Abrir el chat del equipo', group: 'Chat', id: 'chat' },
  { keys: [['Esc']], what: 'Cerrar ventanas y paletas', group: 'General' },
  { keys: [['F2']], what: 'Renombrar el panel activo (o el espacio enfocado en la lista)', group: 'Paneles', id: 'rename' },
  { keys: [['F1']], what: 'Ver atajos de teclado (esta hoja)', group: 'General', id: 'help' },
  { keys: [['Ctrl', 'Alt', '1–4']], what: 'Distribución: 1 (uno), 2 (dos), 3 (tres) o 4 (cuatro) paneles a la vista', group: 'Paneles' },
  { keys: [['Ctrl', '1']], what: 'Ir al panel 1 (el primero visible, de izquierda a derecha y de arriba abajo)', group: 'Paneles', id: 'focus1' },
  { keys: [['Ctrl', '2']], what: 'Ir al panel 2', group: 'Paneles', id: 'focus2' },
  { keys: [['Ctrl', '3']], what: 'Ir al panel 3', group: 'Paneles', id: 'focus3' },
  { keys: [['Ctrl', '4']], what: 'Ir al panel 4', group: 'Paneles', id: 'focus4' },
  { keys: [['Ctrl', 'Shift', 'Enter']], what: 'Enviar a varios espacios, con el mensaje enfocado', group: 'General', id: 'broadcastNow' },
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
  { id: 'chat', name: 'Abrir el chat del equipo', def: 'Ctrl Shift M' },
  { id: 'history', name: 'Buscar en el historial de conversaciones', def: 'Ctrl Shift F' },
  { id: 'rename', name: 'Renombrar el panel activo', def: 'F2' },
  { id: 'help', name: 'Ver atajos de teclado', def: 'F1' },
  { id: 'focus1', name: 'Ir al panel 1', def: 'Ctrl 1' },
  { id: 'focus2', name: 'Ir al panel 2', def: 'Ctrl 2' },
  { id: 'focus3', name: 'Ir al panel 3', def: 'Ctrl 3' },
  { id: 'focus4', name: 'Ir al panel 4', def: 'Ctrl 4' },
  { id: 'broadcastNow', name: 'Enviar a varios espacios, con el mensaje enfocado', def: 'Ctrl Shift Enter' }
]

/** Combinaciones de una fila de la hoja: las personalizadas si la acción se puede cambiar. */
export function shortcutKeys(s: Shortcut): string[][] {
  return s.id ? [bindingOf(s.id).split(' ').filter(Boolean)] : s.keys
}

/** Texto para mostrar de una acción: «Ctrl+Shift+F». */
export const comboLabel = (id: ShortcutId): string => bindingOf(id).split(' ').join('+')

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

/** Combinación canónica de un evento para grabarla, o null si no es una combinación usable (sin Ctrl/Alt o solo modificadores). Una tecla F sola sirve. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const key = keyTokenOf(e)
  if (!key) return null
  if (!e.ctrlKey && !e.altKey) return /^F(?:[1-9]|1[0-2])$/.test(key) && !e.shiftKey ? key : null
  return canonicalCombo([e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join(' '))
}

const norm = (s: string): string => canonicalCombo(s) ?? s

/** «Ctrl Shift 1–5» son cinco combinaciones: así un atajo propio no puede pisar ninguna. */
function expandRange(keys: string[]): string[][] {
  const last = keys[keys.length - 1] ?? ''
  const m = /^(\d)–(\d)$/.exec(last)
  if (!m) return [keys]
  const out: string[][] = []
  for (let d = Number(m[1]); d <= Number(m[2]); d++) out.push([...keys.slice(0, -1), String(d)])
  return out
}

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
  for (const s of SHORTCUTS) {
    if (s.id) continue
    for (const k of s.keys) for (const c of expandRange(k)) if (norm(c.join(' ')) === target) return s.what
  }
  return null
}

/* ---------- Captura (mientras se graba un atajo en Configuración) ---------- */

let capturing = false
/** true mientras Configuración graba un atajo: las funciones no deben disparar el atajo viejo. */
export const isCapturingShortcut = (): boolean => capturing
export const setShortcutCapture = (on: boolean): void => {
  capturing = on
}
