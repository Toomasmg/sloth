export interface KeyTarget {
  tag: string
  /** input, textarea, select o contenteditable. */
  editable: boolean
  /** Dentro de un menú, una lista de opciones o un diálogo. */
  popup: boolean
}

export interface ComposeKey {
  key: string
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  isComposing: boolean
  target: KeyTarget
}

/** Qué hace una tecla con el foco en el panel pero fuera de un campo: escribir en la caja, pegar, o nada. */
export function composeIntent(k: ComposeKey): 'type' | 'paste' | null {
  if (k.isComposing || k.altKey || k.metaKey) return null
  if (k.target.editable || k.target.popup) return null
  if (k.ctrlKey) return k.key.toLowerCase() === 'v' ? 'paste' : null
  if (k.key === ' ') return null
  return [...k.key].length === 1 ? 'type' : null
}
