import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react'

export interface ActionMenuItem {
  id: string
  label: string
  /** Texto a la derecha (p. ej. el atajo «F2»). */
  hint?: string
  icon?: ReactNode
  danger?: boolean
  /** Separador visual antes de este ítem. */
  sepBefore?: boolean
  onSelect(): void
}

/**
 * Botón con menú desplegable (el «más» de cada panel y el menú de la app). Se cierra con Escape o clic
 * afuera; las flechas se mueven entre opciones. El disparador lleva `aria-haspopup` y `aria-expanded`.
 */
export function ActionMenu({
  label,
  items,
  trigger,
  triggerClassName,
  triggerTitle,
  wrapClassName,
  menuClassName
}: {
  /** Nombre accesible del disparador y del menú. */
  label: string
  items: ActionMenuItem[]
  /** Contenido del disparador (ícono, logo, texto…). */
  trigger: ReactNode
  triggerClassName: string
  triggerTitle?: string
  wrapClassName: string
  /** Clase del panel; por defecto el del menú «más» de los paneles. */
  menuClassName?: string
}): React.JSX.Element {
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

  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const btns = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    if (!btns.length) return
    const i = btns.indexOf(document.activeElement as HTMLButtonElement)
    e.preventDefault()
    const j = e.key === 'ArrowDown' ? (i + 1) % btns.length : (i - 1 + btns.length) % btns.length
    btns[j].focus()
  }

  return (
    <span ref={wrapRef} className={wrapClassName}>
      <button
        ref={btnRef}
        type="button"
        className={`${triggerClassName} ${open ? 'on' : ''}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        title={triggerTitle ?? label}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </button>
      {open && (
        <div ref={menuRef} id={id} className={menuClassName ?? 'pane-menu'} role="menu" aria-label={label} onKeyDown={onMenuKey}>
          {items.map((it) => (
            <Fragment key={it.id}>
              {it.sepBefore && <div className="pane-menu-sep" role="separator" />}
              <button
                type="button"
                role="menuitem"
                className={`pane-menu-item ${it.danger ? 'danger' : ''}`}
                onClick={() => {
                  setOpen(false)
                  it.onSelect()
                }}
              >
                {it.icon && <span className="pane-menu-ico">{it.icon}</span>}
                <span className="pane-menu-label">{it.label}</span>
                {it.hint && <span className="pane-menu-hint">{it.hint}</span>}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </span>
  )
}
