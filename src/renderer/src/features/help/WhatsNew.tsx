import { Sparkle } from '@phosphor-icons/react'
import type { ChangelogEntry } from '../../../../shared/changelog'
import { Dialog } from './Dialog'

/** Novedades: entradas de la versión (o versiones) que el usuario todavía no vio. */
export function WhatsNewModal({
  entries,
  onClose
}: {
  entries: ChangelogEntry[]
  onClose: () => void
}): React.JSX.Element {
  return (
    <Dialog
      labelId="f-help-whatsnew-title"
      title="Novedades"
      icon={<Sparkle size={18} aria-hidden="true" />}
      onClose={onClose}
      footer={
        <button type="button" className="btn primary" onClick={onClose}>
          Listo
        </button>
      }
    >
      {entries.length === 0 ? (
        <p className="hint">Todavía no hay novedades para mostrar.</p>
      ) : (
        entries.map((e) => (
          <article key={e.version} className="f-help-entry">
            <header>
              <h3>{e.title}</h3>
              <span className="mono hint">
                v{e.version} · {e.date}
              </span>
            </header>
            <ul>
              {e.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </article>
        ))
      )}
    </Dialog>
  )
}
