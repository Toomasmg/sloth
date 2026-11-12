import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { ArrowClockwise, ArrowLeft, CircleNotch, PaperPlaneRight, PencilSimple, UserPlus, UsersThree, WarningCircle } from '@phosphor-icons/react'
import { CHAT_LIMITS, type ChatConvRef, type ChatMessage, type ChatRole } from '../../../../shared/chat'
import { Av, dayLabel, LinkedText, sameDay, timeLabel } from './view-utils'
import {
  errText,
  getDraft,
  loadMessages,
  markRead,
  retrySend,
  sendMessage,
  setDraft,
  useAnnouncement,
  useConvMessages,
  useConvMeta
} from './store'

export type ChatModalKind = 'members' | 'invite' | 'editTeam'

interface Props {
  conv: ChatConvRef
  title: string
  /** Foto (team) o avatar (dm) y la inicial para el avatar de la cabecera. */
  photo?: string
  initial: string
  /** Solo equipos: rol del usuario (define qué botones se muestran). */
  role?: ChatRole
  meId?: string
  onBack(): void
  onModal(kind: ChatModalKind): void
}

/**
 * Una conversación (equipo o DM). Se monta con `key` por conversación, así el borrador y la carga
 * inicial son por conversación. Sin timers: los mensajes nuevos llegan por el store.
 */
export function Conversation({ conv, title, photo, initial, role, meId, onBack, onModal }: Props): React.JSX.Element {
  const list = useConvMessages(conv)
  const info = useConvMeta(conv)
  const announce = useAnnouncement()
  const [text, setText] = useState(() => getDraft(conv))
  const [err, setErr] = useState<string>()
  const [loadingOlder, setLoadingOlder] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinRef = useRef(true)
  const prependRef = useRef<number | null>(null)
  const taId = useId()
  const countId = useId()
  const isTeam = conv.kind === 'team'
  const canManage = isTeam && (role === 'owner' || role === 'admin')
  const over = text.length > CHAT_LIMITS.body
  const near = text.length > CHAT_LIMITS.body - 300

  // Al abrir: pedir los mensajes y marcar leído. Cada conversación tiene su propio montaje (key).
  useEffect(() => {
    markRead(conv)
    void loadMessages(conv).then((e) => e && setErr(e))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.kind, conv.id])

  // Scroll: al fondo si estabas abajo o mandaste algo; al cargar anteriores, mantené la posición.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (prependRef.current !== null) {
      el.scrollTop = el.scrollHeight - prependRef.current
      prependRef.current = null
      return
    }
    if (pinRef.current) el.scrollTop = el.scrollHeight
  }, [list])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (el) pinRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const older = async (): Promise<void> => {
    const el = scrollRef.current
    if (el) prependRef.current = el.scrollHeight - el.scrollTop
    setLoadingOlder(true)
    const e = await loadMessages(conv, true)
    setLoadingOlder(false)
    if (e) setErr(e)
  }

  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault()
    const body = text.trim()
    if (!body || over) return
    setText('')
    setDraft(conv, '')
    setErr(undefined)
    pinRef.current = true
    try {
      await sendMessage(conv, body)
    } catch (ex) {
      setErr(errText(ex))
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  const items: React.ReactNode[] = []
  const now = Date.now()
  list.forEach((msg, i) => {
    const prev = list[i - 1]
    if (!prev || !sameDay(prev.createdAt, msg.createdAt)) {
      items.push(
        <li key={`day-${msg.id}`} className="f-chat-day" role="presentation">
          <span>{dayLabel(msg.createdAt, now)}</span>
        </li>
      )
    }
    items.push(<MessageItem key={msg.id} msg={msg} mine={!!meId && msg.author.id === meId} />)
  })

  return (
    <>
      <header className="f-chat-head">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Volver a la lista">
          <ArrowLeft size={16} aria-hidden="true" />
        </button>
        <Av src={photo} initial={initial} size={24} />
        <h3 className="f-chat-title" title={title}>
          {title}
        </h3>
      </header>
      {isTeam && (
        <div className="f-chat-subbar">
          <button type="button" className="btn sm ghost" onClick={() => onModal('members')}>
            <UsersThree size={14} aria-hidden="true" />
            Miembros
          </button>
          {canManage && (
            <button type="button" className="btn sm ghost" onClick={() => onModal('invite')}>
              <UserPlus size={14} aria-hidden="true" />
              Invitar
            </button>
          )}
          {canManage && (
            <button type="button" className="btn sm ghost" onClick={() => onModal('editTeam')}>
              <PencilSimple size={14} aria-hidden="true" />
              Editar
            </button>
          )}
        </div>
      )}

      {err && (
        <p className="f-chat-err" role="alert">
          {err}
        </p>
      )}

      <div className="f-chat-scroll" ref={scrollRef} onScroll={onScroll} tabIndex={0} role="region" aria-label="Mensajes">
        {info?.more && (
          <div className="f-chat-more">
            <button type="button" className="btn sm ghost" onClick={() => void older()} disabled={loadingOlder}>
              {loadingOlder ? 'Cargando…' : 'Cargar anteriores'}
            </button>
          </div>
        )}
        {!info && <p className="hint f-chat-empty">Cargando mensajes…</p>}
        {info && list.length === 0 && <p className="hint f-chat-empty">Todavía no hay mensajes. Escribí el primero.</p>}
        <ol className="f-chat-list">{items}</ol>
      </div>

      {/* Mensajes nuevos de otros: se anuncian sin mover el foco. */}
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>

      <form className="f-chat-composer" onSubmit={(e) => void submit(e)}>
        <label className="sr-only" htmlFor={taId}>
          Escribí un mensaje
        </label>
        <textarea
          id={taId}
          rows={2}
          value={text}
          placeholder="Escribí un mensaje. Enter envía, Shift+Enter salta de línea."
          aria-describedby={countId}
          aria-invalid={over || undefined}
          onChange={(e) => {
            setText(e.target.value)
            setDraft(conv, e.target.value)
          }}
          onKeyDown={onKey}
        />
        <div className="f-chat-composer-foot">
          <span id={countId} className={over ? 'f-chat-count over' : 'f-chat-count'}>
            {over ? `Pasaste el límite: ${text.length}/${CHAT_LIMITS.body}` : near ? `${text.length}/${CHAT_LIMITS.body}` : ''}
          </span>
          <button type="submit" className="btn primary sm" disabled={!text.trim() || over}>
            <PaperPlaneRight size={14} aria-hidden="true" />
            Enviar
          </button>
        </div>
      </form>
    </>
  )
}

