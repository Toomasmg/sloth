import { useEffect, useRef, type ReactNode } from 'react'
import { captureOpener } from '../return-focus'
import './SidePanel.css'

// Paneles laterales abiertos y su ancho: la grilla (y la Vista) se corren a la izquierda para no quedar tapadas.
const openWidths = new Map<symbol, number>()
function syncPush(): void {
  const w = Math.max(0, ...openWidths.values())
  if (w) document.documentElement.style.setProperty('--side-panel-w', `${w}px`)
  else document.documentElement.style.removeProperty('--side-panel-w')
}

export interface SidePanelProps {
  labelId: string
  title: ReactNode
  onClose: () => void
  /** Acciones de la cabecera, antes de la X. */
  actions?: ReactNode
  /** Ancho en px (por defecto 400). */
  width?: number
  className?: string
  children: ReactNode
}

/**
 * Panel a la derecha que acompaña a la terminal: no es modal (sin fondo que tape, sin trampa de
 * foco), empuja los paneles en vez de taparlos y tiene su X visible. Esc lo cierra solo si el foco está adentro: con el foco en la
 * terminal, Esc es de Claude.
 */
export function SidePanel({ labelId, title, onClose, actions, width = 400, className, children }: SidePanelProps): React.JSX.Element {
  const rootRef = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const key = Symbol('side-panel')
    openWidths.set(key, width)
    syncPush()
    return () => {
      openWidths.delete(key)
      syncPush()
    }
  }, [width])

  useEffect(() => {
    const restore = captureOpener()
    // Foco adentro al abrir, sin pisar lo que el contenido ya haya enfocado (un campo, p. ej.).
    if (!rootRef.current?.contains(document.activeElement)) rootRef.current?.querySelector<HTMLElement>('.ui-side-x')?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (!rootRef.current?.contains(document.activeElement)) return
      e.preventDefault()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      restore()
    }
  }, [])

  return (
    <aside ref={rootRef} className={`ui-side ${className ?? ''}`} style={{ width }} role="dialog" aria-modal="false" aria-labelledby={labelId}>
      <header className="ui-side-head">
        <h2 className="ui-side-title" id={labelId}>
          {title}
        </h2>
        <span className="ui-side-grow" />
        {actions}
        <button type="button" className="ui-side-x" aria-label="Cerrar panel" title="Cerrar (Esc)" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>
      <div className="ui-side-body">{children}</div>
    </aside>
  )
}
