import { useId, useState } from 'react'
import { KeyReturn } from '@phosphor-icons/react'
import type { ChatTeam } from '../../../../../shared/chat'
import { useUi } from '../../host'
import { cleanError } from '../../../format'
import { TeamModal } from './shared'

const CODE_RE = /^[0-9a-f]{16}$/

/** Entrar a un equipo con un código. */
export function JoinByCode({ onClose, onJoined }: { onClose(): void; onJoined(team: ChatTeam): void }): React.JSX.Element {
  const ui = useUi()
  const titleId = useId()
  const inputId = useId()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const join = async (): Promise<void> => {
    if (busy) return
    const c = code.trim().toLowerCase()
    if (!CODE_RE.test(c)) {
      setErr('El código tiene 16 caracteres: letras de la a a la f y números.')
      return
    }
    setErr(null)
    setBusy(true)
    try {
      const team = await ui.invoke<ChatTeam>('feat:chat:joinByCode', c)
      onJoined(team)
    } catch (e) {
      setErr(cleanError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <TeamModal titleId={titleId} title="Entrar con código" icon={<KeyReturn size={18} weight="duotone" />} busy={busy} onClose={onClose}>
      <form
        className="f-chat-team-form"
        onSubmit={(e) => {
          e.preventDefault()
          void join()
        }}
      >
        <div className="field">
          <label htmlFor={inputId}>Código del equipo</label>
          <input
            id={inputId}
            className="mono"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            placeholder="0123456789abcdef"
            aria-describedby={err ? `${inputId}-err` : undefined}
            aria-invalid={err ? true : undefined}
          />
        </div>
        {err && (
          <p id={`${inputId}-err`} className="form-error" role="alert">
            {err}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={busy || code.trim() === ''}>
            {busy ? 'Entrando…' : 'Entrar'}
          </button>
        </div>
      </form>
    </TeamModal>
  )
}
