import { useId, useState } from 'react'
import type { ChatInvite, ChatTeam } from '../../../../../shared/chat'
import { useUi } from '../../host'
import { cleanError } from '../../../format'

const dateOf = (ms: number): string => new Date(ms).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })

/** Invitaciones pendientes (aceptar / rechazar). Se muestra arriba de la lista si hay. */
export function InvitesList({ invites, onJoined }: { invites: ChatInvite[]; onJoined(team: ChatTeam): void }): React.JSX.Element | null {
  const ui = useUi()
  const headId = useId()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set())
  const [err, setErr] = useState<string | null>(null)

  const pending = invites.filter((i) => !gone.has(i.id))
  if (pending.length === 0) return null

  const hide = (id: string): void => setGone((prev) => new Set(prev).add(id))

  const accept = async (inv: ChatInvite): Promise<void> => {
    setErr(null)
    setBusyId(inv.id)
    try {
      const team = await ui.invoke<ChatTeam>('feat:chat:acceptInvite', inv.id)
      hide(inv.id)
      onJoined(team)
    } catch (e) {
      setErr(cleanError(e))
    } finally {
      setBusyId(null)
    }
  }

  const decline = async (inv: ChatInvite): Promise<void> => {
    setErr(null)
    setBusyId(inv.id)
    try {
      await ui.invoke('feat:chat:declineInvite', inv.id)
      hide(inv.id)
    } catch (e) {
      setErr(cleanError(e))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="f-chat-team-invites" aria-labelledby={headId}>
      <h3 id={headId}>Invitaciones ({pending.length})</h3>
      <ul className="f-chat-team-list">
        {pending.map((inv) => {
          const busy = busyId === inv.id
          return (
            <li key={inv.id} className="f-chat-team-item">
              <div className="f-chat-team-item-main">
                <strong>{inv.teamName}</strong>
                <span className="field-help">
                  Te invitó {inv.invitedBy?.login ?? 'alguien'} · {dateOf(inv.createdAt)}
                </span>
              </div>
              <div className="f-chat-team-actions">
                <button type="button" className="btn sm primary" onClick={() => void accept(inv)} disabled={busy} aria-label={`Aceptar invitación a ${inv.teamName}`}>
                  {busy ? 'Un momento…' : 'Aceptar'}
                </button>
                <button type="button" className="btn sm ghost" onClick={() => void decline(inv)} disabled={busy} aria-label={`Rechazar invitación a ${inv.teamName}`}>
                  Rechazar
                </button>
              </div>
            </li>
          )
        })}
      </ul>
      {err && (
        <p className="form-error" role="alert">
          {err}
        </p>
      )}
    </section>
  )
}
