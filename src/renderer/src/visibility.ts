import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

const isVisible = (): boolean => document.visibilityState === 'visible'

/** true mientras la ventana se ve (no minimizada ni tapada del todo). */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(isVisible)
  useEffect(() => {
    const on = (): void => setVisible(isVisible())
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return visible
}

/**
 * Corre `fn` al montar y cada `ms`, pero solo con la ventana visible:
 * se pausa al ocultarse y refresca una vez al volver.
 */
export function useVisiblePolling(fn: () => void, ms: number, deps: unknown[] = []): void {
  const visible = useDocumentVisible()
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    if (!visible) return
    fnRef.current()
    const t = setInterval(() => fnRef.current(), ms)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, ms, ...deps])
}

/* ---------- Paneles visibles ----------
 * App dice qué paneles se ven (los que están en pestañas quedan ocultos). Terminales y el botón de
 * Git miran esto: lo oculto no dibuja, no mide y no consulta nada. Por defecto, visible.
 */
const paneVisible = new Map<string, boolean>()
const paneListeners = new Set<() => void>()

export function setPaneVisible(id: string, visible: boolean): void {
  if (paneVisible.has(id) && paneVisible.get(id) === visible) return
  paneVisible.set(id, visible)
  for (const l of paneListeners) l()
}

/** true si el panel se ve en la grilla (o si todavía no se sabe). */
export function usePaneVisible(id: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      paneListeners.add(cb)
      return () => paneListeners.delete(cb)
    },
    () => paneVisible.get(id) ?? true
  )
}
