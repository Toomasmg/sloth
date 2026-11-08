import { useEffect, useSyncExternalStore, lazy, Suspense } from 'react'
import { HistoryIcon } from '../../icons/SlothIcons'
import { comboLabel, isCapturingShortcut, matchShortcut } from '../../shortcuts'
import type { FeatureUi } from '../host'
const HistoryPage = lazy(() => import('./HistoryPage').then((m) => ({ default: m.HistoryPage })))
import './history.css'


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
      if (!isCapturingShortcut() && matchShortcut('history', e)) {
        e.preventDefault()
        e.stopPropagation()
        setOpen(!isOpen)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  return open ? (
    <Suspense fallback={null}>
      <HistoryPage onClose={() => setOpen(false)} />
    </Suspense>
  ) : null
}

function TitlebarButton(): React.JSX.Element {
  return (
    <button
      type="button"
      className="icon-btn f-history-tb"
      onClick={() => setOpen(true)}
      aria-label="Historial de sesiones"
      title={`Historial de sesiones (${comboLabel('history')})`}
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
        shortcut: comboLabel('history'),
        icon: <HistoryIcon size={16} />,
        run: () => setOpen(true)
      }
    ]
  }
}

export default ui
