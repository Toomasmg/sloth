import { CHANGELOG } from '../../shared/changelog'
import slothLogo from './assets/sloth-logo.png'

/**
 * Marca de Sloth: el perezoso colgado de la rama, sin fondo, para usar dentro de la app.
 * El ejecutable usa la misma ilustración sobre fondo negro (build/icon.*).
 * `size` es el alto; el ancho sale de la proporción del dibujo (más ancho que alto).
 */
export function LogoMark({ size = 28 }: { size?: number }): React.JSX.Element {
  return (
    <img
      src={slothLogo}
      alt=""
      aria-hidden="true"
      draggable={false}
      className="logo-mark"
      style={{ height: size, width: 'auto', display: 'block', flex: 'none' }}
    />
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
