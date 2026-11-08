import { TEMPLATE_COLOR_KEYS, TEMPLATE_ICON_KEYS } from '../../../../shared/templates-shared'

/** Colores de plantillas y de espacios (mismas claves que main). */
export const TEMPLATE_COLORS: Record<(typeof TEMPLATE_COLOR_KEYS)[number], { name: string; hex: string }> = {
  cielo: { name: 'Cielo', hex: '#8ab4ff' },
  hoja: { name: 'Hoja', hex: '#5fd4a6' },
  lila: { name: 'Lila', hex: '#b59cff' },
  ambar: { name: 'Ámbar', hex: '#f0b45a' },
  coral: { name: 'Coral', hex: '#ff7a7a' }
}

/** Íconos de plantilla: trazo de 24 px, sin relleno (dibujos del diseño de Plantillas). */
export const TEMPLATE_ICONS: Record<(typeof TEMPLATE_ICON_KEYS)[number], { label: string; path: string }> = {
  ticket: {
    label: 'Ticket',
    path: 'M4 8.5A1.5 1.5 0 0 1 5.5 7h13A1.5 1.5 0 0 1 20 8.5v1.6a2.4 2.4 0 0 0 0 4.8v1.6a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5v-1.6a2.4 2.4 0 0 0 0-4.8zM14 7v10'
  },
  db: {
    label: 'Base de datos',
    path: 'M5 6.5C5 5.1 8.1 4 12 4s7 1.1 7 2.5S15.9 9 12 9 5 7.9 5 6.5zM5 6.5v11c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-11M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5'
  },
  revision: {
    label: 'Revisión',
    path: 'M2.5 12C4.2 8.6 7.7 6.5 12 6.5s7.8 2.1 9.5 5.5c-1.7 3.4-5.2 5.5-9.5 5.5S4.2 15.4 2.5 12zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5z'
  },
  bolt: { label: 'Urgente', path: 'M13.5 3.5L5.5 13.5h6l-1 7 8-10h-6z' },
  compass: {
    label: 'Explorar',
    path: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 1 0 0-17zM15.2 8.8l-1.9 4.5-4.5 1.9 1.9-4.5z'
  },
  rama: {
    label: 'Rama',
    path: 'M7 4v16M7 15c0-4 3-5.5 7-6M14 9c1.5-2.5 4-3.5 6.5-3.5-.3 2.6-1.8 4.6-4.4 5.2-1 .2-1.6-.6-2.1-1.7zM8.7 4a1.7 1.7 0 1 1-3.4 0a1.7 1.7 0 1 1 3.4 0zM8.7 20a1.7 1.7 0 1 1-3.4 0a1.7 1.7 0 1 1 3.4 0z'
  }
}

export const colorHex = (k: string | undefined): string => TEMPLATE_COLORS[k as keyof typeof TEMPLATE_COLORS]?.hex ?? TEMPLATE_COLORS.cielo.hex
export const iconPath = (k: string | undefined): string => (TEMPLATE_ICONS[k as keyof typeof TEMPLATE_ICONS] ?? TEMPLATE_ICONS.rama).path

/** Chips para insertar en el primer mensaje. */
export const VAR_CHIPS = ['{ticket}', '{carpeta}', '{rama}'] as const
