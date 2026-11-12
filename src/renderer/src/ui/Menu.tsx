import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { keyToMove, moveIndex, typeaheadIndex } from './nav'
import './ui.css'

type ActionItem = { type?: 'item'; id: string; label: string; icon?: ReactNode; shortcut?: string; danger?: boolean; disabled?: boolean; onSelect: () => void }
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

export function Menu({ trigger, items, align = 'end', ...rest }: MenuProps): React.JSX.Element {
  const id = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const typed = useRef({ text: '', at: 0 })

  const actions = items.filter((it): it is ActionItem => it.type !== 'separator')
  const labels = actions.map((a) => a.label)
  const isDis = (i: number): boolean => !!actions[i].disabled

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    setPos(null)
    if (returnFocus) triggerRef.current?.focus()
  }, [])

  const focusItem = (i: number): void => {
    popRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[i]?.focus()
  }

  useLayoutEffect(() => {
    const a = triggerRef.current
    const p = popRef.current
    if (!open || !a || !p) return
    const r = a.getBoundingClientRect()
    const w = p.offsetWidth
    const h = p.offsetHeight
    let top = r.bottom + 4
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4)
    const left = Math.min(Math.max(8, align === 'end' ? r.right - w : r.left), window.innerWidth - w - 8)
    setPos({ left, top })
  }, [open, align])

  const placed = pos !== null
  useEffect(() => {
    if (!open || !placed) return
    const first = moveIndex(actions.length, -1, 'next', isDis)
    if (first >= 0) focusItem(first)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, placed])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!popRef.current?.contains(t) && !triggerRef.current?.contains(t)) close(false)
    }
    const onBlur = (): void => close(false)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('blur', onBlur)
    }
  }, [open, close])

  const onPopKey = (e: KeyboardEvent): void => {
    const cur = [...(popRef.current?.querySelectorAll('[role="menuitem"]') ?? [])].indexOf(document.activeElement as Element)
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
      return
    }
    if (e.key === 'Tab') {
      close(false)
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

  const props: MenuTriggerProps = {
    ref: triggerRef,
    onClick: () => (open ? close(false) : setOpen(true)),
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
        <div
          ref={popRef}
          id={id}
          role="menu"
          aria-label={rest['aria-label']}
          className="ui-menu"
          style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
          onKeyDown={onPopKey}
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
                  close(true)
                  it.onSelect()
                }}
              >
                {it.icon && (
                  <span className="ui-menu-icon" aria-hidden="true">
                    {it.icon}
                  </span>
                )}
                <span className="ui-menu-label">{it.label}</span>
                {it.shortcut && <kbd className="ui-menu-kbd">{it.shortcut}</kbd>}
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}
