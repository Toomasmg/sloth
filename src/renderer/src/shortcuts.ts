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
