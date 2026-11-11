import { MoreIcon } from '../icons/SlothIcons'
import { ActionMenu, type ActionMenuItem } from './ActionMenu'

export type PaneMenuItem = ActionMenuItem

/**
 * Menú «más» del header de un panel (Renombrar, Ver cambios, Historial, Mover…). Mismo menú que el de
 * la app (ActionMenu): Escape o clic afuera lo cierran; las flechas se mueven entre opciones.
 */
export function PaneMenu({ label, items }: { label: string; items: PaneMenuItem[] }): React.JSX.Element {
  return (
    <ActionMenu
      label={label}
      items={items}
      trigger={<MoreIcon size={18} />}
      triggerClassName="icon-btn pane-menu-btn"
      wrapClassName="pane-menu-wrap"
    />
  )
}
