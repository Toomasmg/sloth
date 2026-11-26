import { lazy, Suspense, useEffect } from 'react'
import type { FeatureUi } from '../host'
import { useUi } from '../host'
import type { PrsSnapshot } from '../../../../shared/prs'
import { chipPrRojo } from '../../layout/pendientes'
import { ErrorIcon, PullRequestIcon } from '../../icons/SlothIcons'
import { openPrs, setPrsSnapshot, usePrs, usePrsPendientes } from './store'
import './prs.css'

const PrsPage = lazy(() => import('./PrsPage').then((m) => ({ default: m.PrsPage })))

function PrsGlobal(): React.JSX.Element | null {
  const ui = useUi()
  const { open } = usePrs()
  // `peek` devuelve lo guardado sin salir a GitHub; después solo llegan los refrescos de la vista.
  useEffect(() => {
    let alive = true
    void ui.invoke<PrsSnapshot>('feat:prs:peek').then((s) => alive && s && setPrsSnapshot(s)).catch(() => {})
    const off = ui.on('feat:prs:updated', (s: PrsSnapshot) => setPrsSnapshot(s))
    return () => {
      alive = false
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return open ? (
    <Suspense fallback={null}>
      <PrsPage />
    </Suspense>
  ) : null
}

function PrRojoChip(): React.JSX.Element | null {
  const chip = chipPrRojo(usePrsPendientes())
  if (!chip) return null
  return (
    <button type="button" className="sl-sum is-danger" onClick={openPrs} aria-label={chip.label} title={chip.label}>
      <ErrorIcon size={12} />
      <span>{chip.texto}</span>
    </button>
  )
}

const ui: FeatureUi = {
  name: 'prs',
  Global: PrsGlobal,
  Titlebar: PrRojoChip,
  commands() {
    return [
      {
        id: 'prs-open',
        title: 'Ver PRs',
        subtitle: 'Pull requests abiertos de los repos de tus espacios',
        group: 'Git',
        keywords: 'pull request ci checks github merge',
        icon: <PullRequestIcon size={16} />,
        run: openPrs
      }
    ]
  }
}

export default ui
