import { useEffect, useRef, type ReactNode } from 'react'
import './page.css'

/**
 * Página a pantalla completa (Historial, Ayuda, Reportar): cabecera con «‹ Espacios» para volver,
 * Escape cierra, el foco entra al volver y regresa a donde estaba al cerrarse.
 */
export function PageShell({
  labelId,
  title,
  onClose,
  right,
  backLabel = '‹ Espacios',
  className,
  children
}: {
  labelId: string
  title: string
  onClose: () => void
  right?: ReactNode
  /** Texto del botón para volver (por defecto «‹ Espacios»). */
  backLabel?: ReactNode
  className?: string
  children: ReactNode
}): React.JSX.Element {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const backRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null
    backRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        closeRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (prev?.isConnected) prev.focus()
    }
  }, [])

  return (
    <div className={`page-shell ${className ?? ''}`} role="dialog" aria-modal="true" aria-labelledby={labelId}>
      <header className="page-head">
        <button ref={backRef} type="button" className="page-back" onClick={() => closeRef.current()}>
          {backLabel}
        </button>
        <span className="page-sep" aria-hidden="true" />
        <span className="page-name" id={labelId}>
          {title}
        </span>
        <span className="page-grow" />
        {right}
      </header>
      <div className="page-body">{children}</div>
    </div>
  )
}
