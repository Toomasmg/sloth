import type { ReactNode } from 'react'
import { StateIcon } from '../StateIcon'
import { STATE_LABEL } from '../format'
import type { AgentState } from '../../../shared/types'
import './ui.css'

export type Tone = 'neutral' | 'accent' | 'working' | 'waiting' | 'done' | 'danger' | 'team'

/** Número en una pastilla (no leídos, pendientes). Con 0 no se dibuja; pasado `max` muestra «99+». */
export function Badge({ count, max = 99, tone = 'neutral', 'aria-label': ariaLabel }: { count: number; max?: number; tone?: Tone; 'aria-label'?: string }): React.JSX.Element | null {
  if (count <= 0) return null
  return (
    <span className={`ui-badge ui-tone--${tone}`} aria-label={ariaLabel}>
      {count > max ? `${max}+` : count}
    </span>
  )
}

/** Identificador o dato corto, en mono por defecto (TCK-123, plan, rama). */
export function Tag({ children, tone = 'neutral', mono = true, title }: { children: ReactNode; tone?: Tone; mono?: boolean; title?: string }): React.JSX.Element {
  return (
    <span className={`ui-tag ui-tone--${tone}${mono ? ' is-mono' : ''}`} title={title}>
      {children}
    </span>
  )
}

export interface ChipProps {
  children: ReactNode
  /** Filtro activo (aria-pressed). */
  selected?: boolean
  onClick?: () => void
  /** Con esto el chip se puede sacar: muestra una X con su propio botón. */
  onRemove?: () => void
  removeLabel?: string
  'aria-label'?: string
  count?: number
  icon?: ReactNode
  disabled?: boolean
}

export function Chip({ children, selected, onClick, onRemove, removeLabel = 'Quitar', count, icon, disabled, ...rest }: ChipProps): React.JSX.Element {
  return (
    <span className={`ui-chip${selected ? ' is-on' : ''}${disabled ? ' is-disabled' : ''}`}>
      <button type="button" className="ui-chip-main" aria-label={rest['aria-label']} aria-pressed={selected === undefined ? undefined : selected} disabled={disabled} onClick={onClick}>
        {icon}
        {children}
        {count != null && <span className="ui-chip-count">{count}</span>}
      </button>
      {onRemove && (
        <button type="button" className="ui-chip-x" aria-label={`${removeLabel} ${typeof children === 'string' ? children : ''}`.trim()} disabled={disabled} onClick={onRemove}>
          ×
        </button>
      )}
    </span>
  )
}

/** Estado de Claude: forma, color y texto (nunca solo color). Con `label` muestra el nombre al lado. */
export function StatusGlyph({ state, size = 14, label }: { state?: AgentState; size?: number; label?: boolean }): React.JSX.Element {
  const name = state ? STATE_LABEL[state] : 'Sin estado'
  return (
    <span className="ui-glyph" role={label ? undefined : 'img'} aria-label={label ? undefined : name}>
      <StateIcon state={state} size={size} />
      {label && <span className="ui-glyph-label">{name}</span>}
    </span>
  )
}
