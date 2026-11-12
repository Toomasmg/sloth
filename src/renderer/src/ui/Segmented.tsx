import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { keyToMove, moveIndex } from './nav'
import './ui.css'

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  icon?: ReactNode
  disabled?: boolean
  /** Nombre accesible cuando `label` es solo un ícono. */
  ariaLabel?: string
}

export interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  'aria-label': string
  size?: 'sm' | 'md'
  disabled?: boolean
}

export function Segmented<T extends string>({ options, value, onChange, size = 'md', disabled, ...rest }: SegmentedProps<T>): React.JSX.Element {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const current = options.findIndex((o) => o.value === value)

  const onKeyDown = (e: KeyboardEvent): void => {
    const move = keyToMove(e.key, 'horizontal') ?? keyToMove(e.key, 'vertical')
    if (!move) return
    const i = moveIndex(options.length, current, move, (k) => !!options[k].disabled)
    if (i < 0) return
    e.preventDefault()
    onChange(options[i].value)
    refs.current[i]?.focus()
  }

  return (
    <div role="radiogroup" aria-label={rest['aria-label']} className={`ui-seg ui-seg--${size}`} onKeyDown={onKeyDown}>
      {options.map((o, i) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={o.ariaLabel}
            tabIndex={on || (current < 0 && i === 0) ? 0 : -1}
            disabled={disabled || o.disabled}
            className={`ui-seg-item${on ? ' is-on' : ''}`}
            onClick={() => onChange(o.value)}
          >
            {o.icon}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
