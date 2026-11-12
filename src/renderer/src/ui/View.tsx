import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DiscardConfirm } from '../Modal'
import { captureOpener } from '../return-focus'
import { FOCUSABLE, nextFocusIndex } from '../focus-trap'
import './View.css'

export interface ViewProps {
  /** id del título: la Vista se nombra con él (`aria-labelledby`). */
  labelId: string
  title: ReactNode
  /** Vuelve a Espacios. Lo llaman el botón de volver y Esc. */
  onClose: () => void
  /** Acciones de la cabecera, a la derecha del título. */
  actions?: ReactNode
  /** Texto del botón de volver (por defecto «Espacios»). */
  backLabel?: string
  /** Con cambios sin guardar, volver pregunta antes de descartar. */
  dirty?: boolean
  /** El cuerpo no scrollea ni se apila: el contenido arma su propio layout (p. ej. Ajustes). */
  flush?: boolean
  className?: string
  children: ReactNode
}

/**
 * Destino a pantalla completa debajo de la barra superior: cabecera con volver, título y acciones;
 * Esc vuelve; el foco entra al abrir y regresa a donde estaba al salir; Tab queda adentro.
 * Las terminales siguen vivas detrás.
 */
export function View({ labelId, title, onClose, actions, backLabel = 'Espacios', dirty, flush, className, children }: ViewProps): React.JSX.Element {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const dirtyRef = useRef(false)
  dirtyRef.current = !!dirty
  const [asking, setAsking] = useState(false)
  const request = (): void => {
    if (dirtyRef.current) setAsking(true)
    else closeRef.current()
  }
  const requestRef = useRef(request)
  requestRef.current = request
  const rootRef = useRef<HTMLDivElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)

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
    // Si el contenido ya tomó el foco al montarse (p. ej. el título de Ajustes), se respeta.
    if (!rootRef.current?.contains(document.activeElement)) backRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        requestRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      restore()
    }
  }, [])

  return (
    <div ref={rootRef} className={`ui-view ${className ?? ''}`} role="dialog" aria-modal="true" aria-labelledby={labelId} onKeyDown={trapTab}>
      <header className="ui-view-head">
        <button ref={backRef} type="button" className="ui-view-back" title="Volver (Esc)" onClick={request}>
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 5l-7 7 7 7" />
          </svg>
          {backLabel}
        </button>
        <span className="ui-view-sep" aria-hidden="true" />
        <h1 className="ui-view-title" id={labelId}>
          {title}
        </h1>
        <span className="ui-view-grow" />
        {actions && <div className="ui-view-actions">{actions}</div>}
      </header>
      <div className={`ui-view-body ${flush ? 'flush' : ''}`}>{children}</div>
      {asking && <DiscardConfirm onKeep={() => setAsking(false)} onDiscard={() => closeRef.current()} />}
    </div>
  )
}
