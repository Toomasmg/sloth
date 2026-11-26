export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'
export type ButtonLook = 'ui' | 'classic' | 'git'

export interface ButtonClassOptions {
  look: ButtonLook
  variant: ButtonVariant
  size: ButtonSize
  block?: boolean
  loading?: boolean
  className?: string
}

// Los botones de la función git tienen sus propias reglas (30 px, anillo propio): se llaman como las variantes.
const GIT_CLASS: Record<ButtonVariant, string> = {
  primary: 'g-btn-solid',
  secondary: 'g-btn-plain',
  ghost: 'g-btn-ghost',
  danger: 'g-btn-danger'
}

export function buttonClass({ look, variant, size, block, loading, className }: ButtonClassOptions): string {
  const own =
    look === 'git'
      ? [GIT_CLASS[variant]]
      : look === 'classic'
        ? ['btn', size === 'sm' && 'sm', variant !== 'secondary' && variant]
        : ['ui-btn', `ui-btn--${variant}`, `ui-btn--${size}`, block && 'ui-btn--block', loading && 'is-loading']
  return [...own, className].filter(Boolean).join(' ')
}
