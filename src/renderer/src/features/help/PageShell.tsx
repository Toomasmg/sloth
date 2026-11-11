import { useEffect, useRef, type ReactNode } from 'react'
import { captureOpener } from '../../return-focus'
import { FOCUSABLE, nextFocusIndex } from '../../focus-trap'
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
  backLabel,
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
  const rootRef = useRef<HTMLDivElement>(null)

  const trapTab = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab' || e.defaultPrevented || !rootRef.current) return
    const list = [...rootRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0)
    const i = nextFocusIndex(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey)
    if (i < 0) return
    e.preventDefault()
    list[i].focus()
  }

  useEffect(() => {
    const restore = captureOpener()
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
      restore()
    }
  }, [])

  return (
    <div ref={rootRef} className={`page-shell ${className ?? ''}`} role="dialog" aria-modal="true" aria-labelledby={labelId} onKeyDown={trapTab}>
      <header className="page-head">
        <button ref={backRef} type="button" className="page-back" aria-label={backLabel ? undefined : 'Volver a los espacios'} title="Volver (Esc)" onClick={() => closeRef.current()}>
          {backLabel ?? '‹ Espacios'}
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
