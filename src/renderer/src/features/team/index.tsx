import { useEffect, useRef } from 'react'
import { UsersThree } from '@phosphor-icons/react'
import type { FeatureUi } from '../host'
import { useUi } from '../host'
import { useDocumentVisible } from '../../visibility'
import { setTeamOpen, setTeamSnapshot, STALE_MS, useTeamOpen, useTeamSnapshot, type TeamSnapshot } from './model'
import { TeamView } from './TeamView'
import './team.css'

/** Botón «Equipo» en la barra de título; el punto avisa si hay PRs con CI fallando. */
function TitlebarButton(): React.JSX.Element {
  const open = useTeamOpen()
  const snap = useTeamSnapshot()
  const failing = snap?.summary.ciFailing ?? 0
  return (
    <button
      type="button"
      className="icon-btn f-team-tb"
      aria-label="Equipo"
      aria-pressed={open}
      title={failing ? `Equipo · ${failing} ${failing === 1 ? 'PR con CI fallando' : 'PRs con CI fallando'}` : 'Equipo: en qué anda cada uno'}
      onClick={() => setTeamOpen(!open)}
    >
      <UsersThree size={15} aria-hidden="true" />
      {failing > 0 && <span className="f-team-tb-dot" aria-hidden="true" />}
    </button>
  )
}

/**
 * Carga lo guardado una vez y escucha a main (sin polling). GitHub se lee al abrir la vista y al
 * volver a la ventana si la vista está abierta y pasaron más de 5 min. Con la vista cerrada o la
 * ventana oculta no se pide nada.
 */
function Global(): React.JSX.Element | null {
  const ui = useUi()
  const open = useTeamOpen()
  const visible = useDocumentVisible()
  const snapRef = useRef<TeamSnapshot | null>(null)
  const snap = useTeamSnapshot()
  snapRef.current = snap

  useEffect(() => {
    let alive = true
    void ui.invoke<TeamSnapshot>('feat:team:state').then((s) => alive && s && setTeamSnapshot(s))
    const off = ui.on('feat:team:changed', (s: TeamSnapshot) => setTeamSnapshot(s))
    return () => {
      alive = false
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Al abrir: siempre (es barato).
  useEffect(() => {
    if (!open) return
    void ui.invoke('feat:team:refreshGithub').catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Al volver a la ventana con la vista abierta, si quedó viejo.
  const wasVisible = useRef(visible)
  useEffect(() => {
    const back = visible && !wasVisible.current
    wasVisible.current = visible
    if (!back || !open) return
    const at = snapRef.current?.github.fetchedAt ?? 0
    if (Date.now() - at > STALE_MS && !snapRef.current?.githubRunning) void ui.invoke('feat:team:refreshGithub').catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, open])

  return open ? <TeamView /> : null
}

const ui: FeatureUi = {
  name: 'team',
  Titlebar: TitlebarButton,
  Global,
  commands: () => [
    {
      id: 'team:open',
      title: 'Ver equipo',
      subtitle: 'PRs abiertos con su CI y review, y en qué ticket anda cada uno',
      group: 'Equipo',
      keywords: 'equipo team personas prs github review ci conector tickets',
      run: () => setTeamOpen(true)
    }
  ]
}

export default ui
