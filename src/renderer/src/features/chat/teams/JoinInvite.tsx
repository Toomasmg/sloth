import { useEffect, useId, useRef, useState } from 'react'
import { CircleNotch, ClipboardText, Ticket } from '@phosphor-icons/react'
import type { ChatInviteJoin, ChatInvitePreview } from '../../../../../shared/chat'
import { Modal } from '../../../Modal'
import { Button, InlineAlert, Textarea } from '../../../ui'
import { useUi } from '../../host'
import { clearInviteError, closeJoinInvite, errText, joinedTeam, useInviteError } from '../store'

type Phase = { kind: 'paste' } | { kind: 'confirm'; preview: ChatInvitePreview } | { kind: 'waiting'; teamName?: string }

const PREFIX = 'sloth-invitacion:'

/**
 * Unirse al chat con una invitación completa: se pega, main la valida y dice qué va a pasar. Si hay
 * que conectar a un servidor (nuevo o distinto del actual) se muestra el host y se pide confirmación.
 * El texto pegado solo viaja a main como dato: no se interpreta acá.
 */
export function JoinInvite(): React.JSX.Element {
  const ui = useUi()
  const fieldId = useId()
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'paste' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [offer, setOffer] = useState<string | null>(null)
  const pendingErr = useInviteError()
  const textRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let alive = true
    ui.invoke<string | null>('feat:chat:clipboardInvite').then(
      (t) => {
        if (alive && t) setOffer(t)
      },
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [ui])

  useEffect(() => {
    if (!pendingErr) return
    setErr(pendingErr)
    setPhase({ kind: 'paste' })
    clearInviteError()
  }, [pendingErr])

  const join = async (confirmed?: 'confirmNew' | 'confirmReplace', teamName?: string): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      const r = await ui.invoke<ChatInviteJoin>('feat:chat:joinInvite', text, confirmed)
      if (r.kind === 'joined') joinedTeam(r.team)
      else setPhase({ kind: 'waiting', teamName })
    } catch (e) {
      setErr(errText(e))
      setPhase({ kind: 'paste' })
    } finally {
      setBusy(false)
    }
  }

  const review = async (): Promise<void> => {
    if (busy) return
    if (!text.trim()) {
      setErr('Pegá la invitación que te mandaron.')
      textRef.current?.focus()
      return
    }
    setBusy(true)
    setErr(null)
    let preview: ChatInvitePreview
    try {
      preview = await ui.invoke<ChatInvitePreview>('feat:chat:previewInvite', text)
    } catch (e) {
      setErr(errText(e))
      setBusy(false)
      textRef.current?.focus()
      return
    }
    setBusy(false)
    if (preview.decision === 'confirmNew' || preview.decision === 'confirmReplace') setPhase({ kind: 'confirm', preview })
    else void join(undefined, preview.teamName)
  }

  const cancelLogin = (): void => {
    ui.invoke('feat:chat:cancelSignIn').catch((e: unknown) => setErr(errText(e)))
  }

  const teamLabel = (name?: string): string => (name ? `«${name}»` : 'el equipo')

  let body: React.ReactNode
  let footer: React.ReactNode
  if (phase.kind === 'paste') {
    body = (
      <>
        <p className="f-chat-join-lead">Pegá el texto que te mandaron. Trae el servidor del chat y el código del equipo: Sloth configura todo y te pide iniciar sesión con GitHub.</p>
        {offer && !text && (
          <InlineAlert
            tone="info"
            action={
              <Button size="sm" icon={<ClipboardText size={14} aria-hidden="true" />} onClick={() => {
                  setText(offer)
                  setErr(null)
                  textRef.current?.focus()
                }}
              >
                Pegarla
              </Button>
            }
          >
            Tenés una invitación copiada.
          </InlineAlert>
        )}
        <label className="f-chat-join-label" htmlFor={fieldId}>
          Invitación
        </label>
        <Textarea
          ref={textRef}
          id={fieldId}
          rows={4}
          value={text}
          data-autofocus
          spellCheck={false}
          autoComplete="off"
          placeholder={`${PREFIX}v1.…`}
          maxLength={8000}
          disabled={busy}
          error={err ?? undefined}
          onChange={(e) => {
            setText(e.target.value)
            if (err) setErr(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void review()
            }
          }}
        />
      </>
    )
    footer = (
      <>
        <Button variant="ghost" onClick={closeJoinInvite} disabled={busy}>
          Cancelar
        </Button>
        <Button variant="primary" loading={busy} onClick={() => void review()}>
          Continuar
        </Button>
      </>
    )
  } else if (phase.kind === 'confirm') {
    const p = phase.preview
    const replace = p.decision === 'confirmReplace'
    body = (
      <>
        <p className="f-chat-join-lead">Vas a conectar el chat a este servidor para entrar a {teamLabel(p.teamName)}:</p>
        <p className="f-chat-join-host mono" aria-label={`Servidor: ${p.host}`}>
          {p.host}
        </p>
        {replace ? (
          <InlineAlert tone="warning">
            Ya tenés el chat conectado a <strong>{p.currentHost}</strong>. Si seguís, esa configuración se reemplaza y se cierra tu sesión del chat.
          </InlineAlert>
        ) : (
          <p className="f-chat-join-note">Seguí solo si la invitación te la mandó alguien de tu equipo. Después se abre GitHub en el navegador para iniciar sesión.</p>
        )}
        {err && <InlineAlert tone="danger">{err}</InlineAlert>}
      </>
    )
    footer = (
      <>
        <Button variant="ghost" onClick={() => setPhase({ kind: 'paste' })} disabled={busy}>
          Volver
        </Button>
        <Button variant={replace ? 'danger' : 'primary'} loading={busy} data-autofocus onClick={() => void join(p.decision === 'confirmReplace' ? 'confirmReplace' : 'confirmNew', p.teamName)}>
          {replace ? 'Reemplazar y entrar' : 'Conectar y entrar'}
        </Button>
      </>
    )
  } else {
    body = (
      <>
        <p className="f-chat-join-wait" role="status">
          <CircleNotch size={16} className="f-chat-spin" aria-hidden="true" /> Terminá de iniciar sesión con GitHub en el navegador.
        </p>
        <p className="f-chat-join-note">Apenas vuelvas, entrás a {teamLabel(phase.teamName)}. Podés cerrar esta ventana: el equipo se abre solo.</p>
      </>
    )
    footer = (
      <>
        <Button variant="ghost" onClick={cancelLogin}>
          Cancelar inicio de sesión
        </Button>
        <Button onClick={closeJoinInvite}>Cerrar</Button>
      </>
    )
  }

  return (
    <Modal
      title="Unirme con una invitación"
      icon={<Ticket size={18} weight="duotone" aria-hidden="true" />}
      size="sm"
      locked={busy}
      onClose={closeJoinInvite}
      footer={footer}
    >
      <div className="f-chat-join">{body}</div>
    </Modal>
  )
}
