import { useUi } from '../../host'
import { Group } from '../ui'
import { Button, EmptyState, Tag } from '../../../ui'
import { openDialog, useTemplates, usesTicket } from '../../templates/store'
import { colorHex } from '../../templates/catalog'
import { shortPath } from '../../../format'
/* ---------- Plantillas ---------- */

export function TemplatesSection(): React.JSX.Element {
  const ui = useUi()
  const { list, defaultId, loaded } = useTemplates()
  const accLabel = (id: string): string => (id === 'sugerida' ? 'Cuenta sugerida' : (ui.accounts.find((a) => a.id === id)?.label ?? 'cuenta borrada'))
  if (loaded && list.length === 0)
    return (
      <EmptyState
        title="Todavía no hay plantillas"
        description="Una plantilla arma el espacio por vos: carpeta, cuenta, rama y primer mensaje. Creá una o guardá un espacio como plantilla desde su panel."
        action={
          <Button variant="primary" onClick={() => openDialog({ kind: 'manage' })}>
            Nueva plantilla
          </Button>
        }
      />
    )
  return (
    <>
      <div className="f-set-actions">
        <Button variant="primary" size="sm" onClick={() => openDialog({ kind: 'manage' })}>
          Nueva plantilla
        </Button>
      </div>
      <Group id="g-plantillas" label="Tus plantillas">
        {list.map((t) => (
          <div key={t.id} className="f-set-row">
            <span className="f-set-swatch" style={{ background: colorHex(t.color) }} aria-hidden="true" />
            <div className="f-set-row-text">
              <span className="f-set-row-title">
                {t.name}
                {t.id === defaultId && <Tag>Predeterminada</Tag>}
                {t.team && <Tag>Del equipo</Tag>}
              </span>
              <span className="f-set-hint">
                {accLabel(t.accountId)}
                {usesTicket(t) ? ' · pide ticket' : ''}
                {t.useWorktree ? ` · rama ${t.useWorktree.branchPattern}` : t.repoPath ? ` · ${shortPath(t.repoPath)}` : ''}
              </span>
            </div>
            <div className="f-set-row-ctl">
              <Button size="sm" onClick={() => openDialog({ kind: 'manage', id: t.id })} aria-label={`Editar plantilla ${t.name}`}>
                Editar
              </Button>
            </div>
          </div>
        ))}
      </Group>
    </>
  )
}
