import { Modal } from './Modal'

export interface ConfirmRequest {
  title: string
  body: string
  yes: string
  no?: string
  resolve: (ok: boolean) => void
}

/** Confirmación de acciones que no se pueden deshacer; reemplaza al `window.confirm` del sistema. */
export function ConfirmDialog({ req, onDone }: { req: ConfirmRequest; onDone: (ok: boolean) => void }): React.JSX.Element {
  return (
    <Modal title={req.title} onClose={() => onDone(false)} className="confirm-dialog">
      <p className="confirm-body">{req.body}</p>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={() => onDone(false)} data-autofocus>
          {req.no ?? 'Cancelar'}
        </button>
        <button type="button" className="btn primary" onClick={() => onDone(true)}>
          {req.yes}
        </button>
      </div>
    </Modal>
  )
}
