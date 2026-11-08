import { useState } from 'react'
import type { DecisionEntry } from '../../../../main/features/permissions'
import type { PermissionRule } from '../../../../main/features/permissions-core'
import { cleanError } from '../../format'
import { CloseIcon } from '../../icons/SlothIcons'
import { removeRule, setDnd, setRule, undoDecision } from './api'
import { hhmm, usePermissionsList } from './store'

const TAG: Record<DecisionEntry['tag'], { label: string; cls: string; text: (e: DecisionEntry) => string }> = {
  once: { label: 'Permitido', cls: 'ok', text: (e) => `Permitido una vez · ${e.label}` },
  always: { label: 'Siempre', cls: 'lila', text: (e) => `Permitido siempre · ${e.label}` },
  rule: { label: 'Regla', cls: 'lila', text: (e) => `Permitido por regla · ${e.label}` },
  deny: { label: 'Rechazado', cls: 'coral', text: (e) => `Rechazado · ${e.label}` },
  terminal: { label: 'Terminal', cls: 'muted', text: (e) => `Respondido en la terminal · ${e.label}` }
}

type Tab = 'hist' | 'rules'

/**
 * Panel «Decisiones»: lo decidido hoy (con Deshacer para «Permitir siempre») y las reglas guardadas
 * (interruptor y quitar). Todo se persiste en main.
 */
export function DecisionsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { data, error: loadError } = usePermissionsList()
  const [tab, setTab] = useState<Tab>('hist')
  const [err, setErr] = useState<string | null>(null)
  const act = async (fn: () => Promise<void>): Promise<void> => {
    setErr(null)
    try {
      await fn()
    } catch (e) {
      setErr(cleanError(e))
    }
  }
  const spaceName = (id: string): string => data?.spaces[id]?.name ?? 'Espacio borrado'
  const rules = data?.rules ?? []

  return (
    <div className="modal-backdrop pr-backdrop" onMouseDown={onClose}>
      <aside
        className="modal pd-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Decisiones y reglas"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
        }}
      >
        <header className="pd-head">
          <span className="pd-title">Decisiones</span>
          <div className="seg" role="group" aria-label="Vista">
            <button type="button" aria-pressed={tab === 'hist'} onClick={() => setTab('hist')}>
              Historial de hoy
            </button>
            <button type="button" aria-pressed={tab === 'rules'} onClick={() => setTab('rules')}>
              Reglas · {rules.length}
            </button>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <CloseIcon size={14} />
          </button>
        </header>

        <label className="pd-dnd">
          <span className="pd-dnd-text">
            No molestar
            <span className="pd-dnd-sub">
              {data?.dndFromSettings ? 'Activado desde la Configuración' : 'Sin avisos de Windows mientras esté activo'}
            </span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              checked={Boolean(data?.dnd)}
              disabled={!data}
              onChange={(e) => void act(() => setDnd(e.target.checked))}
            />
            <span className="switch-track" aria-hidden="true" />
          </span>
        </label>

        {(err || loadError) && (
          <p className="pd-error" role="alert">
            {err ?? loadError}
          </p>
        )}

        {tab === 'hist' ? (
          <ol className="pd-list" aria-label="Decisiones de hoy">
            {(data?.history ?? []).map((h) => {
              const t = TAG[h.tag] ?? TAG.once
              const undoable = h.tag === 'always' && !!h.ruleId && !h.undone
              return (
                <li key={h.id} className="pd-row">
                  <span className="pd-time mono">{hhmm(h.at)}</span>
                  <span className="pd-main">
                    <span className="pd-tagline">
                      <span className={`pd-tag ${t.cls}`}>{t.label}</span>
                      <span className="pd-space">{spaceName(h.workspaceId)}</span>
                    </span>
                    <span className="pd-text">{t.text(h)}</span>
                  </span>
                  {undoable && (
                    <button type="button" className="btn sm" onClick={() => void act(() => undoDecision(h.id))}>
                      Deshacer
                    </button>
                  )}
                  {h.undone && <span className="pd-undone">Deshecho</span>}
                </li>
              )
            })}
            {data && data.history.length === 0 && <li className="pd-empty">Todavía no tomaste decisiones hoy.</li>}
          </ol>
        ) : (
          <div className="pd-list" aria-label="Reglas guardadas">
            <p className="pd-help">Estos pedidos se aprueban sin preguntar, solo en el espacio donde los guardaste. Podés desactivarlos o quitarlos cuando quieras.</p>
            {rules.map((r: PermissionRule) => (
              <div key={r.id} className="pd-row">
                <span className="pd-main">
                  <span className={`pd-text ${r.kind === 'cmd' ? 'mono' : ''}`}>{r.label}</span>
                  <span className="pd-space">
                    {spaceName(r.workspaceId)} · {r.on ? 'Activo' : 'Desactivado'}
                  </span>
                </span>
                <span className="switch">
                  <input
                    type="checkbox"
                    checked={r.on}
                    aria-label={`Permitir siempre ${r.label} en ${spaceName(r.workspaceId)}`}
                    onChange={(e) => void act(() => setRule(r.id, e.target.checked))}
                  />
                  <span className="switch-track" aria-hidden="true" />
                </span>
                <button type="button" className="btn sm" aria-label={`Quitar la regla ${r.label}`} onClick={() => void act(() => removeRule(r.id))}>
                  Quitar
                </button>
              </div>
            ))}
            {data && rules.length === 0 && <p className="pd-empty">No hay pedidos permitidos siempre.</p>}
          </div>
        )}
      </aside>
    </div>
  )
}
