import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ChatsCircle, MagnifyingGlass, PencilSimple, UserPlus, UsersThree } from '@phosphor-icons/react'
import { type ChatConvRef, type ChatRole } from '../../../../shared/chat'
import { EmptyState, IconButton } from '../../ui'
import { Composer, type ComposerHandle } from './Composer'
import { MessageItem } from './MessageItem'
import { SearchBar } from './SearchBar'
import { seenUpTo, startsGroup, typingText } from './message-ops'
import { Av, dayLabel, sameDay } from './view-utils'
import {
  loadMessages,
  markRead,
  MAX_CACHED,
  useAnnouncement,
  useConvMessages,
  useConvMeta,
  useExtras,
  useExtrasMissing,
  useTyping
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
  me?: { id: string; login: string }
  /** Solo directos: hasta cuándo leyó el otro. */
  otherReadAt?: number
  onBack(): void
  onModal(kind: ChatModalKind): void
}

const NEEDS_UPDATE = 'Editar, borrar, responder y reaccionar necesitan que el admin del servidor aplique la actualización 0004 del chat.'
const TOO_OLD = 'Ese mensaje es muy viejo para mostrarlo acá.'
const FLASH_MS = 1600
const NOTICE_MS = 6000
let updateHintShown = false

/**
 * Una conversación (equipo o DM). Se monta con `key` por conversación, así el borrador y la carga
 * inicial son por conversación. Los mensajes nuevos llegan por el store.
 */
export function Conversation({ conv, title, photo, initial, role, me, otherReadAt, onBack, onModal }: Props): React.JSX.Element {
  const list = useConvMessages(conv)
  const info = useConvMeta(conv)
  const announce = useAnnouncement()
  const extras = useExtras()
  const extrasMissing = useExtrasMissing()
  const typing = useTyping(conv)
  const [loadErr, setLoadErr] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [searching, setSearching] = useState(false)
  const [flashId, setFlashId] = useState<string>()
  const scrollRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<ComposerHandle>(null)
  const searchBtnRef = useRef<HTMLButtonElement>(null)
  const pinRef = useRef(true)
  const prependRef = useRef<number | null>(null)
  const listRef = useRef(list)
  const infoRef = useRef(info)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  listRef.current = list
  infoRef.current = info
  const isTeam = conv.kind === 'team'
  const canManage = isTeam && (role === 'owner' || role === 'admin')

  // Al abrir: pedir los mensajes y marcar leído. Cada conversación tiene su propio montaje (key).
  useEffect(() => {
    markRead(conv)
    void loadMessages(conv).then((e) => e && setLoadErr(e))
    const pending = timers.current
    return () => pending.forEach(clearTimeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.kind, conv.id])

  // El aviso de la actualización 0004 sale una sola vez por sesión.
  useEffect(() => {
    if (!extrasMissing || updateHintShown) return
    updateHintShown = true
    setNotice(NEEDS_UPDATE)
  }, [extrasMissing])

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

  const later = (fn: () => void, ms: number): void => {
    timers.current.push(setTimeout(fn, ms))
  }

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
    if (e) setLoadErr(e)
  }

  const find = (id: string): HTMLElement | null =>
    [...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-mid]') ?? [])].find((n) => n.dataset.mid === id) ?? null

  const jump = async (id: string): Promise<void> => {
    pinRef.current = false
    while (!listRef.current.some((m) => m.id === id) && infoRef.current?.more && listRef.current.length < MAX_CACHED) {
      const e = await loadMessages(conv, true)
      if (e) {
        setLoadErr(e)
        return
      }
    }
    if (!listRef.current.some((m) => m.id === id)) {
      setNotice(TOO_OLD)
      later(() => setNotice(undefined), NOTICE_MS)
      return
    }
    requestAnimationFrame(() => {
      find(id)?.scrollIntoView({ block: 'center' })
      setFlashId(id)
      later(() => setFlashId(undefined), FLASH_MS)
    })
  }

  const closeSearch = (): void => {
    setSearching(false)
    requestAnimationFrame(() => searchBtnRef.current?.focus())
  }

  const items: React.ReactNode[] = []
  const now = Date.now()
  const seenId = me && conv.kind === 'dm' && extras ? seenUpTo(list, me.id, otherReadAt) : undefined
  list.forEach((msg, i) => {
    const prev = list[i - 1]
    if (!prev || !sameDay(prev.createdAt, msg.createdAt)) {
      items.push(
        <li key={`day-${msg.id}`} className="f-chat-day" role="presentation">
          <span>{dayLabel(msg.createdAt, now)}</span>
        </li>
      )
    }
    items.push(
      <MessageItem
        key={msg.id}
        msg={msg}
        mine={!!me && msg.author.id === me.id}
        me={me}
        head={startsGroup(prev, msg)}
        extras={extras}
        seen={msg.id === seenId}
        flash={msg.id === flashId}
        onReply={(m) => composerRef.current?.startReply(m)}
        onEdit={(m) => composerRef.current?.startEdit(m)}
        onJump={(mid) => void jump(mid)}
      />
    )
  })

  return (
    <>
      <header className="f-chat-head">
        <IconButton label="Volver a la lista" size="sm" icon={<ArrowLeft size={16} />} onClick={onBack} />
        <Av src={photo} initial={initial} size={28} />
        <h3 className="f-chat-title" title={title}>
          {title}
        </h3>
        <IconButton
          ref={searchBtnRef}
          label="Buscar en la conversación"
          size="sm"
          icon={<MagnifyingGlass size={16} />}
          pressed={searching}
          onClick={() => (searching ? closeSearch() : setSearching(true))}
        />
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

      {searching && <SearchBar conv={conv} onJump={(id) => void jump(id)} onClose={closeSearch} />}

      {loadErr && (
        <p className="f-chat-err f-chat-banner" role="alert">
          {loadErr}
        </p>
      )}
      {notice && (
        <p className="hint f-chat-banner" role="status">
          {notice}
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
        {info && list.length === 0 && (
          <EmptyState
            size="sm"
            as="h3"
            icon={<ChatsCircle size={28} />}
            title="Todavía no hay mensajes"
            description={isTeam ? 'Escribí el primero: lo ve todo el equipo.' : 'Escribí el primero.'}
          />
        )}
        <ol className="f-chat-list">{items}</ol>
      </div>

      {/* Mensajes nuevos de otros: se anuncian sin mover el foco. */}
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>
      <p className="f-chat-typing" aria-live="polite">
        {extras ? typingText(typing) : ''}
      </p>

      <Composer
        ref={composerRef}
        conv={conv}
        meId={me?.id}
        list={list}
        extras={extras}
        onSent={() => {
          pinRef.current = true
        }}
        onEscape={() => scrollRef.current?.focus()}
      />
    </>
  )
}
