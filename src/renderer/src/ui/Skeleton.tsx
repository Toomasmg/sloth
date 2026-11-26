import './ui.css'

export interface SkeletonProps {
  rows?: number
  /** Lo que lee el lector de pantalla (y se ve si `showLabel`). */
  label?: string
  showLabel?: boolean
  /** `row` para filas de lista (40 px), `card` para tarjetas altas. */
  variant?: 'row' | 'card'
}

/** Esqueleto de carga: barras con un brillo que pasa unas veces y queda quieto (nada infinito en una lista). */
export function Skeleton({ rows = 4, label = 'Cargando…', showLabel = false, variant = 'row' }: SkeletonProps): React.JSX.Element {
  return (
    <div className={`ui-skel ui-skel--${variant}`} role="status" aria-busy="true">
      <span className={showLabel ? 'ui-skel-label' : 'sr-only'}>{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="ui-skel-bar" aria-hidden="true" />
      ))}
    </div>
  )
}
