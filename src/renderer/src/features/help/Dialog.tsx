import { Modal } from '../../Modal'

/** Cáscara de los diálogos de «help»: el Modal común más un pie de acciones. */
export function Dialog({
  title,
  icon,
  onClose,
  className,
  footer,
  children
}: {
  title: string
  icon: React.ReactNode
  onClose: () => void
  className?: string
  footer?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Modal title={title} icon={icon} onClose={onClose} backdropClose className={`f-help-modal ${className ?? ''}`}>
      {children}
      {footer && <footer className="modal-actions">{footer}</footer>}
    </Modal>
  )
}
