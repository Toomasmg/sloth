import { lazy, Suspense } from 'react'
import { ModalLoading } from '../../Modal'
import { useUi, type Command, type FeatureUi, type UiCtx } from '../host'
import { MoveAccountIcon } from '../../icons/SlothIcons'
import './move-account.css'
import { openMove, useMoveTarget } from './state'

// El diálogo se carga recién al abrir el espacio a mover.
const MoveDialog = lazy(() => import('./MoveDialog').then((m) => ({ default: m.MoveDialog })))

// ---------- Reglas ----------

/** Solo espacios (no paneles de login) y solo si hay 2 o más cuentas. */
function canMove(ui: UiCtx, paneId: string): boolean {
  if (paneId.startsWith('login:')) return false
  return ui.workspaces.some((w) => w.id === paneId) && ui.accounts.length >= 2
}

function Global(): React.JSX.Element | null {
  const ui = useUi()
  const t = useMoveTarget()
  if (!t || !ui.workspaces.some((w) => w.id === t.wsId)) return null
  return (
    <Suspense fallback={<ModalLoading />}>
      <MoveDialog wsId={t.wsId} />
    </Suspense>
  )
}

// ---------- Paleta ----------

function commands(ui: UiCtx): Command[] {
  return [
    {
      id: 'move-account.focused',
      title: 'Mover espacio enfocado a otra cuenta',
      group: 'Espacios',
      keywords: 'cuenta cambiar mover',
      icon: <MoveAccountIcon size={16} />,
      run() {
        const id = ui.focused
        if (!id || !canMove(ui, id)) {
          ui.notifyError('Enfocá un espacio para moverlo. Hace falta tener al menos dos cuentas.')
          return
        }
        openMove(id)
      }
    }
  ]
}

const ui: FeatureUi = {
  name: 'move-account',
  Global,
  commands,
  paneActions: (ctx, paneId) =>
    canMove(ctx, paneId) ? [{ id: 'move', label: 'Mover a otra cuenta', group: 'compartir', order: 20, icon: <MoveAccountIcon size={15} />, run: () => openMove(paneId) }] : []
}

export default ui
