import { UpdateIcon } from '../../icons/SlothIcons'
import type { ChangelogEntry } from '../../../../shared/changelog'
import { Dialog } from './Dialog'
import { Button } from '../../ui'

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
      title="Novedades"
      icon={<UpdateIcon size={18} />}
      onClose={onClose}
      footer={
        <Button look="classic" variant="primary" onClick={onClose}>
          Listo
        </Button>
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
