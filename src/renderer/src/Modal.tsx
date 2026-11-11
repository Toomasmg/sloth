import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEventHandler, type KeyboardEventHandler, type ReactNode } from 'react'
import { CloseIcon } from './icons/SlothIcons'
import { captureOpener } from './return-focus'
import { FOCUSABLE, nextFocusIndex } from './focus-trap'

export interface ModalProps {
  title: ReactNode
  subtitle?: ReactNode
  /** Ícono o insignia antes del título. */
  icon?: ReactNode
  onClose: () => void
  /** Con cambios sin guardar, cerrar por Esc, fondo o X pregunta antes de descartar. */
  dirty?: boolean
  /** Cerrar al hacer clic en el fondo. Por defecto no: un clic suelto no debería tirar lo escrito. */
  backdropClose?: boolean
  className?: string
  headClassName?: string
  titlesClassName?: string
  /** Si viene, el diálogo es un `<form>` y esto es su submit. */
  onSubmit?: FormEventHandler<HTMLFormElement>
  onKeyDown?: KeyboardEventHandler<HTMLElement>
  children: ReactNode
}

function focusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0)
}

export function Modal(p: ModalProps): React.JSX.Element {
  const { title, subtitle, icon, onClose, dirty, backdropClose, className, headClassName, titlesClassName, onSubmit, onKeyDown, children } = p
  const titleId = useId()
  const rootRef = useRef<HTMLElement | null>(null)
  const confirmRef = useRef<HTMLDivElement>(null)
  const keepRef = useRef<HTMLButtonElement>(null)
  const [asking, setAsking] = useState(false)
  const askingRef = useRef(false)
  const dirtyRef = useRef(false)
  const closeRef = useRef(onClose)
  askingRef.current = asking
  dirtyRef.current = !!dirty
  closeRef.current = onClose

  const requestClose = (): void => {
    if (dirtyRef.current) setAsking(true)
    else closeRef.current()
  }
  const requestRef = useRef(requestClose)
  requestRef.current = requestClose

  useLayoutEffect(() => {
    const restore = captureOpener()
    const root = rootRef.current
    if (root && !root.contains(document.activeElement)) {
      const autofocus = root.querySelector<HTMLElement>('[data-autofocus]')
      ;(autofocus ?? focusables(root).find((el) => !el.classList.contains('icon-btn')) ?? root).focus()
    }
    return restore
  }, [])

  useEffect(() => {
    const layer = (): HTMLElement | null => (askingRef.current ? confirmRef.current : rootRef.current)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (askingRef.current) setAsking(false)
        else requestRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const box = layer()
      const list = focusables(box)
      e.preventDefault()
      const i = nextFocusIndex(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey)
      if (i >= 0) list[i].focus()
      else box?.focus()
    }
    const onFocusIn = (e: FocusEvent): void => {
      const box = layer()
      if (box && e.target instanceof Node && !box.contains(e.target)) (focusables(box)[0] ?? box).focus()
    }
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [])

  useEffect(() => {
    if (asking) {
      keepRef.current?.focus()
      return
    }
    const root = rootRef.current
    if (root && !root.contains(document.activeElement)) (focusables(root)[0] ?? root).focus()
  }, [asking])

  const head = (
    <header className={headClassName ?? 'modal-head'}>
      {icon}
      <div className={titlesClassName ?? 'modal-titles'}>
        <h2 id={titleId}>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <button type="button" className="icon-btn" onClick={requestClose} aria-label="Cerrar">
        <CloseIcon size={16} />
      </button>
    </header>
  )
  const common = {
    className: `modal ${className ?? ''}`,
    role: 'dialog',
    'aria-modal': true,
    'aria-labelledby': titleId,
    tabIndex: -1,
    onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
    onKeyDown
  }

  return (
    <div className="modal-backdrop" onMouseDown={backdropClose ? requestClose : undefined}>
      {onSubmit ? (
        <form {...common} ref={rootRef as React.RefObject<HTMLFormElement>} onSubmit={onSubmit}>
          {head}
          {children}
        </form>
      ) : (
        <div {...common} ref={rootRef as React.RefObject<HTMLDivElement>}>
          {head}
          {children}
        </div>
      )}
      {asking && (
        <div
          className="modal modal-confirm"
          ref={confirmRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={`${titleId}-c`}
          tabIndex={-1}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <h2 id={`${titleId}-c`} className="modal-confirm-title">
            ¿Descartar lo que escribiste?
          </h2>
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={() => closeRef.current()}>
              Descartar
            </button>
            <button type="button" className="btn primary" ref={keepRef} onClick={() => setAsking(false)}>
              Seguir editando
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
