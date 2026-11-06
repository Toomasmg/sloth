import { useId } from 'react'
import { CHANGELOG } from '../../shared/changelog'

/**
 * Marca de Sloth: dos órbitas (tus cuentas) alrededor de un núcleo con el prompt.
 * Los colores salen de tokens (--logo-*, en themes.css) para que se lean en claro y en oscuro.
 */
export function LogoMark({ size = 28 }: { size?: number }): React.JSX.Element {
  const gid = useId()
  const stroke = `url(#${gid})`
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--logo-1, #9FEAF9)' }} />
          <stop offset="1" style={{ stopColor: 'var(--logo-2, #47848F)' }} />
        </linearGradient>
      </defs>
      <ellipse cx="16" cy="16" rx="13" ry="5.2" transform="rotate(-30 16 16)" fill="none" stroke={stroke} strokeWidth="1.7" />
      <ellipse cx="16" cy="16" rx="13" ry="5.2" transform="rotate(30 16 16)" fill="none" stroke={stroke} strokeWidth="1.7" />
      <circle cx="27.3" cy="9.5" r="1.9" style={{ fill: 'var(--logo-1, #9FEAF9)' }} />
      <circle cx="4.7" cy="9.5" r="1.9" style={{ fill: 'var(--logo-2, #47848F)' }} />
      <rect
        x="10.5"
        y="10.5"
        width="11"
        height="11"
        rx="3"
        style={{ fill: 'var(--logo-core-fill, #1C1F29)', stroke: `var(--logo-core-stroke, ${stroke})` }}
        strokeWidth="1.4"
      />
      <path d="M14 14l2.6 2-2.6 2" fill="none" style={{ stroke: 'var(--logo-prompt, #9FEAF9)' }} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M17.6 18.6h2" style={{ stroke: 'var(--logo-prompt, #9FEAF9)' }} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

/** Versión corta para la marca («v0.5»), sacada de la última entrada de las novedades. */
const SHORT_VERSION = CHANGELOG[0]?.version.split('.').slice(0, 2).join('.') ?? ''

export function Wordmark(): React.JSX.Element {
  return (
    <div className="wordmark">
      <LogoMark />
      <div>
        <div className="wordmark-name">
          <span>Sloth</span>
        </div>
        <div className="wordmark-tag">multi-cuenta · v{SHORT_VERSION}</div>
      </div>
    </div>
  )
}
