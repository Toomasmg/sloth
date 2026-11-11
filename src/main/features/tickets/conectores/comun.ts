import type { Estado } from '../../../../shared/tickets'

/** Los nombres de estado más comunes en inglés y en español, con su clave en snake_case. */
export const ESTADOS_COMUNES: Estado[] = [
  { clave: 'backlog', nombre: 'Backlog', categoria: 'pendiente' },
  { clave: 'to_do', nombre: 'To Do', categoria: 'pendiente' },
  { clave: 'todo', nombre: 'Todo', categoria: 'pendiente' },
  { clave: 'open', nombre: 'Open', categoria: 'pendiente' },
  { clave: 'por_hacer', nombre: 'Por hacer', categoria: 'pendiente' },
  { clave: 'abierto', nombre: 'Abierto', categoria: 'pendiente' },
  { clave: 'in_progress', nombre: 'In Progress', categoria: 'en_curso' },
  { clave: 'doing', nombre: 'Doing', categoria: 'en_curso' },
  { clave: 'en_curso', nombre: 'En curso', categoria: 'en_curso' },
  { clave: 'en_progreso', nombre: 'En progreso', categoria: 'en_curso' },
  { clave: 'in_review', nombre: 'In Review', categoria: 'revision' },
  { clave: 'code_review', nombre: 'Code Review', categoria: 'revision' },
  { clave: 'review', nombre: 'Review', categoria: 'revision' },
  { clave: 'qa', nombre: 'QA', categoria: 'revision' },
  { clave: 'en_revision', nombre: 'En revisión', categoria: 'revision' },
  { clave: 'blocked', nombre: 'Blocked', categoria: 'bloqueado' },
  { clave: 'on_hold', nombre: 'On Hold', categoria: 'bloqueado' },
  { clave: 'bloqueado', nombre: 'Bloqueado', categoria: 'bloqueado' },
  { clave: 'done', nombre: 'Done', categoria: 'hecho' },
  { clave: 'closed', nombre: 'Closed', categoria: 'hecho' },
  { clave: 'resolved', nombre: 'Resolved', categoria: 'hecho' },
  { clave: 'complete', nombre: 'Complete', categoria: 'hecho' },
  { clave: 'completed', nombre: 'Completed', categoria: 'hecho' },
  { clave: 'cancelled', nombre: 'Cancelled', categoria: 'hecho' },
  { clave: 'canceled', nombre: 'Canceled', categoria: 'hecho' },
  { clave: 'listo', nombre: 'Listo', categoria: 'hecho' },
  { clave: 'hecho', nombre: 'Hecho', categoria: 'hecho' },
  { clave: 'cerrado', nombre: 'Cerrado', categoria: 'hecho' },
  { clave: 'cancelado', nombre: 'Cancelado', categoria: 'hecho' }
]

/** Va al final de cada pista de lista: así las claves coinciden con las de ESTADOS_COMUNES. */
export const ESTADO_EN_SNAKE =
  'En "estado" poné el nombre del estado en minúsculas, sin tildes y con guiones bajos en vez de espacios (In Progress → in_progress).'

export const PISTA_ESTADOS = 'Armá "estados" con los estados que viste en las tareas, en el orden del flujo (de pendiente a hecho), sin repetir claves.'

export const faltaConector = (id: string, nombre: string): { clave: string; mensaje: string } => ({
  clave: `sin_${id.replaceAll('-', '_')}`,
  mensaje: `Conectá ${nombre} en claude.ai con esta cuenta (claude.ai → Configuración → Conectores) y probá de nuevo: Claude no encontró las herramientas de ${nombre}.`
})
