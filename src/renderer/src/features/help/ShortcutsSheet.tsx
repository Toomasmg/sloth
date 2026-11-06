import { Fragment } from 'react'
import { Keyboard } from '@phosphor-icons/react'
import { SHORTCUTS } from '../../shortcuts'
import { Dialog } from './Dialog'

const GROUPS = ['General', 'Paneles', 'Terminal'] as const

/** Hoja de atajos («?»). Lee la lista única SHORTCUTS, agrupada. */
export function ShortcutsSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <Dialog
      labelId="f-help-shortcuts-title"
      title="Atajos de teclado"
      icon={<Keyboard size={18} aria-hidden="true" />}
      onClose={onClose}
      className="f-help-sheet"
    >
      {GROUPS.map((g) => {
        const items = SHORTCUTS.filter((s) => (s.group ?? 'General') === g)
        if (items.length === 0) return null
        return (
          <section key={g} className="f-help-group">
            <h3>{g}</h3>
            <dl className="f-help-keys">
              {items.map((s) => (
                <div key={s.what}>
                  <dt>
                    {s.keys.map((combo, i) => (
                      <span key={i} className="f-help-combo">
                        {combo.map((k, j) => (
                          <Fragment key={j}>
                            {j > 0 && (
                              <span className="f-help-plus" aria-hidden="true">
                                +
                              </span>
                            )}
                            <kbd>{k}</kbd>
                          </Fragment>
                        ))}
                      </span>
                    ))}
                  </dt>
                  <dd>{s.what}</dd>
                </div>
              ))}
            </dl>
          </section>
        )
      })}
    </Dialog>
  )
}
