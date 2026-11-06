import { useEffect, useRef, useState } from 'react'

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
