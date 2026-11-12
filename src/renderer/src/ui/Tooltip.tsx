import { cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type Ref } from 'react'
import './ui.css'

type ChildProps = {
  ref?: Ref<HTMLElement>
  'aria-describedby'?: string
  onMouseEnter?: (e: React.MouseEvent) => void
  onMouseLeave?: (e: React.MouseEvent) => void
  onFocus?: (e: React.FocusEvent) => void
  onBlur?: (e: React.FocusEvent) => void
}

export interface TooltipProps {
  text: string
  /** Atajo que se muestra al lado, ya formateado (ej. `comboLabel('sidebar')`). */
  shortcut?: string
  placement?: 'top' | 'bottom' | 'right'
  /** Un solo elemento que reciba `ref` y los eventos de mouse y foco (un botón, un enlace). */
  children: ReactElement<ChildProps>
}

const DELAY = 450

export function Tooltip({ text, shortcut, placement = 'bottom', children }: TooltipProps): React.JSX.Element {
  const id = useId()
  const anchorRef = useRef<HTMLElement | null>(null)
  const tipRef = useRef<HTMLSpanElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  const show = useCallback((now: boolean) => {
    window.clearTimeout(timer.current)
    if (now) setOpen(true)
    else timer.current = window.setTimeout(() => setOpen(true), DELAY)
  }, [])
  const hide = useCallback(() => {
    window.clearTimeout(timer.current)
    setOpen(false)
    setPos(null)
  }, [])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') hide()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, hide])

  useLayoutEffect(() => {
    const a = anchorRef.current
    const t = tipRef.current
    if (!open || !a || !t) return
    const r = a.getBoundingClientRect()
    const w = t.offsetWidth
    const h = t.offsetHeight
    const gap = 6
    if (placement === 'right') {
      setPos({ left: r.right + gap, top: Math.min(Math.max(4, r.top + r.height / 2 - h / 2), window.innerHeight - h - 4) })
      return
    }
    let top = placement === 'top' ? r.top - h - gap : r.bottom + gap
    if (top < 4) top = r.bottom + gap
    if (top + h > window.innerHeight - 4) top = r.top - h - gap
    const left = Math.min(Math.max(4, r.left + r.width / 2 - w / 2), window.innerWidth - w - 4)
    setPos({ left, top })
  }, [open, placement, text, shortcut])

  const child = children
  return (
    <>
      {cloneElement(child, {
        // El hijo puede traer su propio ref (IconButton reenvía el suyo): se respeta además del nuestro.
        ref: (el: HTMLElement | null) => {
          anchorRef.current = el
          const own = child.props.ref
          if (typeof own === 'function') own(el)
          else if (own) (own as { current: HTMLElement | null }).current = el
        },
        'aria-describedby': open ? id : child.props['aria-describedby'],
        onMouseEnter: (e: React.MouseEvent) => {
          child.props.onMouseEnter?.(e)
          show(false)
        },
        onMouseLeave: (e: React.MouseEvent) => {
          child.props.onMouseLeave?.(e)
          hide()
        },
        onFocus: (e: React.FocusEvent) => {
          child.props.onFocus?.(e)
          if ((e.target as HTMLElement).matches(':focus-visible')) show(true)
        },
        onBlur: (e: React.FocusEvent) => {
          child.props.onBlur?.(e)
          hide()
        }
      } as Partial<ChildProps>)}
      {open && (
        <span
          ref={tipRef}
          id={id}
          role="tooltip"
          className="ui-tooltip"
          style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
        >
          {text}
          {shortcut && <kbd className="ui-tooltip-kbd">{shortcut}</kbd>}
        </span>
      )}
    </>
  )
}
