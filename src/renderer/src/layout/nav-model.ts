/** Destinos del riel de navegación. Los cinco primeros tienen atajo (Ctrl+Shift+1…5); Ayuda y Configuración van al pie. */
export type NavDest = 'espacios' | 'tickets' | 'equipo' | 'historial' | 'ramas' | 'ayuda' | 'ajustes'

export const NAV_MAIN: readonly NavDest[] = ['espacios', 'tickets', 'equipo', 'historial', 'ramas']
export const NAV_FOOT: readonly NavDest[] = ['ayuda', 'ajustes']

export const NAV_LABEL: Record<NavDest, string> = {
  espacios: 'Espacios',
  tickets: 'Tickets',
  equipo: 'Equipo',
  historial: 'Historial',
  ramas: 'Ramas aparte',
  ayuda: 'Ayuda',
  ajustes: 'Configuración'
}

/**
 * A qué destino pertenece cada Vista, por el id de su título. Las que se abren desde otra (Reportar
 * y Primeros pasos desde Ayuda, Exportar desde Configuración) marcan a su madre.
 */
const VIEW_DEST: Record<string, NavDest> = {
  'f-tickets-view-title': 'tickets',
  'f-team-title': 'equipo',
  'hist-view-title': 'historial',
  'f-wt-view-title': 'ramas',
  'ay-view-title': 'ayuda',
  'rp-view-title': 'ayuda',
  'fr-view-title': 'ayuda',
  'f-set-view-title': 'ajustes',
  'f-ei-view-title': 'ajustes'
}

/** Destino activo según la Vista de arriba; sin Vista (o una que no es destino) se está en Espacios. */
export const destOf = (viewId: string | null): NavDest => (viewId ? (VIEW_DEST[viewId] ?? 'espacios') : 'espacios')

/** Ctrl+Shift+1…5 → destino. `code` es el de la tecla (Digit1…), así no depende de lo que escribe Shift. */
export function navDestForKey(e: { code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }): NavDest | null {
  if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return null
  const m = /^Digit([1-5])$/.exec(e.code)
  return m ? NAV_MAIN[Number(m[1]) - 1] : null
}
