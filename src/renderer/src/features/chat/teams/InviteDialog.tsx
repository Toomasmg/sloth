import { useEffect, useId, useRef, useState } from 'react'
import { ArrowsClockwise, Check, Copy, Ticket, UserPlus } from '@phosphor-icons/react'
import type { ChatInviteSent, ChatTeam } from '../../../../../shared/chat'
import { useUi } from '../../host'
import { cleanError } from '../../../format'
import { canManage, ConfirmInline, TeamModal } from './shared'

const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/

/** Invitar por usuario de GitHub y mostrar/copiar/regenerar el código (owner/admin). */
export function InviteDialog({ team, onClose }: { team: ChatTeam; onClose(): void }): React.JSX.Element {
  const ui = useUi()
  const titleId = useId()
  const loginId = useId()
  const errId = useId()
  const allowed = canManage(team.role)
  const copyTimer = useRef<number | undefined>(undefined)

  const [login, setLogin] = useState('')
  const [code, setCode] = useState(team.inviteCode ?? '')
  const [busy, setBusy] = useState<'invite' | 'code' | 'full' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [copied, setCopied] = useState<'code' | 'full' | null>(null)
  const [confirmCode, setConfirmCode] = useState(false)

  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  const invite = async (): Promise<void> => {
    const l = login.trim()
    setErr(null)
    setStatus(null)
    if (!LOGIN_RE.test(l)) {
      setErr('Usuario de GitHub no válido. Solo letras, números y guiones, sin @.')
      return
    }
    setBusy('invite')
    try {
      const sent = await ui.invoke<ChatInviteSent>('feat:chat:inviteByLogin', team.id, l)
      setStatus(`Listo: invitaste a ${sent.githubLogin}. Lo va a ver en Sloth.`)
      setLogin('')
    } catch (e) {
      setErr(cleanError(e))
    } finally {
      setBusy(null)
    }
  }

  const markCopied = (what: 'code' | 'full'): void => {
    setErr(null)
    setCopied(what)
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(null), 2000)
  }

  const copyCode = (): void => {
    if (!code) return
    window.sloth
      .clipboardWrite(`Entrá a Sloth → Chat → Entrar con código: ${code}`)
      .then(() => markCopied('code'))
      .catch((e) => setErr(`No se pudo copiar: ${cleanError(e)}`))
  }

  const copyFull = async (): Promise<void> => {
    if (!code) return
    setErr(null)
    setStatus(null)
    setBusy('full')
    try {
      const token = await ui.invoke<string>('feat:chat:inviteText', team.id, code)
      await window.sloth.clipboardWrite(`Sumate al chat de «${team.name}» en Sloth: abrí el Chat, tocá «Unirme con una invitación» y pegá este texto entero.

${token}`)
      markCopied('full')
      setStatus('Invitación copiada. Quien la tenga puede entrar al equipo: mandala por privado.')
    } catch (e) {
      setErr(`No se pudo copiar: ${cleanError(e)}`)
    } finally {
      setBusy(null)
    }
  }

  const regenerate = async (): Promise<void> => {
    setErr(null)
    setStatus(null)
    setBusy('code')
    try {
      const next = await ui.invoke<string>('feat:chat:regenerateCode', team.id)
      setCode(next)
      setConfirmCode(false)
      setStatus('Código nuevo listo. El anterior ya no anda.')
    } catch (e) {
      setErr(cleanError(e))
      setConfirmCode(false)
    } finally {
      setBusy(null)
    }
  }

  const askRegenerate = (): void => {
    // Sin código todavía, no hay nada que invalidar: se genera directo.
    if (!code) void regenerate()
    else setConfirmCode(true)
  }

  return (
    <TeamModal titleId={titleId} title={`Invitar a ${team.name}`} icon={<UserPlus size={18} weight="duotone" />} busy={busy !== null} onClose={onClose}>
      {!allowed ? (
        <p className="field-help">Solo el owner o un admin puede invitar.</p>
      ) : (
        <>
          <form
            className="f-chat-team-form"
            onSubmit={(e) => {
              e.preventDefault()
              if (busy === null) void invite()
            }}
          >
            <div className="field">
              <label htmlFor={loginId}>Usuario de GitHub</label>
              <div className="input-row">
                <input
                  id={loginId}
                  className="mono"
                  value={login}
                  onChange={(e) => setLogin(e.target.value)}
                  maxLength={39}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  disabled={busy !== null}
                  placeholder="usuario-de-github"
                  aria-describedby={`${errId} ${loginId}-hint`}
                  aria-invalid={err ? true : undefined}
                />
                <button type="submit" className="btn primary" disabled={busy !== null || login.trim() === ''}>
                  {busy === 'invite' ? 'Invitando…' : 'Invitar'}
                </button>
              </div>
              <p id={`${loginId}-hint`} className="field-help">
                Sin @. Solo letras, números y guiones.
              </p>
            </div>
          </form>

          <section className="f-chat-team-code-block" aria-labelledby={`${titleId}-code`}>
            <h3 id={`${titleId}-code`}>Código de invitación</h3>
            <p className="field-help">Quien lo tenga puede entrar al equipo desde Sloth → Chat → Entrar con código.</p>
            <div className="f-chat-team-code-row">
              {code ? (
                <code className="f-chat-team-code mono">{code}</code>
              ) : (
                <span className="field-help">Todavía no hay código.</span>
              )}
              <div className="f-chat-team-actions">
                <button type="button" className="btn sm" onClick={copyCode} disabled={!code || busy !== null}>
                  {copied === 'code' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                  {copied === 'code' ? 'Copiado' : 'Copiar'}
                </button>
                <button type="button" className="btn sm" onClick={askRegenerate} disabled={busy !== null || confirmCode}>
                  <ArrowsClockwise size={14} aria-hidden="true" />
                  {busy === 'code' ? 'Cambiando…' : code ? 'Cambiar código' : 'Generar código'}
                </button>
              </div>
            </div>
            <div className="f-chat-team-full">
              <p className="field-help">Para alguien que todavía no tiene el chat: trae el servidor y el código, y entra en un solo paso.</p>
              <button type="button" className="btn sm primary" onClick={() => void copyFull()} disabled={!code || busy !== null || confirmCode}>
                {copied === 'full' ? <Check size={14} aria-hidden="true" /> : <Ticket size={14} aria-hidden="true" />}
                {busy === 'full' ? 'Copiando…' : copied === 'full' ? 'Copiado' : 'Copiar invitación completa'}
              </button>
            </div>
            {confirmCode && (
              <ConfirmInline
                id={`${titleId}-confirm`}
                message="El código viejo deja de andar. ¿Cambiarlo igual?"
                confirmLabel="Sí, cambiar código"
                busy={busy !== null}
                onConfirm={() => void regenerate()}
                onCancel={() => setConfirmCode(false)}
              />
            )}
          </section>
        </>
      )}

      {err && (
        <p id={errId} className="form-error" role="alert">
          {err}
        </p>
      )}
      {status && (
        <p className="f-chat-team-status" role="status">
          <Check size={14} aria-hidden="true" /> {status}
        </p>
      )}

      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy !== null}>
          Cerrar
        </button>
      </div>
    </TeamModal>
  )
}
