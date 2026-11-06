/**
 * Lista ÚNICA de atajos de teclado: la muestran Configuración → Atajos y la hoja de atajos («?»,
 * función «help»). Si agregás un atajo en cualquier parte de la app, sumalo acá.
 */
export interface Shortcut {
  /** Cada combinación es una lista de teclas; varias combinaciones = alternativas. */
  keys: string[][]
  what: string
  /** Para agrupar en la hoja de atajos. */
  group?: 'General' | 'Paneles' | 'Terminal'
}

export const SHORTCUTS: Shortcut[] = [
  { keys: [['Ctrl', 'K']], what: 'Paleta de comandos' },
  { keys: [['Ctrl', 'Shift', 'P']], what: 'Paleta de comandos (alternativo)' },
  { keys: [['Ctrl', ',']], what: 'Configuración' },
  { keys: [['Ctrl', 'Shift', 'F']], what: 'Buscar en el historial de conversaciones' },
  { keys: [['Ctrl', 'Shift', 'B']], what: 'Enviar a varios espacios' },
  { keys: [['Ctrl', 'Shift', 'C']], what: 'Copiar la selección de la terminal' },
  { keys: [['Ctrl', 'Shift', 'V']], what: 'Pegar en la terminal' },
  { keys: [['Clic derecho']], what: 'En la terminal: copia si hay selección, si no pega' },
  { keys: [['Esc']], what: 'Cerrar ventanas y paletas' }
]
