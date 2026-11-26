import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { buttonClass, type ButtonSize, type ButtonVariant } from './button-class'
import { loadingClick } from './loading-click'
import './ui.css'

export type { ButtonSize, ButtonVariant }

interface ButtonBase extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant
  className?: string
}

export interface UiButtonProps extends ButtonBase {
  look?: 'ui'
  size?: ButtonSize
  /** Ícono antes del texto. */
  icon?: ReactNode
  /** Atajo que se muestra dentro del botón, ya formateado (ej. «Ctrl+Enter»). */
  kbd?: string
  /** Mientras algo se hace: no responde a clics ni envía su form, muestra un indicador y avisa a los lectores. */
  loading?: boolean
  block?: boolean
}

/**
 * Aspecto de los botones que se escribían a mano con la clase `btn` (styles.css y themes.css).
 * Se ve distinto de `ui` (altura, relleno, anillo y colores); queda como look aparte hasta que se decida uno solo.
 */
export interface ClassicButtonProps extends ButtonBase {
  look: 'classic'
  size?: 'sm' | 'md'
}

/** Aspecto propio de la función git (git.css): más bajo y con su anillo. Variantes: primary = solid, secondary = plain. */
export interface GitButtonProps extends ButtonBase {
  look: 'git'
}

export type ButtonProps = UiButtonProps | ClassicButtonProps | GitButtonProps

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(props, ref) {
  if (props.look === 'classic') {
    const { look, variant = 'secondary', size = 'md', className, type = 'button', ...attrs } = props
    return <button {...attrs} ref={ref} type={type} className={buttonClass({ look, variant, size, className })} />
  }
  if (props.look === 'git') {
    const { look, variant = 'secondary', className, type = 'button', ...attrs } = props
    return <button {...attrs} ref={ref} type={type} className={buttonClass({ look, variant, size: 'md', className })} />
  }
  const { variant = 'secondary', size = 'md', icon, kbd, loading, block, className, children, disabled, onClick, type = 'button', 'aria-busy': ariaBusy, ...rest } = props
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={buttonClass({ look: 'ui', variant, size, block, loading, className })}
      disabled={disabled}
      aria-busy={loading || ariaBusy}
      aria-disabled={loading || undefined}
      onClick={loadingClick(loading, onClick)}
    >
      {loading ? <span className="ui-spinner" aria-hidden="true" /> : icon}
      {children != null && <span className="ui-btn-label">{children}</span>}
      {kbd && !loading && <kbd className="ui-btn-kbd">{kbd}</kbd>}
    </button>
  )
})
