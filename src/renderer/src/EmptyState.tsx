import { LogoMark } from './Logo'
import './empty.css'

/**
 * Estado vacío / bienvenida (sin paneles abiertos). v0.5 (tarea T6): fondo animado sutil con las
 * órbitas del logo, solo CSS/SVG; pausado con la ventana oculta (.shell.doc-hidden) y con
 * prefers-reduced-motion. Nunca se monta con paneles abiertos (lo decide App).
 */

const CX = 500
const CY = 350
/** Órbitas: radios, rotación en grados y clase (duración en empty.css). */
const ORBITS = [
  { cls: 'o1', rx: 430, ry: 150, deg: -18 },
  { cls: 'o2', rx: 380, ry: 130, deg: 35 },
  { cls: 'o3', rx: 300, ry: 110, deg: -62 }
]

/** Punto del vértice de la elipse rotada (donde va el punto que gira). */
function vertex(rx: number, deg: number): { x: number; y: number } {
  const r = (deg * Math.PI) / 180
  return { x: +(CX + rx * Math.cos(r)).toFixed(1), y: +(CY + rx * Math.sin(r)).toFixed(1) }
}

function Orbits(): React.JSX.Element {
  return (
    <svg
      className="empty-orbits"
      viewBox="0 0 1000 700"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      {ORBITS.map((o) => {
        const v = vertex(o.rx, o.deg)
        return (
          <g key={o.cls} className={`orbit ${o.cls}`}>
            <ellipse
              className="ring"
              cx={CX}
              cy={CY}
              rx={o.rx}
              ry={o.ry}
              transform={`rotate(${o.deg} ${CX} ${CY})`}
            />
            <circle className="dot" cx={v.x} cy={v.y} r={4} />
          </g>
        )
      })}
    </svg>
  )
}

export function EmptyState({ hasAccounts, hasWs }: { hasAccounts: boolean; hasWs: boolean }): React.JSX.Element {
  const steps = [
    { done: hasAccounts, title: 'Agregá tus cuentas', text: 'Cada una se abre en su propia carpeta para iniciar sesión.' },
    { done: hasWs, title: 'Creá un espacio', text: 'Un repo y una cuenta, o directo desde un ticket.' },
    { done: false, title: 'Abrí varios en paralelo', text: 'Cada uno en su PowerShell, con su estado en vivo.' }
  ]
  return (
    <div className="empty-wrap">
      <Orbits />
      <div className="empty">
        <div className="empty-logo">
          <LogoMark size={72} />
        </div>
        <h1>
          <span>Sloth</span>
        </h1>
        <p className="empty-lead">Varias cuentas de Claude, cada una en su terminal y su repo.</p>
        <ol className="steps">
          {steps.map((s, i) => (
            <li key={s.title} className={s.done ? 'done' : ''}>
              <span className="step-n" aria-hidden="true">
                {i + 1}
              </span>
              <div>
                <strong>{s.title}</strong>
                <p>{s.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
