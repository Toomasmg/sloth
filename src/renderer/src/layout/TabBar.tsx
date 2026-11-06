import { ShieldWarning } from '@phosphor-icons/react'
import type { AgentState } from '../../../shared/types'
import { StateIcon } from '../StateIcon'
import { STATE_LABEL } from '../format'
import type { ReorderDrag } from './useReorderDrag'

export interface TabInfo {
  id: string
  title: string
  account: string
  color: string
  state?: AgentState
  perms: number
}

interface Props {
  tabs: TabInfo[]
  active: string | null
  drag: ReorderDrag | null
  scope: React.RefObject<HTMLDivElement | null>
  onSelect(id: string, focusTerminal: boolean): void
  onHide(id: string): void
  onPointerDown(e: React.PointerEvent, id: string): void
}

/** Barra de pestañas: una terminal a la vez. Flechas para moverse, clic del medio para ocultar. */
export function TabBar({ tabs, active, drag, scope, onSelect, onHide, onPointerDown }: Props): React.JSX.Element {
  const focusTab = (id: string): void => {
    requestAnimationFrame(() => scope.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`)?.focus())
  }
  const onKeyDown = (e: React.KeyboardEvent, i: number): void => {
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
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            data-tab-id={t.id}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={`pane-tab ${selected ? 'active' : ''} ${t.perms ? 'perm' : ''} ${t.state === 'waiting' ? 'waiting' : ''} ${drag?.id === t.id ? 'dragging' : ''} ${dropCls}`}
            style={{ '--acc': t.color } as React.CSSProperties}
            title={`${t.title} · ${t.account} — clic del medio para ocultar`}
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
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            <span className="acc-dot" aria-hidden="true" />
            <StateIcon state={t.state} size={12} />
            <span className="pane-tab-title">{t.title}</span>
            {t.perms > 0 && (
              <span className="pane-tab-perm" aria-hidden="true">
                <ShieldWarning size={11} weight="fill" />
                {t.perms > 1 ? t.perms : ''}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
