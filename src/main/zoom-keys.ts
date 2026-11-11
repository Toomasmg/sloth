export interface ZoomKey {
  type: string
  key: string
  code: string
  control: boolean
  alt: boolean
  meta: boolean
}

export const ZOOM_STEP = 0.5
export const ZOOM_LIMIT = 3

/**
 * Nivel de zoom que corresponde a una tecla, o null si no es un atajo de zoom.
 * El menú por defecto de Electron solo toma Ctrl+Shift+= (teclado en inglés): con el «+» propio del
 * teclado en español, o el del numérico, no agrandaba.
 */
export function zoomFor(input: ZoomKey, current: number): number | null {
  if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return null
  if (input.key === '0' || input.code === 'Numpad0') return 0
  const dir = input.key === '+' || input.key === '=' || input.code === 'NumpadAdd' ? 1
    : input.key === '-' || input.code === 'NumpadSubtract' ? -1
    : 0
  if (dir === 0) return null
  return Math.max(-ZOOM_LIMIT, Math.min(ZOOM_LIMIT, current + dir * ZOOM_STEP))
}
