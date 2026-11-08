import { lazy, Suspense } from 'react'
import type { FeatureUi } from '../host'
import { WorktreeIcon } from '../../icons/SlothIcons'
import { openRamas, useRamas } from './store'
import './worktrees.css'

// La página (escaneo de repos y tabla) se carga recién al abrirla: esta función siempre está montada.
const RamasPage = lazy(() => import('./RamasPage').then((m) => ({ default: m.RamasPage })))

function RamasGlobal(): React.JSX.Element | null {
  const { open } = useRamas()
  return open ? (
    <Suspense fallback={null}>
      <RamasPage />
    </Suspense>
  ) : null
}

/** Sección «Ramas aparte» al final del sidebar: abre el panel (que escanea al abrirse). */
function RamasSection(): React.JSX.Element {
  return (
    <section className="section f-wt-section">
      <button type="button" className="f-wt-toggle" onClick={() => openRamas()}>
        <span className="section-title f-wt-title">
          <WorktreeIcon size={13} /> Ramas aparte
        </span>
      </button>
    </section>
  )
}

const ui: FeatureUi = {
  name: 'worktrees',
  Sidebar: RamasSection,
  Global: RamasGlobal,
  commands() {
    return [
      {
        id: 'worktrees:open',
        title: 'Ramas aparte',
        subtitle: 'Copias de trabajo del repo en otra carpeta',
        group: 'Git',
        keywords: 'worktree rama aparte carpeta copia limpiar nueva',
        icon: <WorktreeIcon size={16} />,
        run() {
          openRamas()
        }
      },
      {
        id: 'worktrees:clean',
        title: 'Limpiar ramas que ya no se usan',
        subtitle: 'Mergeadas o borradas en origin, sin espacio ni cambios',
        group: 'Git',
        keywords: 'worktree limpieza borrar ramas mergeadas',
        run() {
          openRamas('limpiar')
        }
      }
    ]
  }
}

export default ui
