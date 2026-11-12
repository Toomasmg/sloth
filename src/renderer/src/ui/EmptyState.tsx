import type { ReactNode } from 'react'
import './ui.css'

export interface EmptyStateProps {
  icon?: ReactNode
  title: string
  /** Una frase: qué pasa y qué hacer. */
  description?: ReactNode
  /** Una sola acción, un `Button` primario. */
  action?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  /** Etiqueta del título; `h2` salvo que la vista ya tenga uno. */
  as?: 'h2' | 'h3' | 'p'
}

export function EmptyState({ icon, title, description, action, size = 'md', as: Heading = 'h2' }: EmptyStateProps): React.JSX.Element {
  return (
    <div className={`ui-empty ui-empty--${size}`}>
      {icon && (
        <div className="ui-empty-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <Heading className="ui-empty-title">{title}</Heading>
      {description && <p className="ui-empty-desc">{description}</p>}
      {action && <div className="ui-empty-action">{action}</div>}
    </div>
  )
}
