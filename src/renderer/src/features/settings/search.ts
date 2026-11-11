import type { SlothIconName } from '../../icons/SlothIcons'
import { SHORTCUT_ACTIONS } from '../../shortcuts'
import type { SectionId } from './bus'

/** Secciones del panel izquierdo, en el orden del diseño. */
export interface NavItem {
  id: SectionId
  name: string
  sub: string
  /** Color del ícono de la fila (el diseño lo usa como fondo del ícono). */
  color: string
  icon: SlothIconName
  /** Separador antes de esta sección. */
  sepBefore?: boolean
}

export const NAV: readonly NavItem[] = [
  { id: 'general', name: 'General', sub: 'Cómo arranca Sloth y qué editor usa.', color: '#a6abb8', icon: 'Settings' },
  { id: 'cuentas', name: 'Cuentas', sub: 'Cada cuenta de Claude tiene su propia sesión.', color: '#8ab4ff', icon: 'Account' },
  { id: 'apariencia', name: 'Apariencia', sub: 'Tema, color de acento y tamaño del texto.', color: '#b59cff', icon: 'Theme' },
  { id: 'terminal', name: 'Terminal', sub: 'Fuente, cursor y shell de cada espacio.', color: '#5fd4a6', icon: 'Editor' },
  { id: 'atajos', name: 'Atajos de teclado', sub: 'Cambiá cualquier atajo a tu gusto.', color: '#c9cdd6', icon: 'Keyboard' },
  { id: 'notif', name: 'Notificaciones y sonido', sub: 'Qué te avisa Sloth y cómo suena.', color: '#f0b45a', icon: 'Bell' },
  {
    id: 'equipo',
    name: 'Equipo y chat',
    sub: 'Conexión del chat del equipo (Supabase) y tu sesión de GitHub.',
    color: '#b59cff',
    icon: 'Team',
    sepBefore: true
  },
  { id: 'updates', name: 'Actualizaciones', sub: 'Sloth se actualiza solo. Acá elegís cómo.', color: '#5fd4a6', icon: 'Update' },
  { id: 'backup', name: 'Copia de seguridad', sub: 'Llevá tu configuración a otra PC o guardala en un archivo.', color: '#7fc8e8', icon: 'Export' },
  { id: 'about', name: 'Acerca de Sloth', sub: 'Versión, repositorio y reportes.', color: '#a6abb8', icon: 'Help' }
]

export const navOf = (id: SectionId): NavItem => NAV.find((n) => n.id === id) ?? NAV[0]

/** Pasa los nombres de antes a las secciones nuevas. */
export function normalizeTab(t: string | undefined): SectionId {
  if (t === 'comportamiento') return 'general'
  if (t === 'datos') return 'equipo'
  return NAV.some((n) => n.id === t) ? (t as SectionId) : 'apariencia'
}

/** Ajustes que se encuentran desde el buscador: título visible y sección donde están. */
const INDEX: readonly [string, SectionId][] = [
  ['Reabrir los espacios de la última vez', 'general'],
  ['Terminales vivas al cerrar la ventana', 'general'],
  ['Abrir Sloth al iniciar Windows', 'general'],
  ['Confirmar al cerrar paneles', 'general'],
  ['Al cerrar, seguir en la bandeja', 'general'],
  ['Preguntar antes de cerrar Sloth', 'general'],
  ['Dormir espacios inactivos (ahorrar memoria)', 'general'],
  ['Editor para abrir en editor', 'general'],
  ['Carpeta de proyectos', 'general'],
  ['Agregar cuenta', 'cuentas'],
  ['Iniciar sesión', 'cuentas'],
  ['Quitar cuenta', 'cuentas'],
  ['Color de cada cuenta', 'cuentas'],
  ['Tema oscuro', 'apariencia'],
  ['Más oscuro', 'apariencia'],
  ['Según Windows', 'apariencia'],
  ['Color de acento', 'apariencia'],
  ['Densidad de las listas', 'apariencia'],
  ['Tamaño del texto', 'apariencia'],
  ['Fuente de la terminal', 'terminal'],
  ['Tamaño de letra de la terminal', 'terminal'],
  ['Cursor', 'terminal'],
  ['Altura de línea', 'terminal'],
  ['Shell (PowerShell)', 'terminal'],
  ...SHORTCUT_ACTIONS.map((a): [string, SectionId] => ['Atajo: ' + a.name, 'atajos']),
  ['Avisar cuando Claude termina', 'notif'],
  ['Avisar cuando pide permiso', 'notif'],
  ['Avisar de mensajes del equipo', 'notif'],
  ['No molestar', 'notif'],
  ['Sonido de aviso', 'notif'],
  ['Supabase: URL del proyecto', 'equipo'],
  ['Clave publicable', 'equipo'],
  ['Sesión de GitHub', 'equipo'],
  ['Buscar actualizaciones', 'updates'],
  ['Canal beta', 'updates'],
  ['Versión instalada', 'about'],
  ['Repositorio', 'about'],
  ['Reportar un problema', 'about'],
  ['Exportar configuración', 'backup'],
  ['Importar configuración', 'backup'],
  ['Reglas de permisos y decisiones', 'notif'],
  ['Plantillas del equipo', 'equipo']
]

const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export interface SearchHit {
  title: string
  section: SectionId
}

/** Busca sin tildes ni mayúsculas. Vacío = sin resultados. */
export function searchSettings(query: string): SearchHit[] {
  const q = norm(query.trim())
  if (!q) return []
  return INDEX.filter(([t]) => norm(t).includes(q))
    .slice(0, 12)
    .map(([title, section]) => ({ title, section }))
}
