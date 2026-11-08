import { useEffect, useSyncExternalStore } from 'react'
import { HistoryIcon } from '../../icons/SlothIcons'
import type { FeatureUi } from '../host'
import { HistoryPage } from './HistoryPage'
import './history.css'

const SHORTCUT = 'Ctrl+Shift+F'

// Abierta o cerrada, compartido entre el botón, el atajo y la paleta.
let isOpen = false
const listeners = new Set<() => void>()
const setOpen = (v: boolean): void => {
  isOpen = v
  for (const l of listeners) l()
}
const useOpen = (): boolean =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => isOpen
  )

/** Global: la página del historial (a pantalla completa) y el atajo Ctrl+Shift+F. */
function Global(): React.JSX.Element | null {
  const open = useOpen()
  // Fase de captura: funciona aunque la terminal (xterm) tenga el foco.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === 'F' || e.key === 'f' || e.code === 'KeyF')) {
        e.preventDefault()
        e.stopPropagation()
        setOpen(!isOpen)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  return open ? <HistoryPage onClose={() => setOpen(false)} /> : null
}

function TitlebarButton(): React.JSX.Element {
  return (
    <button
      type="button"
      className="icon-btn f-history-tb"
      onClick={() => setOpen(true)}
      aria-label="Historial de sesiones"
      title={`Historial de sesiones (${SHORTCUT})`}
    >
      <HistoryIcon size={15} />
    </button>
  )
}

const ui: FeatureUi = {
  name: 'history',
  Titlebar: TitlebarButton,
  Global,
  commands() {
    return [
      {
        id: 'history:search',
        title: 'Historial de sesiones',
        subtitle: 'Conversaciones de Claude de todas las cuentas: retomar, buscar, exportar',
        group: 'Historial',
        keywords: 'historial buscar conversaciones transcript sesion resume retomar exportar markdown fijar',
        shortcut: SHORTCUT,
        icon: <HistoryIcon size={16} />,
        run: () => setOpen(true)
      }
    ]
  }
}

export default ui