function MessageItem({ msg, mine }: { msg: ChatMessage; mine: boolean }): React.JSX.Element {
  const name = msg.author.login === 'ex-miembro' ? 'Ex miembro' : msg.author.login
  const cls = ['f-chat-msg', mine ? 'mine' : '', msg.status === 'failed' ? 'failed' : ''].filter(Boolean).join(' ')
  return (
    <li className={cls}>
      <Av src={msg.author.avatarUrl} initial={msg.author.login} />
      <div className="f-chat-msg-body">
        <div className="f-chat-msg-head">
          <strong>{name}</strong>
          <time dateTime={new Date(msg.createdAt).toISOString()}>{timeLabel(msg.createdAt)}</time>
        </div>
        <p className="f-chat-text">
          <LinkedText text={msg.body} />
        </p>
        {msg.status === 'sending' && (
          <span className="f-chat-state">
            <CircleNotch size={12} className="f-chat-spin" aria-hidden="true" />
            Enviando…
          </span>
        )}
        {msg.status === 'failed' && (
          <span className="f-chat-state err">
            <WarningCircle size={12} weight="fill" aria-hidden="true" />
            No se envió · <button type="button" className="f-chat-retry" onClick={() => void retrySend(msg)}>
              <ArrowClockwise size={12} aria-hidden="true" />
              Reintentar
            </button>
          </span>
        )}
        {msg.status === 'failed' && msg.error && <span className="hint f-chat-errline">{msg.error}</span>}
      </div>
    </li>
  )
}
