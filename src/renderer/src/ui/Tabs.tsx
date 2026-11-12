import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { keyToMove, moveIndex } from './nav'
import './ui.css'

export interface TabItem<T extends string> {
  id: T
  label: ReactNode
  /** Cuenta o insignia después del nombre. */
  badge?: ReactNode
  disabled?: boolean
}

export interface TabsProps<T extends string> {
  tabs: TabItem<T>[]
  value: T
  onChange: (id: T) => void
  'aria-label': string
  /** Con esto los ids quedan `${idBase}-tab-${id}` y `${idBase}-panel-${id}`; el panel se enlaza con `tabPanelProps`. */
  idBase?: string
}

export const tabPanelProps = (idBase: string, id: string): { role: 'tabpanel'; id: string; 'aria-labelledby': string; tabIndex: 0 } => ({
  role: 'tabpanel',
  id: `${idBase}-panel-${id}`,
  'aria-labelledby': `${idBase}-tab-${id}`,
  tabIndex: 0
})

export function Tabs<T extends string>({ tabs, value, onChange, idBase, ...rest }: TabsProps<T>): React.JSX.Element {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const current = tabs.findIndex((t) => t.id === value)

  const onKeyDown = (e: KeyboardEvent): void => {
    const move = keyToMove(e.key, 'horizontal')
    if (!move) return
    const i = moveIndex(tabs.length, current, move, (k) => !!tabs[k].disabled)
    if (i < 0) return
    e.preventDefault()
    onChange(tabs[i].id)
    refs.current[i]?.focus()
  }

  return (
    <div role="tablist" aria-label={rest['aria-label']} className="ui-tabs" onKeyDown={onKeyDown}>
      {tabs.map((t, i) => {
        const on = t.id === value
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="tab"
            id={idBase ? `${idBase}-tab-${t.id}` : undefined}
            aria-selected={on}
            aria-controls={idBase ? `${idBase}-panel-${t.id}` : undefined}
            tabIndex={on ? 0 : -1}
            disabled={t.disabled}
            className={`ui-tab${on ? ' is-on' : ''}`}
            onClick={() => onChange(t.id)}
          >
            {t.label}
            {t.badge != null && <span className="ui-tab-badge">{t.badge}</span>}
          </button>
        )
      })}
    </div>
  )
}
