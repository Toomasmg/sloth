import type { ReactNode } from 'react'
import './page.css'

export interface PageHeadProps {
  /** id del h1, por si la página lo referencia (`aria-labelledby`). */
  titleId?: string
  title: ReactNode
  description?: ReactNode
  /** Acciones de la página, a la derecha del título. */
  actions?: ReactNode
}

/**
 * Encabezado de una página grande: título, bajada y acciones. El texto lleva `ui-intro`, así que con poca altura
 * se esconde a la vista (queda para el lector de pantalla) y las acciones suben.
 */
export function PageHead({ titleId, title, description, actions }: PageHeadProps): React.JSX.Element {
  return (
    <header className="ui-page-head">
      <div className="ui-page-head-text ui-intro">
        <h1 id={titleId} className="ui-page-title">
          {title}
        </h1>
        {description && <p className="ui-page-desc">{description}</p>}
      </div>
      {actions && <div className="ui-page-actions">{actions}</div>}
    </header>
  )
}
