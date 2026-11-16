import { useCallback, useEffect, useRef, useState } from 'react'
import { cssMs } from './duration'

// Lo mismo que --t-exit en tokens.css. Se lee de ahí para que el CSS mande; esto es el respaldo.
const EXIT_MS = 140

function exitMs(): number {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 0
  return cssMs(getComputedStyle(document.documentElement).getPropertyValue('--t-exit')) ?? EXIT_MS
}

/**
 * Salida con animación: `leave()` marca `closing` (el CSS corre la entrada al revés) y llama a `done`
 * cuando termina. Un segundo `leave()` mientras sale no hace nada.
 */
export function useExit(done: () => void): [closing: boolean, leave: () => void] {
  const [closing, setClosing] = useState(false)
  const doneRef = useRef(done)
  doneRef.current = done
  const timer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    []
  )
  const leave = useCallback(() => {
    if (timer.current !== null) return
    const ms = exitMs()
    if (!ms) {
      doneRef.current()
      return
    }
    setClosing(true)
    timer.current = window.setTimeout(() => doneRef.current(), ms)
  }, [])
  return [closing, leave]
}
