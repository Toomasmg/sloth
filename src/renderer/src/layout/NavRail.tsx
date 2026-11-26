import { useEffect, type ReactNode } from 'react'
import { HelpIcon, HistoryIcon, SettingsIcon, TeamIcon, TerminalIcon, PullRequestIcon, TicketIcon, WorktreeIcon } from '../icons/SlothIcons'
import { Tooltip } from '../ui'
import { comboLabel, isCapturingShortcut } from '../shortcuts'
import { isMine, useSnapshot } from '../features/tickets/model'
import { useTeamSnapshot } from '../features/team/model'
import { usePrsPendientes } from '../features/prs/store'
import { goTo, useNavDest } from './nav'
import { insigniaEquipo, insigniaPrs, resumenParaRiel, type Insignia } from './pendientes'
import { NAV_FOOT, NAV_LABEL, NAV_MAIN, navDestForKey, type NavDest } from './nav-model'

const ICON: Record<NavDest, ReactNode> = {
  espacios: <TerminalIcon size={18} />,
  tickets: <TicketIcon size={18} />,
  equipo: <TeamIcon size={18} />,
  historial: <HistoryIcon size={18} />,
  ramas: <WorktreeIcon size={18} />,
  prs: <PullRequestIcon size={18} />,
  ayuda: <HelpIcon size={18} />,
  ajustes: <SettingsIcon size={18} />
}

function RailButton({ dest, active, shortcut, badge }: { dest: NavDest; active: boolean; shortcut?: string; badge?: { n: number; label: string; tono?: Insignia['tono'] } }): React.JSX.Element {
  const label = NAV_LABEL[dest]
  const n = badge?.n ?? 0
  return (
    <Tooltip text={label} shortcut={shortcut} placement="right">
      <button
        type="button"
        className={`sl-rail-btn${active ? ' is-on' : ''}`}
        aria-label={n > 0 && badge ? `${label}, ${badge.label}` : label}
        aria-current={active ? 'page' : undefined}
        data-nav={dest}
        onClick={() => goTo(dest)}
      >
        {ICON[dest]}
        {n > 0 && (
          <span className={`sl-rail-badge${badge?.tono === 'danger' ? ' is-danger' : ''}`} aria-hidden="true">
            {n > 99 ? '99+' : n}
          </span>
        )}
      </button>
    </Tooltip>
  )
}

/**
 * Riel de navegación: un destino por función y siempre se ve dónde estás. Ctrl+Shift+1…6 va a cada
 * destino desde cualquier lado, también con el foco en la terminal (no son teclas de la shell).
 */
export function NavRail(): React.JSX.Element {
  const current = useNavDest()
  const snap = useSnapshot()
  const team = useTeamSnapshot()
  const pend = usePrsPendientes()
  const equipo = insigniaEquipo(resumenParaRiel(team ? { ...team.summary, leyoGithub: Boolean(team.github.fetchedAt) } : null, pend))
  const prs = insigniaPrs(pend)
  const mine = snap ? snap.tickets.filter((t) => isMine(t, snap.me)).length : 0

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isCapturingShortcut()) return
      const dest = navDestForKey(e)
      // Con un diálogo abierto no se navega por detrás.
      if (!dest || document.querySelector('.modal-backdrop')) return
      e.preventDefault()
      e.stopImmediatePropagation()
      goTo(dest)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <nav className="sl-rail" aria-label="Navegación">
      {NAV_MAIN.map((d, i) => (
        <RailButton
          key={d}
          dest={d}
          active={current === d}
          shortcut={`Ctrl+Shift+${i + 1}`}
          badge={d === 'tickets' ? { n: mine, label: `${mine} ${mine === 1 ? 'ticket tuyo' : 'tickets tuyos'}` } : d === 'equipo' ? equipo ?? undefined : d === 'prs' ? prs ?? undefined : undefined}
        />
      ))}
      <span className="sl-rail-grow" />
      {NAV_FOOT.map((d) => (
        <RailButton key={d} dest={d} active={current === d} shortcut={d === 'ajustes' ? comboLabel('settings') : comboLabel('help')} />
      ))}
    </nav>
  )
}
