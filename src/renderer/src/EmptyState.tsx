import { LogoMark } from './Logo'

/**
 * Estado vacío / bienvenida (sin paneles abiertos). v0.5 (tarea T6): fondo animado sutil con las
 * órbitas del logo, solo CSS/SVG; pausado con la ventana oculta (.shell.doc-hidden) y con
 * prefers-reduced-motion. Nunca se monta con paneles abiertos (lo decide App).
 */
export function EmptyState({ hasAccounts, hasWs }: { hasAccounts: boolean; hasWs: boolean }): React.JSX.Element {
  const steps = [
    { done: hasAccounts, title: 'Agregá tus cuentas', text: 'Cada una se abre en su propia carpeta para iniciar sesión.' },
    { done: hasWs, title: 'Creá un espacio', text: 'Un repo y una cuenta, o directo desde un ticket.' },
    { done: false, title: 'Abrí varios en paralelo', text: 'Cada uno en su PowerShell, con su estado en vivo.' }
  ]
  return (
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
  )
}
