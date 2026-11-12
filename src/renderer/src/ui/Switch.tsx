import type { ReactNode } from 'react'
import './ui.css'

export interface SwitchProps {
  checked: boolean
  onChange: (value: boolean) => void
  /** Texto visible al lado. Sin él, pasá `aria-label`. */
  children?: ReactNode
  'aria-label'?: string
  disabled?: boolean
  id?: string
}

export function Switch({ checked, onChange, children, disabled, id, ...rest }: SwitchProps): React.JSX.Element {
  return (
    <button type="button" role="switch" id={id} aria-checked={checked} aria-label={rest['aria-label']} disabled={disabled} className="ui-switch" onClick={() => onChange(!checked)}>
      <span className={`ui-switch-track${checked ? ' is-on' : ''}`} aria-hidden="true">
        <span className="ui-switch-knob" />
      </span>
      {children != null && <span className="ui-switch-label">{children}</span>}
    </button>
  )
}
