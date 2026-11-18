import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Broom, ChatsCircle, DotsThree, MagnifyingGlass, PencilSimple, Timer, UserPlus, UsersThree } from '@phosphor-icons/react'
import { type ChatConvRef, type ChatMessage, type ChatRetentionHours, type ChatRole } from '../../../../shared/chat'
import { canManageConv, dropExpired, noticeText, retentionLabel } from '../../../../shared/chat-retention'
import { EmptyState, IconButton, Menu, type MenuItem } from '../../ui'
import { Composer, type ComposerHandle } from './Composer'
import { MessageItem } from './MessageItem'
import { activeReduce, scrolledFar } from './active-msg'
import { vigilarVencimiento } from './expiracion'
import { SearchBar } from './SearchBar'
import { proximoVencimiento, seenUpTo, startsGroup, typingText } from './message-ops'
import { Av, dayLabel, sameDay } from './view-utils'
import {
  loadMessages,
  markRead,
  MAX_CACHED,
  PAGE,
  peekConv,
  useAnnouncement,
  useConvMessages,
  useConvMeta,
  useExtras,
  useExtrasMissing,
  useTyping
} from './store'

export type ChatModalKind = 'members' | 'invite' | 'editTeam' | 'retention' | 'clear'

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
  /** Solo equipos: borrado automático, en horas. */
  retentionHours?: ChatRetentionHours
  onBack(): void
  onModal(kind: ChatModalKind): void
}

const NEEDS_UPDATE = 'Editar, borrar, responder y reaccionar necesitan que el admin del servidor aplique la actualización 0004 del chat.'
const TOO_OLD = 'Ese mensaje es muy viejo para mostrarlo acá.'
const FLASH_MS = 1600
const MAX_JUMP_PAGES = Math.ceil(MAX_CACHED / PAGE)
const NOTICE_MS = 6000
let updateHintShown = false

/**
 * Una conversación (equipo o DM). Se monta con `key` por conversación, así el borrador y la carga
 * inicial son por conversación. Los mensajes nuevos llegan por el store.
 */
