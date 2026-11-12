import { MoreIcon } from '../icons/SlothIcons'
import { ContextMenu, IconButton, Menu, type MenuItem } from '../ui'
import { withSeparators, type PaneAction } from './pane-actions'

function toItems(actions: PaneAction[]): MenuItem[] {
  return withSeparators(actions).map((a) =>
    a === 'sep' ? { type: 'separator' } : { id: a.id, label: a.label, icon: a.icon, hint: a.hint, shortcut: a.shortcut, danger: a.danger, onSelect: a.run }
  )
}

/**
 * El menú de un espacio o panel. Es el mismo en el «…» de la cabecera del panel, el clic derecho de
 * la barra lateral y de la pestaña; la paleta muestra las mismas acciones con Tab.
 */
export function WorkspaceMenuButton({ name, actions }: { name: string; actions: PaneAction[] }): React.JSX.Element {
  return (
    <Menu
      aria-label={`Acciones de ${name}`}
      items={toItems(actions)}
      trigger={(p) => <IconButton {...p} label={`Más acciones de ${name}`} icon={<MoreIcon size={16} />} size="sm" className="pane-more" />}
    />
  )
}

export function WorkspaceContextMenu({
  name,
  x,
  y,
  actions,
  onClose
}: {
  name: string
  x: number
  y: number
  actions: PaneAction[]
  onClose: (returnFocus: boolean) => void
}): React.JSX.Element {
  return <ContextMenu aria-label={`Acciones de ${name}`} x={x} y={y} items={toItems(actions)} onClose={onClose} />
}
