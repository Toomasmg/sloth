import type { AgentState } from '../../../shared/types'
import { StateIcon } from '../StateIcon'
import { STATE_LABEL } from '../format'
import type { ReorderDrag } from './useReorderDrag'
import { PermissionIcon } from '../icons/SlothIcons'

export interface TabInfo {
  id: string
  title: string
  account: string
  state?: AgentState
  perms: number
  /** Ícono del espacio (emoji), solo para mostrar. */
  icon?: string
  /** Se ve en la grilla ahora (los demás esperan en pestañas). */
  onScreen: boolean
}

interface Props {
  tabs: TabInfo[]
  active: string | null
  drag: ReorderDrag | null
  scope: React.RefObject<HTMLDivElement | null>
  onSelect(id: string, focusTerminal: boolean): void
  onHide(id: string): void
  onPointerDown(e: React.PointerEvent, id: string): void
  /** Clic derecho o Shift+F10: el menú del espacio en ese punto. */
  onMenu(id: string, x: number, y: number): void
}

/** Una pestaña por panel abierto, con su estado. Flechas para moverse, clic del medio o Supr para ocultar. */
export function TabBar({ tabs, active, drag, scope, onSelect, onHide, onPointerDown, onMenu }: Props): React.JSX.Element {
  const focusTab = (id: string): void => {
    requestAnimationFrame(() => scope.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`)?.focus())
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, i: number): void => {
    if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
      e.preventDefault()
      const r = e.currentTarget.getBoundingClientRect()
      onMenu(tabs[i].id, r.left, r.bottom + 4)
      return
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return
    let j = -1
    if (e.key === 'ArrowRight') j = (i + 1) % tabs.length
    else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') j = 0
    else if (e.key === 'End') j = tabs.length - 1
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect(tabs[i].id, true)
      return
    } else if (e.key === 'Delete') {
      e.preventDefault()
      onHide(tabs[i].id)
      return
    }
    if (j < 0) return
    e.preventDefault()
    onSelect(tabs[j].id, false)
    focusTab(tabs[j].id)
  }

  return (
    <div ref={scope} className="pane-tabs" role="tablist" aria-label="Paneles abiertos" aria-orientation="horizontal">
      {tabs.map((t, i) => {
        const selected = t.id === active
        const dropCls = drag && drag.target === t.id && drag.mode ? `drop-${drag.mode}` : ''
        const stateText = t.state ? STATE_LABEL[t.state] : 'sin estado'
        // En reposo no hay glifo: solo se marca lo que cambia (trabaja, espera, terminó, pide permiso).
        const glyph = t.perms > 0 ? <PermissionIcon size={12} className="ic ic-waiting" /> : t.state && t.state !== 'idle' ? <StateIcon state={t.state} size={12} /> : null
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            data-tab-id={t.id}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={`pane-tab ${selected ? 'active' : ''} ${t.onScreen ? 'on-screen' : ''} ${drag?.id === t.id ? 'dragging' : ''} ${dropCls}`}
            title={`${t.title} · ${t.account} (clic derecho: más acciones; clic del medio o Supr: ocultar)`}
            aria-label={`${t.title}, ${t.account}, ${stateText}${t.perms ? `, ${t.perms === 1 ? 'permiso pendiente' : `${t.perms} permisos pendientes`}` : ''}`}
            onClick={() => onSelect(t.id, true)}
            onPointerDown={(e) => onPointerDown(e, t.id)}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault()
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return
              e.preventDefault()
              onHide(t.id)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              onMenu(t.id, e.clientX, e.clientY)
            }}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {glyph}
            {t.icon && <span className="pane-tab-icon">{t.icon}</span>}
            <span className="pane-tab-title">{t.title}</span>
            {t.perms > 1 && <span className="pane-tab-n">{t.perms}</span>}
          </button>
        )
      })}
    </div>
  )
}