export function Conversation({ conv, title, photo, initial, role, me, otherReadAt, retentionHours, onBack, onModal }: Props): React.JSX.Element {
  const stored = useConvMessages(conv)
  const isTeam = conv.kind === 'team'
  // La RLS ya no devuelve los vencidos; esto saca los que vencen con la conversación abierta. Un solo
  // timer al próximo vencimiento sube `venc`: la conversación solo se vuelve a renderizar cuando algo vence.
  const [venc, setVenc] = useState(0)
  const retention = isTeam ? retentionHours : undefined
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const list = useMemo(() => dropExpired(stored, retention, Date.now()), [stored, retention, venc])
  const meId = me?.id
  const meLogin = me?.login
  const meStable = useMemo(() => (meId !== undefined && meLogin !== undefined ? { id: meId, login: meLogin } : undefined), [meId, meLogin])
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
  const [activeId, setActiveId] = useState<string | null>(null)
  const openTop = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<ComposerHandle>(null)
  const searchBtnRef = useRef<HTMLButtonElement>(null)
  const pinRef = useRef(true)
  const prependRef = useRef<number | null>(null)
  const aliveRef = useRef(true)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const canManage = isTeam && (role === 'owner' || role === 'admin')

  // Al abrir: pedir los mensajes y marcar leído. Cada conversación tiene su propio montaje (key).
  useEffect(() => {
    aliveRef.current = true
    markRead(conv)
    void loadMessages(conv).then((e) => e && setLoadErr(e))
    const pending = timers.current
    return () => {
      aliveRef.current = false
      pending.forEach(clearTimeout)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.kind, conv.id])

  useEffect(() => {
    const next = proximoVencimiento(stored, retention, Date.now())
    if (next === undefined) return
    const vigilia = vigilarVencimiento(next, Date.now, setTimeout, (h) => clearTimeout(h as ReturnType<typeof setTimeout>), () => setVenc((n) => n + 1))
    const revisar = (): void => {
      if (document.visibilityState === 'visible') vigilia.revisar()
    }
    document.addEventListener('visibilitychange', revisar)
    window.addEventListener('focus', revisar)
    return () => {
      document.removeEventListener('visibilitychange', revisar)
      window.removeEventListener('focus', revisar)
      vigilia.parar()
    }
  }, [stored, retention, venc])

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
      openTop.current = el.scrollTop
      return
    }
    if (pinRef.current) {
      el.scrollTop = el.scrollHeight
      openTop.current = el.scrollTop
    }
  }, [stored])

  const later = useCallback((fn: () => void, ms: number): void => {
    timers.current.push(setTimeout(fn, ms))
  }, [])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    pinRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (activeId && scrolledFar(openTop.current, el.scrollTop)) setActiveId(null)
  }

  const toggleBar = useCallback((id: string): void => {
    openTop.current = scrollRef.current?.scrollTop ?? 0
    setActiveId((cur) => activeReduce(cur, { type: 'toggle', id }))
  }, [])
  const closeBar = useCallback((): void => setActiveId(null), [])
  const startReply = useCallback((m: ChatMessage): void => composerRef.current?.startReply(m), [])
  const startEdit = useCallback((m: ChatMessage): void => composerRef.current?.startEdit(m), [])

  useEffect(() => {
    if (!activeId) return
    const onDown = (e: PointerEvent): void => {
      if (!(e.target as Element).closest('.f-chat-bar, .f-chat-bubble, [role="menu"]')) setActiveId(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      const li = scrollRef.current?.querySelector<HTMLElement>(`[data-mid="${CSS.escape(activeId)}"]`)
      if (li?.contains(document.activeElement)) li.focus()
      setActiveId(null)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [activeId])

  const older = async (): Promise<void> => {
    const el = scrollRef.current
    if (el) prependRef.current = el.scrollHeight - el.scrollTop
    setLoadingOlder(true)
    const e = await loadMessages(conv, true)
    setLoadingOlder(false)
    if (e) setLoadErr(e)
  }

  const find = useCallback(
    (id: string): HTMLElement | null =>
      [...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-mid]') ?? [])].find((n) => n.dataset.mid === id) ?? null,
    []
  )

  const jump = useCallback(async (id: string): Promise<void> => {
    pinRef.current = false
    const has = (): boolean => peekConv(conv).list.some((m) => m.id === id)
    for (let i = 0; i < MAX_JUMP_PAGES && !has(); i++) {
      const before = peekConv(conv)
      if (!before.more || before.list.length >= MAX_CACHED) break
      const e = await loadMessages(conv, true)
      if (!aliveRef.current) return
      if (e) {
        setLoadErr(e)
        return
      }
      if (peekConv(conv).list.length === before.list.length) break
    }
    if (!has()) {
      setNotice(TOO_OLD)
      later(() => setNotice(undefined), NOTICE_MS)
      return
    }
    requestAnimationFrame(() => {
      find(id)?.scrollIntoView({ block: 'center' })
      setFlashId(id)
      later(() => setFlashId(undefined), FLASH_MS)
    })
    // `conv` cambia de identidad en cada render del padre; el montaje es por kind e id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.kind, conv.id, later, find])
  const onJump = useCallback((id: string): void => void jump(id), [jump])

  const closeSearch = (): void => {
    setSearching(false)
    requestAnimationFrame(() => searchBtnRef.current?.focus())
  }

  const allowedClear = canManageConv(conv.kind, role)
  const menuItems: MenuItem[] = [
    ...(isTeam
      ? [
          {
            id: 'retention',
            label: 'Borrar mensajes automáticamente…',
            icon: <Timer size={14} />,
            hint: retentionLabel(retentionHours),
            onSelect: () => onModal('retention')
          },
          { type: 'separator' as const }
        ]
      : []),
    {
      id: 'clear',
      label: 'Vaciar conversación…',
      icon: <Broom size={14} />,
      danger: true,
      disabled: !allowedClear,
      hint: allowedClear ? undefined : 'Solo owner o admin',
      onSelect: () => onModal('clear')
    }
  ]

  const items: React.ReactNode[] = []
  const now = Date.now()
  const seenId = meStable && conv.kind === 'dm' && extras ? seenUpTo(list, meStable.id, otherReadAt) : undefined
  list.forEach((msg, i) => {
    const prev = list[i - 1]
    if (!prev || !sameDay(prev.createdAt, msg.createdAt)) {
      items.push(
        <li key={`day-${msg.id}`} className="f-chat-day" role="presentation">
          <span>{dayLabel(msg.createdAt, now)}</span>
        </li>
      )
    }
    if (msg.notice) {
      items.push(
        <li key={msg.id} className="f-chat-notice" data-mid={msg.id}>
          {noticeText(msg.notice, msg.author.login)}
        </li>
      )
      return
    }
    items.push(
      <MessageItem
        key={msg.id}
        msg={msg}
        mine={!!meStable && msg.author.id === meStable.id}
        me={meStable}
        head={startsGroup(prev, msg)}
        extras={extras}
        seen={msg.id === seenId}
        flash={msg.id === flashId}
        active={msg.id === activeId}
        onToggle={toggleBar}
        onCloseBar={closeBar}
        onReply={startReply}
        onEdit={startEdit}
        onJump={onJump}
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
        {extras && (
          <Menu
            aria-label="Opciones de la conversación"
            align="end"
            items={menuItems}
            trigger={(p) => <IconButton {...p} label="Opciones de la conversación" size="sm" icon={<DotsThree size={16} weight="bold" />} />}
          />
        )}
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
          {extras && retentionHours !== undefined && (
            <span className="f-chat-retention">
              <Timer size={14} aria-hidden="true" />
              Los mensajes se borran a los {retentionLabel(retentionHours)}
            </span>
          )}
        </div>
      )}

      {searching && <SearchBar conv={conv} onJump={onJump} onClose={closeSearch} />}

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
      <p className="f-chat-typing">{extras ? typingText(typing) : ''}</p>

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
