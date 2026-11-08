import { useEffect, useRef } from 'react'
import { CloseIcon } from '../../icons/SlothIcons'

/**
 * Cáscara de modal de «help»: backdrop, role=dialog, Escape cierra y el foco vuelve a donde estaba
 * antes de abrirse.
 */
export function Dialog({
  labelId,
  title,
  icon,
  onClose,
  className,
  footer,
  children
}: {
  labelId: string
  title: string
  icon: React.ReactNode
  onClose: () => void
  className?: string
  footer?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ref.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
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
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={ref}
        tabIndex={-1}
        className={`modal f-help-modal ${className ?? ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          {icon}
          <h2 id={labelId}>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <CloseIcon size={16} />
          </button>
        </header>
        {children}
        {footer && <footer className="modal-actions">{footer}</footer>}
      </div>
    </div>
  )
}
