import { useEffect, useId, useState } from 'react'
import { ChatCircle, Crown, ShieldCheck, SignOut, Users, UserMinus } from '@phosphor-icons/react'
import type { ChatMember, ChatSnapshot, ChatTeam, ChatThread } from '../../../../../shared/chat'
import { useUi } from '../../host'
import { cleanError } from '../../../format'
import { Avatar, canManage, ConfirmInline, roleLabel, TeamModal } from './shared'

type Confirm = { kind: 'remove'; member: ChatMember } | { kind: 'leave' } | null

/** Miembros del equipo: avatar, login, rol; «Escribirle» abre DM; owner/admin pueden sacar members; «Salir del equipo». */
export function MembersPanel({
  team,
  onClose,
  onOpenDm,
  onLeft
}: {
  team: ChatTeam
  onClose(): void
  onOpenDm(thread: ChatThread): void
  onLeft(): void
}): React.JSX.Element {
  const ui = useUi()
  const titleId = useId()
  const allowed = canManage(team.role)

  const [members, setMembers] = useState<ChatMember[] | null>(null)
  const [meId, setMeId] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [err, setErr] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const reload = async (): Promise<void> => {
    try {
      setMembers(await ui.invoke<ChatMember[]>('feat:chat:members', team.id))
    } catch (e) {
      setErr(cleanError(e))
      setMembers([])
    }
  }

  // Una sola carga al abrir (sin polling). El id propio sale de state() para no mostrar «Escribirle» a uno mismo.
  useEffect(() => {
    void reload()
    void ui
      .invoke<ChatSnapshot>('feat:chat:state')
      .then((snap) => setMeId(snap.auth.status === 'signedIn' ? snap.auth.me.id : null))
      .catch(() => setMeId(null))
  }, [team.id])

  const writeTo = async (m: ChatMember): Promise<void> => {
    setErr(null)
    setStatus(null)
    setBusyKey(`dm:${m.profile.id}`)
    try {
      const thread = await ui.invoke<ChatThread>('feat:chat:openDm', m.profile.id)
      onOpenDm(thread)
    } catch (e) {
      setErr(cleanError(e))
    } finally {
      setBusyKey(null)
    }
  }

  const runConfirm = async (c: Exclude<Confirm, null>): Promise<void> => {
    setErr(null)
    setStatus(null)
    setBusyKey('confirm')
    try {
      if (c.kind === 'leave') {
        await ui.invoke('feat:chat:leaveTeam', team.id)
        onLeft()
        return
      }
      await ui.invoke('feat:chat:removeMember', team.id, c.member.profile.id)
      setConfirm(null)
      setStatus(`Sacaste a ${c.member.profile.login} del equipo.`)
      await reload()
    } catch (e) {
      setErr(cleanError(e))
      setConfirm(null)
    } finally {
      setBusyKey(null)
    }
  }

  const me = members?.find((m) => m.profile.id === meId)

  return (
    <TeamModal titleId={titleId} title={`Miembros de ${team.name}`} icon={<Users size={18} weight="duotone" />} busy={busyKey !== null} onClose={onClose}>
      {members === null ? (
        <p className="field-help" role="status">
          Cargando miembros…
        </p>
      ) : (
        <ul className="f-chat-team-list" aria-label={`Miembros de ${team.name}`}>
          {members.map((m) => {
            const isMe = m.profile.id === meId
            const canRemove = allowed && !isMe && m.role === 'member'
            return (
              <li key={m.profile.id} className="f-chat-team-item">
                <Avatar profile={m.profile} />
                <div className="f-chat-team-item-main">
                  <strong>
                    {m.profile.login}
                    {isMe && <span className="f-chat-team-you"> (vos)</span>}
                  </strong>
                  {m.profile.name && <span className="field-help">{m.profile.name}</span>}
                </div>
                <span className={`f-chat-team-role r-${m.role}`}>
                  {m.role === 'owner' ? <Crown size={12} aria-hidden="true" /> : m.role === 'admin' ? <ShieldCheck size={12} aria-hidden="true" /> : null}
                  {roleLabel(m.role)}
                </span>
                <div className="f-chat-team-actions">
                  {!isMe && (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => void writeTo(m)}
                      disabled={busyKey !== null}
                      aria-label={`Escribirle a ${m.profile.login}`}
                    >
                      <ChatCircle size={14} aria-hidden="true" />
                      {busyKey === `dm:${m.profile.id}` ? 'Abriendo…' : 'Escribirle'}
                    </button>
                  )}
                  {canRemove && (
                    <button
                      type="button"
                      className="btn sm danger"
                      onClick={() => setConfirm({ kind: 'remove', member: m })}
                      disabled={busyKey !== null || confirm !== null}
                      aria-label={`Sacar a ${m.profile.login} del equipo`}
                    >
                      <UserMinus size={14} aria-hidden="true" />
                      Sacar
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {confirm?.kind === 'remove' && (
        <ConfirmInline
          id={`${titleId}-remove`}
          message={`¿Sacar a ${confirm.member.profile.login} de ${team.name}? Deja de ver los mensajes del equipo.`}
          confirmLabel="Sacar del equipo"
          busy={busyKey !== null}
          onConfirm={() => void runConfirm(confirm)}
          onCancel={() => setConfirm(null)}
        />
      )}

      {err && (
        <p className="form-error" role="alert">
          {err}
        </p>
      )}
      {status && (
        <p className="f-chat-team-status" role="status">
          {status}
        </p>
      )}

      <footer className="f-chat-team-footer">
        {me?.role === 'owner' ? (
          <p className="field-help">El owner no puede salir</p>
        ) : confirm?.kind === 'leave' ? (
          <ConfirmInline
            id={`${titleId}-leave`}
            message={`¿Salir de ${team.name}? Ya no vas a ver sus mensajes hasta que te vuelvan a invitar.`}
            confirmLabel="Salir del equipo"
            busy={busyKey !== null}
            onConfirm={() => void runConfirm({ kind: 'leave' })}
            onCancel={() => setConfirm(null)}
          />
        ) : (
          <button
            type="button"
            className="btn sm ghost f-chat-team-leave"
            onClick={() => setConfirm({ kind: 'leave' })}
            disabled={busyKey !== null || confirm !== null || members === null || !me}
          >
            <SignOut size={14} aria-hidden="true" />
            Salir del equipo
          </button>
        )}
        <span className="field-help">{members?.length ?? 0} en el equipo</span>
      </footer>

      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busyKey !== null}>
          Cerrar
        </button>
      </div>
    </TeamModal>
  )
}
