import { useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { ArrowBendUpLeft, ArrowClockwise, CircleNotch, Copy, DotsThree, PencilSimple, Smiley, Trash, WarningCircle } from '@phosphor-icons/react'
import { CHAT_REACTIONS, type ChatMessage, type ChatReactionEmoji } from '../../../../shared/chat'
import { ContextMenu, IconButton, Menu, Tooltip, toast, type MenuItem } from '../../ui'
import { Av, LinkedText, timeLabel } from './view-utils'
import { ConfirmInline } from './teams/shared'
import { removeMessage, retrySend, errText, toggleReaction } from './store'

const REACTION_NAMES: Record<ChatReactionEmoji, string> = {
  '👍': 'Me gusta',
  '❤️': 'Me encanta',
  '😂': 'Jajaja',
  '🎉': 'Festejo',
  '😮': 'Sorpresa',
  '😢': 'Tristeza',
  '🙏': 'Gracias',
  '👀': 'Lo estoy mirando'
}

interface Props {
  msg: ChatMessage
  mine: boolean
  me?: { id: string; login: string }
  /** Primer mensaje de una tanda del mismo autor: lleva avatar y nombre. */
  head: boolean
  /** El servidor tiene la 0004: editar, borrar, responder y reaccionar. */
  extras: boolean
  /** «Visto» va debajo de este mensaje (solo en directos). */
  seen: boolean
  flash: boolean
  onReply(m: ChatMessage): void
  onEdit(m: ChatMessage): void
  onJump(id: string): void
}

const emojiIcon = (e: string): React.JSX.Element => <span className="f-chat-emoji">{e}</span>

export function MessageItem({ msg, mine, me, head, extras, seen, flash, onReply, onEdit, onJump }: Props): React.JSX.Element {
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const liRef = useRef<HTMLLIElement>(null)
  const deleted = msg.deletedAt !== undefined
  const sent = msg.status === 'sent'
  const name = msg.author.login === 'ex-miembro' ? 'Ex miembro' : msg.author.login
  const canAct = extras && sent && !deleted && !!me

  const copy = (): void => {
    window.sloth.clipboardWrite(msg.body).then(
      () => toast({ tone: 'success', message: 'Copiado' }),
      (e: unknown) => toast({ tone: 'danger', message: errText(e) })
    )
  }
  const react = (e: ChatReactionEmoji): void => {
    if (me) toggleReaction(msg, e, me)
  }
  const doRemove = (): void => {
    setConfirming(false)
    removeMessage(msg).catch((e: unknown) => toast({ tone: 'danger', message: errText(e) }))
  }

  const reactItems = (long: boolean): MenuItem[] =>
    CHAT_REACTIONS.map((e) => ({
      id: `react-${e}`,
      label: long ? `Reaccionar con «${REACTION_NAMES[e]}»` : REACTION_NAMES[e],
      icon: emojiIcon(e),
      onSelect: () => react(e)
    }))

  const moreItems = (withReactions: boolean): MenuItem[] => {
    const items: MenuItem[] = []
    if (canAct) {
      items.push({ id: 'reply', label: 'Responder', icon: <ArrowBendUpLeft size={14} />, onSelect: () => onReply(msg) })
      if (withReactions) items.push({ type: 'separator' }, ...reactItems(true), { type: 'separator' })
    }
    items.push({ id: 'copy', label: 'Copiar texto', icon: <Copy size={14} />, onSelect: copy })
    if (canAct && mine) items.push({ id: 'edit', label: 'Editar', icon: <PencilSimple size={14} />, onSelect: () => onEdit(msg) })
    if (mine && (canAct || !sent)) {
      items.push({ id: 'delete', label: 'Eliminar', icon: <Trash size={14} />, danger: true, onSelect: () => setConfirming(true) })
    }
    return items
  }

  const openCtx = (e: MouseEvent): void => {
    if (deleted) return
    e.preventDefault()
    setCtx({ x: e.clientX, y: e.clientY })
  }
  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>): void => {
    if (e.target !== e.currentTarget || deleted) return
    if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return
    e.preventDefault()
    const r = e.currentTarget.getBoundingClientRect()
    setCtx({ x: r.left + 24, y: r.top + 24 })
  }

  const cls = ['f-chat-msg', mine && 'mine', head && 'head', flash && 'flash', msg.status === 'failed' && 'failed', deleted && 'deleted']
    .filter(Boolean)
    .join(' ')

  return (
    <li className={cls} data-mid={msg.id} ref={liRef} tabIndex={0} onContextMenu={openCtx} onKeyDown={onKeyDown}>
      {!mine && (head ? <Av src={msg.author.avatarUrl} initial={msg.author.login} size={28} /> : <span className="f-chat-av-gap" aria-hidden="true" />)}
      <div className="f-chat-msg-body">
        {head && (
          <div className="f-chat-msg-head">
            {!mine && <strong>{name}</strong>}
            <time dateTime={new Date(msg.createdAt).toISOString()}>{timeLabel(msg.createdAt)}</time>
          </div>
        )}
        <div className="f-chat-bubble">
          {(!head || mine) && <span className="sr-only">{name}: </span>}
          {msg.replyTo && !deleted && (
            <button type="button" className="f-chat-quote" onClick={() => onJump(msg.replyTo!.id)} aria-label={`Ir al mensaje citado de ${msg.replyTo.authorLogin}`}>
              <strong>@{msg.replyTo.authorLogin}</strong>
              <span>{msg.replyTo.deleted ? 'Mensaje eliminado' : msg.replyTo.excerpt}</span>
            </button>
          )}
          {deleted ? (
            <p className="f-chat-text f-chat-text-gone">Mensaje eliminado</p>
          ) : (
            <p className="f-chat-text">
              <LinkedText text={msg.body} meLogin={me?.login} />
              {msg.editedAt !== undefined && (
                <span className="f-chat-edited" title={`Editado ${new Date(msg.editedAt).toLocaleString('es-AR')}`}>
                  {' '}
                  (editado)
                </span>
              )}
            </p>
          )}
        </div>

        {!deleted && msg.reactions && msg.reactions.length > 0 && (
          <div className="f-chat-reacts">
            {msg.reactions.map((r) => {
              const own = !!me && r.userIds.includes(me.id)
              return (
                <Tooltip key={r.emoji} text={r.logins.join(', ')} placement="top">
                  <button
                    type="button"
                    className="f-chat-react"
                    aria-pressed={own}
                    aria-label={`${r.emoji} ${r.userIds.length}, ${REACTION_NAMES[r.emoji]}`}
                    disabled={!canAct}
                    onClick={() => react(r.emoji)}
                  >
                    <span aria-hidden="true">{r.emoji}</span>
                    <span aria-hidden="true">{r.userIds.length}</span>
                  </button>
                </Tooltip>
              )
            })}
          </div>
        )}

        {msg.status === 'sending' && (
          <span className="f-chat-state">
            <CircleNotch size={12} className="f-chat-spin" aria-hidden="true" />
            Enviando…
          </span>
        )}
        {msg.status === 'failed' && (
          <span className="f-chat-state err">
            <WarningCircle size={12} weight="fill" aria-hidden="true" />
            No se envió ·{' '}
            <button type="button" className="f-chat-retry" onClick={() => void retrySend(msg)}>
              <ArrowClockwise size={12} aria-hidden="true" />
              Reintentar
            </button>
          </span>
        )}
        {msg.status === 'failed' && msg.error && <span className="hint f-chat-errline">{msg.error}</span>}
        {seen && <span className="f-chat-seen">Visto</span>}

        {confirming && (
          <ConfirmInline
            id={`del-${msg.id}`}
            message="¿Eliminar el mensaje? Lo deja de ver todo el equipo."
            confirmLabel="Eliminar"
            onConfirm={doRemove}
            onCancel={() => setConfirming(false)}
          />
        )}
      </div>

      {!deleted && !confirming && (
        <div className="f-chat-bar">
          {canAct && (
            <Menu
              aria-label="Reaccionar"
              items={reactItems(false)}
              trigger={(p) => <IconButton {...p} label="Reaccionar" size="sm" icon={<Smiley size={14} />} />}
            />
          )}
          {canAct && <IconButton label="Responder" size="sm" icon={<ArrowBendUpLeft size={14} />} onClick={() => onReply(msg)} />}
          <Menu
            aria-label="Más acciones"
            items={moreItems(false)}
            trigger={(p) => <IconButton {...p} label="Más acciones" size="sm" icon={<DotsThree size={14} weight="bold" />} />}
          />
        </div>
      )}

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          aria-label="Acciones del mensaje"
          items={moreItems(true)}
          onClose={(back) => {
            setCtx(null)
            if (back) liRef.current?.focus()
          }}
        />
      )}
    </li>
  )
}
