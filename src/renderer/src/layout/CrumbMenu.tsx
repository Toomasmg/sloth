import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDownIcon } from '../icons/SlothIcons'

/** Una opción del menú de la ruta: cuerpo libre (ícono, nombre, rama, estado) y la acción al elegirla. */
export interface CrumbItem {
  id: string
  /** Es lo que está abierto ahora: se marca y el foco arranca ahí. */
  current?: boolean
  body: ReactNode
  onSelect(): void
}

/** Grupo con título (en el menú de cuentas, cada cuenta con sus espacios). */
export interface CrumbGroup {
  id: string
  title: string
  items: CrumbItem[]
  empty: string
}

/**
 * Parte de la ruta «Cuenta › Espacio» que abre un menú desplegable. Mismo comportamiento que el menú «más»
 * del panel (PaneMenu): se cierra con Escape, Tab o clic afuera; las flechas, Inicio y Fin se mueven entre
 * opciones. Al elegir una, vuelve el foco al botón de la ruta.
 */
export function CrumbMenu({
  label,
  trigger,
  groups,
  emptyText
}: {
  /** Nombre accesible del botón (con lo que está abierto ahora). */
  label: string
  /** Texto visible de la parte de la ruta. */
  trigger: ReactNode
  groups: CrumbGroup[]
  emptyText: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const id = useId()
  const wrapRef = useRef<HTMLSpanElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"][aria-current="true"]') ?? menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')
    first?.focus()
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
    if (e.key === 'Tab') {
      // Tab cierra el menú y deja el foco en la ruta (el menú se desmonta, no debe quedarse con el foco).
      e.preventDefault()
      setOpen(false)
      btnRef.current?.focus()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
    if (!items.length) return
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    e.preventDefault()
    const j =
      e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
    items[j].focus()
  }

  return (
    <span ref={wrapRef} className="crumb-menu-wrap">
      <button
        ref={btnRef}
        type="button"
        className={`sl-crumb-btn ${open ? 'on' : ''}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="sl-crumb-text">{trigger}</span>
        <ChevronDownIcon size={12} />
      </button>
      {open && (
        <div ref={menuRef} id={id} className="pane-menu crumb-menu" role="menu" aria-label={label} onKeyDown={onMenuKey}>
          {groups.map((g) => (
            <div key={g.id} role="group" aria-label={g.title} className="crumb-menu-group">
              <div role="presentation" className="crumb-menu-title">
                {g.title}
              </div>
              {g.items.length === 0 && (
                <div role="none" className="crumb-menu-empty">
                  {g.empty}
                </div>
              )}
              {g.items.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  role="menuitem"
                  aria-current={it.current ? 'true' : undefined}
                  className={`pane-menu-item crumb-menu-item ${it.current ? 'current' : ''}`}
                  onClick={() => {
                    setOpen(false)
                    it.onSelect()
                    btnRef.current?.focus()
                  }}
                >
                  {it.body}
                </button>
              ))}
            </div>
          ))}
          {groups.length === 0 && (
            <div role="none" className="crumb-menu-empty">
              {emptyText}
            </div>
          )}
        </div>
      )}
    </span>
  )
}
