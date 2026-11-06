import { useEffect, useRef, useState } from 'react'
import { Check, Copy, UserPlus } from '@phosphor-icons/react'
import { api } from '../../api'
import { Dialog } from './Dialog'

/** Texto para mandarle a un compañero. El link de descarga es fijo. */
export const INVITE_TEXT =
  'Te paso Sloth, la app que uso para correr varias cuentas de Claude Code: https://github.com/Toomasmg/sloth/releases/latest — ' +
  '1) Bajá el instalador Sloth-Setup (.exe) de esa página y abrilo. ' +
  '2) Agregá tu cuenta de Claude y tocá Iniciar sesión. ' +
  '3) Creá un espacio con tu repo (o soltá la carpeta en la ventana).'

export function InviteModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = (): void => {
    api.clipboardWrite(INVITE_TEXT)
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Dialog
      labelId="f-help-invite-title"
      title="Invitar a un compañero"
      icon={<UserPlus size={18} aria-hidden="true" />}
      onClose={onClose}
      footer={
        <>
          <span className="f-help-copied" role="status">
            {copied && (
              <>
                <Check size={14} aria-hidden="true" /> Copiado
              </>
            )}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            Cerrar
          </button>
          <button type="button" className="btn primary" onClick={copy}>
            <Copy size={14} aria-hidden="true" /> Copiar texto
          </button>
        </>
      }
    >
      <p className="hint">Copiá este mensaje y mandáselo. Trae el link de descarga y los pasos para empezar.</p>
      <textarea
        className="f-help-invite-text"
        readOnly
        aria-label="Texto de invitación"
        value={INVITE_TEXT}
        onFocus={(e) => e.currentTarget.select()}
      />
    </Dialog>
  )
}
