import { useState } from 'react'
import { useUi } from '../host'
import { cleanError } from '../../format'
import { CloseIcon } from '../../icons/SlothIcons'
import { setSnapshot, type Snapshot } from './model'

/** De qué sistema salen los tickets y, según la vía, con qué cuenta de Claude o qué repo de GitHub. */
export function Ajustes({ snap, onClose }: { snap: Snapshot; onClose: () => void }): React.JSX.Element {
  const ui = useUi()
  const [err, setErr] = useState<string | null>(null)
  // Cambiar de conector borra la lista: si hay tickets, se confirma antes.
  const [pendiente, setPendiente] = useState<string | null>(null)
  const via = snap.conector.via

  const set = (p: Record<string, unknown>): void => {
    setErr(null)
    void ui.invoke<Snapshot>('feat:tickets:setConfig', p).then(setSnapshot, (e) => setErr(cleanError(e)))
  }

  const elegirConector = (id: string): void => {
    if (id === snap.config.conectorId) return setPendiente(null)
    if (snap.tickets.length) return setPendiente(id)
    set({ conectorId: id })
  }

  const confirmar = (): void => {
    if (pendiente) set({ conectorId: pendiente })
    setPendiente(null)
  }

  const elegirCarpeta = async (): Promise<void> => {
    const p = await window.sloth.pickFolder()
    if (p) set({ defaultRepo: p })
  }

  return (
    <section className="f-tickets-ajustes" aria-label="Ajustes de tickets">
      <div className="f-tickets-ajustes-fila">
        <label className="field f-tickets-ajustes-campo">
          <span>Conector</span>
          <select value={pendiente ?? snap.config.conectorId} onChange={(e) => elegirConector(e.target.value)} disabled={snap.running}>
            {snap.conectores.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nombre}
                {c.verificado ? '' : ' (sin probar)'}
              </option>
            ))}
          </select>
        </label>

        {via === 'mcp' ? (
          <>
            <label className="field f-tickets-ajustes-campo">
              <span>Cuenta para consultar</span>
              <select value={snap.config.queryAccountId ?? ''} onChange={(e) => set({ queryAccountId: e.target.value })}>
                <option value="">La de menos uso</option>
                {ui.accounts.map((a) => (
                  <option key={a.id} value={a.id} disabled={!ui.statuses[a.id]?.loggedIn}>
                    {a.label}
                    {ui.statuses[a.id]?.loggedIn ? '' : ' (sin sesión)'}
                  </option>
                ))}
              </select>
            </label>
            <label className="field f-tickets-ajustes-campo">
              <span>Modelo</span>
              <select value={snap.config.model} onChange={(e) => set({ model: e.target.value })}>
                <option value="haiku">Haiku (barato)</option>
                <option value="sonnet">Sonnet</option>
                <option value="opus">Opus</option>
              </select>
            </label>
          </>
        ) : (
          <div className="field f-tickets-ajustes-campo f-tickets-ajustes-repo">
            <span>Carpeta del repo</span>
            <div className="f-tickets-ajustes-ruta">
              <code title={snap.config.defaultRepo}>{snap.config.defaultRepo ?? snap.lastRepo ?? 'Sin elegir'}</code>
              <button type="button" className="f-tickets-b f-tickets-b--sm" onClick={() => void elegirCarpeta()}>
                Elegir carpeta…
              </button>
            </div>
          </div>
        )}

        <span className="f-tickets-grow" />
        <button type="button" className="f-tickets-b f-tickets-b--sm" onClick={onClose} aria-label="Cerrar ajustes de tickets">
          <CloseIcon size={13} />
        </button>
      </div>

      {via === 'gh' && (
        <p className="f-tickets-ajustes-nota">
          Usa gh con tu sesión de GitHub: no gasta Claude.
          {!snap.config.defaultRepo && snap.lastRepo ? ' Sin carpeta elegida, usa la del último espacio.' : ''}
        </p>
      )}

      {pendiente && (
        <div className="f-tickets-alert f-tickets-confirm" role="alertdialog" aria-label="Confirmar cambio de conector">
          <span className="f-tickets-alert-text">Cambiar de conector borra la lista actual. ¿Seguimos?</span>
          <button type="button" className="f-tickets-b f-tickets-b--sm f-tickets-b--pri" autoFocus onClick={confirmar}>
            Cambiar
          </button>
          <button type="button" className="f-tickets-b f-tickets-b--sm" onClick={() => setPendiente(null)}>
            Cancelar
          </button>
        </div>
      )}

      {err && (
        <p className="form-error" role="alert">
          {err}
        </p>
      )}
    </section>
  )
}
