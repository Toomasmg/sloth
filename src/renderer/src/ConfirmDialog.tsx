import { Modal } from './Modal'
import { Button } from './ui'

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
        <Button look="classic" variant="ghost" onClick={() => onDone(false)} data-autofocus>
          {req.no ?? 'Cancelar'}
        </Button>
        <Button look="classic" variant="primary" onClick={() => onDone(true)}>
          {req.yes}
        </Button>
      </div>
    </Modal>
  )
}
