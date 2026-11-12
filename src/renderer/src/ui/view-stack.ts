/** Vistas abiertas, de abajo hacia arriba. Las registra `View` al montarse; el riel de navegación las lee. */
export interface ViewEntry {
  id: string
  /** Lo mismo que el botón de volver: si hay cambios sin guardar, pregunta antes. */
  request: () => void
  isDirty: () => boolean
}

let stack: ViewEntry[] = []
const subs = new Set<() => void>()
const emit = (): void => subs.forEach((f) => f())

export function pushView(entry: ViewEntry): () => void {
  stack = [...stack, entry]
  emit()
  return () => {
    stack = stack.filter((e) => e !== entry)
    emit()
  }
}

export const getViews = (): readonly ViewEntry[] => stack

export function subscribeViews(f: () => void): () => void {
  subs.add(f)
  return () => {
    subs.delete(f)
  }
}

/** Id de la Vista de arriba, o null si se ven los espacios. */
export const topViewId = (): string | null => stack[stack.length - 1]?.id ?? null

/**
 * Cierra todas las Vistas, de arriba hacia abajo. Si una tiene cambios sin guardar, le pide que
 * pregunte y para ahí: devuelve false y no se navega a ningún lado.
 */
export function closeAllViews(): boolean {
  for (const e of [...stack].reverse()) {
    if (e.isDirty()) {
      e.request()
      return false
    }
    e.request()
  }
  return true
}

/** Solo la Vista de arriba responde a Esc: las de abajo no se ven. */
export const isTopView = (entry: ViewEntry): boolean => stack[stack.length - 1] === entry
