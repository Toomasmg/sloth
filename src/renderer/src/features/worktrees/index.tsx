import type { FeatureUi } from '../host'
import { WorktreeIcon } from '../../icons/SlothIcons'
import { openRamas } from './store'
import { RamasPage } from './RamasPage'
import './worktrees.css'

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
  Global: RamasPage,
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
