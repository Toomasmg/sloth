import { useEffect } from 'react'
import { useUi, type FeatureUi } from '../host'
import { PermissionReview } from './PermissionReview'
import { DecisionsPanel } from './DecisionsPanel'
import { setFocusedSpace } from './api'
import { closePermissionUi, openPermissionReview, usePermissionUi } from './store'
import { PermissionIcon } from '../../icons/SlothIcons'
import './permissions.css'

/** Pedidos vivos: los que tienen espacio abierto y todavía no vencieron (App ya los filtra por espacio). */
function useLive(): ReturnType<typeof useUi>['permissions'] {
  const ui = useUi()
  const now = Date.now()
  return ui.permissions.filter((p) => p.expiresAt > now && ui.workspaces.some((w) => w.id === p.workspaceId))
}

/** Chip de la barra de estado: «N pide(n) permiso», abre la revisión de pedidos (es el único chip de permisos). */
const Titlebar = (): React.JSX.Element | null => {
  const live = useLive()
  if (live.length === 0) return null
  return (
    <button
      type="button"
      className="chip chip-perm pr-chip"
      onClick={() => openPermissionReview(live[0].id)}
      title="Revisar los pedidos de permiso"
    >
      <PermissionIcon size={12} strokeWidth={2.2} />
      {live.length === 1 ? '1 pide permiso' : `${live.length} piden permiso`}
    </button>
  )
}

/**
 * Montaje único: la revisión a pantalla completa y el panel de decisiones. Además avisa a main qué
 * espacio está en pantalla (para no mandar avisos de Windows de lo que ya se ve).
 */
const Global = (): React.JSX.Element | null => {
  const ui = useUi()
  const open = usePermissionUi()
  const live = useLive()

  useEffect(() => {
    void setFocusedSpace(ui.focused).catch(() => undefined)
  }, [ui.focused])

  return (
    <>
      {open.review && (
        <PermissionReview
          prompts={live}
          workspaces={ui.workspaces}
          accounts={ui.accounts}
          initialId={open.review.id}
          onClose={closePermissionUi}
        />
      )}
      {open.decisions && <DecisionsPanel onClose={closePermissionUi} />}
    </>
  )
}

const ui: FeatureUi = { name: 'permissions', Titlebar, Global }

export default ui
