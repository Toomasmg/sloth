import type { ConectorDef } from '../conector'

/** Los issues de un repo de GitHub, leídos y escritos con `gh` y la sesión de la persona: no pasa por Claude. */
export default {
  id: 'github',
  nombre: 'GitHub Issues',
  via: 'gh',
  verificado: true,
  idRegex: '^[1-9]\\d{0,6}$',
  idMayusculas: false,
  ejemplo: { id: '123', estado: 'abierto', prioridad: 'etiqueta', proyecto: 'dueño/repo' },
  estados: [
    { clave: 'abierto', nombre: 'Abierto', categoria: 'pendiente' },
    { clave: 'cerrado', nombre: 'Cerrado', categoria: 'hecho' }
  ],
  faltaConector: { clave: 'sin_gh', mensaje: 'Instalá GitHub CLI (gh) y corré gh auth login para ver los issues.' }
} satisfies ConectorDef
