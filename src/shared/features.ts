/**
 * Canales IPC de las funciones (features). Cada función usa `feat:<nombre>:<operación>`:
 * así cada una vive en su carpeta y nadie toca el preload ni el index de main.
 */
export const FEAT_CHANNEL = /^feat:[a-z0-9-]+:[A-Za-z0-9-]+$/

export const isFeatChannel = (c: unknown): c is string => typeof c === 'string' && FEAT_CHANNEL.test(c)

/** Órdenes del proceso main a la interfaz (por ejemplo, después de que una función crea un espacio). */
export type UiCommand =
  | { type: 'reload' }
  | { type: 'open-pane'; id: string }
  | { type: 'restart-pane'; id: string }
  | { type: 'focus-window' }
