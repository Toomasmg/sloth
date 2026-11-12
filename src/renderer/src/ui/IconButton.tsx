import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Tooltip } from './Tooltip'
import './ui.css'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children' | 'aria-label' | 'title'> {
  /** Obligatorio: es el `aria-label` y el texto del tooltip a la vez. */
  label: string
  icon: ReactNode
  shortcut?: string
  variant?: 'ghost' | 'secondary' | 'danger'
  size?: 'sm' | 'md'
  /** Para botones que alternan (panel abierto, favorito). */
  pressed?: boolean
  loading?: boolean
  className?: string
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, shortcut, variant = 'ghost', size = 'md', pressed, loading, className, onClick, type = 'button', ...rest },
  ref
) {
  const cls = ['ui-icon-btn', `ui-icon-btn--${variant}`, `ui-icon-btn--${size}`, loading && 'is-loading', className].filter(Boolean).join(' ')
  return (
    <Tooltip text={label} shortcut={shortcut}>
      <button
        {...rest}
        ref={ref}
        type={type}
        className={cls}
        aria-label={label}
        {...(pressed !== undefined && { 'aria-pressed': pressed })}
        aria-busy={loading || undefined}
        aria-disabled={loading || undefined}
        onClick={loading ? undefined : onClick}
      >
        {loading ? <span className="ui-spinner" aria-hidden="true" /> : icon}
      </button>
    </Tooltip>
  )
})
