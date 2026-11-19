// Vite los mete en el bundle del main: @xterm/xterm es de desarrollo y no viaja en el node_modules del instalador.
import js from '@xterm/xterm/lib/xterm.js?raw'
import css from '@xterm/xterm/css/xterm.css?raw'

export const XTERM = { js, css }
