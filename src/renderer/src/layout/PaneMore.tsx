import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { DotsThree } from '@phosphor-icons/react'

/**
 * Grupo «Más» del header de un panel. En paneles angostos (container query en layout.css) los
 * botones secundarios se esconden detrás de este botón y aparecen en un menú; en anchos quedan en
 * línea (display: contents). Los hijos siempre están montados, así que no pierden estado.
 */
export function PaneMore({ children }: { children: ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const id = useId()
  const wrapRef = useRef<HTMLSpanElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
    const onDown = (e: PointerEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
      btnRef.current?.focus()
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <span ref={wrapRef} className="pane-more-wrap">
      <button
        ref={btnRef}
        type="button"
        className="icon-btn pane-more-trigger"
        aria-label="Más acciones del panel"
        aria-expanded={open}
        aria-controls={id}
        title="Más acciones"
        onClick={() => setOpen((o) => !o)}
      >
        <DotsThree size={16} weight="bold" aria-hidden="true" />
      </button>
      <div
        ref={menuRef}
        id={id}
        role="group"
        aria-label="Más acciones del panel"
        className={`pane-more${open ? ' open' : ''}`}
        onClickCapture={(e) => {
          if (!(e.target as HTMLElement).closest('button')) return
          // Si el foco estaba dentro del menú, vuelve al botón «Más» antes de que la acción abra algo.
          if (menuRef.current?.contains(document.activeElement)) btnRef.current?.focus()
          setOpen(false)
        }}
      >
        {children}
      </div>
    </span>
  )
}
