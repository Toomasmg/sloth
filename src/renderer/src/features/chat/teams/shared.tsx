import { useLayoutEffect } from 'react'
import { useSettings } from '../../settings/store'
import { X } from '@phosphor-icons/react'
import type { ChatProfile, ChatRole } from '../../../../../shared/chat'

/** Solo avatares de GitHub (la CSP también lo fuerza). */
const AVATAR_HOST = /^https:\/\/avatars\.githubusercontent\.com\//

export const canManage = (role: ChatRole): boolean => role === 'owner' || role === 'admin'

export const roleLabel = (r: ChatRole): string => (r === 'owner' ? 'Owner' : r === 'admin' ? 'Admin' : 'Miembro')

/** Devuelve el foco a donde estaba cuando se cierra un diálogo. */
export function useReturnFocus(): void {
  useLayoutEffect(() => {
    const a = document.activeElement
    const prev = a instanceof HTMLElement && a !== document.body ? a : null
    return () => {
      if (prev?.isConnected) prev.focus()
    }
  }, [])
}

/** Marco de los diálogos de equipos: reusa .modal-backdrop / .modal. Escape cierra (salvo ocupado). */
export function TeamModal({
  titleId,
  title,
  icon,
  busy,
  onClose,
  children
}: {
  titleId: string
  title: string
  icon: React.ReactNode
  busy?: boolean
  onClose(): void
  children: React.ReactNode
}): React.JSX.Element {
  useReturnFocus()
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div
        className="modal f-chat-team-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          e.stopPropagation()
          if (!busy) onClose()
        }}
      >
        <header className="modal-head">
          <span className="f-chat-team-modal-icon" aria-hidden="true">
            {icon}
          </span>
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar" disabled={busy}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        {children}
      </div>
    </div>
  )
}

/** Confirmación en línea (acciones destructivas). Escape cancela; el foco arranca en «Cancelar». */
export function ConfirmInline({
  id,
  message,
  confirmLabel,
  busy,
  onConfirm,
  onCancel
}: {
  id: string
  message: string
  confirmLabel: string
  busy?: boolean
  onConfirm(): void
  onCancel(): void
}): React.JSX.Element {
  return (
    <div
      className="f-chat-team-confirm"
      role="alertdialog"
      aria-labelledby={id}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      }}
    >
      <p id={id}>{message}</p>
      <div className="f-chat-team-actions">
        <button type="button" className="btn sm" onClick={onCancel} disabled={busy} autoFocus>
          Cancelar
        </button>
        <button type="button" className="btn sm danger" onClick={onConfirm} disabled={busy}>
          {confirmLabel}
        </button>
      </div>
    </div>
  )
}

/** Foto de perfil o, si no hay, la inicial. El nombre va al lado, así que la imagen es decorativa. */
export function Avatar({ profile, size = 28 }: { profile: ChatProfile; size?: number }): React.JSX.Element {
  // Modo liviano: sin fotos, solo la inicial.
  const lite = useSettings().settings.lightMode
  const url = !lite && profile.avatarUrl && AVATAR_HOST.test(profile.avatarUrl) ? profile.avatarUrl : undefined
  const style = { width: size, height: size }
  if (url) {
    return <img className="f-chat-team-avatar" src={url} alt="" width={size} height={size} loading="lazy" style={style} />
  }
  return (
    <span className="f-chat-team-avatar f-chat-team-avatar-initial" aria-hidden="true" style={style}>
      {(profile.login.charAt(0) || '?').toUpperCase()}
    </span>
  )
}
