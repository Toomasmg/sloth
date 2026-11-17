import { useId, useState } from 'react'
import { Broom, Timer } from '@phosphor-icons/react'
import { CHAT_RETENTION_HOURS, type ChatConvRef, type ChatTeam } from '../../../../shared/chat'
import { canManageConv, parseRetention, retentionLabel } from '../../../../shared/chat-retention'
import { Modal } from '../../Modal'
import { Button, InlineAlert, Select } from '../../ui'
import { clearConversation, errText, setRetention } from './store'

const NEVER = 'off'
const OPTIONS = [
  { value: NEVER, label: retentionLabel(null) },
  ...CHAT_RETENTION_HOURS.map((h) => ({ value: String(h), label: retentionLabel(h) }))
]

/** Borrado automático del equipo. Lo ven todos; solo owner o admin lo cambian. */
export function RetentionDialog({ team, onClose }: { team: ChatTeam; onClose(): void }): React.JSX.Element {
  const selectId = useId()
  const hintId = useId()
  const allowed = canManageConv('team', team.role)
  const current = team.retentionHours === undefined ? NEVER : String(team.retentionHours)
  const [value, setValue] = useState(current)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()

  const save = async (): Promise<void> => {
    setBusy(true)
    setErr(undefined)
    try {
      await setRetention(team.id, parseRetention(value === NEVER ? null : Number(value)))
      onClose()
    } catch (e) {
      setErr(errText(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Borrar mensajes automáticamente"
      icon={<Timer size={18} weight="duotone" aria-hidden="true" />}
      size="sm"
      locked={busy}
      dirty={value !== current}
      onClose={onClose}
      footer={
        allowed ? (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancelar
            </Button>
            <Button variant="primary" onClick={() => void save()} loading={busy} disabled={value === current}>
              Guardar
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Cerrar</Button>
        )
      }
    >
      <div className="f-chat-settings">
        <label htmlFor={selectId}>Borrar los mensajes del equipo después de</label>
        <Select id={selectId} options={OPTIONS} value={value} disabled={!allowed || busy} aria-describedby={hintId} onChange={(e) => setValue(e.target.value)} />
        <p id={hintId} className="hint">
          {allowed
            ? 'Aplica a todo el equipo: los mensajes más viejos que el plazo desaparecen para todos y no se pueden recuperar.'
            : 'Solo owner o admin del equipo pueden cambiarlo.'}
        </p>
        {err && <InlineAlert tone="danger">{err}</InlineAlert>}
      </div>
    </Modal>
  )
}

/** Confirmación de «Vaciar conversación»: en un equipo se borra para todos; en un DM, solo de tu lado. */
export function ClearDialog({ conv, title, onClose }: { conv: ChatConvRef; title: string; onClose(): void }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()

  const clear = async (): Promise<void> => {
    setBusy(true)
    setErr(undefined)
    try {
      await clearConversation(conv)
      onClose()
    } catch (e) {
      setErr(errText(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Vaciar conversación"
      icon={<Broom size={18} weight="duotone" aria-hidden="true" />}
      size="sm"
      locked={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy} data-autofocus>
            Cancelar
          </Button>
          <Button variant="danger" onClick={() => void clear()} loading={busy}>
            {conv.kind === 'dm' ? 'Vaciar para mí' : 'Vaciar para todos'}
          </Button>
        </>
      }
    >
      <div className="f-chat-settings">
        {conv.kind === 'dm' ? (
          <p>
            Se borran los mensajes de <strong>{title}</strong> de tu lado. La otra persona los sigue viendo. Si el servidor del chat
            no tiene la actualización 0008, se borran para los dos.
          </p>
        ) : (
          <p>
            Se borran todos los mensajes de <strong>{title}</strong> para todos los participantes. No se puede deshacer.
          </p>
        )}
        {err && <InlineAlert tone="danger">{err}</InlineAlert>}
      </div>
    </Modal>
  )
}
