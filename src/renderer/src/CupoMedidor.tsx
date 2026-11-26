import type { CSSProperties } from 'react'
import type { Cupo } from '../../shared/cupo'
import { fmtTok } from './format'
import { WarningIcon } from './icons/SlothIcons'
import { textoCupo } from './cupo-texto'
import './cupo.css'

/** Barra fina más texto: el porcentaje y la hora van escritos, el color solo refuerza. */
export function CupoMedidor({ cupo, ahora, className }: { cupo: Cupo; ahora: number; className?: string }): React.JSX.Element {
  const t = textoCupo(cupo, ahora, fmtTok)
  const conBarra = cupo.pct !== undefined
  const aviso = cupo.nivel === 'alto' || cupo.nivel === 'lleno'
  return (
    <span className={`cupo is-${cupo.nivel}${className ? ` ${className}` : ''}`} title={t.largo}>
      {conBarra && (
        <span className="cupo-bar" aria-hidden="true">
          <span className="cupo-fill" style={{ '--cupo-pct': `${Math.min(100, cupo.pct ?? 0)}%` } as CSSProperties} />
        </span>
      )}
      <span className="cupo-txt">
        {aviso && <WarningIcon size={11} aria-hidden="true" />}
        <span aria-hidden="true">{t.corto}</span>
        <span className="sr-only">{t.etiqueta}</span>
      </span>
    </span>
  )
}
