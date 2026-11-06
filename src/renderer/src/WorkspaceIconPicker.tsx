import { useEffect, useRef } from 'react'

/** Íconos curados para los espacios (v0.5). El nombre va en el aria-label de cada botón. */
export const WORKSPACE_ICONS: { icon: string; label: string }[] = [
  { icon: '🦥', label: 'Perezoso' },
  { icon: '🚀', label: 'Cohete' },
  { icon: '🧪', label: 'Pruebas' },
  { icon: '🐛', label: 'Bug' },
  { icon: '🔥', label: 'Fuego' },
  { icon: '⭐', label: 'Estrella' },
  { icon: '📦', label: 'Paquete' },
  { icon: '🛠️', label: 'Herramientas' },
  { icon: '🎨', label: 'Diseño' },
  { icon: '📊', label: 'Métricas' },
  { icon: '🔒', label: 'Seguridad' },
  { icon: '🌐', label: 'Web' },
  { icon: '🧩', label: 'Plugin' },
  { icon: '📱', label: 'Móvil' },
  { icon: '💬', label: 'Chat' },
  { icon: '🧠', label: 'Ideas' },
  { icon: '⚙️', label: 'Configuración' },
  { icon: '📝', label: 'Notas' },
  { icon: '🗂️', label: 'Carpetas' },
  { icon: '🧹', label: 'Limpieza' },
  { icon: '🔧', label: 'Ajustes' },
  { icon: '💡', label: 'Idea' },
  { icon: '📚', label: 'Docs' },
  { icon: '🔌', label: 'Conexión' },
  { icon: '☁️', label: 'Nube' },
  { icon: '🗄️', label: 'Base de datos' },
  { icon: '🧱', label: 'Bloques' },
  { icon: '🎯', label: 'Objetivo' },
  { icon: '🏗️', label: 'Obra' },
  { icon: '🐳', label: 'Docker' },
  { icon: '🤖', label: 'Bot' },
  { icon: '📣', label: 'Anuncios' },
  { icon: '🧭', label: 'Brújula' },
  { icon: '🔍', label: 'Búsqueda' },
  { icon: '🛡️', label: 'Protección' },
  { icon: '🧾', label: 'Facturación' },
  { icon: '📈', label: 'Crecimiento' },
  { icon: '🎮', label: 'Juego' },
  { icon: '🌱', label: 'Brote' },
  { icon: '✅', label: 'Listo' }
]

const COLS = 8
const PANEL_W = 248
const PANEL_H = 230

interface Props {
  /** Nombre del espacio, para el título accesible. */
  name: string
  /** Ícono actual, si tiene: queda marcado. */
  current?: string
  /** Posición (viewport) donde se abre; se ajusta para que entre en la ventana. */
  x: number
  y: number
  /** `null` quita el ícono. */
  onPick(icon: string | null): void
  onClose(): void
}

/** Popover para elegir el ícono de un espacio. Escape o clic afuera cierran; flechas se mueven entre íconos. */
export function WorkspaceIconPicker({ name, current, x, y, onPick, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const sel = gridRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? gridRef.current?.querySelector<HTMLElement>('button')
    sel?.focus()
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) closeRef.current()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      closeRef.current()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [])

  const onGridKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const btns = [...(gridRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const i = btns.indexOf(document.activeElement as HTMLButtonElement)
    if (i < 0) return
    let j = -1
    if (e.key === 'ArrowRight') j = i + 1
    else if (e.key === 'ArrowLeft') j = i - 1
    else if (e.key === 'ArrowDown') j = i + COLS
    else if (e.key === 'ArrowUp') j = i - COLS
    else if (e.key === 'Home') j = 0
    else if (e.key === 'End') j = btns.length - 1
    else return
    e.preventDefault()
    if (j >= 0 && j < btns.length) btns[j].focus()
  }

  const left = Math.max(8, Math.min(x, window.innerWidth - PANEL_W - 8))
  const top = Math.max(8, Math.min(y, window.innerHeight - PANEL_H - 8))

  return (
    <div ref={ref} className="icon-picker" role="dialog" aria-modal="false" aria-label={`Elegir ícono de ${name}`} style={{ left, top }}>
      <div ref={gridRef} className="icon-picker-grid" role="group" aria-label="Íconos" onKeyDown={onGridKey}>
        {WORKSPACE_ICONS.map((it) => {
          const pressed = it.icon === current
          return (
            <button
              key={it.icon}
              type="button"
              aria-label={it.label}
              aria-pressed={pressed}
              title={it.label}
              onClick={() => onPick(it.icon)}
            >
              <span aria-hidden="true">{it.icon}</span>
            </button>
          )
        })}
      </div>
      <button type="button" className="btn sm icon-picker-none" onClick={() => onPick(null)}>
        Sin ícono
      </button>
    </div>
  )
}
