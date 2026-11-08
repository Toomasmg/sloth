import { useEffect, lazy, Suspense } from 'react'
import { useUi, type FeatureUi } from '../host'
import { TicketIcon } from '../../icons/SlothIcons'
const Board = lazy(() => import('./Board').then((m) => ({ default: m.Board })))
import { isMine, setBoardOpen, setSnapshot, useBoardOpen, useSnapshot, type Snapshot } from './model'
import './gruv.css'

/** Chip «Tickets» en la barra de título, con cuántos tickets son míos (los que Gruv trajo). */
function TitlebarChip(): React.JSX.Element {
  const snap = useSnapshot()
  const open = useBoardOpen()
  const mine = snap ? snap.tickets.filter((t) => isMine(t, snap.me)).length : 0
  return (
    <button
      type="button"
      className="tb-chip f-gruv-chip-tb"
      aria-pressed={open}
      onClick={() => setBoardOpen(!open)}
      title="Tickets de Gruv"
    >
      <TicketIcon size={12} />
      Tickets
      {mine > 0 && <span className="f-gruv-chip-n">{mine}</span>}
    </button>
  )
}

/** Carga el estado una vez y escucha los cambios de main (sin polling). */
function Global(): React.JSX.Element | null {
  const ui = useUi()
  const open = useBoardOpen()
  useEffect(() => {
    let alive = true
    void ui.invoke<Snapshot>('feat:gruv:state').then((s) => alive && setSnapshot(s))
    const off = ui.on('feat:gruv:changed', (s: Snapshot) => setSnapshot(s))
    return () => {
      alive = false
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return open ? (
    <Suspense fallback={null}>
      <Board />
    </Suspense>
  ) : null
}

const ui: FeatureUi = {
  name: 'gruv',
  Titlebar: TitlebarChip,
  Global,
  commands: () => [
    {
      id: 'gruv:board',
      title: 'Tickets de Gruv',
      subtitle: 'Tus tickets y los del equipo: empezar uno crea su espacio',
      group: 'Tickets',
      keywords: 'gruv kanban tck tickets tablero lista',
      run: () => setBoardOpen(true)
    }
  ]
}

export default ui
