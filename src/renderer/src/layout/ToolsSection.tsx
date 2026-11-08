import { useState, type ReactNode } from 'react'
import { BroadcastIcon, HistoryIcon, TeamIcon, TemplatesIcon, TicketIcon, TrashIcon, WorktreeIcon } from '../icons/SlothIcons'
import type { UiCtx } from '../features/host'
import { runFeatureCommand } from '../features/palette'
import { setBoardOpen, useSnapshot, isMine } from '../features/gruv/model'
import { openHistory } from '../features/history/index'
import { openRamas, useRamas } from '../features/worktrees/store'
import { openDialog } from '../features/templates/store'
import { setTeamOpen } from '../features/team/model'

const OPEN_KEY = 'sloth.sidebar.tools'

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) !== '0'
  } catch {
    return true
  }
}

function saveOpen(open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_KEY, open ? '1' : '0')
  } catch {
    /* sin espacio o bloqueado: la preferencia se pierde, nada más */
  }
}

/** Fila de herramienta: 30 px, ícono de 16 y texto de 13 (como el resto de la barra lateral). */
function ToolRow({
  icon,
  label,
  badge,
  disabled,
  onClick
}: {
  icon: ReactNode
  label: string
  badge?: number
  disabled?: boolean
  onClick(): void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="tools-row"
      onClick={onClick}
      disabled={disabled}
    >
      <span className="tools-row-ico" aria-hidden="true">
        {icon}
      </span>
      <span className="tools-row-text">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="tools-row-badge">{badge}</span>
      )}
    </button>
  )
}

/**
 * «Herramientas» de la barra lateral, entre las cuentas y el pie. Reúne lo que antes solo estaba en el
 * buscador o en un atajo. Plegable; recuerda si está abierta (esta PC).
 */
export function ToolsSection({ ctx }: { ctx: UiCtx }): React.JSX.Element {
  const [open, setOpenState] = useState(readOpen)
  const snap = useSnapshot()
  const { candidates } = useRamas()
  const mine = snap ? snap.tickets.filter((t) => isMine(t, snap.me)).length : undefined
  const toggle = (): void =>
    setOpenState((v) => {
      saveOpen(!v)
      return !v
    })

  return (
    <section className="tools" aria-labelledby="tools-h">
      <h2 id="tools-h" className="tools-head">
        <button type="button" className="tools-toggle" onClick={toggle} aria-expanded={open} aria-controls="tools-body">
          <span className="tools-chev" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          Herramientas
        </button>
      </h2>
      <div id="tools-body" className="tools-body" hidden={!open}>
        <ToolRow icon={<TicketIcon size={16} />} label="Tickets de Gruv" badge={mine} onClick={() => setBoardOpen(true)} />
        <ToolRow icon={<HistoryIcon size={16} />} label="Historial de sesiones" onClick={() => openHistory()} />
        <ToolRow icon={<TemplatesIcon size={16} />} label="Plantillas" onClick={() => openDialog({ kind: 'manage' })} />
        <ToolRow icon={<WorktreeIcon size={16} />} label="Ramas aparte" onClick={() => openRamas()} />
        <ToolRow
          icon={<BroadcastIcon size={16} />}
          label="Enviar a varios espacios"
          disabled={ctx.workspaces.length === 0}
          onClick={() => runFeatureCommand('broadcast:open', ctx)}
        />
        <ToolRow icon={<TrashIcon size={16} />} label="Limpiar ramas que ya no se usan" badge={candidates ?? 0} onClick={() => openRamas('limpiar')} />
        <ToolRow icon={<TeamIcon size={16} />} label="Ver equipo" onClick={() => setTeamOpen(true)} />
      </div>
    </section>
  )
}
