import { useEffect } from 'react'
import { Ticket } from '@phosphor-icons/react'
import type { FeatureUi } from '../host'
import { useUi } from '../host'
import { Board } from './Board'
import { setBoardOpen, setSnapshot, useBoardOpen, useSnapshot, type Snapshot } from './model'
import './gruv.css'

/** Chip «Tickets» en la barra de título, con cuántos tickets hay en el tablero (Gruv no trae los cerrados). */
function TitlebarChip(): React.JSX.Element {
  const snap = useSnapshot()
  const open = useBoardOpen()
  const ui = useUi()
  let count = 0
  if (snap) {
    const ids = new Set<string>()
    for (const t of [...snap.tickets, ...snap.manual]) {
      if (ids.has(t.id)) continue
      ids.add(t.id)
      count++
    }
    for (const w of ui.workspaces) if (w.ticket && !ids.has(w.ticket.toUpperCase())) count++
  }
  return (
    <button
      type="button"
      className="tb-chip f-gruv-chip-tb"
      aria-pressed={open}
      onClick={() => setBoardOpen(!open)}
      title="Tablero de tickets de Gruv"
    >
      <Ticket size={12} weight="bold" aria-hidden="true" />
      Tickets
      {count > 0 && <span className="f-gruv-chip-n">{count}</span>}
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
  return open ? <Board /> : null
}

const ui: FeatureUi = {
  name: 'gruv',
  Titlebar: TitlebarChip,
  Global,
  commands: () => [
    {
      id: 'gruv:board',
      title: 'Tablero de tickets',
      subtitle: 'Tickets de Gruv: empezar uno crea su espacio con /ticket',
      group: 'Tickets',
      keywords: 'gruv kanban tck tickets tablero',
      run: () => setBoardOpen(true)
    }
  ]
}

export default ui
