import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { keyToMove, moveIndex, typeaheadIndex } from './nav'
import './ui.css'

type ActionItem = {
  type?: 'item'
  id: string
  label: string
  icon?: ReactNode
  shortcut?: string
  /** Aclaración corta a la derecha («la terminal sigue»). */
  hint?: string
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}
export type MenuItem = { type: 'separator' } | ActionItem

export interface MenuTriggerProps {
  ref: Ref<HTMLButtonElement>
  onClick: () => void
  onKeyDown: (e: KeyboardEvent) => void
  'aria-haspopup': 'menu'
  'aria-expanded': boolean
  'aria-controls'?: string
}

export interface MenuProps {
  /** Dibuja el disparador; hay que esparcirle las props (`<IconButton {...p} />`). */
  trigger: (p: MenuTriggerProps) => ReactNode
  items: MenuItem[]
  align?: 'start' | 'end'
  'aria-label': string
}

type Anchor = { kind: 'rect'; rect: DOMRect; align: 'start' | 'end' } | { kind: 'point'; x: number; y: number }

/** Lista flotante con teclado (flechas, Inicio/Fin, letras), Esc y clic afuera. La comparten Menu y ContextMenu. */
function MenuPopup({
  id,
  items,
  label,
  anchor,
  ignore,
  onClose
}: {
  id?: string
  items: MenuItem[]
  label: string
  anchor: () => Anchor | null
  /** Un clic ahí no cierra: es el disparador, que ya alterna solo. */
  ignore?: () => HTMLElement | null
  onClose: (returnFocus: boolean) => void
}): React.JSX.Element {
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const typed = useRef({ text: '', at: 0 })
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const ignoreRef = useRef(ignore)
  ignoreRef.current = ignore

  const actions = items.filter((it): it is ActionItem => it.type !== 'separator')
  const labels = actions.map((a) => a.label)
  const isDis = (i: number): boolean => !!actions[i].disabled
  const focusItem = (i: number): void => {
    popRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[i]?.focus()
  }

  useLayoutEffect(() => {
    const p = popRef.current
    const a = anchor()
    if (!p || !a) return
    const w = p.offsetWidth
    const h = p.offsetHeight
    let left: number
    let top: number
    if (a.kind === 'rect') {
      top = a.rect.bottom + 4
      if (top + h > window.innerHeight - 8) top = Math.max(8, a.rect.top - h - 4)
      left = a.align === 'end' ? a.rect.right - w : a.rect.left
    } else {
      left = a.x
      top = a.y + h > window.innerHeight - 8 ? Math.max(8, a.y - h) : a.y
    }
    setPos({ left: Math.min(Math.max(8, left), window.innerWidth - w - 8), top })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const placed = pos !== null
  useEffect(() => {
    if (!placed) return
    const first = moveIndex(actions.length, -1, 'next', isDis)
    if (first >= 0) focusItem(first)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || ignoreRef.current?.()?.contains(t)) return
      closeRef.current(false)
    }
    const onBlur = (): void => closeRef.current(false)
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  const onPopKey = (e: KeyboardEvent): void => {
    const cur = [...(popRef.current?.querySelectorAll('[role="menuitem"]') ?? [])].indexOf(document.activeElement as Element)
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose(true)
      return
    }
    if (e.key === 'Tab') {
      onClose(false)
      return
    }
    const move = keyToMove(e.key, 'vertical')
    if (move) {
      e.preventDefault()
      const i = moveIndex(actions.length, cur, move, isDis)
      if (i >= 0) focusItem(i)
      return
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now()
      typed.current = { text: now - typed.current.at < 700 ? typed.current.text + e.key : e.key, at: now }
      const i = typeaheadIndex(labels, cur, typed.current.text, isDis)
      if (i >= 0) focusItem(i)
    }
  }

  // Al body: la cabecera de un panel tiene `container-type` y `overflow: hidden`, que encerrarían y cortarían un `fixed`.
  return createPortal(
    <div
      ref={popRef}
      id={id}
      role="menu"
      aria-label={label}
      className="ui-menu"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      onKeyDown={onPopKey}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, k) => {
        if (it.type === 'separator') return <div key={`s${k}`} role="separator" className="ui-menu-sep" />
        return (
          <button
            key={it.id}
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={it.disabled}
            className={`ui-menu-item${it.danger ? ' is-danger' : ''}`}
            onClick={() => {
              onClose(true)
              it.onSelect()
            }}
          >
            {it.icon && (
              <span className="ui-menu-icon" aria-hidden="true">
                {it.icon}
              </span>
            )}
            <span className="ui-menu-label">{it.label}</span>
            {it.hint && <span className="ui-menu-hint">{it.hint}</span>}
            {it.shortcut && <kbd className="ui-menu-kbd">{it.shortcut}</kbd>}
          </button>
        )
      })}
    </div>,
    document.body
  )
}

export function Menu({ trigger, items, align = 'end', ...rest }: MenuProps): React.JSX.Element {
  const id = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }, [])

  const props: MenuTriggerProps = {
    ref: triggerRef,
    onClick: () => setOpen((o) => !o),
    onKeyDown: (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setOpen(true)
      }
    },
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? id : undefined
  }

  return (
    <>
      {trigger(props)}
      {open && (
        <MenuPopup
          id={id}
          items={items}
          label={rest['aria-label']}
          anchor={() => {
            const r = triggerRef.current?.getBoundingClientRect()
            return r ? { kind: 'rect', rect: r, align } : null
          }}
          ignore={() => triggerRef.current}
          onClose={close}
        />
      )}
    </>
  )
}

export interface ContextMenuProps {
  x: number
  y: number
  items: MenuItem[]
  'aria-label': string
  /** `returnFocus`: se cerró con Esc o eligiendo algo; el que lo abrió recupera el foco. */
  onClose: (returnFocus: boolean) => void
}

/** Menú en un punto (clic derecho o Shift+F10). Controlado: lo monta y desmonta quien lo abre. */
export function ContextMenu({ x, y, items, onClose, ...rest }: ContextMenuProps): React.JSX.Element {
  return <MenuPopup items={items} label={rest['aria-label']} anchor={() => ({ kind: 'point', x, y })} onClose={onClose} />
}
