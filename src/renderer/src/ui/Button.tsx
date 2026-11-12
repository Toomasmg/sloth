import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { loadingClick } from './loading-click'
import './ui.css'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Ícono antes del texto. */
  icon?: ReactNode
  /** Atajo que se muestra dentro del botón, ya formateado (ej. «Ctrl+Enter»). */
  kbd?: string
  /** Mientras algo se hace: no responde a clics ni envía su form, muestra un indicador y avisa a los lectores. */
  loading?: boolean
  block?: boolean
  className?: string
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, kbd, loading, block, className, children, disabled, onClick, type = 'button', ...rest },
  ref
) {
  const cls = ['ui-btn', `ui-btn--${variant}`, `ui-btn--${size}`, block && 'ui-btn--block', loading && 'is-loading', className].filter(Boolean).join(' ')
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={cls}
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClick={loadingClick(loading, onClick)}
    >
      {loading ? <span className="ui-spinner" aria-hidden="true" /> : icon}
      {children != null && <span className="ui-btn-label">{children}</span>}
      {kbd && !loading && <kbd className="ui-btn-kbd">{kbd}</kbd>}
    </button>
  )
})
