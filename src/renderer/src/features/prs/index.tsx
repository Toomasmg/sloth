import { lazy, Suspense } from 'react'
import type { FeatureUi } from '../host'
import { PullRequestIcon } from '../../icons/SlothIcons'
import { openPrs, usePrs } from './store'
import './prs.css'

const PrsPage = lazy(() => import('./PrsPage').then((m) => ({ default: m.PrsPage })))

function PrsGlobal(): React.JSX.Element | null {
  const { open } = usePrs()
  return open ? (
    <Suspense fallback={null}>
      <PrsPage />
    </Suspense>
  ) : null
}

const ui: FeatureUi = {
  name: 'prs',
  Global: PrsGlobal,
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
