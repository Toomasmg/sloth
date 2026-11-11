import { useEffect, lazy, Suspense } from 'react'
import { useUi, type FeatureUi } from '../host'
import { TicketIcon } from '../../icons/SlothIcons'
const Board = lazy(() => import('./Board').then((m) => ({ default: m.Board })))
import { etiquetaTablero, getSnapshot, isMine, norm, setBoardOpen, setSnapshot, useBoardOpen, useSnapshot, type Snapshot } from './model'
import './tickets.css'

/** Chip «Tickets» en la barra de título, con cuántos tickets son míos (los que trajo el conector). */
function TitlebarChip(): React.JSX.Element {
  const snap = useSnapshot()
  const open = useBoardOpen()
  const mine = snap ? snap.tickets.filter((t) => isMine(t, snap.me)).length : 0
  return (
    <button
      type="button"
      className="tb-chip f-tickets-chip-tb"
      aria-pressed={open}
      onClick={() => setBoardOpen(!open)}
      title={etiquetaTablero(snap)}
    >
      <TicketIcon size={12} />
      Tickets
      {mine > 0 && <span className="f-tickets-chip-n">{mine}</span>}
    </button>
  )
}

/** Carga el estado una vez y escucha los cambios de main (sin polling). */
function Global(): React.JSX.Element | null {
  const ui = useUi()
  const open = useBoardOpen()
  useEffect(() => {
    let alive = true
    void ui.invoke<Snapshot>('feat:tickets:state').then((s) => alive && setSnapshot(s))
    const off = ui.on('feat:tickets:changed', (s: Snapshot) => setSnapshot(s))
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
  name: 'tickets',
  Titlebar: TitlebarChip,
  Global,
  commands: () => {
    const snap = getSnapshot()
    return [
      {
        id: 'tickets:board',
        title: etiquetaTablero(snap),
        subtitle: 'Tus tickets y los del equipo: empezar uno crea su espacio',
        group: 'Tickets',
        keywords: `tickets kanban tck tablero lista ${snap ? norm(snap.conector.nombre) : ''}`.trim(),
        run: () => setBoardOpen(true)
      }
    ]
  }
}

export default ui
