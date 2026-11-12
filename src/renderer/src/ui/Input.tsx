import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { ChevronDownIcon } from '../icons/SlothIcons'
import './ui.css'

interface FieldProps {
  /** Texto de error: pinta el borde y se lee junto con el campo (`aria-describedby`). */
  error?: string
  size?: 'sm' | 'md'
}

const cx = (...c: (string | false | undefined)[]): string => c.filter(Boolean).join(' ')

function FieldError({ id, error }: { id?: string; error?: string }): React.JSX.Element | null {
  return error ? (
    <span id={id} className="ui-field-error">
      {error}
    </span>
  ) : null
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'className' | 'prefix'>, FieldProps {
  /** Ícono o prefijo dentro del campo, a la izquierda. */
  prefix?: ReactNode
  /** Algo a la derecha (botón de limpiar, unidad). */
  suffix?: ReactNode
  className?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ error, size = 'md', prefix, suffix, className, id, ...rest }, ref) {
  const auto = useId()
  const errId = error ? `${id ?? auto}-err` : undefined
  return (
    <span className={cx('ui-field', className)}>
      <span className={cx('ui-input-wrap', `ui-input-wrap--${size}`, !!error && 'is-invalid', !!rest.disabled && 'is-disabled')}>
        {prefix && (
          <span className="ui-input-affix" aria-hidden="true">
            {prefix}
          </span>
        )}
        <input
          {...rest}
          id={id}
          ref={ref}
          className="ui-input"
          aria-invalid={error ? true : undefined}
          aria-describedby={[errId, rest['aria-describedby']].filter(Boolean).join(' ') || undefined}
        />
        {suffix && <span className="ui-input-affix">{suffix}</span>}
      </span>
      <FieldError id={errId} error={error} />
    </span>
  )
})

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'>, FieldProps {
  className?: string
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ error, size: _size, className, id, ...rest }, ref) {
  const auto = useId()
  const errId = error ? `${id ?? auto}-err` : undefined
  return (
    <span className={cx('ui-field', className)}>
      <span className={cx('ui-input-wrap', 'ui-input-wrap--area', !!error && 'is-invalid', !!rest.disabled && 'is-disabled')}>
        <textarea {...rest} id={id} ref={ref} className="ui-input ui-textarea" aria-invalid={error ? true : undefined} aria-describedby={errId} />
      </span>
      <FieldError id={errId} error={error} />
    </span>
  )
})

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size' | 'className' | 'children'>, FieldProps {
  options: SelectOption[]
  className?: string
}

/** `<select>` nativo con aspecto propio: conserva teclado, escritura rápida y lectores, y se ve igual en todos los temas. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ options, error, size = 'md', className, id, ...rest }, ref) {
  const auto = useId()
  const errId = error ? `${id ?? auto}-err` : undefined
  return (
    <span className={cx('ui-field', className)}>
      <span className={cx('ui-input-wrap', `ui-input-wrap--${size}`, !!error && 'is-invalid', !!rest.disabled && 'is-disabled')}>
        <select {...rest} id={id} ref={ref} className="ui-input ui-select" aria-invalid={error ? true : undefined} aria-describedby={errId}>
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="ui-select-chevron" aria-hidden="true">
          <ChevronDownIcon size={14} />
        </span>
      </span>
      <FieldError id={errId} error={error} />
    </span>
  )
})
